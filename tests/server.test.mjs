import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { Chess } from 'chess.js';
import { createChessServer } from '../server.mjs';
import { Game } from '../lib/game.mjs';
import { OpenAIClient } from '../lib/llm.mjs';

const secret = 'server-test-secret-not-for-browser';
const privateSentinel = 'synthetic-private-provider-reasoning-must-stay-private';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  server.closeEvents?.();
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function waitState(game, predicate) {
  const current = game.snapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      game.off('state', changed);
      reject(new Error('Expected game state did not arrive.'));
    }, 3000);
    const changed = state => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      game.off('state', changed);
      resolve(state);
    };
    game.on('state', changed);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { replies = [], requestMove, settings = {}, persistencePath, reasoningContent } = {}) {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ body, authorization: request.headers.authorization, path: request.url });
    const reply = replies[requests.length - 1];
    response.writeHead(reply ? 200 : 500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply ? {
      choices: [{ message: { content: JSON.stringify(reply), ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) }, finish_reason: 'stop' }],
      usage: { completion_tokens: 25, prompt_tokens: 100, total_tokens: 125 },
    } : { error: { message: 'The test upstream received an unexpected request.' } }));
  });
  const upstreamUrl = await listen(upstream);
  const client = new OpenAIClient({ baseUrl: `${upstreamUrl}/v1`, apiKey: secret, timeoutMs: 1000 });
  const game = new Game({
    requestMove: requestMove ?? (input => client.move(input)),
    settings: { delayMs: 0, maxPlies: 2, ...settings },
    persistencePath,
    requestTimeoutMs: 1000,
  });
  const server = createChessServer({ game, client, apiKey: secret });
  const baseUrl = await listen(server);
  const authHeaders = { Authorization: `Bearer ${server.accessToken}` };
  t.after(async () => {
    await game.close();
    await closeServer(server);
    await closeServer(upstream);
  });
  const get = async route => {
    const response = await fetch(`${baseUrl}${route}`, { headers: authHeaders });
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, body = {}, headers = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { baseUrl, game, server, upstream, requests, get, post, authHeaders };
}

test('REST and SSE expose a legal alternating MAX match without the upstream credential', async t => {
  const explanation = {
    idea: 'Occupy the center and open lines for the bishop.',
    threats: 'Black can challenge the center with a pawn.',
    alternatives: [{ move: 'd2d4', whyNot: 'It creates a different central structure.' }],
    plan: 'Develop the knights and castle.',
  };
  const arena = await fixture(t, { reasoningContent: privateSentinel, replies: [
    { move: 'e2e5', comment: 'This illegal response must be rejected.' },
    { move: 'e2e4', comment: 'White claims the center.', explanation },
    { move: 'e7e5', comment: 'Black meets White in the center.' },
  ] });
  const initial = await arena.get('/api/state');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.status, 'idle');
  assert.deepEqual(initial.body.players, {
    w: { model: 'gpt-6.1-sol', effort: 'max' }, b: { model: 'gpt-6-astra', effort: 'max' },
  });
  assert.equal(initial.body.legalMoves.length, 20);
  const modelList = await arena.get('/api/models');
  assert.deepEqual(modelList.body.models, ['gpt-6.1-sol', 'gpt-6-astra']);
  assert.equal(modelList.body.connected, true);
  const abort = new AbortController();
  const events = await fetch(`${arena.baseUrl}/api/events`, { signal: abort.signal, headers: arena.authHeaders });
  t.after(() => abort.abort());
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let transcript = decoder.decode((await reader.read()).value);
  assert.match(transcript, /event: state/);
  assert.match(transcript, /"status":"idle"/);
  assert.equal((await arena.post('/api/start')).status, 200);
  const final = await waitState(arena.game, state => state.status === 'finished');
  while (!transcript.includes('"status":"finished"')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    transcript += decoder.decode(chunk.value, { stream: true });
  }
  abort.abort();
  assert.deepEqual(final.moves.map(move => [move.color, move.uci]), [['w', 'e2e4'], ['b', 'e7e5']]);
  assert.deepEqual(final.moves[0].explanation, explanation);
  assert.match(transcript, /Occupy the center and open lines for the bishop/);
  assert.deepEqual((await arena.get('/api/state')).body.moves[0].explanation, explanation);
  assert.equal(final.result.score, '1/2-1/2');
  assert.match(final.result.reason, /Move limit/);
  assert.equal(arena.requests.length, 3);
  assert.deepEqual(arena.requests.map(item => item.body.model), ['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6-astra']);
  for (const request of arena.requests) {
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.authorization, `Bearer ${secret}`);
    assert.equal(request.body.reasoning_effort, 'max');
    assert.ok(Number.isInteger(request.body.max_completion_tokens) && request.body.max_completion_tokens >= 2000);
  }
  assert.match(arena.requests[1].body.messages[1].content, /last response was rejected/);
  const replay = new Chess();
  for (const move of final.moves) replay.move(move.uci);
  assert.equal(replay.fen(), final.fen);
  const pgn = await (await fetch(`${arena.baseUrl}/api/pgn`, { headers: arena.authHeaders })).text();
  assert.match(pgn, /\[White "gpt-6\.1-sol"\]/);
  assert.match(pgn, /\[Black "gpt-6-astra"\]/);
  assert.match(pgn, /\[Result "1\/2-1\/2"\]/);
  assert.match(pgn, /1\. e4 e5 1\/2-1\/2/);
  const page = await (await fetch(arena.baseUrl)).text();
  for (const publicData of [JSON.stringify(initial.body), JSON.stringify(final), JSON.stringify(modelList.body), transcript, pgn, page]) {
    assert.equal(publicData.includes(secret), false);
    assert.equal(publicData.includes(privateSentinel), false);
    assert.equal(publicData.includes('reasoning_content'), false);
  }
  assert.equal((await fetch(`${arena.baseUrl}/.env`)).status, 404);
  assert.equal((await fetch(`${arena.baseUrl}/lib/llm.mjs`)).status, 404);
});

