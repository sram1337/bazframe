import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TempDirectory {
  root: string;
  path: (...segments: string[]) => string;
  mkdir: (relativePath: string) => Promise<string>;
  write: (relativePath: string, contents: string | Uint8Array) => Promise<string>;
  readText: (relativePath: string) => Promise<string>;
  initGit: (relativePath?: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

async function makeWritable(path: string): Promise<void> {
  let metadata; try { metadata = await lstat(path); } catch { return; }
  if (metadata.isSymbolicLink()) return;
  await chmod(path, metadata.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (metadata.isDirectory()) for (const name of await readdir(path)) await makeWritable(join(path, name));
}

export async function createTempDirectory(prefix = 'bazframe-2-test-'): Promise<TempDirectory> {
  // Keep Unix test homes comfortably below sockaddr_un limits; descriptive
  // caller prefixes are diagnostics only and must not invalidate lock tests.
  const effectivePrefix = (process.platform === 'darwin' || process.platform === 'linux')
    && !prefix.startsWith('/') ? 'bzft-' : prefix;
  const root = await mkdtemp(effectivePrefix.startsWith('/')
    ? effectivePrefix
    : join(process.platform === 'darwin' ? '/tmp' : tmpdir(), effectivePrefix));
  return {
    root,
    path: (...segments) => join(root, ...segments),
    async mkdir(relativePath) {
      const path = join(root, relativePath);
      await mkdir(path, { recursive: true });
      return path;
    },
    async write(relativePath, contents) {
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
      return path;
    },
    readText(relativePath) {
      return readFile(join(root, relativePath), 'utf8');
    },
    async initGit(relativePath = '.') {
      const path = join(root, relativePath);
      await mkdir(path, { recursive: true });
      await execFileAsync('git', ['init', '--quiet'], { cwd: path });
      return path;
    },
    async cleanup() {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  };
}
