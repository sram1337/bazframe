import { join, resolve } from 'node:path';
import type { ChildOutputPolicy } from '../core/child-process.js';
import { BazframeError } from '../core/errors.js';
import { profileDirectory } from '../profiles/profile-store.js';
import {
  addManagedGitLibraryAtRevision,
  addManagedGitSkillAtRevision,
  classifyManagedGitImportOutcome,
  sameManagedGitExportHealth,
  type ManagedGitExactRevisionReuseRequirement,
  type ManagedGitExportHealthSnapshot,
  type ManagedGitLifecycleResult
} from '../providers/managed-git.js';
import type { PathFreeManagedGitIdentity } from '../providers/managed-git-record.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import {
  sameProfileArtifactDirectorySnapshot
} from './profile-artifact-io.js';
import {
  planProfileImport,
  type PlanProfileImportOptions,
  type ProfileImportPlan,
  type ProfileImportPlanningResult
} from './profile-import-plan.js';
import {
  ProfileImportPublicationError,
  publishImportedProfile,
  type ProfileImportPublicationOptions
} from './profile-import-publication.js';
import type { ManagedGitAcquisitionLimitPolicy } from './profile-portability-policy.js';

export type ProfileImportResourceOutcome =
  | 'created'
  | 'reused'
  | 'not-created'
  | 'recovery-required'
  | 'commit-ambiguous';

export type ProfileImportProfileOutcome =
  | 'published'
  | 'reused'
  | 'not-published'
  | 'commit-ambiguous';

export interface ProfileImportResourceResult {
  kind: 'skill' | 'library';
  id: string;
  outcome: ProfileImportResourceOutcome;
}

export interface ProfileImportResult {
  plan: ProfileImportPlan;
  resources: ProfileImportResourceResult[];
  profileOutcome: 'published' | 'reused';
  destinationPath: string;
  activeSelectionChanged: false;
}

export interface ProfileImportPartialResult {
  plan: ProfileImportPlan;
  resources: ProfileImportResourceResult[];
  profileOutcome: ProfileImportProfileOutcome;
  destinationPath: string;
  activeSelectionChanged: false;
}

export interface ExecuteProfileImportOptions {
  bazframeHome: string;
  artifactDirectory: string;
  destinationProfileId?: string;
  environment?: NodeJS.ProcessEnv;
  acquisitionLimits?: Partial<ManagedGitAcquisitionLimitPolicy>;
  childOutputPolicy?: ChildOutputPolicy;
  reportPlan: (plan: ProfileImportPlan) => void | Promise<void>;
}

export interface ProfileImportExecutionDependencies {
  planImport?: typeof planProfileImport;
  addSkillAtRevision?: typeof addManagedGitSkillAtRevision;
  addLibraryAtRevision?: typeof addManagedGitLibraryAtRevision;
  classifyResourceOutcome?: typeof classifyManagedGitImportOutcome;
  publishProfile?: (options: ProfileImportPublicationOptions) => ReturnType<typeof publishImportedProfile>;
  stateLock?: typeof withStateLock;
  ensureDirectory?: typeof ensureManagedDirectory;
}

export class ProfileImportBlockedError extends BazframeError {
  readonly plan: ProfileImportPlan;

  constructor(plan: ProfileImportPlan) {
    super('PROFILE_IMPORT_BLOCKED', 'Profile import is blocked by the reported inspection plan.');
    this.name = 'ProfileImportBlockedError';
    this.plan = copyPlan(plan);
  }
}

export class ProfileImportExecutionError extends BazframeError {
  readonly result: ProfileImportPartialResult;

  constructor(result: ProfileImportPartialResult, cause: unknown) {
    super(
      'PROFILE_IMPORT_FAILED',
      `Profile import did not complete; profile outcome is ${result.profileOutcome}. Inspect and retry.`,
      { cause }
    );
    this.name = 'ProfileImportExecutionError';
    this.result = copyPartialResult(result);
  }
}

interface PreparedExecution {
  planOptions: PlanProfileImportOptions;
  environment: NodeJS.ProcessEnv;
  acquisitionLimits?: Partial<ManagedGitAcquisitionLimitPolicy>;
  childOutputPolicy?: ChildOutputPolicy;
  reportPlan: ExecuteProfileImportOptions['reportPlan'];
}

interface ResourceProgress {
  kind: 'skill' | 'library';
  id: string;
  identity: PathFreeManagedGitIdentity;
  initialAction: 'create' | 'reuse';
  attempted: boolean;
  successfulOutcome?: 'created' | 'reused';
  reuseRequirement?: ManagedGitExactRevisionReuseRequirement;
}

