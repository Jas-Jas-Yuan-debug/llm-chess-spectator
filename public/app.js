import { MOVE_RATINGS, classifyMove } from './move-classification.js';
import { OPENING_BOOK } from './opening-book.js';

const $ = (id) => document.getElementById(id);
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FILES = 'abcdefgh';
let state = null;
let flipped = false;
let reviewPly = null;
let busy = false;
let stream = null;
let streamReconnectTimer;
let streamGeneration = 0;
let streamRetryMs = 1000;
let streamStopped = false;
const ACCESS_STORAGE_KEY = 'spectator.viewerAccess';
const ACCESS_MESSAGE = 'Open Start Chess.command or the private viewer link printed by the server to access this arena.';
let viewerCapability = readViewerCapability();
let toastTimer;
let lastMoveCount = 0;
let currentGameId = null;
let explanationColor = null;
let evaluationFen = null;
let evaluationData = null;
let evaluationSequence = 0;
let evaluationPollTimer;
let evaluationController;
let confirmedEngineName = '';
let connection = { connected: false, checking: true };
let initialFen = START_FEN;
const readyEvaluations = new Map();
const moveReviews = new Map();
const reviewFailures = new Map();
let reviewContexts = [];
let reviewGeneration = 0;
let reviewTimer;
let reviewJob = null;
let reviewHalted = false;
let reviewBackoffUntil = 0;
let reviewError = '';
let reviewFailureCount = 0;
const REVIEW_POSITION_TIMEOUT_MS = 45000;
const RATING_ORDER = Object.freeze(['book', 'brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'miss']);
// Original, local SVG marks. All paths and classes come from this fixed list.
const RATING_MARKS = Object.freeze({
  book: '<path d="M12 6c-3-2-7-2-9-1v13c3-1 6-1 9 1 3-2 6-2 9-1V5c-2-1-6-1-9 1Zm0 0v13"/>',
  brilliant: '<path d="M8 5v8m8-8v8"/><circle cx="8" cy="18" r="1.1"/><circle cx="16" cy="18" r="1.1"/>',
  great: '<path d="M12 5v8"/><circle cx="12" cy="18" r="1.1"/>',
  best: '<path class="rating-solid" d="m12 3 2.6 5.8 6.4.6-4.8 4.2 1.4 6.4-5.6-3.3L6.4 20l1.4-6.4L3 9.4l6.4-.6Z"/>',
  excellent: '<path d="m5 12 4.5 4.5L19 7"/>',
  good: '<path d="M8 11h-4v9h4m0-9 4-7c2 0 3 1 2 5h5c2 0 2 1 2 3l-2 6c-.3 1.2-1 2-2 2H8V11Z"/>',
  inaccuracy: '<path d="M3.5 7c0-4 6.5-4 6.5 0 0 2-3.2 2.3-3.2 5m10-7v8"/><circle cx="6.8" cy="18" r="1"/><circle cx="16.8" cy="18" r="1"/>',
  mistake: '<path d="M8 7c0-5 8-5 8 0 0 3-4 3-4 6"/><circle cx="12" cy="18" r="1.1"/>',
  blunder: '<path d="M2.5 7c0-4 7-4 7 0 0 2.5-3.5 2.5-3.5 6m8.5-6c0-4 7-4 7 0 0 2.5-3.5 2.5-3.5 6"/><circle cx="6" cy="18" r="1"/><circle cx="18" cy="18" r="1"/>',
  miss: '<circle cx="11" cy="13" r="7"/><circle cx="11" cy="13" r="3"/><path d="m12 12 8-8m-5 0h5v5"/>',
});

function validCapability(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

function readViewerCapability() {
  let supplied = null;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (fragment.has('access_token')) {
    supplied = fragment.get('access_token');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    try {
      if (validCapability(supplied)) window.sessionStorage.setItem(ACCESS_STORAGE_KEY, supplied);
      else window.sessionStorage.removeItem(ACCESS_STORAGE_KEY);
    } catch { /* A private link still works when session storage is unavailable. */ }
    return validCapability(supplied) ? supplied : null;
  }
  try {
    const saved = window.sessionStorage.getItem(ACCESS_STORAGE_KEY);
    return validCapability(saved) ? saved : null;
  } catch { return null; }
}

class AccessError extends Error {
  constructor() { super(ACCESS_MESSAGE); this.name = 'AccessError'; }
}

function showAccessRequired() {
  viewerCapability = null;
  try { window.sessionStorage.removeItem(ACCESS_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
  streamStopped = true;
  streamGeneration += 1;
  stream?.abort();
  clearTimeout(streamReconnectTimer);
  clearTimeout(evaluationPollTimer);
  evaluationController?.abort();
  renderOpeningDatabase(null, null);
  resetMoveReview();
  if (state) renderReviewUpdates();
  $('page-error-text').textContent = ACCESS_MESSAGE;
  $('page-error').hidden = false;
  $('retry-state').hidden = true;
  $('connection-error').hidden = true;
  $('connection-label').textContent = 'Private viewer';
  $('connection-dot').className = 'status-dot';
  $('connection-button').disabled = true;
  $('retry-connection').disabled = true;
  $('play-button').disabled = true;
  $('step-button').disabled = true;
  $('reset-button').disabled = true;
  $('match-label-text').textContent = 'PRIVATE ARENA';
  if (!state) $('board-loading').innerHTML = '<span>Open the private viewer link to enter.</span>';
}

// Deliberately self-contained: no icon fonts, image requests, or piece CDNs.
const PIECE_PATHS = {
  p: '<circle cx="32" cy="17" r="7.5"/><path d="M26 26h12c-1 6 0 11 5 18H21c5-7 6-12 5-18Z"/><path d="M20 44h24l3 7H17Z"/><path d="M16 52h32v5H16Z"/>',
  r: '<path d="M17 9h7v7h5V9h6v7h5V9h7v14l-6 4v17H23V27l-6-4Z"/><path d="M21 44h22l4 8H17Z"/><path d="M16 52h32v5H16Z"/><path class="piece-detail" d="M22 23h20M23 30h18" fill="none"/>',
  n: '<path d="M20 43c-1-9 3-15 9-20l-9 3-4-7 8-6 2-6 8 3c11 2 15 11 12 23l-4 11Z"/><path d="m25 14 5 5-8 4M36 13c-1 6-3 9-7 13M35 27c-5 3-6 7-5 13" class="piece-detail" fill="none"/><circle cx="31" cy="18" r="1.3" class="piece-eye" stroke="none"/><path d="M20 44h24l3 8H17Z"/><path d="M16 52h32v5H16Z"/>',
  b: '<path d="M32 7c-2 5-12 9-12 18 0 7 5 10 12 10s12-3 12-10C44 16 34 12 32 7Z"/><path d="m33 15-7 11" class="piece-detail" fill="none"/><path d="M26 34h12l3 11H23Z"/><path d="M20 45h24l3 7H17Z"/><path d="M16 52h32v5H16Z"/>',
  q: '<path d="m16 19 7 5 2-10 7 8 7-8 2 10 7-5-8 17H24Z"/><circle cx="15" cy="17" r="3"/><circle cx="25" cy="12" r="3"/><circle cx="39" cy="12" r="3"/><circle cx="49" cy="17" r="3"/><path d="M25 36h14l3 9H22Z"/><path d="M20 45h24l3 7H17Z"/><path d="M16 52h32v5H16Z"/><path class="piece-detail" d="M24 32h16M26 40h12" fill="none"/>',
  k: '<path d="M30 5h4v5h5v4h-5v5h-4v-5h-5v-4h5Z"/><path d="M32 24c-5-8-17-4-16 5 1 7 7 10 10 11h12c3-1 9-4 10-11 1-9-11-13-16-5Z"/><path d="M25 39h14l3 6H22Z"/><path d="M20 45h24l3 7H17Z"/><path d="M16 52h32v5H16Z"/><path class="piece-detail" d="M32 25v11M24 35h16" fill="none"/>',
};
const PIECE_NAMES = { p: 'pawn', r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king' };
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function pieceSvg(type, color, labeled = false) {
  const white = color === 'w';
  const fill = white ? '#fffef4' : '#34493a';
  const stroke = white ? '#54624a' : '#203426';
  const detail = white ? '#637057' : '#adbaa2';
  return `<svg class="chess-piece ${white ? 'white-piece' : 'black-piece'}" viewBox="0 0 64 64" ${labeled ? `role="img" aria-label="${white ? 'White' : 'Black'} ${PIECE_NAMES[type]}"` : 'aria-hidden="true"'}><g fill="${fill}" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${(PIECE_PATHS[type] || '').replaceAll('class="piece-detail"', `class="piece-detail" stroke="${detail}"`).replaceAll('class="piece-eye"', `class="piece-eye" fill="${detail}"`)}</g></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function ratingInfo(type) {
  const key = String(type || '').toLowerCase();
  return RATING_ORDER.includes(key) && MOVE_RATINGS[key] ? { key, ...MOVE_RATINGS[key] } : null;
}

function ratingBadge(result, { board = false } = {}) {
  const info = ratingInfo(result?.type);
  if (!info) return '';
  const label = `${info.label}. ${result.reason || info.description}`;
  return `<span class="move-rating rating-${info.key}${board ? ' board-move-rating' : ''}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${board ? ' tabindex="0"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${RATING_MARKS[info.key]}</svg></span>`;
}

function startingFen(next) {
  const header = typeof next.pgn === 'string' ? next.pgn.match(/^\[FEN\s+"([^"\r\n]+)"\]\s*$/m)?.[1] : null;
  if (!header || header.split(/\s+/).length !== 6) return START_FEN;
  try {
    const board = parseFen(header);
    return board.length === 8 && board.every(row => row.length === 8) && /^[wb]$/.test(header.split(/\s+/)[1]) ? header : START_FEN;
  } catch { return START_FEN; }
}

function boundedSet(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function readyEvaluation(fen) {
  const data = readyEvaluations.get(fen);
  if (data) { readyEvaluations.delete(fen); readyEvaluations.set(fen, data); }
  return data;
}

function rememberEvaluation(fen, data) {
  if (data?.status !== 'ready' || data.fen && data.fen !== fen) return false;
  boundedSet(readyEvaluations, fen, { ...data, fen }, 128);
  reviewFailures.delete(fen);
  return true;
}

function resetMoveReview() {
  reviewGeneration += 1;
  clearTimeout(reviewTimer);
  reviewTimer = null;
  reviewJob?.controller.abort();
  reviewJob = null;
  readyEvaluations.clear();
  moveReviews.clear();
  reviewFailures.clear();
  reviewContexts = [];
  reviewHalted = false;
  reviewBackoffUntil = 0;
  reviewError = '';
  reviewFailureCount = 0;
}

function buildReviewContexts() {
  initialFen = startingFen(state);
  reviewContexts = state.moves.slice(-1000).map((move, offset) => {
    const index = Math.max(0, state.moves.length - 1000) + offset;
    const beforeFen = index ? state.moves[index - 1].fen : initialFen;
    const previousFen = index > 0 ? index > 1 ? state.moves[index - 2].fen : initialFen : null;
    const key = JSON.stringify([state.id, index + 1, beforeFen, move.fen, move.uci]);
    const bookKey = `${String(beforeFen || '').split(/\s+/).slice(0, 4).join(' ')}|${move.uci}`;
    return { key, ply: index + 1, move, beforeFen, afterFen: move.fen, previousFen, book: OPENING_BOOK[bookKey] };
  });
}

function reviewContext(ply) {
  return reviewContexts[ply - (reviewContexts[0]?.ply || 1)];
}

function syncMoveReviews() {
  let changed = false;
  for (const context of reviewContexts) {
    let entry = moveReviews.get(context.key);
    if (!entry) {
      entry = { status: 'pending', result: null, complete: false };
      boundedSet(moveReviews, context.key, entry, 1000);
    }
    if (entry.complete) continue;
    const before = readyEvaluation(context.beforeFen);
    const after = readyEvaluation(context.afterFen);
    const previousBefore = context.previousFen ? readyEvaluation(context.previousFen) : null;
    if (!context.book && (!before || !after)) continue;
    let result;
    try { result = classifyMove({ move: context.move, beforeFen: context.beforeFen, before, after, previousBefore, book: context.book }); }
    catch { result = null; }
    if (ratingInfo(result?.type)) {
      if (JSON.stringify(entry.result) !== JSON.stringify(result)) changed = true;
      entry.result = result;
      entry.status = 'ready';
      entry.complete = result.type === 'book' || !context.previousFen || Boolean(previousBefore) || reviewFailures.has(context.previousFen);
    } else if (before && after) {
      entry.status = 'unrated';
      entry.complete = true;
      changed = true;
    }
  }
  return changed;
}

function reviewStatus(context) {
  const entry = context && moveReviews.get(context.key);
  if (entry?.result) return 'ready';
  if (entry?.status === 'unrated') return 'unrated';
  if (context && (reviewHalted || [context.beforeFen, context.afterFen].some(fen => reviewFailures.has(fen)) || ['error', 'unavailable'].includes(evaluationData?.status))) return 'unavailable';
  return 'pending';
}

function renderMoveReview(view) {
  const context = reviewContext(view.ply);
  const entry = context && moveReviews.get(context.key);
  const status = reviewStatus(context);
  const detailsOpen = $('move-rating-details')?.open || false;
  const container = $('move-review-content');
  const error = context ? reviewFailures.get(context.beforeFen)?.error || reviewFailures.get(context.afterFen)?.error || reviewError : '';
  const renderKey = JSON.stringify([context?.key, status, entry?.result, error, Boolean(viewerCapability)]);
  if (container.dataset.reviewKey === renderKey) return;
  container.dataset.reviewKey = renderKey;
  const detailsFocused = document.activeElement === $('move-rating-details')?.querySelector('summary');
  if (!context) {
    container.innerHTML = '<p class="move-review-empty">Select a completed move to see its engine rating.</p>';
  } else if (entry?.result) {
    const result = entry.result;
    const info = ratingInfo(result.type);
    const moveLabel = `${Math.ceil(context.ply / 2)}${context.move.color === 'w' ? '.' : '…'} ${context.move.san}`;
    const metrics = [];
    if (Number.isFinite(result.depth)) metrics.push(`Analysis depth ${result.depth}`);
    if (Number.isFinite(result.lossCp)) metrics.push(`Evaluation loss ${Math.max(0, result.lossCp / 100).toFixed(2)} pawns`);
    if (Number.isFinite(result.lossExpected)) metrics.push(`Expected score loss ${Math.max(0, result.lossExpected * 100).toFixed(1)} percentage points`);
    if (result.bestSan || result.bestMove) metrics.push(`Engine choice: ${result.bestSan || result.bestMove}`);
    if (result.opening?.name) metrics.push(`${result.opening.eco || ''} ${result.opening.name}`.trim());
    container.innerHTML = `<div class="move-review-summary">${ratingBadge(result)}<strong>${escapeHtml(info.label)}</strong><span>${escapeHtml(moveLabel)}</span></div><p class="move-review-reason">${escapeHtml(result.reason || info.description)}</p>${metrics.length ? `<details class="move-rating-details" id="move-rating-details"${detailsOpen ? ' open' : ''}><summary>Analysis details</summary><p>${escapeHtml(metrics.join(' · '))}</p></details>` : ''}`;
  } else {
    const pending = status === 'pending';
    const message = pending ? 'Stockfish is reviewing this move…' : status === 'unrated' ? 'This move is unrated. A complete engine comparison is unavailable.' : 'This move is unrated. Engine review is unavailable.';
    container.innerHTML = `<div class="move-review-summary">${pending ? '<span class="spinner" aria-hidden="true"></span>' : ''}<strong>${pending ? 'Review pending' : 'Unrated'}</strong><span>${escapeHtml(context.move.san)}</span></div><p class="move-review-reason"${error ? ` title="${escapeHtml(error)}"` : ''}>${message}</p>`;
  }
  if (detailsFocused) $('move-rating-details')?.querySelector('summary')?.focus({ preventScroll: true });
  $('retry-move-review').hidden = !context || status === 'ready' || status === 'pending' || !viewerCapability;
}

function renderRatingLegend() {
  $('rating-legend').innerHTML = RATING_ORDER.map(type => {
    const info = ratingInfo(type);
    return `<div class="rating-guide-item">${ratingBadge({ type, reason: info.description })}<span><strong>${escapeHtml(info.label)}</strong><span>${escapeHtml(info.description)}</span></span></div>`;
  }).join('');
}

function renderReviewUpdates() {
  if (!state) return;
  const view = currentView();
  renderBoard(view);
  renderMoves(view);
  renderMoveReview(view);
}

function scheduleMoveReview(delay = 0) {
  if (reviewTimer !== null && reviewTimer !== undefined || reviewHalted || !state || !viewerCapability) return;
  reviewTimer = setTimeout(() => { reviewTimer = null; pumpMoveReview(); }, Math.max(delay, reviewBackoffUntil - Date.now(), 0));
}

function nextReviewPosition() {
  const selected = currentView()?.ply;
  const prioritized = [...new Set([reviewContext(selected), reviewContexts.at(-1), ...reviewContexts])].filter(Boolean);
  for (const context of prioritized) {
    if (moveReviews.get(context.key)?.complete) continue;
    for (const fen of [context.beforeFen, context.afterFen, context.previousFen]) {
      if (fen && !readyEvaluations.has(fen) && !reviewFailures.has(fen)) return fen;
    }
  }
  return null;
}

function failReviewPosition(job, message, halt = false) {
  boundedSet(reviewFailures, job.fen, { error: message }, 128);
  reviewError = message;
  reviewFailureCount += 1;
  reviewHalted = halt || reviewFailureCount >= 3;
  reviewBackoffUntil = Date.now() + 4000;
  if (reviewJob === job) reviewJob = null;
  syncMoveReviews();
  renderReviewUpdates();
}

async function pumpMoveReview() {
  if (!state || !viewerCapability || reviewHalted || reviewJob?.pending) return;
  // The displayed board always gets its request before background review work.
  if (evaluationFen !== currentView().fen || evaluationData?.status !== 'ready') return;
  if (Date.now() < reviewBackoffUntil) { scheduleMoveReview(reviewBackoffUntil - Date.now()); return; }
  if (syncMoveReviews()) renderReviewUpdates();
  if (!reviewJob) {
    const fen = nextReviewPosition();
    if (!fen) return;
    reviewJob = { fen, generation: reviewGeneration, startedAt: Date.now(), controller: new AbortController(), pending: false, queueRetries: 0 };
  }
  const job = reviewJob;
  if (Date.now() - job.startedAt >= REVIEW_POSITION_TIMEOUT_MS) {
    failReviewPosition(job, 'The position took too long to evaluate. Retry its move review when the engine is available.');
    scheduleMoveReview(4000);
    return;
  }
  job.pending = true;
  const timeout = setTimeout(() => job.controller.abort(), Math.max(1, REVIEW_POSITION_TIMEOUT_MS - (Date.now() - job.startedAt)));
  try {
    const data = await api(`/api/evaluation?fen=${encodeURIComponent(job.fen)}`, { signal: job.controller.signal });
    if (job.generation !== reviewGeneration || reviewJob !== job) return;
    if (data.fen && data.fen !== job.fen) throw new Error('The evaluator returned a different position.');
    if (rememberEvaluation(job.fen, data)) {
      reviewJob = null;
      syncMoveReviews();
      renderReviewUpdates();
    } else if (data.status !== 'pending') {
      if (/queue is full/i.test(data.error || '') && job.queueRetries < 1) {
        job.queueRetries += 1;
        reviewBackoffUntil = Date.now() + 4000;
      } else failReviewPosition(job, data.error || 'The engine could not review this position.', true);
    }
  } catch (error) {
    if (job.generation !== reviewGeneration || reviewJob !== job || error instanceof AccessError) return;
    failReviewPosition(job, error.name === 'AbortError' ? 'The position took too long to evaluate. Retry its move review.' : error.message, error.name !== 'AbortError');
  } finally {
    clearTimeout(timeout);
    job.pending = false;
    if (job.generation === reviewGeneration && !reviewHalted) scheduleMoveReview(800);
  }
}

function retryMoveReview() {
  const context = reviewContext(currentView()?.ply);
  if (!context || !viewerCapability) return;
  reviewGeneration += 1;
  clearTimeout(reviewTimer);
  reviewTimer = null;
  reviewJob?.controller.abort();
  reviewJob = null;
  for (const fen of [context.beforeFen, context.afterFen, context.previousFen]) {
    if (fen) { reviewFailures.delete(fen); readyEvaluations.delete(fen); }
  }
  moveReviews.delete(context.key);
  reviewHalted = false;
  reviewBackoffUntil = 0;
  reviewError = '';
  reviewFailureCount = 0;
  syncMoveReviews();
  evaluationFen = null;
  syncEvaluation(currentView());
  renderReviewUpdates();
  scheduleMoveReview();
}

function modelName(model, color) {
  if (/astra/i.test(model || '')) return 'GPT-6 Astra';
  if (/6[.\-_]?1.*sol/i.test(model || '')) return 'GPT-6.1 Sol';
  return model || (color === 'w' ? 'GPT-6.1 Sol' : 'GPT-6 Astra');
}

function parseFen(fen) {
  return fen.split(' ')[0].split('/').map((rank) => {
    const row = [];
    for (const char of rank) {
      if (/\d/.test(char)) row.push(...Array(Number(char)).fill(null));
      else row.push({ type: char.toLowerCase(), color: char === char.toUpperCase() ? 'w' : 'b' });
    }
    return row;
  });
}

function currentView() {
  if (!state) return null;
  const count = state.moves.length;
  const ply = reviewPly === null ? count : Math.min(reviewPly, count);
  const move = ply > 0 ? state.moves[ply - 1] : null;
  const fen = reviewPly === null ? state.fen : move?.fen || initialFen;
  return { ply, move, fen, board: reviewPly === null && state.board ? state.board : parseFen(fen), turn: fen.split(' ')[1], isLive: reviewPly === null };
}

function renderBoard(view) {
  const lastSquares = view.move?.uci ? [view.move.uci.slice(0, 2), view.move.uci.slice(2, 4)] : [];
  const rating = moveReviews.get(reviewContext(view.ply)?.key)?.result;
  const board = $('board');
  const renderKey = JSON.stringify([view.fen, flipped, view.isLive, state.inCheck, state.turn, view.move?.uci, rating]);
  if (board.dataset.reviewKey === renderKey) return;
  board.dataset.reviewKey = renderKey;
  const badgeFocused = board.contains(document.activeElement) && document.activeElement?.classList.contains('board-move-rating');
  let html = '';
  for (let displayedRow = 0; displayedRow < 8; displayedRow++) {
    for (let displayedCol = 0; displayedCol < 8; displayedCol++) {
      const row = flipped ? 7 - displayedRow : displayedRow;
      const col = flipped ? 7 - displayedCol : displayedCol;
      const squareName = `${FILES[col]}${8 - row}`;
      const piece = view.board[row][col];
      const checked = view.isLive && state.inCheck && piece?.type === 'k' && piece.color === state.turn;
      const description = `${squareName}${piece ? `, ${piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece.type]}` : ', empty'}`;
      html += `<div class="square${(row + col) % 2 ? ' dark' : ''}${lastSquares.includes(squareName) ? ' last-move' : ''}${checked ? ' check' : ''}" data-square="${squareName}" aria-label="${description}">${displayedCol === 0 ? `<span class="coordinate rank-coordinate" aria-hidden="true">${8 - row}</span>` : ''}${displayedRow === 7 ? `<span class="coordinate file-coordinate" aria-hidden="true">${FILES[col]}</span>` : ''}${piece ? pieceSvg(piece.type, piece.color) : ''}${squareName === lastSquares[1] ? ratingBadge(rating, { board: true }) : ''}</div>`;
    }
  }
  $('board').innerHTML = html;
  if (badgeFocused) board.querySelector('.board-move-rating')?.focus({ preventScroll: true });
  $('board').setAttribute('aria-label', `Chessboard, ${view.isLive ? 'live position' : `after half-move ${view.ply}`}, ${view.turn === 'w' ? 'white' : 'black'} to move${state.inCheck && view.isLive ? ', in check' : ''}${rating ? `. Move rating: ${ratingInfo(rating.type)?.label}` : ''}. ${view.fen}`);
  $('board-loading').hidden = true;
}

function capturedPieces(view) {
  const captured = { w: [], b: [] };
  for (const move of state.moves.slice(0, view.ply)) {
    if (move.captured) captured[move.color].push(move.captured);
  }
  // Missing captured metadata can be recovered from the boards, including en passant.
  if (!state.moves.some((move) => move.captured) && view.ply > 0) {
    let previous = parseFen(initialFen);
    for (const move of state.moves.slice(0, view.ply)) {
      const next = parseFen(move.fen);
      const victim = move.color === 'w' ? 'b' : 'w';
      for (const type of Object.keys(PIECE_VALUES)) {
        const before = previous.flat().filter((p) => p?.color === victim && p.type === type).length;
        const after = next.flat().filter((p) => p?.color === victim && p.type === type).length;
        for (let i = 0; i < before - after; i++) captured[move.color].push(type);
      }
      previous = next;
    }
  }
  for (const color of ['w', 'b']) captured[color].sort((a, b) => PIECE_VALUES[a] - PIECE_VALUES[b]);
  return captured;
}

function renderPlayer(color, target, view, captured) {
  const player = state.players?.[color] || {};
  const isThinking = view.isLive && state.thinking?.color === color;
  const active = view.turn === color && state.status !== 'finished';
  const advantage = captured[color].reduce((sum, type) => sum + PIECE_VALUES[type], 0) - captured[color === 'w' ? 'b' : 'w'].reduce((sum, type) => sum + PIECE_VALUES[type], 0);
  const info = isThinking ? '<span class="spinner" aria-hidden="true"></span><span class="player-elapsed">Thinking</span>' : active ? `<span class="status-dot connected"></span><span>${view.isLive ? 'To move' : 'Next to move'}</span>` : state.status === 'finished' && view.isLive ? '<span>Game over</span>' : '<span>Waiting</span>';
  target.innerHTML = `<div class="player-symbol ${color === 'w' ? 'white-symbol' : ''}">${pieceSvg('k', color)}</div><div class="player-info"><div class="player-name">${escapeHtml(modelName(player.model, color))}<span class="effort-badge">${escapeHtml((player.effort || 'max').toUpperCase())}</span></div><div class="player-color">${color === 'w' ? 'WHITE' : 'BLACK'}</div><div class="captured-pieces" aria-label="Captured pieces">${captured[color].map((type) => pieceSvg(type, color === 'w' ? 'b' : 'w', true)).join('')}${advantage > 0 ? `<span class="captured-score">+${advantage}</span>` : ''}</div></div><div class="player-status ${active ? 'active' : ''}" data-color="${color}">${info}</div>`;
}

function seconds(ms) {
  if (!Number.isFinite(Number(ms))) return '';
  const value = Number(ms) / 1000;
  return `${value < 100 ? value.toFixed(1) : Math.round(value)}s`;
}

function thinkingElapsed() {
  const started = state?.thinking?.startedAt;
  const timestamp = typeof started === 'number' ? started : Date.parse(started);
  return Number.isFinite(timestamp) ? seconds(Math.max(0, Date.now() - timestamp)) : '';
}

function updateClocks() {
  if (!state?.thinking || reviewPly !== null) return;
  const elapsed = thinkingElapsed();
  document.querySelectorAll('.player-elapsed').forEach((item) => { item.textContent = `Thinking${elapsed ? ` · ${elapsed}` : ''}`; });
  if (!state.moves.length) $('thought-time').textContent = elapsed;
  const name = modelName(state.thinking.model, state.thinking.color);
  $('thinking-description').textContent = `${name} is thinking${elapsed ? ` · ${elapsed}` : ''}${state.thinking.attempt > 1 ? ` · attempt ${state.thinking.attempt}` : ''}`;
}

function renderThought(view) {
  const thinking = view.isLive && state.thinking;
  const move = view.move;
  $('thinking-indicator').hidden = !thinking;
  $('thought-text').classList.toggle('has-comment', Boolean(move?.comment));
  if (thinking) {
    const name = modelName(thinking.model, thinking.color);
    $('thinking-description').textContent = `${name} is thinking${thinkingElapsed() ? ` · ${thinkingElapsed()}` : ''}${thinking.attempt > 1 ? ` · attempt ${thinking.attempt}` : ''}`;
  }
  if (thinking && !move) {
    const name = modelName(thinking.model, thinking.color);
    $('thought-label').textContent = 'THINKING NOW';
    $('thought-author').textContent = `${thinking.color === 'w' ? 'White' : 'Black'} · ${name}`;
    $('thought-text').textContent = 'A position. A possibility. A next move.';
    $('thought-caption').textContent = 'The model is considering the legal moves on the board.';
    $('thought-time').textContent = thinkingElapsed();
  } else if (move) {
    $('thought-label').textContent = view.isLive ? 'LATEST MOVE' : 'FROM THIS POSITION';
    $('thought-author').textContent = `${move.color === 'w' ? 'White' : 'Black'} · ${modelName(move.model, move.color)} · ${move.san}`;
    $('thought-text').textContent = move.comment || `${move.color === 'w' ? 'White' : 'Black'} played ${move.san}.`;
    $('thought-caption').textContent = move.comment ? '' : 'The model shared a move without commentary.';
    $('thought-time').textContent = seconds(move.elapsedMs);
  } else {
    $('thought-label').textContent = view.isLive ? 'FROM THE BOARD' : 'THE STARTING POSITION';
    $('thought-author').textContent = '';
    $('thought-text').textContent = 'The opening is still unwritten.';
    $('thought-caption').textContent = view.isLive ? 'Start a match to see each model\'s moves and the explanation it chooses to share.' : 'Thirty-two pieces. White moves first. Return to the live position to follow the match.';
    $('thought-time').textContent = '';
  }
  renderExplanation(view);
}

function renderExplanation(view) {
  $('explain-white-model').textContent = state.players?.w?.model ? modelName(state.players.w.model, 'w') : 'Not configured';
  $('explain-black-model').textContent = state.players?.b?.model ? modelName(state.players.b.model, 'b') : 'Not configured';
  const color = view.isLive ? (explanationColor || view.move?.color || 'w') : (view.move?.color || 'w');
  const move = view.isLive ? state.moves.findLast((entry) => entry.color === color) : view.move;
  const whiteTab = $('explain-white');
  const blackTab = $('explain-black');
  whiteTab.setAttribute('aria-selected', String(color === 'w'));
  blackTab.setAttribute('aria-selected', String(color === 'b'));
  whiteTab.disabled = blackTab.disabled = !view.isLive;
  const panel = $('explanation-body');
  panel.setAttribute('aria-labelledby', color === 'w' ? 'explain-white' : 'explain-black');
  const moveKey = `${color}-${move?.ply || 0}`;
  const scrollTop = panel.dataset.moveKey === moveKey ? panel.scrollTop : 0;
  panel.dataset.moveKey = moveKey;
  if (!move) {
    panel.innerHTML = `<p class="explanation-empty">${view.isLive ? `${color === 'w' ? 'White' : 'Black'}'s decision summary will appear after its first move.` : 'Select a completed move to see its explanation.'}</p>`;
    return;
  }
  const model = modelName(move.model, move.color);
  const heading = `<div class="explanation-move">${escapeHtml(model)} <span>· ${Math.ceil(move.ply / 2)}${move.color === 'w' ? '.' : '…'} ${escapeHtml(move.san)}</span></div>`;
  const explanation = move.explanation;
  if (!explanation || typeof explanation !== 'object') {
    panel.innerHTML = `${heading}<p class="explanation-empty">Detailed explanations are available for new moves.</p>${move.comment ? `<p class="explanation-original"><span>Original commentary</span>${escapeHtml(move.comment)}</p>` : ''}`;
    panel.scrollTop = scrollTop;
    return;
  }
  const sections = [];
  for (const [field, label] of [['idea', 'Why this move'], ['threats', 'Threats & tradeoffs']]) {
    if (typeof explanation[field] === 'string' && explanation[field].trim()) sections.push(`<div class="explanation-detail"><h4>${label}</h4><p>${escapeHtml(explanation[field])}</p></div>`);
  }
  if (Array.isArray(explanation.alternatives) && explanation.alternatives.length) {
    const alternatives = explanation.alternatives.slice(0, 2).filter((entry) => entry && typeof entry.move === 'string' && typeof entry.whyNot === 'string');
    if (alternatives.length) sections.push(`<div class="explanation-detail"><h4>Alternatives</h4><ul>${alternatives.map((entry) => `<li><strong>${escapeHtml(entry.move)}</strong><span>${escapeHtml(entry.whyNot)}</span></li>`).join('')}</ul></div>`);
  }
  if (typeof explanation.plan === 'string' && explanation.plan.trim()) sections.push(`<div class="explanation-detail"><h4>Next plan</h4><p>${escapeHtml(explanation.plan)}</p></div>`);
  panel.innerHTML = `${heading}${sections.join('') || '<p class="explanation-empty">The model did not share a detailed explanation for this move.</p>'}`;
  panel.scrollTop = scrollTop;
}

function renderMoves(view) {
  const count = state.moves.length;
  $('journal-count').textContent = `${String(count).padStart(2, '0')} ${count === 1 ? 'HALF-MOVE' : 'HALF-MOVES'}`;
  const container = $('moves-list');
  const scrollTop = container.scrollTop;
  const focusedPly = container.contains(document.activeElement) ? document.activeElement.closest('[data-ply]')?.dataset.ply : null;
  if (count) {
    let html = '';
    for (let i = 0; i < count; i += 2) {
      html += `<div class="move-row"><span class="move-number">${Math.floor(i / 2) + 1}.</span>`;
      for (let j = i; j < i + 2; j++) {
        const move = state.moves[j];
        const context = move && reviewContext(j + 1);
        const result = context && moveReviews.get(context.key)?.result;
        const info = ratingInfo(result?.type);
        const ratingLabel = info ? `Engine rating: ${info.label}. ${result.reason || info.description}` : reviewStatus(context) === 'pending' ? 'Move review pending.' : 'Move unrated.';
        html += move ? `<button class="move-cell${view.ply === j + 1 ? ' selected' : ''}" data-ply="${j + 1}" aria-label="Review ${move.color === 'w' ? 'white' : 'black'} move ${Math.floor(j / 2) + 1}, ${escapeHtml(move.san)}. ${escapeHtml(ratingLabel)}" aria-pressed="${view.ply === j + 1}" title="${escapeHtml(`${ratingLabel}${move.comment ? ` Model commentary: ${move.comment}` : ''}`)}"><span class="move-notation"><span>${escapeHtml(move.san)}</span>${ratingBadge(result)}</span><span class="move-time">${seconds(move.elapsedMs)}</span>${move.comment ? '<span class="move-comment-icon" aria-hidden="true"></span>' : ''}</button>` : '<span></span>';
      }
      html += '</div>';
    }
    container.innerHTML = html;
    if (focusedPly) container.querySelector(`[data-ply="${Number(focusedPly)}"]`)?.focus({ preventScroll: true });
    if (view.isLive && count > lastMoveCount) container.scrollTop = container.scrollHeight;
    else container.scrollTop = scrollTop;
  } else if (!container.querySelector('.moves-empty')) {
    container.innerHTML = '<div class="moves-empty"><svg class="empty-piece" viewBox="0 0 56 64" aria-hidden="true"><path d="M15 4v17h6v28h-8v10h30V49h-8V21h6V4h-8v9h-5V4h-4v9h-5V4Z"/></svg><h4>A good game starts<br>with a little curiosity.</h4><p>Every move will appear here.<br>Pick one to revisit the position.</p></div>';
  }
  lastMoveCount = count;
  $('first-button').disabled = !count || view.ply === 0;
  $('previous-button').disabled = !count || view.ply === 0;
  $('next-button').disabled = view.isLive || view.ply >= count;
  $('live-button').disabled = view.isLive;
  $('live-button').classList.toggle('is-review', !view.isLive);
  $('live-button-label').textContent = view.isLive ? 'Live position' : 'Return to live';
  $('export-button').classList.toggle('disabled', count === 0 || !viewerCapability);
  $('export-button').setAttribute('aria-disabled', String(count === 0 || !viewerCapability));
  $('export-button').tabIndex = count && viewerCapability ? 0 : -1;
}

function renderControls(view) {
  const running = state.status === 'running';
  const finished = state.status === 'finished';
  $('play-label').textContent = running ? 'Pause match' : finished ? 'Match complete' : state.status === 'error' ? 'Retry match' : state.status === 'paused' ? 'Resume match' : 'Start match';
  $('play-button').setAttribute('data-testid', running ? 'pause-match' : 'start-match');
  $('play-button').disabled = busy || finished || !viewerCapability;
  $('play-button').querySelector('svg').innerHTML = running ? '<path d="M8 5v14M16 5v14"/>' : '<path d="m8 5 11 7-11 7Z"/>';
  $('play-button').querySelector('svg').classList.toggle('play-icon', !running);
  $('step-button').disabled = busy || finished || running || Boolean(state.thinking) || !viewerCapability;
  $('reset-button').disabled = busy || !viewerCapability;
  let text = { idle: 'READY TO PLAY', running: 'MATCH IN PROGRESS', paused: 'MATCH PAUSED', error: 'MATCH INTERRUPTED', finished: 'MATCH COMPLETE' }[state.status] || 'READY TO PLAY';
  if (state.thinking && state.status !== 'running') text = 'ONE MOVE IN PROGRESS';
  if (!view.isLive) text = view.ply === 0 ? 'REVIEWING THE OPENING' : `REVIEWING HALF-MOVE ${view.ply}`;
  $('match-label-text').textContent = text;
  $('match-label').classList.toggle('running', view.isLive && running);
  $('match-label').classList.toggle('reviewing', !view.isLive);
  $('board-meta').textContent = view.isLive && state.inCheck ? `${state.turn === 'w' ? 'WHITE' : 'BLACK'} IS IN CHECK` : 'STANDARD CHESS · 8 × 8';
  $('board-hint').textContent = !view.isLive ? 'You’re reviewing a position. The live match continues independently.' : 'The models choose from legal moves. The board has the final say.';
  $('match-error').hidden = !state.error;
  $('match-error-text').textContent = state.error || '';
  $('match-result').hidden = !state.result;
  $('result-score').textContent = state.result?.score || '';
  $('result-reason').textContent = state.result?.reason || '';
}

function render() {
  if (!state) return;
  const view = currentView();
  renderBoard(view);
  const captured = capturedPieces(view);
  renderPlayer(flipped ? 'w' : 'b', $('top-player'), view, captured);
  renderPlayer(flipped ? 'b' : 'w', $('bottom-player'), view, captured);
  renderThought(view);
  renderMoves(view);
  renderMoveReview(view);
  renderControls(view);
  syncEvaluation(view);
  scheduleMoveReview();
  $('settings-white').textContent = modelName(state.players?.w?.model, 'w');
  $('settings-black').textContent = modelName(state.players?.b?.model, 'b');
}

function evaluationName(engine) {
  if (!engine || typeof engine.name !== 'string') return '';
  const name = engine.name.trim();
  const version = typeof engine.version === 'string' || typeof engine.version === 'number' ? String(engine.version).trim() : '';
  return version && !name.includes(version) ? `${name} ${version}` : name;
}

function principalVariation(data, fen) {
  const moves = Array.isArray(data.pvSan) && data.pvSan.length ? data.pvSan : data.pvUci;
  if (!Array.isArray(moves) || !moves.length) return '';
  const fields = fen.split(' ');
  const startsWhite = fields[1] === 'w';
  const firstNumber = Number(fields[5]) || 1;
  return moves.slice(0, 6).map((move, index) => {
    const white = (index + (startsWhite ? 0 : 1)) % 2 === 0;
    const number = firstNumber + Math.floor((index + (startsWhite ? 0 : 1)) / 2);
    const prefix = white ? `${number}. ` : index === 0 ? `${number}… ` : '';
    return `${prefix}${String(move)}`;
  }).join(' ');
}

function renderOpeningDatabase(view, data) {
  const details = $('opening-database');
  const summary = $('opening-summary');
  const content = $('opening-content');
  const opening = typeof view?.fen === 'string' && data?.fen === view.fen && data?.opening && typeof data.opening === 'object' && !Array.isArray(data.opening) ? data.opening : null;
  if (!opening) {
    details.hidden = false;
    content.dataset.openingKey = '';
    if (content.innerHTML) content.innerHTML = '';
    const label = data?.fen === view?.fen && ['error', 'unavailable'].includes(data?.status) ? 'Opening database · Unavailable' : 'Opening database · Loading…';
    if (summary.textContent !== label) summary.textContent = label;
    return;
  }
  const moves = Array.isArray(opening.moves) ? opening.moves.slice(0, 64).filter(move => move && typeof move.uci === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move.uci) && typeof move.san === 'string' && move.san.trim()).map(move => ({
    uci: move.uci,
    san: move.san.trim().slice(0, 32),
    eco: typeof move.eco === 'string' ? move.eco.trim().slice(0, 12) : '',
    name: typeof move.name === 'string' ? move.name.trim().slice(0, 200) : '',
  })) : [];
  const hasBookMoves = opening.inBook === true && moves.length > 0;
  const label = hasBookMoves ? `Opening database · ${moves.length} book ${moves.length === 1 ? 'move' : 'moves'}` : 'Opening database · Out of book';
  if (summary.textContent !== label) summary.textContent = label;
  details.hidden = false;
  const source = opening.source && typeof opening.source === 'object' ? opening.source : {};
  const sourceName = typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 100) : 'Local opening database';
  const sourceParts = [sourceName];
  if (Number.isInteger(source.openingCount) && source.openingCount >= 0 && source.openingCount <= 10000000) sourceParts.push(`${source.openingCount.toLocaleString('en-US')} named openings`);
  if (Number.isInteger(source.transitionCount) && source.transitionCount >= 0 && source.transitionCount <= 10000000) sourceParts.push(`${source.transitionCount.toLocaleString('en-US')} transitions`);
  if (typeof source.commit === 'string' && /^[a-f0-9]{7,64}$/i.test(source.commit)) sourceParts.push(`Snapshot ${source.commit.slice(0, 7)}`);
  const bestMove = data.status === 'ready' && typeof data.bestMove === 'string' ? data.bestMove : null;
  const renderKey = JSON.stringify([view.fen, hasBookMoves, moves, sourceParts, bestMove]);
  if (content.dataset.openingKey === renderKey) return;
  content.dataset.openingKey = renderKey;
  content.innerHTML = `${hasBookMoves ? `<ul class="opening-moves">${moves.map(move => `<li${move.name ? ` title="${escapeHtml(move.name)}"` : ''}><strong>${escapeHtml(move.san)}</strong>${move.eco ? `<span class="opening-eco">${escapeHtml(move.eco)}</span>` : ''}${move.name ? `<span class="opening-name">${escapeHtml(move.name)}</span>` : ''}${move.uci === bestMove ? '<span class="opening-engine-choice">Engine choice</span>' : ''}</li>`).join('')}</ul>` : '<p class="opening-empty">No matching book continuations for this position.</p>'}<p class="opening-source">${escapeHtml(sourceParts.join(' · '))}</p><p class="opening-method">Stockfish evaluates the position independently of this opening list.</p>`;
}

function renderEvaluation(view) {
  const data = evaluationData;
  renderOpeningDatabase(view, data);
  const status = data?.status || 'pending';
  const engineName = evaluationName(data?.engine);
  if (engineName) confirmedEngineName = engineName;
  $('engine-name').textContent = confirmedEngineName || 'Engine evaluation';
  $('engine-context').textContent = view.isLive ? 'Live position' : view.ply ? `Reviewed move ${view.ply}` : 'Starting position';
  $('engine-depth').textContent = status === 'ready' && Number.isFinite(data?.depth) ? `Depth ${data.depth}` : '';
  $('engine-spinner').hidden = status !== 'pending';
  $('retry-evaluation').hidden = !['error', 'unavailable'].includes(status);
  $('engine-evaluation').classList.toggle('is-unavailable', ['error', 'unavailable'].includes(status));
  $('evaluation-bar').classList.toggle('is-pending', status !== 'ready');
  $('evaluation-white').style.width = '50%';
  $('evaluation-bar').setAttribute('aria-label', 'Evaluation pending. White advantage is shown on the left; Black advantage on the right.');
  if (status === 'pending') {
    $('engine-score').textContent = 'Analyzing';
    $('engine-line').textContent = 'Analyzing the displayed position…';
    $('engine-line').title = '';
    return;
  }
  if (status === 'error' || status === 'unavailable') {
    $('engine-score').textContent = 'Unavailable';
    $('engine-line').textContent = data.error || 'The evaluator is unavailable. Retry to check again.';
    $('engine-line').title = $('engine-line').textContent;
    return;
  }
  let score = '—';
  let advantage = 'No score available';
  let whiteShare = 50;
  if (Number.isFinite(data.mateWhite)) {
    const winningColor = data.winningColor || (data.mateWhite > 0 ? 'w' : data.mateWhite < 0 ? 'b' : null);
    const winner = winningColor === 'w' ? 'White' : winningColor === 'b' ? 'Black' : '';
    score = `${winner ? `${winner} ` : ''}M${Math.abs(data.mateWhite)}`;
    advantage = winner ? `${winner} has a forced mate in ${Math.abs(data.mateWhite)}` : 'Checkmate';
    whiteShare = winningColor === 'w' ? 100 : winningColor === 'b' ? 0 : 50;
  } else if (Number.isFinite(data.cpWhite)) {
    const value = data.cpWhite / 100;
    score = `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}`;
    advantage = value > 0 ? 'White advantage' : value < 0 ? 'Black advantage' : 'Equal position';
    whiteShare = 50 + 46 * Math.tanh(value / 3);
  }
  $('engine-score').textContent = score;
  $('engine-score').title = `${advantage}. Scores are always from White's perspective.`;
  $('evaluation-white').style.width = `${whiteShare}%`;
  $('evaluation-bar').setAttribute('aria-label', `${advantage}; ${score}. White advantage is shown on the left; Black advantage on the right.`);
  const variation = principalVariation(data, view.fen);
  $('engine-line').textContent = variation ? `Best line · ${variation}` : data.bestMove ? `Best move · ${data.bestMove}` : 'No continuation available for this position.';
  $('engine-line').title = `${advantage}. ${$('engine-line').textContent}`;
}

async function fetchEvaluation(fen, sequence) {
  try {
    const data = await api(`/api/evaluation?fen=${encodeURIComponent(fen)}`, { signal: evaluationController.signal });
    if (sequence !== evaluationSequence || fen !== evaluationFen || data.fen && data.fen !== fen) return;
    evaluationData = data;
    if (rememberEvaluation(fen, data)) {
      if (syncMoveReviews()) renderReviewUpdates();
      scheduleMoveReview();
    } else if (data.status !== 'pending' && state) renderMoveReview(currentView());
    if (state) renderEvaluation(currentView());
    if (data.status === 'pending') evaluationPollTimer = setTimeout(() => fetchEvaluation(fen, sequence), 800);
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== evaluationSequence || fen !== evaluationFen) return;
    evaluationData = { fen, status: 'unavailable', error: error.message };
    if (state) { renderEvaluation(currentView()); renderMoveReview(currentView()); }
  }
}

function syncEvaluation(view) {
  if (!viewerCapability) return;
  if (view.fen === evaluationFen) { renderEvaluation(view); return; }
  clearTimeout(evaluationPollTimer);
  evaluationController?.abort();
  evaluationController = new AbortController();
  evaluationFen = view.fen;
  evaluationData = readyEvaluation(view.fen) || null;
  evaluationSequence += 1;
  renderEvaluation(view);
  if (evaluationData) scheduleMoveReview();
  else fetchEvaluation(view.fen, evaluationSequence);
}

function acceptState(next) {
  if (!viewerCapability) return;
  if (!next || !Array.isArray(next.moves) || !next.fen) return;
  if (state && next.id === state.id && next.revision !== undefined && state.revision !== undefined && next.revision < state.revision) return;
  if (currentGameId !== next.id || next.moves.length < (state?.moves.length || 0)) {
    resetMoveReview();
    clearTimeout(evaluationPollTimer);
    evaluationController?.abort();
    evaluationFen = null;
    evaluationData = null;
    evaluationSequence += 1;
    reviewPly = null;
    lastMoveCount = 0;
    currentGameId = next.id;
    explanationColor = null;
  }
  state = next;
  buildReviewContexts();
  syncMoveReviews();
  $('page-error').hidden = true;
  render();
}

async function authorizedFetch(path, options = {}) {
  if (!viewerCapability) throw new AccessError();
  const target = new URL(path, window.location.origin);
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) throw new Error('Only this arena’s API can receive viewer access.');
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${viewerCapability}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${target.pathname}${target.search}`, { ...options, headers, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (response.status === 401 || response.status === 403) { showAccessRequired(); throw new AccessError(); }
  return response;
}

async function api(path, options = {}) {
  const response = await authorizedFetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status}).`);
  return body;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}

async function act(action, body) {
  if (busy || !state) return;
  busy = true;
  renderControls(currentView());
  try {
    const next = await api(`/api/${action}`, { method: 'POST', body: JSON.stringify(body || {}) });
    acceptState(next);
    return next;
  } catch (error) {
    toast(error.message);
    throw error;
  } finally {
    busy = false;
    render();
  }
}

async function loadState() {
  try {
    acceptState(await api('/api/state'));
  } catch (error) {
    if (error instanceof AccessError) { showAccessRequired(); return; }
    $('page-error-text').textContent = `The arena could not be loaded. ${error.message}`;
    $('page-error').hidden = false;
    $('match-label-text').textContent = 'ARENA UNAVAILABLE';
    $('board-loading').innerHTML = '<span>Waiting for the local server</span>';
  }
}

function renderConnection() {
  $('connection-dot').className = `status-dot${connection.checking ? '' : connection.connected ? ' connected' : ' disconnected'}`;
  $('connection-label').textContent = connection.checking ? 'Connecting' : connection.connected ? 'API connected' : 'API offline';
  $('connection-button').title = connection.connected ? 'Connected to the local model API. Click to check again.' : `${connection.error || 'The local model API is unavailable.'} Click to retry.`;
  $('settings-endpoint').textContent = connection.baseUrl || 'http://127.0.0.1:8317/v1';
  $('connection-error').hidden = connection.checking || connection.connected;
  $('connection-error-text').textContent = `The model API is unavailable. ${connection.error || 'Check that the local API is running.'}`;
  $('retry-connection').disabled = connection.checking;
}

async function checkConnection(showToast = false) {
  if (!viewerCapability) { showAccessRequired(); return; }
  connection.checking = true;
  renderConnection();
  try {
    const next = await api('/api/models');
    if (!viewerCapability) { showAccessRequired(); return; }
    connection = { ...next, checking: false };
  } catch (error) {
    if (error instanceof AccessError) { showAccessRequired(); return; }
    connection = { ...connection, connected: false, checking: false, error: error.message };
  }
  renderConnection();
  if (showToast) toast(connection.connected ? 'Connected to the local model API.' : connection.error || 'The local model API is unavailable. Check that it is running, then retry.');
}

function stateEventReader(onState) {
  const maxEventSize = 8 * 1024 * 1024 + 64 * 1024;
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let eventSize = 0;
  return (chunk) => {
    if (buffer.length + chunk.length > maxEventSize) throw new Error('The arena update exceeded the viewer limit.');
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) {
        if (eventName === 'state' && dataLines.length) {
          let parsed;
          try { parsed = JSON.parse(dataLines.join('\n')); } catch { throw new Error('The arena sent an unreadable update.'); }
          onState(parsed);
        }
        eventName = '';
        dataLines = [];
        eventSize = 0;
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        eventSize += value.length + 1;
        if (eventSize > maxEventSize || dataLines.length >= 4096) throw new Error('The arena update exceeded the viewer limit.');
        dataLines.push(value);
      }
    }
    if (buffer.length > maxEventSize) throw new Error('The arena update exceeded the viewer limit.');
  };
}

