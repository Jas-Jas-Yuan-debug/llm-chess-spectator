import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { getOpeningInfo } from '../lib/openings.mjs';
import { BOOK_SOURCE } from '../public/opening-book.js';

test('opening metadata describes the bundled factual source and initial legal continuations', () => {
  const chess = new Chess();
  const info = getOpeningInfo(chess.fen());
  assert.deepEqual(info.source, {
    name: 'Lichess openings', commit: BOOK_SOURCE.commit,
    openingCount: 3865, transitionCount: 8192,
  });
  assert.equal(info.inBook, true);
  assert.ok(info.moves.length > 0 && info.moves.length <= 64);
  assert.ok(info.moves.some(move => move.uci === 'e2e4' && move.san === 'e4'));
  assert.ok(info.moves.some(move => move.uci === 'd2d4' && move.san === 'd4'));
  for (const move of info.moves) {
    assert.deepEqual(Object.keys(move).sort(), ['eco', 'name', 'san', 'uci']);
    const replay = new Chess(chess.fen());
    assert.equal(replay.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), ...(move.uci[4] ? { promotion: move.uci[4] } : {}) }).san, move.san);
    assert.match(move.eco, /^[A-E]\d{2}$/);
    assert.ok(move.name.length <= 300);
  }
  assert.equal(chess.history().length, 0);
});

test('Sicilian continuation uses exact position, legal UCI and chess.js SAN', () => {
  const chess = new Chess();
  chess.move('e4');
  const replies = getOpeningInfo(chess.fen());
  const sicilian = replies.moves.find(move => move.uci === 'c7c5');
  assert.ok(sicilian);
  assert.equal(sicilian.san, 'c5');
  assert.match(sicilian.name, /Sicilian Defense/);
  assert.match(sicilian.eco, /^B/);
  chess.move('c5');
  const next = getOpeningInfo(chess.fen());
  assert.equal(next.inBook, true);
  assert.ok(next.moves.some(move => move.uci === 'g1f3' && move.san === 'Nf3'));
  assert.equal(chess.history().length, 2);
});

test('move counters do not change position lookup and alternate castling representation canonicalizes', () => {
  const fen = new Chess().fen();
  const initial = getOpeningInfo(fen);
  const fields = fen.split(' ');
  fields[2] = 'qkQK'; fields[4] = '32767'; fields[5] = '50000';
  assert.deepEqual(getOpeningInfo(fields.join(' ')), initial);
});

test('out-of-book positions, promotions and terminal positions return no invented book move', () => {
  for (const fen of [
    '7k/8/8/8/8/8/8/K7 w - - 0 1',
    '7k/P7/8/8/8/8/8/7K w - - 0 1',
    '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
  ]) {
    const info = getOpeningInfo(fen);
    assert.ok(info);
    assert.equal(info.inBook, false);
    assert.deepEqual(info.moves, []);
    assert.equal(info.source.name, 'Lichess openings');
  }
});

test('invalid or unsafe FEN is rejected through the engine validator without starting an engine', () => {
  const initial = new Chess().fen();
  for (const fen of [
    undefined, null, {}, '', 'invalid', `${initial}\ngo infinite`, 'x'.repeat(201),
    initial.replace('0 1', '32768 1'), initial.replace('0 1', '0 50001'),
    initial.replace('0 1', '0 9007199254740993'), initial.replace('0 1', '0 NaN'),
    '7k/8/8/8/8/8/8/K7 w KQ - 0 1',
  ]) assert.equal(getOpeningInfo(fen), null);
});

test('callers cannot mutate source metadata or cached candidate labels', () => {
  const fen = new Chess().fen();
  const first = getOpeningInfo(fen);
  assert.throws(() => { first.source.name = 'changed'; }, TypeError);
  assert.throws(() => { first.moves[0].name = 'changed'; }, TypeError);
  assert.throws(() => { first.moves.push({ uci: 'a1a8' }); }, TypeError);
  assert.deepEqual(getOpeningInfo(fen), first);
});
