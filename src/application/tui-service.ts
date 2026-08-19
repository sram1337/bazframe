import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
import { assertSafeSkillId, isSafeSkillId } from '../skills/skill-id.js';
import { listAvailableSkills } from '../skills/skill-library.js';
import { inspectStatus, type StatusInspection } from '../status/status.js';
import {
  formatSourceDiagnostic,
  inspectGlobalSources,
  type GlobalSourceInspection,
  type SourceDiagnostic
} from '../source-units/source-unit-resolver.js';
import { resolvePhysicalRelativeDirectory, verifySourceSnapshot } from '../source-units/source-snapshot.js';
import { readOptionalSourceBuildManifest, type SourceBuildManifest } from '../source-units/source-build-manifest.js';
import { canonicalPhysicalSourceRoot } from '../sources/source-store.js';
import { addSource as addGlobalSource, type SourceLifecycleResult } from '../sources/source-lifecycle.js';
import {
  captureProfileSourceReferenceBulkIndex,
  profileSourceReferenceKey,
  readProfileSourceReference,
  scanProfileSourceReferences,
  type ProfileSourceReference
} from '../profiles/profile-source-reference.js';

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

export interface ProfileSourceReferenceSummary extends ProfileSourceReference {
  id: string;
  path: string;
  availability: 'available' | 'unavailable';
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
  sourceReferences?: ProfileSourceReferenceSummary[];
}

export interface SkillSummary {
  id: string;
  sourceId: string;
  directory: string;
}

export interface SkillSourceSummary {
  id: string;
  label: string;
  root: string;
  canonicalRoot?: string;
  artifactWritesSupported: false;
  skills: SkillSummary[];
}

export interface ManagedSourceSummary {
  id: string;
  source: string;
  root: string;
  digest: string;
  sourceUnitRoot: string;
  rebuildAvailability: 'available' | 'unavailable';
  referenceCount: number | 'unknown';
  health: 'ready' | 'failed';
  diagnostics: string[];
}

export type DashboardSetupStatus =
  | { state: 'available'; value: StatusInspection }
  | { state: 'unavailable'; diagnostic: DashboardDiagnostic };

export interface DashboardSnapshot {
  revision: number;
  activeProfileId?: string;
  profiles: ProfileSummary[];
  managedSources?: ManagedSourceSummary[];
  skillRoots?: SkillSourceSummary[];
  availableSkillSources?: SkillSourceSummary[];
  /** Test-fixture compatibility only; production dashboards use the separated collections above. */
  sources?: SkillSourceSummary[];
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

export interface SkillPreview extends SkillReference {
  path: string;
  contents: string;
}

export interface DirectoryBrowserEntry {
  name: string;
  path: string;
}

export interface DirectoryBrowserSnapshot {
  input: string;
  resolvedPath: string;
  selectablePath?: string;
  entries: DirectoryBrowserEntry[];
}

export interface SourceCandidateSummary {
  sourceId: string;
  enteredRoot: string;
  canonicalRoot: string;
  manifest:
    | { state: 'absent' }
    | { state: 'present'; value: SourceBuildManifest }
    | { state: 'invalid'; diagnostic: string };
}

export interface SourceAddRequest {
  root: string;
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
  loadSkillPreview(skill: SkillReference): Promise<SkillPreview>;
  browseDirectories(input: string): Promise<DirectoryBrowserSnapshot>;
  inspectSourceCandidate(request: SourceAddRequest): Promise<SourceCandidateSummary>;
  addSource(request: SourceAddRequest): Promise<SourceLifecycleResult>;
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
    },
    async loadSkillPreview(skill) {
      return loadSkillPreview(options, skill);
    },
    async browseDirectories(input) {
      return browseDirectories(options, input);
    },
    async inspectSourceCandidate(request) {
      const enteredRoot = expandBrowserPath(options, request.root);
      const canonicalRoot = await canonicalPhysicalSourceRoot(enteredRoot);
      const sourceId = basename(canonicalRoot);
      assertSafeSkillId(sourceId);
      try {
        const manifest = await readOptionalSourceBuildManifest(canonicalRoot);
        return {
          sourceId,
          enteredRoot,
          canonicalRoot,
          manifest: manifest === undefined
            ? { state: 'absent' }
            : { state: 'present', value: manifest }
        };
      } catch (error) {
        return {
          sourceId,
          enteredRoot,
          canonicalRoot,
          manifest: { state: 'invalid', diagnostic: messageFor(error) }
        };
      }
    },
    async addSource(request) {
      const root = expandBrowserPath(options, request.root);
      return addGlobalSource(options, root, { declaredBuild: 'reject' });
    }
  };
}

