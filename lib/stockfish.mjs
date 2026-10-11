import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Chess } from 'chess.js';

function fenError(message) {
  return Object.assign(new Error(`Invalid FEN: ${message}`), { status: 400 });
}

function validateCounters(fields) {
  if (fields.length !== 6) throw fenError('exactly six fields are required.');
  for (const [index, minimum, maximum] of [[4, 0, 32767], [5, 1, 50000]]) {
    const value = Number(fields[index]);
    if (!/^\d+$/.test(fields[index]) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw fenError('move counters must be whole decimal integers within the engine limits.');
    }
  }
}

export function validateEvaluationFen(input) {
  if (typeof input !== 'string' || input.length > 200 || /[\r\n\u0000]/.test(input)) {
    throw Object.assign(new Error('A valid chess FEN is required.'), { status: 400 });
  }
  const fields = input.trim().split(/\s+/);
  validateCounters(fields);
  let chess;
  try { chess = new Chess(input.trim()); }
  catch (error) { throw Object.assign(new Error(`Invalid FEN: ${error.message}`), { status: 400 }); }
  // Validate the supplied rights before chess.js can normalize their representation.
  for (const [right, color, kingSquare, rookSquare] of [
    ['K', 'w', 'e1', 'h1'], ['Q', 'w', 'e1', 'a1'],
    ['k', 'b', 'e8', 'h8'], ['q', 'b', 'e8', 'a8'],
  ]) {
    if (!fields[2].includes(right)) continue;
    const king = chess.get(kingSquare);
    const rook = chess.get(rookSquare);
    if (king?.type !== 'k' || king.color !== color || rook?.type !== 'r' || rook.color !== color) {
      throw fenError('castling rights require the king and rook on their home squares.');
    }
  }
  // Stockfish 19 rejects impossible piece budgets and an attacked non-moving king.
  const pieces = chess.board().flat().filter(Boolean);
  const opponent = chess.turn() === 'w' ? 'b' : 'w';
  const otherKing = pieces.find(piece => piece.type === 'k' && piece.color === opponent);
  if (pieces.length > 32 || chess.isAttacked(otherKing.square, chess.turn())) {
    throw Object.assign(new Error('Invalid FEN: the position cannot arise from legal chess moves.'), { status: 400 });
  }
  for (const color of ['w', 'b']) {
    const counts = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
    for (const piece of pieces) if (piece.color === color) counts[piece.type] += 1;
    const promotions = Math.max(0, counts.q - 1) + Math.max(0, counts.r - 2) + Math.max(0, counts.b - 2) + Math.max(0, counts.n - 2);
    if (counts.p > 8 || promotions > 8 - counts.p) {
      throw Object.assign(new Error('Invalid FEN: the position exceeds the legal piece or promotion budget.'), { status: 400 });
    }
  }
  const canonicalFen = chess.fen();
  validateCounters(canonicalFen.split(' '));
  return canonicalFen;
}

// Fullmove numbers label a game; the halfmove clock still affects draw evaluation.
function evaluationKey(fen) {
  return `${fen.split(' ').slice(0, 5).join(' ')} 1`;
}

function forPosition(state, fen) {
  return { ...structuredClone(state), fen };
}

function emptyEvaluation(fen, engine, status = 'pending', error = null) {
  return {
    fen, status, engine: { ...engine }, cpWhite: null, mateWhite: null, winningColor: null,
    depth: 0, pvUci: [], pvSan: [], bestMove: null, wdlWhite: null, nodes: 0, nps: 0, error,
  };
}

export function unavailableEvaluation(fen, error = 'Stockfish is not configured.') {
  return emptyEvaluation(validateEvaluationFen(fen), { name: 'Stockfish', version: null }, 'unavailable', error);
}

function replayPv(fen, candidates) {
  const chess = new Chess(fen);
  const pvUci = [];
  const pvSan = [];
  for (const candidate of candidates.slice(0, 64)) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(candidate)) break;
    try {
      const move = chess.move({ from: candidate.slice(0, 2), to: candidate.slice(2, 4), ...(candidate[4] ? { promotion: candidate[4] } : {}) });
      pvUci.push(candidate);
      pvSan.push(move.san);
    } catch { break; }
  }
  return { pvUci, pvSan };
}

