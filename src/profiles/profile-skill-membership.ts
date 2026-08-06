import { lstat, readlink, symlink, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readUtf8InstructionFile } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { assertSafeSkillId } from '../skills/skill-id.js';
import { readSkillDeclaredName, SKILL_DEFINITION } from '../skills/skill-metadata.js';
import { listAvailableSkills, suggestSkillIds } from '../skills/skill-library.js';
import { withStateLock } from '../state/lock.js';
import { resolveSkillbookLibrary } from '../state/paths.js';
import { assertSafeProfileId } from './profile-id.js';
import { profileDirectory, readActiveProfile } from './profile-store.js';

export { readSkillDeclaredName } from '../skills/skill-metadata.js';

export type ProfileSkillMembershipAction = 'added' | 'current' | 'removed' | 'absent';

export interface ProfileSkillMembershipResult {
  action: ProfileSkillMembershipAction;
  profileId: string;
  skillId: string;
  sourceDirectory: string;
  membershipPath: string;
}

export interface ProfileSkillMembershipOptions {
  bazframeHome: string;
  environment: NodeJS.ProcessEnv;
  userHome?: string;
}

export async function addActiveProfileSkill(
  options: ProfileSkillMembershipOptions,
  skillId: string
): Promise<ProfileSkillMembershipResult> {
  assertSafeSkillId(skillId);
  return addProfileSkillFor(options, undefined, skillId);
}

export async function addProfileSkill(
  options: ProfileSkillMembershipOptions,
  profileId: string,
  skillId: string
): Promise<ProfileSkillMembershipResult> {
  assertSafeProfileId(profileId);
  assertSafeSkillId(skillId);
  return addProfileSkillFor(options, profileId, skillId);
}

async function addProfileSkillFor(
  options: ProfileSkillMembershipOptions,
  profileId: string | undefined,
  skillId: string
): Promise<ProfileSkillMembershipResult> {
  return withProfileMembershipLock(
    options,
    profileId,
    skillId,
    'bazframe profile skills add',
    async (paths) => {
      await assertAvailableSkillSource(options, paths.sourceDirectory, skillId);
      const declaredName = await readSkillDeclaredName(paths.sourceDirectory);
      if (declaredName !== skillId) {
        throw new BazframeError(
          'SKILL_NAME_MISMATCH',
          `Skillbook skill ${JSON.stringify(skillId)} declares frontmatter name ${JSON.stringify(declaredName)} in ${join(paths.sourceDirectory, SKILL_DEFINITION)}.`
        );
      }

      const existing = await inspectMembership(paths.membershipPath, paths.sourceDirectory);
      if (existing === 'current') return result(paths, skillId, 'current');

      try {
        await symlink(paths.sourceDirectory, paths.membershipPath, 'dir');
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          const raced = await inspectMembership(paths.membershipPath, paths.sourceDirectory);
          if (raced === 'current') return result(paths, skillId, 'current');
        }
        if (error instanceof BazframeError) throw error;
        throw new BazframeError(
          'PROFILE_SKILL_ADD_FAILED',
          `Could not add profile skill membership ${paths.membershipPath}${formatErrorCode(error)}`,
          { cause: error }
        );
      }
      return result(paths, skillId, 'added');
    }
  );
}

export async function removeActiveProfileSkill(
  options: ProfileSkillMembershipOptions,
  skillId: string
): Promise<ProfileSkillMembershipResult> {
  assertSafeSkillId(skillId);
  return removeProfileSkillFor(options, undefined, skillId);
}

export async function removeProfileSkill(
  options: ProfileSkillMembershipOptions,
  profileId: string,
  skillId: string
): Promise<ProfileSkillMembershipResult> {
  assertSafeProfileId(profileId);
  assertSafeSkillId(skillId);
  return removeProfileSkillFor(options, profileId, skillId);
}

async function removeProfileSkillFor(
  options: ProfileSkillMembershipOptions,
  profileId: string | undefined,
  skillId: string
): Promise<ProfileSkillMembershipResult> {
  return withProfileMembershipLock(
    options,
    profileId,
    skillId,
    'bazframe profile skills remove',
    async (paths) => {
      const existing = await inspectMembership(paths.membershipPath, paths.sourceDirectory);
      if (existing === 'absent') return result(paths, skillId, 'absent');

      // Narrow the external-writer race before unlinking. Bazframe writers also hold both locks.
      await inspectMembership(paths.membershipPath, paths.sourceDirectory);
      try {
        await unlink(paths.membershipPath);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return result(paths, skillId, 'absent');
        throw new BazframeError(
          'PROFILE_SKILL_REMOVE_FAILED',
          `Could not remove profile skill membership ${paths.membershipPath}${formatErrorCode(error)}`,
          { cause: error }
        );
      }
      return result(paths, skillId, 'removed');
    }
  );
}

