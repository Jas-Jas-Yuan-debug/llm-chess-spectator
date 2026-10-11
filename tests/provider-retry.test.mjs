import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setImmediate as flush } from 'node:timers/promises';
import { Chess } from 'chess.js';
import { Game } from '../lib/game.mjs';
import { OpenAIClient, ProviderDisconnectError } from '../lib/llm.mjs';
import { DataLimitError } from '../lib/limits.mjs';

const incomplete = 'stream error: stream disconnected before completion: stream closed before response.completed';

function waitFor(game, predicate, timeout = 3000) {
  if (predicate(game.snapshot())) return Promise.resolve(game.snapshot());
  return new Promise((resolve, reject) => {
    const changed = state => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      game.off('state', changed);
      resolve(state);
    };
    const timer = setTimeout(() => { game.off('state', changed); reject(new Error('Timed out waiting for recovery state.')); }, timeout);
    game.on('state', changed);
  });
}

async function mockApi(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return new OpenAIClient({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'retry-test-secret' });
}

test('an incomplete provider stream retries the unchanged position once and commits exactly one move', { timeout: 5000 }, async t => {
  const requests = [];
  const client = await mockApi(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(requests.length === 1 ? 408 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(requests.length === 1 ? { error: { message: incomplete } }
      : { choices: [{ message: { content: '{"move":"e2e4","comment":"Recovered."}' } }] }));
  });
  const game = new Game({ whiteModel: 'gpt-6-astra', blackModel: 'gpt-6.1-sol', requestMove: request => client.move(request) });
  t.after(() => game.close());
  const before = game.snapshot();
  game.step();
  const state = await waitFor(game, state => state.moves.length === 1);
  await flush();
  assert.equal(state.id, before.id);
  assert.equal(state.status, 'paused');
  assert.equal(state.error, null);
  assert.equal(state.moves.length, 1);
  assert.equal(state.moves[0].uci, 'e2e4');
  assert.equal(state.moves[0].model, 'gpt-6-astra');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[0].model, 'gpt-6-astra');
  assert.equal(requests[0].reasoning_effort, 'max');
  assert.match(requests[0].messages[1].content, /FEN: rnbqkbnr/);
});

test('repeated disconnects stop after one transport retry without an invented move', async t => {
  let calls = 0;
  const game = new Game({ requestMove: async () => { calls++; throw new ProviderDisconnectError(incomplete); } });
  t.after(() => game.close());
  const before = game.snapshot();
  game.step();
  const state = await waitFor(game, state => state.status === 'error');
  assert.equal(calls, 2);
  assert.equal(state.id, before.id);
  assert.equal(state.fen, before.fen);
  assert.equal(state.moves.length, 0);
  assert.equal(state.thinking, null);
  assert.match(state.error, /disconnected/);
});

test('the one transport retry is shared by all validation attempts for a ply', async t => {
  const requests = [];
  const game = new Game({ requestMove: async request => {
    requests.push(request);
    if (requests.length === 2) return { move: 'e2e5' };
    throw new ProviderDisconnectError(incomplete);
  } });
  t.after(() => game.close());
  game.step();
  const state = await waitFor(game, state => state.status === 'error');
  assert.equal(requests.length, 3);
  assert.match(requests[2].feedback, /Illegal/);
  assert.ok(requests.every(request => request.fen === new Chess().fen()));
  assert.equal(state.moves.length, 0);
});

for (const action of ['pause', 'reset']) {
  test(`${action} during recovery cancels the delayed retry`, async t => {
    let calls = 0;
    const game = new Game({ requestMove: async () => { calls++; throw new ProviderDisconnectError(incomplete); } });
    t.after(() => game.close());
    const before = game.snapshot();
    game.step();
    await waitFor(game, state => state.thinking?.transportRetry === 1);
    game[action]();
    await flush();
    await flush();
    assert.equal(calls, 1);
    assert.equal(game.snapshot().moves.length, 0);
    assert.equal(game.snapshot().thinking, null);
    assert.equal(game.snapshot().error, null);
    assert.equal(game.snapshot().status, action === 'reset' ? 'idle' : 'paused');
    assert.equal(game.snapshot().id === before.id, action !== 'reset');
  });

  test(`${action} at retry-delay fulfillment prevents another provider callback`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const game = new Game({ requestMove: async () => {
      calls++;
      if (calls === 1) throw new ProviderDisconnectError(incomplete);
      return { move: 'e2e4' };
    } });
    t.after(() => game.close());
    const before = game.snapshot();
    game.step();
    await flush();
    assert.equal(game.snapshot().thinking?.transportRetry, 1);
    t.mock.timers.tick(1000);
    // Run after the delay fulfills but before its awaiting task continues.
    queueMicrotask(() => game[action]());
    await flush();
    await flush();
    assert.equal(calls, 1);
    assert.equal(game.snapshot().moves.length, 0);
    assert.equal(game.snapshot().fen, before.fen);
    assert.equal(game.snapshot().thinking, null);
    assert.equal(game.snapshot().error, null);
    assert.equal(game.snapshot().status, action === 'reset' ? 'idle' : 'paused');
    assert.equal(game.snapshot().id === before.id, action !== 'reset');
  });
}

