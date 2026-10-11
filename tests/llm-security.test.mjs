import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setImmediate as tick } from 'node:timers/promises';
import { OpenAIClient, createRequestDispatcher } from '../lib/llm.mjs';

const run = promisify(execFile);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function upstream(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test('success, HTTP error and model catalog decoded bytes share the response ceiling, including gzip', async t => {
  const large = JSON.stringify({ error: { message: 'x'.repeat(4096) }, data: [{ id: 'x'.repeat(4096) }] });
  const small = JSON.stringify({ accepted: '✓' });
  const baseUrl = await upstream(t, (request, response) => {
    if (request.url.endsWith('small')) {
      const body = gzipSync(small);
      response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': body.length });
      response.end(body);
    } else if (request.url.endsWith('error')) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(large);
    } else {
      const body = gzipSync(large);
      assert.ok(body.length < 128);
      response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': body.length });
      response.end(body);
    }
  });
  const client = new OpenAIClient({ baseUrl, maxResponseBytes: 128 });
  assert.deepEqual(await client.request('small'), { accepted: '✓' });
  await assert.rejects(client.request('success'), /decoded response exceeds the 128-byte/);
  await assert.rejects(client.request('error'), /decoded response exceeds the 128-byte/);
  const models = await client.listModels();
  assert.equal(models.connected, false);
  assert.match(models.error, /decoded response exceeds the 128-byte/);
});

test('chunked overflow stops consumption and cancels the response before parsing', async t => {
  let closed = false;
  const baseUrl = await upstream(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"message":"');
    const timer = setInterval(() => response.write('字'.repeat(32)), 5);
    response.on('close', () => { closed = true; clearInterval(timer); });
  });
  const client = new OpenAIClient({ baseUrl, maxResponseBytes: 64 });
  await assert.rejects(client.request('chat/completions', { body: { model: 'fake' } }), /decoded response exceeds the 64-byte/);
  for (let index = 0; !closed && index < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(closed, true);
});

test('the decoded byte boundary permits exactly the cap and rejects one byte more', async () => {
  for (const [size, allowed] of [[32, true], [33, false]]) {
    let signal;
    const client = new OpenAIClient({ maxResponseBytes: 32, fetchImpl: async (url, options) => {
      signal = options.signal;
      return new Response(`{"a":"${'x'.repeat(size - 8)}"}`);
    } });
    if (allowed) assert.equal((await client.request('test')).a.length, 24);
    else await assert.rejects(client.request('test'), /32-byte safety limit/);
    assert.equal(signal.aborted, !allowed);
  }
});

test('all API redirects fail without sending the key or body to another endpoint', async t => {
  let destinationRequests = 0;
  const destination = await upstream(t, (request, response) => { destinationRequests += 1; response.end('{}'); });
  let sameOriginRequests = 0;
  const baseUrl = await upstream(t, (request, response) => {
    if (request.url.endsWith('redirected')) { sameOriginRequests += 1; response.end('{}'); return; }
    response.writeHead(307, { Location: request.url.endsWith('models') ? '/v1/redirected' : `${destination}/redirected` });
    response.end();
  });
  const client = new OpenAIClient({ baseUrl, apiKey: 'never-forward-this-key' });
  await assert.rejects(client.request('chat/completions', { body: { secret: 'private prompt' } }), /fetch failed/);
  assert.equal((await client.listModels()).connected, false);
  assert.equal(destinationRequests, 0);
  assert.equal(sameOriginRequests, 0);
});

test('compression guard counts raw duplicate/case/comma headers and preserves callback receiver', () => {
  for (const controller of [
    { rawHeaders: [Buffer.from('Content-Encoding'), Buffer.from('gzip, gzip'), Buffer.from('cOnTeNt-EnCoDiNg'), Buffer.from('gzip,gzip,gzip,gzip')] },
    {},
  ]) {
    let received;
    const handler = { onResponseStart() { throw new Error('unsafe decoder callback reached'); } };
    const dispatcher = createRequestDispatcher(1000, { dispatch(options, forwarded) { received = forwarded; return true; } });
    dispatcher.dispatch({}, handler);
    assert.throws(() => received.onResponseStart(controller, 200, { 'Content-Encoding': ['gzip,gzip', 'gzip,gzip,gzip,gzip'] }, 'OK'), /too many Content-Encoding/);
  }
  let called = false;
  const handler = { onResponseStart() { assert.equal(this, handler); called = true; }, onResponseData() { assert.equal(this, handler); } };
  const dispatcher = createRequestDispatcher(1000, { dispatch(options, forwarded) {
    forwarded.onResponseStart({ rawHeaders: ['CONTENT-ENCODING', 'gzip'] }, 200, {}, 'OK');
    forwarded.onResponseData();
    return false;
  } });
  assert.equal(dispatcher.dispatch({}, handler), false);
  assert.equal(called, true);
});