export async function executeProfileImport(
  options: ExecuteProfileImportOptions,
  dependencies: ProfileImportExecutionDependencies = {}
): Promise<ProfileImportResult> {
  const prepared = prepareExecution(options);
  const services = {
    plan: dependencies.planImport ?? planProfileImport,
    addSkill: dependencies.addSkillAtRevision ?? addManagedGitSkillAtRevision,
    addLibrary: dependencies.addLibraryAtRevision ?? addManagedGitLibraryAtRevision,
    classifyOutcome: dependencies.classifyResourceOutcome ?? classifyManagedGitImportOutcome,
    publish: dependencies.publishProfile ?? publishImportedProfile,
    lock: dependencies.stateLock ?? withStateLock,
    ensureDirectory: dependencies.ensureDirectory ?? ensureManagedDirectory
  };

  const initial = await services.plan(prepared.planOptions);
  const displayedPlan = copyPlan(initial.plan);
  await prepared.reportPlan(copyPlan(displayedPlan));
  if (initial.plan.blockers.length > 0 || initial.plan.profileAction === 'blocked') {
    throw new ProfileImportBlockedError(displayedPlan);
  }

  const destinationPath = profileDirectory(initial.homePath, initial.plan.destinationProfileId);
  const profileBase = {
    plan: displayedPlan,
    destinationPath,
    activeSelectionChanged: false as const
  };
  let executionPlan: ProfileImportPlanningResult;
  try {
    executionPlan = await services.plan(prepared.planOptions);
    validateExecutionAuthorization(initial, executionPlan);
  } catch (cause) {
    const initialProgress = orderedResources(initial);
    throw await executionFailure(
      profileBase,
      initial.homePath,
      initialProgress,
      prepared.environment,
      services.classifyOutcome,
      'not-published',
      cause
    );
  }
  const progress = orderedResources(executionPlan);

  try {
    for (const resource of progress) {
      resource.attempted = true;
      const lifecycleOptions = {
        bazframeHome: initial.homePath,
        environment: prepared.environment,
        ...(prepared.acquisitionLimits === undefined ? {} : { acquisitionLimits: prepared.acquisitionLimits }),
        ...(prepared.childOutputPolicy === undefined ? {} : { childOutputPolicy: prepared.childOutputPolicy })
      };
      const result = resource.kind === 'skill'
        ? await services.addSkill(lifecycleOptions, resource.id, resource.identity, resource.reuseRequirement)
        : await services.addLibrary(lifecycleOptions, resource.id, resource.identity, resource.reuseRequirement);
      resource.successfulOutcome = lifecycleOutcome(result);
    }
  } catch (cause) {
    const resources = await classifyResourceResults(initial.homePath, progress, prepared.environment, services.classifyOutcome);
    throw new ProfileImportExecutionError({
      ...profileBase,
      resources,
      profileOutcome: 'not-published'
    }, cause);
  }

  let authoritative: ProfileImportPlanningResult;
  try {
    authoritative = await services.plan(prepared.planOptions);
    validatePlanningResult(
      initial,
      authoritative,
      executionPlan,
      executionPlan.plan.profileAction === 'reuse' ? ['reuse'] : ['publish', 'reuse'],
      false
    );
  } catch (cause) {
    throw await executionFailure(profileBase, initial.homePath, progress, prepared.environment, services.classifyOutcome, 'not-published', cause);
  }

  if (authoritative.plan.profileAction === 'reuse') {
    let reuseProved = false;
    try {
      await services.lock(
        join(initial.homePath, 'locks', 'state.lock'),
        { command: 'bazframe profile import', target: destinationPath },
        async () => {
          const final = await services.plan(prepared.planOptions);
          validatePlanningResult(initial, final, authoritative, ['reuse'], true);
          reuseProved = true;
        },
        { managedRoot: initial.homePath }
      );
      return successResult(profileBase, progress, 'reused');
    } catch (cause) {
      throw await executionFailure(
        profileBase,
        initial.homePath,
        progress,
        prepared.environment,
        services.classifyOutcome,
        reuseProved ? 'reused' : 'commit-ambiguous',
        cause
      );
    }
  }

  try {
    await services.lock(
      join(initial.homePath, 'locks', 'state.lock'),
      { command: 'bazframe profile import prepare', target: join(initial.homePath, 'profiles') },
      () => services.ensureDirectory(initial.homePath, join(initial.homePath, 'profiles'), {
        chmodExistingDirectories: false
      }),
      { managedRoot: initial.homePath }
    );
  } catch (cause) {
    throw await executionFailure(profileBase, initial.homePath, progress, prepared.environment, services.classifyOutcome, 'not-published', cause);
  }

  const skills = authoritative.plan.skills.map((id) => {
    const health = requiredHealth(authoritative, 'skill', id);
    return { id, target: health.root.path, device: health.root.device, inode: health.root.inode };
  });
  let lockedProfileOutcome: 'published' | 'reused' | undefined;
  try {
    const publication = await services.publish({
      bazframeHome: initial.homePath,
      destinationProfileId: initial.plan.destinationProfileId,
      instructionBytes: initial.artifactSnapshot.instructions.bytes,
      skills,
      libraryIds: [...authoritative.plan.libraries],
      commit: (publish) => services.lock(
        join(initial.homePath, 'locks', 'state.lock'),
        { command: 'bazframe profile import', target: destinationPath },
        async () => {
          const final = await services.plan(prepared.planOptions);
          validatePlanningResult(initial, final, authoritative, ['publish', 'reuse'], true);
          if (final.plan.profileAction === 'reuse') {
            lockedProfileOutcome = 'reused';
            return 'discarded';
          }
          await publish();
          lockedProfileOutcome = 'published';
          return 'published';
        },
        { managedRoot: initial.homePath }
      )
    });
    const outcome = publication.action === 'published' ? 'published' : lockedProfileOutcome;
    if (outcome !== 'published' && outcome !== 'reused') {
      throw new BazframeError('PROFILE_IMPORT_PUBLICATION_INVALID', 'Imported-profile publisher returned without a proven profile outcome.');
    }
    return successResult(profileBase, progress, outcome);
  } catch (cause) {
    let profileOutcome: ProfileImportProfileOutcome = lockedProfileOutcome ?? 'not-published';
    if (cause instanceof ProfileImportPublicationError) {
      profileOutcome = cause.commitState === 'published'
        ? 'published'
        : cause.commitState === 'commit-ambiguous'
          ? 'commit-ambiguous'
          : lockedProfileOutcome ?? 'not-published';
    }
    throw await executionFailure(
      profileBase,
      initial.homePath,
      progress,
      prepared.environment,
      services.classifyOutcome,
      profileOutcome,
      cause
    );
  }
}