interface MembershipPaths {
  profileId: string;
  sourceDirectory: string;
  membershipPath: string;
}

async function withProfileMembershipLock<T>(
  options: ProfileSkillMembershipOptions,
  requestedProfileId: string | undefined,
  skillId: string,
  command: string,
  operation: (paths: MembershipPaths) => Promise<T>
): Promise<T> {
  const stateLock = join(options.bazframeHome, 'locks', 'state.lock');
  return withStateLock(
    stateLock,
    {
      command,
      target: requestedProfileId === undefined
        ? join(options.bazframeHome, 'active-profile')
        : profileDirectory(options.bazframeHome, requestedProfileId)
    },
    async () => {
      const profileId = requestedProfileId ?? await readActiveProfile(options.bazframeHome);
      const directory = profileDirectory(options.bazframeHome, profileId);
      const skillsDirectory = join(directory, 'skills');
      const library = resolveSkillbookLibrary(options.environment, options.userHome);
      const sourceDirectory = resolve(library, 'skills', skillId);
      const membershipPath = join(skillsDirectory, skillId);
      const paths = { profileId, sourceDirectory, membershipPath };

      return withStateLock(
        join(options.bazframeHome, 'locks', 'profiles', `${profileId}.skills.lock`),
        { command, target: membershipPath },
        async () => {
          await assertPhysicalDirectory(
            join(options.bazframeHome, 'profiles'),
            'Profiles directory'
          );
          await assertPhysicalDirectory(
            directory,
            requestedProfileId === undefined
              ? `Active profile ${JSON.stringify(profileId)}`
              : `Profile ${JSON.stringify(profileId)}`
          );
          await readUtf8InstructionFile(
            join(directory, 'AGENTS.md'),
            `Profile ${JSON.stringify(profileId)} instructions`
          );
          await assertPhysicalDirectory(skillsDirectory, 'Profile skills directory');
          return operation(paths);
        },
        { managedRoot: options.bazframeHome }
      );
    },
    { managedRoot: options.bazframeHome }
  );
}

async function assertAvailableSkillSource(
  options: ProfileSkillMembershipOptions,
  sourceDirectory: string,
  skillId: string
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(sourceDirectory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      const available = await listAvailableSkills(options);
      const suggestions = suggestSkillIds(skillId, available.skillIds);
      const suggestion = suggestions.length === 0
        ? ' Run `bazframe skills` to list available skills.'
        : suggestions.length === 1
          ? ` Did you mean ${JSON.stringify(suggestions[0])}?`
          : ` Did you mean one of ${suggestions.map((candidate) => JSON.stringify(candidate)).join(', ')}?`;
      throw new BazframeError(
        'SKILL_NOT_FOUND',
        `Skillbook skill ${JSON.stringify(skillId)} does not exist at ${sourceDirectory}.${suggestion}`,
        { cause: error }
      );
    }
    throw new BazframeError(
      'DIRECTORY_READ_FAILED',
      `Skillbook skill must be an existing physical directory: ${sourceDirectory}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError(
      'DIRECTORY_NOT_PHYSICAL',
      `Skillbook skill must be an existing physical directory: ${sourceDirectory}`
    );
  }
}

async function assertPhysicalDirectory(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new BazframeError(
      'DIRECTORY_READ_FAILED',
      `${label} must be an existing physical directory: ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError(
      'DIRECTORY_NOT_PHYSICAL',
      `${label} must be an existing physical directory: ${path}`
    );
  }
}

async function inspectMembership(
  membershipPath: string,
  expectedTarget: string
): Promise<'absent' | 'current'> {
  let metadata;
  try {
    metadata = await lstat(membershipPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'absent';
    throw new BazframeError(
      'PROFILE_SKILL_READ_FAILED',
      `Could not inspect profile skill entry: ${membershipPath}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (!metadata.isSymbolicLink()) {
    throw unmanagedMembership(membershipPath, 'is a physical entry');
  }

  let target: string;
  try {
    target = await readlink(membershipPath);
  } catch (error) {
    throw new BazframeError(
      'PROFILE_SKILL_READ_FAILED',
      `Could not read profile skill membership link: ${membershipPath}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (!isAbsolute(target)) {
    throw unmanagedMembership(membershipPath, `uses a relative target ${JSON.stringify(target)}`);
  }
  if (resolve(target) !== expectedTarget) {
    throw unmanagedMembership(membershipPath, `targets ${JSON.stringify(target)}`);
  }
  return 'current';
}

function result(
  paths: MembershipPaths,
  skillId: string,
  action: ProfileSkillMembershipAction
): ProfileSkillMembershipResult {
  return { action, skillId, ...paths };
}

function unmanagedMembership(path: string, detail: string): BazframeError {
  return new BazframeError(
    'PROFILE_SKILL_ENTRY_UNMANAGED',
    `Refusing to change unmanaged profile skill entry ${path}: it ${detail}.`
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
