import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { readUtf8InstructionFile } from '../core/content.js';
import type { ChildResult } from '../core/child-process.js';
import type { InheritedChildRunner } from '../core/external-editor.js';
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
  readProfileFavorites,
  toggleProfileFavorite as toggleStoredProfileFavorite
} from '../profiles/profile-favorites.js';
import { editProfileInstructions as launchProfileInstructionEditor } from '../profiles/profile-instruction-editor.js';
import {
  captureProfileRemovalIdentity,
  type ProfileRemovalIdentity
} from '../profiles/profile-removal-identity.js';
import {
  profileDirectory,
  readActiveProfile,
  selectProfile
} from '../profiles/profile-store.js';
import { editSkillDefinition as launchSkillDefinitionEditor } from '../skills/skill-definition-editor.js';
import { assertSafeSkillId, isSafeSkillId } from '../skills/skill-id.js';
import {
  DEFAULT_SKILL_SOURCE_ID,
  DEFAULT_SKILL_SOURCE_LABEL,
  inspectDefaultSkillCatalog,
  readDefaultSkillRegistration,
  type DefaultSkillRegistration
} from '../skills/default-skill-catalog.js';
import {
  inspectAdapterStatus,
  inspectStatus,
  type StatusAdapterInspection,
  type StatusCorrectiveAction,
  type StatusInspection
} from '../status/status.js';
import {
  formatSkillCollectionDiagnostic,
  inspectGlobalSkillCollections,
  type GlobalSkillCollectionInspection,
  type SkillCollectionDiagnostic
} from '../skill-collections/skill-collection-resolver.js';
import { resolvePhysicalRelativeDirectory, verifySkillSnapshot } from '../skill-collections/skill-snapshot.js';
import { PACKAGE_MANIFEST } from '../packages/package-manifest.js';
import { canonicalPhysicalCollectionRoot, collectionKey, idForRecord, kindForRecord, skillsRootForRecord, type SkillCollectionKind } from '../skill-collections/skill-collection-store.js';
import { addLibrary as addGlobalLibrary, type SkillCollectionLifecycleResult } from '../skill-collections/skill-collection-lifecycle.js';
import {
  addManagedGitLibrary,
  isManagedGitSource,
  parseManagedGitSource,
  type ManagedGitLifecycleResult
} from '../providers/managed-git.js';
import {
  captureProfileCollectionReferenceBulkIndex,
  idForReference,
  kindForReference,
  readProfileCollectionReference,
  scanProfileCollectionReferences,
  type ProfileSkillCollectionReference
} from '../profiles/profile-skill-collection-reference.js';

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
  originId?: string;
  skillId: string;
  path: string;
  target?: string;
  kind: MembershipKind;
  manageable: boolean;
  diagnostic?: string;
}

export interface ProfileCollectionReferenceSummary {
  kind: SkillCollectionKind;
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
  favorite: boolean;
  membershipWritable: boolean;
  membershipDiagnostic?: string;
  memberships: DirectMembership[];
  libraryReferences?: ProfileCollectionReferenceSummary[];
  packageReferences?: ProfileCollectionReferenceSummary[];
}

export interface SkillSummary {
  id: string;
  originId: string;
  directory: string;
}

export interface SkillGroupSummary {
  id: string;
  label: string;
  root: string;
  canonicalRoot?: string;
  artifactWritesSupported: false;
  skills: SkillSummary[];
}

export interface SkillCollectionSummary {
  key: string;
  kind: SkillCollectionKind;
  id: string;
  root: string;
  digest: string;
  artifactRoot?: string;
  skillsRoot: string;
  refreshAvailability: 'available' | 'unavailable';
  skillCount: number;
  referenceCount: number | 'unknown';
  health: 'ready' | 'failed';
  diagnostics: string[];
}

export type DashboardSetupStatus =
  | { state: 'available'; value: StatusInspection }
  | { state: 'unavailable'; diagnostic: DashboardDiagnostic };

export interface DashboardAdapterInspection {
  adapter: StatusAdapterInspection;
  correctiveActions: readonly StatusCorrectiveAction[];
  setupDiagnostic?: DashboardDiagnostic;
}

