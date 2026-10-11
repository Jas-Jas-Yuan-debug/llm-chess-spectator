import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Chess } from 'chess.js';
import { Game, parseMoveResponse } from '../lib/game.mjs';
import { OpenAIClient } from '../lib/llm.mjs';
import { normalizeUsage } from '../lib/limits.mjs';

function waitFor(game, predicate) {
  if (predicate(game.snapshot())) return Promise.resolve(game.snapshot());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { game.off('state', changed); reject(new Error('Timed out waiting for state.')); }, 1500);
    const changed = state => {
      if (!predicate(state)) return;
      clearTimeout(timer); game.off('state', changed); resolve(state);
    };
    game.on('state', changed);
  });
}

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'chess-retention-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'game.json');
}

const untrustedUsage = () => ({
  prompt_tokens: 25, completion_tokens: 0, total_tokens: 44,
  completion_tokens_details: { reasoning_tokens: 19, audio_tokens: -1, rejected_prediction_tokens: Infinity, private: 'hidden' },
  prompt_tokens_details: { cached_tokens: 2, audio_tokens: NaN },
  unknown: 'unretained'.repeat(5000), nested: { arbitrary: ['unbounded'] },
});
const safeUsage = { prompt_tokens: 25, completion_tokens: 0, total_tokens: 44, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 19 } };

