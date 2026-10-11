import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { OPENING_BOOK, BOOK_SOURCE } from '../public/opening-book.js';
import { buildOpeningBook, renderOpeningBook, parseOpeningTsv } from '../scripts/build-opening-book.mjs';

const position = fen => fen.split(' ').slice(0, 4).join(' ');
const transition = move => `${position(move.before)}|${move.from}${move.to}${move.promotion || ''}`;
const source = rows => `eco\tname\tpgn\n${rows.map(row => row.join('\t')).join('\n')}\n`;
const fixture = () => ({
  'a.tsv': source([['A00', 'Anderssen Opening', '1. a3']]),
  'b.tsv': source([
    ['B00', "King's Pawn Game", '1. e4'],
    ['B20', 'Sicilian Defense', '1. e4 c5'],
    ['B50', 'Sicilian Defense', '1. e4 c5 2. Nf3 d6'],
    ['B50', 'Sicilian Defense: Modern Variations', '1. e4 c5 2. Nf3 d6'],
    ['B54', 'Sicilian Defense: Dragon Variation, Accelerated Dragon', '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 g6'],
  ]),
  'c.tsv': source([['C20', "King's Pawn Game", '1. e4 e5']]),
  'd.tsv': source([['D00', "Queen's Pawn Game", '1. d4 d5']]),
  'e.tsv': source([['E00', 'Indian Game', '1. d4 Nf6 2. c4']]),
});

function play(moves) {
  const chess = new Chess();
  for (const move of moves.split(' ')) chess.move(move);
  return chess;
}

test('opening generator has deterministic ordering and fixed source metadata without network access', () => {
  const data = fixture();
  const forward = buildOpeningBook(data);
  const reversed = buildOpeningBook(Object.fromEntries(Object.entries(data).reverse()));
  assert.equal(renderOpeningBook(forward), renderOpeningBook(reversed));
  assert.equal(forward.source.commit, BOOK_SOURCE.commit);
  assert.equal(forward.source.license, 'CC0-1.0');
  assert.equal(forward.source.maxPlies, 40);
  assert.deepEqual(Object.keys(forward.book), Object.keys(forward.book).sort());
});

test('opening labels describe completed named positions rather than speculative future variations', () => {
  const { book } = buildOpeningBook(fixture());
  const e4 = new Chess().move('e4');
  assert.deepEqual(book[transition(e4)], { eco: 'B00', name: "King's Pawn Game" });
  const d6 = play('e4 c5 Nf3 d6').history({ verbose: true }).at(-1);
  assert.deepEqual(book[transition(d6)], { eco: 'B50', name: 'Sicilian Defense: Modern Variations' });
  const nxd4 = play('e4 c5 Nf3 d6 d4 cxd4 Nxd4').history({ verbose: true }).at(-1);
  assert.deepEqual(book[transition(nxd4)], { eco: 'B50', name: 'Sicilian Defense: Modern Variations' });
  const g6 = play('e4 c5 Nf3 d6 d4 cxd4 Nxd4 g6').history({ verbose: true }).at(-1);
  assert.deepEqual(book[transition(g6)], { eco: 'B54', name: 'Sicilian Defense: Dragon Variation, Accelerated Dragon' });
});

test('unnamed early prefixes use the shortest continuation family', () => {
  const data = fixture();
  data['a.tsv'] = source([
    ['A04', 'Reti Opening: Longer Variation', '1. Nf3 d5 2. d4'],
    ['A04', 'Zukertort Opening: Short Variation', '1. Nf3 Nf6'],
  ]);
  const { book } = buildOpeningBook(data);
  const nf3 = new Chess().move('Nf3');
  assert.deepEqual(book[transition(nf3)], { eco: 'A04', name: 'Zukertort Opening' });
});

test('generated transitions are exactly source-line moves and do not infer legal continuations', () => {
  const data = fixture();
  const { book } = buildOpeningBook(data);
  const expected = new Set(Object.entries(data).flatMap(([file, content]) =>
    parseOpeningTsv(content, file).flatMap(row => row.moves.map(transition))));
  assert.deepEqual(new Set(Object.keys(book)), expected);
  assert.equal(book[transition(new Chess().move('Nc3'))], undefined);
  const continuation = play('e4 c5 Nf3 d6 d4 cxd4 Nxd4');
  assert.equal(book[transition(continuation.move('a6'))], undefined);
});

test('generator validates source lines and stops storing transitions after 40 plies', () => {
  const data = fixture();
  const chess = new Chess();
  for (let index = 0; index < 9; index += 1) {
    for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) chess.move(move);
  }
  for (const move of ['a3', 'a6', 'a4', 'a5', 'h3', 'h6']) chess.move(move);
  data['a.tsv'] = source([['A00', 'Long Opening: Boundary Variation', chess.pgn().split('\n\n').at(-1)]]);
  const { book } = buildOpeningBook(data);
  const history = chess.history({ verbose: true });
  assert.ok(book[transition(history[39])]);
  assert.equal(book[transition(history[40])], undefined);
  assert.equal(book[transition(history[41])], undefined);
});

test('invalid source format, illegal moves, null moves and nonstandard starts are rejected', () => {
  assert.throws(() => parseOpeningTsv('eco,name,pgn\n', 'a.tsv'), /unexpected TSV header/);
  assert.throws(() => parseOpeningTsv(source([['A00', 'Wrong volume', '1. e4']]), 'b.tsv'), /invalid opening record/);
  assert.throws(() => parseOpeningTsv(source([['B00', 'Illegal', '1. e5']]), 'b.tsv'), /invalid legal move sequence/);
  assert.throws(() => parseOpeningTsv(source([['B00', 'Null', '1. --']]), 'b.tsv'), /unsupported move count|invalid legal move sequence/);
  assert.throws(() => parseOpeningTsv(source([['B00', 'Extra field', '1. e4', 'extra']]), 'b.tsv'), /exactly three fields/);
  const customStart = '[SetUp "1"] [FEN "4k3/8/8/8/8/8/8/4K3 w - - 0 1"] 1. Kd2';
  assert.throws(() => parseOpeningTsv(source([['A00', 'Custom start', customStart]]), 'a.tsv'), /unsupported move count|invalid legal move sequence/);
});

test('every bundled opening transition is a legal UCI move from its exact FEN', () => {
  assert.equal(Object.keys(OPENING_BOOK).length, BOOK_SOURCE.transitionCount);
  assert.equal(BOOK_SOURCE.openingCount, 3865);
  assert.equal(BOOK_SOURCE.transitionCount, 8192);
  for (const [key, label] of Object.entries(OPENING_BOOK)) {
    const [fen, uci] = key.split('|');
    assert.match(uci, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
    const chess = new Chess(`${fen} 0 1`);
    assert.ok(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) }));
    assert.match(label.eco, /^[A-E]\d{2}$/);
    assert.ok(label.name);
  }
});

test('bundled Najdorf line marks only its 15 published prefix transitions', () => {
  const chess = new Chess();
  const knownLine = 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7';
  const labels = knownLine.split(' ').map(san => OPENING_BOOK[transition(chess.move(san))]);
  assert.deepEqual(labels.map(Boolean), [...Array(15).fill(true), ...Array(5).fill(false)]);
  assert.equal(labels[6].name, 'Sicilian Defense');
  assert.equal(labels[9].name, 'Sicilian Defense: Najdorf Variation');
  assert.equal(labels[14].name, 'Sicilian Defense: Najdorf Variation, English Attack');
});
