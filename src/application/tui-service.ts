import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readUtf8InstructionFile } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  addProfile,
  duplicateProfile,
  removeProfile,
  renameProfile
} from '../profiles/profile-management.js';
import {
  addProfileSkill,
  removeProfileSkill,
  type ProfileSkillMembershipOptions
} from '../profiles/profile-skill-membership.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import {
  captureProfileRemovalIdentity,
  type ProfileRemovalIdentity
} from '../profiles/profile-removal-identity.js';
import {
  profileDirectory,
  readActiveProfile,
  selectProfile
} from '../profiles/profile-store.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { listAvailableSkills } from '../skills/skill-library.js';
import { inspectStatus, type StatusInspection } from '../status/status.js';

export type DiagnosticSeverity = 'warning' | 'error';

export interface DashboardDiagnostic {
  id: string;
  severity: DiagnosticSeverity;
  message: string;
}

export type MembershipKind = 'managed' | 'unmanaged';

export interface DirectMembership {
  id: string;
  membershipId: string;
  sourceId?: string;
  skillId: string;
  path: string;
  target?: string;
  kind: MembershipKind;
  manageable: boolean;
  diagnostic?: string;
}

export interface ProfileSummary {
  id: string;
  directory: string;
  instructionsPath: string;
  removalIdentity: ProfileRemovalIdentity;
  active: boolean;
  membershipWritable: boolean;
  membershipDiagnostic?: string;
  memberships: DirectMembership[];
}

export interface SkillSummary {
  id: string;
  sourceId: string;
  directory: string;
}

export interface SkillSourceSummary {
  id: string;
  provider: 'skillbook';
  label: string;
  root: string;
  canonicalRoot?: string;
  artifactWritesSupported: false;
  skills: SkillSummary[];
}

export type DashboardSetupStatus =
  | { state: 'available'; value: StatusInspection }
  | { state: 'unavailable'; diagnostic: DashboardDiagnostic };

export interface DashboardSnapshot {
  revision: number;
  activeProfileId?: string;
  profiles: ProfileSummary[];
  sources: SkillSourceSummary[];
  status: DashboardSetupStatus;
  diagnostics: DashboardDiagnostic[];
}

export type ProfileRemovalAuthorization =
  | { kind: 'generated-empty' }
  | {
      kind: 'recursive';
      confirmedProfileId: string;
      removalIdentity: ProfileRemovalIdentity;
    };

export interface SkillReference {
  sourceId: string;
  skillId: string;
}

export interface MembershipReference extends SkillReference {
  membershipId: string;
}

export interface BazframeTuiService {
  loadDashboard(): Promise<DashboardSnapshot>;
  createProfile(profileId: string): Promise<void>;
  duplicateProfile(sourceProfileId: string, profileId: string): Promise<void>;
  useProfile(profileId: string): Promise<void>;
  renameProfile(previousProfileId: string, profileId: string): Promise<void>;
  removeProfile(profileId: string, authorization: ProfileRemovalAuthorization): Promise<void>;
  addMembership(profileId: string, skill: SkillReference): Promise<void>;
  removeMembership(profileId: string, membership: MembershipReference): Promise<void>;
}

export interface BazframeTuiServiceOptions extends ProfileSkillMembershipOptions {
  bazframeVersion: string;
  cwd: string;
  adapterArtifactUrl?: URL;
}

const SKILLBOOK_SOURCE_ID = 'skillbook';

export function createBazframeTuiService(
  options: BazframeTuiServiceOptions
): BazframeTuiService {
  let revision = 0;

  return {
    async loadDashboard() {
      revision += 1;
      return inspectDashboard(options, revision);
    },
    async createProfile(profileId) {
      await addProfile(options.bazframeHome, profileId);
    },
    async duplicateProfile(sourceProfileId, profileId) {
      await duplicateProfile(options.bazframeHome, sourceProfileId, profileId);
    },
    async useProfile(profileId) {
      await selectProfile(options.bazframeHome, profileId);
    },
    async renameProfile(previousProfileId, profileId) {
      await renameProfile(options.bazframeHome, previousProfileId, profileId);
    },
    async removeProfile(profileId, authorization) {
      if (authorization.kind === 'recursive') {
        if (authorization.confirmedProfileId !== profileId) {
          throw new BazframeError(
            'PROFILE_REMOVE_CONFIRMATION_MISMATCH',
            `Recursive removal confirmation must exactly match ${JSON.stringify(profileId)}.`
          );
        }
        await removeProfile(options.bazframeHome, profileId, true, {
          expectedIdentity: authorization.removalIdentity
        });
        return;
      }
      await removeProfile(options.bazframeHome, profileId, false);
    },
    async addMembership(profileId, skill) {
      assertKnownSource(skill.sourceId);
      await addProfileSkill(options, profileId, skill.skillId);
    },
    async removeMembership(profileId, membership) {
      assertKnownSource(membership.sourceId);
      const expectedMembershipId = membershipProjectionId(profileId, membership.skillId);
      if (membership.membershipId !== expectedMembershipId) {
        throw new BazframeError(
          'PROFILE_SKILL_MEMBERSHIP_STALE',
          `Stale profile skill membership reference: ${JSON.stringify(membership.membershipId)}`
        );
      }
      await removeProfileSkill(options, profileId, membership.skillId);
    }
  };
}