test('retry delay and replacement request share the original controller deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let secondSignal;
  let finish;
  const game = new Game({ requestTimeoutMs: 2000, requestMove: request => {
    calls++;
    if (calls === 1) return Promise.reject(new ProviderDisconnectError(incomplete));
    secondSignal = request.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  t.after(() => game.close());
  game.step();
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(secondSignal.aborted, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(secondSignal.aborted, true);
  assert.equal(game.snapshot().status, 'error');
  assert.match(game.snapshot().error, /timed out after 2 seconds/);
  finish({ move: 'e2e4' });
  await flush();
  assert.equal(game.snapshot().moves.length, 0);
});

test('a deadline expiring during recovery never sends the retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const game = new Game({ requestTimeoutMs: 500, requestMove: async () => { calls++; throw new ProviderDisconnectError(incomplete); } });
  t.after(() => game.close());
  game.step();
  await flush();
  t.mock.timers.tick(500);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls, 1);
  assert.equal(game.snapshot().status, 'error');
  assert.equal(game.snapshot().moves.length, 0);
});

test('only an explicit HTTP408 incomplete stream is classified as retryable and public errors redact the key', async () => {
  for (const [status, message, retryable] of [
    [408, incomplete, true], [408, 'request timed out', false], [500, incomplete, false],
    [401, incomplete, false], [403, 'Forbidden', false], [429, 'Rate limited', false],
  ]) {
    const client = new OpenAIClient({ apiKey: 'retry-test-secret', fetchImpl: async () => new Response(JSON.stringify({ error: { message: `${message} retry-test-secret` } }), { status }) });
    await assert.rejects(client.request('chat/completions', { body: {} }), error => {
      assert.equal(error instanceof ProviderDisconnectError, retryable);
      assert.equal(error.message.includes('retry-test-secret'), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    });
  }
});

test('recognized socket disconnects are retryable; timeouts, redirects and safety failures are not', async () => {
  for (const [failure, retryable] of [
    [new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }), true],
    [Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), true],
    [Object.assign(new Error('headers timed out'), { code: 'UND_ERR_HEADERS_TIMEOUT' }), false],
    [new Error('stream disconnected before completion'), false],
    [new TypeError('redirect encountered'), false],
    [new DataLimitError('Too many Content-Encoding layers.'), false],
    [Object.assign(new Error('socket reset', { cause: new DataLimitError('Safety boundary rejected this response.') }), { code: 'ECONNRESET' }), false],
    [new DOMException('Cancelled.', 'AbortError'), false],
  ]) {
    const client = new OpenAIClient({ fetchImpl: async () => { throw failure; } });
    await assert.rejects(client.request('chat/completions', { body: {} }), error => {
      assert.equal(error instanceof ProviderDisconnectError, retryable);
      return true;
    });
  }
});

test('a real response truncated before completion is a retryable socket failure', { timeout: 5000 }, async t => {
  const client = await mockApi(t, (request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    response.write('{"choices":');
    setImmediate(() => response.destroy());
  });
  await assert.rejects(client.request('chat/completions', { body: {} }), ProviderDisconnectError);
});

test('truncated non-success HTTP responses never become retryable socket failures', { timeout: 5000 }, async t => {
  for (const status of [401, 403, 429, 500, 408]) {
    const client = await mockApi(t, (request, response) => {
      request.resume();
      response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      response.write('{"error":');
      setImmediate(() => response.destroy());
    });
    await assert.rejects(client.request('chat/completions', { body: {} }), error => {
      assert.equal(error instanceof ProviderDisconnectError, false, `HTTP ${status} must not trigger a transport retry.`);
      return true;
    });
  }
});

test('ordinary transport and safety failures stop immediately without retry', async t => {
  for (const failure of [new Error('Model API HTTP 403: Forbidden'), new Error('Model request timed out.'), new DataLimitError('Oversized decoded response.')]) {
    let calls = 0;
    const game = new Game({ requestMove: async () => { calls++; throw failure; } });
    t.after(() => game.close());
    game.step();
    const state = await waitFor(game, state => state.status === 'error');
    assert.equal(calls, 1);
    assert.equal(state.moves.length, 0);
  }
});
