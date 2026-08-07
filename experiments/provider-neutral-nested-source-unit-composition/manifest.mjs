import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function filesystemType(stats) {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isBlockDevice()) return 'block-device';
  if (stats.isCharacterDevice()) return 'character-device';
  if (stats.isFIFO()) return 'fifo';
  if (stats.isSocket()) return 'socket';
  return 'unknown';
}

/**
 * Capture a complete, non-link-following manifest. Directories and special
 * entries have no portable byte content, so their sha256 field is null.
 */
export async function captureManifest(root) {
  const entries = [];

  async function visit(absolutePath, relativePath) {
    const stats = await lstat(absolutePath);
    const type = filesystemType(stats);
    let sha256 = null;
    if (type === 'file') {
      sha256 = hash(await readFile(absolutePath));
    } else if (type === 'symlink') {
      sha256 = hash(await readlink(absolutePath, { encoding: 'buffer' }));
    }

    entries.push({ path: relativePath, type, size: stats.size, sha256 });
    if (type !== 'directory') return;

    const names = (await readdir(absolutePath)).sort(compareNames);
    for (const name of names) {
      const childRelativePath = relativePath === '.' ? name : `${relativePath}/${name}`;
      await visit(join(absolutePath, name), childRelativePath);
    }
  }

  await visit(root, '.');
  return entries;
}

export function firstManifestDifference(before, after) {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) {
      return { index, before: before[index] ?? null, after: after[index] ?? null };
    }
  }
  return null;
}
