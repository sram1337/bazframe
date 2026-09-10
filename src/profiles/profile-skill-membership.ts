import { ADDED_SKILL_NAMESPACE_ENTRY_LIMIT } from '../skills/added-skill-platform-services.js';
import { constants } from 'node:fs';
import { lstat, open, readlink, symlink, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MAX_EFFECTIVE_INSTRUCTION_BYTES, readUtf8InstructionFile } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  inspectDefaultSkillCatalog,
  readDefaultSkillRegistration,
  readDefaultSkillRegistrationLink,
  suggestSkillIds
} from '../skills/default-skill-catalog.js';
import type {
  AddedSkillMutationAuthority,
  AddedSkillPlatformServices
} from '../skills/added-skill-platform-services.js';
import { assertSafeSkillId } from '../skills/skill-id.js';
import { withStateLock } from '../state/lock.js';
import { assertSafeProfileId } from './profile-id.js';
import { profileDirectory, readActiveProfile, type ActiveProfileReadServices } from './profile-store.js';

export { readSkillDeclaredName } from '../skills/skill-metadata.js';
export type ProfileSkillMembershipAction = 'added' | 'current' | 'removed' | 'absent';
export interface ProfileSkillMembershipResult {
  action: ProfileSkillMembershipAction;
  profileId: string;
  skillId: string;
  sourceDirectory: string;
  membershipPath: string;
}

/** Deterministic namespace-substitution seam used only by lifecycle tests. */
export interface ProfileSkillMembershipTestHooks {
  beforeCommit?: () => void | Promise<void>;
}
export interface ProfileSkillMembershipOptions {
  bazframeHome: string;
  testHooks?: ProfileSkillMembershipTestHooks;
  /** Internal Windows product-slice dependency; it does not bypass the public platform gate. */
  platformServices?: AddedSkillPlatformServices;
  selectionReadServices?: ActiveProfileReadServices;
}

interface DirectoryIdentity { device: bigint; inode: bigint }
interface OpenDirectory { path: string; handle: FileHandle; identity: DirectoryIdentity }
interface MembershipPaths {
  profileId: string;
  membershipPath: string;
  parents: OpenDirectory[];
}

export async function addActiveProfileSkill(options: ProfileSkillMembershipOptions, skillId: string): Promise<ProfileSkillMembershipResult> {
  assertSafeSkillId(skillId);
  return addProfileSkillFor(options, undefined, skillId);
}
export async function addProfileSkill(options: ProfileSkillMembershipOptions, profileId: string, skillId: string): Promise<ProfileSkillMembershipResult> {
  assertSafeProfileId(profileId); assertSafeSkillId(skillId);
  return addProfileSkillFor(options, profileId, skillId);
}
async function addProfileSkillFor(options: ProfileSkillMembershipOptions, profileId: string | undefined, skillId: string): Promise<ProfileSkillMembershipResult> {
  if (options.platformServices !== undefined) {
    if (profileId === undefined && options.selectionReadServices === undefined && options.platformServices.selectionReadServices === undefined) throw windowsExplicitProfileRequired();
    return addWindowsProfileSkill(
      { ...options, platformServices: options.platformServices },
      profileId,
      skillId
    );
  }
  return withProfileMembershipLock(options, profileId, skillId, 'bazframe profile skill add', async (paths) => {
    const registration = await resolveRegistration(options.bazframeHome, skillId);
    const existing = await inspectMembership(paths.membershipPath, registration.target);
    if (existing === 'current') return result(paths, registration.target, skillId, 'current');
    await options.testHooks?.beforeCommit?.();
    await assertParentsStable(paths.parents);
    const current = await readDefaultSkillRegistration(options.bazframeHome, skillId);
    if (current.target !== registration.target) throw changedRegistration(skillId);
    await assertParentsStable(paths.parents);
    try { await symlink(registration.target, paths.membershipPath, 'dir'); }
    catch (error) {
      if (errorCode(error) === 'EEXIST') {
        const raced = await inspectMembership(paths.membershipPath, registration.target);
        if (raced === 'current') return result(paths, registration.target, skillId, 'current');
      }
      if (error instanceof BazframeError) throw error;
      throw new BazframeError('PROFILE_SKILL_ADD_FAILED', `Could not add profile skill membership ${paths.membershipPath}${formatCode(error)}`, { cause: error });
    }
    await assertParentsStable(paths.parents);
    return result(paths, registration.target, skillId, 'added');
  });
}