async function connectEvents() {
  if (streamStopped || !viewerCapability) return;
  clearTimeout(streamReconnectTimer);
  stream?.abort();
  stream = new AbortController();
  const controller = stream;
  const generation = ++streamGeneration;
  let reader;
  try {
    const response = await authorizedFetch('/api/events', { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('The arena stream is unavailable.');
    if (generation !== streamGeneration) return;
    if (state) renderControls(currentView());
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const consume = stateEventReader((next) => { if (generation === streamGeneration) { acceptState(next); streamRetryMs = 1000; } });
    while (!controller.signal.aborted && generation === streamGeneration) {
      const { done, value } = await reader.read();
      if (done) { consume(decoder.decode()); break; }
      consume(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (error instanceof AccessError) { showAccessRequired(); return; }
    if (error.name === 'AbortError') return;
  } finally {
    if (reader) { try { await reader.cancel(); } catch { /* The network may already be closed. */ } reader.releaseLock(); }
  }
  if (!streamStopped && viewerCapability && generation === streamGeneration && !controller.signal.aborted) {
    $('board-hint').textContent = 'Reconnecting to the arena. Your last position is still here.';
    streamReconnectTimer = setTimeout(connectEvents, streamRetryMs);
    streamRetryMs = Math.min(streamRetryMs * 2, 10000);
  }
}

function review(ply) {
  if (!state || !state.moves.length) return;
  reviewPly = ply === null ? null : Math.max(0, Math.min(ply, state.moves.length));
  render();
  const selected = $('moves-list').querySelector('.move-cell.selected');
  if (selected && reviewPly !== null) selected.scrollIntoView({ behavior: 'auto', block: 'nearest' });
}

function openSettings() {
  $('delay-input').value = state?.settings?.delayMs ?? 1200;
  $('plies-input').value = state?.settings?.maxPlies ?? 200;
  $('settings-error').hidden = true;
  $('settings-dialog').showModal();
}

$('play-button').addEventListener('click', () => {
  if (!state || busy) return;
  act(state.status === 'running' ? 'pause' : 'start').catch(() => {});
});
$('step-button').addEventListener('click', () => act('step').catch(() => {}));
$('reset-button').addEventListener('click', () => act('reset').then((next) => { if (next) toast('A fresh board. White moves first.'); }).catch(() => {}));
$('flip-button').addEventListener('click', () => { flipped = !flipped; render(); $('flip-button').setAttribute('aria-pressed', String(flipped)); });
$('retry-evaluation').addEventListener('click', () => { evaluationFen = null; if (state) syncEvaluation(currentView()); });
$('retry-move-review').addEventListener('click', retryMoveReview);
$('first-button').addEventListener('click', () => review(0));
$('previous-button').addEventListener('click', () => review(currentView().ply - 1));
$('next-button').addEventListener('click', () => review(currentView().ply + 1));
$('live-button').addEventListener('click', () => review(null));
$('moves-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-ply]');
  if (button) review(Number(button.dataset.ply));
});
$('explain-white').addEventListener('click', () => { explanationColor = 'w'; if (state) renderExplanation(currentView()); });
$('explain-black').addEventListener('click', () => { explanationColor = 'b'; if (state) renderExplanation(currentView()); });
for (const id of ['explain-white', 'explain-black']) {
  $(id).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !state || reviewPly !== null) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.key === 'ArrowLeft' || event.key === 'Home' ? $('explain-white') : $('explain-black');
    target.click();
    target.focus();
  });
}
$('export-button').removeAttribute('href');
$('export-button').setAttribute('role', 'button');
$('export-button').addEventListener('click', async (event) => {
  event.preventDefault();
  if (!state?.moves.length || !viewerCapability) return;
  let downloadUrl;
  try {
    const response = await authorizedFetch('/api/pgn', { headers: { Accept: 'application/x-chess-pgn' } });
    if (!response.ok) throw new Error(`PGN download failed (${response.status}).`);
    downloadUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = 'spectator.pgn';
    link.click();
  } catch (error) {
    if (error instanceof AccessError) showAccessRequired();
    else toast(error.message);
  } finally { if (downloadUrl) setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000); }
});
$('export-button').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.code === 'Space') { event.preventDefault(); event.stopPropagation(); $('export-button').click(); }
});
$('connection-button').addEventListener('click', () => checkConnection(true));
$('retry-connection').addEventListener('click', () => checkConnection(true));
$('retry-state').addEventListener('click', () => { loadState(); checkConnection(); });
$('settings-button').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('cancel-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('click', (event) => {
  if (event.target === $('settings-dialog')) {
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('settings-dialog').close();
  }
});
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = { delayMs: Number($('delay-input').value), maxPlies: Number($('plies-input').value) };
  $('settings-error').hidden = true;
  $('save-settings').disabled = true;
  try {
    const next = await act('settings', body);
    if (next) { $('settings-dialog').close(); toast('Match settings saved.'); }
  } catch (error) {
    $('settings-error').textContent = error.message;
    $('settings-error').hidden = false;
  } finally { $('save-settings').disabled = false; }
});
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, select, [contenteditable="true"], dialog') || $('settings-dialog').open || !state) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); review(currentView().ply - 1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); if (reviewPly !== null) review(currentView().ply + 1); }
  if (event.code === 'Space' && !event.target.closest('button, a')) { event.preventDefault(); if (!$('play-button').disabled) $('play-button').click(); }
});

setInterval(updateClocks, 500);
window.addEventListener('beforeunload', () => { streamStopped = true; stream?.abort(); clearTimeout(streamReconnectTimer); clearTimeout(evaluationPollTimer); evaluationController?.abort(); resetMoveReview(); });
function bootstrapViewer() {
  resetMoveReview();
  clearTimeout(evaluationPollTimer);
  evaluationController?.abort();
  evaluationSequence += 1;
  evaluationData = null;
  if (state) renderReviewUpdates();
  if (!viewerCapability) { showAccessRequired(); return; }
  streamStopped = false;
  streamRetryMs = 1000;
  evaluationFen = null;
  $('retry-state').hidden = false;
  $('connection-button').disabled = false;
  $('retry-connection').disabled = false;
  loadState();
  checkConnection();
  connectEvents();
}
window.addEventListener('hashchange', () => {
  if (!new URLSearchParams(window.location.hash.slice(1)).has('access_token')) return;
  viewerCapability = readViewerCapability();
  bootstrapViewer();
});
bootstrapViewer();
renderRatingLegend();
