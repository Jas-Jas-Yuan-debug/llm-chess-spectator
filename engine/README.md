# Stockfish evaluator

The local evaluator uses the official **Stockfish 19** stable release, published on September 5, 2026. It runs as a separate UCI subprocess; the LLM players do not receive engine scores or suggested moves.

- Release: https://github.com/official-stockfish/Stockfish/releases/tag/sf_19
- Official source: https://github.com/official-stockfish/Stockfish/tree/sf_19
- macOS universal asset: `stockfish-macos-universal.tar.gz`
- Asset SHA-256: `a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77`
- Executable: `engine/stockfish/stockfish`

Stockfish is GPLv3 software. The official download's license and source notices are retained in `engine/stockfish/`. The downloaded binaries are ignored by Git. Keep those license files and provide the corresponding source if you redistribute the binary.