export async function removeActiveProfileSkill(options: ProfileSkillMembershipOptions, skillId: string): Promise<ProfileSkillMembershipResult> {
  assertSafeSkillId(skillId);
  return removeProfileSkillFor(options, undefined, skillId);
}
export async function removeProfileSkill(options: ProfileSkillMembershipOptions, profileId: string, skillId: string): Promise<ProfileSkillMembershipResult> {
  assertSafeProfileId(profileId); assertSafeSkillId(skillId);
  return removeProfileSkillFor(options, profileId, skillId);
}
async function removeProfileSkillFor(options: ProfileSkillMembershipOptions, profileId: string | undefined, skillId: string): Promise<ProfileSkillMembershipResult> {
  if (options.platformServices !== undefined) {
    if (profileId === undefined && options.selectionReadServices === undefined && options.platformServices.selectionReadServices === undefined) throw windowsExplicitProfileRequired();
    return removeWindowsProfileSkill(
      { ...options, platformServices: options.platformServices },
      profileId,
      skillId
    );
  }
  return withProfileMembershipLock(options, profileId, skillId, 'bazframe profile skill remove', async (paths) => {
    const registration = await readDefaultSkillRegistrationLink(options.bazframeHome, skillId);
    const existing = await inspectMembership(paths.membershipPath, registration.target);
    if (existing === 'absent') return result(paths, registration.target, skillId, 'absent');
    await options.testHooks?.beforeCommit?.();
    await assertParentsStable(paths.parents);
    const current = await readDefaultSkillRegistrationLink(options.bazframeHome, skillId);
    if (current.target !== registration.target) throw changedRegistration(skillId);
    await inspectMembership(paths.membershipPath, registration.target);
    await assertParentsStable(paths.parents);
    try { await unlink(paths.membershipPath); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') return result(paths, registration.target, skillId, 'absent');
      throw new BazframeError('PROFILE_SKILL_REMOVE_FAILED', `Could not remove profile skill membership ${paths.membershipPath}${formatCode(error)}`, { cause: error });
    }
    await assertParentsStable(paths.parents);
    return result(paths, registration.target, skillId, 'removed');
  });
}

async function addWindowsProfileSkill(
  options: ProfileSkillMembershipOptions & { platformServices: AddedSkillPlatformServices },
  profileId: string | undefined,
  skillId: string
): Promise<ProfileSkillMembershipResult> {
  return withWindowsProfileMembershipLock(
    options,
    profileId,
    skillId,
    'bazframe profile skill add',
    async (membershipPath, skillsDirectory, authority, namespaceIdentity, resolvedProfileId, validateSelection, ensureNamespace) => {
      const registration = await resolveRegistration(
        options.bazframeHome,
        skillId,
        options.platformServices
      );
      const existing = namespaceIdentity === undefined ? { kind: 'absent' as const } : options.platformServices.inspectSkillLink(
        skillsDirectory,
        skillId,
        registration.target
      );
      if (existing.kind === 'current') {
        return windowsResult(resolvedProfileId, membershipPath, registration.target, skillId, 'current');
      }
      await options.testHooks?.beforeCommit?.();
      const current = await readDefaultSkillRegistration(
        options.bazframeHome,
        skillId,
        { platformServices: options.platformServices }
      );
      if (current.target !== registration.target) throw changedRegistration(skillId);
      await validateSelection();
      await ensureNamespace();
      const action = await options.platformServices.createSkillLink(
        authority,
        skillsDirectory,
        skillId,
        registration.target
      );
      return windowsResult(resolvedProfileId, membershipPath, registration.target, skillId, action);
    }
  );
}

