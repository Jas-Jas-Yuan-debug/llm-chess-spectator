import { createServer as createHttpServer } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Game } from './lib/game.mjs';
import { OpenAIClient, publicError } from './lib/llm.mjs';
import { StockfishEvaluator, unavailableEvaluation } from './lib/stockfish.mjs';

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

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function sameLocalOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(`http://${request.headers.host}`);
    return originUrl.protocol === requestUrl.protocol && isLocalHost(originUrl.hostname) && isLocalHost(requestUrl.hostname) && originUrl.port === requestUrl.port;
  } catch { return false; }
}

export function createChessServer({ game, client, evaluator = null, publicDir = join(rootDirectory, 'public'), apiKey = '' }) {
  if (!game || !client) throw new Error('A game and model client are required.');
  const clients = new Set();
  const publish = state => {
    const event = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const response of clients) response.write(event);
  };
  game.on('state', publish);
  const server = createHttpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/')) {
        if (request.method === 'POST' && !sameLocalOrigin(request)) return json(response, 403, { error: 'Cross-origin game controls are not allowed.' });
        if (request.method === 'GET' && pathname === '/api/state') return json(response, 200, game.snapshot());
        if (request.method === 'GET' && pathname === '/api/models') return json(response, 200, await client.listModels());
        if (request.method === 'GET' && pathname === '/api/evaluation') {
          const fen = url.searchParams.get('fen') ?? game.snapshot().fen;
          return json(response, 200, evaluator ? evaluator.evaluate(fen) : unavailableEvaluation(fen));
        }
        if (request.method === 'GET' && pathname === '/api/events') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
          });
          response.write(`retry: 1500\nevent: state\ndata: ${JSON.stringify(game.snapshot())}\n\n`);
          clients.add(response);
          const timer = setInterval(() => response.write(': keepalive\n\n'), 15_000);
          request.on('close', () => { clearInterval(timer); clients.delete(response); });
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
  server.on('close', () => { game.off('state', publish); for (const response of clients) response.end(); clients.clear(); evaluator?.close?.()?.catch?.(() => {}); });
  server.closeEvents = () => { for (const response of clients) response.end(); clients.clear(); };
  return server;
}

export async function startServer({ port, baseUrl, apiKey, persistencePath, whiteModel, blackModel, effort, publicDir, evaluator: suppliedEvaluator, stockfishPath } = {}) {
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
  const evaluator = suppliedEvaluator === undefined ? new StockfishEvaluator({ enginePath: stockfishPath ?? process.env.STOCKFISH_PATH ?? join(rootDirectory, 'engine', 'stockfish', 'stockfish') }) : suppliedEvaluator;
  const server = createChessServer({ game, client, evaluator, publicDir, apiKey: secret });
  try { await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(configuredPort, '127.0.0.1', resolvePromise); }); }
  catch (error) { await evaluator?.close(); throw error; }
  return { server, game, client, evaluator, port: server.address().port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().then(({ server, game, evaluator, port }) => {
    console.log(`LLM Chess is ready at http://127.0.0.1:${port}`);
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
