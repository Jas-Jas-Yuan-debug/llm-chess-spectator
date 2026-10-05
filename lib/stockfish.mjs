import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Chess } from 'chess.js';

export function validateEvaluationFen(input) {
  if (typeof input !== 'string' || input.length > 200 || /[\r\n\u0000]/.test(input)) {
    throw Object.assign(new Error('A valid chess FEN is required.'), { status: 400 });
  }
  let chess;
  try { chess = new Chess(input.trim()); }
  catch (error) { throw Object.assign(new Error(`Invalid FEN: ${error.message}`), { status: 400 }); }
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
  const fields = input.trim().split(/\s+/);
  if (Number(fields[4]) > 32767 || Number(fields[5]) > 50000) {
    throw Object.assign(new Error('Invalid FEN: move counters exceed the engine limits.'), { status: 400 });
  }
  return chess.fen();
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
  constructor({ enginePath, engineArgs = [], spawnImpl = spawn, movetimeMs = 1500, maxDepth = 22, maxCache = 128, maxQueue = 32, startupTimeoutMs = 5000, stopTimeoutMs = 3000 } = {}) {
    super();
    this.enginePath = enginePath;
    this.engineArgs = engineArgs;
    this.spawn = spawnImpl;
    this.movetimeMs = movetimeMs;
    this.maxDepth = maxDepth;
    this.maxCache = Math.max(1, Math.min(128, maxCache));
    this.maxQueue = Math.max(1, Math.min(128, maxQueue));
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
      this.child = this.spawn(this.enginePath, this.engineArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child.once('error', error => this._fail(`Stockfish could not start: ${error.message}`));
      this.child.once('exit', (code, signal) => {
        if (!this._closed) this._fail(`Stockfish exited unexpectedly (${signal || code}).`);
      });
      this.child.stdin.on('error', error => { if (!this._closed) this._fail(`Stockfish input failed: ${error.message}`); });
      this._reader = createInterface({ input: this.child.stdout });
      this._reader.on('line', line => this._line(line.trim()));
      this.child.stderr.on('data', () => { /* UCI diagnostics must not contaminate public evaluation output. */ });
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
    if (line.includes('CRITICAL ERROR')) { this._fail('Stockfish rejected the requested position.'); return; }
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
    const cached = this.cache.get(fen);
    if (cached) {
      this.cache.delete(fen);
      this.cache.set(fen, cached);
      return structuredClone(cached);
    }
    if (this._closed || this._unavailable) return emptyEvaluation(fen, this.engine, 'unavailable', this._unavailable || 'Stockfish evaluator has shut down.');
    if (this._active?.fen === fen) return structuredClone(this._active.state);
    if (this._queue.has(fen)) return structuredClone(this._queue.get(fen).state);
    if (this._queue.size >= this.maxQueue) return emptyEvaluation(fen, this.engine, 'error', 'The evaluation queue is full. Retry shortly.');
    const job = { fen, state: emptyEvaluation(fen, this.engine), cancelled: false };
    this._queue.set(fen, job);
    this._startQueued();
    return structuredClone(this.cache.get(fen) ?? job.state);
  }

  _startQueued() {
    if (!this._initialized || this._closed || this._unavailable || this._active || this._draining || !this._queue.size) return;
    const [fen, job] = this._queue.entries().next().value;
    this._queue.delete(fen);
    job.state.engine = { ...this.engine };
    const chess = new Chess(job.fen);
    if (chess.isCheckmate() || chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDrawByFiftyMoves()) {
      job.state.status = 'ready';
      if (chess.isCheckmate()) {
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
    this.cache.set(state.fen, structuredClone(state));
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
    this.emit('evaluation', structuredClone(state));
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
    if (!this.child?.pid || this.child.exitCode !== null) { this._reader?.close(); return; }
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.write('stop\nquit\n');
    });
    this._reader?.close();
  }
}
