import { ExecutableHelperUncertainError, resolvePackageExecutable, type ResolvedExecutable } from '../core/executable-resolution.js';
import { sameResourceIdentity, type ResourceRootIdentity } from './resource-identity.js';
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

export type CanonicalPackageRootIdentity = ResourceRootIdentity;
export interface SkillCollectionPreparationEffects {
  basename: typeof basename;
  resolveBuild?(argv: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<ResolvedExecutable>;
  rootIdentity(root: string): Promise<ResourceRootIdentity>;
  manifestAbsent(root: string): Promise<boolean>;
  readManifest: typeof readPackageManifest;
  resolveDirectory: typeof resolvePhysicalRelativeDirectory;
  snapshotDependencies(): SkillSnapshotDependencies;
  assertAuthority(): void;
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
  effects?: SkillCollectionPreparationEffects;
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
  snapshotDependencies: SkillSnapshotDependencies = {},
  effects?: SkillCollectionPreparationEffects
): Promise<PreparedLibrary> {
  await assertLibraryManifestAbsent(libraryRoot, effects);
  const snapshot = await publishSkillSnapshot(bazframeHome, libraryRoot, { ...effects?.snapshotDependencies(), ...snapshotDependencies });
  await assertLibraryManifestAbsent(libraryRoot, effects);
  await (effects?.resolveDirectory ?? resolvePhysicalRelativeDirectory)(snapshot.artifactPath, '.');
  effects?.assertAuthority();
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
  const effects = dependencies.effects;
  const policy = packageLimitPolicy(dependencies.limitPolicy);
  const rootIdentity = await (effects?.rootIdentity ?? physicalRootIdentity)(packageRoot);
  assertExpectedPackageRootIdentity(rootIdentity, dependencies.expectedRootIdentity);
  const initial = await (effects?.readManifest ?? readPackageManifest)(packageRoot, policy);
  if (expectedManifest !== undefined && !samePackageManifestSnapshot(expectedManifest, initial)) {
    throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed after build authorization.');
  }
  await assertPhysicalRootIdentity(packageRoot, rootIdentity, effects);
  const adjacentManifest = await (effects?.readManifest ?? readPackageManifest)(packageRoot, policy);
  if (!samePackageManifestSnapshot(initial, adjacentManifest)) {
    throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed before build.');
  }
  freezePackageManifestSnapshot(initial);
  let launch = effects?.resolveBuild !== undefined
    ? await effects.resolveBuild(initial.manifest.build, packageRoot, environment)
    : process.platform === 'win32'
      ? await resolvePackageExecutable(initial.manifest.build, { cwd: packageRoot, environment })
      : { executable: initial.manifest.build[0]!, args: initial.manifest.build.slice(1) };
  await dependencies.beforePackageBuild?.(Object.freeze({
    packageId: (effects?.basename ?? basename)(rootIdentity.root),
    rootIdentity: Object.freeze({ ...rootIdentity }),
    manifestSnapshot: initial
  }));
  await assertPhysicalRootIdentity(packageRoot, rootIdentity, effects);
  if (!samePackageManifestSnapshot(initial, await (effects?.readManifest ?? readPackageManifest)(packageRoot, policy))) throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed before authorized helper execution.');
  effects?.assertAuthority();
  try { if ('afterAuthorization' in launch && launch.afterAuthorization !== undefined) launch = await launch.afterAuthorization(); }
  catch (error) { if (error instanceof ExecutableHelperUncertainError) throw new PackageBuildTerminationUncertainError(undefined, { cause: error }); throw error; }
  await assertPhysicalRootIdentity(packageRoot, rootIdentity, effects);
  if (!samePackageManifestSnapshot(initial, await (effects?.readManifest ?? readPackageManifest)(packageRoot, policy))) throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed during adjacent build authorization.');
  effects?.assertAuthority();
  await executeBuild(
    [launch.executable, ...launch.args],
    packageRoot,
    environment,
    childOutputPolicy,
    policy,
    dependencies.packageProcessRunner ?? spawnBoundedPackageProcess
  );
  await assertPhysicalRootIdentity(packageRoot, rootIdentity, effects);
  const revalidated = await (effects?.readManifest ?? readPackageManifest)(packageRoot, policy);
  if (!samePackageManifestSnapshot(initial, revalidated)) throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed during build.');
  const artifactPath = await (effects?.resolveDirectory ?? resolvePhysicalRelativeDirectory)(packageRoot, initial.manifest.artifactRoot);
  await (effects?.resolveDirectory ?? resolvePhysicalRelativeDirectory)(artifactPath, initial.manifest.skillsRoot);
  const snapshot = await publishSkillSnapshot(bazframeHome, artifactPath, effects?.snapshotDependencies());
  await (effects?.resolveDirectory ?? resolvePhysicalRelativeDirectory)(snapshot.artifactPath, initial.manifest.skillsRoot);
  await afterSnapshot?.();
  await assertPhysicalRootIdentity(packageRoot, rootIdentity, effects);
  const finalManifest = await (effects?.readManifest ?? readPackageManifest)(packageRoot, policy);
  if (!samePackageManifestSnapshot(initial, finalManifest)) throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed before activation.');
  effects?.assertAuthority();
  return {
    kind: 'package', snapshot, artifactRoot: initial.manifest.artifactRoot,
    skillsRoot: initial.manifest.skillsRoot, manifestSnapshot: initial
  };
}

export async function revalidatePreparedCollectionDeclaration(
  root: string,
  prepared: PreparedSkillCollection,
  effects?: SkillCollectionPreparationEffects
): Promise<void> {
  if (prepared.kind === 'library') {
    await assertLibraryManifestAbsent(root, effects);
    return;
  }
  const current = await (effects?.readManifest ?? readPackageManifest)(root);
  if (!samePackageManifestSnapshot(prepared.manifestSnapshot, current)) {
    throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed before activation.');
  }
}

async function assertLibraryManifestAbsent(libraryRoot: string, effects?: SkillCollectionPreparationEffects): Promise<void> {
  if (effects !== undefined) {
    if (!await effects.manifestAbsent(libraryRoot)) throw new BazframeError('LIBRARY_IS_PACKAGE', `Library root contains ${PACKAGE_MANIFEST}. Use package add.`);
    return;
  }
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

type RootIdentity = ResourceRootIdentity;

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
    && (current.root !== expected.root || !sameResourceIdentity(current, expected))) {
    throw new BazframeError('SKILL_COLLECTION_ROOT_CHANGED', `Package root does not match the caller's expected physical identity: ${current.root}`);
  }
}

async function assertPhysicalRootIdentity(root: string, expected: RootIdentity, effects?: SkillCollectionPreparationEffects): Promise<void> {
  effects?.assertAuthority();
  const current = await (effects?.rootIdentity ?? physicalRootIdentity)(root);
  if (!sameResourceIdentity(current, expected) || current.root !== expected.root) {
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
  if (result.failure !== undefined || result.error !== undefined || result.uncertainTermination === true) {
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
