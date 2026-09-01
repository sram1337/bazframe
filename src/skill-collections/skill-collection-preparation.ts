import { lstat, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  spawnBoundedPackageProcess,
  type BoundedPackageProcessOptions,
  type BoundedPackageProcessResult,
  type ChildOutputPolicy
} from '../core/child-process.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { PACKAGE_MANIFEST, readPackageManifest, samePackageManifestSnapshot, type PackageManifestSnapshot } from '../packages/package-manifest.js';
import { packageLimitPolicy, type PackageLimitPolicy } from '../profile-portability/profile-portability-policy.js';
import { publishSkillSnapshot, resolvePhysicalRelativeDirectory, type PublishedSnapshot, type SkillSnapshotDependencies } from './skill-snapshot.js';

export interface PreparedLibrary { kind: 'library'; snapshot: PublishedSnapshot; skillsRoot: '.' }
export interface PreparedPackage {
  kind: 'package';
  snapshot: PublishedSnapshot;
  artifactRoot: string;
  skillsRoot: string;
  manifestSnapshot: PackageManifestSnapshot;
}
export type PreparedSkillCollection = PreparedLibrary | PreparedPackage;

export interface CanonicalPackageRootIdentity {
  readonly root: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface BeforePackageBuildContext {
  readonly packageId: string;
  readonly rootIdentity: CanonicalPackageRootIdentity;
  readonly manifestSnapshot: PackageManifestSnapshot;
}

export class PackageBuildTerminationUncertainError extends BazframeError {
  constructor(message = 'Package build termination could not be proven.', options?: ErrorOptions) {
    super('PACKAGE_BUILD_TERMINATION_UNCERTAIN', message, options);
    this.name = 'PackageBuildTerminationUncertainError';
  }
}

export class PackageBuildInterruptedError extends BazframeError {
  readonly signal: Extract<NodeJS.Signals, 'SIGHUP' | 'SIGINT' | 'SIGTERM'>;

