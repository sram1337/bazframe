import { constants, type Dir } from 'node:fs';
import {
  lstat,
  open,
  opendir,
  readlink,
  realpath,
  type FileHandle
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readPhysicalInstructionSnapshot } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { boundedPathForDisplay, boundedTextForDisplay } from '../core/safe-text.js';
import {
  classifyManagedGitImportResource,
  sameManagedGitExportHealth,
  type ManagedGitExportHealthSnapshot,
  type ManagedGitImportResourceClassification
} from '../providers/managed-git.js';
import {
  readOptionalActiveProfileSnapshot,
  profileDirectory,
  type ActiveProfileSnapshot
} from '../profiles/profile-store.js';
import {
  readProfileCollectionReferenceSnapshot
} from '../profiles/profile-skill-collection-reference.js';
import {
  resolveGlobalSkillCollection,
  validateCapturedSkillComposition,
  type DerivedSkill,
  type FlatSkillIdentity,
  type SkillCollectionDiagnostic
} from '../skill-collections/skill-collection-resolver.js';
import type { LibraryRecord } from '../skill-collections/skill-collection-store.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { assertSafeSkillId } from '../skills/skill-id.js';
import {
  assertReadOnlyPathAnchor,
  closeReadOnlyPathAnchor,
  holdReadOnlyPathAnchor
} from '../state/read-only-path-anchor.js';
import {
  assertStage2ProfileArtifactCapabilities,
  type LocalMappingArtifactSource,
  type ProfileArtifactResource,
  type RemoteGitArtifactSource
} from './profile-artifact.js';
import {
  captureLocalLibraryMapping,
  classifyLocalLibraryImportResource,
  sameLocalLibraryHealth,
  type LocalLibraryHealthSnapshot,
  type LocalLibraryImportResourceClassification,
  type LocalLibraryMappingSnapshot,
  type ProfileImportMappingInput
} from './profile-import-local-library.js';
import {
  readProfileArtifactDirectory,
  type ProfileArtifactDirectorySnapshot
} from './profile-artifact-io.js';
import {
  PROFILE_PORTABILITY_PRODUCTION_LIMITS,
  profileArtifactLimitPolicy,
  type ProfileArtifactLimitPolicy
} from './profile-portability-policy.js';

export type ResourceImportAction = 'create' | 'reuse' | 'blocked';
export type ProfileImportAction = 'publish' | 'reuse' | 'blocked';
export type CompositionPlanStatus = 'ready' | 'deferred' | 'blocked';

export interface ProfileImportBlocker {
  code: string;
  key: string;
  message: string;
}

export type ResourceImportPlan =
  | {
    kind: 'skill' | 'library';
    id: string;
    source: RemoteGitArtifactSource;
    action: ResourceImportAction;
    reason?: string;
    networkRequired: boolean;
    buildRequired: false;
  }
  | {
    kind: 'library';
    id: string;
    source: LocalMappingArtifactSource & { root?: string };
    action: ResourceImportAction;
    reason?: string;
    networkRequired: false;
    buildRequired: false;
  };

export interface ActiveSelectionImportPlan {
  state: 'absent' | 'selected' | 'blocked';
  profileId?: string;
  reason?: string;
  willChange: false;
}

export interface ProfileImportPlan {
  artifactPath: string;
  schemaVersion: 1;
  exportedProfileId: string;
  destinationProfileId: string;
  instructions: { path: 'profile/AGENTS.md'; sha256: string };
  skills: string[];
  omittedLocalSkills: string[];
  libraries: string[];
  packages: [];
  resources: ResourceImportPlan[];
  activeSelection: ActiveSelectionImportPlan;
  composition: {
    status: CompositionPlanStatus;
    deferredLibraries: string[];
    knownCollectionSkillCount: number;
    knownCollectionSkillPreview: string[];
  };
  exclusions: {
    activeSelectionWillChange: false;
    policyWillChange: false;
    collectionChildrenEnterDefault: false;
  };
  profileAction: ProfileImportAction;
  blockers: ProfileImportBlocker[];
}

/** Internal execution handoff. Only plan is suitable for later CLI projection. */
export type ProfileImportResourceSnapshot =
  | { kind: 'skill' | 'library'; id: string; sourceType: 'remoteGit'; health: ManagedGitExportHealthSnapshot }
  | { kind: 'library'; id: string; sourceType: 'localMapping'; health: LocalLibraryHealthSnapshot };

export interface ProfileImportPlanningResult {
  plan: ProfileImportPlan;
  homePath: string;
  artifactSnapshot: ProfileArtifactDirectorySnapshot;
  resourceSnapshots: ProfileImportResourceSnapshot[];
  mappingSnapshots: LocalLibraryMappingSnapshot[];
}

export interface PlanProfileImportOptions {
  bazframeHome: string;
  artifactDirectory: string;
  destinationProfileId?: string;
  mappings?: readonly ProfileImportMappingInput[];
  environment?: NodeJS.ProcessEnv;
}

