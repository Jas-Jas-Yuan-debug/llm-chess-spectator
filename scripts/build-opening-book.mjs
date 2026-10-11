// SPDX-License-Identifier: AGPL-3.0-only
// Rebuild the browser's fixed opening reference from Lichess's CC0 dataset.
import { Chess } from 'chess.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_COMMIT = 'a6189a30dc273ccb21fc2536a9a2fefd5592a67a';
export const SOURCE_REPOSITORY = 'https://github.com/lichess-org/chess-openings';
export const MAX_BOOK_PLIES = 40;
const SOURCE_FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'];
const LICENSE_FILE = 'COPYING.txt';
const SOURCE_SHA256 = Object.freeze({
  'a.tsv': '3282e4c9155289a29224f9a85fba0decb46efa35c2fa5e39662d2ac48fb0f793',
  'b.tsv': '1d5ed134ebbd87915ead5683416e37583bb3e5ae3582b4d8cb5cb4aa7ef4f623',
  'c.tsv': '45e843c7b7e79a0d04d5bda879c9bd23f5a10974488bd8615e4f4c5d0749986f',
  'd.tsv': '1cf4057a8aece94f27bb3f278ad410ee2844831a642364eeceaafa091dbcceda',
  'e.tsv': '48c6f6645b031a5937c8386839debab0e2e48837251687ba1afb6369677f8546',
  'COPYING.txt': 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
});
const MAX_TSV_BYTES = 2_000_000;
const MAX_LICENSE_BYTES = 64_000;
const MAX_ROWS = 25_000;
const MAX_TRANSITIONS = 50_000;
const MAX_PGN_CHARACTERS = 4_096;
const MAX_LINE_PLIES = 256;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, 'public', 'opening-book.js');
const licensePath = join(root, 'public', 'opening-book.LICENSE.txt');

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const positionKey = fen => fen.split(' ').slice(0, 4).join(' ');
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');

function preferredName(a, b) {
  // Names with more variation/subvariation components describe a more specific
  // named position. Prefer the shortest source line for the same specificity.
  const specificity = name => (name.match(/[:,]/g) || []).length;
  return specificity(b.name) - specificity(a.name)
    || a.moves.length - b.moves.length
    || compareText(a.name, b.name)
    || compareText(a.eco, b.eco)
    || compareText(a.pgn, b.pgn);
}

function preferredPrefix(a, b) {
  // Shared transitions retain a position's most recently completed opening name.
  // Before any named position exists, use the shortest continuation's family.
  return b.completedAt - a.completedAt
    || (a.completedAt ? preferredName(a.label, b.label) : 0)
    || a.continuation.moves.length - b.continuation.moves.length
    || preferredName(a.continuation, b.continuation);
}

export function parseOpeningTsv(text, file) {
  if (!SOURCE_FILES.includes(file)) throw new Error(`Unexpected source filename: ${file}`);
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TSV_BYTES) {
    throw new Error(`${file} exceeds the source size limit.`);
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.shift() !== 'eco\tname\tpgn') throw new Error(`${file} has an unexpected TSV header.`);
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === '' && index === lines.length - 1) continue;
    const fields = lines[index].split('\t');
    if (fields.length !== 3) throw new Error(`${file}:${index + 2} must contain exactly three fields.`);
    const [eco, name, pgn] = fields;
    if (!/^[A-E]\d{2}$/.test(eco) || eco[0].toLowerCase() !== file[0]
      || !name || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)
      || !pgn || pgn.length > MAX_PGN_CHARACTERS || /[\u0000-\u001f\u007f]/.test(pgn)) {
      throw new Error(`${file}:${index + 2} has an invalid opening record.`);
    }
    const chess = new Chess();
    try {
      chess.loadPgn(pgn, { strict: true });
    } catch {
      throw new Error(`${file}:${index + 2} contains an invalid legal move sequence.`);
    }
    const moves = chess.history({ verbose: true });
    if (!moves.length || moves.length > MAX_LINE_PLIES
      || moves[0].before !== new Chess().fen()
      || moves.some(move => !/^[a-h][1-8]$/.test(move.from) || !/^[a-h][1-8]$/.test(move.to))) {
      throw new Error(`${file}:${index + 2} has an unsupported move count.`);
    }
    rows.push({ eco, name, pgn, moves, finalPosition: positionKey(chess.fen()) });
    if (rows.length > MAX_ROWS) throw new Error(`${file} exceeds the opening record limit.`);
  }
  return rows;
}

