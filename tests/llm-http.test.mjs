import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getGlobalDispatcher } from 'undici';
import { OpenAIClient } from '../lib/llm.mjs';

test('default HTTP transport handles real responses with matching dispatcher callbacks and request deadlines', { timeout: 5000 }, async t => {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, method: request.method, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/v1/models' ? { data: [{ id: 'http-test-model' }] } : { accepted: true }));
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));

  const dispatcher = getGlobalDispatcher();
  const originalDispatch = dispatcher.dispatch;
  const deadlines = [];
  t.mock.method(dispatcher, 'dispatch', function (options, handler) {
    assert.equal(typeof handler.onRequestStart, 'function');
    assert.equal(typeof handler.onResponseStart, 'function');
    assert.equal(typeof handler.onResponseData, 'function');
    deadlines.push({ headers: options.headersTimeout, body: options.bodyTimeout });
    return originalDispatch.call(this, options, handler);
  });

  const client = new OpenAIClient({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'http-test-token' });
  assert.deepEqual(await client.request('chat/completions', { body: { model: 'http-test-model', messages: [] } }), { accepted: true });
  const models = await client.listModels();
  assert.equal(models.connected, true);
  assert.deepEqual(models.models, ['http-test-model']);
  assert.deepEqual(deadlines, [{ headers: 1_000_000, body: 1_000_000 }, { headers: 12_000, body: 12_000 }]);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer http-test-token');
  assert.deepEqual(JSON.parse(requests[0].body), { model: 'http-test-model', messages: [] });
  assert.equal(requests[1].method, 'GET');
});
