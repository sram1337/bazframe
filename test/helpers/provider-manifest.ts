import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface ProviderManifestRecord {
  root: string;
  path: string;
  type: 'missing' | 'file' | 'directory' | 'symlink' | 'other';
  contentSha256: string | null;
}

export interface MeasuredProviderOperation<T> {
  providerBefore: ProviderManifestRecord[];
  providerAfter: ProviderManifestRecord[];
  ownedBefore: ProviderManifestRecord[];
  ownedAfter: ProviderManifestRecord[];
  outcome: { ok: true; value: T } | { ok: false; error: unknown };
}

/**
 * Captures owned state first, then the provider manifest immediately around one
 * measured operation, and only then captures owned state again.
 */
export async function measureProviderOperation<T>(
  providerRoots: readonly string[],
  ownedRoots: readonly string[],
  operation: () => Promise<T> | T
): Promise<MeasuredProviderOperation<T>> {
  const ownedBefore = await captureProviderManifest(ownedRoots);
  const providerBefore = await captureProviderManifest(providerRoots);
  let outcome: MeasuredProviderOperation<T>['outcome'];
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const providerAfter = await captureProviderManifest(providerRoots);
  const ownedAfter = await captureProviderManifest(ownedRoots);
  return { providerBefore, providerAfter, ownedBefore, ownedAfter, outcome };
}

export async function captureProviderManifest(
  roots: readonly string[]
): Promise<ProviderManifestRecord[]> {
  const records: ProviderManifestRecord[] = [];
  for (const root of [...roots].sort()) await captureRoot(root, records);
  return records.sort((left, right) => left.root.localeCompare(right.root)
    || left.path.localeCompare(right.path));
}

async function captureRoot(root: string, records: ProviderManifestRecord[]): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      records.push({ root, path: '.', type: 'missing', contentSha256: null });
      return;
    }
    throw error;
  }
  await captureEntry(root, '.', metadata, records);
}

async function captureEntry(
  root: string,
  relativePath: string,
  metadata: Awaited<ReturnType<typeof lstat>>,
  records: ProviderManifestRecord[]
): Promise<void> {
  const absolute = relativePath === '.' ? root : join(root, ...relativePath.split('/'));
  if (metadata.isSymbolicLink()) {
    records.push({
      root,
      path: relativePath,
      type: 'symlink',
      contentSha256: sha256(Buffer.from(await readlink(absolute)))
    });
    return;
  }
  if (metadata.isFile()) {
    records.push({
      root,
      path: relativePath,
      type: 'file',
      contentSha256: sha256(await readFile(absolute))
    });
    return;
  }
  if (metadata.isDirectory()) {
    records.push({ root, path: relativePath, type: 'directory', contentSha256: null });
    for (const name of (await readdir(absolute)).sort()) {
      const childPath = relativePath === '.' ? name : `${relativePath}/${name}`;
      await captureEntry(root, childPath, await lstat(join(absolute, name)), records);
    }
    return;
  }
  records.push({ root, path: relativePath, type: 'other', contentSha256: null });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