test('real excessive compression headers cannot crash the process and ordinary gzip still works', { timeout: 5000 }, async () => {
  const llmUrl = new URL('../lib/llm.mjs', import.meta.url).href;
  const source = `
    import {createServer} from 'node:http';
    import {gzipSync} from 'node:zlib';
    import {OpenAIClient} from ${JSON.stringify(llmUrl)};
    const server=createServer((req,res)=>{
      if(req.url.endsWith('bad')) {
        res.writeHead(200, {'Content-Encoding':['gzip,gzip','gzip,gzip,gzip,gzip']});
        res.end('untrusted body');
      } else {res.writeHead(200, {'Content-Encoding':'gzip'});res.end(gzipSync('{"safe":true}'));}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const client=new OpenAIClient({baseUrl:'http://127.0.0.1:'+server.address().port});
    let rejected=0;
    for(let i=0;i<2;i++) {try{await client.request('bad');}catch(error){if(!error.message.includes('too many Content-Encoding'))throw error;rejected++;}}
    const normal=await client.request('good');
    console.log(JSON.stringify({rejected,normal}));
    server.close();server.closeAllConnections();
  `;
  const result = await run(process.execPath, ['--input-type=module', '-e', source], { timeout: 4000, maxBuffer: 10_000 });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { rejected: 2, normal: { safe: true } });
  assert.doesNotMatch(result.stderr, /Unhandled|ERR_UNHANDLED/);
});

test('model discovery coalesces bounded consumers, isolates cancellation and caches bounded results', async () => {
  const pending = deferred();
  let calls = 0;
  let sharedSignal;
  const client = new OpenAIClient({ maxModelsConsumers: 2, fetchImpl: (url, input) => {
    calls += 1; sharedSignal = input.signal; return pending.promise;
  } });
  const firstController = new AbortController();
  const first = client.listModels({ signal: firstController.signal });
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const second = client.listModels();
  const excess = await client.listModels();
  assert.equal(excess.connected, false);
  assert.match(excess.error, /concurrent/);
  assert.equal(calls, 1);
  firstController.abort();
  await firstRejected;
  assert.equal(sharedSignal.aborted, false);
  pending.resolve(new Response('{"data":[{"id":"safe-model"}]}'));
  const result = await second;
  assert.deepEqual(result.models, ['safe-model']);
  result.models.push('mutated caller copy');
  assert.deepEqual((await client.listModels()).models, ['safe-model']);
  assert.equal(calls, 1);
});

test('all model consumers leaving cancels shared work without replacing an unsettled request', async () => {
  const pending = deferred();
  let calls = 0;
  let sharedSignal;
  const client = new OpenAIClient({ fetchImpl: (url, input) => { calls += 1; sharedSignal = input.signal; return pending.promise; } });
  const a = new AbortController();
  const b = new AbortController();
  const first = client.listModels({ signal: a.signal });
  const second = client.listModels({ signal: b.signal });
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const secondRejected = assert.rejects(second, { name: 'AbortError' });
  a.abort();
  assert.equal(sharedSignal.aborted, false);
  b.abort();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(sharedSignal.aborted, true);
  const replacement = client.listModels();
  await tick();
  assert.equal(calls, 1);
  pending.resolve(new Response('{"data":[{"id":"late-model"}]}'));
  assert.equal((await replacement).connected, false);
  assert.equal((await client.listModels()).connected, false);
  assert.equal(calls, 1);
});

test('disconnected catalog consumers leave no active listener or retained subscriber backlog', async () => {
  const pending = deferred();
  let calls = 0;
  const client = new OpenAIClient({ maxModelsConsumers: 2, fetchImpl: () => { calls += 1; return pending.promise; } });
  const keeper = client.listModels();
  for (let index = 0; index < 500; index += 1) {
    const controller = new AbortController();
    const caller = client.listModels({ signal: controller.signal });
    const rejected = assert.rejects(caller, { name: 'AbortError' });
    controller.abort();
    await rejected;
    assert.equal(client._modelsFlight.consumers.size, 1);
  }
  assert.equal(calls, 1);
  pending.resolve(new Response('{"data":[{"id":"kept"}]}'));
  assert.deepEqual((await keeper).models, ['kept']);
  await tick();
  assert.equal(client._modelsFlight, null);
});

test('model failure cache expires and oversized catalogs or identifiers are rejected', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const client = new OpenAIClient({ modelsCacheTtlMs: 10, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return new Response('{"error":{"message":"provider unavailable"}}', { status: 503 });
    return new Response('{"data":[{"id":"recovered"}]}');
  } });
  assert.equal((await client.listModels()).connected, false);
  now += 9;
  assert.equal((await client.listModels()).connected, false);
  assert.equal(calls, 1);
  now += 1;
  assert.deepEqual((await client.listModels()).models, ['recovered']);
  assert.equal(calls, 2);
  for (const data of [Array.from({ length: 513 }, () => ({ id: 'model' })), [{ id: 'm'.repeat(257) }]]) {
    const oversized = new OpenAIClient({ fetchImpl: async () => new Response(JSON.stringify({ data })) });
    const result = await oversized.listModels();
    assert.equal(result.connected, false);
    assert.match(result.error, /safety limit/);
  }
});
