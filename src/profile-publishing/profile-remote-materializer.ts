import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError } from '../core/errors.js';
import type { ChildOutputPolicy } from '../core/child-process.js';
import {
  PackageBuildReportAccumulator,
  createPackageBuildAuthorizationReport
} from '../profile-portability/profile-import-package-build.js';
import {
  addManagedGitLibraryAtRevision,
  addManagedGitPackageAtRevision,
  addManagedGitSkillAtRevision,
  isDefiniteManagedGitAcquisitionUnavailable,
  isUncertainManagedGitOperation,
  type ManagedGitOptions
} from '../providers/managed-git.js';
import { ensureManagedDirectory, writeFileAtomic } from '../state/atomic-file.js';
import { publishArtifactTree, type ArtifactTreeManifestV1 } from './artifact-tree.js';
import { publishStoredBlob } from './blob-store.js';
import { type CapturedResource, type ExactRemoteGitIdentity } from './captured-profile.js';
import { captureCatalogResource } from './profile-capture.js';
import type {
  ProfileLifecycleRemoteAdapter,
  RemoteResourceMaterializationContext
} from './profile-lifecycle.js';
import { createOwnedProfileGithubDirectory } from './profile-github-process.js';
import { assertOperationMutationAuthority } from './profile-operation-lock.js';

export interface ProductionProfileRemoteAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  childOutputPolicy?: ChildOutputPolicy;
  /** Deterministic internal seams forwarded only for managed-Git lifecycle tests. */
  testHooks?: ManagedGitOptions['testHooks'];
}

interface OwnedDirectoryIdentity { device: bigint; inode: bigint }

/**
 * Production exact-revision materialization. Stage 3 runs in an isolated home,
 * so its catalog/provenance state can never collide with the user's catalog.
 */
export function createProductionProfileLifecycleRemoteAdapter(
  options: ProductionProfileRemoteAdapterOptions = {}
): ProfileLifecycleRemoteAdapter {
  const environment = { ...(options.environment ?? process.env) };
  return {
    materialize: (resource, context) => materializeRemote(resource, context, environment, options.childOutputPolicy, options.testHooks)
  };
}

async function materializeRemote(
  resource: CapturedResource,
  context: RemoteResourceMaterializationContext,
  environment: NodeJS.ProcessEnv,
  childOutputPolicy?: ChildOutputPolicy,
  testHooks?: ManagedGitOptions['testHooks']
) {
  if (resource.payload.kind !== 'remoteGit') throw invalid('remote adapter received a non-remote resource');
  assertOperationMutationAuthority(context.authority, context.home, ['@store'], context.transactionId);
  const temporaryRoot = join(context.home, 'profile-publishing', 'remote-materialization');
  await ensureManagedDirectory(context.home, temporaryRoot);
  assertOperationMutationAuthority(context.authority, context.home, ['@store'], context.transactionId);
  const owned = await createOwnedProfileGithubDirectory(temporaryRoot, 'bazframe-profile-remote-');
  const temporaryHome = owned.path;
  const temporaryIdentity = await directoryIdentity(temporaryHome);
  let result: Awaited<ReturnType<typeof publishCapturedArtifact>> | undefined;
  let primaryError: unknown;
  try {
    const acquisitionEnvironment = await strictGitAcquisitionEnvironment(temporaryHome, environment);
    await acquireIntoIsolatedHome(temporaryHome, resource, context, acquisitionEnvironment, childOutputPolicy, testHooks);
    await assertOwnedDirectory(temporaryHome, temporaryIdentity);
    const captured = await captureCatalogResource({
      bazframeHome: temporaryHome,
      kind: resource.key.kind,
      name: resource.key.name,
      capturedResourceId: resource.id,
      bundleRemote: true,
      environment: acquisitionEnvironment
    });
    await assertOwnedDirectory(temporaryHome, temporaryIdentity);
    result = await publishCapturedArtifact(resource, captured, context);
    await assertOwnedDirectory(temporaryHome, temporaryIdentity);
  } catch (error) {
    primaryError = error;
  }

  try {
    await owned.dispose();
  } catch {
    throw cleanupInvalid(primaryError === undefined
      ? 'retained isolated-home identity was not proved'
      : 'retained isolated-home identity was not proved after a failed operation');
  }

  if (primaryError !== undefined) {
    if (isUncertainManagedGitOperation(primaryError)) {
      throw new BazframeError(
        'PROFILE_REMOTE_MATERIALIZATION_RECOVERY_REQUIRED',
        'Remote materialization settlement is uncertain; private isolated state was retained for diagnosis.'
      );
    }
    if (isDefiniteManagedGitAcquisitionUnavailable(primaryError)) {
      return { kind: 'acquisitionUnavailable' as const, diagnosticCode: 'REMOTE_UNAVAILABLE', cacheWritten: false, buildExecuted: false };
    }
    throw primaryError;
  }
  if (result === undefined) throw invalid('remote materialization completed without an artifact result');
  return result;
}

