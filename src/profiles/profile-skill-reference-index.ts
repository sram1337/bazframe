import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, readdir, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { errorCode } from '../core/errors.js';
import type { AddedSkillPlatformServices } from '../skills/added-skill-platform-services.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { isSafeProfileId } from './profile-id.js';

export interface ProfileSkillReferenceDiagnostic {
  profileId: string;
  path: string;
}

export interface ProfileSkillReferenceIndex {
  profileIds: string[];
  diagnostics: ProfileSkillReferenceDiagnostic[];
  identity: string;
}

/** Deterministic namespace-substitution seam used only by lifecycle tests. */
export interface ProfileSkillReferenceIndexTestHooks {
  afterProfileOpened?: (profileId: string) => void | Promise<void>;
  afterSkillsOpened?: (profileId: string) => void | Promise<void>;
  /** Internal Windows product-slice dependency; it does not bypass the public platform gate. */
  platformServices?: AddedSkillPlatformServices;
}

const ADDED_SKILL_NAMESPACE_ENTRY_LIMIT = 1024;

interface DirectoryIdentity { device: bigint; inode: bigint }
interface OpenDirectory { path: string; handle: FileHandle; identity: DirectoryIdentity }

export async function captureProfileSkillReferenceIndex(
  home: string,
  skillId: string,
  expectedTarget: string,
  testHooks: ProfileSkillReferenceIndexTestHooks = {}
): Promise<ProfileSkillReferenceIndex> {
  if (testHooks.platformServices !== undefined) {
    return captureWindowsProfileSkillReferenceIndex(
      home,
      skillId,
      expectedTarget,
      testHooks.platformServices,
      testHooks
    );
  }
  const profilesRoot = join(home, 'profiles');
  let rootMetadata;
  try { rootMetadata = await lstat(profilesRoot, { bigint: true }); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return indexed([], [], ['profiles:absent']);
    return invalidIndex(profilesRoot);
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return invalidIndex(profilesRoot);

  let root: OpenDirectory | undefined;
  try {
    root = await openDirectory(profilesRoot, identity(rootMetadata));
    const identityParts = [`profiles:${identityText(root.identity)}`];
    const profileIds: string[] = [];
    const diagnostics: ProfileSkillReferenceDiagnostic[] = [];
    for (const profileId of await enumerateDirectory(root)) {
      const directory = join(profilesRoot, profileId);
      if (!isSafeProfileId(profileId)) {
        diagnostics.push({ profileId: '<unknown-profile>', path: directory });
        identityParts.push(`profile:${profileId}:unsafe`);
        continue;
      }
      let profileMetadata;
      try { profileMetadata = await lstat(directory, { bigint: true }); }
      catch {
        diagnostics.push({ profileId, path: directory });
        identityParts.push(`profile:${profileId}:unreadable`);
        continue;
      }
      identityParts.push(`profile:${profileId}:${kind(profileMetadata)}:${identityText(identity(profileMetadata))}`);
      if (profileMetadata.isSymbolicLink() || !profileMetadata.isDirectory()) {
        diagnostics.push({ profileId, path: directory });
        continue;
      }

      let profile: OpenDirectory | undefined;
      let skills: OpenDirectory | undefined;
      try {
        profile = await openDirectory(directory, identity(profileMetadata));
        await testHooks.afterProfileOpened?.(profileId);
        await assertDirectoryStable(profile);
        const skillsDirectory = join(directory, 'skills');
        let skillsMetadata;
        try { skillsMetadata = await lstat(skillsDirectory, { bigint: true }); }
        catch (error) {
          if (errorCode(error) === 'ENOENT') {
            identityParts.push(`skills:${profileId}:absent`);
            await assertDirectoryStable(profile);
            continue;
          }
          throw error;
        }
        identityParts.push(`skills:${profileId}:${kind(skillsMetadata)}:${identityText(identity(skillsMetadata))}`);
        if (skillsMetadata.isSymbolicLink() || !skillsMetadata.isDirectory()) {
          diagnostics.push({ profileId, path: skillsDirectory });
          continue;
        }
        skills = await openDirectory(skillsDirectory, identity(skillsMetadata));
        await testHooks.afterSkillsOpened?.(profileId);
        await assertDirectoryStable(skills);
        const membershipPath = join(skillsDirectory, skillId);
        try {
          const membership = await lstat(membershipPath, { bigint: true });
          if (!membership.isSymbolicLink()) {
            identityParts.push(`membership:${profileId}:${kind(membership)}:${identityText(identity(membership))}`);
          } else {
            const target = await readlink(membershipPath);
            identityParts.push(`membership:${profileId}:link:${identityText(identity(membership))}:${target}`);
            if (isAbsolute(target) && target === expectedTarget) profileIds.push(profileId);
          }
        } catch (error) {
          if (errorCode(error) === 'ENOENT') {
            identityParts.push(`membership:${profileId}:absent`);
          } else {
            diagnostics.push({ profileId, path: membershipPath });
            identityParts.push(`membership:${profileId}:unreadable`);
          }
        }
        await assertDirectoryStable(skills);
        await assertDirectoryStable(profile);
      } catch {
        diagnostics.push({ profileId, path: directory });
        identityParts.push(`profile:${profileId}:unstable`);
      } finally {
        await skills?.handle.close().catch(() => undefined);
        await profile?.handle.close().catch(() => undefined);
      }
    }
    await assertDirectoryStable(root);
    return indexed(profileIds, diagnostics, identityParts);
  } catch {
    return invalidIndex(profilesRoot);
  } finally {
    await root?.handle.close().catch(() => undefined);
  }
}

async function captureWindowsProfileSkillReferenceIndex(
  home: string,
  skillId: string,
  expectedTarget: string,
  platformServices: AddedSkillPlatformServices,
  testHooks: ProfileSkillReferenceIndexTestHooks
): Promise<ProfileSkillReferenceIndex> {
  const profilesRoot = join(home, 'profiles');
  let root;
  try {
    root = await platformServices.enumeratePrivateDirectory(
      profilesRoot,
      ADDED_SKILL_NAMESPACE_ENTRY_LIMIT
    );
  } catch (error) {
    if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') {
      return indexed([], [], ['profiles:absent']);
    }
    return invalidIndex(profilesRoot);
  }
  const profileIds: string[] = [];
  const diagnostics: ProfileSkillReferenceDiagnostic[] = [];
  const identityParts = [`profiles:${root.identity}`];
  for (const profileId of root.names) {
    const profilePath = join(profilesRoot, profileId);
    if (!isSafeProfileId(profileId)) {
      diagnostics.push({ profileId: '<unknown-profile>', path: profilePath });
      identityParts.push(`profile:${profileId}:unsafe`);
      continue;
    }
    try {
      const profile = platformServices.inspectPrivateDirectory(profilePath);
      identityParts.push(`profile:${profileId}:${profile.identity}`);
      await testHooks.afterProfileOpened?.(profileId);
      const skillsPath = join(profilePath, 'skills');
      let skills;
      try {
        skills = await platformServices.enumeratePrivateDirectory(
          skillsPath,
          ADDED_SKILL_NAMESPACE_ENTRY_LIMIT
        );
      } catch (error) {
        if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') {
          identityParts.push(`skills:${profileId}:absent`);
          if (platformServices.inspectPrivateDirectory(profilePath).identity !== profile.identity) {
            throw new Error('profile changed', { cause: error });
          }
          continue;
        }
        throw error;
      }
      identityParts.push(`skills:${profileId}:${skills.identity}`);
      for (const entry of skills.entries) {
        if (!isSafeSkillId(entry.name)
          || !entry.directory
          || entry.reparseTag !== 0xa0000003) {
          diagnostics.push({ profileId, path: join(skillsPath, entry.name) });
          identityParts.push(`skills-entry:${profileId}:${entry.name}:unsupported`);
        }
      }
      await testHooks.afterSkillsOpened?.(profileId);
      const aliases = skills.names.filter((name) => portableKey(name) === portableKey(skillId));
      if (aliases.length === 0) {
        identityParts.push(`membership:${profileId}:absent`);
      } else if (aliases.length !== 1 || aliases[0] !== skillId) {
        diagnostics.push({ profileId, path: join(skillsPath, aliases[0] ?? skillId) });
        identityParts.push(`membership:${profileId}:ambiguous`);
      } else {
        const membership = platformServices.inspectSkillLink(
          skillsPath,
          skillId,
          expectedTarget
        );
        identityParts.push(`membership:${profileId}:${membership.identity}`);
        if (membership.kind !== 'current') throw new Error('membership disappeared');
        profileIds.push(profileId);
      }
      const skillsAfter = await platformServices.enumeratePrivateDirectory(
        skillsPath,
        ADDED_SKILL_NAMESPACE_ENTRY_LIMIT
      );
      if (!sameEnumeration(skills, skillsAfter)) throw new Error('skills changed');
      if (platformServices.inspectPrivateDirectory(profilePath).identity !== profile.identity) {
        throw new Error('profile changed');
      }
    } catch {
      diagnostics.push({ profileId, path: profilePath });
      identityParts.push(`profile:${profileId}:unstable`);
    }
  }
  try {
    const after = await platformServices.enumeratePrivateDirectory(
      profilesRoot,
      ADDED_SKILL_NAMESPACE_ENTRY_LIMIT
    );
    if (after.identity !== root.identity || after.names.join('\0') !== root.names.join('\0')) {
      return invalidIndex(profilesRoot);
    }
  } catch {
    return invalidIndex(profilesRoot);
  }
  return indexed(profileIds, diagnostics, identityParts);
}

