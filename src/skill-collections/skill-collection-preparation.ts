import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnInheritedChild } from '../core/child-process.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { PACKAGE_MANIFEST, readPackageManifest, samePackageManifestSnapshot, type PackageManifestSnapshot } from '../packages/package-manifest.js';
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

export async function prepareLibrary(
  bazframeHome: string,
  libraryRoot: string,
  snapshotDependencies: SkillSnapshotDependencies = {}
): Promise<PreparedLibrary> {
  const manifestPath = join(libraryRoot, PACKAGE_MANIFEST);
  try {
    await lstat(manifestPath);
    throw new BazframeError('LIBRARY_IS_PACKAGE', `Library root contains ${PACKAGE_MANIFEST}. Use \`bazframe packages add <absolute-root>\`.`);
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
  expectedManifest?: PackageManifestSnapshot
): Promise<PreparedPackage> {
  const rootIdentity = await physicalRootIdentity(packageRoot);
  const initial = await readPackageManifest(packageRoot);
  if (expectedManifest !== undefined && !samePackageManifestSnapshot(expectedManifest, initial)) {
    throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed after build authorization.');
  }
  await executeBuild(initial.manifest.build, packageRoot, environment);
  await assertPhysicalRootIdentity(packageRoot, rootIdentity);
  const revalidated = await readPackageManifest(packageRoot);
  if (!samePackageManifestSnapshot(initial, revalidated)) throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed during build.');
  const artifactPath = await resolvePhysicalRelativeDirectory(packageRoot, initial.manifest.artifactRoot);
  await resolvePhysicalRelativeDirectory(artifactPath, initial.manifest.skillsRoot);
  const snapshot = await publishSkillSnapshot(bazframeHome, artifactPath);
  await resolvePhysicalRelativeDirectory(snapshot.artifactPath, initial.manifest.skillsRoot);
  await afterSnapshot?.();
  await assertPhysicalRootIdentity(packageRoot, rootIdentity);
  const finalManifest = await readPackageManifest(packageRoot);
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
    throw new BazframeError('LIBRARY_IS_PACKAGE', `Library root contains ${PACKAGE_MANIFEST}. Use \`bazframe packages add <absolute-root>\`.`);
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    if (errorCode(error) !== 'ENOENT') {
      throw new BazframeError('LIBRARY_ROOT_INVALID', `Could not inspect library root: ${libraryRoot}`, { cause: error });
    }
  }
}

interface RootIdentity { device: bigint; inode: bigint; canonicalPath: string }

async function physicalRootIdentity(root: string): Promise<RootIdentity> {
  const metadata = await lstat(root, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('PACKAGE_ROOT_CHANGED', `Package root must remain a physical directory: ${root}`);
  return { device: metadata.dev, inode: metadata.ino, canonicalPath: await realpath(root) };
}

async function assertPhysicalRootIdentity(root: string, expected: RootIdentity): Promise<void> {
  const current = await physicalRootIdentity(root);
  if (current.device !== expected.device || current.inode !== expected.inode || current.canonicalPath !== expected.canonicalPath) {
    throw new BazframeError('PACKAGE_ROOT_CHANGED', `Package root changed during build: ${root}`);
  }
}

async function executeBuild(argv: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<void> {
  let result;
  try {
    result = await spawnInheritedChild(argv[0]!, argv.slice(1), { cwd, environment });
  } catch (error) {
    throw new BazframeError('PACKAGE_BUILD_FAILED', `Could not start package build: ${argv[0]}`, { cause: error });
  }
  if (result.exitCode === 0 && result.signal === null) return;
  throw new BazframeError(
    'PACKAGE_BUILD_FAILED',
    result.signal === null
      ? `Package build exited with status ${result.exitCode ?? 1}.`
      : `Package build terminated by signal ${result.signal}.`
  );
}
