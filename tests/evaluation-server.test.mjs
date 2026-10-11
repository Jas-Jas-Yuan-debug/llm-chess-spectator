import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { Game } from '../lib/game.mjs';
import { StockfishEvaluator } from '../lib/stockfish.mjs';
import { createChessServer } from '../server.mjs';

const bundledEngine = fileURLToPath(new URL('../engine/stockfish/stockfish', import.meta.url));
const secret = 'evaluation-server-test-secret';

function fenAfter(moves) {
  const chess = new Chess();
  for (const move of moves) chess.move(move);
  return chess.fen();
}

async function arena(t, evaluator = null) {
  const calls = [];
  let release;
  const pendingMove = new Promise(resolve => { release = resolve; });
  const game = new Game({ requestMove: input => { calls.push(input); return pendingMove; } });
  const client = { listModels: async () => ({ connected: true, models: ['fake-white', 'fake-black'] }) };
  const server = createChessServer({ game, client, evaluator, apiKey: secret });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${server.accessToken}` };
  t.after(async () => {
    await game.close();
    await evaluator?.close();
    server.closeEvents();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const get = async path => {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    return { status: response.status, body: await response.json() };
  };
  const evaluate = fen => get(`/api/evaluation${fen === undefined ? '' : `?fen=${encodeURIComponent(fen)}`}`);
  const post = async path => {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    return { status: response.status, body: await response.json() };
  };
  return { game, evaluator, calls, release, get, evaluate, post };
}

test('opening database accompanies evaluations without engine or player work and rejects invalid positions', async t => {
  const viewer = await arena(t);
  const before = viewer.game.snapshot();
  const result = await viewer.evaluate(before.fen);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'unavailable');
  assert.equal(result.body.opening.source.name, 'Lichess openings');
  assert.equal(result.body.opening.source.openingCount, 3865);
  assert.equal(result.body.opening.inBook, true);
  assert.ok(result.body.opening.moves.some(move => move.uci === 'e2e4' && move.san === 'e4'));
  const legal = new Chess(before.fen).moves({ verbose: true }).map(move => move.lan);
  assert.ok(result.body.opening.moves.every(move => legal.includes(move.uci)));
  const invalid = await viewer.evaluate('not a position');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.opening, undefined);
  assert.equal(viewer.calls.length, 0);
  assert.deepEqual(viewer.game.snapshot(), before);
});

async function readyEvaluation(arena, fen) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await arena.evaluate(fen);
    assert.equal(result.status, 200);
    if (result.body.status === 'ready') return result.body;
    assert.equal(result.body.status, 'pending', JSON.stringify(result.body));
    await delay(20);
  }
  assert.fail('The requested evaluation did not finish.');
}

function fakeEngine(searchMs = 120) {
  const commands = [];
  const child = new EventEmitter();
  child.pid = 999999;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let fen;
  let active = false;
  let timer;
  const output = line => child.stdout.write(`${line}\n`);
  const bestMove = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    const chess = new Chess(fen);
    const move = chess.moves({ verbose: true })[0];
    const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
    output(`info depth 12 score cp 40 wdl 100 900 0 pv ${uci}`);
    output(`bestmove ${uci}`);
  };
  child.kill = () => {
    if (child.exitCode !== null) return;
    clearTimeout(timer);
    child.exitCode = 0;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
  };
  child.stdin = new Writable({
    write(chunk, encoding, done) {
      for (const command of chunk.toString().trim().split('\n')) {
        commands.push(command);
        if (command === 'uci') queueMicrotask(() => {
          output('id name Stockfish 19');
          output('option name Threads type spin default 1 min 1 max 1024');
          output('option name Hash type spin default 16 min 1 max 10000');
          output('option name UCI_ShowWDL type check default false');
          output('uciok');
        });
        if (command === 'isready') queueMicrotask(() => output('readyok'));
        if (command.startsWith('position fen ')) fen = command.slice(13);
        if (command.startsWith('go ')) { active = true; timer = setTimeout(bestMove, searchMs); }
        if (command === 'stop') queueMicrotask(bestMove);
        if (command === 'quit') queueMicrotask(child.kill);
      }
      done();
    },
  });
  const evaluator = new StockfishEvaluator({ enginePath: 'fake-stockfish', spawnImpl: () => child, movetimeMs: searchMs });
  return { evaluator, child, commands };
}

test('two HTTP viewers finish both evaluations while repeatedly polling different positions', async t => {
  const engine = fakeEngine();
  const viewer = await arena(t, engine.evaluator);
  assert.equal(await engine.evaluator.ready, true);
  const initial = new Chess().fen();
  const afterE4 = fenAfter(['e4']);
  const before = viewer.game.snapshot();
  for (let round = 0; round < 16; round += 1) {
    assert.equal((await viewer.evaluate(initial)).status, 200);
    assert.equal((await viewer.evaluate(afterE4)).status, 200);
    await delay(20);
  }
  const white = (await viewer.evaluate(initial)).body;
  const black = (await viewer.evaluate(afterE4)).body;
  assert.equal(white.status, 'ready');
  assert.equal(black.status, 'ready');
  assert.equal(white.cpWhite, 40);
  assert.equal(black.cpWhite, -40);
  assert.deepEqual(white.wdlWhite, { win: 100, draw: 900, loss: 0 });
  assert.deepEqual(black.wdlWhite, { win: 0, draw: 900, loss: 100 });
  assert.equal(engine.commands.filter(command => command.startsWith('go ')).length, 2);
  assert.deepEqual(viewer.game.snapshot(), before);
  assert.equal(viewer.calls.length, 0);
  assert.equal(JSON.stringify([white, black]).includes(secret), false);
});

test('pending evaluations do not block or modify a pending LLM move or game controls', async t => {
  const engine = fakeEngine(250);
  const viewer = await arena(t, engine.evaluator);
  await engine.evaluator.ready;
  await viewer.post('/api/step');
  assert.equal(viewer.calls.length, 1);
  const before = viewer.game.snapshot();
  const pending = await viewer.evaluate();
  assert.equal(pending.status, 200);
  assert.equal(pending.body.status, 'pending');
  assert.deepEqual((await viewer.get('/api/state')).body, before);
  const paused = await viewer.post('/api/pause');
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'paused');
  assert.equal(viewer.calls[0].signal.aborted, true);
  viewer.release({ move: 'e2e4' });
  const evaluation = await readyEvaluation(viewer, before.fen);
  assert.equal(evaluation.status, 'ready');
  assert.equal(viewer.game.snapshot().moves.length, 0);
  assert.equal(viewer.game.snapshot().fen, before.fen);
});

test('evaluation API handles missing engine and invalid FEN without querying either LLM', async t => {
  const viewer = await arena(t);
  const before = viewer.game.snapshot();
  const unavailable = await viewer.evaluate();
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.body.status, 'unavailable');
  assert.equal(unavailable.body.fen, before.fen);
  for (const fen of [
    'not a FEN', `${before.fen}\ngo infinite`, '4k3/8/8/8/8/8/4R3/4K3 w - - 0 1',
    before.fen.replace(' 0 1', ' 100001x 1'), before.fen.replace(' 0 1', ' 0 100001x'),
    '4k3/8/8/8/8/8/8/4K3 w Q - 0 1', '4k3/8/8/8/8/8/8/r3K3 w Q - 0 1',
  ]) {
    const invalid = await viewer.evaluate(fen);
    assert.equal(invalid.status, 400);
    assert.equal(JSON.stringify(invalid.body).includes(secret), false);
  }
  assert.deepEqual(viewer.game.snapshot(), before);
  assert.equal(viewer.calls.length, 0);
});

test('bundled Stockfish HTTP results use White perspective, legal SAN lines, and clean shutdown', {
  skip: !existsSync(bundledEngine),
}, async t => {
  const evaluator = new StockfishEvaluator({ enginePath: bundledEngine, movetimeMs: 150, maxDepth: 12 });
  const viewer = await arena(t, evaluator);
  assert.equal(await evaluator.ready, true);
  const before = viewer.game.snapshot();
  const cases = [
    { fen: fenAfter(['f3', 'e5', 'g4']), winner: 'b', mate: -1, san: 'Qh4#' },
    { fen: fenAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6']), winner: 'w', mate: 1, san: 'Qxf7#' },
    { fen: fenAfter(['f3', 'e5', 'g4', 'Qh4#']), winner: 'b', mate: 0 },
    { fen: fenAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']), winner: 'w', mate: 0 },
  ];
  for (const position of cases) {
    const result = await readyEvaluation(viewer, position.fen);
    assert.equal(result.fen, position.fen);
    assert.equal(result.engine.version, '19');
    assert.equal(result.mateWhite, position.mate);
    assert.equal(result.winningColor, position.winner);
    assert.deepEqual(result.wdlWhite, position.winner === 'w' ? { win: 1000, draw: 0, loss: 0 } : { win: 0, draw: 0, loss: 1000 });
    const replay = new Chess(position.fen);
    assert.deepEqual(result.pvUci.map(move => replay.move(move).san), result.pvSan);
    if (position.san) assert.equal(result.pvSan[0], position.san);
    else assert.deepEqual(result.pvUci, []);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(viewer.game.snapshot(), before);
  assert.equal(viewer.calls.length, 0);
  await evaluator.close();
  assert.ok(evaluator.child.exitCode !== null || evaluator.child.signalCode !== null);
});