async function removeWindowsProfileSkill(
  options: ProfileSkillMembershipOptions & { platformServices: AddedSkillPlatformServices },
  profileId: string | undefined,
  skillId: string
): Promise<ProfileSkillMembershipResult> {
  return withWindowsProfileMembershipLock(
    options,
    profileId,
    skillId,
    'bazframe profile skill remove',
    async (membershipPath, skillsDirectory, authority, namespaceIdentity, resolvedProfileId, validateSelection) => {
      const registration = await readDefaultSkillRegistrationLink(
        options.bazframeHome,
        skillId,
        { platformServices: options.platformServices }
      );
      if (namespaceIdentity === undefined) return windowsResult(resolvedProfileId, membershipPath, registration.target, skillId, 'absent');
      const existing = options.platformServices.inspectSkillLink(
        skillsDirectory,
        skillId,
        registration.target
      );
      if (existing.kind === 'absent') {
        return windowsResult(resolvedProfileId, membershipPath, registration.target, skillId, 'absent');
      }
      await options.testHooks?.beforeCommit?.();
      const current = await readDefaultSkillRegistrationLink(
        options.bazframeHome,
        skillId,
        { platformServices: options.platformServices }
      );
      if (current.target !== registration.target) throw changedRegistration(skillId);
      if (options.platformServices.inspectPrivateDirectory(skillsDirectory).identity !== namespaceIdentity) {
        throw new BazframeError(
          'PROFILE_SKILL_NAMESPACE_CHANGED',
          `Profile skill namespace changed while in use: ${skillsDirectory}`
        );
      }
      await validateSelection();
      const action = await options.platformServices.removeSkillLink(
        authority,
        skillsDirectory,
        skillId,
        registration.target
      );
      return windowsResult(resolvedProfileId, membershipPath, registration.target, skillId, action);
    }
  );
}

async function withWindowsProfileMembershipLock<T>(
  options: ProfileSkillMembershipOptions & { platformServices: AddedSkillPlatformServices },
  profileId: string | undefined,
  skillId: string,
  command: string,
  operation: (
    membershipPath: string,
    skillsDirectory: string,
    authority: AddedSkillMutationAuthority,
    namespaceIdentity: string | undefined,
    resolvedProfileId: string,
    validateSelection: () => Promise<void>,
    ensureNamespace: () => Promise<void>
  ) => Promise<T>
): Promise<T> {
  const pathJoin = options.platformServices.joinPath ?? join;
  const selectionReads = options.selectionReadServices ?? options.platformServices.selectionReadServices;
  return options.platformServices.withLock(
    pathJoin(options.bazframeHome, 'locks', 'state.lock'),
    { command, target: profileId === undefined ? pathJoin(options.bazframeHome, 'active-profile') : pathJoin(options.bazframeHome, 'profiles', profileId) },
    async (stateAuthority) => {
      const resolvedProfileId = profileId ?? await readActiveProfile(options.bazframeHome, selectionReads);
      const directory = pathJoin(options.bazframeHome, 'profiles', resolvedProfileId);
      const skillsDirectory = pathJoin(directory, 'skills');
      const membershipPath = pathJoin(skillsDirectory, skillId);
      return options.platformServices.withLock(
        pathJoin(options.bazframeHome, 'locks', 'profiles', `${resolvedProfileId}.skills.lock`),
        { command, target: membershipPath },
        async (profileAuthority) => {
          const authority = { assertHeld() { stateAuthority.assertHeld(); profileAuthority.assertHeld(); } };
          authority.assertHeld();
          options.platformServices.inspectPrivateDirectory(pathJoin(options.bazframeHome, 'profiles'));
          const profile = options.platformServices.inspectPrivateDirectory(directory);
          await options.platformServices.readStableUtf8File(pathJoin(directory, 'AGENTS.md'), `Profile ${JSON.stringify(resolvedProfileId)} instructions`, MAX_EFFECTIVE_INSTRUCTION_BYTES);
          const namespace = await optionalWindowsSkillNamespace(options.platformServices, directory, skillsDirectory);
          async function validateSelection() {
            authority.assertHeld();
            if (profileId === undefined && await readActiveProfile(options.bazframeHome, selectionReads) !== resolvedProfileId) throw new BazframeError('PROFILE_SELECTION_CHANGED', 'Active profile changed before membership mutation.');
            authority.assertHeld();
          }
          await validateSelection();
          async function ensureNamespace() {
            await validateSelection();
            if (options.platformServices.inspectPrivateDirectory(directory).identity !== profile.identity) throw new BazframeError('PROFILE_SKILL_NAMESPACE_CHANGED', 'Profile changed before creating Skill membership.');
            const current = await optionalWindowsSkillNamespace(options.platformServices, directory, skillsDirectory);
            if (current?.identity !== namespace?.identity) throw new BazframeError('PROFILE_SKILL_NAMESPACE_CHANGED', 'Skill namespace changed before membership mutation.');
            authority.assertHeld();
            if (current === undefined) options.platformServices.ensurePrivateDirectory(directory, 'skills');
            authority.assertHeld();
          }
          const value = await operation(membershipPath, skillsDirectory, authority, namespace?.identity, resolvedProfileId, validateSelection, ensureNamespace);
          await validateSelection(); return value;
        }
      );
    }
  );
}

