import { mkdir, mkdtemp, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'darwin') throw new Error('The automatic installer supports macOS. Install official Stockfish and configure STOCKFISH_PATH on other systems.');

const metadata = await fetch('https://api.github.com/repos/official-stockfish/Stockfish/releases/latest', {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Chess-Spectator' },
  signal: AbortSignal.timeout(30_000),
});
if (!metadata.ok) throw new Error(`Could not retrieve the latest official release: HTTP ${metadata.status}`);
const release = await metadata.json();
const asset = release.assets?.find(item => item.name === 'stockfish-macos-universal.tar.gz');
if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error('The official macOS asset or its SHA-256 digest is unavailable.');
const url = new URL(asset.browser_download_url);
if (url.hostname !== 'github.com' || !url.pathname.startsWith('/official-stockfish/Stockfish/releases/download/')) throw new Error('Unexpected Stockfish asset source.');

console.log(`Downloading ${release.name} from the official release...`);
const download = await fetch(url, { signal: AbortSignal.timeout(180_000) });
if (!download.ok) throw new Error(`Stockfish download failed: HTTP ${download.status}`);
const bytes = Buffer.from(await download.arrayBuffer());
const digest = createHash('sha256').update(bytes).digest('hex');
if (`sha256:${digest}` !== asset.digest) throw new Error('Stockfish SHA-256 verification failed.');

const temporary = await mkdtemp(join(tmpdir(), 'chess-stockfish-'));
try {
  const archive = join(temporary, 'stockfish.tar.gz');
  await writeFile(archive, bytes);
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (files.some(file => !file.startsWith('stockfish/') || file.split('/').includes('..'))) throw new Error('Unexpected paths in the official archive.');
  await mkdir(join(root, 'engine'), { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', join(root, 'engine')]);
  const link = join(root, 'engine', 'stockfish', 'stockfish');
  try { await unlink(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await symlink('stockfish-macos-universal', link);
  await writeFile(join(root, 'engine', 'installed-release.json'), JSON.stringify({
    name: release.name, tag: release.tag_name, source: release.html_url,
    asset: asset.name, sha256: digest, installedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  console.log(`${release.name} installed and checksum verified.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
