import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  ensureManagedDirectory,
  removeManagedDirectoryTree,
  writeFileAtomic
} from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import { assertSafeProfileId, isSafeProfileId } from './profile-id.js';
import {
  captureProfileRemovalIdentity,
  staleProfileRemovalAuthorization,
  type ProfileRemovalIdentity
} from './profile-removal-identity.js';
import { loadProfile, profileDirectory, readActiveProfile } from './profile-store.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type ProfileAddAction = 'added' | 'current';
export type ProfileDuplicateAction = 'duplicated';
export type ProfileRemoveAction = 'removed' | 'absent';
export type ProfileRenameAction = 'renamed' | 'current';

export interface ProfileLifecycleResult<A extends string> {
  action: A;
  profileId: string;
  directory: string;
}

export interface ProfileDuplicateResult extends ProfileLifecycleResult<ProfileDuplicateAction> {
  sourceProfileId: string;
}

export interface ProfileRenameResult extends ProfileLifecycleResult<ProfileRenameAction> {
  previousProfileId: string;
  activeSelectionUpdated: boolean;
}

export interface ProfileListResult {
  profileIds: string[];
  diagnostics: string[];
}

export interface ProfileRemovalSnapshotAuthorization {
  expectedIdentity: ProfileRemovalIdentity;
}

export async function addProfile(
  bazframeHome: string,
  profileId: string
): Promise<ProfileLifecycleResult<ProfileAddAction>> {
  assertSafeProfileId(profileId);
  return withGlobalStateLock(bazframeHome, 'bazframe profile add', async () => {
    const profilesRoot = join(bazframeHome, 'profiles');
    const directory = profileDirectory(bazframeHome, profileId);
    await ensureManagedDirectory(bazframeHome, profilesRoot, {
      chmodExistingDirectories: false
    });

    const existing = await pathMetadata(directory);
    if (existing !== undefined) {
      await assertRuntimeValidPhysicalProfile(bazframeHome, profileId, existing);
      return { action: 'current', profileId, directory };
    }

    await clearProfileAliasCache(bazframeHome, profileId);
    let created = false;
    try {
      await mkdir(directory, { mode: DIRECTORY_MODE });
      created = true;
      await mkdir(join(directory, 'skills'), { mode: DIRECTORY_MODE });
      await createEmptyFile(join(directory, 'AGENTS.md'));
      return { action: 'added', profileId, directory };
    } catch (error) {
      if (created) {
        try {
          await cleanupFailedProfileCreation(bazframeHome, directory);
        } catch {
          // Preserve the initialization failure as primary; the path is reported below.
        }
      }
      if (error instanceof BazframeError) throw error;
      throw new BazframeError(
        'PROFILE_ADD_FAILED',
        `Could not create profile ${JSON.stringify(profileId)} at ${directory}${formatErrorCode(error)}`,
        { cause: error }
      );
    }
  });
}

export async function duplicateProfile(
  bazframeHome: string,
  sourceProfileId: string,
  profileId: string,
  dependencies: {
    copyProfileTree?: (source: string, destination: string) => Promise<void>;
  } = {}
): Promise<ProfileDuplicateResult> {
  assertSafeProfileId(sourceProfileId);
  assertSafeProfileId(profileId);
  return withGlobalStateLock(bazframeHome, 'bazframe profile duplicate', async () => {
    await assertPhysicalDirectory(bazframeHome, 'Bazframe home');
    const profilesRoot = join(bazframeHome, 'profiles');
    await assertPhysicalDirectory(profilesRoot, 'Profiles directory');
    const sourceDirectory = profileDirectory(bazframeHome, sourceProfileId);
    const directory = profileDirectory(bazframeHome, profileId);
    const sourceMetadata = await pathMetadata(sourceDirectory);
    if (sourceMetadata === undefined) {
      throw new BazframeError(
        'PROFILE_NOT_FOUND',
        `Profile ${JSON.stringify(sourceProfileId)} does not exist at ${sourceDirectory}.`
      );
    }
    assertPhysicalProfileRoot(sourceDirectory, sourceMetadata);
    if (await pathMetadata(directory) !== undefined) {
      throw new BazframeError(
        'PROFILE_DUPLICATE_DESTINATION_OCCUPIED',
        `Refusing to replace occupied profile destination: ${directory}`
      );
    }

    await clearProfileAliasCache(bazframeHome, profileId);
    const temporaryDirectory = join(
      profilesRoot,
      `.${profileId}.${process.pid}.${randomUUID()}.duplicate.tmp`
    );
    let published = false;
    try {
      await (dependencies.copyProfileTree ?? copyProfileTree)(
        sourceDirectory,
        temporaryDirectory
      );
      const temporaryMetadata = await pathMetadata(temporaryDirectory);
      if (temporaryMetadata === undefined) {
        throw new BazframeError(
          'PROFILE_DUPLICATE_STAGING_MISSING',
          `Profile copy did not create its staging directory: ${temporaryDirectory}`
        );
      }
      assertPhysicalProfileRoot(temporaryDirectory, temporaryMetadata);
      if (await pathMetadata(directory) !== undefined) {
        throw new BazframeError(
          'PROFILE_DUPLICATE_DESTINATION_OCCUPIED',
          `Refusing to replace occupied profile destination: ${directory}`
        );
      }
      await rename(temporaryDirectory, directory);
      published = true;
    } catch (error) {
      if (!published) {
        try {
          await cleanupDuplicateStaging(bazframeHome, temporaryDirectory);
        } catch (cleanupError) {
          const originalMessage = error instanceof Error ? error.message : String(error);
          throw new BazframeError(
            'PROFILE_DUPLICATE_CLEANUP_FAILED',
            `Duplication failed (${originalMessage}) and staging cleanup also failed at ${temporaryDirectory}.`,
            { cause: cleanupError }
          );
        }
      }
      if (error instanceof BazframeError) throw error;
      throw new BazframeError(
        'PROFILE_DUPLICATE_FAILED',
        `Could not duplicate profile ${JSON.stringify(sourceProfileId)} to ${JSON.stringify(profileId)}; temporary path: ${temporaryDirectory}${formatErrorCode(error)}`,
        { cause: error }
      );
    }

    return { action: 'duplicated', sourceProfileId, profileId, directory };
  });
}