export class StockfishEvaluator extends EventEmitter {
  constructor({ enginePath, engineArgs = [], spawnImpl = spawn, movetimeMs = 1500, maxDepth = 22, maxCache = 128, maxQueue = 32, maxRecoveries = 2, startupTimeoutMs = 5000, stopTimeoutMs = 3000 } = {}) {
    super();
    this.enginePath = enginePath;
    this.engineArgs = engineArgs;
    this.spawn = spawnImpl;
    this.movetimeMs = movetimeMs;
    this.maxDepth = maxDepth;
    this.maxCache = Math.max(1, Math.min(128, maxCache));
    this.maxQueue = Math.max(1, Math.min(128, maxQueue));
    this.maxRecoveries = Number.isInteger(maxRecoveries) ? Math.max(0, Math.min(2, maxRecoveries)) : 2;
    this._recoveryCount = 0;
    this._recovering = false;
    this.startupTimeoutMs = startupTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.engine = { name: 'Stockfish', version: null };
    this.options = new Set();
    this.cache = new Map();
    this._waiters = new Set();
    this._active = null;
    this._queue = new Map();
    this._draining = false;
    this._initialized = false;
    this._unavailable = null;
    this._closed = false;
    this.ready = this._initialize();
  }

  async _initialize() {
    try {
      if (!this.enginePath) throw new Error('Stockfish executable is not configured.');
      const child = this.child = this.spawn(this.enginePath, this.engineArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.once('error', error => { if (this.child === child) this._fail(`Stockfish could not start: ${error.message}`); });
      // 'close' follows drained stdout; the final position-rejection line must be handled first.
      child.once('close', (code, signal) => {
        if (!this._closed && this.child === child) this._fail(`Stockfish exited unexpectedly (${signal || code}).`);
      });
      child.stdin.on('error', error => { if (!this._closed && this.child === child) this._fail(`Stockfish input failed: ${error.message}`); });
      this._reader = createInterface({ input: child.stdout });
      this._reader.on('line', line => { if (this.child === child) this._line(line.trim()); });
      child.stderr.on('data', () => { /* UCI diagnostics must not contaminate public evaluation output. */ });
      const uci = this._waitFor('uciok', this.startupTimeoutMs);
      this._send('uci');
      await uci;
      if (!/^Stockfish\b/i.test(this.engine.name) || !this.engine.version) throw new Error('The executable did not identify itself as a versioned Stockfish UCI engine.');
      for (const [name, value] of [['Threads', '2'], ['Hash', '128'], ['MultiPV', '1'], ['UCI_ShowWDL', 'true']]) {
        if (this.options.has(name)) this._send(`setoption name ${name} value ${value}`);
      }
      const ready = this._waitFor('readyok', this.startupTimeoutMs);
      this._send('ucinewgame');
      this._send('isready');
      await ready;
      if (this._closed || this._unavailable) return false;
      this._initialized = true;
      this._startQueued();
      return true;
    } catch (error) {
      if (!this._closed) this._fail(error.message);
      return false;
    }
  }

  _waitFor(expected, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { expected, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { this._waiters.delete(waiter); reject(new Error(`Stockfish did not acknowledge ${expected}.`)); }, timeoutMs);
      this._waiters.add(waiter);
    });
  }

  _send(command) {
    if (this._closed || !this.child?.stdin || this.child.stdin.destroyed) return;
    this.emit('command', command);
    this.child.stdin.write(`${command}\n`);
  }

  _line(line) {
    if (line.includes('CRITICAL ERROR')) {
      if (this._active && /^info string CRITICAL ERROR: Command `position fen /.test(line)) this._recoverPosition();
      else this._fail('Stockfish rejected an engine command.');
      return;
    }
    if (line.startsWith('id name ')) {
      this.engine.name = line.slice(8).slice(0, 120);
      this.engine.version = /\bStockfish\s+(\d+(?:\.\d+)?)/i.exec(this.engine.name)?.[1] ?? null;
    }
    const option = /^option name (.+?) type /.exec(line);
    if (option) this.options.add(option[1]);
    for (const waiter of [...this._waiters]) {
      if (line !== waiter.expected) continue;
      clearTimeout(waiter.timer);
      this._waiters.delete(waiter);
      waiter.resolve();
    }
    if (!this._active) return;
    if (line.startsWith('info ')) this._info(line);
    else if (line.startsWith('bestmove ')) this._bestMove(line.split(/\s+/)[1]);
  }

  evaluate(input) {
    const fen = validateEvaluationFen(input);
    const key = evaluationKey(fen);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return forPosition(cached, fen);
    }
    if (this._closed || this._unavailable) return emptyEvaluation(fen, this.engine, 'unavailable', this._unavailable || 'Stockfish evaluator has shut down.');
    if (this._active?.key === key) return forPosition(this._active.state, fen);
    if (this._queue.has(key)) return forPosition(this._queue.get(key).state, fen);
    if (this._queue.size >= this.maxQueue) return emptyEvaluation(fen, this.engine, 'error', 'The evaluation queue is full. Retry shortly.');
    const job = { key, fen, state: emptyEvaluation(fen, this.engine), cancelled: false };
    this._queue.set(key, job);
    this._startQueued();
    return forPosition(this.cache.get(key) ?? job.state, fen);
  }

  _startQueued() {
    if (!this._initialized || this._recovering || this._closed || this._unavailable || this._active || this._draining || !this._queue.size) return;
    const [key, job] = this._queue.entries().next().value;
    this._queue.delete(key);
    try {
      job.state.engine = { ...this.engine };
      // Recheck the exact representation consumed at the native-process boundary.
      job.fen = validateEvaluationFen(job.fen);
      const chess = new Chess(job.fen);
      const checkmate = chess.isCheckmate();
      if (checkmate || chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDrawByFiftyMoves()) {
        job.state.status = 'ready';
        if (checkmate) {
          job.state.mateWhite = 0;
          job.state.winningColor = chess.turn() === 'w' ? 'b' : 'w';
          job.state.wdlWhite = job.state.winningColor === 'w' ? { win: 1000, draw: 0, loss: 0 } : { win: 0, draw: 0, loss: 1000 };
        } else {
          job.state.cpWhite = 0;
          job.state.wdlWhite = { win: 0, draw: 1000, loss: 0 };
        }
        this._cache(job.state);
        queueMicrotask(() => this._startQueued());
        return;
      }
      this._active = job;
      job.timer = setTimeout(() => this._fail('Stockfish search exceeded its time limit.'), this.movetimeMs + this.stopTimeoutMs + 1000);
      this._send(`position fen ${job.fen}`);
      this._send(`go depth ${this.maxDepth} movetime ${this.movetimeMs}`);
    } catch {
      clearTimeout(job.timer);
      const dispatched = this._active === job;
      if (dispatched) this._active = null;
      job.state.status = 'error';
      job.state.error = 'Stockfish could not analyze this position.';
      this._cache(job.state);
      if (dispatched) { this._fail('Stockfish could not dispatch an analysis command.'); return; }
      queueMicrotask(() => this._startQueued());
    }
  }

  _info(line) {
    const job = this._active;
    if (job.cancelled || /\bmultipv ([2-9]|\d{2,})\b/.test(line) || line.startsWith('info string')) return;
    const state = job.state;
    for (const key of ['nodes', 'nps']) {
      const value = new RegExp(`\\b${key} (\\d+)\\b`).exec(line);
      if (value) state[key] = Number(value[1]);
    }
    const score = /\bscore (cp|mate) (-?\d+)\b/.exec(line);
    if (!score || /\b(?:lowerbound|upperbound)\b/.test(line)) return;
    const sign = new Chess(job.fen).turn() === 'w' ? 1 : -1;
    const value = Number(score[2]) * sign;
    state.cpWhite = score[1] === 'cp' ? value : null;
    state.mateWhite = score[1] === 'mate' ? value : null;
    state.winningColor = score[1] === 'mate' && value !== 0 ? (value > 0 ? 'w' : 'b') : null;
    const depth = /\bdepth (\d+)\b/.exec(line);
    if (depth) state.depth = Number(depth[1]);
    const wdl = /\bwdl (\d+) (\d+) (\d+)\b/.exec(line);
    if (wdl) {
      const values = wdl.slice(1).map(Number);
      if (values.every(value => value <= 1000) && values.reduce((a, b) => a + b, 0) === 1000) {
        state.wdlWhite = sign === 1 ? { win: values[0], draw: values[1], loss: values[2] } : { win: values[2], draw: values[1], loss: values[0] };
      }
    }
    const pv = /\bpv (.+)$/.exec(line);
    if (pv) {
      Object.assign(state, replayPv(job.fen, pv[1].split(/\s+/)));
      state.bestMove = state.pvUci[0] ?? null;
    }
    this.emit('evaluation', structuredClone(state));
  }

  _bestMove(bestMove) {
    const job = this._active;
    clearTimeout(job.timer);
    if (!job.cancelled) {
      const legal = replayPv(job.fen, [bestMove]);
      if (legal.pvUci.length !== 1 || (job.state.cpWhite === null && job.state.mateWhite === null)) {
        job.state.status = 'error';
        job.state.error = legal.pvUci.length !== 1 ? 'Stockfish returned an illegal best move.' : 'Stockfish returned no evaluation score.';
      } else {
        job.state.status = 'ready';
        job.state.bestMove = bestMove;
        if (job.state.pvUci[0] !== bestMove) Object.assign(job.state, legal);
      }
      this._cache(job.state);
    }
    this._active = null;
    this._draining = true;
    const ready = this._waitFor('readyok', this.stopTimeoutMs);
    this._send('isready');
    ready.then(() => { this._draining = false; this._startQueued(); }).catch(error => { if (!this._closed) this._fail(error.message); });
  }

  _cache(state) {
    this.cache.set(evaluationKey(state.fen), structuredClone(state));
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
    this.emit('evaluation', structuredClone(state));
  }

  _recoverPosition() {
    const job = this._active;
    clearTimeout(job.timer);
    this._active = null;
    this._initialized = false;
    this._recovering = true;
    this._draining = false;
    job.state.status = 'error';
    job.state.error = 'Stockfish rejected this position.';
    this._cache(job.state);
    if (this._recoveryCount >= this.maxRecoveries) {
      this._fail('Stockfish recovery limit reached after repeated position rejections.');
      return;
    }
    this._recoveryCount += 1;
    const child = this.child;
    const reader = this._reader;
    // Retire callbacks before terminating: old output and exit events cannot affect a replacement.
    this.child = null;
    this._reader = null;
    this._recoveryPromise = this._stopProcess(child, reader, false).then(async () => {
      if (this._closed) return false;
      this._recovering = false;
      this.ready = this._initialize();
      return this.ready;
    }).catch(() => {
      if (!this._closed) this._fail('Stockfish could not recover from a rejected position.');
      return false;
    });
    this.ready = this._recoveryPromise;
  }

  _fail(message) {
    if (this._unavailable) return;
    this._unavailable = String(message).slice(0, 400);
    this._initialized = false;
    if (this._active) clearTimeout(this._active.timer);
    for (const waiter of this._waiters) { clearTimeout(waiter.timer); waiter.reject(new Error(this._unavailable)); }
    this._waiters.clear();
    for (const job of [this._active, ...this._queue.values()]) {
      if (!job) continue;
      job.state.status = 'unavailable';
      job.state.error = this._unavailable;
      this.emit('evaluation', structuredClone(job.state));
    }
    this._active = null;
    this._queue.clear();
    this.child?.kill();
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = this._closeProcess();
    return this._closePromise;
  }

  async _closeProcess() {
    this._closed = true;
    if (this._active) clearTimeout(this._active.timer);
    for (const waiter of this._waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Stockfish evaluator has shut down.')); }
    this._waiters.clear();
    this._active = null;
    this._queue.clear();
    await this._stopProcess(this.child, this._reader);
    await this._recoveryPromise;
  }

  async _stopProcess(child, reader, graceful = true) {
    if (!child?.pid || child.exitCode !== null) { reader?.close(); return; }
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve(); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 1500);
      child.once('exit', finish);
      if (graceful && !child.stdin.destroyed) child.stdin.write('stop\nquit\n');
      else child.kill();
    });
    reader?.close();
  }
}