async function optionalWindowsSkillNamespace(platform: AddedSkillPlatformServices, profile: string, skills: string) {
  try { return platform.inspectPrivateDirectory(skills); }
  catch (error) {
    if (errorCode(error) !== 'WINDOWS_NATIVE_PATH_NOT_FOUND') throw error;
    const names = (await platform.enumeratePrivateDirectory(profile, ADDED_SKILL_NAMESPACE_ENTRY_LIMIT)).names;
    if (names.some((name) => name.normalize('NFC').toLowerCase() === 'skills')) throw error;
    return undefined;
  }
}

function windowsResult(
  profileId: string,
  membershipPath: string,
  sourceDirectory: string,
  skillId: string,
  action: ProfileSkillMembershipAction
): ProfileSkillMembershipResult {
  return { action, profileId, skillId, sourceDirectory, membershipPath };
}

function windowsExplicitProfileRequired(): BazframeError {
  return new BazframeError(
    'WINDOWS_PROFILE_SKILL_EXPLICIT_PROFILE_REQUIRED',
    'The internal Windows added-Skill slice requires an explicit profile.'
  );
}

async function withProfileMembershipLock<T>(
  options: ProfileSkillMembershipOptions,
  requestedProfileId: string | undefined,
  skillId: string,
  command: string,
  operation: (paths: MembershipPaths) => Promise<T>
): Promise<T> {
  return withStateLock(join(options.bazframeHome, 'locks', 'state.lock'), {
    command,
    target: requestedProfileId === undefined ? join(options.bazframeHome, 'active-profile') : profileDirectory(options.bazframeHome, requestedProfileId)
  }, async () => {
    const profileId = requestedProfileId ?? await readActiveProfile(options.bazframeHome);
    const directory = profileDirectory(options.bazframeHome, profileId);
    const skillsDirectory = join(directory, 'skills');
    const membershipPath = join(skillsDirectory, skillId);
    return withStateLock(join(options.bazframeHome, 'locks', 'profiles', `${profileId}.skills.lock`), { command, target: membershipPath }, async () => {
      const parents: OpenDirectory[] = [];
      try {
        parents.push(await openPhysicalDirectory(join(options.bazframeHome, 'profiles'), 'Profiles directory'));
        parents.push(await openPhysicalDirectory(directory, requestedProfileId === undefined ? `Active profile ${JSON.stringify(profileId)}` : `Profile ${JSON.stringify(profileId)}`));
        await readUtf8InstructionFile(join(directory, 'AGENTS.md'), `Profile ${JSON.stringify(profileId)} instructions`);
        parents.push(await openPhysicalDirectory(skillsDirectory, 'Profile skills directory'));
        await assertParentsStable(parents);
        return await operation({ profileId, membershipPath, parents });
      } finally {
        for (const parent of [...parents].reverse()) await parent.handle.close().catch(() => undefined);
      }
    }, { managedRoot: options.bazframeHome });
  }, { managedRoot: options.bazframeHome });
}