export interface ProfileImportPlanDependencies {
  limitPolicy?: Partial<ProfileArtifactLimitPolicy>;
  readArtifact?: typeof readProfileArtifactDirectory;
  classifyResource?: typeof classifyManagedGitImportResource;
  captureMapping?: typeof captureLocalLibraryMapping;
  classifyLocalLibrary?: typeof classifyLocalLibraryImportResource;
  readActiveSelection?: typeof readOptionalActiveProfileSnapshot;
  classifyActiveProfilePresence?: typeof classifyActiveProfilePresence;
  resolveLibrary?: (
    bazframeHome: string,
    libraryId: string,
    capturedRecord: LibraryRecord
  ) => Promise<DerivedSkill[]>;
  /** Internal lower-only seams for bounded planning tests. */
  maxKnownCollectionSkills?: number;
  maxProfileNamespaceEntries?: number;
  classifyDestination?: typeof classifyDestinationProfile;
  testHooks?: {
    afterCapabilityValidation?: () => void | Promise<void>;
    afterMappingClosureValidation?: (blockers: readonly ProfileImportBlocker[]) => void | Promise<void>;
    beforeDestinationFinalCheck?: () => void | Promise<void>;
  };
}

type ImportableRemoteResource =
  | { kind: 'skill'; id: string; source: RemoteGitArtifactSource }
  | { kind: 'library'; id: string; source: RemoteGitArtifactSource };
type LocalLibraryResource = { kind: 'library'; id: string; source: LocalMappingArtifactSource };
type ClassifiedResource =
  | { sourceType: 'remoteGit'; resource: ImportableRemoteResource; classification: ManagedGitImportResourceClassification }
  | { sourceType: 'localMapping'; resource: LocalLibraryResource; mapping?: LocalLibraryMappingSnapshot; classification: LocalLibraryImportResourceClassification };

function isImportableRemoteResource(resource: ProfileArtifactResource): resource is ImportableRemoteResource {
  return resource.source.type === 'remoteGit' && resource.kind !== 'package';
}
function isLocalLibraryResource(resource: ProfileArtifactResource): resource is LocalLibraryResource {
  return resource.kind === 'library' && resource.source.type === 'localMapping';
}

interface DestinationClassification {
  action: 'publish' | 'reuse' | 'blocked';
  reason?: string;
  /** Internal physical evidence; never projected into the public plan. */
  evidence?: string;
}

