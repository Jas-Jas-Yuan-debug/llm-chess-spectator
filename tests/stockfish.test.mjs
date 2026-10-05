import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { Chess } from 'chess.js';
import { StockfishEvaluator, validateEvaluationFen } from '../lib/stockfish.mjs';

const initialFen = new Chess().fen();
function after(...moves) { const chess = new Chess(); for (const move of moves) chess.move(move); return chess.fen(); }
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeUci extends EventEmitter {
  constructor({ onGo, onStop, version = '19', wdl = true, drainReady = true } = {}) {
    super();
    this.pid = 12345;
    this.exitCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.commands = [];
    this.onGo = onGo;
    this.onStop = onStop;
    this.version = version;
    this.wdl = wdl;
    this.drainReady = drainReady;
    this.readyCount = 0;
    this.goCount = 0;
    this.fen = null;
    this.stdin = new Writable({ write: (chunk, encoding, callback) => {
      for (const command of chunk.toString().trim().split('\n')) {
        this.commands.push(command);
        queueMicrotask(() => this.command(command));
      }
      callback();
    } });
  }
  lines(...lines) { this.stdout.write(`${lines.join('\n')}\n`); }
  command(command) {
    if (command === 'uci') this.lines(`id name Stockfish ${this.version}`, 'option name Threads type spin default 1 min 1 max 1024', 'option name Hash type spin default 16 min 1 max 33554432', 'option name MultiPV type spin default 1 min 1 max 256', ...(this.wdl ? ['option name UCI_ShowWDL type check default false'] : []), 'uciok');
    else if (command === 'isready') { this.readyCount += 1; if (this.readyCount === 1 || this.drainReady) this.lines('readyok'); }
    else if (command.startsWith('position fen ')) this.fen = command.slice(13);
    else if (command.startsWith('go ')) {
      this.goCount += 1;
      if (this.onGo) this.onGo(this, this.fen);
      else {
        const chess = new Chess(this.fen);
        const move = chess.moves({ verbose: true })[0];
        const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
        this.lines(`info depth 12 multipv 1 score cp 40 wdl 80 900 20 nodes 1000 nps 50000 pv ${uci}`, `bestmove ${uci}`);
      }
    } else if (command === 'stop') this.onStop?.(this);
    else if (command === 'quit') this.kill();
  }
  kill(signal = null) {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit('exit', 0, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit('close', 0, signal);
  }
}

async function fixture(t, options = {}, evaluatorOptions = {}) {
  const fake = new FakeUci(options);
  const evaluator = new StockfishEvaluator({ enginePath: 'fake-stockfish', spawnImpl: () => fake, ...evaluatorOptions });
  t.after(() => evaluator.close());
  assert.equal(await evaluator.ready, true);
  return { fake, evaluator };
}

function finished(evaluator, fen, timeout = 1000) {
  const current = evaluator.evaluate(fen);
  if (current.status !== 'pending') return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const listener = value => {
      if (value.fen !== fen || value.status === 'pending') return;
      clearTimeout(timer);
      evaluator.off('evaluation', listener);
      resolve(value);
    };
    const timer = setTimeout(() => { evaluator.off('evaluation', listener); reject(new Error('Evaluation did not finish.')); }, timeout);
    evaluator.on('evaluation', listener);
  });
}

test('verifies actual UCI identity and applies supported bounded analysis settings', async t => {
  const { fake, evaluator } = await fixture(t);
  assert.deepEqual(evaluator.engine, { name: 'Stockfish 19', version: '19' });
  const value = await finished(evaluator, initialFen);
  assert.equal(value.status, 'ready');
  assert.ok(fake.commands.includes('setoption name Threads value 2'));
  assert.ok(fake.commands.includes('setoption name Hash value 128'));
  assert.ok(fake.commands.includes('setoption name MultiPV value 1'));
  assert.ok(fake.commands.includes('setoption name UCI_ShowWDL value true'));
  assert.ok(fake.commands.includes('go depth 22 movetime 1500'));
  assert.equal(value.depth, 12);
  assert.equal(value.cpWhite, 40);
  assert.deepEqual(value.wdlWhite, { win: 80, draw: 900, loss: 20 });
});