async function loadSkillPreview(
  options: BazframeTuiServiceOptions,
  reference: SkillReference
): Promise<SkillPreview> {
  assertSafeSkillId(reference.skillId);
  let definitionPath: string | undefined;
  if (reference.sourceId === SKILLBOOK_SOURCE_ID) {
    const listed = await listAvailableSkills(options);
    if (!listed.skillIds.includes(reference.skillId)) {
      throw new BazframeError(
        'SKILL_PREVIEW_STALE',
        `Skill is no longer available from Skillbook: ${reference.skillId}`
      );
    }
    definitionPath = join(listed.skillsRoot, reference.skillId, 'SKILL.md');
  } else if (reference.sourceId.startsWith('managed:')) {
    const sourceId = reference.sourceId.slice('managed:'.length);
    if (!isSafeSkillId(sourceId)) {
      throw new BazframeError('SKILL_SOURCE_UNKNOWN', `Unknown skill source: ${reference.sourceId}`);
    }
    const global = await inspectGlobalSources(options.bazframeHome);
    const source = global.sources.find((item) => item.record.source === sourceId);
    if (source === undefined || source.diagnostics.length > 0) {
      throw new BazframeError(
        'SKILL_PREVIEW_STALE',
        `Managed source is unavailable: ${sourceId}`
      );
    }
    definitionPath = source.skills.find((skill) => skill.name === reference.skillId)?.definitionPath;
  } else {
    throw new BazframeError('SKILL_SOURCE_UNKNOWN', `Unknown skill source: ${reference.sourceId}`);
  }
  if (definitionPath === undefined) {
    throw new BazframeError(
      'SKILL_PREVIEW_STALE',
      `Skill is no longer available: ${reference.sourceId}/${reference.skillId}`
    );
  }
  return {
    ...reference,
    path: definitionPath,
    contents: await readUtf8InstructionFile(definitionPath, 'Skill definition')
  };
}

async function browseDirectories(
  options: BazframeTuiServiceOptions,
  input: string
): Promise<DirectoryBrowserSnapshot> {
  const resolvedPath = expandBrowserPath(options, input);
  await assertNoExplicitAncestorSymlink(
    resolvedPath,
    input.length === 0
      ? resolvedPath
      : input === '~' || input.startsWith('~/')
        ? expandBrowserPath(options, '~')
        : undefined
  );
  let listRoot: string;
  let selectablePath: string | undefined;
  let prefix = '';
  try {
    const metadata = await lstat(resolvedPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new BazframeError(
        'SOURCE_BROWSER_PATH_INVALID',
        `Path must be a physical directory: ${resolvedPath}`
      );
    }
    listRoot = await canonicalPhysicalSourceRoot(resolvedPath);
    selectablePath = resolvedPath;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    const parent = dirname(resolvedPath);
    prefix = basename(resolvedPath);
    listRoot = await canonicalPhysicalSourceRoot(parent);
  }
  const entries: DirectoryBrowserEntry[] = [];
  for (const entry of (await readdir(listRoot, { withFileTypes: true }))
    .sort((left, right) => lexicalCompare(left.name, right.name))) {
    if (!entry.name.startsWith(prefix)) continue;
    const path = join(listRoot, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    entries.push({ name: entry.name, path });
  }
  return {
    input,
    resolvedPath,
    ...(selectablePath === undefined ? {} : { selectablePath }),
    entries
  };
}

async function assertNoExplicitAncestorSymlink(
  path: string,
  implicitRoot?: string
): Promise<void> {
  const ancestors: string[] = [];
  for (
    let current = path;
    dirname(current) !== current && current !== implicitRoot;
    current = dirname(current)
  ) {
    ancestors.push(current);
  }
  for (const ancestor of ancestors.reverse()) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink()) {
        throw new BazframeError(
          'SOURCE_BROWSER_PATH_INVALID',
          `Path traverses a symbolic link instead of physical directories: ${ancestor}`
        );
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
  }
}