export async function planProfileImport(
  options: PlanProfileImportOptions,
  dependencies: ProfileImportPlanDependencies = {}
): Promise<ProfileImportPlanningResult> {
  if (typeof options.bazframeHome !== 'string' || options.bazframeHome.length === 0 || options.bazframeHome.includes('\0')) {
    throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', 'Bazframe home must be a non-empty path without NUL bytes.');
  }
  if (typeof options.artifactDirectory !== 'string' || options.artifactDirectory.length === 0 || options.artifactDirectory.includes('\0')) {
    throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', 'Profile artifact directory must be a non-empty path without NUL bytes.');
  }
  const enteredHome = resolve(options.bazframeHome);
  const environment = { ...(options.environment ?? process.env) };
  const policy = profileArtifactLimitPolicy(dependencies.limitPolicy);
  const readArtifact = dependencies.readArtifact ?? readProfileArtifactDirectory;
  const artifactSnapshot = await readArtifact(options.artifactDirectory, policy);

  // Capability rejection is intentionally before every target-side classifier.
  assertStage2ProfileArtifactCapabilities(artifactSnapshot.artifact);
  await dependencies.testHooks?.afterCapabilityValidation?.();

  const artifact = artifactSnapshot.artifact;
  const destinationProfileId = options.destinationProfileId ?? artifact.profile.id;
  assertSafeProfileId(destinationProfileId);
  const homeAnchor = await holdReadOnlyPathAnchor(enteredHome);
  try {
    const home = homeAnchor.path;
    if (pathsOverlap(home, artifactSnapshot.root.path)) {
      throw new BazframeError(
        'PROFILE_IMPORT_PATH_OVERLAP',
        'Profile artifact root and BAZFRAME_HOME must be disjoint.'
      );
    }
    const classifyResource = dependencies.classifyResource ?? classifyManagedGitImportResource;
    const captureMapping = dependencies.captureMapping ?? captureLocalLibraryMapping;
    const classifyLocalLibrary = dependencies.classifyLocalLibrary ?? classifyLocalLibraryImportResource;
    const readActiveSelection = dependencies.readActiveSelection ?? readOptionalActiveProfileSnapshot;
    const classifyActiveProfile = dependencies.classifyActiveProfilePresence ?? classifyActiveProfilePresence;
    const classifyDestination = dependencies.classifyDestination ?? classifyDestinationProfile;
    const resolveLibrary = dependencies.resolveLibrary ?? (async (bazframeHome, _libraryId, capturedRecord) => (
      resolveGlobalSkillCollection(bazframeHome, capturedRecord)
    ));
    const maxKnownCollectionSkills = boundedKnownCollectionSkills(dependencies.maxKnownCollectionSkills);
    const maxProfileNamespaceEntries = boundedProfileNamespaceEntries(dependencies.maxProfileNamespaceEntries);
    const blockers: ProfileImportBlocker[] = [];
    const classifiedResources: ClassifiedResource[] = [];
    const mappingInputs = validateMappingInputs(options.mappings ?? [], artifact.resources);
    const mappingSnapshots: LocalLibraryMappingSnapshot[] = [];
    for (const mapping of mappingInputs) {
      const snapshot = await captureMapping(mapping);
      if (pathsOverlap(snapshot.root, home) || pathsOverlap(snapshot.root, artifactSnapshot.root.path)) {
        throw new BazframeError('PROFILE_IMPORT_MAPPING_OVERLAP', `Mapped library ${mapping.id} overlaps the artifact root or BAZFRAME_HOME.`);
      }
      for (const existing of mappingSnapshots) {
        if (pathsOverlap(snapshot.root, existing.root)) {
          throw new BazframeError('PROFILE_IMPORT_MAPPING_OVERLAP', `Mapped libraries ${existing.id} and ${mapping.id} overlap.`);
        }
      }
      mappingSnapshots.push(snapshot);
    }
    const mappingById = new Map(mappingSnapshots.map((mapping) => [mapping.id, mapping]));
    for (const resource of artifact.resources) {
      if (isLocalLibraryResource(resource) && !mappingById.has(resource.id)) {
        blockers.push(blocker(
          'PROFILE_IMPORT_MAPPING_REQUIRED',
          `library:${resource.id}`,
          `Local library ${resource.id} requires --map library:${resource.id}=<absolute-source-directory>.`
        ));
      }
    }
    await dependencies.testHooks?.afterMappingClosureValidation?.(blockers.map((item) => ({ ...item })));

    for (const resource of artifact.resources) {
      if (isImportableRemoteResource(resource)) {
        const classification = await classifyResource(
          home,
          resource.kind,
          resource.id,
          pathFreeRemoteGitIdentity(resource.source),
          environment
        );
        classifiedResources.push({ sourceType: 'remoteGit', resource, classification });
        if (classification.action === 'blocked') {
          blockers.push(blocker(
            'PROFILE_IMPORT_RESOURCE_BLOCKED',
            `${resource.kind}:${resource.id}`,
            classification.reason ?? `Resource ${resource.kind}:${resource.id} is blocked.`
          ));
        }
        continue;
      }
      if (isLocalLibraryResource(resource)) {
        const mapping = mappingById.get(resource.id);
        const classification: LocalLibraryImportResourceClassification = mapping === undefined
          ? { action: 'blocked', reason: `Local library ${resource.id} requires an explicit mapping.` }
          : await classifyLocalLibrary(home, resource.id, mapping);
        classifiedResources.push({ sourceType: 'localMapping', resource, ...(mapping === undefined ? {} : { mapping }), classification });
        if (classification.action === 'blocked' && mapping !== undefined) {
          blockers.push(blocker(
            'PROFILE_IMPORT_RESOURCE_BLOCKED',
            `library:${resource.id}`,
            classification.reason
          ));
        }
        continue;
      }
      throw new BazframeError('PROFILE_ARTIFACT_STAGE2_UNSUPPORTED', 'Stage 2 profile import encountered an unsupported resource after capability validation.');
    }

    let activeSelectionState = await classifyActiveSelection(home, readActiveSelection, classifyActiveProfile);
    if (activeSelectionState.plan.state === 'blocked') {
      blockers.push(blocker(
        'PROFILE_IMPORT_ACTIVE_SELECTION_BLOCKED',
        'active-profile',
        activeSelectionState.plan.reason ?? 'Active-profile state is blocked.'
      ));
    }
    const composition = await classifyComposition(
      home,
      artifact.profile.skills,
      artifact.profile.omittedLocalSkills,
      classifiedResources,
      resolveLibrary,
      maxKnownCollectionSkills,
      blockers
    );

    let destination = await classifyDestination(
      home,
      destinationProfileId,
      artifactSnapshot,
      classifiedResources,
      dependencies.testHooks,
      maxProfileNamespaceEntries
    );
    if (destination.action === 'blocked') {
      blockers.push(blocker(
        'PROFILE_IMPORT_PROFILE_COLLISION',
        `profile:${destinationProfileId}`,
        destination.reason ?? `Destination profile ${destinationProfileId} is blocked.`
      ));
    }

    await revalidateResourceClassifications(
      home,
      classifiedResources,
      classifyResource,
      classifyLocalLibrary,
      environment,
      blockers
    );
    if (classifiedResources.some((item) => item.resource.kind === 'library' && item.classification.action === 'blocked')) {
      composition.status = 'blocked';
    }
    composition.deferredLibraries = composition.deferredLibraries.filter((id) => classifiedResources.some(
      (item) => item.resource.kind === 'library' && item.resource.id === id && item.classification.action === 'create'
    ));

    if (destination.action !== 'blocked') {
      const finalDestination = await classifyDestination(
        home,
        destinationProfileId,
        artifactSnapshot,
        classifiedResources,
        dependencies.testHooks,
        maxProfileNamespaceEntries
      );
      if (finalDestination.action !== destination.action
        || finalDestination.evidence !== destination.evidence) {
        const reason = finalDestination.reason === undefined
          ? `Destination profile ${destinationProfileId} changed during import planning.`
          : `Destination profile ${destinationProfileId} changed during import planning: ${finalDestination.reason}`;
        blockers.push(blocker('PROFILE_IMPORT_PROFILE_CHANGED', `profile:${destinationProfileId}`, reason));
        destination = { action: 'blocked', reason };
      } else {
        destination = finalDestination;
      }
    }

    if (activeSelectionState.plan.state !== 'blocked') {
      const finalActiveSelection = await classifyActiveSelection(home, readActiveSelection, classifyActiveProfile);
      if (!sameActiveSelectionEvidence(activeSelectionState, finalActiveSelection)) {
        blockers.push(blocker(
          'PROFILE_IMPORT_ACTIVE_SELECTION_CHANGED',
          'active-profile',
          finalActiveSelection.plan.reason === undefined
            ? 'Active-profile state changed during import planning.'
            : `Active-profile state changed during import planning: ${finalActiveSelection.plan.reason}`
        ));
      }
      activeSelectionState = finalActiveSelection;
    }

    if (destination.action === 'publish'
      && activeSelectionState.plan.profileId === destinationProfileId) {
      blockers.push(blocker(
        'PROFILE_IMPORT_DANGLING_ACTIVE_SELECTION',
        `active-profile:${destinationProfileId}`,
        `The absent destination profile ${destinationProfileId} is named by active-profile.`
      ));
    }
    await assertReadOnlyPathAnchor(homeAnchor);

    const sortedBlockers = [...blockers].sort((left, right) => compare(
      `${left.code}\0${left.key}\0${left.message}`,
      `${right.code}\0${right.key}\0${right.message}`
    ));
    const profileAction: ProfileImportAction = sortedBlockers.length > 0
      ? 'blocked'
      : destination.action;
    const resources: ResourceImportPlan[] = classifiedResources.map((item) => {
      const common = {
        id: item.resource.id,
        action: item.classification.action,
        ...(!('reason' in item.classification) || item.classification.reason === undefined
          ? {}
          : { reason: boundedTextForDisplay(item.classification.reason) }),
        buildRequired: false as const
      };
      if (item.sourceType === 'localMapping') {
        return {
          ...common,
          kind: 'library' as const,
          source: { type: 'localMapping' as const, ...(item.mapping === undefined ? {} : { root: item.mapping.root }) },
          networkRequired: false as const
        };
      }
      return {
        ...common,
        kind: item.resource.kind,
        source: { ...item.resource.source },
        networkRequired: item.classification.action === 'create'
      };
    });

    return {
      plan: {
        artifactPath: artifactSnapshot.root.path,
        schemaVersion: 1,
        exportedProfileId: artifact.profile.id,
        destinationProfileId,
        instructions: { ...artifact.profile.instructions },
        skills: [...artifact.profile.skills],
        omittedLocalSkills: [...artifact.profile.omittedLocalSkills],
        libraries: [...artifact.profile.libraries],
        packages: [],
        resources,
        activeSelection: activeSelectionState.plan,
        composition,
        exclusions: {
          activeSelectionWillChange: false,
          policyWillChange: false,
          collectionChildrenEnterDefault: false
        },
        profileAction,
        blockers: sortedBlockers
      },
      homePath: home,
      artifactSnapshot,
      resourceSnapshots: classifiedResources.flatMap((item): ProfileImportResourceSnapshot[] => {
        if (item.classification.action !== 'reuse' || item.classification.health === undefined) return [];
        return item.sourceType === 'localMapping'
          ? [{ kind: 'library', id: item.resource.id, sourceType: 'localMapping', health: item.classification.health }]
          : [{ kind: item.resource.kind, id: item.resource.id, sourceType: 'remoteGit', health: item.classification.health }];
      }),
      mappingSnapshots: mappingSnapshots.map((mapping) => ({ ...mapping }))
    };
  } finally {
    await closeReadOnlyPathAnchor(homeAnchor);
  }
}