async function resolveRegistration(
  home: string,
  skillId: string,
  platformServices?: AddedSkillPlatformServices
) {
  try {
    return await readDefaultSkillRegistration(
      home,
      skillId,
      platformServices === undefined ? {} : { platformServices }
    );
  }
  catch (error) {
    if (error instanceof BazframeError && error.code === 'DEFAULT_SKILL_NOT_FOUND') {
      const available = await inspectDefaultSkillCatalog(
        home,
        platformServices === undefined ? {} : { platformServices }
      );
      const suggestions = suggestSkillIds(skillId, available.skillIds);
      const suggestion = suggestions.length === 0
        ? ' Run `bazframe skill list` to list registered skills or `bazframe skill add <absolute-root>`.'
        : suggestions.length === 1 ? ` Did you mean ${JSON.stringify(suggestions[0])}?`
          : ` Did you mean one of ${suggestions.map((item) => JSON.stringify(item)).join(', ')}?`;
      throw new BazframeError('SKILL_NOT_FOUND', `Default skill ${JSON.stringify(skillId)} is not registered.${suggestion}`, { cause: error });
    }
    throw error;
  }
}

async function openPhysicalDirectory(path: string, label: string): Promise<OpenDirectory> {
  let metadata;
  try { metadata = await lstat(path, { bigint: true }); }
  catch (error) {
    throw new BazframeError('DIRECTORY_READ_FAILED', `${label} must be an existing physical directory: ${path}${formatCode(error)}`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError('DIRECTORY_NOT_PHYSICAL', `${label} must be an existing physical directory: ${path}`);
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    const directory = { path, handle, identity: identity(metadata) };
    if (!opened.isDirectory() || !sameIdentity(identity(opened), directory.identity)) throw new Error('directory identity changed');
    await assertDirectoryStable(directory);
    return directory;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof BazframeError) throw error;
    throw new BazframeError('DIRECTORY_NOT_PHYSICAL', `${label} must remain a stable physical directory: ${path}${formatCode(error)}`, { cause: error });
  }
}

async function assertParentsStable(parents: readonly OpenDirectory[]): Promise<void> {
  for (const parent of [...parents].reverse()) await assertDirectoryStable(parent);
}

async function assertDirectoryStable(directory: OpenDirectory): Promise<void> {
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }), lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || !sameIdentity(identity(opened), directory.identity) || !sameIdentity(identity(current), directory.identity)) {
    throw new BazframeError('PROFILE_SKILL_NAMESPACE_CHANGED', `Profile skill namespace changed while in use: ${directory.path}`);
  }
}

async function inspectMembership(membershipPath: string, expectedTarget: string): Promise<'absent' | 'current'> {
  let metadata;
  try { metadata = await lstat(membershipPath); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return 'absent';
    throw new BazframeError('PROFILE_SKILL_READ_FAILED', `Could not inspect profile skill entry: ${membershipPath}${formatCode(error)}`, { cause: error });
  }
  if (!metadata.isSymbolicLink()) throw unmanagedMembership(membershipPath, 'is a physical entry');
  let target: string;
  try { target = await readlink(membershipPath); }
  catch (error) { throw new BazframeError('PROFILE_SKILL_READ_FAILED', `Could not read profile skill membership link: ${membershipPath}${formatCode(error)}`, { cause: error }); }
  if (!isAbsolute(target)) throw unmanagedMembership(membershipPath, `uses a relative target ${JSON.stringify(target)}`);
  if (target !== expectedTarget) throw unmanagedMembership(membershipPath, `targets ${JSON.stringify(target)}`);
  return 'current';
}

function identity(metadata: { dev: bigint; ino: bigint }): DirectoryIdentity { return { device: metadata.dev, inode: metadata.ino }; }
function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.device === right.device && left.inode === right.inode; }
function result(paths: MembershipPaths, sourceDirectory: string, skillId: string, action: ProfileSkillMembershipAction): ProfileSkillMembershipResult {
  return { action, skillId, sourceDirectory, profileId: paths.profileId, membershipPath: paths.membershipPath };
}
function unmanagedMembership(path: string, detail: string): BazframeError { return new BazframeError('PROFILE_SKILL_ENTRY_UNMANAGED', `Refusing to change unmanaged profile skill entry ${path}: it ${detail}.`); }
function changedRegistration(skillId: string): BazframeError { return new BazframeError('DEFAULT_SKILL_CHANGED', `Default skill registration changed while updating profile membership: ${skillId}.`); }
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
