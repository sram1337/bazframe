import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { lstat, open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { MAX_EFFECTIVE_INSTRUCTION_BYTES, readUtf8InstructionFile } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { writeFileAtomic } from '../state/atomic-file.js';
import { readAtMostOneBeyond } from '../state/bounded-file-read.js';
import { withStateLock } from '../state/lock.js';
export { resolveBazframeHome } from '../state/paths.js';
import type { AddedSkillPlatformServices } from '../skills/added-skill-platform-services.js';
import { readDefaultSkillRegistration } from '../skills/default-skill-catalog.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { assertSafeProfileId } from './profile-id.js';

const ACTIVE_PROFILE_FILE = 'active-profile';
const ADDED_SKILL_NAMESPACE_ENTRY_LIMIT = 1024;
const MAX_STATE_BYTES = 1024;

export interface Profile {
  id: string;
  directory: string;
  instructionsPath: string;
  instructions: string;
  skillDirectories: string[];
}

export function profileDirectory(bazframeHome: string, profileId: string): string {
  assertSafeProfileId(profileId);
  return join(bazframeHome, 'profiles', profileId);
}

export interface ProfileLoadOptions {
  /** Internal Windows product-slice dependency; it does not bypass the public platform gate. */
  platformServices?: AddedSkillPlatformServices;
}

export async function loadProfile(
  bazframeHome: string,
  profileId: string,
  options: ProfileLoadOptions = {}
): Promise<Profile> {
  const directory = profileDirectory(bazframeHome, profileId);
  if (options.platformServices !== undefined) {
    return loadWindowsProfile(bazframeHome, profileId, directory, options.platformServices);
  }
  let metadata;
  try {
    metadata = await stat(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new BazframeError(
        'PROFILE_NOT_FOUND',
        `Profile ${JSON.stringify(profileId)} does not exist at ${directory}.`
      );
    }
    throw new BazframeError(
      'PROFILE_READ_FAILED',
      `Could not inspect profile ${JSON.stringify(profileId)} at ${directory}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (!metadata.isDirectory()) {
    throw new BazframeError(
      'PROFILE_NOT_DIRECTORY',
      `Profile ${JSON.stringify(profileId)} is not a directory: ${directory}`
    );
  }

  const instructionsPath = join(directory, 'AGENTS.md');
  const instructions = await readUtf8InstructionFile(
    instructionsPath,
    `Profile ${JSON.stringify(profileId)} instructions`
  );
  const skillDirectories = await discoverSkillDirectories(join(directory, 'skills'));

  return {
    id: profileId,
    directory,
    instructionsPath,
    instructions,
    skillDirectories
  };
}

async function loadWindowsProfile(
  bazframeHome: string,
  profileId: string,
  directory: string,
  platformServices: AddedSkillPlatformServices
): Promise<Profile> {
  try {
    platformServices.inspectPrivateDirectory(directory);
  } catch (error) {
    if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') {
      throw new BazframeError(
        'PROFILE_NOT_FOUND',
        `Profile ${JSON.stringify(profileId)} does not exist at ${directory}.`
      );
    }
    throw new BazframeError(
      'PROFILE_READ_FAILED',
      `Could not inspect profile ${JSON.stringify(profileId)} at ${directory}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  const instructionsPath = join(directory, 'AGENTS.md');
  const instructions = await platformServices.readStableUtf8File(
    instructionsPath,
    `Profile ${JSON.stringify(profileId)} instructions`,
    MAX_EFFECTIVE_INSTRUCTION_BYTES
  );
  const skillsRoot = join(directory, 'skills');
  let enumeration;
  try {
    enumeration = await platformServices.enumeratePrivateDirectory(
      skillsRoot,
      ADDED_SKILL_NAMESPACE_ENTRY_LIMIT
    );
  } catch (error) {
    if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') {
      enumeration = { names: [], entries: [], identity: 'absent' };
    }
    else throw new BazframeError(
      'SKILLS_READ_FAILED',
      `Could not inspect profile skills directory: ${skillsRoot}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  const skillDirectories: string[] = [];
  for (const skillId of enumeration.names) {
    if (!isSafeSkillId(skillId)) {
      throw new BazframeError(
        'SKILL_READ_FAILED',
        `Could not inspect unsafe profile skill candidate: ${join(skillsRoot, skillId)}`
      );
    }
    let registration;
    try {
      registration = await readDefaultSkillRegistration(
        bazframeHome,
        skillId,
        { platformServices }
      );
      const membership = platformServices.inspectSkillLink(
        skillsRoot,
        skillId,
        registration.target
      );
      if (membership.kind !== 'current') throw new Error('membership disappeared');
    } catch (error) {
      throw new BazframeError(
        'SKILL_READ_FAILED',
        `Could not prove catalog-backed profile skill candidate: ${join(skillsRoot, skillId)}${formatErrorCode(error)}`,
        { cause: error }
      );
    }
    skillDirectories.push(registration.target);
  }
  if (enumeration.identity !== 'absent') {
    const after = await platformServices.enumeratePrivateDirectory(
      skillsRoot,
      ADDED_SKILL_NAMESPACE_ENTRY_LIMIT
    );
    if (after.identity !== enumeration.identity
      || after.names.join('\0') !== enumeration.names.join('\0')) {
      throw new BazframeError(
        'SKILLS_READ_FAILED',
        `Profile skills directory changed while being inspected: ${skillsRoot}`
      );
    }
  }
  return { id: profileId, directory, instructionsPath, instructions, skillDirectories };
}

export async function discoverSkillDirectories(skillsRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new BazframeError(
      'SKILLS_READ_FAILED',
      `Could not inspect profile skills directory: ${skillsRoot}${formatErrorCode(error)}`,
      { cause: error }
    );
  }

  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const candidate = join(skillsRoot, entry.name);
    let candidateMetadata;
    try {
      candidateMetadata = await stat(candidate);
    } catch (error) {
      throw new BazframeError(
        'SKILL_READ_FAILED',
        `Could not inspect profile skill candidate: ${candidate}${formatErrorCode(error)}`,
        { cause: error }
      );
    }
    if (!candidateMetadata.isDirectory()) continue;

    const skillFile = join(candidate, 'SKILL.md');
    try {
      const skillMetadata = await stat(skillFile);
      if (skillMetadata.isFile()) result.push(candidate);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new BazframeError(
          'SKILL_READ_FAILED',
          `Could not inspect profile skill definition: ${skillFile}${formatErrorCode(error)}`,
          { cause: error }
        );
      }
    }
  }
  return result;
}

export interface ActiveProfileSnapshot {
  profileId: string;
  path: string;
  device: bigint;
  inode: bigint;
  contentSha256: string;
}

export interface ActiveProfileSnapshotReadOptions {
  testHooks?: {
    afterInitialStat?: () => void | Promise<void>;
    afterPathStat?: () => void | Promise<void>;
    afterClose?: () => void | Promise<void>;
  };
}

export async function readOptionalActiveProfileSnapshot(
  bazframeHome: string,
  options: ActiveProfileSnapshotReadOptions = {}
): Promise<ActiveProfileSnapshot | undefined> {
  const statePath = join(bazframeHome, ACTIVE_PROFILE_FILE);
  let handle: FileHandle | undefined;
  let snapshot: ActiveProfileSnapshot | undefined;
  let operationError: unknown;
  try {
    try {
      handle = await open(
        statePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      if (errorCode(error) === 'ELOOP') {
        throw new BazframeError(
          'INVALID_ACTIVE_PROFILE_STATE',
          `Active-profile state must be a regular UTF-8 file no larger than ${MAX_STATE_BYTES} bytes: ${statePath}`,
          { cause: error }
        );
      }
      throw error;
    }
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_STATE_BYTES)) {
      throw new BazframeError(
        'INVALID_ACTIVE_PROFILE_STATE',
        `Active-profile state must be a regular UTF-8 file no larger than ${MAX_STATE_BYTES} bytes: ${statePath}`
      );
    }
    await options.testHooks?.afterInitialStat?.();
    const bytes = await readAtMostOneBeyond(handle, MAX_STATE_BYTES);
    const afterRead = await handle.stat({ bigint: true });
    const current = await lstat(statePath, { bigint: true });
    await options.testHooks?.afterPathStat?.();
    const final = await handle.stat({ bigint: true });
    const finalPath = await lstat(statePath, { bigint: true });
    if (bytes.byteLength > MAX_STATE_BYTES) {
      throw new BazframeError(
        'INVALID_ACTIVE_PROFILE_STATE',
        `Active-profile state exceeds ${MAX_STATE_BYTES} bytes: ${statePath}`
      );
    }
    if (!afterRead.isFile()
      || !final.isFile()
      || current.isSymbolicLink()
      || !current.isFile()
      || finalPath.isSymbolicLink()
      || !finalPath.isFile()
      || before.dev !== afterRead.dev
      || before.ino !== afterRead.ino
      || afterRead.dev !== current.dev
      || afterRead.ino !== current.ino
      || current.dev !== final.dev
      || current.ino !== final.ino
      || finalPath.dev !== final.dev
      || finalPath.ino !== final.ino
      || before.size !== afterRead.size
      || before.mtimeNs !== afterRead.mtimeNs
      || before.ctimeNs !== afterRead.ctimeNs
      || afterRead.size !== final.size
      || afterRead.mtimeNs !== final.mtimeNs
      || afterRead.ctimeNs !== final.ctimeNs
      || current.size !== final.size
      || current.mtimeNs !== final.mtimeNs
      || current.ctimeNs !== final.ctimeNs
      || finalPath.size !== final.size
      || finalPath.mtimeNs !== final.mtimeNs
      || finalPath.ctimeNs !== final.ctimeNs
      || BigInt(bytes.byteLength) !== final.size) {
      throw new BazframeError(
        'INVALID_ACTIVE_PROFILE_STATE',
        `Active-profile state changed while being read: ${statePath}`
      );
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new BazframeError(
        'INVALID_ACTIVE_PROFILE_STATE',
        `Active-profile state is not valid UTF-8: ${statePath}`,
        { cause: error }
      );
    }
    if (text.includes('\0')) {
      throw new BazframeError(
        'INVALID_ACTIVE_PROFILE_STATE',
        `Active-profile state contains a NUL byte: ${statePath}`
      );
    }
    const profileId = text.endsWith('\r\n')
      ? text.slice(0, -2)
      : text.endsWith('\n')
        ? text.slice(0, -1)
        : text;
    assertSafeProfileId(profileId);
    snapshot = {
      profileId,
      path: statePath,
      device: before.dev,
      inode: before.ino,
      contentSha256: createHash('sha256').update(bytes).digest('hex')
    };
  } catch (error) {
    operationError = error instanceof BazframeError ? error : stateReadError(statePath, error);
  }
  if (handle !== undefined) {
    try {
      await handle.close();
      await options.testHooks?.afterClose?.();
    } catch (error) {
      operationError ??= stateReadError(statePath, error);
    }
  }
  if (operationError !== undefined) throw operationError;
  return snapshot;
}

export async function readActiveProfile(bazframeHome: string): Promise<string> {
  const snapshot = await readOptionalActiveProfileSnapshot(bazframeHome);
  if (snapshot === undefined) {
    throw new BazframeError(
      'NO_ACTIVE_PROFILE',
      'No active profile. Run `bazframe profile use <profile>` first.'
    );
  }
  return snapshot.profileId;
}

export async function selectProfile(
  bazframeHome: string,
  profileId: string
): Promise<Profile> {
  assertSafeProfileId(profileId);
  const statePath = join(bazframeHome, ACTIVE_PROFILE_FILE);
  return withStateLock(
    join(bazframeHome, 'locks', 'state.lock'),
    { command: 'bazframe profile use', target: statePath },
    async () => {
      const profile = await loadProfile(bazframeHome, profileId);
      await writeFileAtomic(statePath, `${profileId}\n`, { managedRoot: bazframeHome });
      return profile;
    },
    { managedRoot: bazframeHome }
  );
}

export async function writeActiveProfile(
  bazframeHome: string,
  profileId: string
): Promise<void> {
  assertSafeProfileId(profileId);
  const statePath = join(bazframeHome, ACTIVE_PROFILE_FILE);
  await withStateLock(
    join(bazframeHome, 'locks', 'state.lock'),
    { command: 'bazframe profile use', target: statePath },
    () => writeFileAtomic(statePath, `${profileId}\n`, { managedRoot: bazframeHome }),
    { managedRoot: bazframeHome }
  );
}

function stateReadError(statePath: string, error: unknown): BazframeError {
  return new BazframeError(
    'ACTIVE_PROFILE_READ_FAILED',
    `Could not read active-profile state: ${statePath}${formatErrorCode(error)}`,
    { cause: error }
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
