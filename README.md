# Chess Spectator

A local chess arena where you can watch two LLMs play against each other. The default configuration uses **GPT-6.1 Sol (White)** and **GPT-6 Astra (Black)** with **max** reasoning through an OpenAI-compatible API.

The default model names are proxy-specific aliases. Your API service must support the configured model names and reasoning effort; change them to match its model catalog.

## Run

Install **Node.js 22.19 or newer** and Git, then clone the project:

```sh
git clone https://github.com/Jas-Jas-Yuan-debug/llm-chess-spectator.git
cd llm-chess-spectator
npm ci
cp .env.example .env
```

Edit `.env` with your own `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `WHITE_MODEL`, and `BLACK_MODEL`. The example endpoint is `http://127.0.0.1:8317/v1`; run your compatible API service there or replace it with your service's URL. Keep `REASONING_EFFORT=max` if your service supports it.

On **macOS**, install the Stockfish evaluator:

```sh
npm run setup:engine
```

On **Linux or Windows**, install an official Stockfish executable for your system and set `STOCKFISH_PATH` in `.env` to its absolute path. The automatic installer supports macOS. Missing Stockfish leaves the match viewer usable and displays an evaluator-unavailable message.

Start the app:

```sh
npm start
```

Open the **private viewer link printed by the server**, then choose **Start match**. It has the form `http://127.0.0.1:3000/#access_token=…`; the token is generated for each server launch. On macOS, **Start Chess.command** opens this private link automatically after configuration, including when the server is already running. Keep the terminal running while you watch; Control-C stops the server.

The browser removes the token from the address bar and keeps it in that tab's session storage, scoped to the exact app origin and port. Refreshing the tab retains access. A new browser session or server restart requires the current private viewer link. Opening the bare URL shows instructions for entering the private arena.

## Watch a match

- **Pause / Resume** controls the match; pause cancels a pending move request.
- **Step** requests a single move.
- Select a move or use the review controls to replay the position. **Live** returns to the current position.
- **Flip board** changes perspective.
- **Export PGN** saves a standard chess game file.
- **Move explanations** shows each model's short explanation of its choice, threats and tradeoffs, legal alternatives, and next plan. White and Black tabs let you inspect their latest explanations; selecting a historical move shows its saved explanation. Moves played before this feature retain their original commentary.
- **Stockfish evaluation** analyzes the position you are viewing, including replayed moves. It shows the engine version, search depth, an advantage bar, and the best line. Positive scores favor White; negative scores favor Black. A mate score names the side with a forced mate. Stockfish runs separately from the LLM players.
- **Settings** adjusts the delay between moves and maximum game length.
- **New game** resets the board; export a game you want to keep first.

Every move is checked by `chess.js`. Models receive the position, move history, and legal move list. Invalid moves are retried; repeated failures produce a visible error so no substitute move is silently played. Checkmate and drawn positions end the match automatically. A move limit bounds long games. Commentary and explanations are model-provided summaries, and the app does not collect private reasoning transcripts.

Each model request has a cutoff of **1,000 seconds (16 minutes 40 seconds)**. The game controller, API client, and HTTP response timeouts use this limit; pausing still cancels a pending request immediately. A recognized incomplete provider stream or socket disconnect is retried once per move after a one-second delay, within the original request deadline. Repeated disconnects or a timeout stop the match; **Retry match** continues from the saved position.

The current game is saved locally in `.local/current-game.json`. Restarting the server restores the game paused so you can resume it.

## Connection

Your configured API key is stored only in the local `.env` file, which is excluded by `.gitignore`. The browser never receives it. Edit `.env` and restart the server to change the endpoint, model names, reasoning effort, or port. `.env.example` documents the settings without a key.

The app listens on `127.0.0.1` and runs on your own computer.

All match API routes require `Authorization: Bearer <viewer-access-token>`, including state, settings, controls, PGN downloads, model checks, event streaming, and engine evaluation. `/api/health` is the only public API route and returns no match or provider data. The viewer uses authenticated fetch requests, including its live event stream and PGN export; it does not use cookies or put the token in query strings.

The current private viewer link is also saved in the owner-only `.local/viewer-access.json` file with permissions `0600`, which the macOS launcher reads after checking the local origin and configured port. `.local` is excluded from version control. Keep this link and file private: the viewer token grants access to the local match and its controls. This token is separate from `OPENAI_API_KEY`; the provider key remains on the server.

## Stockfish

The evaluator runs your locally installed Stockfish executable. The macOS installer downloads the latest stable official release, verifies the release asset's SHA-256 checksum, and keeps the downloaded license and source files. The development installation was verified with **Stockfish 19**. To install or update on macOS:

```sh
npm run setup:engine
```

Restart the app after updating the engine; the saved match will restore paused. `STOCKFISH_PATH` can point to a different locally installed engine. Stockfish is a separate UCI subprocess, and its scores and suggested moves are not sent to either LLM. Evaluations describe the selected position; they do not reconstruct repetition history from the full game. See [engine/README.md](engine/README.md) for release and license information.

Downloaded Stockfish binaries, archives, and source files are local installation artifacts and are not committed to this repository.

## Verification

```sh
npm test
```

Tests cover move validation, retries, game results, cancellation, persistence, game controls, Stockfish score and mate handling, legal best lines, simultaneous viewers, and isolation from the LLM players. Real Stockfish integration runs when the local engine is installed. Live API and browser checks are performed separately.

## License

Copyright © 2026 Jas-Jas-Yuan-debug and contributors.

The original application code is licensed under the **GNU Affero General Public License version 3 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full terms, including source requirements for modified versions used over a network. The software is provided without warranty.

Third-party components retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for `chess.js`, Undici, and the separately installed Stockfish engine.