async function acquireIntoIsolatedHome(
  temporaryHome: string,
  resource: CapturedResource,
  context: RemoteResourceMaterializationContext,
  environment: NodeJS.ProcessEnv,
  childOutputPolicy?: ChildOutputPolicy,
  testHooks?: ManagedGitOptions['testHooks']
): Promise<void> {
  if (resource.payload.kind !== 'remoteGit') throw invalid('remote acquisition identity is absent');
  const identity = resource.payload.identity;
  let authorizationCalls = 0;
  const managedOptions: ManagedGitOptions = {
    bazframeHome: temporaryHome,
    environment,
    yes: true,
    ...(childOutputPolicy === undefined ? {} : { childOutputPolicy }),
    ...(testHooks === undefined ? {} : { testHooks }),
    ...(resource.key.kind === 'package' ? {
      beforePackageBuild: async (buildContext) => {
        authorizationCalls += 1;
        if (authorizationCalls !== 1) throw invalid('package authorization callback ran more than once');
        const report = new PackageBuildReportAccumulator().add(createPackageBuildAuthorizationReport(
          resource.key.name,
          { type: 'remoteGit', ...identity },
          buildContext
        ));
        const authorization = context.packageBuildAuthorization;
        if (authorization.mode === 'preauthorized') return;
        if (authorization.mode === 'decline' || !await authorization.authorize(report)) {
          throw new BazframeError('PROFILE_PACKAGE_BUILD_CONFIRMATION_REQUIRED', 'Package build was not authorized.');
        }
      }
    } : {})
  };
  if (resource.key.kind === 'skill') {
    await addManagedGitSkillAtRevision(managedOptions, resource.key.name, identity);
  } else if (resource.key.kind === 'library') {
    await addManagedGitLibraryAtRevision(managedOptions, resource.key.name, identity);
  } else {
    await addManagedGitPackageAtRevision(managedOptions, resource.key.name, identity);
  }
}