test('pause then immediate step discards an upstream response from the cancelled move', async t => {
  const old = deferred();
  const next = deferred();
  const calls = [];
  const arena = await fixture(t, {
    requestMove: input => { calls.push(input); return calls.length === 1 ? old.promise : next.promise; },
  });
  await arena.post('/api/step');
  await waitState(arena.game, state => state.thinking !== null);
  assert.equal((await arena.post('/api/pause')).body.thinking, null);
  assert.equal((await arena.post('/api/step')).status, 200);
  old.resolve({ move: 'e2e4' });
  await waitState(arena.game, state => state.thinking !== null && calls.length === 2);
  assert.equal(calls[0].signal.aborted, true);
  next.resolve({ move: 'd2d4', comment: 'The resumed request chooses a different opening.' });
  const final = await waitState(arena.game, state => state.moves.length === 1 && state.thinking === null);
  assert.equal(final.status, 'paused');
  assert.deepEqual(final.moves.map(move => move.uci), ['d2d4']);
  await nextTick();
  assert.equal(arena.game.snapshot().moves.length, 1);
});

test('reset then immediate start cannot apply a move from the previous game', async t => {
  const old = deferred();
  const next = deferred();
  const calls = [];
  const arena = await fixture(t, {
    settings: { maxPlies: 1 },
    requestMove: input => { calls.push(input); return calls.length === 1 ? old.promise : next.promise; },
  });
  const before = arena.game.snapshot().id;
  await arena.post('/api/start');
  await waitState(arena.game, state => state.thinking !== null);
  const reset = (await arena.post('/api/reset')).body;
  assert.notEqual(reset.id, before);
  assert.equal(reset.status, 'idle');
  assert.equal(reset.moves.length, 0);
  await arena.post('/api/start');
  old.resolve({ move: 'e2e4' });
  await waitState(arena.game, state => state.thinking !== null && calls.length === 2);
  next.resolve({ move: 'g1f3' });
  const final = await waitState(arena.game, state => state.status === 'finished');
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(final.id, reset.id);
  assert.deepEqual(final.moves.map(move => move.uci), ['g1f3']);
});

