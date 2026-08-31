import { constants, type Dir } from 'node:fs';
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  readPhysicalInstructionSnapshot,
  samePhysicalInstructionSnapshot,
  type PhysicalInstructionSnapshot
} from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { escapeUnsafeDisplayCharacters } from '../core/safe-text.js';
import {
  decodeProfileArtifactBytes,
  type ProfileArtifact,
  type ProfileArtifactLimitPolicy
} from './profile-artifact.js';
import { profileArtifactLimitPolicy } from './profile-portability-policy.js';

export interface PhysicalArtifactDirectoryIdentity {
  path: string;
  device: bigint;
  inode: bigint;
}

export interface ProfileArtifactDirectorySnapshot {
  root: PhysicalArtifactDirectoryIdentity;
  profileDirectory: PhysicalArtifactDirectoryIdentity;
  manifestBytes: Uint8Array;
  artifact: ProfileArtifact;
  instructions: PhysicalInstructionSnapshot;
}

export function sameProfileArtifactDirectorySnapshot(
  left: ProfileArtifactDirectorySnapshot,
  right: ProfileArtifactDirectorySnapshot
): boolean {
  return sameDirectoryIdentity(left.root, right.root)
    && left.root.path === right.root.path
    && sameDirectoryIdentity(left.profileDirectory, right.profileDirectory)
    && left.profileDirectory.path === right.profileDirectory.path
    && Buffer.from(left.manifestBytes).equals(Buffer.from(right.manifestBytes))
    && samePhysicalInstructionSnapshot(left.instructions, right.instructions)
    && left.instructions.path === right.instructions.path;
}

export type ProfileArtifactCloseTarget =
  | 'manifest'
  | 'instruction'
  | 'directory-stream'
  | 'directory-handle';

export interface ProfileArtifactReadTestHooks {
  afterManifestRead?: () => void | Promise<void>;
  beforeFinalIdentityCheck?: () => void | Promise<void>;
  afterClose?: (target: ProfileArtifactCloseTarget, path: string) => void | Promise<void>;
}

interface HeldPhysicalDirectory extends PhysicalArtifactDirectoryIdentity {
  handle: FileHandle;
}

interface PhysicalFileSnapshot {
  bytes: Uint8Array;
  device: bigint;
  inode: bigint;
  byteCount: number;
}

export async function readProfileArtifactDirectory(
  directory: string,
  limitPolicy: ProfileArtifactLimitPolicy,
  testHooks: ProfileArtifactReadTestHooks = {}
): Promise<ProfileArtifactDirectorySnapshot> {
  const policy = copyLimitPolicy(limitPolicy);
  const rootPath = await canonicalPhysicalDirectory(directory, 'Profile artifact root');
  let root: HeldPhysicalDirectory | undefined;
  let profileDirectory: HeldPhysicalDirectory | undefined;
  let snapshot: ProfileArtifactDirectorySnapshot | undefined;
  let operationError: unknown;
  try {
    root = await openPhysicalDirectory(rootPath, 'Profile artifact root');
    await enumerateExactEntries(
      root,
      ['bazframe-profile.json', 'profile'],
      'Profile artifact root',
      testHooks
    );

    const profilePath = join(root.path, 'profile');
    profileDirectory = await openPhysicalDirectory(
      profilePath,
      'Profile artifact profile directory'
    );
    await enumerateExactEntries(
      profileDirectory,
      ['AGENTS.md'],
      'Profile artifact profile directory',
      testHooks
    );

    const manifestPath = join(root.path, 'bazframe-profile.json');
    const manifest = await readPhysicalManifest(
      manifestPath,
      policy.maxManifestBytes,
      testHooks.afterManifestRead,
      testHooks.afterClose
    );
    const artifact = decodeProfileArtifactBytes(manifest.bytes, policy);

    const instructionPath = join(profileDirectory.path, 'AGENTS.md');
    const instructions = await readPhysicalInstructionSnapshot(
      instructionPath,
      'Profile artifact instructions',
      { afterClose: () => testHooks.afterClose?.('instruction', instructionPath) }
    );
    if (instructions.contentSha256 !== artifact.profile.instructions.sha256) {
      throw invalidArtifact('instruction digest does not match profile/AGENTS.md');
    }

    await testHooks.beforeFinalIdentityCheck?.();
    await enumerateExactEntries(
      root,
      ['bazframe-profile.json', 'profile'],
      'Profile artifact root',
      testHooks
    );
    await enumerateExactEntries(
      profileDirectory,
      ['AGENTS.md'],
      'Profile artifact profile directory',
      testHooks
    );

    const finalManifest = await readPhysicalManifest(
      manifestPath,
      policy.maxManifestBytes,
      undefined,
      testHooks.afterClose
    );
    if (!samePhysicalFileSnapshot(manifest, finalManifest)) {
      throw readFailure('Profile artifact manifest changed during inspection', manifestPath);
    }
    const finalInstructions = await readPhysicalInstructionSnapshot(
      instructionPath,
      'Profile artifact instructions',
      { afterClose: () => testHooks.afterClose?.('instruction', instructionPath) }
    );
    if (!samePhysicalInstructionSnapshot(instructions, finalInstructions)) {
      throw readFailure('Profile artifact instructions changed during inspection', instructionPath);
    }
    await assertDirectoryStable(profileDirectory, 'Profile artifact profile directory');
    await assertDirectoryStable(root, 'Profile artifact root');

    snapshot = {
      root: directoryIdentity(root),
      profileDirectory: directoryIdentity(profileDirectory),
      manifestBytes: Uint8Array.from(manifest.bytes),
      artifact,
      instructions
    };
  } catch (error) {
    operationError = error instanceof BazframeError
      ? error
      : readFailure('Could not inspect profile artifact', rootPath, error);
  }

  operationError = await closeHeldDirectoryHandles(
    [profileDirectory, root],
    operationError,
    testHooks.afterClose
  );
  if (operationError !== undefined) throw operationError;
  if (snapshot === undefined) {
    throw readFailure('Could not inspect profile artifact', rootPath);
  }
  return snapshot;
}

