import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { Chess } from 'chess.js';
import { withAbort } from './llm.mjs';

export function toUci(move) {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export class InvalidMoveError extends Error {}

function summaryText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeExplanation(input, legal, chosenMove) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const explanation = {
    idea: summaryText(input.idea, 400),
    threats: summaryText(input.threats, 400),
    alternatives: [],
    plan: summaryText(input.plan, 400),
  };
  const alternatives = Array.isArray(input.alternatives) ? input.alternatives : [];
  const available = new Set(legal.map(toUci));
  const seen = new Set([toUci(chosenMove)]);
  for (const alternative of alternatives) {
    if (!alternative || typeof alternative !== 'object' || typeof alternative.move !== 'string') continue;
    const move = alternative.move.trim().toLowerCase();
    const whyNot = summaryText(alternative.whyNot, 300);
    if (!available.has(move) || seen.has(move) || !whyNot) continue;
    explanation.alternatives.push({ move, whyNot });
    seen.add(move);
    if (explanation.alternatives.length === 2) break;
  }
  return explanation.idea || explanation.threats || explanation.plan || explanation.alternatives.length ? explanation : null;
}

export function parseMoveResponse(response, chess) {
  let payload = response;
  if (typeof response === 'string' || typeof response?.text === 'string') {
    const text = (typeof response === 'string' ? response : response.text).trim();
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try { payload = JSON.parse(clean); }
    catch {
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try { payload = JSON.parse(clean.slice(start, end + 1)); }
        catch { throw new InvalidMoveError('The response was not valid move JSON.'); }
      } else { payload = { move: clean }; }
    }
  }
  const value = payload?.move ?? payload?.uci ?? payload?.san;
  if (typeof value !== 'string' || value.length > 40) throw new InvalidMoveError('The response must include a move string.');
  const candidate = value.trim().replace(/[!?]+$/, '');
  const legal = chess.moves({ verbose: true });
  const coordinate = candidate.toLowerCase().replace(/[\s\-]/g, '');
  let move = legal.find(item => toUci(item) === coordinate);
  if (!move) {
    const normalSan = san => san.replace(/0/g, 'O').replace(/[+#]$/, '');
    move = legal.find(item => normalSan(item.san) === normalSan(candidate));
  }
  if (!move) throw new InvalidMoveError(`Illegal or incomplete move "${candidate}" for the current position.`);
  const comment = typeof payload.comment === 'string' ? payload.comment.trim().slice(0, 1000) : '';
  return { move, comment, explanation: normalizeExplanation(payload.explanation, legal, move), usage: response?.usage ?? payload?.usage ?? null };
}

export function validateSettings(input, current = { delayMs: 1200, maxPlies: 200 }) {
  const settings = { ...current };
  for (const [key, min, max] of [['delayMs', 0, 60_000], ['maxPlies', 1, 1000]]) {
    if (input?.[key] === undefined) continue;
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) {
      throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    }
    settings[key] = input[key];
  }
  return settings;
}

export class Game extends EventEmitter {
  constructor({ requestMove, whiteModel = 'gpt-6.1-sol', blackModel = 'gpt-6-astra', effort = 'max', settings = {}, persistencePath = null, initialFen, requestTimeoutMs = 1_000_000 } = {}) {
    super();
    if (typeof requestMove !== 'function') throw new Error('A requestMove function is required.');
    this.requestMove = requestMove;
    this.players = { w: { model: whiteModel, effort }, b: { model: blackModel, effort } };
    this.settings = validateSettings(settings);
    this.persistencePath = persistencePath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.initialFen = initialFen ?? new Chess().fen();
    this._epoch = 0;
    this._task = null;
    this._taskController = null;
    this._stepRequested = false;
    this.revision = 0;
    this._newGame();
    this._restore();
  }

  _newGame() {
    this.chess = new Chess(this.initialFen);
    this._setHeaders(this.chess, '*');
    this.id = randomUUID();
    this.moves = [];
    this.thinking = null;
    this.error = null;
    this.result = null;
    this.status = 'idle';
  }

