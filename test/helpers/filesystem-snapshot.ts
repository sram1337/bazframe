import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';

export type SnapshotEntry =
  | { path: string; kind: 'directory'; mode: number }
  | { path: string; kind: 'file'; mode: number; size: number; sha256: string }
  | { path: string; kind: 'symlink'; mode: number; target: string };

export async function snapshotFilesystem(root: string): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  await visit(root, root, entries);
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function visit(root: string, current: string, entries: SnapshotEntry[]): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name);
    const path = relative(root, absolutePath).split('\\').join('/');
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      entries.push({ path, kind: 'symlink', mode: metadata.mode, target: await readlink(absolutePath) });
    } else if (metadata.isDirectory()) {
      entries.push({ path, kind: 'directory', mode: metadata.mode });
      await visit(root, absolutePath, entries);
    } else {
      const contents = await readFile(absolutePath);
      entries.push({
        path,
        kind: 'file',
        mode: metadata.mode,
        size: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex')
      });
    }
  }
}