export type DashboardAdapterStatus =
  | { state: 'available'; value: DashboardAdapterInspection }
  | { state: 'unavailable'; diagnostic: DashboardDiagnostic };

export interface DashboardSnapshot {
  revision: number;
  activeProfileId?: string;
  profiles: ProfileSummary[];
  collections?: SkillCollectionSummary[];
  skillGroups?: SkillGroupSummary[];
  availableSkillGroups?: SkillGroupSummary[];
  adapterStatus: DashboardAdapterStatus;
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
  originId: string;
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

export type LibraryInputInspection =
  | { kind: 'directory'; input: string; browser: DirectoryBrowserSnapshot }
  | {
      kind: 'managed-git';
      input: string;
      libraryId: string;
      remote: string;
    };

export type LibraryCandidateSummary =
  | {
      kind: 'directory';
      libraryId: string;
      enteredRoot: string;
      canonicalRoot: string;
      packageManifest: { state: 'absent' } | { state: 'present' };
    }
  | {
      kind: 'managed-git';
      libraryId: string;
      enteredSource: string;
      remote: string;
    };

export interface LibraryAddRequest {
  source: string;
}

export type LibraryAddResult = SkillCollectionLifecycleResult | ManagedGitLifecycleResult;

export interface MembershipReference extends SkillReference {
  membershipId: string;
}

export interface BazframeTuiService {
  loadDashboard(): Promise<DashboardSnapshot>;
  createProfile(profileId: string): Promise<void>;
  duplicateProfile(sourceProfileId: string, profileId: string): Promise<void>;
  useProfile(profileId: string): Promise<void>;
  toggleProfileFavorite(profileId: string): Promise<void>;
  renameProfile(previousProfileId: string, profileId: string): Promise<void>;
  removeProfile(profileId: string, authorization: ProfileRemovalAuthorization): Promise<void>;
  editProfileInstructions(profileId: string): Promise<ChildResult>;
  editSkillDefinition(skill: SkillReference): Promise<ChildResult>;
  addMembership(profileId: string, skill: SkillReference): Promise<void>;
  removeMembership(profileId: string, membership: MembershipReference): Promise<void>;
  loadSkillPreview(skill: SkillReference): Promise<SkillPreview>;
  inspectLibraryInput(input: string): Promise<LibraryInputInspection>;
  inspectLibraryCandidate(request: LibraryAddRequest): Promise<LibraryCandidateSummary>;
  addLibrary(request: LibraryAddRequest): Promise<LibraryAddResult>;
}

export interface BazframeTuiServiceOptions extends ProfileSkillMembershipOptions {
  bazframeVersion: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  userHome?: string;
  adapterArtifactUrl?: URL;
  editorChildRunner?: InheritedChildRunner;
}

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
    async toggleProfileFavorite(profileId) {
      await toggleStoredProfileFavorite(options.bazframeHome, profileId);
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
    async editProfileInstructions(profileId) {
      return launchProfileInstructionEditor({
        bazframeHome: options.bazframeHome,
        profileId,
        environment: options.environment,
        ...(options.editorChildRunner === undefined
          ? {}
          : { childRunner: options.editorChildRunner })
      });
    },
    async editSkillDefinition(skill) {
      assertSafeSkillId(skill.skillId);
      if (skill.originId !== DEFAULT_SKILL_SOURCE_ID) {
        throw new BazframeError(
          'SKILL_EDITOR_SOURCE_READ_ONLY',
          `Only live (default) skills can be opened in an editor: ${skill.originId}/${skill.skillId}`
        );
      }
      return launchSkillDefinitionEditor({
        bazframeHome: options.bazframeHome,
        skillId: skill.skillId,
        environment: options.environment,
        ...(options.editorChildRunner === undefined
          ? {}
          : { childRunner: options.editorChildRunner })
      });
    },
    async addMembership(profileId, skill) {
      assertKnownOrigin(skill.originId);
      await addProfileSkill(options, profileId, skill.skillId);
    },
    async removeMembership(profileId, membership) {
      assertKnownOrigin(membership.originId);
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
    async inspectLibraryInput(input) {
      return inspectLibraryInput(options, input);
    },
    async inspectLibraryCandidate(request) {
      if (isManagedGitSource(request.source)) {
        const source = parseManagedGitSource(request.source);
        return {
          kind: 'managed-git',
          libraryId: source.id,
          enteredSource: request.source,
          remote: source.remote
        };
      }
      const enteredRoot = expandBrowserPath(options, request.source);
      const canonicalRoot = await canonicalPhysicalCollectionRoot(enteredRoot, 'library');
      const libraryId = basename(canonicalRoot);
      assertSafeSkillId(libraryId);
      let packageManifest: Extract<LibraryCandidateSummary, { kind: 'directory' }>['packageManifest'] = { state: 'absent' };
      try { await lstat(join(canonicalRoot, PACKAGE_MANIFEST)); packageManifest = { state: 'present' }; }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      return { kind: 'directory', libraryId, enteredRoot, canonicalRoot, packageManifest };
    },
    async addLibrary(request) {
      if (isManagedGitSource(request.source)) {
        return addManagedGitLibrary({
          bazframeHome: options.bazframeHome,
          environment: options.environment
        }, request.source);
      }
      const root = expandBrowserPath(options, request.source);
      return addGlobalLibrary(options, root);
    }
  };
}

async function loadSkillPreview(
  options: BazframeTuiServiceOptions,
  reference: SkillReference
): Promise<SkillPreview> {
  assertSafeSkillId(reference.skillId);
  let definitionPath: string | undefined;
  if (reference.originId === DEFAULT_SKILL_SOURCE_ID) {
    try {
      const registration = await readDefaultSkillRegistration(options.bazframeHome, reference.skillId);
      definitionPath = join(registration.target, 'SKILL.md');
    } catch (error) {
      throw new BazframeError('SKILL_PREVIEW_STALE', `Skill is no longer available from (default): ${reference.skillId}`, { cause: error });
    }
  } else if (reference.originId.startsWith('library:') || reference.originId.startsWith('package:')) {
    const [kind, id] = reference.originId.split(':') as [SkillCollectionKind, string];
    if (!isSafeSkillId(id)) throw new BazframeError('SKILL_ORIGIN_UNKNOWN', `Unknown Skill origin: ${reference.originId}`);
    const global = await inspectGlobalSkillCollections(options.bazframeHome);
    const collection = global.collections.find((item) => kindForRecord(item.record) === kind && idForRecord(item.record) === id);
    if (collection === undefined || collection.diagnostics.length > 0) throw new BazframeError('SKILL_PREVIEW_STALE', `${kind === 'library' ? 'Library' : 'Package'} is unavailable: ${id}`);
    definitionPath = collection.skills.find((skill) => skill.name === reference.skillId)?.definitionPath;
  } else {
    throw new BazframeError('SKILL_ORIGIN_UNKNOWN', `Unknown Skill origin: ${reference.originId}`);
  }
  if (definitionPath === undefined) {
    throw new BazframeError(
      'SKILL_PREVIEW_STALE',
      `Skill is no longer available: ${reference.originId}/${reference.skillId}`
    );
  }
  return {
    ...reference,
    path: definitionPath,
    contents: await readUtf8InstructionFile(definitionPath, 'Skill definition')
  };
}

async function inspectLibraryInput(
  options: BazframeTuiServiceOptions,
  input: string
): Promise<LibraryInputInspection> {
  if (isManagedGitSource(input)) {
    const source = parseManagedGitSource(input);
    return {
      kind: 'managed-git',
      input,
      libraryId: source.id,
      remote: source.remote
    };
  }
  return { kind: 'directory', input, browser: await browseDirectories(options, input) };
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
        'LIBRARY_BROWSER_PATH_INVALID',
        `Path must be a physical directory: ${resolvedPath}`
      );
    }
    listRoot = await canonicalPhysicalCollectionRoot(resolvedPath, 'library');
    selectablePath = resolvedPath;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    const parent = dirname(resolvedPath);
    prefix = basename(resolvedPath);
    listRoot = await canonicalPhysicalCollectionRoot(parent, 'library');
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
          'LIBRARY_BROWSER_PATH_INVALID',
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
      throw new BazframeError('LIBRARY_BROWSER_PATH_INVALID', 'Cannot expand ~ without an absolute user home.');
    }
    return value === '~' ? resolve(userHome) : resolve(userHome, value.slice(2));
  }
  if (value.startsWith('~') || !isAbsolute(value)) {
    throw new BazframeError(
      'LIBRARY_BROWSER_PATH_INVALID',
      'Library paths must be absolute or use only the exact ~ or ~/ prefix.'
    );
  }
  return resolve(value);
}

