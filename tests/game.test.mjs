import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { Game, parseMoveResponse, InvalidMoveError, validateSettings } from '../lib/game.mjs';
import { OpenAIClient, contentText } from '../lib/llm.mjs';

function waitFor(game, predicate, timeout = 1500) {
  const current = game.snapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const changed = state => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      game.off('state', changed);
      resolve(state);
    };
    const timer = setTimeout(() => { game.off('state', changed); reject(new Error(`Timed out waiting for state: ${JSON.stringify(game.snapshot())}`)); }, timeout);
    game.on('state', changed);
  });
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('parses JSON, fenced JSON, UCI and SAN while enforcing legality and promotion', () => {
  const chess = new Chess();
  assert.equal(parseMoveResponse({ text: '{"move":"e2e4","comment":"Center.","usage":null}' }, chess).move.san, 'e4');
  assert.equal(parseMoveResponse('```json\n{"move":"g1f3"}\n```', chess).move.san, 'Nf3');
  assert.equal(parseMoveResponse('d4', chess).move.from, 'd2');
  assert.equal(parseMoveResponse('e2-e4', chess).move.to, 'e4');
  assert.throws(() => parseMoveResponse('{"move":"e2e5"}', chess), InvalidMoveError);
  assert.throws(() => parseMoveResponse('Here is my detailed analysis.', chess), InvalidMoveError);
  assert.equal(chess.history().length, 0);
  const promotion = new Chess('7k/P7/8/8/8/8/8/7K w - - 0 1');
  assert.throws(() => parseMoveResponse('a7a8', promotion), InvalidMoveError);
  assert.equal(parseMoveResponse('a7a8n', promotion).move.promotion, 'n');
});

test('adversarial SAN suffixes are bounded before dependency parsing and ordinary legal SAN still works', t => {
  const chess = new Chess();
  t.mock.method(chess, 'move', () => { throw new Error('Provider move strings must not reach dependency parsing.'); });
  for (const move of ['e4' + '!'.repeat(100_000), 'Nf3' + '+'.repeat(100_000), 'e4' + '?'.repeat(39)]) {
    assert.throws(() => parseMoveResponse({ move }, chess), InvalidMoveError);
  }
  assert.equal(parseMoveResponse({ move: 'e4!' }, chess).move.san, 'e4');
  assert.equal(chess.fen(), new Chess().fen());
});

test('public summaries keep bounded text and only distinct legal alternative moves', () => {
  const chess = new Chess();
  const parsed = parseMoveResponse({ move: 'e2e4', explanation: {
    idea: 'x'.repeat(450), threats: 7, plan: ' Develop\n pieces\u0000 safely. ',
    alternatives: [
      { move: 'e2e4', whyNot: 'Chosen move must not repeat.' },
      { move: 'e2e5', whyNot: 'An illegal move.' },
      { move: 'd2d4', whyNot: 'y'.repeat(350) },
      { move: 'D2D4', whyNot: 'A duplicate.' },
      { move: 'g1f3', whyNot: 'Develops a knight before occupying the center.' },
      { move: 'b1c3', whyNot: 'A third alternative.' },
    ],
    internalAnalysis: 'An unknown field is ignored.',
  } }, chess);
  assert.equal(parsed.move.san, 'e4');
  assert.equal(parsed.explanation.idea.length, 400);
  assert.equal(parsed.explanation.threats, '');
  assert.equal(parsed.explanation.plan, 'Develop pieces safely.');
  assert.deepEqual(parsed.explanation.alternatives.map(item => item.move), ['d2d4', 'g1f3']);
  assert.equal(parsed.explanation.alternatives[0].whyNot.length, 300);
  assert.equal(Object.hasOwn(parsed.explanation, 'internalAnalysis'), false);
  assert.equal(chess.fen(), new Chess().fen());
});

test('malformed or missing summaries never invalidate an otherwise legal move', async () => {
  const chess = new Chess();
  for (const explanation of [undefined, null, 4, 'bad', [], { idea: [], plan: {}, threats: true, alternatives: 'bad' }]) {
    const parsed = parseMoveResponse({ move: 'e2e4', explanation }, chess);
    assert.equal(parsed.move.san, 'e4');
    assert.equal(parsed.explanation, null);
  }
  const game = new Game({ requestMove: async () => ({ move: 'e2e4', comment: 'Original comment.', explanation: { idea: 99, alternatives: [{ move: 'e2e5', whyNot: 'Illegal.' }] } }) });
  try {
    game.step();
    const state = await waitFor(game, state => state.moves.length === 1);
    assert.equal(state.status, 'paused');
    assert.equal(state.error, null);
    assert.equal(state.moves[0].comment, 'Original comment.');
    assert.equal(Object.hasOwn(state.moves[0], 'explanation'), false);
  } finally { await game.close(); }
});

