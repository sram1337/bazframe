import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  link,
  open,
  realpath,
  rmdir,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readUtf8InstructionFile } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { assertSafeSkillId, isSafeSkillId } from '../skills/skill-id.js';
import { ensureManagedDirectory, writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import { assertSafeProfileId } from './profile-id.js';
import { isPortableSourceRelativePath } from '../source-units/source-build-manifest.js';
import { prepareSourceUnit } from '../source-units/source-unit-preparation.js';
import { loadFlatSkillIdentities, validateProspectiveSourceUnit } from '../source-units/source-unit-resolver.js';
import { discoverSkillDirectories, profileDirectory, readActiveProfile } from './profile-store.js';

const DESCRIPTOR_V1_KEYS = ['providerId', 'schemaVersion', 'sourceId', 'sourceRoot'] as const;
const DESCRIPTOR_V2_KEYS = ['providerId', 'schemaVersion', 'snapshotDigest', 'sourceId', 'sourceRoot', 'sourceUnitRoot'] as const;

export interface SourceDescriptorV1 {
  schemaVersion: 1;
  providerId: string;
  sourceId: string;
  sourceRoot: string;
}
export interface SourceDescriptorV2 {
  schemaVersion: 2;
  providerId: string;
  sourceId: string;
  sourceRoot: string;
  snapshotDigest: string;
  sourceUnitRoot: string;
}
export type SourceDescriptor = SourceDescriptorV1 | SourceDescriptorV2;

export type ProfileSourceMembershipAction = 'added' | 'built' | 'current' | 'removed' | 'absent';

export type ProfileSourceMembershipResult = SourceDescriptor & {
  action: ProfileSourceMembershipAction;
  profileId: string;
  descriptorPath: string;
};

export interface ProfileSourceMembershipOptions {
  bazframeHome: string;
  environment?: NodeJS.ProcessEnv;
}

export interface ProfileSourceMembershipDependencies {
  beforeRemoveRevalidation?: (descriptorPath: string) => Promise<void>;
  removeDirectory?: (path: string) => Promise<void>;
  removeTemporaryDescriptor?: (path: string) => Promise<void>;
}

export function encodeSourceDescriptor(descriptor: SourceDescriptor): string {
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}

export function decodeSourceDescriptor(
  value: unknown,
  expectedProviderId?: string,
  expectedSourceId?: string
): SourceDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidDescriptor('descriptor must be a JSON object');
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = candidate.schemaVersion === 1 ? DESCRIPTOR_V1_KEYS
    : candidate.schemaVersion === 2 ? DESCRIPTOR_V2_KEYS : undefined;
  if (expectedKeys === undefined) throw invalidDescriptor('unsupported schemaVersion');
  if (keys.length !== expectedKeys.length
    || !keys.every((key, index) => key === expectedKeys[index])) {
    throw invalidDescriptor(`descriptor must contain exactly the schema-v${candidate.schemaVersion} fields`);
  }
  if (typeof candidate.providerId !== 'string' || !isSafeSkillId(candidate.providerId)) {
    throw invalidDescriptor('providerId is invalid');
  }
  if (typeof candidate.sourceId !== 'string' || !isSafeSkillId(candidate.sourceId)) {
    throw invalidDescriptor('sourceId is invalid');
  }
  if (typeof candidate.sourceRoot !== 'string'
    || candidate.sourceRoot.includes('\0')
    || !isAbsolute(candidate.sourceRoot)
    || resolve(candidate.sourceRoot) !== candidate.sourceRoot) {
    throw invalidDescriptor('sourceRoot must be a canonical absolute path');
  }
  if (expectedProviderId !== undefined && candidate.providerId !== expectedProviderId) {
    throw invalidDescriptor('providerId does not match the descriptor path');
  }
  if (expectedSourceId !== undefined && candidate.sourceId !== expectedSourceId) {
    throw invalidDescriptor('sourceId does not match the descriptor path');
  }
  if (candidate.schemaVersion === 1) return {
    schemaVersion: 1,
    providerId: candidate.providerId,
    sourceId: candidate.sourceId,
    sourceRoot: candidate.sourceRoot
  };
  if (typeof candidate.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.snapshotDigest)) {
    throw invalidDescriptor('snapshotDigest must be lowercase SHA-256');
  }
  if (typeof candidate.sourceUnitRoot !== 'string' || !isPortableSourceRelativePath(candidate.sourceUnitRoot)) {
    throw invalidDescriptor('sourceUnitRoot is invalid');
  }
  return {
    schemaVersion: 2,
    providerId: candidate.providerId,
    sourceId: candidate.sourceId,
    sourceRoot: candidate.sourceRoot,
    snapshotDigest: candidate.snapshotDigest,
    sourceUnitRoot: candidate.sourceUnitRoot
  };
}

