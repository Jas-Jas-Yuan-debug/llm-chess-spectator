import { createServer as createHttpServer } from 'node:http';
import { existsSync, statSync, createReadStream, mkdirSync, chmodSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Game } from './lib/game.mjs';
import { OpenAIClient, publicError } from './lib/llm.mjs';
import { StockfishEvaluator, unavailableEvaluation } from './lib/stockfish.mjs';
import { getOpeningInfo } from './lib/openings.mjs';
import { newAccessToken, requestOrigin, browserContextAllowed, hasAccess } from './lib/access.mjs';

const rootDirectory = dirname(fileURLToPath(import.meta.url));
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 32_768) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!bytes) return {};
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 });
  return result;
}

export function createChessServer({ game, client, evaluator = null, publicDir = join(rootDirectory, 'public'), apiKey = '', accessToken = newAccessToken(), maxSubscribers = 8, maxEventBytes = 8 * 1024 * 1024 + 4096, stallTimeoutMs = 5000 }) {
  if (!game || !client) throw new Error('A game and model client are required.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(accessToken)) throw new Error('A 256-bit viewer access token is required.');
  maxSubscribers = Math.max(1, Math.min(8, maxSubscribers));
  const clients = new Set();
  const cleanup = (viewer, destroy = false) => {
    if (!clients.delete(viewer)) return;
    clearInterval(viewer.heartbeat);
    clearTimeout(viewer.stallTimer);
    viewer.latest = null;
    viewer.response.off('drain', viewer.drain);
    viewer.response.off('close', viewer.close);
    viewer.response.off('error', viewer.close);
    if (destroy) viewer.response.destroy();
    else viewer.response.end();
  };
  const send = (viewer, event, isState = false) => {
    if (!clients.has(viewer)) return;
    if (Buffer.byteLength(event) > maxEventBytes || viewer.response.writableLength > maxEventBytes) return cleanup(viewer, true);
    if (viewer.blocked) {
      if (isState) viewer.latest = event;
      return;
    }
    if (!viewer.response.write(event)) {
      viewer.blocked = true;
      viewer.stallTimer = setTimeout(() => cleanup(viewer, true), stallTimeoutMs);
    }
    if (viewer.response.writableLength > maxEventBytes) cleanup(viewer, true);
  };
  const publish = state => {
    const event = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const viewer of clients) send(viewer, event, true);
  };
  game.on('state', publish);
  const server = createHttpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const origin = requestOrigin(request, server.address()?.port);
      if (!origin) return json(response, 403, { error: 'Unapproved local request authority.' });
      const url = new URL(request.url, origin);
      if (url.origin !== origin || url.username || url.password) return json(response, 403, { error: 'Request target authority must match Host.' });
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/')) {
        if (!browserContextAllowed(request, origin)) return json(response, 403, { error: 'Cross-origin API requests are not allowed.' });
        if (request.method === 'GET' && pathname === '/api/health') return json(response, 200, { ready: true });
        if (!hasAccess(request, accessToken)) return json(response, 401, { error: 'Open the private viewer link printed by the server or use Start Chess.command.' });
        if (request.method === 'POST' && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) return json(response, 415, { error: 'Game controls require application/json.' });
        if (request.method === 'GET' && pathname === '/api/state') return json(response, 200, game.snapshot());
        if (request.method === 'GET' && pathname === '/api/models') {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          response.once('close', cancel);
          try { return json(response, 200, await client.listModels({ signal: controller.signal })); }
          finally { response.off('close', cancel); }
        }
        if (request.method === 'GET' && pathname === '/api/evaluation') {
          const fen = url.searchParams.get('fen') ?? game.snapshot().fen;
          const evaluation = evaluator ? evaluator.evaluate(fen) : unavailableEvaluation(fen);
          return json(response, 200, { ...evaluation, opening: getOpeningInfo(fen) });
        }
        if (request.method === 'GET' && pathname === '/api/events') {
          if (clients.size >= maxSubscribers) return json(response, 429, { error: 'Too many live viewers. Close another viewer and retry.' });
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
          });
          const viewer = { response, blocked: false, latest: null, heartbeat: null, stallTimer: null };
          viewer.close = () => cleanup(viewer, true);
          viewer.drain = () => {
            if (!clients.has(viewer)) return;
            viewer.blocked = false;
            clearTimeout(viewer.stallTimer);
            const latest = viewer.latest;
            viewer.latest = null;
            if (latest) send(viewer, latest, true);
          };
          clients.add(viewer);
          response.on('drain', viewer.drain);
          response.once('close', viewer.close);
          response.once('error', viewer.close);
          send(viewer, `retry: 1500\nevent: state\ndata: ${JSON.stringify(game.snapshot())}\n\n`, true);
          if (clients.has(viewer)) viewer.heartbeat = setInterval(() => send(viewer, ': keepalive\n\n'), 15_000);
          return;
        }
        if (request.method === 'GET' && pathname === '/api/pgn') {
          response.writeHead(200, { 'Content-Type': 'application/x-chess-pgn; charset=utf-8', 'Content-Disposition': 'attachment; filename="llm-chess.pgn"', 'Cache-Control': 'no-store' });
          return response.end(`${game.snapshot().pgn}\n`);
        }
        const controls = { '/api/start': () => game.start(), '/api/pause': () => game.pause(), '/api/step': () => game.step(), '/api/reset': () => game.reset(), '/api/settings': body => game.updateSettings(body) };
        if (request.method === 'POST' && controls[pathname]) {
          const body = await readJson(request);
          try { return json(response, 200, controls[pathname](body)); }
          catch (error) { return json(response, pathname === '/api/settings' ? 400 : 409, { error: publicError(error, apiKey) }); }
        }
        return json(response, 404, { error: 'API route not found.' });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: 'Method not allowed.' });
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (relative.split('/').some(part => part.startsWith('.')) || relative.includes('\\')) return json(response, 404, { error: 'File not found.' });
      const file = resolve(publicDir, relative);
      const directory = resolve(publicDir);
      if (file !== directory && !file.startsWith(`${directory}${sep}`)) return json(response, 404, { error: 'File not found.' });
      if (!existsSync(file) || !statSync(file).isFile()) return json(response, 404, { error: 'File not found.' });
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      if (request.method === 'HEAD') return response.end();
      const stream = createReadStream(file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 400, { error: publicError(error, apiKey) });
      else response.destroy();
    }
  });
  server.on('close', () => { game.off('state', publish); for (const viewer of [...clients]) cleanup(viewer); evaluator?.close?.()?.catch?.(() => {}); });
  server.closeEvents = () => { for (const viewer of [...clients]) cleanup(viewer); };
  Object.defineProperty(server, 'accessToken', { value: accessToken });
  return server;
}