async function publishCapturedArtifact(
  requested: CapturedResource,
  captured: Awaited<ReturnType<typeof captureCatalogResource>>,
  context: RemoteResourceMaterializationContext
): Promise<{ kind: 'ready'; treeId: string; identity: ExactRemoteGitIdentity; cacheWritten: boolean; buildExecuted: boolean }> {
  if (requested.payload.kind !== 'remoteGit' || captured.resource.id !== requested.id
    || captured.resource.key.kind !== requested.key.kind || captured.resource.key.name !== requested.key.name
    || captured.resource.payload.kind !== 'bundled'
    || captured.resource.payload.role !== roleFor(requested.key.kind)
    || captured.resource.payload.origin === undefined
    || !sameIdentity(captured.resource.payload.origin, requested.payload.identity)) {
    throw invalid('isolated capture does not match the requested exact remote identity');
  }
  const blobs = new Map(captured.blobs.map((blob) => [blob.sha256, blob]));
  for (const file of captured.resource.payload.files) {
    const blob = blobs.get(file.sha256);
    if (blob === undefined || blob.bytes !== file.bytes) throw invalid('isolated capture blob closure is incomplete');
  }
  if (new Set(captured.resource.payload.files.map((file) => file.sha256)).size !== blobs.size) {
    throw invalid('isolated capture blob closure contains unreferenced bytes');
  }
  let cacheWritten = false;
  for (const blob of captured.blobs) {
    assertOperationMutationAuthority(context.authority, context.home, ['@store'], context.transactionId);
    const published = await publishStoredBlob(context.home, context.authority, blob.bytesValue, blob.sha256);
    cacheWritten ||= !published.reused;
  }
  const manifest: ArtifactTreeManifestV1 = {
    schemaVersion: 1,
    kind: 'bazframe-artifact-tree',
    role: captured.resource.payload.role,
    files: captured.resource.payload.files.map((file) => ({ ...file }))
  };
  assertOperationMutationAuthority(context.authority, context.home, ['@store'], context.transactionId);
  const tree = await publishArtifactTree(context.home, context.authority, manifest);
  cacheWritten ||= !tree.reused;
  return { kind: 'ready', treeId: tree.treeId, identity: structuredClone(requested.payload.identity), cacheWritten, buildExecuted: requested.key.kind === 'package' };
}

async function strictGitAcquisitionEnvironment(temporaryHome: string, inherited: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const gitHome = join(temporaryHome, 'git-home');
  const xdgHome = join(temporaryHome, 'git-xdg');
  const hooks = join(temporaryHome, 'git-hooks');
  await ensureManagedDirectory(temporaryHome, gitHome);
  await ensureManagedDirectory(temporaryHome, xdgHome);
  await ensureManagedDirectory(temporaryHome, hooks);
  const globalConfig = join(temporaryHome, 'git-global-config');
  await writeFileAtomic(globalConfig, '', { managedRoot: temporaryHome, mode: 0o600, commitOnRename: true });
  const inheritedConfigHome = inherited.XDG_CONFIG_HOME ?? (inherited.HOME === undefined ? undefined : join(inherited.HOME, '.config'));
  const githubConfig = inherited.GH_CONFIG_DIR ?? (inheritedConfigHome === undefined ? undefined : join(inheritedConfigHome, 'gh'));
  return {
    ...inherited,
    ...(githubConfig === undefined ? {} : { GH_CONFIG_DIR: githubConfig }),
    BAZFRAME_STRICT_GIT_ENVIRONMENT: '1',
    BAZFRAME_STRICT_GIT_HOME: gitHome,
    BAZFRAME_STRICT_GIT_XDG_HOME: xdgHome,
    BAZFRAME_STRICT_GIT_GLOBAL_CONFIG: globalConfig,
    BAZFRAME_STRICT_GIT_HOOKS: hooks
  };
}

async function directoryIdentity(path: string): Promise<OwnedDirectoryIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw cleanupInvalid('isolated home is not a physical directory');
  return { device: metadata.dev, inode: metadata.ino };
}

async function assertOwnedDirectory(path: string, expected: OwnedDirectoryIdentity): Promise<void> {
  const current = await directoryIdentity(path);
  if (current.device !== expected.device || current.inode !== expected.inode) throw cleanupInvalid('isolated home ownership changed');
}

function roleFor(kind: CapturedResource['key']['kind']): ArtifactTreeManifestV1['role'] {
  return kind === 'package' ? 'packageArtifacts' : kind;
}
function sameIdentity(left: ExactRemoteGitIdentity, right: ExactRemoteGitIdentity): boolean {
  return left.remote === right.remote && left.fetchUrl === right.fetchUrl
    && left.branch === right.branch && left.revision === right.revision;
}
function invalid(detail: string): BazframeError {
  return new BazframeError('PROFILE_REMOTE_MATERIALIZATION_INVALID', `Invalid remote profile materialization: ${detail}.`);
}
function cleanupInvalid(detail: string): BazframeError {
  return new BazframeError('PROFILE_REMOTE_MATERIALIZATION_CLEANUP_UNPROVEN', `Remote materialization cleanup was not proved: ${detail}.`);
}
