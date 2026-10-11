import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Game } from '../lib/game.mjs';
import { createChessServer } from '../server.mjs';

async function fixture(t, options = {}) {
  const calls = { moves: 0, models: 0, evaluations: 0 };
  const game = new Game({ requestMove: async () => { calls.moves++; return { move: 'e2e4' }; } });
  const client = { listModels: async () => { calls.models++; return { connected: true, models: ['test-model'] }; } };
  const evaluator = { evaluate: fen => { calls.evaluations++; return { status: 'pending', fen }; }, close: async () => {} };
  const server = createChessServer({ game, client, evaluator, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${server.accessToken}` };
  t.after(async () => {
    await game.close();
    server.closeEvents();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  return { game, server, calls, headers, port, baseUrl };
}

function raw(arena, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: arena.port, path, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('every private API requires the owner capability before reads, work or controls', async t => {
  const arena = await fixture(t);
  const before = arena.game.snapshot();
  for (const route of ['/api/state', '/api/models', '/api/evaluation', '/api/events', '/api/pgn']) {
    for (const headers of [{}, { Authorization: `Bearer ${'x'.repeat(43)}` }]) {
      const response = await fetch(`${arena.baseUrl}${route}`, { headers });
      assert.equal(response.status, 401, route);
      assert.equal((await response.text()).includes(arena.server.accessToken), false);
    }
  }
  for (const route of ['/api/start', '/api/pause', '/api/step', '/api/reset', '/api/settings']) {
    assert.equal((await fetch(`${arena.baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  }
  assert.deepEqual(arena.game.snapshot(), before);
  assert.deepEqual(arena.calls, { moves: 0, models: 0, evaluations: 0 });
  const page = await fetch(arena.baseUrl);
  assert.equal(page.status, 200);
  assert.equal((await page.text()).includes(arena.server.accessToken), false);
  assert.deepEqual(await (await fetch(`${arena.baseUrl}/api/health`)).json(), { ready: true });
  assert.equal((await fetch(`${arena.baseUrl}/api/state`, { headers: arena.headers })).status, 200);
  assert.equal((await fetch(`${arena.baseUrl}/api/models`, { headers: arena.headers })).status, 200);
  assert.equal((await fetch(`${arena.baseUrl}/api/evaluation`, { headers: arena.headers })).status, 200);
  assert.deepEqual(arena.calls, { moves: 0, models: 1, evaluations: 1 });
});

test('foreign and alias origins, null origins and foreign browser metadata cannot use even a supplied capability', async t => {
  const arena = await fixture(t);
  const before = arena.game.snapshot();
  for (const extra of [
    { Origin: 'https://foreign.example' }, { Origin: 'null' },
    { Origin: `http://localhost:${arena.port}` }, { Origin: 'http://127.0.0.1:1' },
    { Origin: `${arena.baseUrl}/path` }, { 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    for (const route of ['/api/state', '/api/models', '/api/evaluation', '/api/events', '/api/pgn']) {
      assert.equal((await fetch(`${arena.baseUrl}${route}`, { headers: { ...arena.headers, ...extra } })).status, 403, route);
    }
    assert.equal((await fetch(`${arena.baseUrl}/api/reset`, { method: 'POST', headers: { ...arena.headers, 'Content-Type': 'application/json', ...extra }, body: '{}' })).status, 403);
  }
  assert.deepEqual(arena.game.snapshot(), before);
  assert.deepEqual(arena.calls, { moves: 0, models: 0, evaluations: 0 });
  const valid = await fetch(`${arena.baseUrl}/api/settings`, { method: 'POST', headers: { ...arena.headers, Origin: arena.baseUrl, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: '{"delayMs":350}' });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).settings.delayMs, 350);
  const wrongType = await fetch(`${arena.baseUrl}/api/reset`, { method: 'POST', headers: { ...arena.headers, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
  assert.equal(arena.game.snapshot().id, before.id);
});

test('Host and absolute request authority are checked for static files and all APIs', async t => {
  const arena = await fixture(t);
  for (const path of ['/', '/app.js', '/api/state', '/api/models', '/api/evaluation', '/api/events', '/%61pi/state']) {
    for (const Host of [`attacker.example:${arena.port}`, '127.0.0.1:1', `localhost.evil:${arena.port}`]) {
      assert.equal((await raw(arena, path, { ...arena.headers, Host })).status, 403, `${Host} ${path}`);
    }
  }
  for (const path of [`http://foreign.example/api/state`, `http://127.0.0.1:1/api/state`, '//foreign.example/api/state', '/\\foreign.example/api/state']) {
    assert.equal((await raw(arena, path, arena.headers)).status, 403, path);
  }
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const origin = `http://${host}:${arena.port}`;
    assert.equal((await raw(arena, '/api/state', { ...arena.headers, Host: `${host}:${arena.port}`, Origin: origin })).status, 200);
  }
  assert.equal((await raw(arena, `${arena.baseUrl}/api/state`, arena.headers)).status, 200);
  assert.deepEqual(arena.calls, { moves: 0, models: 0, evaluations: 0 });
});

test('every response forbids framing while the top-level viewer and scripts remain usable', async t => {
  const arena = await fixture(t);
  for (const path of ['/', '/app.js', '/api/health', '/api/state', '/missing']) {
    const response = await fetch(`${arena.baseUrl}${path}`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    if (path === '/' || path === '/app.js') assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
});

test('SSE admission is bounded and disconnected viewers release their slots', async t => {
  const arena = await fixture(t, { maxSubscribers: 2 });
  const controllers = [new AbortController(), new AbortController()];
  t.after(() => controllers.forEach(controller => controller.abort()));
  const streams = await Promise.all(controllers.map(controller => fetch(`${arena.baseUrl}/api/events`, { headers: arena.headers, signal: controller.signal })));
  for (const response of streams) assert.equal(response.status, 200);
  assert.equal((await fetch(`${arena.baseUrl}/api/events`, { headers: arena.headers })).status, 429);
  controllers[0].abort();
  await delay(30);
  const replacement = new AbortController();
  t.after(() => replacement.abort());
  assert.equal((await fetch(`${arena.baseUrl}/api/events`, { headers: arena.headers, signal: replacement.signal })).status, 200);
});

test('a blocked SSE writer coalesces states and a stalled viewer is removed without affecting others', async t => {
  const originalWrite = ServerResponse.prototype.write;
  let blockedResponse;
  let writes = 0;
  const payloads = [];
  t.mock.method(ServerResponse.prototype, 'write', function(chunk, ...args) {
    if (this.req.url === '/api/events' && !blockedResponse) blockedResponse = this;
    if (this === blockedResponse) {
      writes++;
      payloads.push(chunk.toString());
      originalWrite.call(this, chunk, ...args);
      return false;
    }
    return originalWrite.call(this, chunk, ...args);
  });
  const arena = await fixture(t, { maxSubscribers: 2, stallTimeoutMs: 120 });
  const first = new AbortController();
  const healthy = new AbortController();
  t.after(() => { first.abort(); healthy.abort(); });
  await fetch(`${arena.baseUrl}/api/events`, { headers: arena.headers, signal: first.signal });
  const normal = await fetch(`${arena.baseUrl}/api/events`, { headers: arena.headers, signal: healthy.signal });
  const reader = normal.body.getReader();
  await reader.read();
  for (let i = 0; i < 12; i++) arena.game.updateSettings({ delayMs: i });
  assert.equal(writes, 1, 'blocked response must not queue each publication');
  const revision = arena.game.snapshot().revision;
  blockedResponse.emit('drain');
  assert.equal(writes, 2);
  assert.match(payloads[1], new RegExp(`"revision":${revision}`));
  assert.equal(payloads[1].includes('"delayMs":11'), true);
  assert.equal((await reader.read()).done, false, 'another viewer continues receiving states');
  await delay(180);
  assert.equal(blockedResponse.destroyed, true);
  const replacement = new AbortController();
  t.after(() => replacement.abort());
  assert.equal((await fetch(`${arena.baseUrl}/api/events`, { headers: arena.headers, signal: replacement.signal })).status, 200);
});

test('oversize SSE snapshots are dropped before a response can retain the frame', async t => {
  const arena = await fixture(t, { maxEventBytes: 64 });
  await assert.rejects(fetch(`${arena.baseUrl}/api/events`, { headers: arena.headers }));
  assert.equal((await fetch(`${arena.baseUrl}/api/state`, { headers: arena.headers })).status, 200);
});
