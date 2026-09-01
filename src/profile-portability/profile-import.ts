import { join, resolve } from 'node:path';
import type { ChildOutputPolicy } from '../core/child-process.js';
import { BazframeError } from '../core/errors.js';
import type { PackageManifestSnapshot } from '../packages/package-manifest.js';
import { profileDirectory } from '../profiles/profile-store.js';
import { addLibrary, addPackage, type SkillCollectionLifecycleResult } from '../skill-collections/skill-collection-lifecycle.js';
import {
  addManagedGitLibraryAtRevision,
  addManagedGitPackageAtRevision,
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
  assertLocalCollectionMappingSnapshot,
  assertLocalLibraryMappingSnapshot,
  classifyLocalCollectionImportOutcome,
  classifyLocalLibraryImportOutcome,
  sameLocalCollectionHealth,
  sameLocalCollectionMappingSnapshot,
  type LocalCollectionHealthSnapshot,
  type LocalCollectionMappingInput,
  type LocalCollectionMappingSnapshot,
  type LocalPackageMappingSnapshot
} from './profile-import-local-library.js';
import {
  sameProfileArtifactDirectorySnapshot
} from './profile-artifact-io.js';
import {
  planProfileImport,
  type PlanProfileImportOptions,
  type ProfileImportPlan,
  type ProfileImportPlanningResult,
  type ProfileImportResourceSnapshot
} from './profile-import-plan.js';
import {
  ProfileImportPublicationError,
  publishImportedProfile,
  type ProfileImportPublicationOptions
} from './profile-import-publication.js';
import type { ManagedGitAcquisitionLimitPolicy } from './profile-portability-policy.js';
import {
  PackageBuildReportAccumulator,
  copyPackageBuildReport,
  createPackageBuildAuthorizationReport,
  sameAuthorizedPackageInputs,
  type AuthorizePackageBuild,
  type PackageBuildAuthorizationReport
} from './profile-import-package-build.js';

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
  kind: 'skill' | 'library' | 'package';
  id: string;
  outcome: ProfileImportResourceOutcome;
}

export interface ProfileImportResult {
  plan: ProfileImportPlan;
  resources: ProfileImportResourceResult[];
  profileOutcome: 'published' | 'reused';
  destinationPath: string;
  activeSelectionChanged: false;
  packageBuildReports?: PackageBuildAuthorizationReport[];
  possibleNonrollbackablePackageEffects?: string[];
}

export interface ProfileImportPartialResult {
  plan: ProfileImportPlan;
  resources: ProfileImportResourceResult[];
  profileOutcome: ProfileImportProfileOutcome;
  destinationPath: string;
  activeSelectionChanged: false;
  packageBuildReports?: PackageBuildAuthorizationReport[];
  possibleNonrollbackablePackageEffects?: string[];
}

export interface ExecuteProfileImportOptions {
  bazframeHome: string;
  artifactDirectory: string;
  destinationProfileId?: string;
  mappings?: readonly LocalCollectionMappingInput[];
  environment?: NodeJS.ProcessEnv;
  acquisitionLimits?: Partial<ManagedGitAcquisitionLimitPolicy>;
  childOutputPolicy?: ChildOutputPolicy;
  authorizePackageBuild?: AuthorizePackageBuild;
  reportPlan: (plan: ProfileImportPlan) => void | Promise<void>;
}

export interface ProfileImportExecutionDependencies {
  planImport?: typeof planProfileImport;
  addSkillAtRevision?: typeof addManagedGitSkillAtRevision;
  addLibraryAtRevision?: typeof addManagedGitLibraryAtRevision;
  addPackageAtRevision?: typeof addManagedGitPackageAtRevision;
  classifyResourceOutcome?: typeof classifyManagedGitImportOutcome;
  classifyLocalCollectionOutcome?: typeof classifyLocalCollectionImportOutcome;
  /** Stage 2 compatibility seam. */
  classifyLocalLibraryOutcome?: typeof classifyLocalLibraryImportOutcome;
  addLocalLibrary?: typeof addLibrary;
  addLocalPackage?: typeof addPackage;
  assertLocalCollectionMapping?: typeof assertLocalCollectionMappingSnapshot;
  /** Stage 2 compatibility seam. */
  assertLocalMapping?: typeof assertLocalLibraryMappingSnapshot;
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

export class ProfileImportPackageBuildAuthorizationRequiredError extends BazframeError {
  readonly plan: ProfileImportPlan;