export async function removeProfile(
  bazframeHome: string,
  profileId: string,
  force: boolean,
  authorization?: ProfileRemovalSnapshotAuthorization
): Promise<ProfileLifecycleResult<ProfileRemoveAction>> {
  assertSafeProfileId(profileId);
  return withGlobalStateLock(bazframeHome, 'bazframe profile remove', async () => {
    const directory = profileDirectory(bazframeHome, profileId);
    const activeProfile = await readActiveProfileIfPresent(bazframeHome);
    if (activeProfile === profileId) {
      throw new BazframeError(
        'ACTIVE_PROFILE_REMOVE_REFUSED',
        `Cannot remove active profile ${JSON.stringify(profileId)}. Select another profile first.`
      );
    }

    const metadata = await pathMetadata(directory);
    if (metadata === undefined) {
      if (authorization !== undefined) throw staleProfileRemovalAuthorization(profileId);
      await clearProfileAliasCache(bazframeHome, profileId);
      return { action: 'absent', profileId, directory };
    }
    try {
      assertPhysicalProfileRoot(directory, metadata);
    } catch (error) {
      if (authorization !== undefined) throw staleProfileRemovalAuthorization(profileId, error);
      throw error;
    }
    if (!force) await assertGeneratedEmptyProfile(directory);

    await clearProfileAliasCache(bazframeHome, profileId);
    if (authorization !== undefined) {
      let currentIdentity: ProfileRemovalIdentity;
      try {
        currentIdentity = await captureProfileRemovalIdentity(directory);
      } catch (error) {
        throw staleProfileRemovalAuthorization(profileId, error);
      }
      if (!sameRemovalIdentity(currentIdentity, authorization.expectedIdentity)) {
        throw staleProfileRemovalAuthorization(profileId);
      }
    }
    await removeManagedDirectoryTree(bazframeHome, directory);
    return { action: 'removed', profileId, directory };
  });
}

