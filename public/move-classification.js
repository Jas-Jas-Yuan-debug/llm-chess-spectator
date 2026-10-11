import { Chess } from './vendor/chess.js';

// These labels use local heuristics. They do not reproduce Chess.com's ratings.
export const MOVE_RATINGS = Object.freeze({
  book: { label: 'Book', symbol: '▣', description: 'A move in the selected opening book.' },
  brilliant: { label: 'Brilliant', symbol: '!!', description: 'A sound piece sacrifice supported by the engine’s best line.' },
  great: { label: 'Great', symbol: '!', description: 'A best move that preserves a turning point after the opponent’s error.' },
  best: { label: 'Best', symbol: '★', description: 'The engine’s first choice in this position.' },
  excellent: { label: 'Excellent', symbol: '✓', description: 'An estimated outcome loss of at most 2 percentage points.' },
  good: { label: 'Good', symbol: '•', description: 'An estimated outcome loss of at most 5 percentage points.' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', description: 'An estimated outcome loss of at most 10 percentage points.' },
  mistake: { label: 'Mistake', symbol: '?', description: 'An estimated outcome loss of at most 20 percentage points.' },
  blunder: { label: 'Blunder', symbol: '??', description: 'An estimated outcome loss greater than 20 percentage points.' },
  miss: { label: 'Miss', symbol: '×', description: 'A winning opportunity created by the opponent was lost.' },
});

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAMES = { n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };
const EPSILON = 1e-12;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const atMost = (value, limit) => value <= limit + EPSILON;
const atLeast = (value, limit) => value >= limit - EPSILON;
const isUci = (value) => typeof value === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value);

function playUci(chess, uci) {
  if (!isUci(uci)) return null;
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
  } catch { return null; }
}

function validFen(fen) {
  if (typeof fen !== 'string' || fen.length > 200 || fen.split(' ').length !== 6) return null;
  try {
    const chess = new Chess(fen);
    return chess.fen() === fen ? chess : null;
  } catch { return null; }
}

function engineIdentity(data) {
  const name = data?.engine?.name;
  const version = data?.engine?.version;
  if (typeof name !== 'string' || !name.trim() || !['string', 'number'].includes(typeof version) || !String(version).trim()
    || (typeof version === 'number' && !Number.isFinite(version))) return null;
  return `${name.trim()}\u0000${String(version).trim()}`;
}

function hasValidWdl(data) {
  const wdl = data?.wdlWhite;
  return Boolean(wdl && ['win', 'draw', 'loss'].every((key) => Number.isInteger(wdl[key]) && wdl[key] >= 0 && wdl[key] <= 1000)
    && wdl.win + wdl.draw + wdl.loss === 1000);
}

function whiteExpected(data) {
  if (!data || data.status !== 'ready') return null;
  const hasCp = isNumber(data.cpWhite);
  const hasMate = isNumber(data.mateWhite);
  if (hasCp === hasMate) return null;
  if (hasMate) {
    if (!Number.isInteger(data.mateWhite)) return null;
    const winner = data.winningColor === 'w' || data.winningColor === 'b'
      ? data.winningColor : data.mateWhite > 0 ? 'w' : data.mateWhite < 0 ? 'b' : null;
    if (!winner || (data.mateWhite !== 0 && winner !== (data.mateWhite > 0 ? 'w' : 'b'))) return null;
    return winner === 'w' ? 1 : 0;
  }
  const wdl = data.wdlWhite;
  if (hasValidWdl(data)) {
    return (wdl.win + wdl.draw / 2) / 1000;
  }
  // When WDL is absent, this explicitly local logistic uses a 300 cp scale.
  return 1 / (1 + Math.exp(-Math.max(-100000, Math.min(100000, data.cpWhite)) / 300));
}

function moverExpected(data, color) {
  const white = whiteExpected(data);
  return white === null ? null : color === 'w' ? white : 1 - white;
}

function previousExpected(previous, beforeFen, mover, engine) {
  if (!previous || engineIdentity(previous) !== engine || moverExpected(previous, mover) === null) return null;
  const chess = validFen(previous.fen);
  if (!chess || chess.turn() === mover) return null;
  // This proves that the extra score belongs to the immediately preceding
  // opponent position, rather than any earlier position in the game.
  if (!chess.moves({ verbose: true }).some((move) => move.after === beforeFen)) return null;
  return moverExpected(previous, mover);
}

function materialBalance(chess, color) {
  return chess.board().flat().reduce((sum, piece) => sum + (piece ? VALUES[piece.type] * (piece.color === color ? 1 : -1) : 0), 0);
}

function sacrificeEvidence(beforeChess, afterChess, after, mover) {
  if (!Array.isArray(after.pvUci) || after.pvUci.length < 2 || after.pvUci[0] !== after.bestMove) return null;
  const baseline = materialBalance(beforeChess, mover);
  const line = new Chess(afterChess.fen());
  const reply = playUci(line, after.pvUci[0]);
  if (!reply || reply.color === mover || !NAMES[reply.captured]) return null;
  const immediatelyLost = baseline - materialBalance(line, mover);
  if (immediatelyLost < 2) return null;
  const followup = playUci(line, after.pvUci[1]);
  if (!followup || followup.color !== mover) return null;
  const stillLost = baseline - materialBalance(line, mover);
  if (stillLost < 2) return null;
  return { piece: NAMES[reply.captured], reply: reply.san, followup: followup.san, material: stillLost };
}