test('normalizes Black scores and WDL into White perspective and validates SAN PV', async t => {
  const fen = after('e4');
  const { evaluator } = await fixture(t, { onGo: fake => fake.lines('info depth 18 multipv 1 score cp 70 wdl 100 850 50 nodes 5000 nps 70000 pv e7e5 g1f3 b8c6 a1a8', 'bestmove e7e5') });
  const value = await finished(evaluator, fen);
  assert.equal(value.cpWhite, -70);
  assert.equal(value.mateWhite, null);
  assert.equal(value.winningColor, null);
  assert.deepEqual(value.wdlWhite, { win: 50, draw: 850, loss: 100 });
  assert.deepEqual(value.pvUci, ['e7e5', 'g1f3', 'b8c6']);
  assert.deepEqual(value.pvSan, ['e5', 'Nf3', 'Nc6']);
  assert.equal(value.bestMove, 'e7e5');
});

test('concurrent positions complete fairly in order, with deduplication and readyok drain', async t => {
  const fenB = after('e4');
  const fenC = after('e4', 'e5');
  const { fake, evaluator } = await fixture(t, {
    drainReady: false,
    onGo: (fake, fen) => {
      if (fen === initialFen) fake.lines('info depth 4 score cp 10 pv e2e4 e7e5');
      else if (fen === fenB) fake.lines('info depth 13 score cp 25 pv e7e5 g1f3', 'bestmove e7e5');
      else fake.lines('info depth 14 score cp 35 pv g1f3 b8c6', 'bestmove g1f3');
    },
    onStop: fake => { /* The test explicitly releases the drain. */ },
  });
  evaluator.evaluate(initialFen);
  await tick();
  assert.equal(fake.goCount, 1);
  const doneB = finished(evaluator, fenB);
  const pending = evaluator.evaluate(fenC);
  evaluator.evaluate(fenB);
  assert.equal(pending.fen, fenC);
  assert.equal(pending.status, 'pending');
  await tick();
  assert.equal(fake.goCount, 1);
  assert.equal(fake.commands.includes('stop'), false);
  fake.lines('info depth 12 score cp 30 pv e2e4 e7e5', 'bestmove e2e4');
  await tick();
  assert.equal(fake.goCount, 1);
  assert.equal(fake.commands.includes(`position fen ${fenB}`), false);
  const done = finished(evaluator, fenC);
  fake.lines('readyok');
  const valueB = await doneB;
  assert.equal(valueB.fen, fenB);
  assert.equal(valueB.cpWhite, -25);
  assert.deepEqual(valueB.pvSan, ['e5', 'Nf3']);
  await tick();
  assert.equal(fake.goCount, 2);
  fake.lines('readyok');
  const value = await done;
  assert.equal(value.fen, fenC);
  assert.equal(value.cpWhite, 35);
  assert.equal(value.depth, 14);
  assert.deepEqual(value.pvSan, ['Nf3', 'Nc6']);
  assert.equal(fake.goCount, 3);
  assert.equal(evaluator.cache.get(initialFen).cpWhite, 30);
  assert.deepEqual(fake.commands.filter(command => command.startsWith('position fen ')), [`position fen ${initialFen}`, `position fen ${fenB}`, `position fen ${fenC}`]);
  fake.lines('readyok');
});

test('queue overflow is bounded and recoverable without interrupting existing viewers', async t => {
  const { fake, evaluator } = await fixture(t, { onGo: () => {} }, { maxQueue: 1 });
  evaluator.evaluate(initialFen);
  await tick();
  const fenB = after('e4');
  const fenC = after('e4', 'e5');
  assert.equal(evaluator.evaluate(fenB).status, 'pending');
  assert.equal(evaluator.evaluate(fenB).status, 'pending');
  const overflow = evaluator.evaluate(fenC);
  assert.equal(overflow.fen, fenC);
  assert.equal(overflow.status, 'error');
  assert.match(overflow.error, /queue is full/i);
  assert.equal(evaluator._queue.size, 1);
  assert.equal(fake.goCount, 1);
  assert.equal(fake.commands.includes('stop'), false);
  fake.lines('info depth 10 score cp 20 pv e2e4', 'bestmove e2e4');
  await tick();
  assert.equal(evaluator.evaluate(fenC).status, 'pending');
  assert.equal(fake.goCount, 2);
});

