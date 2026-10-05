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
if curl -fsS --max-time 2 "$chess_url/api/state" >/dev/null 2>&1; then
  open "$chess_url"
  print "Chess Spectator is already running at $chess_url"
  exit 0
fi
(
  for chess_attempt in {1..40}; do
    if curl -fsS --max-time 1 "$chess_url/api/state" >/dev/null 2>&1; then
      open "$chess_url"
      break
    fi
    sleep 0.25
  done
) &
npm start
