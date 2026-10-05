import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { getGlobalDispatcher } from 'undici';
import { Game } from '../lib/game.mjs';
import { createRequestDispatcher, OpenAIClient } from '../lib/llm.mjs';

test('request dispatcher replaces five-minute transport cutoffs while forwarding the original request and handler', () => {
  for (const cutoff of [1_000_000, 2000]) {
    const handler = { onError() {} };
    const original = {
      origin: 'http://unused.invalid', path: '/v1/chat/completions', method: 'POST',
      headers: ['Content-Type', 'application/json'], body: '{"model":"fake-model"}',
      headersTimeout: 300_000, bodyTimeout: 300_000,
    };
    let forwarded;
    const baseDispatcher = {
      dispatch(options, receivedHandler) {
        assert.equal(this, baseDispatcher);
        assert.equal(receivedHandler, handler);
        forwarded = options;
        return false;
      },
    };
    const dispatcher = createRequestDispatcher(cutoff, baseDispatcher);
    assert.equal(dispatcher.dispatch(original, handler), false);
    assert.deepEqual(forwarded, { ...original, headersTimeout: cutoff, bodyTimeout: cutoff });
    assert.notEqual(forwarded, original);
    assert.equal(forwarded.headers, original.headers);
    assert.equal(original.headersTimeout, 300_000);
    assert.equal(original.bodyTimeout, 300_000);
  }
});

for (const { label, options, cutoff } of [
  { label: 'the 1000 second default', options: {}, cutoff: 1_000_000 },
  { label: 'a supplied shorter override', options: { requestTimeoutMs: 2000 }, cutoff: 2000 },
]) {
  test(`Game enforces ${label} and discards a response arriving after cancellation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    let respond;
    let calls = 0;
    const game = new Game({
      ...options,
      requestMove: input => {
        calls += 1;
        signal = input.signal;
        return new Promise(resolve => { respond = resolve; });
      },
    });
    t.after(() => game.close());
    const initialFen = game.snapshot().fen;
    game.step();
    await flush();
    assert.equal(game.snapshot().status, 'paused');
    assert.notEqual(game.snapshot().thinking, null);
    assert.equal(calls, 1);
    if (cutoff === 1_000_000) {
      t.mock.timers.tick(360_000);
      await flush();
      assert.equal(signal.aborted, false);
      assert.equal(game.snapshot().error, null);
      t.mock.timers.tick(639_999);
    } else {
      t.mock.timers.tick(cutoff - 1);
    }
    await flush();
    assert.equal(signal.aborted, false);
    assert.equal(game.snapshot().error, null);
    assert.notEqual(game.snapshot().thinking, null);

    t.mock.timers.tick(1);
    await flush();
    const timedOut = game.snapshot();
    assert.equal(signal.aborted, true);
    assert.equal(timedOut.status, 'error');
    assert.equal(timedOut.thinking, null);
    assert.match(timedOut.error, new RegExp(`timed out after ${cutoff / 1000} seconds`));
    assert.equal(timedOut.fen, initialFen);
    assert.equal(timedOut.moves.length, 0);
    assert.equal(calls, 1);

    respond({ move: 'e2e4', comment: 'This response arrived after the deadline.' });
    await flush();
    assert.equal(game.snapshot().fen, initialFen);
    assert.equal(game.snapshot().moves.length, 0);
    assert.equal(game.snapshot().status, 'error');
  });
}

for (const { label, clientOptions, requestOptions, cutoff } of [
  { label: 'the 1000 second default', clientOptions: {}, requestOptions: {}, cutoff: 1_000_000 },
  { label: 'a supplied shorter constructor override', clientOptions: { timeoutMs: 2000 }, requestOptions: {}, cutoff: 2000 },
  { label: 'a supplied shorter request override', clientOptions: { timeoutMs: 10_000 }, requestOptions: { timeoutMs: 2000 }, cutoff: 2000 },
]) {
  test(`OpenAIClient enforces ${label} by aborting its fetch`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    let calls = 0;
    const baseDispatcher = getGlobalDispatcher();
    const handler = { onError() {} };
    let transportOptions;
    t.mock.method(baseDispatcher, 'dispatch', function (options, receivedHandler) {
      assert.equal(this, baseDispatcher);
      assert.equal(receivedHandler, handler);
      transportOptions = options;
      return false;
    });
    const client = new OpenAIClient({
      ...clientOptions,
      baseUrl: 'http://unused.invalid/v1',
      fetchImpl: (url, input) => {
        calls += 1;
        signal = input.signal;
        assert.equal(typeof input.dispatcher?.dispatch, 'function');
        assert.notEqual(input.dispatcher, baseDispatcher);
        assert.equal(input.dispatcher.dispatch({
          origin: 'http://unused.invalid', path: '/v1/chat/completions', method: 'POST',
          headersTimeout: 300_000, bodyTimeout: 300_000,
        }, handler), false);
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Cancelled fake fetch.', 'AbortError')), { once: true });
        });
      },
    });
    const request = client.request('chat/completions', { ...requestOptions, body: { model: 'fake-model' } });
    const rejected = assert.rejects(request, new RegExp(`timed out after ${cutoff / 1000} seconds`));
    assert.equal(calls, 1);
    assert.equal(signal.aborted, false);
    assert.equal(getGlobalDispatcher(), baseDispatcher);
    assert.equal(transportOptions.headersTimeout, cutoff);
    assert.equal(transportOptions.bodyTimeout, cutoff);
    if (cutoff === 1_000_000) {
      t.mock.timers.tick(360_000);
      await flush();
      assert.equal(signal.aborted, false);
      t.mock.timers.tick(639_999);
    } else {
      t.mock.timers.tick(cutoff - 1);
    }
    await flush();
    assert.equal(signal.aborted, false);

    t.mock.timers.tick(1);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  });
}