type ActiveProfilePresence = Awaited<ReturnType<typeof classifyActiveProfilePresence>>;

interface ClassifiedActiveSelection {
  plan: ActiveSelectionImportPlan;
  snapshot?: ActiveProfileSnapshot;
  presence?: ActiveProfilePresence;
}

async function classifyActiveSelection(
  home: string,
  readActiveSelection: typeof readOptionalActiveProfileSnapshot,
  classifyActiveProfile: typeof classifyActiveProfilePresence
): Promise<ClassifiedActiveSelection> {
  try {
    const snapshot = await readActiveSelection(home);
    if (snapshot === undefined) return { plan: { state: 'absent', willChange: false } };
    const presence = await classifyActiveProfile(home, snapshot.profileId);
    if (presence.action === 'blocked') {
      return {
        plan: { state: 'blocked', reason: presence.reason, willChange: false },
        snapshot,
        presence
      };
    }
    return {
      plan: { state: 'selected', profileId: snapshot.profileId, willChange: false },
      snapshot,
      presence
    };
  } catch (error) {
    return { plan: { state: 'blocked', reason: safeReason(error), willChange: false } };
  }
}

function sameActiveSelectionEvidence(
  left: ClassifiedActiveSelection,
  right: ClassifiedActiveSelection
): boolean {
  if (left.plan.state !== right.plan.state) return false;
  if (left.snapshot === undefined || right.snapshot === undefined) {
    return left.snapshot === right.snapshot;
  }
  return left.snapshot.profileId === right.snapshot.profileId
    && left.snapshot.path === right.snapshot.path
    && left.snapshot.device === right.snapshot.device
    && left.snapshot.inode === right.snapshot.inode
    && left.snapshot.contentSha256 === right.snapshot.contentSha256
    && left.presence?.action === right.presence?.action
    && (left.presence?.action !== 'blocked'
      || (right.presence?.action === 'blocked' && left.presence.reason === right.presence.reason));
}