test('a saved finished match restores identical moves, position, result, and PGN', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-server-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const persistencePath = join(directory, 'current-game.json');
  const original = await fixture(t, { persistencePath, replies: [{ move: 'e2e4' }, { move: 'e7e5' }] });
  await original.post('/api/start');
  const finished = await waitState(original.game, state => state.status === 'finished');
  await original.game.close();
  const restored = await fixture(t, { persistencePath });
  const state = (await restored.get('/api/state')).body;
  assert.equal(state.status, 'finished');
  assert.equal(state.id, finished.id);
  assert.equal(state.fen, finished.fen);
  assert.deepEqual(state.moves, finished.moves);
  assert.deepEqual(state.result, finished.result);
  assert.equal(state.pgn, finished.pgn);
  assert.equal(state.thinking, null);
  assert.equal((await restored.post('/api/start')).body.status, 'finished');
  assert.equal(restored.requests.length, 0);
});

test('public explanation survives saving and restoration while preserving legacy move history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chess-explanation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const persistencePath = join(directory, 'current-game.json');
  const legacy = await fixture(t, { persistencePath, replies: [{ move: 'e2e4', comment: 'Existing public commentary.' }] });
  await legacy.post('/api/step');
  const legacyState = await waitState(legacy.game, state => state.moves.length === 1 && state.thinking === null);
  assert.equal(legacyState.moves[0].explanation, undefined);
  await legacy.game.close();

  const explanation = {
    idea: 'Challenge White with an equal central pawn.',
    threats: 'White may develop a knight to attack this pawn.',
    alternatives: [{ move: 'c7c5', whyNot: 'It creates an asymmetric pawn structure.' }],
    plan: 'Develop the knight and defend the center.',
  };
  const upgraded = await fixture(t, {
    persistencePath, reasoningContent: privateSentinel,
    replies: [{ move: 'e7e5', comment: 'Black replies in the center.', explanation }],
  });
  assert.deepEqual((await upgraded.get('/api/state')).body.moves, legacyState.moves);
  await upgraded.post('/api/step');
  const completed = await waitState(upgraded.game, state => state.status === 'finished');
  assert.equal(completed.id, legacyState.id);
  assert.deepEqual(completed.moves[0], legacyState.moves[0]);
  assert.deepEqual(completed.moves[1].explanation, explanation);
  const savedText = await readFile(persistencePath, 'utf8');
  const saved = JSON.parse(savedText);
  assert.deepEqual(saved.state.moves, completed.moves);
  assert.equal(savedText.includes(privateSentinel), false);
  assert.equal(savedText.includes('reasoning_content'), false);
  assert.equal(savedText.includes(secret), false);
  await upgraded.game.close();

  const restored = await fixture(t, { persistencePath });
  const restoredState = (await restored.get('/api/state')).body;
  assert.equal(restoredState.id, legacyState.id);
  assert.equal(restoredState.fen, completed.fen);
  assert.equal(restoredState.pgn, completed.pgn);
  assert.deepEqual(restoredState.moves, completed.moves);
  assert.deepEqual(restoredState.moves[1].explanation, explanation);
  assert.equal(restoredState.moves[0].explanation, undefined);
  assert.equal(restored.requests.length, 0);
});

test('REST controls reject malformed inputs and foreign origins without changing the match', async t => {
  const arena = await fixture(t);
  const initial = arena.game.snapshot();
  assert.equal((await arena.post('/api/settings', { delayMs: -1 })).status, 400);
  assert.equal((await arena.post('/api/settings', '{')).status, 400);
  assert.equal((await arena.post('/api/start', '[]')).status, 400);
  assert.equal((await arena.post('/api/start', {}, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await arena.post('/api/start', {}, { Origin: 'http://127.0.0.1:1' })).status, 403);
  assert.equal((await arena.get('/api/unknown')).status, 404);
  assert.equal((await arena.get('/api/start')).status, 404);
  assert.equal(arena.game.snapshot().status, initial.status);
  assert.equal(arena.game.snapshot().fen, initial.fen);
  assert.equal(arena.requests.length, 0);
  const updated = await arena.post('/api/settings', { delayMs: 350, maxPlies: 25 }, { Origin: arena.baseUrl });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.settings, { delayMs: 350, maxPlies: 25 });
});