function prepareExecution(options: ExecuteProfileImportOptions): PreparedExecution {
  if (options === null || typeof options !== 'object') throw new TypeError('Profile import options are required.');
  if (typeof options.bazframeHome !== 'string' || options.bazframeHome.length === 0 || options.bazframeHome.includes('\0')) {
    throw new BazframeError('PROFILE_IMPORT_INVALID', 'Bazframe home must be a non-empty path without NUL bytes.');
  }
  if (typeof options.artifactDirectory !== 'string' || options.artifactDirectory.length === 0 || options.artifactDirectory.includes('\0')) {
    throw new BazframeError('PROFILE_IMPORT_INVALID', 'Profile artifact directory must be a non-empty path without NUL bytes.');
  }
  if (typeof options.reportPlan !== 'function') {
    throw new BazframeError('PROFILE_IMPORT_INVALID', 'Profile import requires a plan-report callback.');
  }
  const destinationProfileId = options.destinationProfileId;
  const acquisitionLimits = options.acquisitionLimits === undefined ? undefined : { ...options.acquisitionLimits };
  return {
    planOptions: {
      bazframeHome: resolve(options.bazframeHome),
      artifactDirectory: resolve(options.artifactDirectory),
      ...(destinationProfileId === undefined ? {} : { destinationProfileId }),
      environment: { ...(options.environment ?? process.env) }
    },
    environment: { ...(options.environment ?? process.env) },
    ...(acquisitionLimits === undefined ? {} : { acquisitionLimits }),
    ...(options.childOutputPolicy === undefined ? {} : { childOutputPolicy: options.childOutputPolicy }),
    reportPlan: options.reportPlan
  };
}

function orderedResources(initial: ProfileImportPlanningResult): ResourceProgress[] {
  const plans = new Map(initial.plan.resources.map((resource) => [`${resource.kind}:${resource.id}`, resource]));
  const resources = initial.artifactSnapshot.artifact.resources;
  return (['skill', 'library'] as const).flatMap((kind) => resources
    .filter((resource) => resource.kind === kind && resource.source.type === 'remoteGit')
    .sort((left, right) => compare(left.id, right.id))
    .map((resource): ResourceProgress => {
      const plan = plans.get(`${kind}:${resource.id}`);
      if (plan === undefined || plan.action === 'blocked') {
        throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', `Reported resource plan is incomplete for ${kind}:${resource.id}.`);
      }
      if (resource.source.type !== 'remoteGit') {
        throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', `Stage 1 resource source is unsupported for ${kind}:${resource.id}.`);
      }
      const identity: PathFreeManagedGitIdentity = {
        remote: resource.source.remote,
        fetchUrl: resource.source.fetchUrl,
        branch: resource.source.branch,
        revision: resource.source.revision
      };
      const health = initial.resourceSnapshots.find((item) => item.kind === kind && item.id === resource.id)?.health;
      if (plan.action === 'reuse' && health === undefined) {
        throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', `Exact reuse evidence is missing for ${kind}:${resource.id}.`);
      }
      return {
        kind,
        id: resource.id,
        identity,
        initialAction: plan.action,
        attempted: false,
        ...(health === undefined ? {} : { reuseRequirement: { mode: 'must-reuse' as const, expectedHealth: health } })
      };
    }));
}