async function classifyActiveProfilePresence(
  home: string,
  profileId: string
): Promise<{ action: 'present' | 'absent' } | { action: 'blocked'; reason: string }> {
  const path = profileDirectory(home, profileId);
  let handle: FileHandle | undefined;
  try {
    let before;
    try {
      before = await lstat(path, { bigint: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { action: 'absent' };
      throw error;
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(`Active profile path is not a physical directory: ${boundedPathForDisplay(path)}`);
    }
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!opened.isDirectory()
      || current.isSymbolicLink()
      || !current.isDirectory()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || current.dev !== before.dev
      || current.ino !== before.ino) {
      throw new Error(`Active profile path changed while inspected: ${boundedPathForDisplay(path)}`);
    }
    await handle.close();
    handle = undefined;
    return { action: 'present' };
  } catch (error) {
    return { action: 'blocked', reason: safeReason(error) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const KNOWN_COLLECTION_SKILL_PREVIEW_LIMIT = 32;
const COMPOSITION_DIAGNOSTIC_LIMIT = 256;

async function classifyComposition(
  home: string,
  skills: readonly string[],
  omittedLocalSkills: readonly string[],
  resources: readonly ClassifiedResource[],
  resolveLibrary: NonNullable<ProfileImportPlanDependencies['resolveLibrary']>,
  maxKnownCollectionSkills: number,
  blockers: ProfileImportBlocker[]
): Promise<ProfileImportPlan['composition']> {
  const flatSkills: FlatSkillIdentity[] = [...skills, ...omittedLocalSkills]
    .sort(compare)
    .map((name) => ({ name, definitionPath: '' }));
  const collectionSkills: DerivedSkill[] = [];
  const deferredLibraries = resources
    .filter((item) => item.resource.kind === 'library' && item.classification.action === 'create')
    .map((item) => item.resource.id)
    .sort(compare);
  let compositionBlocked = resources.some(
    (item) => item.resource.kind === 'library' && item.classification.action === 'blocked'
  );
  let aggregateLimitReached = false;
  for (const item of resources) {
    if (item.resource.kind !== 'library' || item.classification.action !== 'reuse') continue;
    const captured = item.classification.action === 'reuse'
      ? item.classification.health?.collectionSnapshot?.record
      : undefined;
    if (captured === undefined || !('library' in captured)) {
      compositionBlocked = true;
      blockers.push(blocker(
        'PROFILE_IMPORT_COMPOSITION_BLOCKED',
        `library:${item.resource.id}`,
        `Reusable library ${item.resource.id} lacks captured collection evidence.`
      ));
      continue;
    }
    try {
      const derived = await resolveLibrary(home, item.resource.id, captured);
      if (collectionSkills.length + derived.length > maxKnownCollectionSkills) {
        aggregateLimitReached = true;
        compositionBlocked = true;
        blockers.push(blocker(
          'PROFILE_IMPORT_COMPOSITION_LIMIT',
          'composition:known-collection-skills',
          `Known collection Skills exceed the ${maxKnownCollectionSkills}-entry planning limit.`
        ));
        break;
      }
      collectionSkills.push(...derived);
    } catch (error) {
      compositionBlocked = true;
      blockers.push(blocker(
        'PROFILE_IMPORT_COMPOSITION_BLOCKED',
        `library:${item.resource.id}`,
        safeReason(error)
      ));
    }
  }
  if (!aggregateLimitReached) {
    const diagnostics = validateCapturedSkillComposition(flatSkills, collectionSkills);
    const shown = diagnostics.slice(0, COMPOSITION_DIAGNOSTIC_LIMIT);
    for (const diagnostic of shown) blockers.push(compositionBlocker(diagnostic));
    if (diagnostics.length > shown.length) {
      blockers.push(blocker(
        'PROFILE_IMPORT_COMPOSITION_LIMIT',
        'composition:diagnostics',
        `Known composition produced more than ${COMPOSITION_DIAGNOSTIC_LIMIT} collision diagnostics.`
      ));
    }
    compositionBlocked ||= diagnostics.length > 0;
  }
  const knownNames = [...new Set(collectionSkills.map((skill) => skill.name))].sort(compare);
  return {
    status: compositionBlocked ? 'blocked' : deferredLibraries.length > 0 ? 'deferred' : 'ready',
    deferredLibraries,
    knownCollectionSkillCount: knownNames.length,
    knownCollectionSkillPreview: knownNames.slice(0, KNOWN_COLLECTION_SKILL_PREVIEW_LIMIT)
  };
}

function boundedKnownCollectionSkills(value: number = PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutEntries): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutEntries) {
    throw new BazframeError(
      'PROFILE_PORTABILITY_POLICY_INVALID',
      `Import composition Skill limit must be an integer from 0 through ${PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutEntries}.`
    );
  }
  return value;
}

function boundedProfileNamespaceEntries(
  value: number = PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries
): number {
  if (!Number.isSafeInteger(value)
    || value < 0
    || value > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries) {
    throw new BazframeError(
      'PROFILE_PORTABILITY_POLICY_INVALID',
      `Import profile namespace limit must be an integer from 0 through ${PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries}.`
    );
  }
  return value;
}

async function revalidateResourceClassifications(
  home: string,
  resources: ClassifiedResource[],
  classifyResource: typeof classifyManagedGitImportResource,
  classifyLocalLibrary: typeof classifyLocalLibraryImportResource,
  environment: NodeJS.ProcessEnv,
  blockers: ProfileImportBlocker[]
): Promise<void> {
  for (const item of resources) {
    if (item.sourceType === 'localMapping') {
      const initial = item.classification;
      if (initial.action === 'blocked') continue;
      if (item.mapping === undefined) throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', `Mapped library evidence is missing for ${item.resource.id}.`);
      const current = await classifyLocalLibrary(home, item.resource.id, item.mapping);
      const unchanged = initial.action === current.action
        && (initial.action === 'create'
          || (initial.health !== undefined && current.action === 'reuse'
            && sameLocalLibraryHealth(initial.health, current.health)));
      if (unchanged) {
        item.classification = current;
        continue;
      }
      blockChangedResource(item, current, 'Local', blockers);
      continue;
    }
    const initial = item.classification;
    if (initial.action === 'blocked') continue;
    const current = await classifyResource(
      home,
      item.resource.kind,
      item.resource.id,
      pathFreeRemoteGitIdentity(item.resource.source),
      environment
    );
    const unchanged = initial.action === current.action
      && (initial.action === 'create'
        || (initial.health !== undefined && current.action === 'reuse' && current.health !== undefined
          && sameManagedGitExportHealth(initial.health, current.health)));
    if (unchanged) {
      item.classification = current;
      continue;
    }
    blockChangedResource(item, current, 'Remote Git', blockers);
  }
}

function blockChangedResource(
  item: ClassifiedResource,
  current: ManagedGitImportResourceClassification | LocalLibraryImportResourceClassification,
  label: 'Local' | 'Remote Git',
  blockers: ProfileImportBlocker[]
): void {
  const currentReason = 'reason' in current ? current.reason : undefined;
  const reason = currentReason === undefined
    ? `${label} ${item.resource.kind} ${item.resource.id} changed during import planning.`
    : `${label} ${item.resource.kind} ${item.resource.id} changed during import planning: ${currentReason}`;
  item.classification = { action: 'blocked', reason: boundedTextForDisplay(reason) };
  blockers.push(blocker('PROFILE_IMPORT_RESOURCE_CHANGED', `${item.resource.kind}:${item.resource.id}`, reason));
}

function pathFreeRemoteGitIdentity(source: RemoteGitArtifactSource): Omit<RemoteGitArtifactSource, 'type'> {
  return {
    remote: source.remote,
    fetchUrl: source.fetchUrl,
    branch: source.branch,
    revision: source.revision
  };
}

function compositionBlocker(diagnostic: SkillCollectionDiagnostic): ProfileImportBlocker {
  const name = diagnostic.category === 'duplicate-name' ? diagnostic.name : diagnostic.path;
  return blocker(
    'PROFILE_IMPORT_COMPOSITION_BLOCKED',
    `${diagnostic.collectionKind}:${diagnostic.collectionId}:${name}`,
    `Known Skill composition collision in ${diagnostic.collectionKind}:${diagnostic.collectionId}: ${name}`
  );
}

async function classifyDestinationProfile(
  home: string,
  profileId: string,
  artifactSnapshot: ProfileArtifactDirectorySnapshot,
  resources: readonly ClassifiedResource[],
  testHooks: ProfileImportPlanDependencies['testHooks'] = {},
  maxProfileNamespaceEntries: number = PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries
): Promise<DestinationClassification> {
  const directory = profileDirectory(home, profileId);
  const parents: StableDirectory[] = [];
  let root: StableDirectory | undefined;
  try {
    const inspection = await inspectDestinationPath(home, directory, parents);
    if (inspection.rootMetadata === undefined) {
      await testHooks.beforeDestinationFinalCheck?.();
      await assertDestinationAbsence(inspection.absentPath, parents);
      return {
        action: 'publish',
        evidence: destinationEvidence('absent', inspection.absentPath, parents)
      };
    }
    if (resources.some((item) => item.classification.action !== 'reuse')) {
      return { action: 'blocked', reason: 'An existing destination profile can be reused only with exact healthy reusable dependencies.' };
    }

    root = await openStableDirectory(directory, inspection.rootMetadata);
    const names = await stableDirectoryNames(root, maxProfileNamespaceEntries);
    const allowed = new Set(['AGENTS.md', 'skills', 'libraries', 'packages']);
    if (names.some((name) => !allowed.has(name)) || !names.includes('AGENTS.md') || !names.includes('skills')) {
      throw mismatch('destination profile root entries differ from the portable profile');
    }
    const currentInstructions = await readPhysicalInstructionSnapshot(
      join(directory, 'AGENTS.md'),
      `Destination profile ${JSON.stringify(profileId)} instructions`
    );
    if (!sameInstructionContent(currentInstructions, artifactSnapshot.instructions)) {
      throw mismatch('destination profile instruction bytes differ');
    }
    await assertSkillNamespace(
      join(directory, 'skills'),
      artifactSnapshot.artifact.profile.skills,
      resources,
      maxProfileNamespaceEntries
    );
    await assertReferenceNamespace(
      home,
      profileId,
      'library',
      artifactSnapshot.artifact.profile.libraries,
      maxProfileNamespaceEntries
    );
    await assertReferenceNamespace(home, profileId, 'package', [], maxProfileNamespaceEntries);
    await testHooks.beforeDestinationFinalCheck?.();
    const finalInstructions = await readPhysicalInstructionSnapshot(
      join(directory, 'AGENTS.md'),
      `Destination profile ${JSON.stringify(profileId)} instructions`
    );
    if (!sameInstructionContent(finalInstructions, artifactSnapshot.instructions)) {
      throw mismatch('destination profile instruction bytes changed during inspection');
    }
    const skillEvidence = await assertSkillNamespace(
      join(directory, 'skills'),
      artifactSnapshot.artifact.profile.skills,
      resources,
      maxProfileNamespaceEntries
    );
    const libraryEvidence = await assertReferenceNamespace(
      home,
      profileId,
      'library',
      artifactSnapshot.artifact.profile.libraries,
      maxProfileNamespaceEntries
    );
    const packageEvidence = await assertReferenceNamespace(
      home,
      profileId,
      'package',
      [],
      maxProfileNamespaceEntries
    );
    if (!sameStrings(await stableDirectoryNames(root, maxProfileNamespaceEntries), names)) {
      throw mismatch('destination profile root entries changed during inspection');
    }
    for (const parent of parents) await assertStableDirectory(parent);
    return {
      action: 'reuse',
      evidence: [
        destinationEvidence('present', directory, parents),
        `${root.device}:${root.inode}`,
        `${finalInstructions.device}:${finalInstructions.inode}:${finalInstructions.contentSha256}`,
        skillEvidence,
        libraryEvidence,
        packageEvidence
      ].join('|')
    };
  } catch (error) {
    return { action: 'blocked', reason: safeReason(error) };
  } finally {
    await root?.handle.close().catch(() => undefined);
    await Promise.all([...parents].reverse().map((parent) => parent.handle.close().catch(() => undefined)));
  }
}

interface DestinationPathInspection {
  rootMetadata?: {
    dev: bigint;
    ino: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
  };
  absentPath: string;
}

async function inspectDestinationPath(
  home: string,
  destination: string,
  parents: StableDirectory[]
): Promise<DestinationPathInspection> {
  for (const path of [home, join(home, 'profiles')]) {
    let metadata;
    try {
      metadata = await lstat(path, { bigint: true });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await assertDestinationAbsence(path, parents);
      return { absentPath: path };
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw mismatch(`destination namespace ancestor must be a physical directory: ${boundedPathForDisplay(path)}`);
    }
    parents.push(await openStableDirectory(path, metadata));
  }
  try {
    const rootMetadata = await lstat(destination, { bigint: true });
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw mismatch(`destination profile must be a physical directory: ${boundedPathForDisplay(destination)}`);
    }
    return { rootMetadata, absentPath: destination };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    await assertDestinationAbsence(destination, parents);
    return { absentPath: destination };
  }
}

async function assertDestinationAbsence(path: string, parents: readonly StableDirectory[]): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      for (const parent of parents) await assertStableDirectory(parent);
      return;
    }
    throw error;
  }
  throw mismatch(`destination absence changed during inspection: ${boundedPathForDisplay(path)}`);
}

