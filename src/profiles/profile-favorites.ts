import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import { assertSafeProfileId, isSafeProfileId } from './profile-id.js';
import { loadProfile, profileDirectory } from './profile-store.js';

export const PROFILE_FAVORITES_FILE = 'profile-favorites.json';
export const MAX_PROFILE_FAVORITES_BYTES = 64 * 1024;

export interface ProfileFavoritesState {
  schemaVersion: 1;
  favorites: string[];
}

export type ProfileFavoriteAction = 'favorited' | 'unfavorited';

export interface ProfileFavoriteResult {
  action: ProfileFavoriteAction;
  profileId: string;
  favorites: string[];
}

export interface ProfileFavoriteDependencies {
  beforeTargetRevalidation?: () => Promise<void>;
  directorySync?: (path: string) => Promise<void>;
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

export function profileFavoritesPath(bazframeHome: string): string {
  return join(bazframeHome, PROFILE_FAVORITES_FILE);
}

export function decodeProfileFavorites(
  text: string,
  source = 'profile favorites state'
): ProfileFavoritesState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalidProfileFavorites(source, 'invalid JSON', error);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProfileFavorites(source, 'state must be a JSON object');
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort(lexicalCompare);
  if (keys.length !== 2 || keys[0] !== 'favorites' || keys[1] !== 'schemaVersion') {
    throw invalidProfileFavorites(source, 'state must contain exactly the schema-v1 fields');
  }
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.favorites)) {
    throw invalidProfileFavorites(source, 'state must be an exact schema-v1 favorites record');
  }

  const favorites = candidate.favorites;
  if (!favorites.every((profileId) => typeof profileId === 'string' && isSafeProfileId(profileId))) {
    throw invalidProfileFavorites(source, 'favorites must contain only safe profile IDs');
  }
  if (new Set(favorites).size !== favorites.length) {
    throw invalidProfileFavorites(source, 'favorites must be unique');
  }
  if (favorites.some((profileId, index) => (
    index > 0 && lexicalCompare(favorites[index - 1] as string, profileId) >= 0
  ))) {
    throw invalidProfileFavorites(source, 'favorites must be in strict lexical order');
  }
  return { schemaVersion: 1, favorites: [...favorites] };
}