  _setHeaders(chess, score) {
    chess.setHeader('White', this.players.w.model);
    chess.setHeader('Black', this.players.b.model);
    chess.setHeader('Result', score);
  }

  snapshot() {
    return {
      id: this.id, status: this.status, fen: this.chess.fen(), turn: this.chess.turn(),
      board: this.chess.board(), moves: structuredClone(this.moves),
      thinking: this.thinking ? { ...this.thinking } : null,
      error: this.error, result: this.result ? { ...this.result } : null,
      players: structuredClone(this.players), settings: { ...this.settings },
      legalMoves: this.chess.moves({ verbose: true }).map(toUci),
      inCheck: this.chess.inCheck(), pgn: this.chess.pgn(), revision: this.revision,
    };
  }

  _publish() {
    this.revision += 1;
    const state = this.snapshot();
    if (this.persistencePath) {
      try {
        mkdirSync(dirname(this.persistencePath), { recursive: true });
        const temporary = `${this.persistencePath}.tmp`;
        writeFileSync(temporary, JSON.stringify({ version: 1, initialFen: this.initialFen, state }), { mode: 0o600 });
        renameSync(temporary, this.persistencePath);
      } catch (error) { this.emit('persistenceError', error); }
    }
    this.emit('state', state);
    return state;
  }

  _restore() {
    if (!this.persistencePath) return;
    try {
      const saved = JSON.parse(readFileSync(this.persistencePath, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.state?.moves)) return;
      const restored = new Chess(saved.initialFen);
      for (const entry of saved.state.moves) {
        const uci = entry.uci;
        restored.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
      }
      if (restored.fen() !== saved.state.fen) return;
      this.initialFen = saved.initialFen;
      this.chess = restored;
      this.id = saved.state.id || this.id;
      this.moves = saved.state.moves;
      this.settings = validateSettings(saved.state.settings, this.settings);
      this.revision = Number.isInteger(saved.state.revision) ? saved.state.revision : 0;
      this.status = ['finished', 'error', 'idle'].includes(saved.state.status) ? saved.state.status : 'paused';
      this.error = saved.state.error ?? null;
      this.result = saved.state.result ?? null;
      this.thinking = null;
      this._setHeaders(restored, this.result?.score ?? '*');
    } catch { /* Missing or invalid saved games start a fresh game. */ }
  }

  _cancel() {
    this._epoch += 1;
    this._stepRequested = false;
    this._taskController?.abort();
    this.thinking = null;
  }

  start() {
    if (this.status === 'finished') return this.snapshot();
    if (this.status === 'running') return this.snapshot();
    this.status = 'running';
    this.error = null;
    this._stepRequested = false;
    const state = this._publish();
    this._ensureTask();
    return state;
  }

  pause() {
    if (this.status === 'finished') return this.snapshot();
    this._cancel();
    this.status = 'paused';
    return this._publish();
  }

  step() {
    if (this.status === 'running') throw new Error('Pause the game before stepping.');
    if (this.status === 'finished') return this.snapshot();
    if (this.thinking || this._stepRequested) throw new Error('A move is already in progress.');
    this.status = 'paused';
    this.error = null;
    this._stepRequested = true;
    const state = this._publish();
    this._ensureTask();
    return state;
  }

  reset() {
    this._cancel();
    this._newGame();
    return this._publish();
  }

  updateSettings(input) {
    this.settings = validateSettings(input, this.settings);
    return this._publish();
  }

  _finishIfNeeded() {
    let reason;
    let score = '1/2-1/2';
    if (this.chess.isCheckmate()) { reason = 'Checkmate'; score = this.chess.turn() === 'w' ? '0-1' : '1-0'; }
    else if (this.chess.isStalemate()) reason = 'Stalemate';
    else if (this.chess.isThreefoldRepetition()) reason = 'Threefold repetition';
    else if (this.chess.isInsufficientMaterial()) reason = 'Insufficient material';
    else if (this.chess.isDrawByFiftyMoves()) reason = 'Fifty-move rule';
    else if (this.chess.isDraw()) reason = 'Draw';
    else if (this.moves.length >= this.settings.maxPlies) reason = `Move limit reached (${this.settings.maxPlies} plies; exhibition draw)`;
    if (!reason) return false;
    this.result = { score, reason };
    this._setHeaders(this.chess, score);
    this.status = 'finished';
    this.thinking = null;
    this._stepRequested = false;
    this._publish();
    return true;
  }