function destinationEvidence(
  state: 'present' | 'absent',
  path: string,
  parents: readonly StableDirectory[]
): string {
  return [state, path, ...parents.map((parent) => `${parent.path}:${parent.device}:${parent.inode}`)].join('|');
}

interface StableDirectory {
  path: string;
  device: bigint;
  inode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  handle: FileHandle;
}

async function openStableDirectory(
  path: string,
  expected: { dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint }
): Promise<StableDirectory> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()
      || opened.dev !== expected.dev
      || opened.ino !== expected.ino
      || opened.mtimeNs !== expected.mtimeNs
      || opened.ctimeNs !== expected.ctimeNs) {
      throw mismatch(`directory changed while opening: ${boundedPathForDisplay(path)}`);
    }
    const directory = {
      path,
      device: expected.dev,
      inode: expected.ino,
      mtimeNs: expected.mtimeNs,
      ctimeNs: expected.ctimeNs,
      handle
    };
    await assertStableDirectory(directory);
    return directory;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertStableDirectory(directory: StableDirectory): Promise<void> {
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
    || current.ino !== directory.inode
    || opened.mtimeNs !== directory.mtimeNs
    || opened.ctimeNs !== directory.ctimeNs
    || current.mtimeNs !== directory.mtimeNs
    || current.ctimeNs !== directory.ctimeNs) {
    throw mismatch(`directory changed during inspection: ${boundedPathForDisplay(directory.path)}`);
  }
}

