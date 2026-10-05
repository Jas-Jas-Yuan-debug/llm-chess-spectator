const $ = (id) => document.getElementById(id);
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FILES = 'abcdefgh';
let state = null;
let flipped = false;
let reviewPly = null;
let busy = false;
let stream = null;
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
  const fen = reviewPly === null ? state.fen : move?.fen || START_FEN;
  return { ply, move, fen, board: reviewPly === null && state.board ? state.board : parseFen(fen), turn: fen.split(' ')[1], isLive: reviewPly === null };
}

function renderBoard(view) {
  const lastSquares = view.move?.uci ? [view.move.uci.slice(0, 2), view.move.uci.slice(2, 4)] : [];
  let html = '';
  for (let displayedRow = 0; displayedRow < 8; displayedRow++) {
    for (let displayedCol = 0; displayedCol < 8; displayedCol++) {
      const row = flipped ? 7 - displayedRow : displayedRow;
      const col = flipped ? 7 - displayedCol : displayedCol;
      const squareName = `${FILES[col]}${8 - row}`;
      const piece = view.board[row][col];
      const checked = view.isLive && state.inCheck && piece?.type === 'k' && piece.color === state.turn;
      const description = `${squareName}${piece ? `, ${piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece.type]}` : ', empty'}`;
      html += `<div class="square${(row + col) % 2 ? ' dark' : ''}${lastSquares.includes(squareName) ? ' last-move' : ''}${checked ? ' check' : ''}" data-square="${squareName}" aria-label="${description}">${displayedCol === 0 ? `<span class="coordinate rank-coordinate" aria-hidden="true">${8 - row}</span>` : ''}${displayedRow === 7 ? `<span class="coordinate file-coordinate" aria-hidden="true">${FILES[col]}</span>` : ''}${piece ? pieceSvg(piece.type, piece.color) : ''}</div>`;
    }
  }
  $('board').innerHTML = html;
  $('board').setAttribute('aria-label', `Chessboard, ${view.isLive ? 'live position' : `after half-move ${view.ply}`}, ${view.turn === 'w' ? 'white' : 'black'} to move${state.inCheck && view.isLive ? ', in check' : ''}. ${view.fen}`);
  $('board-loading').hidden = true;
}

function capturedPieces(view) {
  const captured = { w: [], b: [] };
  for (const move of state.moves.slice(0, view.ply)) {
    if (move.captured) captured[move.color].push(move.captured);
  }
  // Missing captured metadata can be recovered from the boards, including en passant.
  if (!state.moves.some((move) => move.captured) && view.ply > 0) {
    let previous = parseFen(START_FEN);
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
  if (count) {
    let html = '';
    for (let i = 0; i < count; i += 2) {
      html += `<div class="move-row"><span class="move-number">${Math.floor(i / 2) + 1}.</span>`;
      for (let j = i; j < i + 2; j++) {
        const move = state.moves[j];
        html += move ? `<button class="move-cell${view.ply === j + 1 ? ' selected' : ''}" data-ply="${j + 1}" aria-label="Review ${move.color === 'w' ? 'white' : 'black'} move ${Math.floor(j / 2) + 1}, ${escapeHtml(move.san)}" aria-pressed="${view.ply === j + 1}" title="${escapeHtml(move.comment || 'View this position')}"><span>${escapeHtml(move.san)}</span><span class="move-time">${seconds(move.elapsedMs)}</span>${move.comment ? '<span class="move-comment-icon" aria-hidden="true"></span>' : ''}</button>` : '<span></span>';
      }
      html += '</div>';
    }
    container.innerHTML = html;
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
  $('export-button').classList.toggle('disabled', count === 0);
  $('export-button').setAttribute('aria-disabled', String(count === 0));
  $('export-button').tabIndex = count ? 0 : -1;
}

function renderControls(view) {
  const running = state.status === 'running';
  const finished = state.status === 'finished';
  $('play-label').textContent = running ? 'Pause match' : finished ? 'Match complete' : state.status === 'error' ? 'Retry match' : state.status === 'paused' ? 'Resume match' : 'Start match';
  $('play-button').setAttribute('data-testid', running ? 'pause-match' : 'start-match');
  $('play-button').disabled = busy || finished;
  $('play-button').querySelector('svg').innerHTML = running ? '<path d="M8 5v14M16 5v14"/>' : '<path d="m8 5 11 7-11 7Z"/>';
  $('play-button').querySelector('svg').classList.toggle('play-icon', !running);
  $('step-button').disabled = busy || finished || running || Boolean(state.thinking);
  $('reset-button').disabled = busy;
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
  renderControls(view);
  syncEvaluation(view);
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

function renderEvaluation(view) {
  const data = evaluationData;
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
    if (state) renderEvaluation(currentView());
    if (data.status === 'pending') evaluationPollTimer = setTimeout(() => fetchEvaluation(fen, sequence), 800);
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== evaluationSequence || fen !== evaluationFen) return;
    evaluationData = { fen, status: 'unavailable', error: error.message };
    if (state) renderEvaluation(currentView());
  }
}

function syncEvaluation(view) {
  if (view.fen === evaluationFen) { renderEvaluation(view); return; }
  clearTimeout(evaluationPollTimer);
  evaluationController?.abort();
  evaluationController = new AbortController();
  evaluationFen = view.fen;
  evaluationData = null;
  evaluationSequence += 1;
  renderEvaluation(view);
  fetchEvaluation(view.fen, evaluationSequence);
}

function acceptState(next) {
  if (!next || !Array.isArray(next.moves) || !next.fen) return;
  if (state && next.id === state.id && next.revision !== undefined && state.revision !== undefined && next.revision < state.revision) return;
  if (currentGameId !== next.id || next.moves.length < (state?.moves.length || 0)) {
    reviewPly = null;
    lastMoveCount = 0;
    currentGameId = next.id;
    explanationColor = null;
  }
  state = next;
  $('page-error').hidden = true;
  render();
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
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
  connection.checking = true;
  renderConnection();
  try {
    connection = { ...(await api('/api/models')), checking: false };
  } catch (error) {
    connection = { ...connection, connected: false, checking: false, error: error.message };
  }
  renderConnection();
  if (showToast) toast(connection.connected ? 'Connected to the local model API.' : connection.error || 'The local model API is unavailable. Check that it is running, then retry.');
}

function connectEvents() {
  if (stream) stream.close();
  stream = new EventSource('/api/events');
  stream.addEventListener('state', (event) => {
    try { acceptState(JSON.parse(event.data)); } catch (error) { console.warn('Could not read match update:', error.message); }
  });
  stream.addEventListener('error', () => {
    $('board-hint').textContent = 'Reconnecting to the arena. Your last position is still here.';
  });
  stream.addEventListener('open', () => {
    if (state) renderControls(currentView());
  });
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
$('export-button').addEventListener('click', (event) => { if (!state?.moves.length) event.preventDefault(); });
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
window.addEventListener('beforeunload', () => { stream?.close(); clearTimeout(evaluationPollTimer); evaluationController?.abort(); });
loadState();
checkConnection();
connectEvents();
