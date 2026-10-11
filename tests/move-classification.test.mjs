import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { classifyMove, MOVE_RATINGS } from '../public/move-classification.js';

const ENGINE = { name: 'Stockfish 19', version: '19' };

function position(...moves) {
  const chess = new Chess();
  for (const move of moves) chess.move(move);
  return chess.fen();
}

function played(beforeFen, san) {
  const chess = new Chess(beforeFen);
  const entry = chess.move(san);
  return { color: entry.color, uci: `${entry.from}${entry.to}${entry.promotion ?? ''}`, san: entry.san, fen: chess.fen() };
}

function evaluation(fen, expected = 0.5, overrides = {}) {
  const chess = new Chess(fen);
  const first = chess.moves({ verbose: true })[0];
  const win = Math.round(expected * 1000);
  return {
    fen, status: 'ready', engine: { ...ENGINE }, depth: 20,
    cpWhite: expected === 0 ? -2000 : expected === 1 ? 2000 : 300 * Math.log(expected / (1 - expected)),
    mateWhite: null, winningColor: null, wdlWhite: { win, draw: 0, loss: 1000 - win },
    bestMove: first ? `${first.from}${first.to}${first.promotion ?? ''}` : null,
    pvUci: [], pvSan: [], ...overrides,
  };
}

function fixture({ beforeFen = position(), san = 'e4', beforeScore = 0.5, afterScore = 0.5, best = false } = {}) {
  const move = played(beforeFen, san);
  const other = new Chess(beforeFen).moves({ verbose: true }).find((entry) => `${entry.from}${entry.to}${entry.promotion ?? ''}` !== move.uci);
  const bestMove = best ? move.uci : `${other.from}${other.to}${other.promotion ?? ''}`;
  return { move, beforeFen, before: evaluation(beforeFen, beforeScore, { bestMove }), after: evaluation(move.fen, afterScore) };
}

function addPv(input, ...san) {
  const chess = new Chess(input.move.fen);
  input.after.pvUci = san.map((entry) => {
    const move = chess.move(entry);
    return `${move.from}${move.to}${move.promotion ?? ''}`;
  });
  input.after.bestMove = input.after.pvUci[0];
  return input;
}

test('all ten rating labels have usable metadata', () => {
  assert.equal(Object.keys(MOVE_RATINGS).length, 10);
  for (const item of Object.values(MOVE_RATINGS)) {
    assert.ok(item.label && item.description && item.symbol);
  }
});

test('expected-outcome boundaries are inclusive and improvements are not losses', () => {
  for (const [moverAfter, type] of [
    [0.48, 'excellent'], [0.479, 'good'], [0.45, 'good'], [0.449, 'inaccuracy'],
    [0.4, 'inaccuracy'], [0.399, 'mistake'], [0.3, 'mistake'], [0.299, 'blunder'], [0.9, 'excellent'],
  ]) {
    for (const color of ['w', 'b']) {
      const value = classifyMove(fixture({ beforeFen: color === 'w' ? position() : position('e4'), san: color === 'w' ? 'e4' : 'e5', afterScore: color === 'w' ? moverAfter : 1 - moverAfter }));
      assert.equal(value.type, type, `${color} after expected score ${moverAfter}`);
      assert.ok(value.lossExpected >= 0);
    }
  }
});

test('Black losses invert White-perspective scores and centipawns', () => {
  const input = fixture({ beforeFen: position('e4'), san: 'e5', beforeScore: 0.4, afterScore: 0.7 });
  input.before.cpWhite = -100;
  input.after.cpWhite = 200;
  const value = classifyMove(input);
  assert.equal(value.type, 'blunder');
  assert.equal(value.lossCp, 300);
  assert.ok(Math.abs(value.lossExpected - 0.3) < 1e-12);
});

test('Best uses legal UCI and recomputes SAN; a small independent-search loss does not demote it', () => {
  const input = fixture({ best: true, afterScore: 0.46 });
  input.before.pvSan = ['untrusted notation'];
  const value = classifyMove(input);
  assert.equal(value.type, 'best');
  assert.equal(value.bestSan, 'e4');
  assert.equal(value.bestMove, input.move.uci);
});