async function inspectDashboard(
  options: BazframeTuiServiceOptions,
  revision: number
): Promise<DashboardSnapshot> {
  const diagnostics: DashboardDiagnostic[] = [];
  const activeProfileId = await inspectActiveProfile(options.bazframeHome, diagnostics);
  const source = await inspectSkillbookSource(options, diagnostics);
  const profiles = await inspectProfiles(
    options.bazframeHome,
    source?.root,
    activeProfileId,
    diagnostics
  );
  const status = await inspectSetupStatus(options, diagnostics);

  return {
    revision,
    ...(activeProfileId === undefined ? {} : { activeProfileId }),
    profiles,
    sources: source === undefined ? [] : [source],
    status,
    diagnostics
  };
}

async function inspectSetupStatus(
  options: BazframeTuiServiceOptions,
  diagnostics: DashboardDiagnostic[]
): Promise<DashboardSetupStatus> {
  try {
    return {
      state: 'available',
      value: await inspectStatus({
        bazframeHome: options.bazframeHome,
        bazframeVersion: options.bazframeVersion,
        environment: options.environment,
        cwd: options.cwd,
        ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
        ...(options.adapterArtifactUrl === undefined
          ? {}
          : { artifactUrl: options.adapterArtifactUrl })
      })
    };
  } catch (error) {
    const statusDiagnostic = diagnostic('setup-status', error);
    diagnostics.push(statusDiagnostic);
    return { state: 'unavailable', diagnostic: statusDiagnostic };
  }
}

async function inspectActiveProfile(
  bazframeHome: string,
  diagnostics: DashboardDiagnostic[]
): Promise<string | undefined> {
  try {
    return await readActiveProfile(bazframeHome);
  } catch (error) {
    if (error instanceof BazframeError && error.code === 'NO_ACTIVE_PROFILE') return undefined;
    diagnostics.push(diagnostic('active-profile', error));
    return undefined;
  }
}

async function inspectSkillbookSource(
  options: BazframeTuiServiceOptions,
  diagnostics: DashboardDiagnostic[]
): Promise<SkillSourceSummary | undefined> {
  try {
    const listed = await listAvailableSkills(options);
    for (const [index, message] of listed.diagnostics.entries()) {
      diagnostics.push({
        id: `skillbook-${index}`,
        severity: 'warning',
        message
      });
    }
    let canonicalRoot: string | undefined;
    try {
      canonicalRoot = await realpath(listed.skillsRoot);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    return {
      id: SKILLBOOK_SOURCE_ID,
      provider: 'skillbook',
      label: 'Skillbook',
      root: listed.skillsRoot,
      ...(canonicalRoot === undefined ? {} : { canonicalRoot }),
      artifactWritesSupported: false,
      skills: listed.skillIds.map((id) => ({
        id,
        sourceId: SKILLBOOK_SOURCE_ID,
        directory: join(listed.skillsRoot, id)
      }))
    };
  } catch (error) {
    diagnostics.push(diagnostic('skillbook-source', error));
    return undefined;
  }
}

async function inspectProfiles(
  bazframeHome: string,
  skillbookSkillsRoot: string | undefined,
  activeProfileId: string | undefined,
  diagnostics: DashboardDiagnostic[]
): Promise<ProfileSummary[]> {
  const root = join(bazframeHome, 'profiles');
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    diagnostics.push(diagnostic('profiles-root', error));
    return [];
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    diagnostics.push({
      id: 'profiles-root',
      severity: 'error',
      message: `Profiles path must be a physical directory: ${root}`
    });
    return [];
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    diagnostics.push(diagnostic('profiles-root', error));
    return [];
  }
  entries.sort((left, right) => lexicalCompare(left.name, right.name));

  const profiles: ProfileSummary[] = [];
  for (const entry of entries) {
    if (!isSafeProfileId(entry.name)) {
      diagnostics.push({
        id: `profile-${entry.name}`,
        severity: 'warning',
        message: `Skipping unsafe profile entry ${JSON.stringify(entry.name)}.`
      });
      continue;
    }
    const directory = profileDirectory(bazframeHome, entry.name);
    try {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new BazframeError(
          'PROFILE_NOT_PHYSICAL',
          `Profile lifecycle requires a physical directory: ${directory}`
        );
      }
      // Capture before projecting the disclosed paths and memberships. A
      // cooperating mutation can therefore only make this identity stale; it
      // cannot authorize newer profile content than the dashboard described.
      const removalIdentity = await captureProfileRemovalIdentity(directory);
      const instructionsPath = join(directory, 'AGENTS.md');
      await readUtf8InstructionFile(
        instructionsPath,
        `Profile ${JSON.stringify(entry.name)} instructions`
      );
      const skillsDirectory = join(directory, 'skills');
      let membershipWritable = false;
      let membershipDiagnostic: string | undefined;
      let memberships: DirectMembership[] = [];
      try {
        const skillsMetadata = await lstat(skillsDirectory);
        if (skillsMetadata.isSymbolicLink() || !skillsMetadata.isDirectory()) {
          membershipDiagnostic = `Profile skills path is not a physical directory: ${skillsDirectory}`;
        } else {
          membershipWritable = true;
          memberships = await inspectMemberships(
            skillsDirectory,
            skillbookSkillsRoot,
            diagnostics,
            entry.name
          );
        }
      } catch (error) {
        membershipDiagnostic = errorCode(error) === 'ENOENT'
          ? `Profile has no skills directory: ${skillsDirectory}`
          : `Could not inspect profile skills directory: ${skillsDirectory}${formatErrorCode(error)}`;
      }
      if (membershipDiagnostic !== undefined) {
        diagnostics.push({
          id: `profile-${entry.name}-skills`,
          severity: 'warning',
          message: membershipDiagnostic
        });
      }
      profiles.push({
        id: entry.name,
        directory,
        instructionsPath,
        removalIdentity,
        active: entry.name === activeProfileId,
        membershipWritable,
        ...(membershipDiagnostic === undefined ? {} : { membershipDiagnostic }),
        memberships
      });
    } catch (error) {
      diagnostics.push(diagnostic(`profile-${entry.name}`, error));
    }
  }
  return profiles;
}