interface DescriptorSnapshot {
  descriptor: SourceDescriptor;
  device: bigint;
  inode: bigint;
  contentSha256: string;
}

export async function readSourceDescriptor(
  path: string,
  expectedProviderId?: string,
  expectedSourceId?: string
): Promise<SourceDescriptor> {
  return (await readSourceDescriptorSnapshot(path, expectedProviderId, expectedSourceId)).descriptor;
}

async function readSourceDescriptorSnapshot(
  path: string,
  expectedProviderId?: string,
  expectedSourceId?: string
): Promise<DescriptorSnapshot> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()) throw invalidDescriptor('descriptor must be a physical regular file');
    const bytes = await handle.readFile();
    if (bytes.includes(0)) throw invalidDescriptor('descriptor bytes are invalid');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new BazframeError('SOURCE_DESCRIPTOR_INVALID', 'Source-unit descriptor is not valid UTF-8.', {
        cause: error
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new BazframeError('SOURCE_DESCRIPTOR_INVALID', 'Source-unit descriptor is not valid JSON.', {
        cause: error
      });
    }
    return {
      descriptor: decodeSourceDescriptor(value, expectedProviderId, expectedSourceId),
      device: metadata.dev,
      inode: metadata.ino,
      contentSha256: createHash('sha256').update(bytes).digest('hex')
    };
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    if (errorCode(error) === 'ELOOP') {
      throw invalidDescriptor('descriptor must be a physical regular file');
    }
    throw new BazframeError(
      'SOURCE_DESCRIPTOR_READ_FAILED',
      `Could not open or read source-unit descriptor ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function addActiveProfileSource(
  options: ProfileSourceMembershipOptions,
  providerId: string,
  sourceId: string,
  sourceRoot: string,
  dependencies: ProfileSourceMembershipDependencies = {}
): Promise<ProfileSourceMembershipResult> {
  return addProfileSourceFor(options, undefined, providerId, sourceId, sourceRoot, dependencies);
}

export async function addProfileSource(
  options: ProfileSourceMembershipOptions,
  profileId: string,
  providerId: string,
  sourceId: string,
  sourceRoot: string,
  dependencies: ProfileSourceMembershipDependencies = {}
): Promise<ProfileSourceMembershipResult> {
  assertSafeProfileId(profileId);
  return addProfileSourceFor(options, profileId, providerId, sourceId, sourceRoot, dependencies);
}

async function addProfileSourceFor(
  options: ProfileSourceMembershipOptions,
  requestedProfileId: string | undefined,
  providerId: string,
  sourceId: string,
  sourceRoot: string,
  dependencies: ProfileSourceMembershipDependencies
): Promise<ProfileSourceMembershipResult> {
  assertSafeSkillId(providerId);
  assertSafeSkillId(sourceId);
  const canonicalRoot = await canonicalPhysicalRoot(sourceRoot);
  return withProfileSourceLock(
    options,
    requestedProfileId,
    providerId,
    sourceId,
    'bazframe profile sources add',
    async (paths) => {
      await assertOptionalPhysicalDirectory(paths.sourceUnitsDirectory, 'Profile source-units directory');
      await assertOptionalPhysicalDirectory(paths.providerDirectory, 'Profile source-unit provider directory');
      const existing = await inspectDescriptor(paths.descriptorPath, providerId, sourceId);
      if (existing !== undefined) {
        if (existing.sourceRoot !== canonicalRoot) throw unmanagedDescriptor(paths.descriptorPath, 'names a different canonical source root');
        if (existing.schemaVersion === 1) throw new BazframeError('SOURCE_BUILD_REQUIRED', 'Source membership requires `bazframe profile sources build` before it can be used.');
        return result(paths, existing, 'current');
      }
      const prepared = await prepareSourceUnit(options.bazframeHome, canonicalRoot, options.environment);
      const descriptor: SourceDescriptorV2 = {
        schemaVersion: 2,
        providerId,
        sourceId,
        sourceRoot: canonicalRoot,
        snapshotDigest: prepared.snapshot.digest,
        sourceUnitRoot: prepared.sourceUnitRoot
      };
      await validateCandidate(options, paths, descriptor);
      await ensureManagedDirectory(options.bazframeHome, paths.providerDirectory);
      const created = await createDescriptorExclusive(paths.descriptorPath, encodeSourceDescriptor(descriptor), options.bazframeHome, dependencies);
      if (!created) throw unmanagedDescriptor(paths.descriptorPath, 'was occupied while the descriptor was being added');
      return result(paths, descriptor, 'added');
    }
  );
}

export async function buildActiveProfileSource(
  options: ProfileSourceMembershipOptions,
  providerId: string,
  sourceId: string
): Promise<ProfileSourceMembershipResult> {
  return buildProfileSourceFor(options, undefined, providerId, sourceId);
}

export async function buildProfileSource(
  options: ProfileSourceMembershipOptions,
  profileId: string,
  providerId: string,
  sourceId: string
): Promise<ProfileSourceMembershipResult> {
  assertSafeProfileId(profileId);
  return buildProfileSourceFor(options, profileId, providerId, sourceId);
}

async function buildProfileSourceFor(
  options: ProfileSourceMembershipOptions,
  requestedProfileId: string | undefined,
  providerId: string,
  sourceId: string
): Promise<ProfileSourceMembershipResult> {
  assertSafeSkillId(providerId);
  assertSafeSkillId(sourceId);
  return withProfileSourceLock(options, requestedProfileId, providerId, sourceId, 'bazframe profile sources build', async (paths) => {
    const initial = await inspectDescriptorSnapshot(paths.descriptorPath, providerId, sourceId);
    if (initial === undefined) throw new BazframeError('SOURCE_DESCRIPTOR_MISSING', `Source-unit descriptor does not exist: ${paths.descriptorPath}`);
    const canonicalRoot = await canonicalPhysicalRoot(initial.descriptor.sourceRoot);
    if (canonicalRoot !== initial.descriptor.sourceRoot) throw unmanagedDescriptor(paths.descriptorPath, 'provider input no longer has its recorded canonical identity');
    const prepared = await prepareSourceUnit(options.bazframeHome, canonicalRoot, options.environment);
    const descriptor: SourceDescriptorV2 = {
      schemaVersion: 2,
      providerId,
      sourceId,
      sourceRoot: canonicalRoot,
      snapshotDigest: prepared.snapshot.digest,
      sourceUnitRoot: prepared.sourceUnitRoot
    };
    await validateCandidate(options, paths, descriptor);
    const revalidated = await inspectDescriptorSnapshot(paths.descriptorPath, providerId, sourceId);
    if (revalidated === undefined || !sameDescriptorSnapshot(initial, revalidated)) throw unmanagedDescriptor(paths.descriptorPath, 'changed during source build');
    await replaceDescriptorAtomic(paths.descriptorPath, encodeSourceDescriptor(descriptor), options.bazframeHome);
    return result(paths, descriptor, 'built');
  });
}

export async function removeActiveProfileSource(
  options: ProfileSourceMembershipOptions,
  providerId: string,
  sourceId: string,
  dependencies: ProfileSourceMembershipDependencies = {}
): Promise<ProfileSourceMembershipResult> {
  return removeProfileSourceFor(options, undefined, providerId, sourceId, dependencies);
}

export async function removeProfileSource(
  options: ProfileSourceMembershipOptions,
  profileId: string,
  providerId: string,
  sourceId: string,
  dependencies: ProfileSourceMembershipDependencies = {}
): Promise<ProfileSourceMembershipResult> {
  assertSafeProfileId(profileId);
  return removeProfileSourceFor(options, profileId, providerId, sourceId, dependencies);
}

async function removeProfileSourceFor(
  options: ProfileSourceMembershipOptions,
  requestedProfileId: string | undefined,
  providerId: string,
  sourceId: string,
  dependencies: ProfileSourceMembershipDependencies
): Promise<ProfileSourceMembershipResult> {
  assertSafeSkillId(providerId);
  assertSafeSkillId(sourceId);
  return withProfileSourceLock(
    options,
    requestedProfileId,
    providerId,
    sourceId,
    'bazframe profile sources remove',
    async (paths) => {
      const sourceUnitsExists = await assertOptionalPhysicalDirectory(
        paths.sourceUnitsDirectory,
        'Profile source-units directory'
      );
      if (!sourceUnitsExists) return absentResult(paths, providerId, sourceId);
      const providerExists = await assertOptionalPhysicalDirectory(
        paths.providerDirectory,
        'Profile source-unit provider directory'
      );
      if (!providerExists) {
        await pruneAfterAbsent(paths, dependencies);
        return absentResult(paths, providerId, sourceId);
      }
      const initial = await inspectDescriptorSnapshot(paths.descriptorPath, providerId, sourceId);
      if (initial === undefined) {
        await pruneAfterAbsent(paths, dependencies);
        return absentResult(paths, providerId, sourceId);
      }
      await dependencies.beforeRemoveRevalidation?.(paths.descriptorPath);
      const revalidated = await inspectDescriptorSnapshot(paths.descriptorPath, providerId, sourceId);
      if (revalidated === undefined || !sameDescriptorSnapshot(initial, revalidated)) {
        throw unmanagedDescriptor(
          paths.descriptorPath,
          'changed after it was initially inspected'
        );
      }
      try {
        await unlink(paths.descriptorPath);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          await pruneAfterAbsent(paths, dependencies);
          return absentResult(paths, providerId, sourceId);
        }
        throw new BazframeError(
          'SOURCE_DESCRIPTOR_REMOVE_FAILED',
          `Could not remove source-unit descriptor ${paths.descriptorPath}${formatErrorCode(error)}`,
          { cause: error }
        );
      }
      try {
        await pruneOwnedDirectories(paths, dependencies);
      } catch (error) {
        throw new BazframeError(
          'SOURCE_DIRECTORY_PRUNE_FAILED',
          `Source-unit descriptor was removed, but its empty Bazframe-owned directories could not be pruned${formatErrorCode(error)}`,
          { cause: error }
        );
      }
      return result(paths, initial.descriptor, 'removed');
    }
  );
}

interface SourcePaths {
  profileId: string;
  sourceUnitsDirectory: string;
  providerDirectory: string;
  descriptorPath: string;
}

async function withProfileSourceLock<T>(
  options: ProfileSourceMembershipOptions,
  requestedProfileId: string | undefined,
  providerId: string,
  sourceId: string,
  command: string,
  operation: (paths: SourcePaths) => Promise<T>
): Promise<T> {
  return withStateLock(
    join(options.bazframeHome, 'locks', 'state.lock'),
    {
      command,
      target: requestedProfileId === undefined
        ? join(options.bazframeHome, 'active-profile')
        : profileDirectory(options.bazframeHome, requestedProfileId)
    },
    async () => {
      const profileId = requestedProfileId ?? await readActiveProfile(options.bazframeHome);
      const directory = profileDirectory(options.bazframeHome, profileId);
      const sourceUnitsDirectory = join(directory, 'source-units');
      const providerDirectory = join(sourceUnitsDirectory, providerId);
      const descriptorPath = join(providerDirectory, `${sourceId}.json`);
      const paths = { profileId, sourceUnitsDirectory, providerDirectory, descriptorPath };
      return withStateLock(
        join(options.bazframeHome, 'locks', 'profiles', `${profileId}.sources.lock`),
        { command, target: descriptorPath },
        async () => {
          await assertRequiredPhysicalDirectory(join(options.bazframeHome, 'profiles'), 'Profiles directory');
          await assertRequiredPhysicalDirectory(directory, `Profile ${JSON.stringify(profileId)}`);
          await readUtf8InstructionFile(
            join(directory, 'AGENTS.md'),
            `Profile ${JSON.stringify(profileId)} instructions`
          );
          await assertRequiredPhysicalDirectory(join(directory, 'skills'), 'Profile skills directory');
          return operation(paths);
        },
        { managedRoot: options.bazframeHome }
      );
    },
    { managedRoot: options.bazframeHome }
  );
}

async function canonicalPhysicalRoot(path: string): Promise<string> {
  if (path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw new BazframeError(
      'SOURCE_ROOT_INVALID',
      `Source root must be an absolute existing physical directory: ${path}`
    );
  }
  await assertRequiredPhysicalDirectory(path, 'Source root');
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw new BazframeError(
      'SOURCE_ROOT_INVALID',
      `Could not canonicalize source root ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  await assertRequiredPhysicalDirectory(canonical, 'Canonical source root');
  return canonical;
}

async function inspectDescriptor(
  path: string,
  providerId: string,
  sourceId: string
): Promise<SourceDescriptor | undefined> {
  return (await inspectDescriptorSnapshot(path, providerId, sourceId))?.descriptor;
}

async function inspectDescriptorSnapshot(
  path: string,
  providerId: string,
  sourceId: string
): Promise<DescriptorSnapshot | undefined> {
  try {
    return await readSourceDescriptorSnapshot(path, providerId, sourceId);
  } catch (error) {
    if (errorCode(error) === 'ENOENT'
      || (error instanceof BazframeError
        && error.code === 'SOURCE_DESCRIPTOR_READ_FAILED'
        && error.cause !== undefined
        && errorCode(error.cause) === 'ENOENT')) return undefined;
    if (error instanceof BazframeError && error.code === 'SOURCE_DESCRIPTOR_INVALID') {
      throw unmanagedDescriptor(path, error.message);
    }
    throw error;
  }
}

function sameDescriptorSnapshot(left: DescriptorSnapshot, right: DescriptorSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.contentSha256 === right.contentSha256;
}

async function createDescriptorExclusive(
  path: string,
  contents: string,
  managedRoot: string,
  dependencies: ProfileSourceMembershipDependencies
): Promise<boolean> {
  const temporaryDirectory = join(managedRoot, 'tmp', 'source-descriptors');
  await ensureManagedDirectory(managedRoot, temporaryDirectory);
  const temporaryPath = join(
    temporaryDirectory,
    `${process.pid}.${randomUUID()}.json.tmp`
  );
  let handle: FileHandle | undefined;
  let activated = false;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, path);
      activated = true;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    }
    return true;
  } catch (error) {
    throw new BazframeError(
      'SOURCE_DESCRIPTOR_ADD_FAILED',
      `Could not add source-unit descriptor ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await (dependencies.removeTemporaryDescriptor ?? unlink)(temporaryPath).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT' && !activated) throw error;
    });
  }
}

async function validateCandidate(
  options: ProfileSourceMembershipOptions,
  paths: SourcePaths,
  descriptor: SourceDescriptorV2
): Promise<void> {
  const directory = profileDirectory(options.bazframeHome, paths.profileId);
  const flatSkills = loadFlatSkillIdentities(await discoverSkillDirectories(join(directory, 'skills')));
  await validateProspectiveSourceUnit(directory, flatSkills, {
    ...descriptor,
    descriptorPath: paths.descriptorPath,
    relativeDescriptorPath: `${descriptor.providerId}/${descriptor.sourceId}.json`,
    preparationState: 'ready',
    rebuildAvailability: 'available'
  });
}

async function replaceDescriptorAtomic(path: string, contents: string, managedRoot: string): Promise<void> {
  try { await writeFileAtomic(path, contents, { managedRoot, mode: 0o600, commitOnRename: true }); }
  catch (error) { throw new BazframeError('SOURCE_DESCRIPTOR_REPLACE_FAILED', `Could not activate source-unit descriptor ${path}${formatErrorCode(error)}`, { cause: error }); }
}

async function assertRequiredPhysicalDirectory(path: string, label: string): Promise<void> {
  const exists = await assertOptionalPhysicalDirectory(path, label);
  if (!exists) {
    throw new BazframeError(
      'DIRECTORY_READ_FAILED',
      `${label} must be an existing physical directory: ${path}`
    );
  }
}

async function assertOptionalPhysicalDirectory(path: string, label: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw new BazframeError(
      'DIRECTORY_READ_FAILED',
      `Could not inspect ${label.toLowerCase()}: ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError(
      'DIRECTORY_NOT_PHYSICAL',
      `${label} must be a physical directory: ${path}`
    );
  }
  return true;
}