function lifecycleOutcome(result: ManagedGitLifecycleResult): 'created' | 'reused' {
  if (result.action === 'added') return 'created';
  if (result.action === 'current') return 'reused';
  throw new BazframeError('PROFILE_IMPORT_RESOURCE_RESULT_INVALID', 'Exact resource lifecycle returned an unsupported action.');
}

function validateExecutionAuthorization(
  displayed: ProfileImportPlanningResult,
  current: ProfileImportPlanningResult
): void {
  if (current.homePath !== displayed.homePath
    || !sameProfileArtifactDirectorySnapshot(displayed.artifactSnapshot, current.artifactSnapshot)) {
    throw new BazframeError('PROFILE_IMPORT_ARTIFACT_CHANGED', 'Profile artifact changed after the displayed import plan.');
  }
  if (current.plan.blockers.length > 0
    || current.plan.profileAction === 'blocked'
    || current.plan.activeSelection.state === 'blocked'
    || current.plan.composition.status === 'blocked') {
    throw new BazframeError('PROFILE_IMPORT_REVALIDATION_BLOCKED', 'Profile import state became blocked after the displayed plan.');
  }
  if (displayed.plan.profileAction === 'reuse' && current.plan.profileAction !== 'reuse') {
    throw new BazframeError('PROFILE_IMPORT_DESTINATION_CHANGED', 'An exact displayed destination may not become new publication work.');
  }
  if (current.plan.resources.length !== displayed.plan.resources.length) {
    throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', 'Profile import resource closure changed after the displayed plan.');
  }
  for (const displayedResource of displayed.plan.resources) {
    const currentResource = current.plan.resources.find((resource) => (
      resource.kind === displayedResource.kind && resource.id === displayedResource.id
    ));
    if (currentResource === undefined || currentResource.action === 'blocked'
      || (displayedResource.action === 'reuse' && currentResource.action !== 'reuse')) {
      throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', 'Displayed exact reuse may not become new acquisition work.');
    }
    if (currentResource.action === 'reuse') {
      const displayedHealth = displayed.resourceSnapshots.find((item) => (
        item.kind === displayedResource.kind && item.id === displayedResource.id
      ));
      const currentHealth = current.resourceSnapshots.find((item) => (
        item.kind === currentResource.kind && item.id === currentResource.id
      ));
      if (currentHealth === undefined
        || (displayedResource.action === 'reuse'
          && (displayedHealth === undefined || !sameManagedGitExportHealth(displayedHealth.health, currentHealth.health)))) {
        throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', 'Exact dependency evidence changed after the displayed plan.');
      }
    }
  }
}

function validatePlanningResult(
  initial: ProfileImportPlanningResult,
  current: ProfileImportPlanningResult,
  expectedHealth: ProfileImportPlanningResult | undefined,
  allowedProfileActions: readonly ('publish' | 'reuse')[],
  requireCompleteExpectedHealth: boolean
): void {
  if (current.homePath !== initial.homePath
    || !sameProfileArtifactDirectorySnapshot(initial.artifactSnapshot, current.artifactSnapshot)) {
    throw new BazframeError('PROFILE_IMPORT_ARTIFACT_CHANGED', 'Profile artifact changed after the displayed import plan.');
  }
  if (current.plan.blockers.length > 0
    || current.plan.activeSelection.state === 'blocked'
    || current.plan.composition.status !== 'ready'
    || !allowedProfileActions.includes(current.plan.profileAction as 'publish' | 'reuse')) {
    throw new BazframeError('PROFILE_IMPORT_REVALIDATION_BLOCKED', 'Profile import state is no longer ready for publication or exact reuse.');
  }
  if (current.plan.resources.some((resource) => resource.action !== 'reuse')
    || current.resourceSnapshots.length !== current.plan.resources.length) {
    throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', 'Profile import dependencies are not all exact healthy reuses.');
  }
  const seen = new Set<string>();
  for (const resource of current.plan.resources) {
    const key = `${resource.kind}:${resource.id}`;
    const snapshot = current.resourceSnapshots.find((item) => item.kind === resource.kind && item.id === resource.id);
    if (snapshot === undefined || seen.has(key)) {
      throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', 'Profile import dependency evidence is incomplete.');
    }
    seen.add(key);
    if (expectedHealth !== undefined) {
      const expected = expectedHealth.resourceSnapshots.find((item) => item.kind === resource.kind && item.id === resource.id);
      if ((expected === undefined && requireCompleteExpectedHealth)
        || (expected !== undefined && !sameManagedGitExportHealth(expected.health, snapshot.health))) {
        throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', 'Profile import dependency evidence changed before final publication.');
      }
    }
  }
}