test('forced mate signs and already-checkmated winner are normalized correctly', async t => {
  const fen = after('f3', 'e5', 'g4');
  const { fake, evaluator } = await fixture(t, { onGo: fake => fake.lines('info depth 6 score mate 1 wdl 1000 0 0 pv d8h4', 'bestmove d8h4') });
  const value = await finished(evaluator, fen);
  assert.equal(value.mateWhite, -1);
  assert.equal(value.winningColor, 'b');
  assert.deepEqual(value.pvSan, ['Qh4#']);
  const alreadyMated = after('f3', 'e5', 'g4', 'Qh4#');
  const terminal = await finished(evaluator, alreadyMated);
  assert.equal(terminal.mateWhite, 0);
  assert.equal(terminal.winningColor, 'b');
  assert.equal(terminal.bestMove, null);
  assert.equal(terminal.depth, 0);
  assert.deepEqual(terminal.wdlWhite, { win: 0, draw: 0, loss: 1000 });
  assert.equal(fake.goCount, 1);
});

test('rejects malformed and engine-unsafe FEN without sending commands', async t => {
  const { fake, evaluator } = await fixture(t);
  const before = fake.commands.length;
  for (const fen of ['not a fen', '8/8/8/8/8/8/8/8 w - - 0 1', `${initialFen}\nquit`, '4k3/8/8/8/8/8/4R3/4K3 w - - 0 1', '4k3/8/8/8/8/QQ6/PPPPPPPP/4K3 w - - 0 1']) {
    assert.throws(() => evaluator.evaluate(fen), error => error.status === 400);
  }
  assert.equal(fake.commands.length, before);
  assert.equal(validateEvaluationFen(initialFen), initialFen);
});

test('deduplicates evaluations and bounds completed LRU cache', async t => {
  const { fake, evaluator } = await fixture(t, {}, { maxCache: 2 });
  const fenB = after('e4');
  const fenC = after('e4', 'e5');
  evaluator.evaluate(initialFen);
  evaluator.evaluate(initialFen);
  await finished(evaluator, initialFen);
  assert.equal(fake.goCount, 1);
  await finished(evaluator, fenB);
  evaluator.evaluate(initialFen);
  await finished(evaluator, fenC);
  assert.equal(evaluator.cache.size, 2);
  assert.equal(evaluator.cache.has(initialFen), true);
  assert.equal(evaluator.cache.has(fenB), false);
  assert.equal(evaluator.evaluate(initialFen).status, 'ready');
  assert.equal(fake.goCount, 3);
});

test('missing binary or invalid UCI identity degrades cleanly and close kills subprocess', async t => {
  const missing = new StockfishEvaluator({ enginePath: '/definitely/no/stockfish' });
  t.after(() => missing.close());
  assert.equal(await missing.ready, false);
  const unavailable = missing.evaluate(initialFen);
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.error, /could not start/i);
  const invalidFake = new FakeUci({ version: 'unknown' });
  const invalid = new StockfishEvaluator({ enginePath: 'fake', spawnImpl: () => invalidFake });
  t.after(() => invalid.close());
  assert.equal(await invalid.ready, false);
  assert.equal(invalid.evaluate(initialFen).status, 'unavailable');
  assert.equal(invalidFake.exitCode, 0);
  const { fake, evaluator } = await fixture(t, { onGo: () => {} });
  evaluator.evaluate(initialFen);
  await tick();
  await evaluator.close();
  assert.equal(fake.exitCode, 0);
  assert.equal(evaluator.evaluate(initialFen).status, 'unavailable');
});

test('bound-only scores and illegal best moves cannot appear as complete valid analysis', async t => {
  const { evaluator } = await fixture(t, { wdl: false, onGo: fake => fake.lines('info depth 10 score cp 100 lowerbound nodes 50 pv e2e4', 'bestmove e2e5') });
  const value = await finished(evaluator, initialFen);
  assert.equal(value.status, 'error');
  assert.match(value.error, /illegal best move/i);
  assert.equal(value.cpWhite, null);
  assert.equal(value.pvUci.length, 0);
});