async function inspectDashboard(
  options: BazframeTuiServiceOptions,
  revision: number
): Promise<DashboardSnapshot> {
  const diagnostics: DashboardDiagnostic[] = [];
  const activeProfileId = await inspectActiveProfile(options.bazframeHome, diagnostics);
  const favoriteProfileIds = await inspectProfileFavorites(options.bazframeHome, diagnostics);
  const defaultCatalog = await inspectDefaultSkillGroup(options, diagnostics);
  const global = await inspectGlobalSkillCollections(options.bazframeHome);
  for (const item of global.diagnostics) diagnostics.push({ id: `${item.collectionKind}-${item.collectionId}`, severity: 'error', message: formatSkillCollectionDiagnostic(item) });
  const collections: SkillCollectionSummary[] = [];
  const collectionGroups: SkillGroupSummary[] = [];
  const referenceIndex = await captureProfileCollectionReferenceBulkIndex(options.bazframeHome);
  for (const item of referenceIndex.diagnostics) diagnostics.push({ id: `collection-reference-index-${item.profileId}-${item.diagnostic.key.kind}-${item.diagnostic.path}`, severity: 'error', message: `Reference index unavailable at ${item.profileId}:${item.diagnostic.key.kind}:${item.diagnostic.path}.` });
  const referenceIndexReady = referenceIndex.diagnostics.length === 0;
  for (const item of global.collections) {
    const record = item.record; const kind = kindForRecord(record); const id = idForRecord(record); const key = collectionKey(kind, id);
    const itemDiagnostics = [...item.diagnostics.map(formatSkillCollectionDiagnostic), ...(referenceIndexReady ? [] : ['reference index unavailable'])];
    collections.push({ key, kind, id, root: record.root, digest: record.digest, ...('package' in record ? { artifactRoot: record.artifactRoot } : {}), skillsRoot: skillsRootForRecord(record), refreshAvailability: item.rebuildAvailability, skillCount: item.skills.length, referenceCount: referenceIndexReady ? (referenceIndex.profileIdsByCollection.get(key)?.length ?? 0) : 'unknown', health: item.diagnostics.length === 0 && referenceIndexReady ? 'ready' : 'failed', diagnostics: itemDiagnostics });
    if (item.diagnostics.length === 0) {
      const snapshot = await verifySkillSnapshot(options.bazframeHome, record.digest);
      const immutableRoot = await resolvePhysicalRelativeDirectory(snapshot.artifactPath, skillsRootForRecord(record));
      collectionGroups.push({ id: key, label: `${kind === 'library' ? 'Library' : 'Package'}: ${id}`, root: immutableRoot, artifactWritesSupported: false, skills: item.skills.map((skill) => ({ id: skill.name, originId: key, directory: skill.baseDir })) });
    }
  }
  const profiles = await inspectProfiles(
    options.bazframeHome,
    defaultCatalog?.registrations ?? [],
    activeProfileId,
    new Set(favoriteProfileIds),
    global,
    diagnostics
  );
  const projectedProfileIds = new Set(profiles.map((profile) => profile.id));
  for (const profileId of favoriteProfileIds) {
    if (projectedProfileIds.has(profileId)) continue;
    diagnostics.push({
      id: `profile-favorite-stale-${profileId}`,
      severity: 'warning',
      message: `Favorite profile ${JSON.stringify(profileId)} is not a current physical profile. The stored favorite is retained but not displayed.`
    });
  }
  const { adapterStatus, status } = await inspectSetupStatuses(options, diagnostics);
  const availableSkillGroups = defaultCatalog === undefined ? [] : [defaultCatalog.group];
  return {
    revision,
    ...(activeProfileId === undefined ? {} : { activeProfileId }),
    profiles,
    collections,
    skillGroups: [...availableSkillGroups, ...collectionGroups],
    availableSkillGroups,
    adapterStatus,
    status,
    diagnostics
  };
}