  _ensureTask() {
    if (this._closed || this._task || (this.status !== 'running' && !this._stepRequested)) return;
    const epoch = this._epoch;
    const controller = new AbortController();
    this._taskController = controller;
    this._task = Promise.resolve().then(() => this._run(epoch, controller.signal)).catch(error => {
      if (epoch !== this._epoch || controller.signal.aborted) return;
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
      this.thinking = null;
      this._stepRequested = false;
      this._publish();
    }).finally(() => {
      this._task = null;
      if (this._taskController === controller) this._taskController = null;
      this._ensureTask();
    });
  }

  async _run(epoch, signal) {
    while (epoch === this._epoch && !signal.aborted && (this.status === 'running' || this._stepRequested)) {
      if (this._finishIfNeeded()) return;
      this._stepRequested = false;
      await this._playPly(epoch, signal);
      if (epoch !== this._epoch || signal.aborted) return;
      if (this._finishIfNeeded()) return;
      if (this.status !== 'running') return;
      if (this.settings.delayMs) {
        let timer;
        try { await withAbort(new Promise(resolve => { timer = setTimeout(resolve, this.settings.delayMs); }), signal); }
        finally { clearTimeout(timer); }
      }
    }
  }

  async _playPly(epoch, signal) {
    const color = this.chess.turn();
    const player = this.players[color];
    const started = Date.now();
    let feedback;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (epoch !== this._epoch || signal.aborted) return;
      this.thinking = { color, model: player.model, startedAt: new Date(started).toISOString(), attempt };
      this._publish();
      if (epoch !== this._epoch || signal.aborted) return;
      const requestController = new AbortController();
      const cancel = () => requestController.abort();
      signal.addEventListener('abort', cancel, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; requestController.abort(); }, this.requestTimeoutMs);
      let response;
      try {
        response = await withAbort(this.requestMove({
          color, model: player.model, effort: player.effort,
          fen: this.chess.fen(), pgn: this.chess.pgn(), board: this.chess.ascii(),
          legalMoves: this.chess.moves({ verbose: true }).map(toUci), feedback,
          signal: requestController.signal,
        }), requestController.signal);
      } catch (error) {
        if (timedOut) throw new Error(`Model request timed out after ${Math.round(this.requestTimeoutMs / 1000)} seconds.`);
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      }
      if (epoch !== this._epoch || signal.aborted) return;
      let parsed;
      try { parsed = parseMoveResponse(response, this.chess); }
      catch (error) {
        if (!(error instanceof InvalidMoveError)) throw error;
        feedback = error.message;
        if (attempt === 3) throw new Error(`${player.model} returned an invalid move on all 3 attempts. ${feedback}`);
        continue;
      }
      const move = this.chess.move({ from: parsed.move.from, to: parsed.move.to, ...(parsed.move.promotion ? { promotion: parsed.move.promotion } : {}) });
      this.moves.push({
        ply: this.moves.length + 1, color, model: player.model, san: move.san,
        uci: toUci(move), fen: this.chess.fen(), comment: parsed.comment,
        ...(parsed.explanation ? { explanation: parsed.explanation } : {}),
        elapsedMs: Date.now() - started, usage: parsed.usage,
        ...(move.captured ? { captured: move.captured } : {}),
        ...(move.promotion ? { promotion: move.promotion } : {}),
      });
      this.thinking = null;
      this._publish();
      return;
    }
  }

  async close() {
    this._closed = true;
    this._cancel();
    if (this.status === 'running') this.status = 'paused';
    this._publish();
    await this._task;
  }
}
