import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

export async function createTempDirectory(prefix = 'bazframe-2-test-'): Promise<TempDirectory> {
  const root = await mkdtemp(join(tmpdir(), prefix));
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
    cleanup() {
      return rm(root, { recursive: true, force: true });
    }
  };
}
