import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, readlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';

const FILE_HASH_BUFFER_BYTES = 64 * 1024;

export interface PhysicalProfileDirectoryIdentity {
  device: string;
  inode: string;
}

export interface ProfileRemovalIdentity {
  schemaVersion: 1;
  directory: PhysicalProfileDirectoryIdentity;
  fingerprint: string;
}

interface RemovalNodeMetadata {
  kind:
    | 'directory'
    | 'file'
    | 'symlink'
    | 'block-device'
    | 'character-device'
    | 'fifo'
    | 'socket'
    | 'other';
  device: string;
  inode: string;
  mode: string;
  linkCount: string;
  userId: string;
  groupId: string;
  specialDevice: string;
  size: string;
  modifiedNanoseconds: string;
  changedNanoseconds: string;
  createdNanoseconds: string;
  contentHash?: string;
  target?: string;
}

interface RemovalEntryMetadata {
  name: string;
  node: RemovalNodeMetadata;
  entries?: RemovalEntryMetadata[];
}

interface RemovalSnapshotMetadata {
  directory: RemovalNodeMetadata;
  entries: RemovalEntryMetadata[];
}

/**
 * Captures all profile-owned physical content without resolving symlinks.
 * Every symlink is a leaf represented by its own metadata and stored link text.
 */
export async function captureProfileRemovalIdentity(
  directory: string
): Promise<ProfileRemovalIdentity> {
  const directoryMetadata = await lstat(directory, { bigint: true });
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new BazframeError(
      'PROFILE_NOT_PHYSICAL',
      `Profile lifecycle requires a physical directory: ${directory}`
    );
  }

  const snapshot: RemovalSnapshotMetadata = {
    directory: nodeMetadata(directoryMetadata),
    entries: await captureDirectoryEntries(directory, directoryMetadata)
  };

  return {
    schemaVersion: 1,
    directory: {
      device: directoryMetadata.dev.toString(),
      inode: directoryMetadata.ino.toString()
    },
    fingerprint: createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex')
  };
}

async function captureDirectoryEntries(
  directory: string,
  expectedMetadata: BigIntStats
): Promise<RemovalEntryMetadata[]> {
  const names = (await readdir(directory)).sort(lexicalCompare);
  const entries: RemovalEntryMetadata[] = [];

  for (const name of names) {
    const path = join(directory, name);
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      await assertNodeUnchanged(path, metadata);
      entries.push({
        name,
        node: nodeMetadata(metadata, { target })
      });
      continue;
    }
    if (metadata.isDirectory()) {
      entries.push({
        name,
        node: nodeMetadata(metadata),
        entries: await captureDirectoryEntries(path, metadata)
      });
      continue;
    }
    if (metadata.isFile()) {
      entries.push({
        name,
        node: nodeMetadata(metadata, {
          contentHash: await hashRegularFile(path, metadata)
        })
      });
      continue;
    }
    entries.push({ name, node: nodeMetadata(metadata) });
  }

  await assertNodeUnchanged(directory, expectedMetadata);
  return entries;
}

async function hashRegularFile(path: string, expectedMetadata: BigIntStats): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedMetadata = await handle.stat({ bigint: true });
    assertSameNode(path, expectedMetadata, openedMetadata);
    if (!openedMetadata.isFile()) throw changedDuringCapture(path);

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }

    const finalMetadata = await handle.stat({ bigint: true });
    assertSameNode(path, openedMetadata, finalMetadata);
    return hash.digest('hex');
  } finally {
    await handle?.close();
  }
}

async function assertNodeUnchanged(path: string, expectedMetadata: BigIntStats): Promise<void> {
  const currentMetadata = await lstat(path, { bigint: true });
  assertSameNode(path, expectedMetadata, currentMetadata);
}

function assertSameNode(path: string, left: BigIntStats, right: BigIntStats): void {
  if (JSON.stringify(nodeMetadata(left)) !== JSON.stringify(nodeMetadata(right))) {
    throw changedDuringCapture(path);
  }
}

function changedDuringCapture(path: string): BazframeError {
  return new BazframeError(
    'PROFILE_REMOVAL_IDENTITY_UNSTABLE',
    `Profile content changed while removal identity was being captured: ${path}`
  );
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nodeMetadata(
  metadata: BigIntStats,
  identity: { contentHash?: string; target?: string } = {}
): RemovalNodeMetadata {
  return {
    kind: metadata.isDirectory()
      ? 'directory'
      : metadata.isFile()
        ? 'file'
        : metadata.isSymbolicLink()
          ? 'symlink'
          : metadata.isBlockDevice()
            ? 'block-device'
            : metadata.isCharacterDevice()
              ? 'character-device'
              : metadata.isFIFO()
                ? 'fifo'
                : metadata.isSocket()
                  ? 'socket'
                  : 'other',
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    linkCount: metadata.nlink.toString(),
    userId: metadata.uid.toString(),
    groupId: metadata.gid.toString(),
    specialDevice: metadata.rdev.toString(),
    size: metadata.size.toString(),
    modifiedNanoseconds: metadata.mtimeNs.toString(),
    changedNanoseconds: metadata.ctimeNs.toString(),
    createdNanoseconds: metadata.birthtimeNs.toString(),
    ...(identity.contentHash === undefined ? {} : { contentHash: identity.contentHash }),
    ...(identity.target === undefined ? {} : { target: identity.target })
  };
}

export function staleProfileRemovalAuthorization(
  profileId: string,
  cause?: unknown
): BazframeError {
  const suffix = cause === undefined || errorCode(cause) === undefined
    ? ''
    : ` (${errorCode(cause)})`;
  return new BazframeError(
    'PROFILE_REMOVE_AUTHORIZATION_STALE',
    `Profile ${JSON.stringify(profileId)} changed after recursive removal was disclosed${suffix}. Refresh and confirm the current profile again.`,
    cause === undefined ? undefined : { cause }
  );
}