export function encodeProfileFavorites(profileIds: readonly string[]): string {
  for (const profileId of profileIds) assertSafeProfileId(profileId);
  const favorites = [...new Set(profileIds)].sort(lexicalCompare);
  const encoded = `${JSON.stringify({ schemaVersion: 1, favorites }, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROFILE_FAVORITES_BYTES) {
    throw new BazframeError(
      'PROFILE_FAVORITES_TOO_LARGE',
      `Profile favorites state exceeds ${MAX_PROFILE_FAVORITES_BYTES} bytes.`
    );
  }
  return encoded;
}

export async function readProfileFavorites(bazframeHome: string): Promise<ProfileFavoritesState> {
  const path = profileFavoritesPath(bazframeHome);
  let homeHandle: FileHandle | undefined;
  let handle: FileHandle | undefined;
  try {
    let homeMetadata;
    try {
      homeMetadata = await lstat(bazframeHome, { bigint: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { schemaVersion: 1, favorites: [] };
      throw error;
    }
    if (homeMetadata.isSymbolicLink() || !homeMetadata.isDirectory()) {
      throw invalidProfileFavorites(path, 'state namespace must be a physical directory');
    }
    const homeIdentity = identity(homeMetadata);
    homeHandle = await open(
      bazframeHome,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    await assertDirectoryStable(bazframeHome, homeHandle, homeIdentity, path);

    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        await assertDirectoryStable(bazframeHome, homeHandle, homeIdentity, path);
        return { schemaVersion: 1, favorites: [] };
      }
      throw error;
    }

    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_PROFILE_FAVORITES_BYTES)) {
      throw invalidProfileFavorites(
        path,
        `state must be a physical file no larger than ${MAX_PROFILE_FAVORITES_BYTES} bytes`
      );
    }
    const bytes = await readAtMost(handle, MAX_PROFILE_FAVORITES_BYTES + 1);
    const after = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    await assertDirectoryStable(bazframeHome, homeHandle, homeIdentity, path);
    if (
      bytes.byteLength > MAX_PROFILE_FAVORITES_BYTES
      || !after.isFile()
      || after.size > BigInt(MAX_PROFILE_FAVORITES_BYTES)
      || pathMetadata.isSymbolicLink()
      || !pathMetadata.isFile()
      || !sameIdentity(identity(before), identity(after))
      || !sameIdentity(identity(after), identity(pathMetadata))
    ) {
      throw invalidProfileFavorites(path, 'state identity or size changed while reading');
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw invalidProfileFavorites(path, 'state is not valid UTF-8', error);
    }
    if (text.includes('\0')) {
      throw invalidProfileFavorites(path, 'state contains a NUL byte');
    }
    return decodeProfileFavorites(text, path);
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    if (errorCode(error) === 'ELOOP') {
      throw invalidProfileFavorites(path, 'state and its namespace must be physical');
    }
    throw profileFavoritesReadError(path, error);
  } finally {
    await handle?.close().catch(() => undefined);
    await homeHandle?.close().catch(() => undefined);
  }
}

export async function toggleProfileFavorite(
  bazframeHome: string,
  profileId: string,
  dependencies: ProfileFavoriteDependencies = {}
): Promise<ProfileFavoriteResult> {
  assertSafeProfileId(profileId);
  const statePath = profileFavoritesPath(bazframeHome);
  return withStateLock(
    join(bazframeHome, 'locks', 'state.lock'),
    { command: 'bazframe tui profile favorite', target: statePath },
    async () => {
      const directory = profileDirectory(bazframeHome, profileId);
      const initial = await physicalProfileIdentity(directory, profileId);
      await loadProfile(bazframeHome, profileId);
      const state = await readProfileFavorites(bazframeHome);
      const favorites = new Set(state.favorites);
      const action: ProfileFavoriteAction = favorites.delete(profileId)
        ? 'unfavorited'
        : (favorites.add(profileId), 'favorited');
      await dependencies.beforeTargetRevalidation?.();
      const current = await physicalProfileIdentity(directory, profileId);
      if (initial.device !== current.device || initial.inode !== current.inode) {
        throw new BazframeError(
          'PROFILE_FAVORITE_TARGET_STALE',
          `Profile ${JSON.stringify(profileId)} changed before its favorite state could be updated. Refresh and try again.`
        );
      }
      const sorted = [...favorites].sort(lexicalCompare);
      await writeProfileFavoritesUnlocked(bazframeHome, sorted, dependencies);
      return { action, profileId, favorites: sorted };
    },
    { managedRoot: bazframeHome }
  );
}

/** Read optional preference state for lifecycle cleanup without blocking lifecycle on malformed state. */
export async function readValidProfileFavoritesForLifecycle(
  bazframeHome: string
): Promise<ProfileFavoritesState | undefined> {
  try {
    return await readProfileFavorites(bazframeHome);
  } catch (error) {
    if (
      error instanceof BazframeError
      && (error.code === 'PROFILE_FAVORITES_INVALID'
        || error.code === 'PROFILE_FAVORITES_READ_FAILED')
    ) return undefined;
    throw error;
  }
}

/** Caller must hold the shared global state lock. */
export function writeProfileFavoritesUnlocked(
  bazframeHome: string,
  profileIds: readonly string[],
  dependencies: Pick<ProfileFavoriteDependencies, 'directorySync'> = {}
): Promise<void> {
  return writeFileAtomic(
    profileFavoritesPath(bazframeHome),
    encodeProfileFavorites(profileIds),
    {
      managedRoot: bazframeHome,
      commitOnRename: true,
      ...(dependencies.directorySync === undefined
        ? {}
        : { directorySync: dependencies.directorySync })
    }
  );
}

async function physicalProfileIdentity(
  directory: string,
  profileId: string
): Promise<{ device: bigint; inode: bigint }> {
  let metadata;
  try {
    metadata = await lstat(directory, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new BazframeError(
        'PROFILE_NOT_FOUND',
        `Profile ${JSON.stringify(profileId)} does not exist at ${directory}.`
      );
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError(
      'PROFILE_NOT_PHYSICAL',
      `Profile favorite changes require a physical profile directory: ${directory}`
    );
  }
  return { device: metadata.dev, inode: metadata.ino };
}

async function readAtMost(handle: FileHandle, byteLimit: number): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(byteLimit);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      null
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function assertDirectoryStable(
  path: string,
  handle: FileHandle,
  expected: FileIdentity,
  statePath: string
): Promise<void> {
  const [opened, current] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true })
  ]);
  if (
    !opened.isDirectory()
    || current.isSymbolicLink()
    || !current.isDirectory()
    || !sameIdentity(identity(opened), expected)
    || !sameIdentity(identity(current), expected)
  ) {
    throw invalidProfileFavorites(statePath, 'state namespace identity changed while reading');
  }
}

function identity(metadata: { dev: bigint; ino: bigint }): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function invalidProfileFavorites(source: string, detail: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'PROFILE_FAVORITES_INVALID',
    `${source} is invalid: ${detail}.`,
    cause === undefined ? undefined : { cause }
  );
}

function profileFavoritesReadError(path: string, error: unknown): BazframeError {
  const code = errorCode(error);
  return new BazframeError(
    'PROFILE_FAVORITES_READ_FAILED',
    `Could not read profile favorites state: ${path}${code === undefined ? '' : ` (${code})`}`,
    { cause: error }
  );
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