test('provider whitespace inside bounded move JSON cannot stall fence removal', { timeout: 5000 }, async () => {
  const source = `
    import { Chess } from 'chess.js';
    import { parseMoveResponse } from ${JSON.stringify(new URL('../lib/game.mjs', import.meta.url).href)};
    const result = parseMoveResponse(JSON.stringify({ move: 'e2e4', comment: ' '.repeat(100000) + 'X' }), new Chess());
    if (result.move.san !== 'e4' || result.comment !== 'X') process.exit(1);
    const fence = String.fromCharCode(96).repeat(3);
    const fenced = parseMoveResponse(fence + 'json\\n' + JSON.stringify({move:'g1f3'}) + '\\n' + fence, new Chess());
    if (fenced.move.san !== 'Nf3') process.exit(1);
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 3000 });
});

test('usage retains only finite nonnegative bounded allowlisted counters, including public reasoning token count', () => {
  assert.deepEqual(normalizeUsage(untrustedUsage()), safeUsage);
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage(['bad']), null);
  assert.equal(normalizeUsage({ prompt_tokens: '10', total_tokens: -1, completion_tokens: 1_000_000_001 }), null);
  assert.deepEqual(normalizeUsage({ total_tokens: 1_000_000_000 }), { total_tokens: 1_000_000_000 });
  assert.deepEqual(parseMoveResponse({ text: JSON.stringify({ move: 'e2e4', usage: untrustedUsage() }) }, new Chess()).usage, safeUsage);
  assert.deepEqual(parseMoveResponse({ text: '{"move":"e2e4","usage":{"total_tokens":3}}', usage: { arbitrary: 'drop' } }, new Chess()).usage, { total_tokens: 3 });
  assert.deepEqual(parseMoveResponse({ text: '{"move":"e2e4","usage":{"total_tokens":3}}', usage: { total_tokens: 7 } }, new Chess()).usage, { total_tokens: 7 });
});

test('adapter, live move, save and restored legacy history all normalize usage without changing ordinary fields', async t => {
  const client = new OpenAIClient({ fetchImpl: async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"move":"e2e4","comment":"Ordinary comment."}', reasoning_content: 'never collect private material' } }],
    usage: untrustedUsage(),
  })) });
  const response = await client.move({ fen: new Chess().fen(), pgn: '', board: '', legalMoves: ['e2e4'], color: 'w', model: 'fake-model', effort: 'max' });
  assert.deepEqual(response.usage, safeUsage);
  assert.doesNotMatch(JSON.stringify(response), /never collect|unretained|private/);
  const path = temporary(t);
  const game = new Game({ persistencePath: path, requestMove: async () => ({ move: 'e2e4', comment: 'Ordinary comment.', usage: untrustedUsage(), explanation: { idea: 'Occupy the center.' } }) });
  game.step();
  const state = await waitFor(game, state => state.moves.length === 1);
  assert.deepEqual(state.moves[0].usage, safeUsage);
  await game.close();
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.state.moves[0].usage = untrustedUsage();
  saved.state.moves[0].legacyTag = 'kept ordinary legacy metadata';
  writeFileSync(path, JSON.stringify(saved));
  const restored = new Game({ persistencePath: path, requestMove: async () => ({ move: 'e7e5' }) });
  t.after(() => restored.close());
  const after = restored.snapshot();
  assert.equal(after.id, state.id);
  assert.equal(after.fen, state.fen);
  assert.equal(after.pgn, state.pgn);
  assert.deepEqual(after.moves[0], { ...state.moves[0], usage: safeUsage, legacyTag: 'kept ordinary legacy metadata' });
  assert.doesNotMatch(JSON.stringify(after), /unretained|hidden|arbitrary/);
  restored.pause();
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).state.moves[0].usage, safeUsage);
});

test('per-move, total-state and saved-file budgets each reject a new legal move before board mutation', async t => {
  const initial = new Game({ requestMove: async () => ({ move: 'e2e4' }) });
  const baselineBytes = Buffer.byteLength(JSON.stringify(initial.snapshot()));
  await initial.close();
  for (const [name, limits] of [
    ['Retained move', { maxMoveBytes: 256 }],
    ['Game state', { maxGameBytes: baselineBytes + 600 }],
    ['Saved game', { maxSavedBytes: baselineBytes + 600 }],
  ]) {
    const path = temporary(t);
    let calls = 0;
    const game = new Game({ limits, persistencePath: path, requestMove: async () => { calls += 1; return { move: 'e2e4', comment: '字'.repeat(1000) }; } });
    const before = game.snapshot();
    game.step();
    const after = await waitFor(game, state => state.status === 'error');
    assert.match(after.error, new RegExp(name));
    assert.equal(after.fen, before.fen);
    assert.equal(after.pgn, before.pgn);
    assert.equal(after.moves.length, 0);
    assert.equal(after.thinking, null);
    assert.equal(calls, 1);
    assert.ok(Buffer.byteLength(readFileSync(path)) <= (limits.maxSavedBytes ?? 8 * 1024 * 1024));
    await game.close();
  }
});

test('history safety cap is independent of exhibition setting and leaves the prior move intact', async t => {
  const game = new Game({ limits: { maxHistoryLength: 1 }, settings: { maxPlies: 200 }, requestMove: async request => ({ move: request.color === 'w' ? 'e2e4' : 'e7e5' }) });
  t.after(() => game.close());
  game.step();
  const before = await waitFor(game, state => state.moves.length === 1 && !state.thinking);
  game.step();
  const after = await waitFor(game, state => state.status === 'error');
  assert.match(after.error, /history exceeds the 1-move/);
  assert.equal(after.fen, before.fen);
  assert.equal(after.pgn, before.pgn);
  assert.deepEqual(after.moves, before.moves);
});

test('committed history reserves room for later bounded error and control metadata', async t => {
  const path = temporary(t);
  const probe = new Game({ requestMove: async () => ({ move: 'e2e4' }) });
  probe.step();
  const sample = await waitFor(probe, state => state.moves.length === 1 && !state.thinking);
  await probe.close();
  const reserve = 2048 + Buffer.byteLength(JSON.stringify(sample.players));
  const maxGameBytes = Buffer.byteLength(JSON.stringify(sample)) + reserve + 64;
  const maxSavedBytes = Buffer.byteLength(JSON.stringify({ version: 1, initialFen: new Chess().fen(), state: sample })) + reserve + 64;
  let requests = 0;
  const game = new Game({ limits: { maxGameBytes, maxSavedBytes }, persistencePath: path, requestMove: async () => {
    if (++requests === 1) return { move: 'e2e4' };
    throw new Error('provider failure '.repeat(1000));
  } });
  t.after(() => game.close());
  game.step();
  const committed = await waitFor(game, state => state.moves.length === 1 && !state.thinking);
  game.updateSettings({ delayMs: 60_000, maxPlies: 1000 });
  game.step();
  const failed = await waitFor(game, state => state.status === 'error');
  assert.equal(failed.error.length, 700);
  assert.deepEqual(failed.moves, committed.moves);
  assert.equal(failed.fen, committed.fen);
  assert.ok(Buffer.byteLength(JSON.stringify(failed)) <= maxGameBytes);
  assert.ok(Buffer.byteLength(readFileSync(path)) <= maxSavedBytes);
});

test('over-budget restored file, move, state or history is rejected without rewriting the original save', async t => {
  const source = new Game({ requestMove: async () => ({ move: 'e2e4' }) });
  source.step();
  const state = await waitFor(source, state => state.moves.length === 1 && !state.thinking);
  await source.close();
  const fixture = { version: 1, initialFen: new Chess().fen(), state };
  for (const [limits, change, expected] of [
    [{ maxSavedBytes: 512 }, saved => saved, /Saved game/],
    [{ maxMoveBytes: 512 }, saved => { saved.state.moves[0].legacyExtra = 'x'.repeat(1024); return saved; }, /Retained move/],
    [{ maxGameBytes: 512 }, saved => saved, /Game state/],
    [{ maxHistoryLength: 1 }, saved => { saved.state.moves.push(saved.state.moves[0]); return saved; }, /history/],
  ]) {
    const path = temporary(t);
    const original = JSON.stringify(change(structuredClone(fixture)));
    writeFileSync(path, original);
    const restored = new Game({ persistencePath: path, limits, requestMove: async () => ({ move: 'e2e4' }) });
    assert.equal(restored.snapshot().status, 'error');
    assert.match(restored.snapshot().error, expected);
    assert.equal(restored.snapshot().fen, new Chess().fen());
    assert.equal(restored.snapshot().moves.length, 0);
    assert.throws(() => restored.start(), /Reset the game/);
    assert.throws(() => restored.step(), /Reset the game/);
    await restored.close();
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});