  constructor(signal: Extract<NodeJS.Signals, 'SIGHUP' | 'SIGINT' | 'SIGTERM'>) {
    super('PACKAGE_BUILD_INTERRUPTED', `Package build was interrupted by parent signal ${signal}.`);
    this.name = 'PackageBuildInterruptedError';
    this.signal = signal;
  }
}

export function packageBuildInterruptionSignal(error: unknown): NodeJS.Signals | undefined {
  if (error instanceof PackageBuildInterruptedError) return error.signal;
  if (error instanceof AggregateError) {
    for (const item of error.errors) {
      const signal = packageBuildInterruptionSignal(item);
      if (signal !== undefined) return signal;
    }
  }
  return error instanceof Error && error.cause !== undefined
    ? packageBuildInterruptionSignal(error.cause)
    : undefined;
}

export function isUncertainPackageBuildError(error: unknown): boolean {
  if (error instanceof PackageBuildTerminationUncertainError) return true;
  if (error instanceof Error && error.cause !== undefined && isUncertainPackageBuildError(error.cause)) return true;
  return error instanceof AggregateError && error.errors.some(isUncertainPackageBuildError);
}

export interface PackagePreparationDependencies {
  beforePackageBuild?: (context: BeforePackageBuildContext) => void | Promise<void>;
  expectedRootIdentity?: CanonicalPackageRootIdentity;
  limitPolicy?: Partial<PackageLimitPolicy>;
  packageProcessRunner?: (
    executable: string,
    args: readonly string[],
    options: BoundedPackageProcessOptions
  ) => Promise<BoundedPackageProcessResult>;
}

export async function prepareLibrary(
  bazframeHome: string,
  libraryRoot: string,
  snapshotDependencies: SkillSnapshotDependencies = {}
): Promise<PreparedLibrary> {
  const manifestPath = join(libraryRoot, PACKAGE_MANIFEST);
  try {
    await lstat(manifestPath);
    throw new BazframeError('LIBRARY_IS_PACKAGE', `Library root contains ${PACKAGE_MANIFEST}. Use \`bazframe package add <absolute-root>\`.`);
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    if (errorCode(error) !== 'ENOENT') throw new BazframeError('LIBRARY_ROOT_INVALID', `Could not inspect library root: ${libraryRoot}`, { cause: error });
  }
  const snapshot = await publishSkillSnapshot(bazframeHome, libraryRoot, snapshotDependencies);
  await assertLibraryManifestAbsent(libraryRoot);
  await resolvePhysicalRelativeDirectory(snapshot.artifactPath, '.');
  return { kind: 'library', snapshot, skillsRoot: '.' };
}

export async function preparePackage(
  bazframeHome: string,
  packageRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  afterSnapshot?: () => Promise<void>,
  expectedManifest?: PackageManifestSnapshot,
  childOutputPolicy: ChildOutputPolicy = 'inherit',
  dependencies: PackagePreparationDependencies = {}
): Promise<PreparedPackage> {
  const policy = packageLimitPolicy(dependencies.limitPolicy);
  const rootIdentity = await physicalRootIdentity(packageRoot);
  assertExpectedPackageRootIdentity(rootIdentity, dependencies.expectedRootIdentity);
  const initial = await readPackageManifest(packageRoot, policy);
  if (expectedManifest !== undefined && !samePackageManifestSnapshot(expectedManifest, initial)) {
    throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed after build authorization.');
  }
  await assertPhysicalRootIdentity(packageRoot, rootIdentity);
  const adjacentManifest = await readPackageManifest(packageRoot, policy);
  if (!samePackageManifestSnapshot(initial, adjacentManifest)) {
    throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed before build.');
  }
  freezePackageManifestSnapshot(initial);
  await dependencies.beforePackageBuild?.(Object.freeze({
    packageId: basename(rootIdentity.root),
    rootIdentity: Object.freeze({ root: rootIdentity.root, device: rootIdentity.device, inode: rootIdentity.inode }),
    manifestSnapshot: initial
  }));
  await executeBuild(
    initial.manifest.build,
    packageRoot,
    environment,
    childOutputPolicy,
    policy,
    dependencies.packageProcessRunner ?? spawnBoundedPackageProcess
  );
  await assertPhysicalRootIdentity(packageRoot, rootIdentity);
  const revalidated = await readPackageManifest(packageRoot, policy);
  if (!samePackageManifestSnapshot(initial, revalidated)) throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed during build.');
  const artifactPath = await resolvePhysicalRelativeDirectory(packageRoot, initial.manifest.artifactRoot);
  await resolvePhysicalRelativeDirectory(artifactPath, initial.manifest.skillsRoot);
  const snapshot = await publishSkillSnapshot(bazframeHome, artifactPath);
  await resolvePhysicalRelativeDirectory(snapshot.artifactPath, initial.manifest.skillsRoot);
  await afterSnapshot?.();
  await assertPhysicalRootIdentity(packageRoot, rootIdentity);
  const finalManifest = await readPackageManifest(packageRoot, policy);
  if (!samePackageManifestSnapshot(initial, finalManifest)) throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed before activation.');
  return {
    kind: 'package', snapshot, artifactRoot: initial.manifest.artifactRoot,
    skillsRoot: initial.manifest.skillsRoot, manifestSnapshot: initial
  };
}

export async function revalidatePreparedCollectionDeclaration(
  root: string,
  prepared: PreparedSkillCollection
): Promise<void> {
  if (prepared.kind === 'library') {
    await assertLibraryManifestAbsent(root);
    return;
  }
  const current = await readPackageManifest(root);
  if (!samePackageManifestSnapshot(prepared.manifestSnapshot, current)) {
    throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed before activation.');
  }
}

async function assertLibraryManifestAbsent(libraryRoot: string): Promise<void> {
  const manifestPath = join(libraryRoot, PACKAGE_MANIFEST);
  try {
    await lstat(manifestPath);
    throw new BazframeError('LIBRARY_IS_PACKAGE', `Library root contains ${PACKAGE_MANIFEST}. Use \`bazframe package add <absolute-root>\`.`);
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    if (errorCode(error) !== 'ENOENT') {
      throw new BazframeError('LIBRARY_ROOT_INVALID', `Could not inspect library root: ${libraryRoot}`, { cause: error });
    }
  }
}

interface RootIdentity { device: bigint; inode: bigint; root: string }

async function physicalRootIdentity(root: string): Promise<RootIdentity> {
  const metadata = await lstat(root, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('PACKAGE_ROOT_CHANGED', `Package root must remain a physical directory: ${root}`);
  return { device: metadata.dev, inode: metadata.ino, root: await realpath(root) };
}

function freezePackageManifestSnapshot(snapshot: PackageManifestSnapshot): void {
  Object.freeze(snapshot.manifest.build);
  Object.freeze(snapshot.manifest);
  Object.freeze(snapshot);
}

function assertExpectedPackageRootIdentity(current: RootIdentity, expected: CanonicalPackageRootIdentity | undefined): void {
  if (expected !== undefined
    && (current.root !== expected.root || current.device !== expected.device || current.inode !== expected.inode)) {
    throw new BazframeError('SKILL_COLLECTION_ROOT_CHANGED', `Package root does not match the caller's expected physical identity: ${current.root}`);
  }
}

async function assertPhysicalRootIdentity(root: string, expected: RootIdentity): Promise<void> {
  const current = await physicalRootIdentity(root);
  if (current.device !== expected.device || current.inode !== expected.inode || current.root !== expected.root) {
    throw new BazframeError('PACKAGE_ROOT_CHANGED', `Package root changed during build: ${root}`);
  }
}

async function executeBuild(
  argv: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  outputPolicy: ChildOutputPolicy,
  policy: Readonly<PackageLimitPolicy>,
  runner: NonNullable<PackagePreparationDependencies['packageProcessRunner']>
): Promise<void> {
  let result: BoundedPackageProcessResult;
  try {
    result = await runner(argv[0]!, argv.slice(1), {
      cwd,
      environment,
      ...(outputPolicy === 'inherit' ? {} : { outputPolicy }),
      timeoutMilliseconds: policy.maxBuildMilliseconds,
      terminationGraceMilliseconds: policy.terminationGraceMilliseconds
    });
  } catch (error) {
    throw new BazframeError('PACKAGE_BUILD_FAILED', `Could not start package build: ${argv[0]}`, { cause: error });
  }
  if (result.failure !== undefined) {
    if (result.uncertainTermination === true || result.failure === 'termination-uncertain') {
      throw new PackageBuildTerminationUncertainError(
        'Package build termination could not be proven.',
        { ...(result.error === undefined ? {} : { cause: result.error }) }
      );
    }
    if (result.failure === 'parent-signal'
      && (result.signal === 'SIGHUP' || result.signal === 'SIGINT' || result.signal === 'SIGTERM')) {
      throw new PackageBuildInterruptedError(result.signal);
    }
    const detail = result.failure === 'timeout'
      ? 'Package build timed out.'
      : result.failure === 'process-tree-survived'
        ? 'Package build leader exited while descendant processes remained.'
        : `Could not start package build: ${argv[0]}.`;
    throw new BazframeError('PACKAGE_BUILD_FAILED', detail, { ...(result.error === undefined ? {} : { cause: result.error }) });
  }
  if (result.exitCode === 0 && result.signal === null) return;
  throw new BazframeError(
    'PACKAGE_BUILD_FAILED',
    result.signal === null
      ? `Package build exited with status ${result.exitCode ?? 1}.`
      : `Package build terminated by signal ${result.signal}.`
  );
}