  constructor(plan: ProfileImportPlan) {
    super(
      'PROFILE_IMPORT_PACKAGE_BUILD_AUTHORIZATION_REQUIRED',
      'The reported profile import plan requires package builds; noninteractive input requires --yes.'
    );
    this.name = 'ProfileImportPackageBuildAuthorizationRequiredError';
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
  authorizePackageBuild?: AuthorizePackageBuild;
}

interface ResourceProgressBase {
  kind: 'skill' | 'library' | 'package';
  id: string;
  initialAction: 'create' | 'reuse';
  attempted: boolean;
  successfulOutcome?: 'created' | 'reused';
}
type ResourceProgress =
  | (ResourceProgressBase & {
    sourceType: 'remoteGit';
    identity: PathFreeManagedGitIdentity;
    reuseRequirement?: ManagedGitExactRevisionReuseRequirement;
  })
  | (ResourceProgressBase & {
    kind: 'library' | 'package';
    sourceType: 'localMapping';
    mapping: LocalCollectionMappingSnapshot;
    expectedHealth?: LocalCollectionHealthSnapshot;
  });

export async function executeProfileImport(
  options: ExecuteProfileImportOptions,
  dependencies: ProfileImportExecutionDependencies = {}
): Promise<ProfileImportResult> {
  const prepared = prepareExecution(options);
  const services = {
    plan: dependencies.planImport ?? planProfileImport,
    addSkill: dependencies.addSkillAtRevision ?? addManagedGitSkillAtRevision,
    addLibrary: dependencies.addLibraryAtRevision ?? addManagedGitLibraryAtRevision,
    addPackage: dependencies.addPackageAtRevision ?? addManagedGitPackageAtRevision,
    classifyOutcome: dependencies.classifyResourceOutcome ?? classifyManagedGitImportOutcome,
    classifyLocalOutcome: dependencies.classifyLocalCollectionOutcome
      ?? (async (home, id, mapping) => mapping.kind === 'library'
        ? await (dependencies.classifyLocalLibraryOutcome ?? classifyLocalLibraryImportOutcome)(home, id, mapping)
        : await classifyLocalCollectionImportOutcome(home, id, mapping)) as typeof classifyLocalCollectionImportOutcome,
    addLocalLibrary: dependencies.addLocalLibrary ?? addLibrary,
    addLocalPackage: dependencies.addLocalPackage ?? addPackage,
    assertLocalMapping: dependencies.assertLocalCollectionMapping
      ?? (async (mapping) => mapping.kind === 'library'
        ? await (dependencies.assertLocalMapping ?? assertLocalLibraryMappingSnapshot)(mapping)
        : await assertLocalCollectionMappingSnapshot(mapping)) as typeof assertLocalCollectionMappingSnapshot,
    publish: dependencies.publishProfile ?? publishImportedProfile,
    lock: dependencies.stateLock ?? withStateLock,
    ensureDirectory: dependencies.ensureDirectory ?? ensureManagedDirectory
  };

  const packageBuilds = new PackageBuildReportAccumulator();
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
      services.classifyLocalOutcome,
      packageBuilds,
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
      if (resource.sourceType === 'localMapping') {
        if (resource.initialAction === 'reuse') {
          await services.assertLocalMapping(resource.mapping);
          const exact = await services.classifyLocalOutcome(initial.homePath, resource.id, resource.mapping);
          if (exact.state !== 'exact' || resource.expectedHealth === undefined
            || !sameLocalCollectionHealth(resource.expectedHealth, exact.health)) {
            throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', `Mapped local ${resource.kind} ${resource.id} is no longer an exact reuse.`);
          }
          resource.successfulOutcome = 'reused';
        } else {
          const result = await pathFreeLocalCollectionCreate(resource.kind, resource.id, () => services.lock(
            join(initial.homePath, 'locks', 'state.lock'),
            {
              command: `bazframe profile import local ${resource.kind}`,
              target: join(initial.homePath, resource.kind === 'library' ? 'libraries' : 'packages', `${resource.id}.json`)
            },
            async () => {
              const currentMapping = await services.assertLocalMapping(resource.mapping);
              if (!sameLocalCollectionMappingSnapshot(resource.mapping, currentMapping)) {
                throw new BazframeError('PROFILE_IMPORT_MAPPING_CHANGED', `Mapped ${resource.kind} ${resource.id} root changed before creation.`);
              }
              const current = await services.classifyLocalOutcome(initial.homePath, resource.id, resource.mapping);
              if (current.state !== 'absent') {
                throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', `Mapped local ${resource.kind} ${resource.id} is no longer absent at the create boundary.`);
              }
              const expectedRootIdentity = {
                root: resource.mapping.root,
                device: resource.mapping.device,
                inode: resource.mapping.inode
              };
              if (resource.kind === 'library') {
                return services.addLocalLibrary(lifecycleOptions, resource.mapping.root, {
                  stateLockHeld: true,
                  expectedRootIdentity
                });
              }
              const mapping = resource.mapping as LocalPackageMappingSnapshot;
              return services.addLocalPackage(lifecycleOptions, mapping.root, {
                stateLockHeld: true,
                expectedRootIdentity,
                expectedPackageManifest: mapping.manifestSnapshot,
                beforePackageBuild: async (context) => {
                  const before = await services.assertLocalMapping(mapping) as LocalPackageMappingSnapshot;
                  if (!sameLocalCollectionMappingSnapshot(mapping, before)
                    || !sameAuthorizedPackageInputs(resource.id, expectedRootIdentity, mapping.manifestSnapshot, context)) {
                    throw new BazframeError('PROFILE_IMPORT_MAPPING_CHANGED', `Mapped package ${resource.id} changed before build authorization.`);
                  }
                  const report = packageBuilds.add(createPackageBuildAuthorizationReport(
                    resource.id,
                    { type: 'localMapping', root: mapping.root },
                    context
                  ));
                  const approved = await prepared.authorizePackageBuild?.(copyPackageBuildReport(report)) ?? false;
                  if (approved !== true) {
                    throw new BazframeError('PROFILE_IMPORT_PACKAGE_BUILD_DECLINED', `Package build was not authorized for ${resource.id}.`);
                  }
                  const after = await services.assertLocalMapping(mapping) as LocalPackageMappingSnapshot;
                  if (!sameLocalCollectionMappingSnapshot(mapping, after)
                    || !sameAuthorizedPackageInputs(resource.id, expectedRootIdentity, mapping.manifestSnapshot, context)) {
                    throw new BazframeError('PROFILE_IMPORT_MAPPING_CHANGED', `Mapped package ${resource.id} changed during build authorization.`);
                  }
                  packageBuilds.markPossibleEffect(resource.id);
                }
              });
            },
            { managedRoot: initial.homePath }
          ));
          // Record success only after lock release so a post-commit release failure remains ambiguous.
          resource.successfulOutcome = localLifecycleOutcome(resource.kind, result);
        }
      } else {
        let result: ManagedGitLifecycleResult;
        if (resource.kind === 'skill') {
          result = await services.addSkill(lifecycleOptions, resource.id, resource.identity, resource.reuseRequirement);
        } else if (resource.kind === 'library') {
          result = await services.addLibrary(lifecycleOptions, resource.id, resource.identity, resource.reuseRequirement);
        } else {
          let approvedInputs: {
            rootIdentity: { root: string; device: bigint; inode: bigint };
            manifestSnapshot: PackageManifestSnapshot;
          } | undefined;
          result = await services.addPackage({
            ...lifecycleOptions,
            // Import authorization is performed only by the adjacent callback below.
            yes: true,
            beforePackageBuild: async (context) => {
              const report = packageBuilds.add(createPackageBuildAuthorizationReport(
                resource.id,
                { type: 'remoteGit', ...resource.identity },
                context
              ));
              const approved = await prepared.authorizePackageBuild?.(copyPackageBuildReport(report)) ?? false;
              if (approved !== true) {
                throw new BazframeError('PROFILE_IMPORT_PACKAGE_BUILD_DECLINED', `Package build was not authorized for ${resource.id}.`);
              }
              approvedInputs = {
                rootIdentity: { ...context.rootIdentity },
                manifestSnapshot: {
                  ...context.manifestSnapshot,
                  manifest: {
                    ...context.manifestSnapshot.manifest,
                    build: [...context.manifestSnapshot.manifest.build]
                  }
                }
              };
            },
            onPackageBuildReady: (context) => {
              if (approvedInputs === undefined || !sameAuthorizedPackageInputs(
                resource.id,
                approvedInputs.rootIdentity,
                approvedInputs.manifestSnapshot,
                context
              )) {
                throw new BazframeError('PROFILE_IMPORT_PACKAGE_CHANGED', `Package build authorization changed for ${resource.id}.`);
              }
              packageBuilds.markPossibleEffect(resource.id);
            }
          }, resource.id, resource.identity, resource.reuseRequirement);
        }
        resource.successfulOutcome = lifecycleOutcome(result);
      }
    }
  } catch (cause) {
    const resources = await classifyResourceResults(initial.homePath, progress, prepared.environment, services.classifyOutcome, services.classifyLocalOutcome);
    throw new ProfileImportExecutionError({
      ...profileBase,
      resources,
      profileOutcome: 'not-published',
      packageBuildReports: packageBuilds.reports(),
      possibleNonrollbackablePackageEffects: packageBuilds.possibleEffects()
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
    throw await executionFailure(profileBase, initial.homePath, progress, prepared.environment, services.classifyOutcome, services.classifyLocalOutcome, packageBuilds, 'not-published', cause);
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
      return successResult(profileBase, progress, packageBuilds, 'reused');
    } catch (cause) {
      throw await executionFailure(
        profileBase,
        initial.homePath,
        progress,
        prepared.environment,
        services.classifyOutcome,
        services.classifyLocalOutcome,
        packageBuilds,
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
    throw await executionFailure(profileBase, initial.homePath, progress, prepared.environment, services.classifyOutcome, services.classifyLocalOutcome, packageBuilds, 'not-published', cause);
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
      packageIds: [...authoritative.plan.packages],
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
    return successResult(profileBase, progress, packageBuilds, outcome);
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
      services.classifyLocalOutcome,
      packageBuilds,
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
  const mappings = (options.mappings ?? [])
    .map((mapping) => ({ kind: mapping.kind, id: mapping.id, root: mapping.root }));
  return {
    planOptions: {
      bazframeHome: resolve(options.bazframeHome),
      artifactDirectory: resolve(options.artifactDirectory),
      ...(destinationProfileId === undefined ? {} : { destinationProfileId }),
      mappings,
      environment: { ...(options.environment ?? process.env) }
    },
    environment: { ...(options.environment ?? process.env) },
    ...(acquisitionLimits === undefined ? {} : { acquisitionLimits }),
    ...(options.childOutputPolicy === undefined ? {} : { childOutputPolicy: options.childOutputPolicy }),
    reportPlan: options.reportPlan,
    ...(options.authorizePackageBuild === undefined ? {} : { authorizePackageBuild: options.authorizePackageBuild })
  };
}

function orderedResources(initial: ProfileImportPlanningResult): ResourceProgress[] {
  const plans = new Map(initial.plan.resources.map((resource) => [`${resource.kind}:${resource.id}`, resource]));
  const resources = [...initial.artifactSnapshot.artifact.resources]
    .sort((left, right) => compare(`${resourceOrder(left.kind)}:${left.id}`, `${resourceOrder(right.kind)}:${right.id}`));
  return resources.map((resource): ResourceProgress => {
    const plan = plans.get(`${resource.kind}:${resource.id}`);
    if (plan === undefined || plan.action === 'blocked') {
      throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', `Reported resource plan is incomplete for ${resource.kind}:${resource.id}.`);
    }
    if (resource.source.type === 'localMapping' && resource.kind !== 'skill') {
      const mapping = initial.mappingSnapshots.find(
        (item) => item.kind === resource.kind && item.id === resource.id
      );
      const snapshot = initial.resourceSnapshots.find(
        (item): item is Extract<ProfileImportResourceSnapshot, { sourceType: 'localMapping' }> => (
          item.kind === resource.kind && item.id === resource.id && item.sourceType === 'localMapping'
        )
      );
      if (mapping === undefined || (plan.action === 'reuse' && snapshot === undefined)) {
        throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', `Mapped ${resource.kind} evidence is missing for ${resource.kind}:${resource.id}.`);
      }
      return {
        kind: resource.kind,
        id: resource.id,
        sourceType: 'localMapping',
        mapping: copyLocalMapping(mapping),
        initialAction: plan.action,
        attempted: false,
        ...(snapshot === undefined ? {} : { expectedHealth: snapshot.health })
      };
    }
    if (resource.source.type !== 'remoteGit') {
      throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', `Unsupported resource source for ${resource.kind}:${resource.id}.`);
    }
    const snapshot = initial.resourceSnapshots.find(
      (item): item is Extract<ProfileImportResourceSnapshot, { sourceType: 'remoteGit' }> => (
        item.kind === resource.kind && item.id === resource.id && item.sourceType === 'remoteGit'
      )
    );
    if (plan.action === 'reuse' && snapshot === undefined) {
      throw new BazframeError('PROFILE_IMPORT_PLAN_INVALID', `Exact reuse evidence is missing for ${resource.kind}:${resource.id}.`);
    }
    const identity: PathFreeManagedGitIdentity = {
      remote: resource.source.remote,
      fetchUrl: resource.source.fetchUrl,
      branch: resource.source.branch,
      revision: resource.source.revision
    };
    return {
      kind: resource.kind,
      id: resource.id,
      sourceType: 'remoteGit',
      identity,
      initialAction: plan.action,
      attempted: false,
      ...(snapshot === undefined ? {} : { reuseRequirement: { mode: 'must-reuse' as const, expectedHealth: snapshot.health } })
    };
  });
}

async function pathFreeLocalCollectionCreate<T>(
  kind: 'library' | 'package',
  id: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new BazframeError(
      cause instanceof BazframeError ? cause.code : `PROFILE_IMPORT_LOCAL_${kind.toUpperCase()}_FAILED`,
      `Mapped local ${kind} ${id} creation did not complete safely.`,
      { cause }
    );
  }
}

function localLifecycleOutcome(kind: 'library' | 'package', result: SkillCollectionLifecycleResult): 'created' {
  if (result.action === 'added') return 'created';
  throw new BazframeError('PROFILE_IMPORT_RESOURCE_RESULT_INVALID', `Local ${kind} lifecycle returned an unsupported action.`);
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
  if (!sameMappingSnapshots(displayed.mappingSnapshots, current.mappingSnapshots)) {
    throw new BazframeError('PROFILE_IMPORT_MAPPING_CHANGED', 'Mapped library identity changed after the displayed plan.');
  }
  if (current.plan.resources.length !== displayed.plan.resources.length) {
    throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', 'Profile import resource closure changed after the displayed plan.');
  }
  for (const displayedResource of displayed.plan.resources) {
    const currentResource = current.plan.resources.find((resource) => (
      resource.kind === displayedResource.kind && resource.id === displayedResource.id
    ));
    if (currentResource === undefined || currentResource.action === 'blocked'
      || currentResource.source.type !== displayedResource.source.type
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
          && (displayedHealth === undefined
            || !samePlanningSnapshot(displayedResource.source.type, displayedHealth, currentHealth)))) {
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
  if (!sameMappingSnapshots(initial.mappingSnapshots, current.mappingSnapshots)
    || (expectedHealth !== undefined && !sameMappingSnapshots(expectedHealth.mappingSnapshots, current.mappingSnapshots))) {
    throw new BazframeError('PROFILE_IMPORT_MAPPING_CHANGED', 'Mapped library identity changed before final publication.');
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
        || (expected !== undefined && !samePlanningSnapshot(resource.source.type, expected, snapshot))) {
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
  const snapshot = result.resourceSnapshots.find(
    (item): item is Extract<ProfileImportResourceSnapshot, { sourceType: 'remoteGit' }> => (
      item.kind === kind && item.id === id && item.sourceType === 'remoteGit'
    )
  );
  if (snapshot === undefined) {
    throw new BazframeError('PROFILE_IMPORT_DEPENDENCY_CHANGED', `Profile import lacks exact remote Git health for ${kind}:${id}.`);
  }
  return snapshot.health;
}

async function classifyResourceResults(
  home: string,
  progress: readonly ResourceProgress[],
  environment: NodeJS.ProcessEnv,
  classify: typeof classifyManagedGitImportOutcome,
  classifyLocal: typeof classifyLocalCollectionImportOutcome
): Promise<ProfileImportResourceResult[]> {
  const results: ProfileImportResourceResult[] = [];
  for (const resource of progress) {
    let outcome: ProfileImportResourceOutcome;
    try {
      const classification = resource.sourceType === 'localMapping'
        ? await classifyLocal(home, resource.id, resource.mapping)
        : await classify(home, resource.kind, resource.id, resource.identity, environment);
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
  classifyLocal: typeof classifyLocalCollectionImportOutcome,
  packageBuilds: PackageBuildReportAccumulator,
  profileOutcome: ProfileImportProfileOutcome,
  cause: unknown
): Promise<ProfileImportExecutionError> {
  return new ProfileImportExecutionError({
    ...base,
    resources: await classifyResourceResults(home, progress, environment, classify, classifyLocal),
    profileOutcome,
    packageBuildReports: packageBuilds.reports(),
    possibleNonrollbackablePackageEffects: packageBuilds.possibleEffects()
  }, cause);
}

function successResult(
  base: Pick<ProfileImportResult, 'plan' | 'destinationPath' | 'activeSelectionChanged'>,
  progress: readonly ResourceProgress[],
  packageBuilds: PackageBuildReportAccumulator,
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
    profileOutcome,
    packageBuildReports: packageBuilds.reports(),
    possibleNonrollbackablePackageEffects: packageBuilds.possibleEffects()
  };
}

function samePlanningSnapshot(
  sourceType: 'remoteGit' | 'localMapping',
  left: ProfileImportResourceSnapshot,
  right: ProfileImportResourceSnapshot
): boolean {
  if (sourceType === 'localMapping') {
    return left.sourceType === 'localMapping' && right.sourceType === 'localMapping'
      && left.kind === right.kind
      && sameLocalCollectionHealth(left.health, right.health);
  }
  return left.sourceType === 'remoteGit' && right.sourceType === 'remoteGit'
    && sameManagedGitExportHealth(left.health, right.health);
}

function sameMappingSnapshots(
  left: readonly LocalCollectionMappingSnapshot[],
  right: readonly LocalCollectionMappingSnapshot[]
): boolean {
  return left.length === right.length && left.every((mapping, index) => (
    right[index] !== undefined && sameLocalCollectionMappingSnapshot(mapping, right[index]!)
  ));
}

function copyPartialResult(result: ProfileImportPartialResult): ProfileImportPartialResult {
  return {
    plan: copyPlan(result.plan),
    resources: result.resources.map((resource) => ({ ...resource })),
    profileOutcome: result.profileOutcome,
    destinationPath: result.destinationPath,
    activeSelectionChanged: false,
    packageBuildReports: (result.packageBuildReports ?? []).map(copyPackageBuildReport),
    possibleNonrollbackablePackageEffects: [...(result.possibleNonrollbackablePackageEffects ?? [])]
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
    packages: [...plan.packages],
    resources: plan.resources.map((resource) => resource.source.type === 'remoteGit'
      ? { ...resource, source: { ...resource.source } }
      : {
        ...resource,
        kind: resource.kind as 'library' | 'package',
        source: { ...resource.source },
        networkRequired: false as const
      }),
    packageBuilds: {
      ...plan.packageBuilds,
      unresolvedRemotePackageIds: [...plan.packageBuilds.unresolvedRemotePackageIds],
      warnings: [...plan.packageBuilds.warnings]
    },
    activeSelection: { ...plan.activeSelection },
    composition: {
      ...plan.composition,
      deferredLibraries: [...plan.composition.deferredLibraries],
      deferredPackages: [...plan.composition.deferredPackages],
      knownCollectionSkillPreview: [...plan.composition.knownCollectionSkillPreview]
    },
    exclusions: { ...plan.exclusions },
    profileAction: plan.profileAction,
    blockers: plan.blockers.map((blocker) => ({ ...blocker }))
  };
}

function copyLocalMapping(mapping: LocalCollectionMappingSnapshot): LocalCollectionMappingSnapshot {
  return mapping.kind === 'library'
    ? { ...mapping }
    : { ...mapping, manifestSnapshot: mapping.manifestSnapshot };
}

function resourceOrder(kind: 'skill' | 'library' | 'package'): string {
  return kind === 'skill' ? '0' : kind === 'library' ? '1' : '2';
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