export function sameProfileSkillReferenceIndex(
  left: ProfileSkillReferenceIndex,
  right: ProfileSkillReferenceIndex
): boolean {
  return left.identity === right.identity;
}

async function openDirectory(path: string, expected: DirectoryIdentity): Promise<OpenDirectory> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(identity(opened), expected)) throw new Error('directory identity changed');
    const directory = { path, handle, identity: expected };
    await assertDirectoryStable(directory);
    return directory;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function enumerateDirectory(directory: OpenDirectory): Promise<string[]> {
  await assertDirectoryStable(directory);
  const names = (await readdir(directory.path)).sort(compare);
  await assertDirectoryStable(directory);
  return names;
}

async function assertDirectoryStable(directory: OpenDirectory): Promise<void> {
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }), lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || !sameIdentity(identity(opened), directory.identity) || !sameIdentity(identity(current), directory.identity)) {
    throw new Error('directory identity changed');
  }
}

function invalidIndex(path: string): ProfileSkillReferenceIndex {
  return indexed([], [{ profileId: '<unknown-profile>', path }], ['profiles:invalid']);
}

function indexed(
  profileIds: string[],
  diagnostics: ProfileSkillReferenceDiagnostic[],
  identityParts: string[]
): ProfileSkillReferenceIndex {
  const sortedProfiles = [...new Set(profileIds)].sort(compare);
  const sortedDiagnostics = [...diagnostics].sort((left, right) =>
    compare(`${left.profileId}\0${left.path}`, `${right.profileId}\0${right.path}`));
  const material = [
    ...identityParts.sort(compare),
    ...sortedDiagnostics.map((item) => `diagnostic:${item.profileId}:${item.path}`)
  ].join('\n');
  return {
    profileIds: sortedProfiles,
    diagnostics: sortedDiagnostics,
    identity: createHash('sha256').update(material).digest('hex')
  };
}

function identity(metadata: { dev: bigint; ino: bigint }): DirectoryIdentity { return { device: metadata.dev, inode: metadata.ino }; }
function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.device === right.device && left.inode === right.inode; }
function identityText(value: DirectoryIdentity): string { return `${value.device}:${value.inode}`; }
function kind(metadata: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): string {
  return metadata.isSymbolicLink() ? 'link' : metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other';
}
function sameEnumeration(
  left: { names: string[]; identity: string },
  right: { names: string[]; identity: string }
): boolean {
  return left.identity === right.identity && left.names.join('\0') === right.names.join('\0');
}
function portableKey(value: string): string { return value.normalize('NFC').toLowerCase(); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