async function stableDirectoryNames(
  directory: StableDirectory,
  maximum: number
): Promise<string[]> {
  await assertStableDirectory(directory);
  const names: string[] = [];
  let stream: Dir | undefined;
  let operationError: unknown;
  try {
    stream = await opendir(directory.path);
    while (true) {
      const entry = await stream.read();
      if (entry === null) break;
      if (names.length === maximum) {
        throw mismatch(`directory exceeds the ${maximum}-entry import-planning limit: ${boundedPathForDisplay(directory.path)}`);
      }
      names.push(entry.name);
    }
  } catch (error) {
    operationError = error;
  }
  if (stream !== undefined) {
    try { await stream.close(); }
    catch (error) { operationError ??= error; }
  }
  if (operationError !== undefined) throw operationError;
  await assertStableDirectory(directory);
  return names.sort(compare);
}

async function assertSkillNamespace(
  path: string,
  expectedIds: readonly string[],
  resources: readonly ClassifiedResource[],
  maxProfileNamespaceEntries: number
): Promise<string> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw mismatch('destination skills namespace is not physical');
  const directory = await openStableDirectory(path, metadata);
  try {
    const evidence = [`${directory.path}:${directory.device}:${directory.inode}`];
    const names = await stableDirectoryNames(directory, maxProfileNamespaceEntries);
    if (!sameStrings(names, expectedIds)) throw mismatch('destination direct Skill membership differs');
    const roots = new Map(resources.flatMap((item) => {
      if (item.sourceType !== 'remoteGit'
        || item.resource.kind !== 'skill'
        || item.classification.action !== 'reuse'
        || item.classification.health === undefined) return [];
      return [[item.resource.id, item.classification.health.root] as const];
    }));
    for (const id of expectedIds) {
      const membershipPath = join(path, id);
      const before = await lstat(membershipPath, { bigint: true });
      if (!before.isSymbolicLink()) throw mismatch(`destination Skill ${id} is not a direct link`);
      const target = await readlink(membershipPath);
      const expectedRoot = roots.get(id);
      if (!isAbsolute(target) || expectedRoot === undefined || target !== expectedRoot.path) {
        throw mismatch(`destination Skill ${id} target differs`);
      }
      const canonical = await realpath(target);
      const targetMetadata = await lstat(canonical, { bigint: true });
      const after = await lstat(membershipPath, { bigint: true });
      if (canonical !== target
        || targetMetadata.isSymbolicLink()
        || !targetMetadata.isDirectory()
        || targetMetadata.dev !== expectedRoot.device
        || targetMetadata.ino !== expectedRoot.inode
        || !after.isSymbolicLink()
        || before.dev !== after.dev
        || before.ino !== after.ino
        || await readlink(membershipPath) !== target) {
        throw mismatch(`destination Skill ${id} changed during inspection`);
      }
      evidence.push(`${id}:${before.dev}:${before.ino}:${target}:${targetMetadata.dev}:${targetMetadata.ino}`);
    }
    if (!sameStrings(await stableDirectoryNames(directory, maxProfileNamespaceEntries), names)) {
      throw mismatch('destination direct Skill membership changed during inspection');
    }
    return evidence.join('|');
  } finally {
    await directory.handle.close();
  }
}

