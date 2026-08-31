import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';

export interface ReadOnlyPathAnchor {
  path: string;
  ancestor: {
    path: string;
    handle: FileHandle;
    device: bigint;
    inode: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  firstAbsentPath?: string;
}

/** Holds the target directory itself, or the nearest existing canonical parent of an absent target. */
export async function holdReadOnlyPathAnchor(enteredPath: string): Promise<ReadOnlyPathAnchor> {
  const absolute = resolve(enteredPath);
  const missingSegments: string[] = [];
  let current = absolute;
  let existingMetadata;
  while (true) {
    try {
      existingMetadata = await lstat(current, { bigint: true });
      break;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw invalidAnchor(absolute, error);
      const parent = dirname(current);
      if (parent === current) throw invalidAnchor(absolute, error);
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
  if (missingSegments.length === 0 && (existingMetadata.isSymbolicLink() || !existingMetadata.isDirectory())) {
    throw invalidAnchor(absolute);
  }

  let canonicalAncestor: string;
  try { canonicalAncestor = await realpath(current); }
  catch (error) { throw invalidAnchor(absolute, error); }
  let canonicalMetadata;
  try { canonicalMetadata = await lstat(canonicalAncestor, { bigint: true }); }
  catch (error) { throw invalidAnchor(absolute, error); }
  if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isDirectory()) throw invalidAnchor(absolute);

  let handle: FileHandle | undefined;
  try {
    handle = await open(canonicalAncestor, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()
      || opened.dev !== canonicalMetadata.dev
      || opened.ino !== canonicalMetadata.ino
      || opened.mtimeNs !== canonicalMetadata.mtimeNs
      || opened.ctimeNs !== canonicalMetadata.ctimeNs) {
      throw changedAnchor(absolute);
    }
    const firstAbsentPath = missingSegments.length === 0
      ? undefined
      : join(canonicalAncestor, missingSegments[0]!);
    const anchor: ReadOnlyPathAnchor = {
      path: missingSegments.reduce((path, segment) => join(path, segment), canonicalAncestor),
      ancestor: {
        path: canonicalAncestor,
        handle,
        device: opened.dev,
        inode: opened.ino,
        mtimeNs: opened.mtimeNs,
        ctimeNs: opened.ctimeNs
      },
      ...(firstAbsentPath === undefined ? {} : { firstAbsentPath })
    };
    handle = undefined;
    await assertReadOnlyPathAnchor(anchor);
    return anchor;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

export async function assertReadOnlyPathAnchor(anchor: ReadOnlyPathAnchor): Promise<void> {
  const [opened, current] = await Promise.all([
    anchor.ancestor.handle.stat({ bigint: true }),
    lstat(anchor.ancestor.path, { bigint: true })
  ]);
  if (!opened.isDirectory()
    || current.isSymbolicLink()
    || !current.isDirectory()
    || opened.dev !== anchor.ancestor.device
    || opened.ino !== anchor.ancestor.inode
    || current.dev !== anchor.ancestor.device
    || current.ino !== anchor.ancestor.inode
    || opened.mtimeNs !== anchor.ancestor.mtimeNs
    || opened.ctimeNs !== anchor.ancestor.ctimeNs
    || current.mtimeNs !== anchor.ancestor.mtimeNs
    || current.ctimeNs !== anchor.ancestor.ctimeNs) {
    throw changedAnchor(anchor.path);
  }
  if (anchor.firstAbsentPath !== undefined) {
    try { await lstat(anchor.firstAbsentPath); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw changedAnchor(anchor.path, error);
    }
    throw changedAnchor(anchor.path);
  }
}

export async function closeReadOnlyPathAnchor(anchor: ReadOnlyPathAnchor): Promise<void> {
  await anchor.ancestor.handle.close();
}

function invalidAnchor(path: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'READ_ONLY_PATH_INVALID',
    `Read-only target must be an existing physical directory or have a canonical physical parent: ${path}`,
    cause === undefined ? {} : { cause }
  );
}

function changedAnchor(path: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'READ_ONLY_PATH_CHANGED',
    `Read-only target ancestry changed during inspection: ${path}`,
    cause === undefined ? {} : { cause }
  );
}