function expandBrowserPath(options: BazframeTuiServiceOptions, input: string): string {
  const value = input.length === 0 ? options.cwd : input;
  if (value === '~' || value.startsWith('~/')) {
    const userHome = options.userHome ?? options.environment.HOME;
    if (userHome === undefined || !isAbsolute(userHome)) {
      throw new BazframeError('SOURCE_BROWSER_PATH_INVALID', 'Cannot expand ~ without an absolute user home.');
    }
    return value === '~' ? resolve(userHome) : resolve(userHome, value.slice(2));
  }
  if (value.startsWith('~') || !isAbsolute(value)) {
    throw new BazframeError(
      'SOURCE_BROWSER_PATH_INVALID',
      'Source paths must be absolute or use only the exact ~ or ~/ prefix.'
    );
  }
  return resolve(value);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectDashboard(
  options: BazframeTuiServiceOptions,
  revision: number
): Promise<DashboardSnapshot> {
  const diagnostics: DashboardDiagnostic[] = [];
  const activeProfileId = await inspectActiveProfile(options.bazframeHome, diagnostics);
  const skillbook = await inspectSkillbookSource(options, diagnostics);
  const global = await inspectGlobalSources(options.bazframeHome);
  for (const item of global.diagnostics) diagnostics.push({ id: `managed-source-${item.sourceId}`, severity: 'error', message: `${item.sourceId}:${item.path} ${item.category}` });
  const managedSources: ManagedSourceSummary[] = [];
  const managedRoots: SkillSourceSummary[] = [];
  const referenceIndex = await captureProfileSourceReferenceBulkIndex(options.bazframeHome);
  for (const item of referenceIndex.diagnostics) diagnostics.push({
    id: `managed-source-reference-index-${item.profileId}-${item.diagnostic.path}`,
    severity: 'error',
    message: `Reference index unavailable at ${item.profileId}:${item.diagnostic.path}.`
  });
  const referenceIndexReady = referenceIndex.diagnostics.length === 0;
  for (const item of global.sources) {
    const record = item.record;
    const referenceKey = profileSourceReferenceKey(record.source);
    const id = `managed:${record.source}`;
    const sourceDiagnostics = [
      ...item.diagnostics.map((entry) => `${entry.path} ${entry.category}`),
      ...(referenceIndexReady ? [] : ['reference index unavailable'])
    ];
    const sourceHealthy = item.diagnostics.length === 0 && referenceIndexReady;
    managedSources.push({
      id,
      source: record.source,
      root: record.root,
      digest: record.digest,
      sourceUnitRoot: record.sourceUnitRoot,
      rebuildAvailability: item.rebuildAvailability,
      referenceCount: referenceIndexReady
        ? (referenceIndex.profileIdsBySource.get(referenceKey)?.length ?? 0)
        : 'unknown',
      health: sourceHealthy ? 'ready' : 'failed',
      diagnostics: sourceDiagnostics
    });
    if (item.diagnostics.length === 0) {
      const snapshot = await verifySourceSnapshot(options.bazframeHome, record.digest);
      const immutableRoot = await resolvePhysicalRelativeDirectory(
        snapshot.artifactRoot,
        record.sourceUnitRoot
      );
      managedRoots.push({
        id,
        label: record.source,
        root: immutableRoot,
        artifactWritesSupported: false,
        skills: item.skills.map((skill) => ({ id: skill.name, sourceId: id, directory: skill.baseDir }))
      });
    }
  }
  const profiles = await inspectProfiles(
    options.bazframeHome,
    skillbook?.root,
    activeProfileId,
    global,
    diagnostics
  );
  const status = await inspectSetupStatus(options, diagnostics);
  const availableSkillSources = skillbook === undefined ? [] : [skillbook];
  return {
    revision,
    ...(activeProfileId === undefined ? {} : { activeProfileId }),
    profiles,
    managedSources,
    skillRoots: [...availableSkillSources, ...managedRoots],
    availableSkillSources,
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
  globalSources: { sources: GlobalSourceInspection[]; diagnostics: SourceDiagnostic[] },
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
      const sourceReferences: ProfileSourceReferenceSummary[] = [];
      const referenceNamespace = await scanProfileSourceReferences(bazframeHome, entry.name);
      const invalidReferencePaths = referenceNamespace.diagnostics.map((item) => item.path);
      for (const item of referenceNamespace.diagnostics) diagnostics.push({ id: `profile-${entry.name}-source-${item.path}`, severity: 'error', message: `Invalid source reference ${item.path}.` });
      const readableReferences: Array<{ reference: ProfileSourceReference; path: string }> = [];
      for (const item of referenceNamespace.references) {
        try {
          readableReferences.push({
            reference: await readProfileSourceReference(bazframeHome, entry.name, item.source),
            path: item.path
          });
        } catch (error) {
          invalidReferencePaths.push(item.relativePath);
          diagnostics.push(diagnostic(`profile-${entry.name}-source-${item.relativePath}`, error));
        }
      }
      const namespaceDiagnostic = invalidReferencePaths.length === 0
        ? undefined
        : `Profile source reference namespace is invalid: ${[...invalidReferencePaths].sort(lexicalCompare).join(', ')}`;
      for (const item of readableReferences) {
        const availability = namespaceDiagnostic === undefined
          ? inspectReferenceAvailability(item.reference, globalSources)
          : { availability: 'unavailable' as const, diagnostic: namespaceDiagnostic };
        sourceReferences.push({
          ...item.reference,
          id: item.reference.source,
          path: item.path,
          ...availability
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
        memberships,
        sourceReferences
      });
    } catch (error) {
      diagnostics.push(diagnostic(`profile-${entry.name}`, error));
    }
  }
  return profiles;
}

function inspectReferenceAvailability(
  reference: ProfileSourceReference,
  globalSources: { sources: GlobalSourceInspection[]; diagnostics: SourceDiagnostic[] }
): Pick<ProfileSourceReferenceSummary, 'availability' | 'diagnostic'> {
  const source = globalSources.sources.find((item) => item.record.source === reference.source);
  if (source !== undefined && source.diagnostics.length === 0) {
    return { availability: 'available' };
  }
  const failures = source?.diagnostics ?? globalSources.diagnostics.filter((item) =>
    item.sourceId === reference.source
  );
  return {
    availability: 'unavailable',
    diagnostic: failures.length === 0
      ? 'Global source target is unavailable.'
      : failures.map(formatSourceDiagnostic).join('; ')
  };
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