test('known opening moves return Book without evaluations, but a flag cannot excuse an illegal transition', () => {
  const input = fixture();
  const book = { eco: 'B00', name: 'King’s Pawn Opening' };
  const value = classifyMove({ move: input.move, beforeFen: input.beforeFen, book });
  assert.equal(value.type, 'book');
  assert.deepEqual(value.opening, book);
  assert.equal(value.lossExpected, null);
  assert.equal(classifyMove({ move: input.move, beforeFen: input.beforeFen, book: true }), null, 'an unverified boolean is not an opening-book entry');
  assert.equal(classifyMove({ ...input, book: true }).type, 'excellent');
  assert.equal(classifyMove({ ...input, book: false }).type, 'excellent');
  assert.equal(classifyMove({ ...input, move: { ...input.move, uci: 'e2e5' }, book }), null);
  assert.equal(classifyMove({ ...input, move: { ...input.move, fen: position('d4') }, book }), null);
});

test('mate zero uses the explicit winner for delivered checkmate of either color', () => {
  for (const [beforeFen, san, winner] of [
    [position('e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'), 'Qxf7#', 'w'],
    [position('f3', 'e5', 'g4'), 'Qh4#', 'b'],
  ]) {
    const input = fixture({ beforeFen, san, best: true });
    input.before = evaluation(beforeFen, 0.5, { cpWhite: null, mateWhite: winner === 'w' ? 1 : -1, winningColor: winner, bestMove: input.move.uci });
    input.after = evaluation(input.move.fen, 0.5, { cpWhite: null, mateWhite: 0, winningColor: winner, depth: 0 });
    assert.equal(classifyMove(input).type, 'best');
    assert.equal(classifyMove(input).lossExpected, 0);
    assert.equal(classifyMove(input).depth, 0);
    input.after.winningColor = null;
    assert.equal(classifyMove(input), null);
  }
});

test('same-winner mate distance changes do not manufacture an error; entering an opposing mate does', () => {
  const input = fixture();
  input.before = { ...input.before, cpWhite: null, mateWhite: 3, winningColor: 'w' };
  input.after = { ...input.after, cpWhite: null, mateWhite: 9, winningColor: 'w' };
  assert.equal(classifyMove(input).type, 'excellent');
  input.before = { ...input.before, cpWhite: 0, mateWhite: null, winningColor: null };
  input.after = { ...input.after, mateWhite: -3, winningColor: 'b' };
  assert.equal(classifyMove(input).type, 'blunder');
  input.after.winningColor = 'w';
  assert.equal(classifyMove(input), null);
});

test('Brilliant requires a sound non-pawn sacrifice persisting through the next reply, for both colors', () => {
  for (const [beforeFen, san, pv, beforeScore, afterScore] of [
    ['6k1/5ppp/8/7Q/8/8/5P1P/6RK w - - 0 1', 'Rxg7+', ['Kxg7', 'Qg5+'], 0.6, 0.59],
    ['6rk/5p1p/8/8/7q/8/5PPP/6K1 b - - 0 1', 'Rxg2+', ['Kxg2', 'Qg4+'], 0.4, 0.41],
  ]) {
    const input = addPv(fixture({ beforeFen, san, beforeScore, afterScore, best: true }), ...pv);
    const beforeCopy = structuredClone(input);
    const value = classifyMove(input);
    assert.equal(value.type, 'brilliant');
    assert.match(value.reason, /rook sacrifice/);
    assert.match(value.reason, /4 points/);
    assert.deepEqual(input, beforeCopy, 'classification does not mutate its inputs');
    input.after.pvUci.length = 1;
    assert.equal(classifyMove(input).type, 'best', 'one reply cannot rule out an immediate recapture');
  }
});

test('ordinary equal trades, immediate material recovery, unsound hangs and won positions are not Brilliant', () => {
  const exchange = addPv(fixture({ beforeFen: '3r2k1/8/8/8/3b4/2B5/8/6K1 w - - 0 1', san: 'Bxd4', best: true }), 'Rxd4', 'Kh2');
  assert.equal(classifyMove(exchange).type, 'best');
  const recovery = addPv(fixture({ beforeFen: '1q4k1/1B3ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', san: 'Ra8', best: true }), 'Qxa8', 'Bxa8');
  assert.equal(classifyMove(recovery).type, 'best');
  const sacrifice = addPv(fixture({ beforeFen: '6k1/5ppp/8/7Q/8/8/5P1P/6RK w - - 0 1', san: 'Rxg7+', best: false, afterScore: 0.2 }), 'Kxg7', 'Qg5+');
  assert.equal(classifyMove(sacrifice).type, 'blunder');
  sacrifice.before = evaluation(sacrifice.beforeFen, 0.99, { bestMove: sacrifice.move.uci });
  sacrifice.after = { ...sacrifice.after, ...evaluation(sacrifice.move.fen, 0.99), pvUci: sacrifice.after.pvUci, bestMove: sacrifice.after.bestMove };
  assert.equal(classifyMove(sacrifice).type, 'best');
});