async function pruneAfterAbsent(
  paths: SourcePaths,
  dependencies: ProfileSourceMembershipDependencies
): Promise<void> {
  try {
    await pruneOwnedDirectories(paths, dependencies);
  } catch (error) {
    throw new BazframeError(
      'SOURCE_DIRECTORY_PRUNE_FAILED',
      `Source-unit descriptor is absent, but its empty Bazframe-owned directories could not be pruned${formatErrorCode(error)}`,
      { cause: error }
    );
  }
}

async function pruneOwnedDirectories(
  paths: SourcePaths,
  dependencies: ProfileSourceMembershipDependencies
): Promise<void> {
  await pruneEmpty(paths.providerDirectory, dependencies.removeDirectory);
  await pruneEmpty(paths.sourceUnitsDirectory, dependencies.removeDirectory);
}

async function pruneEmpty(
  path: string,
  removeDirectory: ((path: string) => Promise<void>) | undefined
): Promise<void> {
  try {
    await (removeDirectory ?? rmdir)(path);
  } catch (error) {
    if (!new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST']).has(errorCode(error) ?? '')) throw error;
  }
}

function result(
  paths: SourcePaths,
  descriptor: SourceDescriptor,
  action: ProfileSourceMembershipAction
): ProfileSourceMembershipResult {
  return { action, profileId: paths.profileId, descriptorPath: paths.descriptorPath, ...descriptor };
}

function absentResult(
  paths: SourcePaths,
  providerId: string,
  sourceId: string
): ProfileSourceMembershipResult {
  return result(paths, {
    schemaVersion: 1,
    providerId,
    sourceId,
    sourceRoot: '(unresolved)'
  }, 'absent');
}

function invalidDescriptor(detail: string): BazframeError {
  return new BazframeError('SOURCE_DESCRIPTOR_INVALID', `Invalid source-unit descriptor: ${detail}.`);
}

function unmanagedDescriptor(path: string, detail: string): BazframeError {
  return new BazframeError(
    'SOURCE_DESCRIPTOR_UNMANAGED',
    `Refusing to change unmanaged source-unit descriptor ${path}: ${detail}.`
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