async function inspectMemberships(
  skillsDirectory: string,
  skillbookSkillsRoot: string | undefined,
  diagnostics: DashboardDiagnostic[],
  profileId: string
): Promise<DirectMembership[]> {
  let entries;
  try {
    entries = await readdir(skillsDirectory, { withFileTypes: true });
  } catch (error) {
    diagnostics.push(diagnostic(`memberships-${profileId}`, error));
    return [];
  }
  entries.sort((left, right) => lexicalCompare(left.name, right.name));

  const memberships: DirectMembership[] = [];
  for (const entry of entries) {
    const path = join(skillsDirectory, entry.name);
    const membershipId = membershipProjectionId(profileId, entry.name);
    if (!isSafeSkillId(entry.name)) {
      memberships.push({
        id: entry.name,
        membershipId,
        skillId: entry.name,
        path,
        kind: 'unmanaged',
        manageable: false,
        diagnostic: 'Unsafe skill entry name.'
      });
      continue;
    }
    try {
      const metadata = await lstat(path);
      if (!metadata.isSymbolicLink()) {
        memberships.push({
          id: entry.name,
          membershipId,
          skillId: entry.name,
          path,
          kind: 'unmanaged',
          manageable: false,
          diagnostic: 'Physical profile entry; Bazframe will not change it.'
        });
        continue;
      }
      const target = await readlink(path);
      const managed = skillbookSkillsRoot !== undefined
        && isAbsolute(target)
        && resolve(target) === resolve(skillbookSkillsRoot, entry.name);
      memberships.push({
        id: entry.name,
        membershipId,
        ...(managed ? { sourceId: SKILLBOOK_SOURCE_ID } : {}),
        skillId: entry.name,
        path,
        target,
        kind: managed ? 'managed' : 'unmanaged',
        manageable: managed,
        ...(managed
          ? {}
          : {
              diagnostic: skillbookSkillsRoot === undefined
                ? 'Skillbook source root is unavailable; membership authority cannot be verified.'
                : isAbsolute(target)
                  ? `Foreign target: ${target}`
                  : `Relative target: ${target}`
            })
      });
    } catch (error) {
      memberships.push({
        id: entry.name,
        membershipId,
        skillId: entry.name,
        path,
        kind: 'unmanaged',
        manageable: false,
        diagnostic: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return memberships;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function membershipProjectionId(profileId: string, skillId: string): string {
  return `${profileId}:skillbook:${skillId}`;
}

function assertKnownSource(sourceId: string): void {
  if (sourceId !== SKILLBOOK_SOURCE_ID) {
    throw new BazframeError(
      'SKILL_SOURCE_UNKNOWN',
      `Unknown skill source: ${JSON.stringify(sourceId)}`
    );
  }
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}

function diagnostic(id: string, error: unknown): DashboardDiagnostic {
  return {
    id,
    severity: 'error',
    message: error instanceof Error ? error.message : String(error)
  };
}