async function assertReferenceNamespace(
  home: string,
  profileId: string,
  kind: 'library' | 'package',
  expectedIds: readonly string[],
  maxProfileNamespaceEntries: number
): Promise<string> {
  const path = join(profileDirectory(home, profileId), kind === 'library' ? 'libraries' : 'packages');
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && expectedIds.length === 0) return `absent:${path}`;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw mismatch(`destination ${kind} namespace is not physical`);
  const directory = await openStableDirectory(path, metadata);
  try {
    const evidence = [`${directory.path}:${directory.device}:${directory.inode}`];
    const expectedNames = expectedIds.map((id) => `${id}.json`);
    const names = await stableDirectoryNames(directory, maxProfileNamespaceEntries);
    if (!sameStrings(names, expectedNames)) {
      throw mismatch(`destination ${kind} references differ`);
    }
    for (const id of expectedIds) {
      const snapshot = await readProfileCollectionReferenceSnapshot(home, profileId, { kind, id });
      evidence.push(`${id}:${snapshot.device}:${snapshot.inode}:${snapshot.contentSha256}`);
    }
    if (!sameStrings(await stableDirectoryNames(directory, maxProfileNamespaceEntries), names)) {
      throw mismatch(`destination ${kind} references changed during inspection`);
    }
    return evidence.join('|');
  } finally {
    await directory.handle.close();
  }
}

function sameInstructionContent(
  left: Awaited<ReturnType<typeof readPhysicalInstructionSnapshot>>,
  right: ProfileArtifactDirectorySnapshot['instructions']
): boolean {
  return left.byteCount === right.byteCount
    && left.contentSha256 === right.contentSha256
    && Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function blocker(code: string, key: string, reason: string): ProfileImportBlocker {
  return {
    code,
    key: boundedTextForDisplay(key),
    message: boundedTextForDisplay(reason)
  };
}

function mismatch(detail: string): BazframeError {
  return new BazframeError('PROFILE_IMPORT_PROFILE_COLLISION', `Destination profile mismatch: ${detail}.`);
}

function safeReason(error: unknown): string {
  return boundedTextForDisplay(error instanceof Error ? error.message : String(error));
}

function validateMappingInputs(
  entered: readonly ProfileImportMappingInput[],
  resources: readonly ProfileArtifactResource[]
): ProfileImportMappingInput[] {
  if (!Array.isArray(entered)) {
    throw new BazframeError('PROFILE_IMPORT_MAPPING_INVALID', 'Profile import mappings must be an array.');
  }
  const expected = new Set(resources
    .filter((resource) => resource.kind === 'library' && resource.source.type === 'localMapping')
    .map((resource) => `library:${resource.id}`));
  const seen = new Set<string>();
  const result: ProfileImportMappingInput[] = [];
  for (const raw of entered) {
    if (raw === null || typeof raw !== 'object' || raw.kind !== 'library'
      || typeof raw.id !== 'string' || typeof raw.root !== 'string') {
      throw new BazframeError('PROFILE_IMPORT_MAPPING_INVALID', 'Each profile import mapping must identify one local library and absolute source root.');
    }
    try { assertSafeSkillId(raw.id); }
    catch (error) { throw new BazframeError('PROFILE_IMPORT_MAPPING_INVALID', `Mapped library ID is invalid: ${raw.id}`, { cause: error }); }
    if (!isAbsolute(raw.root) || raw.root.length === 0 || raw.root.includes('\0')) {
      throw new BazframeError('PROFILE_IMPORT_MAPPING_INVALID', 'Mapped library root must be a non-NUL absolute path.');
    }
    const key = `library:${raw.id}`;
    if (seen.has(key)) throw new BazframeError('PROFILE_IMPORT_MAPPING_INVALID', `Duplicate profile import mapping: ${key}`);
    if (!expected.has(key)) throw new BazframeError('PROFILE_IMPORT_MAPPING_INVALID', `Profile artifact does not require local mapping ${key}.`);
    seen.add(key);
    result.push({ kind: 'library', id: raw.id, root: raw.root });
  }
  return result.sort((left, right) => compare(left.id, right.id));
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === ''
    || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