function copyLimitPolicy(policy: ProfileArtifactLimitPolicy): ProfileArtifactLimitPolicy {
  if (policy === null || typeof policy !== 'object') {
    throw invalidArtifact('limit policy is invalid');
  }
  try { return profileArtifactLimitPolicy(policy); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BazframeError('PROFILE_ARTIFACT_INVALID', `Invalid profile artifact limit policy: ${detail}`, { cause: error });
  }
}

async function canonicalPhysicalDirectory(entered: string, label: string): Promise<string> {
  const absolute = resolve(entered);
  const enteredIdentity = await physicalDirectoryIdentity(absolute, label);
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch (error) {
    throw readFailure(`${label} could not be resolved`, absolute, error);
  }
  const [currentEnteredIdentity, canonicalIdentity] = await Promise.all([
    physicalDirectoryIdentity(absolute, label),
    physicalDirectoryIdentity(canonical, label)
  ]);
  if (!sameDirectoryIdentity(enteredIdentity, currentEnteredIdentity)
    || !sameDirectoryIdentity(enteredIdentity, canonicalIdentity)) {
    throw readFailure(`${label} changed while being resolved`, absolute);
  }
  return canonical;
}

async function openPhysicalDirectory(path: string, label: string): Promise<HeldPhysicalDirectory> {
  const expected = await physicalDirectoryIdentity(path, label);
  let handle: FileHandle | undefined;
  let operationError: unknown;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()
      || opened.dev !== expected.device
      || opened.ino !== expected.inode) {
      throw new Error('directory identity changed while opening');
    }
    return { ...expected, path, handle };
  } catch (error) {
    operationError = readFailure(`${label} must remain a stable physical directory`, path, error);
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      // Preserve the primary open or identity error.
    }
  }
  throw operationError;
}

async function enumerateExactEntries(
  directory: HeldPhysicalDirectory,
  expectedNames: readonly string[],
  label: string,
  testHooks: ProfileArtifactReadTestHooks
): Promise<void> {
  await assertDirectoryStable(directory, label);
  const expected = new Set(expectedNames);
  const observed = new Set<string>();
  let stream: Dir | undefined;
  let operationError: unknown;
  try {
    stream = await opendir(directory.path);
    while (true) {
      const entry = await stream.read();
      if (entry === null) break;
      if (!expected.has(entry.name) || observed.has(entry.name)) {
        throw invalidArtifact(`${label} contains an unexpected entry`);
      }
      observed.add(entry.name);
    }
  } catch (error) {
    operationError = error instanceof BazframeError
      ? error
      : readFailure(`${label} could not be enumerated`, directory.path, error);
  }

  if (stream !== undefined) {
    try {
      await stream.close();
      await testHooks.afterClose?.('directory-stream', directory.path);
    } catch (error) {
      operationError ??= readFailure(
        `${label} directory stream could not be closed`,
        directory.path,
        error
      );
    }
  }
  if (operationError !== undefined) throw operationError;

  for (const expectedName of expectedNames) {
    if (!observed.has(expectedName)) {
      throw invalidArtifact(`${label} is missing required entry: ${expectedName}`);
    }
  }
  await assertDirectoryStable(directory, label);
}