async function inspectSetupStatuses(
  options: BazframeTuiServiceOptions,
  diagnostics: DashboardDiagnostic[]
): Promise<{
  adapterStatus: DashboardAdapterStatus;
  status: DashboardSetupStatus;
}> {
  const inspectionOptions = {
    bazframeHome: options.bazframeHome,
    bazframeVersion: options.bazframeVersion,
    environment: options.environment,
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
    ...(options.adapterArtifactUrl === undefined
      ? {}
      : { artifactUrl: options.adapterArtifactUrl })
  };
  try {
    const value = await inspectStatus({ ...inspectionOptions, cwd: options.cwd });
    return {
      adapterStatus: {
        state: 'available',
        value: {
          adapter: value.adapter,
          correctiveActions: value.correctiveActions.filter((action) => action.id === 'adapter')
        }
      },
      status: { state: 'available', value }
    };
  } catch (error) {
    const statusDiagnostic = diagnostic('setup-status', error);
    diagnostics.push(statusDiagnostic);
    try {
      return {
        adapterStatus: {
          state: 'available',
          value: {
            adapter: await inspectAdapterStatus(inspectionOptions),
            correctiveActions: [],
            setupDiagnostic: statusDiagnostic
          }
        },
        status: { state: 'unavailable', diagnostic: statusDiagnostic }
      };
    } catch (adapterError) {
      const adapterDiagnostic = diagnostic('adapter-status', adapterError);
      diagnostics.push(adapterDiagnostic);
      return {
        adapterStatus: { state: 'unavailable', diagnostic: adapterDiagnostic },
        status: { state: 'unavailable', diagnostic: statusDiagnostic }
      };
    }
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

async function inspectProfileFavorites(
  bazframeHome: string,
  diagnostics: DashboardDiagnostic[]
): Promise<string[]> {
  try {
    return (await readProfileFavorites(bazframeHome)).favorites;
  } catch (error) {
    diagnostics.push(diagnostic('profile-favorites', error));
    return [];
  }
}

async function inspectDefaultSkillGroup(
  options: BazframeTuiServiceOptions,
  diagnostics: DashboardDiagnostic[]
): Promise<{ group: SkillGroupSummary; registrations: DefaultSkillRegistration[] } | undefined> {
  try {
    const listed = await inspectDefaultSkillCatalog(options.bazframeHome);
    for (const [index, message] of listed.diagnostics.entries()) {
      diagnostics.push({ id: `default-skill-${index}`, severity: 'warning', message });
    }
    let canonicalRoot: string | undefined;
    try { canonicalRoot = await realpath(listed.root); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    return {
      registrations: listed.registrations,
      group: {
        id: DEFAULT_SKILL_SOURCE_ID,
        label: DEFAULT_SKILL_SOURCE_LABEL,
        root: listed.root,
        ...(canonicalRoot === undefined ? {} : { canonicalRoot }),
        artifactWritesSupported: false,
        skills: listed.registrations.map((registration) => ({
          id: registration.id,
          originId: DEFAULT_SKILL_SOURCE_ID,
          directory: registration.target
        }))
      }
    };
  } catch (error) {
    diagnostics.push(diagnostic('default-skill-group', error));
    return undefined;
  }
}

async function inspectProfiles(
  bazframeHome: string,
  defaultRegistrations: readonly DefaultSkillRegistration[],
  activeProfileId: string | undefined,
  favoriteProfileIds: ReadonlySet<string>,
  globalCollections: { collections: GlobalSkillCollectionInspection[]; diagnostics: SkillCollectionDiagnostic[] },
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
            defaultRegistrations,
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
      const libraryReferences: ProfileCollectionReferenceSummary[] = [];
      const packageReferences: ProfileCollectionReferenceSummary[] = [];
      const referenceNamespace = await scanProfileCollectionReferences(bazframeHome, entry.name);
      const invalidReferencePaths = referenceNamespace.diagnostics.map((item) => `${item.key.kind}:${item.path}`);
      for (const item of referenceNamespace.diagnostics) diagnostics.push({ id: `profile-${entry.name}-${item.key.kind}-${item.path}`, severity: 'error', message: `Invalid ${item.key.kind} reference ${item.path}.` });
      const readableReferences: Array<{ reference: ProfileSkillCollectionReference; path: string }> = [];
      for (const item of referenceNamespace.references) {
        try { readableReferences.push({ reference: await readProfileCollectionReference(bazframeHome, entry.name, item.key), path: item.path }); }
        catch (error) { invalidReferencePaths.push(`${item.key.kind}:${item.relativePath}`); diagnostics.push(diagnostic(`profile-${entry.name}-${item.key.kind}-${item.relativePath}`, error)); }
      }
      const namespaceDiagnostic = invalidReferencePaths.length === 0 ? undefined : `Profile library/package reference namespace is invalid: ${[...invalidReferencePaths].sort(lexicalCompare).join(', ')}`;
      for (const item of readableReferences) {
        const kind = kindForReference(item.reference); const summary: ProfileCollectionReferenceSummary = { kind, id: idForReference(item.reference), path: item.path, ...(namespaceDiagnostic === undefined ? inspectReferenceAvailability(item.reference, globalCollections) : { availability: 'unavailable' as const, diagnostic: namespaceDiagnostic }) };
        (kind === 'library' ? libraryReferences : packageReferences).push(summary);
      }
      profiles.push({
        id: entry.name,
        directory,
        instructionsPath,
        removalIdentity,
        active: entry.name === activeProfileId,
        favorite: favoriteProfileIds.has(entry.name),
        membershipWritable,
        ...(membershipDiagnostic === undefined ? {} : { membershipDiagnostic }),
        memberships,
        libraryReferences,
        packageReferences
      });
    } catch (error) {
      diagnostics.push(diagnostic(`profile-${entry.name}`, error));
    }
  }
  profiles.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
    return lexicalCompare(left.id, right.id);
  });
  return profiles;
}

