# Third-party notices

The original Chess Spectator application code is licensed under `AGPL-3.0-only`; see [LICENSE](LICENSE). The following components retain their upstream copyright notices and licenses.

## chess.js 1.4.0

- Project: [jhlywa/chess.js](https://github.com/jhlywa/chess.js)
- License: BSD 2-Clause (`BSD-2-Clause`)
- Installed license: `node_modules/chess.js/LICENSE`

The browser also includes the unbundled ESM build in `public/vendor/chess.js`, with its license retained in `public/vendor/chess.js.LICENSE.txt`.

The license supplied with the installed dependency states:

```text
Copyright (c) 2025, Jeff Hlywa (jhlywa@gmail.com)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## Undici 8.11.2

- Project: [nodejs/undici](https://github.com/nodejs/undici)
- License: MIT (`MIT`)
- Installed license: `node_modules/undici/LICENSE`

The license supplied with the installed dependency states:

```text
MIT License

Copyright (c) Matteo Collina and Undici contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Stockfish

- Project: [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish)
- Verified development release: [Stockfish 19, tag `sf_19`](https://github.com/official-stockfish/Stockfish/releases/tag/sf_19)
- Corresponding source: [Stockfish source at `sf_19`](https://github.com/official-stockfish/Stockfish/tree/sf_19)
- License: GNU General Public License version 3 or later (`GPL-3.0-or-later`), as stated in the verified source headers
- Copyright © 2004–2026 The Stockfish developers; see the upstream `AUTHORS` file

Stockfish runs as a separate executable over the UCI protocol. Its binary and source are not committed to this repository. The macOS setup script downloads an official release archive, verifies its checksum, and retains the archive's `Copying.txt`, `AUTHORS`, source tree, and other notices under `engine/stockfish/`. The installed release and source URL are recorded in `engine/installed-release.json`.

When redistributing a Stockfish binary, retain its copyright and license notices and satisfy the corresponding-source requirements in its GPL license. The installed `engine/stockfish/Copying.txt` contains the full terms. For an independently installed engine or a different release, consult that installation's license and corresponding source.

## Chess opening names

- Project: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
- License: CC0-1.0 Public Domain Dedication
- Data: `public/opening-book.js`; upstream dedication: `public/opening-book.LICENSE.txt`
- Build script: `scripts/build-opening-book.mjs`, with a pinned source revision recorded in its source and in the generated dataset

The opening transition table is derived from the upstream factual opening sequences. This data retains its public-domain dedication. The application's classification code and original icons remain licensed under AGPL-3.0-only.