function openingDetails(book) {
  if (!book || typeof book !== 'object' || Array.isArray(book)) return null;
  const eco = typeof book.eco === 'string' ? book.eco.trim().slice(0, 12) : '';
  const name = typeof book.name === 'string' ? book.name.trim().slice(0, 200) : '';
  return eco || name ? { eco, name } : null;
}

/**
 * Classify an already played move without mutating game or evaluation data.
 * `book` is an exact opening-book lookup supplied by the caller.
 * `previousBefore` evaluates the position before the opponent's preceding move.
 */
export function classifyMove(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { move, beforeFen, before, after, previousBefore, book } = input;
  if (!move || !['w', 'b'].includes(move.color) || !isUci(move.uci)) return null;
  const beforeChess = validFen(beforeFen);
  if (!beforeChess || beforeChess.turn() !== move.color) return null;
  const afterChess = new Chess(beforeFen);
  const played = playUci(afterChess, move.uci);
  if (!played || afterChess.fen() !== move.fen) return null;
  const opening = openingDetails(book);
  if (opening) {
    return {
      type: 'book', reason: opening?.name ? `Opening book: ${opening.name}${opening.eco ? ` (${opening.eco})` : ''}.` : 'This legal move is in the selected opening book.',
      lossCp: null, lossExpected: null, bestMove: null, bestSan: null, depth: 0,
      ...(opening ? { opening } : {}),
    };
  }
  const engine = engineIdentity(before);
  if (!engine || engineIdentity(after) !== engine || before?.fen !== beforeFen || after?.fen !== move.fen) return null;
  const priorScore = moverExpected(before, move.color);
  const nextScore = moverExpected(after, move.color);
  if (priorScore === null || nextScore === null) return null;
  const lossExpected = Math.max(0, priorScore - nextScore);
  const lossCp = isNumber(before.cpWhite) && isNumber(after.cpWhite)
    ? Math.max(0, (before.cpWhite - after.cpWhite) * (move.color === 'w' ? 1 : -1)) : null;
  const bestChess = new Chess(beforeFen);
  const best = playUci(bestChess, before.bestMove);
  const isBest = Boolean(best && before.bestMove === move.uci);
  const details = {
    lossCp, lossExpected, bestMove: best ? before.bestMove : null, bestSan: best?.san ?? null,
    depth: Math.min(Number.isInteger(before.depth) && before.depth >= 0 ? before.depth : 0, Number.isInteger(after.depth) && after.depth >= 0 ? after.depth : 0),
  };
  const result = (type, reason) => ({ type, reason, ...details });
  if (atMost(lossExpected, 0.02) && atLeast(nextScore, 0.5) && atMost(priorScore, 0.9)) {
    const sacrifice = sacrificeEvidence(beforeChess, afterChess, after, move.color);
    if (sacrifice) {
      return result('brilliant', `Sound ${sacrifice.piece} sacrifice in the engine’s best line: ${sacrifice.reply} ${sacrifice.followup}; at least ${sacrifice.material} points of material remain sacrificed. This is a local heuristic.`);
    }
  }
  const previousScore = previousExpected(previousBefore, beforeFen, move.color, engine);
  if (isBest && previousScore !== null && atMost(previousScore, 0.55) && atLeast(priorScore - previousScore, 0.15)
    && atLeast(nextScore - previousScore, 0.15) && atLeast(nextScore, 0.5) && atMost(lossExpected, 0.02)) {
    return result('great', 'The engine’s best move preserves a turning point created by the opponent’s preceding error. This heuristic does not establish a unique move.');
  }
  if (!isBest && previousScore !== null && atLeast(priorScore - previousScore, 0.1)
    && atLeast(priorScore, 0.65) && atMost(nextScore, 0.55)) {
    return result('miss', 'The opponent’s preceding move created a winning opportunity, and this move lost it according to the engine’s estimated outcomes.');
  }
  if (isBest) return result('best', 'This move matches the engine’s first choice in the position before the move.');
  if (afterChess.isCheckmate()) return result('best', 'This move delivers checkmate.');
  const points = (lossExpected * 100).toFixed(1);
  const reason = `Estimated outcome loss: ${points} percentage points. Ratings use local thresholds${hasValidWdl(before) && hasValidWdl(after) ? ' and engine WDL' : '; scores without WDL use a 300 cp logistic scale'}.`;
  if (atMost(lossExpected, 0.02)) return result('excellent', reason);
  if (atMost(lossExpected, 0.05)) return result('good', reason);
  if (atMost(lossExpected, 0.1)) return result('inaccuracy', reason);
  if (atMost(lossExpected, 0.2)) return result('mistake', reason);
  return result('blunder', reason);
}