function requiredHealth(
  result: ProfileImportPlanningResult,
  kind: 'skill' | 'library',
  id: string
): ManagedGitExportHealthSnapshot {
  const snapshot = result.resourceSnapshots.find((item) => item.kind === kind && item.id === id);
  if (snapshot === undefined) {
    throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', `Profile import lacks exact health for ${kind}:${id}.`);
  }
  return snapshot.health;
}

async function classifyResourceResults(
  home: string,
  progress: readonly ResourceProgress[],
  environment: NodeJS.ProcessEnv,
  classify: typeof classifyManagedGitImportOutcome
): Promise<ProfileImportResourceResult[]> {
  const results: ProfileImportResourceResult[] = [];
  for (const resource of progress) {
    let outcome: ProfileImportResourceOutcome;
    try {
      const classification = await classify(home, resource.kind, resource.id, resource.identity, environment);
      if (classification.state === 'exact') {
        outcome = resource.successfulOutcome
          ?? (resource.initialAction === 'reuse' ? 'reused' : 'commit-ambiguous');
      } else if (classification.state === 'absent') {
        outcome = 'not-created';
      } else if (classification.state === 'recovery-required') {
        outcome = 'recovery-required';
      } else {
        outcome = 'commit-ambiguous';
      }
    } catch {
      outcome = 'commit-ambiguous';
    }
    results.push({ kind: resource.kind, id: resource.id, outcome });
  }
  return results;
}

async function executionFailure(
  base: Pick<ProfileImportPartialResult, 'plan' | 'destinationPath' | 'activeSelectionChanged'>,
  home: string,
  progress: readonly ResourceProgress[],
  environment: NodeJS.ProcessEnv,
  classify: typeof classifyManagedGitImportOutcome,
  profileOutcome: ProfileImportProfileOutcome,
  cause: unknown
): Promise<ProfileImportExecutionError> {
  return new ProfileImportExecutionError({
    ...base,
    resources: await classifyResourceResults(home, progress, environment, classify),
    profileOutcome
  }, cause);
}

function successResult(
  base: Pick<ProfileImportResult, 'plan' | 'destinationPath' | 'activeSelectionChanged'>,
  progress: readonly ResourceProgress[],
  profileOutcome: 'published' | 'reused'
): ProfileImportResult {
  return {
    ...base,
    plan: copyPlan(base.plan),
    resources: progress.map((resource) => ({
      kind: resource.kind,
      id: resource.id,
      outcome: resource.successfulOutcome ?? 'reused'
    })),
    profileOutcome
  };
}

function copyPartialResult(result: ProfileImportPartialResult): ProfileImportPartialResult {
  return {
    plan: copyPlan(result.plan),
    resources: result.resources.map((resource) => ({ ...resource })),
    profileOutcome: result.profileOutcome,
    destinationPath: result.destinationPath,
    activeSelectionChanged: false
  };
}

function copyPlan(plan: ProfileImportPlan): ProfileImportPlan {
  return {
    artifactPath: plan.artifactPath,
    schemaVersion: 1,
    exportedProfileId: plan.exportedProfileId,
    destinationProfileId: plan.destinationProfileId,
    instructions: { ...plan.instructions },
    skills: [...plan.skills],
    omittedLocalSkills: [...plan.omittedLocalSkills],
    libraries: [...plan.libraries],
    packages: [],
    resources: plan.resources.map((resource) => ({
      ...resource,
      source: { ...resource.source }
    })),
    activeSelection: { ...plan.activeSelection },
    composition: {
      ...plan.composition,
      deferredLibraries: [...plan.composition.deferredLibraries],
      knownCollectionSkillPreview: [...plan.composition.knownCollectionSkillPreview]
    },
    exclusions: { ...plan.exclusions },
    profileAction: plan.profileAction,
    blockers: plan.blockers.map((blocker) => ({ ...blocker }))
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
