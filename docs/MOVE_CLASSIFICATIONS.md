# Move classifications

The spectator shows an icon beside each reviewed move, on its destination square, and in the journal's Engine review panel. The model's move explanation remains separate. Selecting an older move prioritizes its review while the live match continues.

The labels follow the familiar categories described in [Chess.com's move classification guide](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc). The icons are original artwork. These are this application's Stockfish estimates, with transparent local rules; they do not reproduce Chess.com's proprietary Expected Points Model or player-rating adjustments.

## Engine comparison

The browser requests evaluations of the positions before and after a legal move from the existing authenticated Stockfish endpoint. Scores must be ready, match the exact positions, and come from the same engine version. White-perspective scores are converted to the mover's perspective, so the same rules apply to both colors.

When Stockfish supplies a valid win/draw/loss distribution, expected points are `(win + draw / 2) / 1000`. Without WDL, the fallback is the local approximation `1 / (1 + exp(-cp / 300))`. Forced mate maps to 1 for the winning side and 0 for the losing side, including an already checkmated position. The loss is the nonnegative difference between expected points before and after the move. Separate searches can disagree slightly; matching the engine's first choice still qualifies as Best.

| Label | Icon | Rule |
| --- | --- | --- |
| Book | Book | The exact legal position and move occur in the bundled opening data. |
| Brilliant | `!!` | At most 2 percentage points lost, no losing outcome afterward, and the engine's first two replies show a non-pawn sacrifice that remains at least 2 material points down. Excludes positions already above 90% expected points. |
| Great | `!` | The engine's best move preserves a turning point created by the opponent's preceding error: expected points rise by at least 15 percentage points from a position at or below 55%, and the gain survives the move. |
| Best | Star | Matches Stockfish's first choice before the move, or delivers checkmate. |
| Excellent | Check | At most 2 percentage points lost. |
| Good | Thumb | More than 2 and at most 5 percentage points lost. |
| Inaccuracy | `?!` | More than 5 and at most 10 percentage points lost. |
| Mistake | `?` | More than 10 and at most 20 percentage points lost. |
| Blunder | `??` | More than 20 percentage points lost. |
| Miss | Target | The opponent's preceding move raises expected points by at least 10 percentage points to at least 65%, but this non-best reply drops them to at most 55%. |

Book takes precedence. Brilliant, Great, and Miss are contextual labels checked before the ordinary loss bands. Great and Miss require a verified evaluation of the position before the opponent's preceding move. Brilliant inspects legal captures in the principal variation and rejects immediate equal trades or recaptures that restore the material.

The evaluator uses a single principal variation. It cannot prove that a Great move is the only good move, and the sacrifice rule intentionally recognizes only a narrow set of Brilliant candidates. Ratings can change with search depth, engine settings, or engine versions. Missing, mismatched, failed, or incomplete evaluations remain unrated rather than receiving an invented label.

## Opening data

The offline book is derived from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings), pinned to commit `a6189a30dc273ccb21fc2536a9a2fefd5592a67a`. The generated module records the revision and SHA-256 hashes of all five upstream TSV files. The source data is dedicated to the public domain under CC0-1.0; the dedication is retained in `public/opening-book.LICENSE.txt`.

Each opening line is legally replayed with chess.js. Lookup keys contain the position's first four FEN fields and the exact UCI move. A move number alone never qualifies a move as Book. Named openings cover only the transitions present in the dataset, including transpositions that reach the same position.

Regenerate or verify the book with:

```sh
node scripts/build-opening-book.mjs
node scripts/build-opening-book.mjs --check
node scripts/build-opening-book.mjs --check --source-dir /path/to/pinned-tsv-files
```

## Live match preservation

Review requests use the existing read-only evaluation endpoint and never invoke match controls or the model API. Stockfish searches up to depth 30 or 10 seconds per position, whichever comes first. Background evaluation is serial, with bounded polling and caches. Its 45-second per-position review deadline allows time for the longer search and queued work. The displayed board's evaluation gets priority. Review work is canceled when the match changes or viewer access is lost. Engine errors offer a manual retry instead of an endless request loop.

Refreshing the page loads the new static assets and reconnects to the saved match. No server restart or match reset is needed.