export async function startServer({ port, baseUrl, apiKey, persistencePath, whiteModel, blackModel, effort, publicDir, evaluator: suppliedEvaluator, stockfishPath, syzygyPath } = {}) {
  const envFile = join(rootDirectory, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const configuredPort = port ?? Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const secret = apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const client = new OpenAIClient({ baseUrl: baseUrl ?? process.env.OPENAI_BASE_URL, apiKey: secret });
  const game = new Game({
    requestMove: input => client.move(input),
    whiteModel: whiteModel ?? process.env.WHITE_MODEL ?? 'gpt-6.1-sol',
    blackModel: blackModel ?? process.env.BLACK_MODEL ?? 'gpt-6-astra',
    effort: effort ?? process.env.REASONING_EFFORT ?? 'max',
    persistencePath: persistencePath === undefined ? join(rootDirectory, '.local', 'current-game.json') : persistencePath,
  });
  game.on('persistenceError', error => console.error(`Could not save game: ${publicError(error, secret)}`));
  const configuredSyzygyPath = syzygyPath ?? process.env.STOCKFISH_SYZYGY_PATH;
  const evaluator = suppliedEvaluator === undefined ? new StockfishEvaluator({
    enginePath: stockfishPath ?? process.env.STOCKFISH_PATH ?? join(rootDirectory, 'engine', 'stockfish', 'stockfish'),
    syzygyPath: configuredSyzygyPath ? resolve(rootDirectory, configuredSyzygyPath) : undefined,
  }) : suppliedEvaluator;
  const server = createChessServer({ game, client, evaluator, publicDir, apiKey: secret });
  try { await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(configuredPort, '127.0.0.1', resolvePromise); }); }
  catch (error) { await evaluator?.close(); throw error; }
  const viewerUrl = `http://127.0.0.1:${server.address().port}/#access_token=${server.accessToken}`;
  if (persistencePath === undefined) {
    const local = join(rootDirectory, '.local');
    mkdirSync(local, { recursive: true, mode: 0o700 });
    chmodSync(local, 0o700);
    const accessFile = join(local, 'viewer-access.json');
    const temporary = `${accessFile}.tmp`;
    writeFileSync(temporary, JSON.stringify({ url: viewerUrl }), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, accessFile);
    const log = join(local, 'chess-server.log');
    if (existsSync(log)) chmodSync(log, 0o600);
  }
  return { server, game, client, evaluator, port: server.address().port, viewerUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().then(({ server, game, evaluator, viewerUrl }) => {
    console.log(`LLM Chess private viewer: ${viewerUrl}`);
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      await game.close();
      await evaluator?.close();
      server.closeEvents();
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch(error => { console.error(publicError(error, process.env.OPENAI_API_KEY)); process.exitCode = 1; });
}