async function closeHeldDirectoryHandles(
  directories: readonly (HeldPhysicalDirectory | undefined)[],
  primaryError: unknown,
  afterClose?: ProfileArtifactReadTestHooks['afterClose']
): Promise<unknown> {
  let operationError = primaryError;
  for (const directory of directories) {
    if (directory === undefined) continue;
    try {
      await directory.handle.close();
      await afterClose?.('directory-handle', directory.path);
    } catch (error) {
      operationError ??= readFailure(
        'Could not close profile artifact directory handle',
        directory.path,
        error
      );
    }
  }
  return operationError;
}

async function readPhysicalManifest(
  path: string,
  maxBytes: number,
  afterRead?: () => void | Promise<void>,
  afterClose?: ProfileArtifactReadTestHooks['afterClose']
): Promise<PhysicalFileSnapshot> {
  let handle: FileHandle | undefined;
  let snapshot: PhysicalFileSnapshot | undefined;
  let operationError: unknown;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw invalidArtifact('manifest must be a physical regular file');
    }
    if (before.size > BigInt(maxBytes)) {
      throw invalidArtifact(`manifest exceeds the ${maxBytes}-byte limit`);
    }

    const expectedBytes = Number(before.size);
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const read = await handle.read(bytes, offset, expectedBytes - offset, null);
      if (read.bytesRead === 0) {
        throw readFailure('Profile artifact manifest changed while being read', path);
      }
      offset += read.bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const overflow = await handle.read(overflowProbe, 0, 1, null);
    if (overflow.bytesRead !== 0) {
      if (expectedBytes >= maxBytes) {
        throw invalidArtifact(`manifest exceeds the ${maxBytes}-byte limit`);
      }
      throw readFailure('Profile artifact manifest changed while being read', path);
    }

    await afterRead?.();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!after.isFile()
      || current.isSymbolicLink()
      || !current.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || after.dev !== current.dev
      || after.ino !== current.ino
      || before.size !== after.size
      || after.size !== current.size
      || before.mtimeNs !== after.mtimeNs
      || after.mtimeNs !== current.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || after.ctimeNs !== current.ctimeNs
      || BigInt(bytes.byteLength) !== after.size) {
      throw readFailure('Profile artifact manifest changed while being read', path);
    }

    snapshot = {
      bytes: Uint8Array.from(bytes),
      device: before.dev,
      inode: before.ino,
      byteCount: bytes.byteLength
    };
  } catch (error) {
    operationError = error instanceof BazframeError
      ? error
      : readFailure('Manifest must be a bounded physical regular file', path, error);
  }

  if (handle !== undefined) {
    try {
      await handle.close();
      await afterClose?.('manifest', path);
    } catch (error) {
      operationError ??= readFailure('Could not close profile artifact manifest', path, error);
    }
  }
  if (operationError !== undefined) throw operationError;
  if (snapshot === undefined) {
    throw readFailure('Could not read profile artifact manifest', path);
  }
  return snapshot;
}

async function physicalDirectoryIdentity(
  path: string,
  label: string
): Promise<PhysicalArtifactDirectoryIdentity> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('not a physical directory');
    }
    return { path, device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    throw readFailure(`${label} must be an existing physical directory`, path, error);
  }
}

async function assertDirectoryStable(
  directory: HeldPhysicalDirectory,
  label: string
): Promise<void> {
  try {
    const [opened, current] = await Promise.all([
      directory.handle.stat({ bigint: true }),
      lstat(directory.path, { bigint: true })
    ]);
    if (!opened.isDirectory()
      || current.isSymbolicLink()
      || !current.isDirectory()
      || opened.dev !== directory.device
      || opened.ino !== directory.inode
      || current.dev !== directory.device
      || current.ino !== directory.inode) {
      throw new Error('directory identity changed');
    }
  } catch (error) {
    throw readFailure(`${label} changed during inspection`, directory.path, error);
  }
}

function directoryIdentity(directory: HeldPhysicalDirectory): PhysicalArtifactDirectoryIdentity {
  return { path: directory.path, device: directory.device, inode: directory.inode };
}

function sameDirectoryIdentity(
  left: PhysicalArtifactDirectoryIdentity,
  right: PhysicalArtifactDirectoryIdentity
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function samePhysicalFileSnapshot(left: PhysicalFileSnapshot, right: PhysicalFileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.byteCount === right.byteCount
    && Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
}

function invalidArtifact(detail: string): BazframeError {
  return new BazframeError(
    'PROFILE_ARTIFACT_INVALID',
    `Invalid profile artifact: ${detail}.`
  );
}

function readFailure(detail: string, path: string, cause?: unknown): BazframeError {
  const code = errorCode(cause);
  return new BazframeError(
    'PROFILE_ARTIFACT_READ_FAILED',
    `${detail}: ${escapeUnsafeDisplayCharacters(path)}${code === undefined ? '' : ` (${code})`}`,
    cause === undefined ? undefined : { cause }
  );
}
