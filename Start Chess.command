#!/bin/zsh
set -eu
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  print "Node.js 22.19 or newer is required. Install it from https://nodejs.org."
  read -r "?Press Enter to close."
  exit 1
fi
if [ ! -d node_modules/chess.js ] || [ ! -d node_modules/undici ]; then
  npm install --no-audit --no-fund
fi
if [ ! -x engine/stockfish/stockfish ]; then
  npm run setup:engine
fi
chess_port=$(node --input-type=module -e 'try { process.loadEnvFile(".env"); } catch {} console.log(process.env.PORT || "3000")')
chess_url="http://127.0.0.1:${chess_port}"
chess_open_private_viewer() {
  local chess_private_url
  chess_private_url=$(node --input-type=module - "$chess_port" <<'CHESS_VIEWER_READER'
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
const port = Number(process.argv[2]);
let descriptor;
try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  descriptor = openSync('.local/viewer-access.json', constants.O_RDONLY | constants.O_NOFOLLOW);
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid() || metadata.size > 4096) throw new Error('Invalid private viewer file.');
  const { url: value } = JSON.parse(readFileSync(descriptor, 'utf8'));
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid private viewer URL.');
  const url = new URL(value);
  const expected = new URL(`http://127.0.0.1:${port}/`);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (url.origin !== expected.origin || url.pathname !== '/' || url.search || url.username || url.password || fragment.size !== 1 || !/^[A-Za-z0-9_-]{32,256}$/.test(fragment.get('access_token') || '')) throw new Error('Invalid private viewer URL.');
  process.stdout.write(url.href);
} catch {
  process.exitCode = 1;
} finally { if (descriptor !== undefined) closeSync(descriptor); }
CHESS_VIEWER_READER
  ) || return 1
  open "$chess_private_url"
}
if curl -fsS --max-time 2 "$chess_url/api/health" >/dev/null 2>&1; then
  if ! chess_open_private_viewer; then
    print "The private viewer link could not be read. Open the private viewer link printed by the running server."
    exit 1
  fi
  print "Chess Spectator is already running. Its private viewer has been opened."
  exit 0
fi
(
  for chess_attempt in {1..40}; do
    if curl -fsS --max-time 1 "$chess_url/api/health" >/dev/null 2>&1; then
      if chess_open_private_viewer; then break; fi
    fi
    sleep 0.25
  done
) &
npm start