test('persisted summaries survive restoration while earlier moves retain every original field', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llm-chess-summaries-'));
  const path = join(directory, 'game.json');
  let game;
  let restored;
  let final;
  try {
    game = new Game({ persistencePath: path, requestMove: async () => ({ move: 'e2e4', comment: 'Center.', usage: { total_tokens: 10 } }) });
    game.step();
    await waitFor(game, state => state.moves.length === 1);
    const before = game.snapshot();
    await game.close();
    game = null;
    restored = new Game({ persistencePath: path, requestMove: async () => ({ move: 'e7e5', comment: 'Contest the center.', usage: { total_tokens: 20 }, explanation: {
      idea: 'Occupy the center and open a bishop.', threats: 'White can develop quickly.',
      alternatives: [{ move: 'c7c5', whyNot: 'Creates an asymmetric position.' }, { move: 'e2e4', whyNot: 'Not a legal Black move.' }],
      plan: 'Develop the kingside pieces.',
    } }) });
    assert.equal(restored.snapshot().id, before.id);
    assert.equal(restored.snapshot().fen, before.fen);
    assert.deepEqual(restored.snapshot().moves, before.moves);
    restored.step();
    const withSummary = await waitFor(restored, state => state.moves.length === 2);
    assert.deepEqual(withSummary.moves[0], before.moves[0]);
    assert.deepEqual(withSummary.moves[1].explanation.alternatives, [{ move: 'c7c5', whyNot: 'Creates an asymmetric position.' }]);
    await restored.close();
    restored = null;
    final = new Game({ persistencePath: path, requestMove: async () => ({ move: '' }) });
    assert.equal(final.snapshot().id, before.id);
    assert.equal(final.snapshot().fen, withSummary.fen);
    assert.deepEqual(final.snapshot().moves, withSummary.moves);
    assert.equal(final.snapshot().pgn, withSummary.pgn);
  } finally {
    if (game) await game.close();
    if (restored) await restored.close();
    if (final) await final.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('alternates configured models with max effort and ends at the exhibition cap', async () => {
  const calls = [];
  const game = new Game({ settings: { delayMs: 0, maxPlies: 2 }, requestMove: async request => {
    calls.push(request);
    const move = request.color === 'w' ? 'e2e4' : 'e7e5';
    assert.ok(request.legalMoves.includes(move));
    return { move, comment: 'Claiming the center.', usage: { total_tokens: 8 } };
  } });
  try {
    game.start();
    const state = await waitFor(game, state => state.status === 'finished');
    assert.equal(state.moves.length, 2);
    assert.deepEqual(calls.map(call => [call.color, call.model, call.effort]), [['w', 'gpt-6.1-sol', 'max'], ['b', 'gpt-6-astra', 'max']]);
    assert.deepEqual(state.moves.map(move => move.san), ['e4', 'e5']);
    assert.equal(state.turn, 'w');
    assert.equal(state.moves[0].usage.total_tokens, 8);
    assert.match(state.result.reason, /Move limit reached/);
    assert.match(state.pgn, /\[Black "gpt-6-astra"\]/);
    assert.match(state.pgn, /\[Result "1\/2-1\/2"\]/);
    assert.match(state.pgn, /1\. e4 e5 1\/2-1\/2/);
  } finally { await game.close(); }
});

test('retries invalid model moves without changing position, then steps exactly one ply', async () => {
  let attempts = 0;
  const requests = [];
  const game = new Game({ settings: { delayMs: 0 }, requestMove: async request => {
    requests.push(request);
    attempts += 1;
    assert.equal(new Chess(request.fen).history().length, 0);
    assert.equal(request.fen, new Chess().fen());
    return { move: attempts < 3 ? 'e2e5' : 'e2e4' };
  } });
  try {
    game.step();
    const state = await waitFor(game, state => state.moves.length === 1 && !state.thinking);
    await tick();
    assert.equal(attempts, 3);
    assert.equal(state.status, 'paused');
    assert.equal(state.moves[0].uci, 'e2e4');
    assert.match(requests[1].feedback, /Illegal/);
    assert.equal(game.snapshot().moves.length, 1);
  } finally { await game.close(); }
});

test('three illegal responses produce a visible error with no invented move', async () => {
  let calls = 0;
  const game = new Game({ requestMove: async () => { calls += 1; return { move: 'a1a8' }; } });
  try {
    game.start();
    const state = await waitFor(game, state => state.status === 'error');
    assert.equal(calls, 3);
    assert.equal(state.moves.length, 0);
    assert.equal(state.fen, new Chess().fen());
    assert.equal(state.thinking, null);
    assert.match(state.error, /all 3 attempts/);
  } finally { await game.close(); }
});

test('pause aborts a request and ignores late replies even when provider ignores abort', async () => {
  let release;
  let requests = 0;
  let firstSignal;
  const game = new Game({ settings: { delayMs: 0 }, requestMove: request => {
    requests += 1;
    if (requests === 1) {
      firstSignal = request.signal;
      return new Promise(resolve => { release = resolve; });
    }
    return Promise.resolve({ move: 'd2d4' });
  } });
  try {
    game.start();
    await waitFor(game, state => Boolean(state.thinking));
    await tick();
    game.pause();
    assert.equal(firstSignal.aborted, true);
    game.step();
    const state = await waitFor(game, state => state.moves.length === 1);
    release({ move: 'e2e4' });
    await tick();
    assert.equal(state.status, 'paused');
    assert.deepEqual(game.snapshot().moves.map(move => move.uci), ['d2d4']);
  } finally { await game.close(); }
});

test('reset prevents a stale reply from committing into a fresh game', async () => {
  let release;
  const game = new Game({ requestMove: () => new Promise(resolve => { release = resolve; }) });
  try {
    const before = game.snapshot();
    game.start();
    await waitFor(game, state => Boolean(state.thinking));
    await tick();
    const after = game.reset();
    release({ move: 'e2e4' });
    await tick();
    assert.notEqual(after.id, before.id);
    assert.equal(game.snapshot().status, 'idle');
    assert.equal(game.snapshot().moves.length, 0);
    assert.equal(game.snapshot().fen, before.fen);
    assert.equal(game.snapshot().thinking, null);
  } finally { await game.close(); }
});

test('repeated starts share one request and a step cannot race a running game', async () => {
  let calls = 0;
  const game = new Game({ requestMove: () => { calls += 1; return new Promise(() => {}); } });
  try {
    for (let index = 0; index < 8; index += 1) game.start();
    await waitFor(game, state => Boolean(state.thinking));
    await tick();
    assert.equal(calls, 1);
    assert.throws(() => game.step(), /Pause/);
    game.pause();
    assert.equal(game.snapshot().thinking, null);
  } finally { await game.close(); }
});

test('request timeout becomes a recoverable visible error', async () => {
  const game = new Game({ requestTimeoutMs: 20, requestMove: () => new Promise(() => {}) });
  try {
    game.step();
    const state = await waitFor(game, state => state.status === 'error');
    assert.match(state.error, /timed out/);
    assert.equal(state.moves.length, 0);
    assert.equal(state.thinking, null);
  } finally { await game.close(); }
});

test('Fool’s mate finishes naturally and exports its result', async () => {
  const moves = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
  const game = new Game({ settings: { delayMs: 0 }, requestMove: async () => ({ move: moves.shift() }) });
  try {
    game.start();
    const state = await waitFor(game, state => state.status === 'finished');
    assert.equal(state.result.score, '0-1');
    assert.equal(state.result.reason, 'Checkmate');
    assert.equal(state.moves.at(-1).san, 'Qh4#');
    assert.equal(state.legalMoves.length, 0);
    assert.match(state.pgn, /Qh4# 0-1/);
  } finally { await game.close(); }
});

test('detects stalemate, insufficient material and fifty-move draw before querying models', async () => {
  for (const [fen, reason] of [
    ['7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 'Stalemate'],
    ['7k/8/8/8/8/8/8/7K w - - 0 1', 'Insufficient material'],
    ['7k/8/8/8/8/8/R7/K7 w - - 100 1', 'Fifty-move rule'],
  ]) {
    let calls = 0;
    const game = new Game({ initialFen: fen, requestMove: async () => { calls += 1; return { move: '' }; } });
    try {
      game.step();
      const state = await waitFor(game, state => state.status === 'finished');
      assert.equal(state.result.reason, reason);
      assert.equal(calls, 0);
    } finally { await game.close(); }
  }
});

test('repeated positions preserve history and finish on threefold repetition', async () => {
  const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  const game = new Game({ settings: { delayMs: 0 }, requestMove: async () => ({ move: moves.shift() }) });
  try {
    game.start();
    const state = await waitFor(game, state => state.status === 'finished');
    assert.equal(state.result.reason, 'Threefold repetition');
    assert.equal(state.moves.length, 8);
  } finally { await game.close(); }
});

test('restores a running game as paused, clears thinking, and retains finished PGN headers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llm-chess-game-'));
  const path = join(directory, 'game.json');
  let game;
  let restored;
  try {
    game = new Game({ persistencePath: path, settings: { delayMs: 0 }, requestMove: request => request.color === 'w' ? Promise.resolve({ move: 'e2e4' }) : new Promise(() => {}) });
    game.start();
    await waitFor(game, state => state.moves.length === 1 && state.thinking?.color === 'b');
    assert.equal(JSON.parse(readFileSync(path)).state.status, 'running');
    restored = new Game({ persistencePath: path, requestMove: async () => ({ move: 'e7e5' }) });
    assert.equal(restored.snapshot().status, 'paused');
    assert.equal(restored.snapshot().thinking, null);
    assert.equal(restored.snapshot().fen, game.snapshot().fen);
    assert.equal(restored.snapshot().pgn, game.snapshot().pgn);
    await game.close();
    game = null;
    restored.updateSettings({ maxPlies: 2, delayMs: 0 });
    restored.start();
    const finished = await waitFor(restored, state => state.status === 'finished');
    await restored.close();
    restored = null;
    const final = new Game({ persistencePath: path, requestMove: async () => ({ move: '' }) });
    assert.deepEqual(final.snapshot().result, finished.result);
    assert.equal(final.snapshot().pgn, finished.pgn);
    await final.close();
  } finally {
    if (game) await game.close();
    if (restored) await restored.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects unsafe or fractional settings and keeps the previous values', async () => {
  assert.throws(() => validateSettings({ maxPlies: 0 }), /maxPlies/);
  assert.throws(() => validateSettings({ delayMs: 2.5 }), /delayMs/);
  assert.throws(() => validateSettings({ maxPlies: '10' }), /maxPlies/);
  const game = new Game({ requestMove: async () => ({ move: '' }) });
  try {
    const before = game.snapshot().settings;
    assert.throws(() => game.updateSettings({ delayMs: -1 }), /delayMs/);
    assert.deepEqual(game.snapshot().settings, before);
  } finally { await game.close(); }
});

test('model adapter sends only public move prompt, accepts structured content and redacts errors', async () => {
  let received;
  const client = new OpenAIClient({ apiKey: 'example-secret', fetchImpl: async (url, request) => {
    received = { url, ...request, body: JSON.parse(request.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '{"move":"e2e4","comment":"Center."}' }], reasoning_content: 'PRIVATE_REASONING_MUST_NOT_BE_EXPOSED' } }], usage: { completion_tokens: 20 } }), { status: 200 });
  } });
  const response = await client.move({ color: 'w', model: 'gpt-6.1-sol', effort: 'max', fen: new Chess().fen(), pgn: '', board: new Chess().ascii(), legalMoves: ['e2e4'] });
  assert.equal(JSON.parse(response.text).move, 'e2e4');
  assert.equal(received.body.reasoning_effort, 'max');
  assert.equal(received.body.model, 'gpt-6.1-sol');
  assert.match(received.body.messages[1].content, /Do not provide private reasoning/);
  assert.match(received.body.messages[1].content, /concise public chess decision summary/);
  assert.match(received.body.messages[1].content, /at most two alternatives/);
  for (const key of ['idea', 'threats', 'alternatives', 'whyNot', 'plan']) assert.ok(received.body.messages[1].content.includes(`"${key}"`));
  assert.equal(JSON.stringify(response).includes('PRIVATE_REASONING_MUST_NOT_BE_EXPOSED'), false);
  assert.equal(Object.hasOwn(response, 'reasoning_content'), false);
  assert.equal(contentText([{ text: 'a' }, { text: 'b' }]), 'a\nb');
  const failing = new OpenAIClient({ apiKey: 'example-secret', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Wrong example-secret key' } }), { status: 401 }) });
  await assert.rejects(failing.move({ legalMoves: [], model: 'x', effort: 'max' }), error => error.message.includes('[redacted]') && !error.message.includes('example-secret'));
});
