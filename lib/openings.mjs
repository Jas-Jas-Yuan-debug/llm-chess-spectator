import { Chess } from 'chess.js';
import { BOOK_SOURCE, OPENING_BOOK } from '../public/opening-book.js';
import { validateEvaluationFen } from './stockfish.mjs';

const SOURCE = Object.freeze({
  name: 'Lichess openings',
  commit: BOOK_SOURCE.commit,
  openingCount: BOOK_SOURCE.openingCount,
  transitionCount: BOOK_SOURCE.transitionCount,
});
const index = new Map();

// The bundled table contains exact position + move transitions, not game counts.
// Copy its bounded factual labels once; each lookup still checks current legality.
for (const [key, label] of Object.entries(OPENING_BOOK)) {
  const separator = key.lastIndexOf('|');
  const position = key.slice(0, separator);
  const uci = key.slice(separator + 1);
  if (separator < 1 || position.length > 180 || position.split(' ').length !== 4 ||
      !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) || !/^[A-E]\d{2}$/.test(label?.eco) ||
      typeof label?.name !== 'string' || label.name.length > 300) continue;
  const candidates = index.get(position) ?? new Map();
  candidates.set(uci, Object.freeze({ uci, eco: label.eco, name: label.name }));
  index.set(position, candidates);
}

export function getOpeningInfo(input) {
  let fen;
  try { fen = validateEvaluationFen(input); }
  catch { return null; }
  const chess = new Chess(fen);
  const candidates = index.get(fen.split(' ').slice(0, 4).join(' '));
  const moves = [];
  if (candidates) {
    for (const move of chess.moves({ verbose: true })) {
      const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
      const candidate = candidates.get(uci);
      if (!candidate) continue;
      moves.push(Object.freeze({ ...candidate, san: move.san }));
      if (moves.length === 64) break;
    }
    moves.sort((first, second) => first.uci.localeCompare(second.uci));
  }
  return Object.freeze({ source: SOURCE, inBook: moves.length > 0, moves: Object.freeze(moves) });
}