export async function renameProfile(
  bazframeHome: string,
  previousProfileId: string,
  profileId: string,
  dependencies: {
    writeActiveProfileState?: (bazframeHome: string, profileId: string) => Promise<void>;
  } = {}
): Promise<ProfileRenameResult> {
  assertSafeProfileId(previousProfileId);
  assertSafeProfileId(profileId);
  return withGlobalStateLock(bazframeHome, 'bazframe profile rename', async () => {
    await assertPhysicalDirectory(bazframeHome, 'Bazframe home');
    await assertPhysicalDirectory(join(bazframeHome, 'profiles'), 'Profiles directory');
    const previousDirectory = profileDirectory(bazframeHome, previousProfileId);
    const directory = profileDirectory(bazframeHome, profileId);
    const previousMetadata = await pathMetadata(previousDirectory);
    if (previousMetadata === undefined) {
      throw new BazframeError(
        'PROFILE_NOT_FOUND',
        `Profile ${JSON.stringify(previousProfileId)} does not exist at ${previousDirectory}.`
      );
    }
    assertPhysicalProfileRoot(previousDirectory, previousMetadata);
    if (previousProfileId === profileId) {
      return {
        action: 'current',
        previousProfileId,
        profileId,
        directory,
        activeSelectionUpdated: false
      };
    }
    if (await pathMetadata(directory) !== undefined) {
      throw new BazframeError(
        'PROFILE_RENAME_DESTINATION_OCCUPIED',
        `Refusing to replace occupied profile destination: ${directory}`
      );
    }

    const activeProfile = await readActiveProfileIfPresent(bazframeHome);
    const activeSelectionUpdated = activeProfile === previousProfileId;
    await clearProfileAliasCache(bazframeHome, previousProfileId);
    await clearProfileAliasCache(bazframeHome, profileId);

    try {
      await rename(previousDirectory, directory);
    } catch (error) {
      throw new BazframeError(
        'PROFILE_RENAME_FAILED',
        `Could not rename profile ${JSON.stringify(previousProfileId)} to ${JSON.stringify(profileId)}${formatErrorCode(error)}`,
        { cause: error }
      );
    }

    if (activeSelectionUpdated) {
      try {
        await (dependencies.writeActiveProfileState ?? writeActiveProfileState)(
          bazframeHome,
          profileId
        );
      } catch (error) {
        await handleActiveRenameWriteFailure(
          bazframeHome,
          previousProfileId,
          profileId,
          previousDirectory,
          directory,
          error
        );
      }
    }

    return {
      action: 'renamed',
      previousProfileId,
      profileId,
      directory,
      activeSelectionUpdated
    };
  });
}