function inspectReferenceAvailability(reference:ProfileSkillCollectionReference,globalCollections:{collections:GlobalSkillCollectionInspection[];diagnostics:SkillCollectionDiagnostic[]}):Pick<ProfileCollectionReferenceSummary,'availability'|'diagnostic'>{const kind=kindForReference(reference);const id=idForReference(reference);const item=globalCollections.collections.find((entry)=>kindForRecord(entry.record)===kind&&idForRecord(entry.record)===id);if(item!==undefined&&item.diagnostics.length===0)return{availability:'available'};const failures=item?.diagnostics??globalCollections.diagnostics.filter((entry)=>entry.collectionKind===kind&&entry.collectionId===id);return{availability:'unavailable',diagnostic:failures.length===0?`Global ${kind} target is unavailable.`:failures.map(formatSkillCollectionDiagnostic).join('; ') };}

async function inspectMemberships(
  skillsDirectory: string,
  defaultRegistrations: readonly DefaultSkillRegistration[],
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
      const registration = defaultRegistrations.find((item) => item.id === entry.name);
      const managed = registration !== undefined && isAbsolute(target) && target === registration.target;
      memberships.push({
        id: entry.name,
        membershipId,
        ...(managed ? { originId: DEFAULT_SKILL_SOURCE_ID } : {}),
        skillId: entry.name,
        path,
        target,
        kind: managed ? 'managed' : 'unmanaged',
        manageable: managed,
        ...(managed
          ? {}
          : {
              diagnostic: registration === undefined
                ? '(default) registration is unavailable; membership authority cannot be verified.'
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
  return `${profileId}:default:${skillId}`;
}

function assertKnownOrigin(originId: string): void {
  if (originId !== DEFAULT_SKILL_SOURCE_ID) {
    throw new BazframeError(
      'SKILL_ORIGIN_UNKNOWN',
      `Unknown Skill origin: ${JSON.stringify(originId)}`
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