export function buildOpeningBook(sources) {
  const rows = SOURCE_FILES.flatMap(file => parseOpeningTsv(sources[file], file));
  if (rows.length > MAX_ROWS) throw new Error('The dataset exceeds the opening record limit.');
  const namedPositions = new Map();
  for (const row of rows) {
    const previous = namedPositions.get(row.finalPosition);
    if (!previous || preferredName(row, previous) < 0) namedPositions.set(row.finalPosition, row);
  }
  const transitions = new Map();
  for (const row of rows) {
    let completedLabel;
    let completedAt = 0;
    for (const [index, move] of row.moves.slice(0, MAX_BOOK_PLIES).entries()) {
      const uci = `${move.from}${move.to}${move.promotion || ''}`;
      const key = `${positionKey(move.before)}|${uci}`;
      const exactLabel = namedPositions.get(positionKey(move.after));
      if (exactLabel) {
        completedLabel = exactLabel;
        completedAt = index + 1;
      }
      const label = completedLabel || { ...row, name: row.name.split(':')[0] };
      const candidate = { label, completedAt, continuation: row, named: Boolean(exactLabel) };
      const previous = transitions.get(key);
      if (!previous || (candidate.named && !previous.named)
        || (candidate.named === previous.named && preferredPrefix(candidate, previous) < 0)) {
        transitions.set(key, candidate);
      }
      if (transitions.size > MAX_TRANSITIONS) throw new Error('The dataset exceeds the transition limit.');
    }
  }
  const book = Object.fromEntries([...transitions.keys()].sort(compareText).map(key => {
    const { eco, name } = transitions.get(key).label;
    return [key, { eco, name }];
  }));
  const source = {
    repository: SOURCE_REPOSITORY,
    commit: SOURCE_COMMIT,
    license: 'CC0-1.0',
    openingCount: rows.length,
    transitionCount: transitions.size,
    maxPlies: MAX_BOOK_PLIES,
    files: SOURCE_FILES.map(file => ({ path: file, sha256: digest(sources[file]) })),
  };
  return { book, source };
}

export function renderOpeningBook({ book, source }) {
  return `// Generated by scripts/build-opening-book.mjs; do not edit by hand.\n`
    + `// Source: ${SOURCE_REPOSITORY}/tree/${SOURCE_COMMIT}\n`
    + '// Factual opening data: public domain / CC0-1.0. See opening-book.LICENSE.txt.\n'
    + '// Keys are the first four FEN fields, a vertical bar, and an exact legal UCI move.\n'
    + '// Labels retain completed named positions; unnamed early prefixes use the opening family.\n'
    + `export const BOOK_SOURCE = Object.freeze(${JSON.stringify(source, null, 2)});\n\n`
    + `export const OPENING_BOOK = Object.freeze(${JSON.stringify(book, null, 2)});\n`;
}

async function downloadSource(file, directory) {
  const limit = file === LICENSE_FILE ? MAX_LICENSE_BYTES : MAX_TSV_BYTES;
  const url = `https://raw.githubusercontent.com/lichess-org/chess-openings/${SOURCE_COMMIT}/${file}`;
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'llm-chess-spectator-opening-book-builder' },
  });
  if (!response.ok || !response.body) throw new Error(`${file} download failed: HTTP ${response.status}.`);
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
    await response.body.cancel();
    throw new Error(`${file} exceeds the download size limit.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`${file} exceeds the download size limit.`);
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  await writeFile(join(directory, file), text, 'utf8');
}

async function readBoundedFile(directory, file) {
  const path = join(directory, file);
  const details = await stat(path);
  const limit = file === LICENSE_FILE ? MAX_LICENSE_BYTES : MAX_TSV_BYTES;
  if (!details.isFile() || details.size > limit) throw new Error(`${file} exceeds the local source size limit.`);
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
}

async function main(args) {
  let check = false;
  let sourceDirectory;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--check' && !check) check = true;
    else if (args[index] === '--source-dir' && !sourceDirectory && args[index + 1]) {
      sourceDirectory = resolve(args[++index]);
    } else if (args[index] === '--help') {
      console.log('Usage: node scripts/build-opening-book.mjs [--check] [--source-dir DIRECTORY]');
      console.log('Without --source-dir, downloads only the pinned public upstream files.');
      console.log('--check compares outputs without changing them; --source-dir supports offline checks.');
      return;
    } else throw new Error(`Unknown or incomplete option: ${args[index]}`);
  }
  let temporary;
  try {
    if (!sourceDirectory) {
      temporary = await mkdtemp(join(tmpdir(), 'chess-opening-book-'));
      sourceDirectory = temporary;
      // Keep source downloads independent but bounded; no credentials are used.
      const downloads = await Promise.allSettled([...SOURCE_FILES, LICENSE_FILE]
        .map(file => downloadSource(file, temporary)));
      const failure = downloads.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
    const contents = await Promise.all([...SOURCE_FILES, LICENSE_FILE].map(async file =>
      [file, await readBoundedFile(sourceDirectory, file)]));
    const sources = Object.fromEntries(contents);
    for (const [file, content] of contents) {
      if (digest(content) !== SOURCE_SHA256[file]) throw new Error(`${file} does not match the pinned source SHA-256.`);
    }
    const license = sources[LICENSE_FILE];
    if (!license.includes('CC0 1.0 Universal')) throw new Error('The upstream CC0 license is missing.');
    const built = buildOpeningBook(sources);
    const rendered = renderOpeningBook(built);
    if (check) {
      const [currentBook, currentLicense] = await Promise.all([
        readFile(outputPath, 'utf8'), readFile(licensePath, 'utf8'),
      ]);
      if (currentBook !== rendered || currentLicense !== license) {
        throw new Error('Opening book outputs differ. Rebuild with the pinned source.');
      }
      console.log(`Opening book is reproducible: ${built.source.openingCount} openings, ${built.source.transitionCount} transitions.`);
    } else {
      await writeFile(outputPath, rendered, 'utf8');
      await writeFile(licensePath, license, 'utf8');
      console.log(`Generated ${built.source.transitionCount} transitions from ${built.source.openingCount} openings (${Buffer.byteLength(rendered)} bytes).`);
    }
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Opening book build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