test('Great and Miss require the actual preceding opponent opportunity, for both colors', () => {
  for (const [beforeFen, san, previousFen, previousWhite, beforeWhite, afterWhite] of [
    [position('e4', 'e5'), 'Nf3', position('e4'), 0.5, 0.7, 0.69],
    [position('e4', 'e5', 'Nf3'), 'Nc6', position('e4', 'e5'), 0.5, 0.3, 0.31],
  ]) {
    const input = fixture({ beforeFen, san, beforeScore: beforeWhite, afterScore: afterWhite, best: true });
    input.previousBefore = evaluation(previousFen, previousWhite);
    assert.equal(classifyMove(input).type, 'great');
    const other = new Chess(beforeFen).moves({ verbose: true }).find((entry) => `${entry.from}${entry.to}${entry.promotion ?? ''}` !== input.move.uci);
    const missed = fixture({ beforeFen, san: other.san, beforeScore: beforeWhite, afterScore: 0.5 });
    missed.before.bestMove = input.move.uci;
    missed.previousBefore = input.previousBefore;
    assert.equal(classifyMove(missed).type, 'miss');
    delete missed.previousBefore;
    assert.equal(classifyMove(missed).type, 'mistake', 'a generic bad move is not a missed opponent opportunity');
    input.previousBefore = evaluation(position('d4'), 0.5);
    assert.equal(classifyMove(input).type, 'best', 'a different preceding position cannot imply a turning point');
  }
});

test('valid WDL includes half the draws; missing WDL uses the stated logistic fallback', () => {
  const input = fixture();
  input.before.wdlWhite = { win: 100, draw: 800, loss: 100 };
  input.after.wdlWhite = { win: 100, draw: 700, loss: 200 };
  assert.equal(classifyMove(input).type, 'good');
  input.before.wdlWhite = null;
  input.after.wdlWhite = null;
  input.before.cpWhite = 0;
  input.after.cpWhite = -300;
  const value = classifyMove(input);
  assert.equal(value.type, 'blunder');
  assert.ok(Math.abs(value.lossExpected - (0.5 - 1 / (1 + Math.E))) < 1e-12);
  assert.match(value.reason, /300 cp logistic/);
  input.after.wdlWhite = { win: -1, draw: 0, loss: 1001 };
  assert.equal(classifyMove(input).type, 'blunder', 'malformed WDL falls back to the numeric cp score');
});

test('incomplete, mismatched and malformed data yield no invented classification', () => {
  for (const bad of [null, [], false, 'text', {}, { move: {} }]) assert.equal(classifyMove(bad), null);
  const mutations = [
    (v) => { v.before.status = 'pending'; },
    (v) => { v.after.status = 'error'; },
    (v) => { v.before.fen = position('d4'); },
    (v) => { v.after.fen = position('d4'); },
    (v) => { v.after.engine.version = '18'; },
    (v) => { v.before.engine.version = null; },
    (v) => { v.before.engine.version = Number.NaN; },
    (v) => { v.after.cpWhite = null; },
    (v) => { v.before.cpWhite = Number.POSITIVE_INFINITY; },
    (v) => { v.move.color = 'b'; },
    (v) => { v.move.uci = 'e2e4\n'; },
    (v) => { v.move.fen = position('d4'); },
    (v) => { v.beforeFen = 'not a FEN'; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.equal(classifyMove(input), null, mutate.toString());
  }
  const input = addPv(fixture({ beforeFen: '6k1/5ppp/8/7Q/8/8/5P1P/6RK w - - 0 1', san: 'Rxg7+', best: true }), 'Kxg7', 'Qg5+');
  input.after.pvUci[1] = 'h1h8';
  assert.equal(classifyMove(input).type, 'best', 'a malformed line cannot establish a sacrifice');
});

test('promotion, en passant and castling transitions are verified by the chess rules', () => {
  for (const [beforeFen, san] of [
    ['7k/P7/8/8/8/8/8/7K w - - 0 1', 'a8=Q+'],
    [position('e4', 'a6', 'e5', 'd5'), 'exd6'],
    [position('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'), 'O-O'],
  ]) {
    const input = fixture({ beforeFen, san, best: true });
    assert.equal(classifyMove(input).type, 'best');
    assert.equal(classifyMove(input).bestSan, input.move.san);
  }
});