export async function listProfiles(bazframeHome: string): Promise<ProfileListResult> {
  const profilesRoot = join(bazframeHome, 'profiles');
  const rootMetadata = await pathMetadata(profilesRoot);
  if (rootMetadata === undefined) return { profileIds: [], diagnostics: [] };
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new BazframeError(
      'PROFILES_DIRECTORY_INVALID',
      `Profiles path must be a physical directory: ${profilesRoot}`
    );
  }

  const profileIds: string[] = [];
  const diagnostics: string[] = [];
  const entries = await readdir(profilesRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (!isSafeProfileId(entry.name)) {
      diagnostics.push(`Skipping unsafe profile entry ${JSON.stringify(entry.name)}.`);
      continue;
    }
    const directory = join(profilesRoot, entry.name);
    try {
      const metadata = await lstat(directory);
      await assertRuntimeValidPhysicalProfile(bazframeHome, entry.name, metadata);
      profileIds.push(entry.name);
    } catch (error) {
      diagnostics.push(
        `Skipping invalid profile ${JSON.stringify(entry.name)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { profileIds, diagnostics };
}

export function currentProfile(bazframeHome: string): Promise<string> {
  return readActiveProfile(bazframeHome);
}

function sameRemovalIdentity(
  current: ProfileRemovalIdentity,
  expected: ProfileRemovalIdentity
): boolean {
  return current.schemaVersion === expected?.schemaVersion
    && current.directory.device === expected.directory?.device
    && current.directory.inode === expected.directory?.inode
    && current.fingerprint === expected.fingerprint;
}

async function assertRuntimeValidPhysicalProfile(
  bazframeHome: string,
  profileId: string,
  metadata: Awaited<ReturnType<typeof lstat>>
): Promise<void> {
  assertPhysicalProfileRoot(profileDirectory(bazframeHome, profileId), metadata);
  await loadProfile(bazframeHome, profileId);
}

function assertPhysicalProfileRoot(
  directory: string,
  metadata: Awaited<ReturnType<typeof lstat>>
): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError(
      'PROFILE_NOT_PHYSICAL',
      `Profile lifecycle requires a physical directory: ${directory}`
    );
  }
}

async function cleanupFailedProfileCreation(
  bazframeHome: string,
  directory: string
): Promise<void> {
  const metadata = await pathMetadata(directory);
  if (metadata === undefined) return;
  assertPhysicalProfileRoot(directory, metadata);
  const entries = (await readdir(directory)).sort();
  if (entries.some((entry) => entry !== 'AGENTS.md' && entry !== 'skills')) return;
  if (entries.includes('AGENTS.md')) {
    const instructions = await lstat(join(directory, 'AGENTS.md'));
    if (instructions.isSymbolicLink() || !instructions.isFile() || instructions.size !== 0) return;
  }
  if (entries.includes('skills')) {
    const skillsDirectory = join(directory, 'skills');
    const skills = await lstat(skillsDirectory);
    if (skills.isSymbolicLink() || !skills.isDirectory()) return;
    if ((await readdir(skillsDirectory)).length !== 0) return;
  }
  await removeManagedDirectoryTree(bazframeHome, directory);
}

async function assertGeneratedEmptyProfile(directory: string): Promise<void> {
  const entries = (await readdir(directory)).sort();
  if (entries.length !== 2 || entries[0] !== 'AGENTS.md' || entries[1] !== 'skills') {
    throw nonEmptyProfile(directory);
  }
  const instructions = await lstat(join(directory, 'AGENTS.md'));
  if (instructions.isSymbolicLink() || !instructions.isFile() || instructions.size !== 0) {
    throw nonEmptyProfile(directory);
  }
  const skillsDirectory = join(directory, 'skills');
  await assertPhysicalDirectory(skillsDirectory, 'Profile skills directory');
  if ((await readdir(skillsDirectory)).length !== 0) throw nonEmptyProfile(directory);
}

async function assertPhysicalDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError('PROFILE_PATH_INVALID', `${label} must be a physical directory: ${path}`);
  }
}

function copyProfileTree(source: string, destination: string): Promise<void> {
  return cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true
  });
}

async function cleanupDuplicateStaging(
  bazframeHome: string,
  temporaryDirectory: string
): Promise<void> {
  const metadata = await pathMetadata(temporaryDirectory);
  if (metadata === undefined) return;
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await removeManagedDirectoryTree(bazframeHome, temporaryDirectory);
    return;
  }
  await unlink(temporaryDirectory);
}

async function createEmptyFile(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } finally {
    await handle?.close();
  }
}

async function clearProfileAliasCache(bazframeHome: string, profileId: string): Promise<void> {
  await removeManagedDirectoryTree(
    bazframeHome,
    join(bazframeHome, 'adapter-cache', 'pi', 'skill-aliases', profileId)
  );
}

async function readActiveProfileIfPresent(bazframeHome: string): Promise<string | undefined> {
  try {
    return await readActiveProfile(bazframeHome);
  } catch (error) {
    if (error instanceof BazframeError && error.code === 'NO_ACTIVE_PROFILE') return undefined;
    throw error;
  }
}

async function writeActiveProfileState(bazframeHome: string, profileId: string): Promise<void> {
  await writeFileAtomic(join(bazframeHome, 'active-profile'), `${profileId}\n`, {
    managedRoot: bazframeHome
  });
}

async function handleActiveRenameWriteFailure(
  bazframeHome: string,
  previousProfileId: string,
  profileId: string,
  previousDirectory: string,
  directory: string,
  writeError: unknown
): Promise<never> {
  let committedSelection: string | undefined;
  try {
    committedSelection = await readActiveProfile(bazframeHome);
  } catch {
    // The recovery error below reports that coherence could not be established.
  }
  if (committedSelection === profileId) {
    throw new BazframeError(
      'PROFILE_RENAME_DURABILITY_UNCONFIRMED',
      `Profile was renamed and active selection points to ${JSON.stringify(profileId)}, but durable state confirmation failed. Run \`bazframe status\`.`,
      { cause: writeError }
    );
  }
  if (committedSelection === previousProfileId) {
    try {
      await rename(directory, previousDirectory);
    } catch (rollbackError) {
      throw new BazframeError(
        'PROFILE_RENAME_RECOVERY_REQUIRED',
        `Profile directory moved to ${directory}, but active selection still points to ${JSON.stringify(previousProfileId)} and rollback failed. Repair the directory or selection manually.`,
        { cause: rollbackError }
      );
    }
    throw new BazframeError(
      'PROFILE_RENAME_ROLLED_BACK',
      `Could not update active selection while renaming profile; the directory rename was rolled back.`,
      { cause: writeError }
    );
  }
  throw new BazframeError(
    'PROFILE_RENAME_RECOVERY_REQUIRED',
    `Profile directory moved to ${directory}, but active selection coherence could not be established. Run \`bazframe status\` and repair the selection.`,
    { cause: writeError }
  );
}

function withGlobalStateLock<T>(
  bazframeHome: string,
  command: string,
  operation: () => Promise<T>
): Promise<T> {
  return withStateLock(
    join(bazframeHome, 'locks', 'state.lock'),
    { command, target: join(bazframeHome, 'profiles') },
    operation,
    { managedRoot: bazframeHome }
  );
}

async function pathMetadata(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function nonEmptyProfile(directory: string): BazframeError {
  return new BazframeError(
    'PROFILE_NOT_EMPTY',
    `Profile is not generated-empty and cannot be removed without --force: ${directory}`
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
