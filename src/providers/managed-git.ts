import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { ChildOutputPolicy } from '../core/child-process.js';
import { boundedPathForDisplay, boundedTextForDisplay, replaceUnsafeDisplayCharacters } from '../core/safe-text.js';
import {
  PROFILE_PORTABILITY_PRODUCTION_LIMITS,
  managedGitAcquisitionLimitPolicy,
  type ManagedGitAcquisitionLimitPolicy
} from '../profile-portability/profile-portability-policy.js';
import { readPackageManifest, samePackageManifestSnapshot, type PackageManifestSnapshot } from '../packages/package-manifest.js';
import {
  addDefaultSkill, defaultSkillCatalogRoot, readDefaultSkillRegistration,
  readDefaultSkillRegistrationSnapshot, removeDefaultSkill
} from '../skills/default-skill-catalog.js';
import { assertSafeSkillId } from '../skills/skill-id.js';
import { parseSkillDeclaredName } from '../skills/skill-metadata.js';
import {
  addLibrary, addPackage, buildPackage, removeLibrary, removePackage, updateLibrary,
  type SkillCollectionLifecycleResult
} from '../skill-collections/skill-collection-lifecycle.js';
import {
  globalCollectionPath, readCollectionSnapshot, readLibrary, readLibrarySnapshot, readPackage, readPackageSnapshot,
  sameCollectionSnapshot, type SkillCollectionRecordSnapshot
} from '../skill-collections/skill-collection-store.js';
import { verifySkillSnapshot } from '../skill-collections/skill-snapshot.js';
import { ensureManagedDirectory, writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import {
  assertReadOnlyPathAnchor,
  closeReadOnlyPathAnchor,
  holdReadOnlyPathAnchor
} from '../state/read-only-path-anchor.js';
import {
  assertValidManagedGitBranch, assertValidManagedGitRevision, canonicalManagedGitRoot,
  decodeManagedGitRecord, decodePathFreeManagedGitIdentity, encodeManagedGitJournal, encodeManagedGitRecord, managedGitCheckoutRoot,
  managedGitJournalPath, managedGitRecordPath, managedGitRecoveryRoot, managedGitStagingRoot,
  optionalManagedGitRecord, optionalManagedGitRecordInExistingNamespace, readManagedGitJournal, readManagedGitRecord, type ManagedGitJournal, type ManagedGitJournalSnapshot,
  type ManagedGitRecord, type ManagedGitRecordSnapshot, type ManagedGitResourceKind,
  type PathFreeManagedGitIdentity
} from './managed-git-record.js';
import { runManagedGitProcess, type ManagedGitProcessResult } from './managed-git-process.js';
import {
  inspectManagedGitAcquisition,
  inspectManagedGitPublishedCheckout,
  sampleManagedGitAcquisitionInProgress
} from './managed-git-acquisition-inspection.js';
import {
  canonicalManagedGitSourceForIdentity,
  normalizeManagedGitOrigin,
  parseManagedGitSource,
  type ManagedGitSource
} from './managed-git-source.js';
export {
  isManagedGitSource,
  normalizeManagedGitOrigin,
  parseManagedGitSource,
  type ManagedGitSource
} from './managed-git-source.js';
export interface ManagedGitBuildAuthorization {
  remote: string;
  revision: string;
  root: string;
  build: readonly string[];
}
export interface ManagedGitOptions {
  bazframeHome: string;
  environment?: NodeJS.ProcessEnv;
  childOutputPolicy?: ChildOutputPolicy;
  yes?: boolean;
  acceptRewrite?: boolean;
  acquisitionLimits?: Partial<ManagedGitAcquisitionLimitPolicy>;
  reportPackageBuild?: (details: ManagedGitBuildAuthorization) => void | Promise<void>;
  confirmPackageBuild?: (details: ManagedGitBuildAuthorization) => boolean | Promise<boolean>;
  /** Internal deterministic fault-injection seams used only by lifecycle tests. */
  testHooks?: {
    afterRemoveResource?: () => void | Promise<void>;
    afterStateLockAcquired?: () => void | Promise<void>;
    afterCloneOriginValidated?: () => void | Promise<void>;
    beforeExactRefUpdate?: () => void | Promise<void>;
    afterPublishedCheckout?: () => void | Promise<void>;
    /** Deterministic process-tree uncertainty seam used only by acquisition tests. */
    injectUncertainAcquisitionFailure?: boolean;
  };
}
export interface ManagedGitExactRevisionReuseRequirement {
  mode: 'must-reuse';
  expectedHealth: ManagedGitExportHealthSnapshot;
}

export interface ManagedGitLifecycleResult {
  action: 'added' | 'current' | 'updated' | 'removed' | 'built';
  kind: ManagedGitResourceKind;
  id: string;
  root: string;
  remote: string;
  branch: string;
  revision: string;
  resourceAction?: string;
}
export interface ManagedGitExportHealthSnapshot {
  recordSnapshot: ManagedGitRecordSnapshot;
  root: { path: string; device: bigint; inode: bigint };
  resourceIdentity: string;
  /** Exact reusable collection evidence retained only by internal planning/execution handoffs. */
  collectionSnapshot?: SkillCollectionRecordSnapshot;
}
export interface ManagedGitExportHealthTestHooks {
  beforeFinalRecoveryCheck?: () => void | Promise<void>;
}
interface PreparedAcquisitionContainer {
  container: string;
  containerIdentity: DirectoryIdentity;
  root: string;
}
interface AcquiredRepository {
  container: string;
  containerIdentity: DirectoryIdentity;
  root: string;
  identity: DirectoryIdentity;
  source: ManagedGitSource;
  branch: string;
  revision: string;
  transport: 'git' | 'gh';
  revisionMode: ManagedGitRevisionSelection['mode'];
  acquisitionPolicy: Readonly<ManagedGitAcquisitionLimitPolicy>;
}
interface DirectoryIdentity { device: bigint; inode: bigint }
interface HeldDirectoryIdentity { handle: FileHandle; identity: DirectoryIdentity }
interface FileIdentity { device: bigint; inode: bigint; sha256: string }
interface TransactionState { resourceCommitted: boolean; journalState?: FileIdentity }
type ManagedGitRevisionSelection =
  | { mode: 'branchHead'; branch?: string }
  | { mode: 'exact'; branch: string; revision: string };
export interface ManagedGitCloneInvocation { transport: 'gh' | 'git'; args: readonly string[] }

const LOCAL_CONFIG_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'remote.origin.url',
  'remote.origin.fetch', 'extensions.objectformat', 'extensions.refstorage'
]);

export function managedGitCloneInvocation(source: ManagedGitSource, root: string, githubAuthenticated: boolean): ManagedGitCloneInvocation {
  return source.githubRepository !== undefined && githubAuthenticated
    ? { transport: 'gh', args: ['repo', 'clone', source.githubRepository, root, '--', '--no-checkout', '--no-local', '--no-hardlinks', '--template='] }
    : {
        transport: 'git',
        args: [
          '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never',
          'clone', '--no-checkout', '--no-local', '--no-hardlinks', '--template=', '--origin', 'origin', source.fetchUrl, root
        ]
      };
}

export async function addManagedGitSkill(options: ManagedGitOptions, entered: string): Promise<ManagedGitLifecycleResult> { return addManaged(options, 'skill', parseManagedGitSource(entered)); }
export async function addManagedGitLibrary(options: ManagedGitOptions, entered: string): Promise<ManagedGitLifecycleResult> { return addManaged(options, 'library', parseManagedGitSource(entered)); }
export async function addManagedGitPackage(options: ManagedGitOptions, entered: string): Promise<ManagedGitLifecycleResult> { return addManaged(options, 'package', parseManagedGitSource(entered)); }
export async function addManagedGitSkillAtRevision(
  options: ManagedGitOptions,
  id: string,
  enteredIdentity: PathFreeManagedGitIdentity,
  requirement?: ManagedGitExactRevisionReuseRequirement
): Promise<ManagedGitLifecycleResult> {
  return addManagedAtRevision(options, 'skill', id, enteredIdentity, requirement);
}
export async function addManagedGitLibraryAtRevision(
  options: ManagedGitOptions,
  id: string,
  enteredIdentity: PathFreeManagedGitIdentity,
  requirement?: ManagedGitExactRevisionReuseRequirement
): Promise<ManagedGitLifecycleResult> {
  return addManagedAtRevision(options, 'library', id, enteredIdentity, requirement);
}
export async function updateManagedGitSkill(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return updateManaged(options, 'skill', id); }
export async function updateManagedGitLibrary(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return updateManaged(options, 'library', id); }
export async function updateManagedGitPackage(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return updateManaged(options, 'package', id); }
export async function removeManagedGitSkill(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return removeManaged(options, 'skill', id); }
export async function removeManagedGitLibrary(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return removeManaged(options, 'library', id); }
export async function removeManagedGitPackage(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return removeManaged(options, 'package', id); }

export async function isManagedGitResource(options: { bazframeHome: string }, kind: ManagedGitResourceKind, id: string): Promise<boolean> {
  if (await optionalManagedGitRecord(options.bazframeHome, kind, id) !== undefined) return true;
  const journalPath = managedGitJournalPath(options.bazframeHome, kind, id);
  return await pathExists(journalPath) && (await readManagedGitJournal(options.bazframeHome, kind, id)).journal.operation === 'remove';
}
export async function verifyManagedGitResource(home: string, kind: ManagedGitResourceKind, id: string, environment: NodeJS.ProcessEnv = process.env): Promise<ManagedGitRecord> {
  const record = (await readManagedGitRecord(home, kind, id)).record;
  await verifyProvider(record, environment);
  await verifyResourceRegistration(record);
  return record;
}

export async function captureManagedGitExportHealth(
  home: string,
  kind: ManagedGitResourceKind,
  id: string,
  environment: NodeJS.ProcessEnv = process.env,
  testHooks: ManagedGitExportHealthTestHooks = {}
): Promise<ManagedGitExportHealthSnapshot> {
  assertSafeSkillId(id);
  const canonicalHome = await realpath(home);
  const initial = await readManagedGitRecord(canonicalHome, kind, id);
  await assertManagedGitResourceRecoveryAbsent(canonicalHome, kind, id);
  await verifyProvider(initial.record, environment);
  await verifyResourceRegistration(initial.record);
  const initialResource = await captureManagedResourceIdentity(initial.record);
  const rootIdentity = await directoryIdentity(initial.record.root);
  const current = await readManagedGitRecord(canonicalHome, kind, id);
  if (!sameRecordSnapshot(initial, current)) {
    throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git provenance changed while capturing export health for ${kind} ${id}.`);
  }
  await assertManagedGitResourceRecoveryAbsent(canonicalHome, kind, id);
  await verifyProvider(current.record, environment);
  await inspectManagedGitPublishedCheckout(
    current.record.root,
    managedGitAcquisitionLimitPolicy()
  );
  await verifyResourceRegistration(current.record);
  const resource = await captureManagedResourceIdentity(current.record);
  if (resource.identity !== initialResource.identity) {
    throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git resource registration changed while capturing export health for ${kind} ${id}.`);
  }
  await assertIdentity(current.record.root, rootIdentity, 'Bazframe-managed checkout changed while capturing export health');
  const snapshot: ManagedGitExportHealthSnapshot = {
    recordSnapshot: current,
    root: { path: current.record.root, ...rootIdentity },
    resourceIdentity: resource.identity,
    ...(resource.collectionSnapshot === undefined ? {} : { collectionSnapshot: resource.collectionSnapshot })
  };
  await testHooks.beforeFinalRecoveryCheck?.();
  await assertManagedGitResourceRecoveryAbsent(canonicalHome, kind, id);
  return snapshot;
}

export function sameManagedGitExportHealth(
  left: ManagedGitExportHealthSnapshot,
  right: ManagedGitExportHealthSnapshot
): boolean {
  const collectionPresenceMatches = (left.collectionSnapshot === undefined)
    === (right.collectionSnapshot === undefined);
  const collectionMatches = left.collectionSnapshot === undefined || right.collectionSnapshot === undefined
    ? collectionPresenceMatches
    : left.collectionSnapshot.path === right.collectionSnapshot.path
      && sameCollectionSnapshot(left.collectionSnapshot, right.collectionSnapshot);
  return left.recordSnapshot.path === right.recordSnapshot.path
    && sameRecordSnapshot(left.recordSnapshot, right.recordSnapshot)
    && left.root.path === right.root.path
    && left.root.device === right.root.device
    && left.root.inode === right.root.inode
    && left.resourceIdentity === right.resourceIdentity
    && collectionMatches;
}

function copyExactReuseRequirement(requirement: ManagedGitExactRevisionReuseRequirement): ManagedGitExportHealthSnapshot {
  if (requirement === null || typeof requirement !== 'object' || requirement.mode !== 'must-reuse'
    || requirement.expectedHealth === null || typeof requirement.expectedHealth !== 'object') {
    throw new BazframeError('MANAGED_GIT_REUSE_REQUIREMENT_INVALID', 'Exact managed-Git reuse requirement is invalid.');
  }
  const health = requirement.expectedHealth;
  return {
    recordSnapshot: {
      record: { ...health.recordSnapshot.record },
      path: health.recordSnapshot.path,
      device: health.recordSnapshot.device,
      inode: health.recordSnapshot.inode,
      contentSha256: health.recordSnapshot.contentSha256
    },
    root: { ...health.root },
    resourceIdentity: health.resourceIdentity,
    ...(health.collectionSnapshot === undefined ? {} : {
      collectionSnapshot: {
        record: { ...health.collectionSnapshot.record },
        path: health.collectionSnapshot.path,
        device: health.collectionSnapshot.device,
        inode: health.collectionSnapshot.inode,
        contentSha256: health.collectionSnapshot.contentSha256
      }
    })
  };
}

function assertExpectedExactReuseHealth(
  home: string,
  kind: 'skill' | 'library',
  id: string,
  identity: PathFreeManagedGitIdentity,
  health: ManagedGitExportHealthSnapshot
): void {
  const record = health.recordSnapshot.record;
  if (record.kind !== kind || record.id !== id || record.root !== managedGitCheckoutRoot(home, kind, id)
    || record.remote !== identity.remote || record.fetchUrl !== identity.fetchUrl
    || record.branch !== identity.branch || record.revision !== identity.revision
    || health.root.path !== record.root) {
    throw new BazframeError('MANAGED_GIT_REUSE_REQUIREMENT_INVALID', `Exact reuse evidence does not match ${kind} ${id}.`);
  }
}

export type ManagedGitImportResourceAction = 'create' | 'reuse' | 'blocked';

export interface ManagedGitImportResourceClassification {
  action: ManagedGitImportResourceAction;
  reason?: string;
  health?: ManagedGitExportHealthSnapshot;
}

export interface ManagedGitImportResourceTestHooks {
  afterInitialOccupancy?: () => void | Promise<void>;
}

export type ManagedGitImportOutcomeClassification =
  | { state: 'exact'; health: ManagedGitExportHealthSnapshot }
  | { state: 'absent' }
  | { state: 'recovery-required' }
  | { state: 'ambiguous'; reason: string };

/** Read-only exact-state classification for post-error import accounting. */
export async function classifyManagedGitImportOutcome(
  home: string,
  kind: 'skill' | 'library',
  id: string,
  enteredExpected: PathFreeManagedGitIdentity,
  environment: NodeJS.ProcessEnv = process.env,
  testHooks: ManagedGitImportResourceTestHooks = {}
): Promise<ManagedGitImportOutcomeClassification> {
  assertSafeSkillId(id);
  const stableEnvironment = { ...environment };
  let anchor: Awaited<ReturnType<typeof holdReadOnlyPathAnchor>> | undefined;
  try {
    const expected = decodePathFreeManagedGitIdentity(enteredExpected, id);
    anchor = await holdReadOnlyPathAnchor(home);
    const result = await classifyManagedGitImportOutcomeAtHome(
      anchor.path,
      kind,
      id,
      expected,
      stableEnvironment,
      testHooks
    );
    await assertReadOnlyPathAnchor(anchor);
    await closeReadOnlyPathAnchor(anchor);
    anchor = undefined;
    return result;
  } catch (error) {
    return { state: 'ambiguous', reason: boundedTextForDisplay(importErrorMessage(error)) };
  } finally {
    if (anchor !== undefined) await closeReadOnlyPathAnchor(anchor).catch(() => undefined);
  }
}

/** Read-only exact-state classification for profile-import planning. */
export async function classifyManagedGitImportResource(
  home: string,
  kind: 'skill' | 'library',
  id: string,
  expected: PathFreeManagedGitIdentity,
  environment: NodeJS.ProcessEnv = process.env,
  testHooks: ManagedGitImportResourceTestHooks = {}
): Promise<ManagedGitImportResourceClassification> {
  const outcome = await classifyManagedGitImportOutcome(home, kind, id, expected, environment, testHooks);
  if (outcome.state === 'exact') return { action: 'reuse', health: outcome.health };
  if (outcome.state === 'absent') return { action: 'create' };
  if (outcome.state === 'recovery-required') {
    return blockedImportResource(`Remote Git ${kind} ${id} has recovery state.`);
  }
  return blockedImportResource(outcome.reason);
}

async function classifyManagedGitImportOutcomeAtHome(
  canonicalHome: string,
  kind: 'skill' | 'library',
  id: string,
  expected: PathFreeManagedGitIdentity,
  environment: NodeJS.ProcessEnv,
  testHooks: ManagedGitImportResourceTestHooks
): Promise<ManagedGitImportOutcomeClassification> {
  const paths = importResourcePaths(canonicalHome, kind, id);
  const initial = await captureImportOccupancy(canonicalHome, paths);
  await testHooks.afterInitialOccupancy?.();
  const allAbsent = Object.values(paths).every((path) => initial.get(path) === 'absent');
  if (allAbsent) {
    const final = await captureImportOccupancy(canonicalHome, paths);
    return sameImportOccupancy(initial, final)
      ? { state: 'absent' }
      : { state: 'ambiguous', reason: `Remote Git ${kind} ${id} occupancy changed while checking absence.` };
  }
  if (initial.get(paths.journal) !== 'absent') {
    const final = await captureImportOccupancy(canonicalHome, paths);
    return sameImportOccupancy(initial, final)
      ? { state: 'recovery-required' }
      : { state: 'ambiguous', reason: `Remote Git ${kind} ${id} recovery occupancy changed while being classified.` };
  }
  if (initial.get(paths.record) === 'absent'
    || initial.get(paths.root) === 'absent'
    || initial.get(paths.resource) === 'absent') {
    return { state: 'ambiguous', reason: `Remote Git ${kind} ${id} has partial or unrecognized occupancy.` };
  }

  const health = await captureManagedGitExportHealth(canonicalHome, kind, id, environment);
  const record = health.recordSnapshot.record;
  if (record.root !== paths.root
    || record.remote !== expected.remote
    || record.fetchUrl !== expected.fetchUrl
    || record.branch !== expected.branch
    || record.revision !== expected.revision) {
    return { state: 'ambiguous', reason: `Remote Git ${kind} ${id} source identity does not match the artifact.` };
  }
  const final = await captureImportOccupancy(canonicalHome, paths);
  if (!sameImportOccupancy(initial, final)) {
    return { state: 'ambiguous', reason: `Remote Git ${kind} ${id} occupancy changed while being classified.` };
  }
  return { state: 'exact', health };
}

type ImportOccupancy = 'absent' | {
  device: bigint;
  inode: bigint;
  type: string;
  mtimeNs: bigint;
  ctimeNs: bigint;
};
interface HeldImportDirectory {
  path: string;
  handle: FileHandle;
  device: bigint;
  inode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function importResourcePaths(home: string, kind: 'skill' | 'library', id: string): {
  record: string;
  journal: string;
  root: string;
  resource: string;
} {
  return {
    record: managedGitRecordPath(home, kind, id),
    journal: managedGitJournalPath(home, kind, id),
    root: managedGitCheckoutRoot(home, kind, id),
    resource: kind === 'skill'
      ? join(defaultSkillCatalogRoot(home), id)
      : globalCollectionPath(home, kind, id)
  };
}

async function captureImportOccupancy(
  home: string,
  paths: ReturnType<typeof importResourcePaths>
): Promise<ReadonlyMap<string, ImportOccupancy>> {
  const result = new Map<string, ImportOccupancy>();
  const held = new Map<string, HeldImportDirectory>();
  let operationError: unknown;
  try {
    for (const leaf of Object.values(paths)) {
      await inspectPhysicalImportPath(home, leaf, result, held);
    }
    for (const directory of held.values()) await assertHeldImportDirectory(directory);
  } catch (error) {
    operationError = error;
  }
  for (const directory of held.values()) {
    try { await directory.handle.close(); }
    catch (error) {
      operationError = operationError === undefined
        ? error
        : new AggregateError([operationError, error], 'Remote Git import inspection and directory close failed');
    }
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

async function inspectPhysicalImportPath(
  home: string,
  leaf: string,
  result: Map<string, ImportOccupancy>,
  held: Map<string, HeldImportDirectory>
): Promise<void> {
  const pathFromHome = relative(home, leaf);
  if (pathFromHome === '' || pathFromHome === '..' || pathFromHome.startsWith(`..${sep}`)) {
    throw new BazframeError('MANAGED_GIT_DESTINATION_OCCUPIED', `Remote Git import path escapes Bazframe home: ${leaf}`);
  }
  const components = [home];
  let current = home;
  for (const segment of pathFromHome.split(sep)) {
    current = join(current, segment);
    components.push(current);
  }
  for (let index = 0; index < components.length; index += 1) {
    const path = components[index]!;
    const isLeaf = index === components.length - 1;
    let metadata;
    try {
      metadata = await lstat(path, { bigint: true });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      result.set(path, 'absent');
      result.set(leaf, 'absent');
      return;
    }
    const occupancy = importOccupancy(metadata);
    const previous = result.get(path);
    if (previous !== undefined && !sameImportOccupancyValue(previous, occupancy)) {
      throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git import namespace changed while inspecting ${path}.`);
    }
    result.set(path, occupancy);
    if (isLeaf) return;
    if (occupancy.type !== 'directory') {
      throw new BazframeError('MANAGED_GIT_DESTINATION_OCCUPIED', `Remote Git import namespace ancestor must be a physical directory: ${path}`);
    }
    if (!held.has(path)) held.set(path, await holdImportDirectory(path, occupancy));
  }
}

function importOccupancy(metadata: {
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}): Exclude<ImportOccupancy, 'absent'> {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    type: metadata.isSymbolicLink()
      ? 'link'
      : metadata.isDirectory()
        ? 'directory'
        : metadata.isFile()
          ? 'file'
          : 'special'
  };
}

async function holdImportDirectory(
  path: string,
  expected: Exclude<ImportOccupancy, 'absent'>
): Promise<HeldImportDirectory> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()
      || opened.dev !== expected.device
      || opened.ino !== expected.inode
      || opened.mtimeNs !== expected.mtimeNs
      || opened.ctimeNs !== expected.ctimeNs) {
      throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git import namespace changed while opening ${path}.`);
    }
    return {
      path,
      handle,
      device: expected.device,
      inode: expected.inode,
      mtimeNs: expected.mtimeNs,
      ctimeNs: expected.ctimeNs
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function assertHeldImportDirectory(directory: HeldImportDirectory): Promise<void> {
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || opened.dev !== directory.device || opened.ino !== directory.inode
    || current.dev !== directory.device || current.ino !== directory.inode
    || opened.mtimeNs !== directory.mtimeNs || opened.ctimeNs !== directory.ctimeNs
    || current.mtimeNs !== directory.mtimeNs || current.ctimeNs !== directory.ctimeNs) {
    throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git import namespace changed while inspecting ${directory.path}.`);
  }
}

function sameImportOccupancyValue(left: ImportOccupancy, right: ImportOccupancy): boolean {
  if (left === 'absent' || right === 'absent') return left === right;
  return left.device === right.device
    && left.inode === right.inode
    && left.type === right.type
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameImportOccupancy(
  left: ReadonlyMap<string, ImportOccupancy>,
  right: ReadonlyMap<string, ImportOccupancy>
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, leftValue] of left) {
    const rightValue = right.get(path);
    if (leftValue === 'absent' || rightValue === 'absent' || rightValue === undefined) {
      if (leftValue !== rightValue) return false;
      continue;
    }
    if (!sameImportOccupancyValue(leftValue, rightValue)) return false;
  }
  return true;
}

function blockedImportResource(reason: string): ManagedGitImportResourceClassification {
  return { action: 'blocked', reason: boundedTextForDisplay(reason) };
}

function importErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function captureManagedResourceIdentity(record: ManagedGitRecord): Promise<{
  identity: string;
  collectionSnapshot?: SkillCollectionRecordSnapshot;
}> {
  const home = resolveHome(record.root);
  if (record.kind === 'skill') {
    const snapshot = await readDefaultSkillRegistrationSnapshot(home, record.id);
    return {
      identity: [
        snapshot.id, snapshot.registrationPath, snapshot.target,
        snapshot.catalogDevice, snapshot.catalogInode,
        snapshot.registrationDevice, snapshot.registrationInode,
        snapshot.targetDevice, snapshot.targetInode
      ].join(':')
    };
  }
  const collectionSnapshot = await readCollectionSnapshot(home, { kind: record.kind, id: record.id });
  return {
    identity: `${collectionSnapshot.path}:${collectionSnapshot.device}:${collectionSnapshot.inode}:${collectionSnapshot.contentSha256}`,
    collectionSnapshot
  };
}

export async function buildManagedGitPackage(options: ManagedGitOptions, id: string): Promise<SkillCollectionLifecycleResult> {
  assertSafeSkillId(id);
  const home = await canonicalManagedHome(options.bazframeHome);
  await assertNoRecovery(home, 'package', id);
  const transaction: TransactionState = { resourceCommitted: false };
  let result: SkillCollectionLifecycleResult;
  try {
    result = await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: 'bazframe package build', target: managedGitCheckoutRoot(home, 'package', id) },
      async () => {
        const snapshot = await readManagedGitRecord(home, 'package', id);
        const record = snapshot.record;
        await verifyProvider(record, options.environment ?? process.env);
        await verifyResourceRegistration(record);
        const rootIdentity = await directoryIdentity(record.root);
        transaction.journalState = await createJournal(home, journalFor(record, 'build', 'building', record.revision, record.revision));
        try {
          const built = await buildPackage(
            { bazframeHome: home, environment: options.environment, childOutputPolicy: options.childOutputPolicy },
            id,
            {
              stateLockHeld: true,
              afterPackageSnapshot: () => cleanManagedCheckout(record, options.environment ?? process.env, rootIdentity)
            }
          );
          transaction.resourceCommitted = true;
          transaction.journalState = await updateJournal(home, journalFor(record, 'build', 'activated', record.revision, record.revision), transaction.journalState);
          return built;
        } catch (error) {
          if (transaction.resourceCommitted) throw recoveryError(error, home, 'package', id, 'build activation committed before journal finalization');
          try {
            await cleanManagedCheckout(record, options.environment ?? process.env, rootIdentity);
            if (transaction.journalState !== undefined) await removeOwnedFile(managedGitJournalPath(home, 'package', id), transaction.journalState);
            transaction.journalState = undefined;
          } catch (cleanupError) {
            transaction.journalState = await updateJournal(home, journalFor(record, 'build', 'cleanup-required', record.revision, record.revision), transaction.journalState).catch(() => transaction.journalState);
            throw new AggregateError([error, cleanupError], `Remote Git package build failed and checkout cleanup could not be proven; inspect ${managedGitJournalPath(home, 'package', id)}.`, { cause: cleanupError });
          }
          throw error;
        }
      },
      { managedRoot: home }
    );
  } catch (error) {
    if (transaction.resourceCommitted && transaction.journalState !== undefined) throw recoveryError(error, home, 'package', id, 'build committed before lock release completed');
    throw error;
  }
  if (transaction.journalState !== undefined) await removeOwnedFile(managedGitJournalPath(home, 'package', id), transaction.journalState);
  return result;
}

export async function inspectManagedGitRecordHealth(record: ManagedGitRecord, environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  try {
    await verifyProvider(record, environment);
    await verifyResourceRegistration(record);
    const journal = managedGitJournalPath(resolveHome(record.root), record.kind, record.id);
    if (await pathExists(journal)) return `recovery state requires inspection: ${journal}`;
    return undefined;
  } catch (error) { return safeDiagnostic(error instanceof Error ? error.message : String(error)); }
}

async function addManagedAtRevision(
  options: ManagedGitOptions,
  kind: 'skill' | 'library',
  id: string,
  enteredIdentity: PathFreeManagedGitIdentity,
  requirement?: ManagedGitExactRevisionReuseRequirement
): Promise<ManagedGitLifecycleResult> {
  const identity = decodePathFreeManagedGitIdentity(enteredIdentity, id);
  const source = canonicalManagedGitSourceForIdentity(id, identity);
  const expectedHealth = requirement === undefined ? undefined : copyExactReuseRequirement(requirement);
  if (expectedHealth !== undefined) {
    const home = await canonicalManagedHome(options.bazframeHome);
    return withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${kind} add exact reuse`, target: managedGitCheckoutRoot(home, kind, id) },
      async () => {
        assertExpectedExactReuseHealth(home, kind, id, identity, expectedHealth);
        const current = await captureManagedGitExportHealth(home, kind, id, options.environment ?? process.env);
        if (!sameManagedGitExportHealth(expectedHealth, current)) {
          throw new BazframeError('MANAGED_GIT_CHANGED', `Exact planned reuse changed for ${kind} ${id}; acquisition was not authorized.`);
        }
        return lifecycleResult('current', current.recordSnapshot.record);
      },
      { managedRoot: home }
    );
  }
  return addManaged(options, kind, source, { mode: 'exact', branch: identity.branch, revision: identity.revision });
}

async function addManaged(
  options: ManagedGitOptions,
  kind: ManagedGitResourceKind,
  source: ManagedGitSource,
  selection: ManagedGitRevisionSelection = { mode: 'branchHead' }
): Promise<ManagedGitLifecycleResult> {
  const acquisitionPolicy = managedGitAcquisitionLimitPolicy(options.acquisitionLimits);
  const home = await canonicalManagedHome(options.bazframeHome);
  const expectedRoot = managedGitCheckoutRoot(home, kind, source.id);
  const existing = await optionalManagedGitRecord(home, kind, source.id);
  if (existing !== undefined) {
    return await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${kind} add`, target: expectedRoot },
      async () => {
        const current = await readManagedGitRecord(home, kind, source.id);
        if (!sameRecordSnapshot(existing, current)) throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git provenance changed while verifying current ${kind} ${source.id}.`);
        if (current.record.remote !== source.remote || current.record.fetchUrl !== source.fetchUrl || current.record.root !== expectedRoot
          || (selection.mode === 'exact' && (current.record.branch !== selection.branch || current.record.revision !== selection.revision))) {
          throw new BazframeError('MANAGED_GIT_IDENTITY_MISMATCH', `Remote Git source ${kind} ${source.id} is occupied by different source identity.`);
        }
        await assertNoRecovery(home, kind, source.id);
        await verifyProvider(current.record, options.environment ?? process.env);
        await verifyResourceRegistration(current.record);
        return lifecycleResult('current', current.record);
      },
      { managedRoot: home }
    );
  }
  await assertNoRecovery(home, kind, source.id);
  await assertResourceAvailableForAdd(home, kind, source.id, expectedRoot);
  const transaction: TransactionState = { resourceCommitted: false };
  let preparedContainer: PreparedAcquisitionContainer | undefined;
  if (selection.mode === 'exact') {
    preparedContainer = await prepareAcquisitionContainer(home, source.id);
    const provisional = makeRecord(kind, source, expectedRoot, selection.branch, selection.revision, 'git');
    try {
      await withStateLock(
        join(home, 'locks', 'state.lock'),
        { command: `bazframe ${kind} add exact acquisition`, target: expectedRoot },
        async () => {
          await assertNoRecovery(home, kind, source.id);
          if (await optionalManagedGitRecord(home, kind, source.id) !== undefined) {
            throw new BazframeError('MANAGED_GIT_DESTINATION_OCCUPIED', `Remote Git provenance became occupied: ${source.id}`);
          }
          await assertResourceAvailableForAdd(home, kind, source.id, expectedRoot);
          transaction.journalState = await createJournal(
            home,
            journalFor(provisional, 'add-exact', 'acquiring', null, selection.revision, preparedContainer!.container)
          );
        },
        { managedRoot: home }
      );
    } catch (error) {
      if (transaction.journalState === undefined) {
        await removeOwnedContainer(preparedContainer.container, preparedContainer.containerIdentity)
          .catch((cleanupError) => { throw new AggregateError([error, cleanupError], 'Exact acquisition preparation and cleanup failed.'); });
        throw error;
      }
      throw recoveryError(error, home, kind, source.id, 'exact acquisition journal committed before lock release completed');
    }
  }
  let acquired: AcquiredRepository;
  try {
    acquired = await acquireRepository(
      home,
      source,
      options.environment ?? process.env,
      selection,
      acquisitionPolicy,
      options.testHooks,
      preparedContainer
    );
  } catch (error) {
    if (selection.mode === 'exact' && transaction.journalState !== undefined) {
      const provisional = makeRecord(kind, source, expectedRoot, selection.branch, selection.revision, 'git');
      if (requiresAcquisitionRecovery(error)) {
        transaction.journalState = await updateJournal(
          home,
          journalFor(provisional, 'add-exact', 'acquisition-quarantined', null, selection.revision, preparedContainer!.container),
          transaction.journalState
        ).catch(() => transaction.journalState);
        const detail = isUncertainManagedGitProcessError(error)
          ? 'acquisition termination was uncertain'
          : 'acquisition cleanup could not be proven';
        throw recoveryError(error, home, kind, source.id, `${detail}; retained quarantine ${boundedPathForDisplay(preparedContainer!.container)}`);
      }
      try {
        await removeOwnedFile(managedGitJournalPath(home, kind, source.id), transaction.journalState);
        transaction.journalState = undefined;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Exact acquisition failed and recovery journal cleanup could not be proven at ${managedGitJournalPath(home, kind, source.id)}.`, { cause: cleanupError });
      }
    }
    throw error;
  }
  let authorizedManifest: PackageManifestSnapshot | undefined;
  try {
    await validateCandidate(kind, acquired.root, source.id);
    if (kind === 'package') authorizedManifest = await authorizeManagedGitPackageBuild(options, acquired.root, source.remote, acquired.revision, expectedRoot);
  } catch (error) {
    await removeOwnedContainer(acquired.container, acquired.containerIdentity).catch((cleanupError) => { throw new AggregateError([error, cleanupError], `Remote Git source validation failed and staging cleanup could not be proven at ${acquired.container}.`, { cause: cleanupError }); });
    if (transaction.journalState !== undefined) {
      try {
        await removeOwnedFile(managedGitJournalPath(home, kind, source.id), transaction.journalState);
        transaction.journalState = undefined;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Remote Git source validation failed and recovery journal cleanup could not be proven for ${kind} ${source.id}.`, { cause: cleanupError });
      }
    }
    throw error;
  }
  let result: ManagedGitLifecycleResult;
  try {
    result = await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${kind} add`, target: expectedRoot },
      () => commitAdd(options, home, kind, source, acquired, authorizedManifest, transaction),
      { managedRoot: home }
    );
  } catch (error) {
    return await throwAfterAcquiredTransactionFailure(
      error, transaction, acquired, home, kind, source.id,
      'resource activation committed before lock release completed',
      'Remote Git source add failed before its transaction started and staging cleanup could not be proven'
    );
  }
  if (transaction.journalState !== undefined) await removeOwnedFile(managedGitJournalPath(home, kind, source.id), transaction.journalState);
  return result;
}

async function commitAdd(
  options: ManagedGitOptions,
  home: string,
  kind: ManagedGitResourceKind,
  source: ManagedGitSource,
  acquired: AcquiredRepository,
  authorizedManifest: PackageManifestSnapshot | undefined,
  transaction: TransactionState
): Promise<ManagedGitLifecycleResult> {
  const expectedRoot = managedGitCheckoutRoot(home, kind, source.id);
  if (transaction.journalState === undefined) await assertNoRecovery(home, kind, source.id);
  else {
    const currentJournal = await readManagedGitJournal(home, kind, source.id);
    if (currentJournal.device !== transaction.journalState.device
      || currentJournal.inode !== transaction.journalState.inode
      || currentJournal.contentSha256 !== transaction.journalState.sha256
      || currentJournal.journal.operation !== 'add-exact'
      || currentJournal.journal.phase !== 'acquiring'
      || currentJournal.journal.staging !== acquired.container) {
      throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Exact acquisition recovery state changed before activation: ${currentJournal.path}`);
    }
  }
  if (await optionalManagedGitRecord(home, kind, source.id) !== undefined) throw new BazframeError('MANAGED_GIT_DESTINATION_OCCUPIED', `Remote Git provenance became occupied: ${source.id}`);
  await assertResourceAvailableForAdd(home, kind, source.id, expectedRoot);
  const record = makeRecord(kind, source, expectedRoot, acquired.branch, acquired.revision, acquired.transport);
  let published = false;
  let recordSnapshot: ManagedGitRecordSnapshot | undefined;
  const addOperation: ManagedGitJournal['operation'] = acquired.revisionMode === 'exact' ? 'add-exact' : 'add';
  transaction.journalState = transaction.journalState === undefined
    ? await createJournal(home, journalFor(record, addOperation, 'staged', null, record.revision, acquired.container))
    : await updateJournal(
        home,
        journalFor(record, addOperation, 'staged', null, record.revision, acquired.container),
        transaction.journalState
      );
  try {
    await ensureManagedDirectory(home, dirname(expectedRoot));
    await assertIdentity(acquired.root, acquired.identity, 'acquired repository changed before publication');
    await rename(acquired.root, expectedRoot);
    published = true;
    transaction.journalState = await updateJournal(home, journalFor(record, addOperation, 'provider-published', null, record.revision, acquired.container), transaction.journalState);
    await options.testHooks?.afterPublishedCheckout?.();
    await inspectManagedGitPublishedCheckout(expectedRoot, acquired.acquisitionPolicy);
    await verifyProvider(record, options.environment ?? process.env);
    await writeFileAtomic(managedGitRecordPath(home, kind, source.id), encodeManagedGitRecord(record), { managedRoot: home, mode: 0o600, commitOnRename: true });
    recordSnapshot = await readManagedGitRecord(home, kind, source.id);
    transaction.journalState = await updateJournal(home, journalFor(record, addOperation, 'provenance-published', null, record.revision, acquired.container), transaction.journalState);
    let collection: SkillCollectionLifecycleResult | undefined;
    if (kind === 'skill') await addDefaultSkill(home, expectedRoot, { stateLockHeld: true });
    else if (kind === 'library') collection = await addLibrary({ bazframeHome: home, environment: options.environment }, expectedRoot, { stateLockHeld: true });
    else collection = await addPackage(
      { bazframeHome: home, environment: options.environment, childOutputPolicy: options.childOutputPolicy }, expectedRoot,
      {
        stateLockHeld: true,
        expectedPackageManifest: authorizedManifest,
        afterPackageSnapshot: () => cleanManagedCheckout(record, options.environment ?? process.env, acquired.identity)
      }
    );
    transaction.resourceCommitted = true;
    await verifyProvider(record, options.environment ?? process.env);
    await verifyResourceRegistration(record);
    await removeOwnedContainer(acquired.container, acquired.containerIdentity);
    transaction.journalState = await updateJournal(home, journalFor(record, addOperation, 'activated', null, record.revision, null), transaction.journalState);
    return { ...lifecycleResult('added', record), resourceAction: collection?.action ?? 'added' };
  } catch (error) {
    if (transaction.resourceCommitted) throw recoveryError(error, home, kind, source.id, 'activation committed before cleanup completed');
    const recovery: unknown[] = [];
    if (recordSnapshot !== undefined) await removeOwnedRecord(home, recordSnapshot).catch((cause) => recovery.push(cause));
    if (published) await removeOwnedTree(expectedRoot, acquired.identity).catch((cause) => recovery.push(cause));
    await removeOwnedContainer(acquired.container, acquired.containerIdentity).catch((cause) => recovery.push(cause));
    if (recovery.length === 0 && transaction.journalState !== undefined) {
      await removeOwnedFile(managedGitJournalPath(home, kind, source.id), transaction.journalState).catch((cause) => recovery.push(cause));
      transaction.journalState = undefined;
    }
    if (recovery.length > 0) throw new ManagedGitRecoveryError([error, ...recovery], `Remote Git source add stopped with recovery state for ${kind} ${source.id}; inspect ${managedGitJournalPath(home, kind, source.id)}.`, error);
    throw error;
  }
}

async function updateManaged(options: ManagedGitOptions, kind: ManagedGitResourceKind, id: string): Promise<ManagedGitLifecycleResult> {
  assertSafeSkillId(id);
  const home = await canonicalManagedHome(options.bazframeHome);
  await assertNoRecovery(home, kind, id);
  const initial = await optionalManagedGitRecord(home, kind, id);
  if (initial === undefined) throw new BazframeError('MANAGED_GIT_NOT_FOUND', `${title(kind)} ${id} was not acquired from a remote Git source.`);
  await verifyProvider(initial.record, options.environment ?? process.env);
  await verifyResourceRegistration(initial.record);
  const source: ManagedGitSource = {
    entered: initial.record.fetchUrl, remote: initial.record.remote, fetchUrl: initial.record.fetchUrl, id,
    ...(initial.record.transport === 'gh' ? { githubRepository: initial.record.remote.slice('github.com/'.length) } : {})
  };
  const acquisitionPolicy = managedGitAcquisitionLimitPolicy(options.acquisitionLimits);
  const acquired = await acquireRepository(
    home,
    source,
    options.environment ?? process.env,
    { mode: 'branchHead', branch: initial.record.branch },
    acquisitionPolicy,
    options.testHooks
  );
  let authorizedManifest: PackageManifestSnapshot | undefined;
  try {
    if (acquired.branch !== initial.record.branch || acquired.source.remote !== initial.record.remote) throw new BazframeError('MANAGED_GIT_IDENTITY_MISMATCH', `Remote Git source update changed remote or branch identity for ${kind} ${id}.`);
    if (acquired.revision === initial.record.revision) return await verifyCurrentUpdate(options, home, initial, acquired);
    if (options.acceptRewrite !== true && !await isAncestor(acquired.root, initial.record.revision, acquired.revision, options.environment ?? process.env)) throw new BazframeError('MANAGED_GIT_NON_FAST_FORWARD', `Recorded branch ${initial.record.branch} no longer advances from ${initial.record.revision}. Retry with --accept-rewrite after reviewing the remote history.`);
    await validateCandidate(kind, acquired.root, id);
    if (kind === 'package') authorizedManifest = await authorizeManagedGitPackageBuild(options, acquired.root, initial.record.remote, acquired.revision, initial.record.root);
  } catch (error) {
    await removeOwnedContainer(acquired.container, acquired.containerIdentity).catch((cleanupError) => { throw new AggregateError([error, cleanupError], `Remote Git source update failed and staging cleanup could not be proven at ${acquired.container}.`, { cause: cleanupError }); });
    throw error;
  }
  const transaction: TransactionState = { resourceCommitted: false };
  let result: ManagedGitLifecycleResult;
  try {
    result = await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${kind} update`, target: initial.record.root },
      async () => { await options.testHooks?.afterStateLockAcquired?.(); return commitUpdate(options, initial, acquired, authorizedManifest, transaction); },
      { managedRoot: home }
    );
  } catch (error) {
    return await throwAfterAcquiredTransactionFailure(
      error, transaction, acquired, home, kind, id,
      'updated resource committed before lock release completed',
      'Remote Git source update failed before its transaction started and staging cleanup could not be proven'
    );
  }
  if (transaction.journalState !== undefined) await removeOwnedFile(managedGitJournalPath(home, kind, id), transaction.journalState);
  return result;
}

async function verifyCurrentUpdate(
  options: ManagedGitOptions,
  home: string,
  initial: ManagedGitRecordSnapshot,
  acquired: AcquiredRepository
): Promise<ManagedGitLifecycleResult> {
  return await withStateLock(
    join(home, 'locks', 'state.lock'),
    { command: `bazframe ${initial.record.kind} update`, target: initial.record.root },
    async () => {
      await options.testHooks?.afterStateLockAcquired?.();
      const current = await readManagedGitRecord(home, initial.record.kind, initial.record.id);
      if (!sameRecordSnapshot(initial, current)) throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git provenance changed while verifying current ${initial.record.kind} ${initial.record.id}.`);
      await assertNoRecovery(home, initial.record.kind, initial.record.id);
      await verifyProvider(current.record, options.environment ?? process.env);
      await verifyResourceRegistration(current.record);
      await removeOwnedContainer(acquired.container, acquired.containerIdentity);
      return lifecycleResult('current', current.record);
    },
    { managedRoot: home }
  );
}

async function commitUpdate(
  options: ManagedGitOptions,
  initialSnapshot: ManagedGitRecordSnapshot,
  acquired: AcquiredRepository,
  authorizedManifest: PackageManifestSnapshot | undefined,
  transaction: TransactionState
): Promise<ManagedGitLifecycleResult> {
  const initial = initialSnapshot.record;
  const home = resolve(options.bazframeHome);
  const environment = options.environment ?? process.env;
  const current = await readManagedGitRecord(home, initial.kind, initial.id);
  if (!sameRecordSnapshot(initialSnapshot, current)) throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git provenance changed during update for ${initial.kind} ${initial.id}.`);
  await verifyProvider(initial, environment);
  await verifyResourceRegistration(initial);
  await verifyProvider({ ...initial, root: acquired.root, revision: acquired.revision }, environment);
  const backup = join(managedGitRecoveryRoot(home), `${initial.kind}-${initial.id}-${randomUUID()}`);
  await ensureManagedDirectory(home, dirname(backup));
  const next = makeRecord(initial.kind, acquired.source, initial.root, acquired.branch, acquired.revision, acquired.transport);
  const previous = await holdDirectoryIdentity(initial.root);
  const previousIdentity = previous.identity;
  let oldMoved = false;
  let newPublished = false;
  let provenanceWritten = false;
  let updatedRecordSnapshot: ManagedGitRecordSnapshot | undefined;
  try {
    transaction.journalState = await createJournal(home, journalFor(next, 'update', 'staged', initial.revision, next.revision, acquired.container, backup));
    await rename(initial.root, backup); oldMoved = true;
    await assertIdentity(acquired.root, acquired.identity, 'candidate changed before update publication');
    await rename(acquired.root, initial.root); newPublished = true;
    transaction.journalState = await updateJournal(home, journalFor(next, 'update', 'provider-published', initial.revision, next.revision, acquired.container, backup), transaction.journalState);
    await options.testHooks?.afterPublishedCheckout?.();
    await inspectManagedGitPublishedCheckout(initial.root, acquired.acquisitionPolicy);
    await verifyProvider(next, environment);
    await writeFileAtomic(managedGitRecordPath(home, initial.kind, initial.id), encodeManagedGitRecord(next), { managedRoot: home, mode: 0o600, commitOnRename: true });
    provenanceWritten = true;
    updatedRecordSnapshot = await readManagedGitRecord(home, initial.kind, initial.id);
    transaction.journalState = await updateJournal(home, journalFor(next, 'update', 'provenance-published', initial.revision, next.revision, acquired.container, backup), transaction.journalState);
    let resourceAction = 'updated';
    if (initial.kind === 'skill') {
      const registration = await readDefaultSkillRegistration(home, initial.id);
      if (registration.target !== initial.root) throw new BazframeError('MANAGED_GIT_REGISTRATION_MISMATCH', `Added Skill registration changed during update: ${initial.id}`);
    } else if (initial.kind === 'library') resourceAction = (await updateLibrary({ bazframeHome: home, environment }, initial.id, { stateLockHeld: true })).action;
    else resourceAction = (await buildPackage(
      { bazframeHome: home, environment, childOutputPolicy: options.childOutputPolicy }, initial.id,
      { stateLockHeld: true, expectedPackageManifest: authorizedManifest, afterPackageSnapshot: () => cleanManagedCheckout(next, environment, acquired.identity) }
    )).action;
    transaction.resourceCommitted = true;
    await removeOwnedTree(backup, previousIdentity);
    await removeOwnedContainer(acquired.container, acquired.containerIdentity);
    transaction.journalState = await updateJournal(home, journalFor(next, 'update', 'activated', initial.revision, next.revision, null, null), transaction.journalState);
    return { ...lifecycleResult('updated', next), resourceAction };
  } catch (error) {
    if (transaction.resourceCommitted) throw recoveryError(error, home, initial.kind, initial.id, 'updated resource activated before cleanup completed');
    const recoveryErrors: unknown[] = [];
    if (provenanceWritten) {
      if (updatedRecordSnapshot === undefined) recoveryErrors.push(new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Updated provenance ownership could not be proven before rollback: ${managedGitRecordPath(home, initial.kind, initial.id)}`));
      else await restoreOwnedRecord(home, updatedRecordSnapshot, initial).catch((cause) => recoveryErrors.push(cause));
    }
    if (newPublished) await removeOwnedTree(initial.root, acquired.identity).catch((cause) => recoveryErrors.push(cause));
    if (oldMoved) await restoreOwnedDirectory(backup, previousIdentity, initial.root).catch((cause) => recoveryErrors.push(cause));
    await removeOwnedContainer(acquired.container, acquired.containerIdentity).catch((cause) => recoveryErrors.push(cause));
    if (recoveryErrors.length === 0 && transaction.journalState !== undefined) {
      await removeOwnedFile(managedGitJournalPath(home, initial.kind, initial.id), transaction.journalState).catch((cause) => recoveryErrors.push(cause));
      transaction.journalState = undefined;
    }
    if (recoveryErrors.length > 0) throw new ManagedGitRecoveryError([error, ...recoveryErrors], `Remote Git source update could not prove complete recovery for ${initial.kind} ${initial.id}; inspect ${managedGitJournalPath(home, initial.kind, initial.id)}.`, error);
    throw error;
  } finally {
    await previous.handle.close().catch(() => undefined);
  }
}

async function removeManaged(options: ManagedGitOptions, kind: ManagedGitResourceKind, id: string): Promise<ManagedGitLifecycleResult> {
  assertSafeSkillId(id);
  const home = await canonicalManagedHome(options.bazframeHome);
  const journalPath = managedGitJournalPath(home, kind, id);
  if (await pathExists(journalPath)) {
    const recovery = await readManagedGitJournal(home, kind, id);
    if (recovery.journal.operation !== 'remove') await assertNoRecovery(home, kind, id);
    return resumeManagedRemoval(options, home, recovery);
  }
  const initial = await optionalManagedGitRecord(home, kind, id);
  if (initial === undefined) throw new BazframeError('MANAGED_GIT_NOT_FOUND', `${title(kind)} ${id} was not acquired from a remote Git source.`);
  await verifyProvider(initial.record, options.environment ?? process.env);
  await verifyResourceRegistration(initial.record);
  const transaction: TransactionState = { resourceCommitted: false };
  let result: ManagedGitLifecycleResult;
  try {
    result = await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${kind} remove`, target: initial.record.root },
      async () => {
        const current = await readManagedGitRecord(home, kind, id);
        if (!sameRecordSnapshot(initial, current)) throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git provenance changed during removal for ${kind} ${id}.`);
        await verifyProvider(current.record, options.environment ?? process.env);
        await verifyResourceRegistration(current.record);
        const rootIdentity = await directoryIdentity(current.record.root);
        const resourceStateSha256 = await managedResourceStateSha256(home, current.record);
        transaction.journalState = await createJournal(home, journalFor(current.record, 'remove', 'removing-resource', current.record.revision, current.record.revision, null, null, resourceStateSha256));
        let resource: { action: string };
        if (kind === 'skill') resource = await removeDefaultSkill(home, id, { stateLockHeld: true });
        else if (kind === 'library') resource = await removeLibrary({ bazframeHome: home, environment: options.environment }, id, { stateLockHeld: true });
        else resource = await removePackage({ bazframeHome: home, environment: options.environment }, id, { stateLockHeld: true });
        transaction.resourceCommitted = true;
        await options.testHooks?.afterRemoveResource?.();
        transaction.journalState = await updateJournal(home, journalFor(current.record, 'remove', 'resource-removed', current.record.revision, current.record.revision, null, null, resourceStateSha256), transaction.journalState);
        await removeOwnedTree(current.record.root, rootIdentity);
        await removeOwnedRecord(home, current);
        transaction.journalState = await updateJournal(home, journalFor(current.record, 'remove', 'removed', current.record.revision, current.record.revision, null, null, resourceStateSha256), transaction.journalState);
        return { ...lifecycleResult('removed', current.record), resourceAction: resource.action };
      },
      { managedRoot: home }
    );
  } catch (error) {
    if (transaction.resourceCommitted && transaction.journalState !== undefined) throw recoveryError(error, home, kind, id, 'resource record was removed before Bazframe-managed checkout cleanup completed');
    if (!transaction.resourceCommitted && transaction.journalState !== undefined) {
      try {
        await removeOwnedFile(managedGitJournalPath(home, kind, id), transaction.journalState);
        transaction.journalState = undefined;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Remote Git source removal failed and journal cleanup could not be proven; inspect ${managedGitJournalPath(home, kind, id)}.`, { cause: cleanupError });
      }
    }
    throw error;
  }
  if (transaction.journalState !== undefined) await removeOwnedFile(managedGitJournalPath(home, kind, id), transaction.journalState);
  return result;
}

async function resumeManagedRemoval(options: ManagedGitOptions, home: string, initialJournal: ManagedGitJournalSnapshot): Promise<ManagedGitLifecycleResult> {
  const record = recordFromRemoveJournal(initialJournal.journal);
  let result: ManagedGitLifecycleResult;
  try {
    result = await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${record.kind} remove`, target: record.root },
      async () => {
        const currentJournal = await readManagedGitJournal(home, record.kind, record.id);
        if (!sameJournalSnapshot(initialJournal, currentJournal)) throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git recovery record changed during removal for ${record.kind} ${record.id}.`);
        const resourcePath = record.kind === 'skill' ? join(defaultSkillCatalogRoot(home), record.id) : globalCollectionPath(home, record.kind, record.id);
        let resourceAction = 'absent';
        if (await pathExists(resourcePath)) {
          if (!await pathExists(record.root)) throw new BazframeError('MANAGED_GIT_RECOVERY_REQUIRED', `Remote Git ${record.kind} registration remains but its checkout is absent: ${record.root}`);
          await verifyProvider(record, options.environment ?? process.env);
          await verifyResourceRegistration(record);
          const currentResourceState = await managedResourceStateSha256(home, record);
          if (currentResourceState !== initialJournal.journal.resourceStateSha256) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Remote Git ${record.kind} registration changed before removal recovery: ${resourcePath}`);
          const removed = record.kind === 'skill'
            ? await removeDefaultSkill(home, record.id, { stateLockHeld: true })
            : record.kind === 'library'
              ? await removeLibrary({ bazframeHome: home, environment: options.environment }, record.id, { stateLockHeld: true })
              : await removePackage({ bazframeHome: home, environment: options.environment }, record.id, { stateLockHeld: true });
          resourceAction = removed.action;
        }
        if (await pathExists(record.root)) {
          await verifyProvider(record, options.environment ?? process.env);
          const rootIdentity = await directoryIdentity(record.root);
          await removeOwnedTree(record.root, rootIdentity);
        }
        const provenance = await optionalManagedGitRecordInExistingNamespace(home, record.kind, record.id);
        if (provenance !== undefined) {
          if (!sameManagedGitRecord(provenance.record, record)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Remote Git provenance changed before removal recovery: ${provenance.path}`);
          await removeOwnedRecord(home, provenance);
        }
        return { ...lifecycleResult('removed', record), resourceAction };
      },
      { managedRoot: home }
    );
  } catch (error) {
    throw recoveryError(error, home, record.kind, record.id, 'removal recovery remains incomplete');
  }
  await removeOwnedFile(initialJournal.path, journalFileIdentity(initialJournal));
  return result;
}

async function managedResourceStateSha256(home: string, record: ManagedGitRecord): Promise<string> {
  if (record.kind === 'skill') {
    const registration = await readDefaultSkillRegistration(home, record.id);
    return createHash('sha256').update(JSON.stringify({ id: registration.id, registrationPath: registration.registrationPath, target: registration.target })).digest('hex');
  }
  return record.kind === 'library'
    ? (await readLibrarySnapshot(home, record.id)).contentSha256
    : (await readPackageSnapshot(home, record.id)).contentSha256;
}

function recordFromRemoveJournal(journal: ManagedGitJournal): ManagedGitRecord {
  if (journal.operation !== 'remove' || journal.resourceStateSha256 === null) throw new BazframeError('MANAGED_GIT_JOURNAL_INVALID', 'Remote Git removal recovery record is incomplete.');
  return decodeManagedGitRecord({ schemaVersion: 1, kind: journal.kind, id: journal.id, root: journal.root, remote: journal.remote, fetchUrl: journal.fetchUrl, transport: journal.transport, branch: journal.branch, revision: journal.nextRevision });
}
function sameManagedGitRecord(left: ManagedGitRecord, right: ManagedGitRecord): boolean { return encodeManagedGitRecord(left) === encodeManagedGitRecord(right); }
function sameJournalSnapshot(left: ManagedGitJournalSnapshot, right: ManagedGitJournalSnapshot): boolean { return left.device === right.device && left.inode === right.inode && left.contentSha256 === right.contentSha256; }
function journalFileIdentity(snapshot: ManagedGitJournalSnapshot): FileIdentity { return { device: snapshot.device, inode: snapshot.inode, sha256: snapshot.contentSha256 }; }

async function prepareAcquisitionContainer(home: string, id: string): Promise<PreparedAcquisitionContainer> {
  await ensureManagedDirectory(home, managedGitStagingRoot(home));
  const container = await mkdtemp(join(managedGitStagingRoot(home), 'acquire-'));
  const containerIdentity = await directoryIdentity(container);
  return { container, containerIdentity, root: join(container, id) };
}

async function acquireRepository(
  home: string,
  source: ManagedGitSource,
  environment: NodeJS.ProcessEnv,
  selection: ManagedGitRevisionSelection,
  acquisitionPolicy: Readonly<ManagedGitAcquisitionLimitPolicy>,
  testHooks: ManagedGitOptions['testHooks'] = {},
  prepared?: PreparedAcquisitionContainer
): Promise<AcquiredRepository> {
  const acquisition = prepared ?? await prepareAcquisitionContainer(home, source.id);
  const { container, containerIdentity, root } = acquisition;
  if (root !== join(container, source.id)) throw new BazframeError('MANAGED_GIT_ACQUISITION_INVALID', 'Prepared acquisition root does not match the requested source ID.');
  const runAcquisition = (executable: string, args: readonly string[], cwd: string, enteredEnvironment: NodeJS.ProcessEnv) => (
    run(executable, args, cwd, enteredEnvironment, () => sampleManagedGitAcquisitionInProgress(
      container,
      root,
      acquisitionPolicy,
      containerIdentity
    ))
  );
  try {
    const git = environment.BAZFRAME_GIT_COMMAND || 'git';
    const gh = environment.BAZFRAME_GH_COMMAND || 'gh';
    const authEnvironment = gitEnvironment(environment, false);
    const authStatus = source.githubRepository === undefined
      ? undefined
      : await runAcquisition(gh, ['auth', 'status', '--hostname', 'github.com'], home, authEnvironment);
    if (authStatus?.failure !== undefined) throw processFailure('inspect GitHub authentication', gh, authStatus);
    const githubAuthenticated = authStatus?.status === 0;
    let invocation = managedGitCloneInvocation(source, root, githubAuthenticated);
    let clone = await runAcquisition(invocation.transport === 'gh' ? gh : git, invocation.args, home, authEnvironment);
    if (clone.failure !== undefined) throw processFailure('clone', source.remote, clone);
    if (clone.status !== 0 && invocation.transport === 'gh') {
      await clearPartialClone(container, containerIdentity, root);
      invocation = managedGitCloneInvocation(source, root, false);
      clone = await runAcquisition(git, invocation.args, home, authEnvironment);
    }
    if (clone.status !== 0 || clone.failure !== undefined) throw processFailure('clone', source.remote, clone);
    if (testHooks.injectUncertainAcquisitionFailure === true) {
      throw processFailure('clone', source.remote, {
        status: null,
        stdout: '',
        stderr: '',
        failure: 'timeout',
        uncertainTermination: true
      });
    }
    const isolated = gitEnvironment(environment, true);
    await assertEffectiveGitStorage(root, git, isolated);
    await assertSafeLocalGitConfiguration(root, git, isolated);
    const rawOrigin = (await requiredOutput(git, repositoryArgs(root, ['config', '--local', '--no-includes', '--get', 'remote.origin.url']), root, isolated, 'read origin URL')).trim();
    const actual = normalizeManagedGitOrigin(rawOrigin);
    if (actual.remote !== source.remote || actual.fetchUrl !== source.fetchUrl) {
      throw new BazframeError('MANAGED_GIT_IDENTITY_MISMATCH', `Cloned origin does not exactly match requested remote Git source ${source.remote}.`);
    }
    await testHooks.afterCloneOriginValidated?.();
    await inspectManagedGitAcquisition(container, root, acquisitionPolicy);
    let branch = selection.branch;
    if (branch === undefined) {
      const symbolic = requiredSingleLine(await requiredOutput(
        git,
        repositoryArgs(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
        root,
        isolated,
        'read default branch'
      ), 'remote default branch');
      if (!symbolic.startsWith('origin/')) throw new BazframeError('MANAGED_GIT_BRANCH_INVALID', `Remote default branch is unavailable for ${source.remote}.`);
      branch = symbolic.slice('origin/'.length);
    }
    assertValidManagedGitBranch(branch);
    const branchRef = `refs/remotes/origin/${branch}`;
    await assertDirectGitReference(root, branchRef, git, isolated);
    const fetchedHead = requiredRevisionOutput(await requiredOutput(
      git,
      repositoryArgs(root, ['rev-parse', '--verify', `${branchRef}^{commit}`]),
      root,
      isolated,
      'resolve fetched branch revision'
    ), 'fetched branch revision');
    let revision = fetchedHead;
    if (selection.mode === 'exact') {
      const resolved = requiredRevisionOutput(await requiredOutput(
        git,
        repositoryArgs(root, ['rev-parse', '--verify', `${selection.revision}^{commit}`]),
        root,
        isolated,
        'resolve exact revision'
      ), 'exact revision');
      if (resolved !== selection.revision) throw new BazframeError('MANAGED_GIT_REVISION_MISMATCH', 'Requested remote Git revision is not an exact commit identity.');
      if (!await isAncestor(root, selection.revision, fetchedHead, environment)) {
        throw new BazframeError('MANAGED_GIT_REVISION_UNREACHABLE', `Requested revision is not reachable from fetched branch ${branch}.`);
      }
      revision = selection.revision;
    }
    await requiredWithMonitor(
      git,
      repositoryArgs(root, ['checkout', '--detach', revision]),
      root,
      isolated,
      'materialize revision',
      () => sampleManagedGitAcquisitionInProgress(container, root, acquisitionPolicy, containerIdentity)
    );
    if (selection.mode === 'exact') {
      await testHooks.beforeExactRefUpdate?.();
      await required(git, repositoryArgs(root, ['update-ref', '--no-deref', branchRef, revision, fetchedHead]), root, isolated, 'pin fetched branch revision');
    }
    await inspectManagedGitAcquisition(container, root, acquisitionPolicy);
    const identity = await directoryIdentity(root);
    await verifyCheckoutState({ root, remote: source.remote, fetchUrl: source.fetchUrl, branch, revision }, environment);
    return { container, containerIdentity, root, identity, source, branch, revision, transport: invocation.transport, revisionMode: selection.mode, acquisitionPolicy };
  } catch (error) {
    if (isUncertainManagedGitProcessError(error)) {
      throw new ManagedGitAcquisitionQuarantineError(container, error);
    }
    try { await removeOwnedContainer(container, containerIdentity); }
    catch (cleanupError) { throw new ManagedGitAcquisitionCleanupError(container, error, cleanupError); }
    throw error;
  }
}

async function validateCandidate(kind: ManagedGitResourceKind, root: string, id: string): Promise<void> {
  if (basename(root) !== id) throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Remote Git source ${kind} root basename must be ${id}.`);
  if (kind === 'skill') {
    const declared = await readStableSkillName(join(root, 'SKILL.md'));
    if (declared !== id) throw new BazframeError('SKILL_NAME_MISMATCH', `Remote Git Skill ${id} declares name ${JSON.stringify(declared)}.`);
    return;
  }
  if (kind === 'package') { await readPackageManifest(root); return; }
  try { await lstat(join(root, 'bazframe-package.json')); throw new BazframeError('LIBRARY_IS_PACKAGE', 'Remote Git library source contains bazframe-package.json; use `bazframe package add` for this repository.'); }
  catch (error) { if (error instanceof BazframeError) throw error; if (errorCode(error) !== 'ENOENT') throw error; }
}

export async function authorizeManagedGitPackageBuild(options: ManagedGitOptions, root: string, remote: string, revision: string, managedRoot?: string): Promise<PackageManifestSnapshot> {
  const manifest = await readPackageManifest(root);
  const details = { remote, revision, root: managedRoot ?? managedGitCheckoutRoot(resolve(options.bazframeHome), 'package', basename(root)), build: manifest.manifest.build };
  await options.reportPackageBuild?.(details);
  if (options.yes !== true) {
    const accepted = await options.confirmPackageBuild?.(details) ?? false;
    if (!accepted) throw new BazframeError('MANAGED_GIT_BUILD_DECLINED', 'Remote package build was not authorized.');
  }
  const current = await readPackageManifest(root);
  if (!samePackageManifestSnapshot(manifest, current)) throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed during build authorization.');
  return manifest;
}

async function verifyProvider(record: ManagedGitRecord, environment: NodeJS.ProcessEnv): Promise<void> {
  await canonicalManagedGitRoot(record);
  await verifyCheckoutState(record, environment);
}

async function verifyCheckoutState(
  record: Pick<ManagedGitRecord, 'root' | 'remote' | 'fetchUrl' | 'branch' | 'revision'>,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const gitMetadata = await lstat(join(record.root, '.git'));
  if (gitMetadata.isSymbolicLink() || !gitMetadata.isDirectory()) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Bazframe-managed checkout .git must be a physical directory: ${record.root}`);
  const git = environment.BAZFRAME_GIT_COMMAND || 'git';
  const isolated = gitEnvironment(environment, true);
  await assertEffectiveGitStorage(record.root, git, isolated);
  await assertSafeLocalGitConfiguration(record.root, git, isolated);
  await assertClean(record.root, environment);
  await assertDetachedHead(record.root, git, isolated);
  const origin = normalizeManagedGitOrigin(requiredSingleLine(
    await requiredOutput(git, repositoryArgs(record.root, ['config', '--local', '--no-includes', '--get', 'remote.origin.url']), record.root, isolated, 'read origin URL'),
    'origin URL'
  ));
  if (origin.remote !== record.remote || origin.fetchUrl !== record.fetchUrl) {
    throw new BazframeError('MANAGED_GIT_IDENTITY_MISMATCH', `Bazframe-managed checkout origin changed: ${record.root}`);
  }
  const head = requiredRevisionOutput(
    await requiredOutput(git, repositoryArgs(record.root, ['rev-parse', '--verify', 'HEAD^{commit}']), record.root, isolated, 'read source revision'),
    'source revision'
  );
  const branchRef = `refs/remotes/origin/${record.branch}`;
  await assertDirectGitReference(record.root, branchRef, git, isolated);
  const branchRevision = requiredRevisionOutput(
    await requiredOutput(git, repositoryArgs(record.root, ['rev-parse', '--verify', `${branchRef}^{commit}`]), record.root, isolated, 'read recorded branch'),
    'recorded branch revision'
  );
  if (head !== record.revision || branchRevision !== record.revision) throw new BazframeError('MANAGED_GIT_REVISION_MISMATCH', `Bazframe-managed checkout revision changed: ${record.root}`);
}

async function assertDetachedHead(root: string, git: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const result = await run(git, repositoryArgs(root, ['symbolic-ref', '-q', 'HEAD']), root, environment);
  if (result.failure !== undefined || result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
    throw processFailure('inspect detached HEAD', git, result);
  }
  if (result.status === 0 || result.stdout !== '' || result.stderr !== '') {
    throw new BazframeError('MANAGED_GIT_REVISION_MISMATCH', `Bazframe-managed checkout HEAD must be detached: ${root}`);
  }
}

async function assertDirectGitReference(root: string, reference: string, git: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const result = await run(git, repositoryArgs(root, ['symbolic-ref', '-q', reference]), root, environment);
  if (result.failure !== undefined || result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
    throw processFailure('inspect branch reference', git, result);
  }
  if (result.status === 0) {
    throw new BazframeError('MANAGED_GIT_BRANCH_INVALID', `Bazframe-managed checkout branch reference must be direct: ${reference}`);
  }
  if (result.stdout !== '' || result.stderr !== '') throw processFailure('inspect branch reference', git, result);
}

async function verifyResourceRegistration(record: ManagedGitRecord): Promise<void> {
  const home = resolveHome(record.root);
  if (record.kind === 'skill') {
    const registration = await readDefaultSkillRegistration(home, record.id);
    if (registration.target !== record.root) throw new BazframeError('MANAGED_GIT_REGISTRATION_MISMATCH', `Added Skill registration does not match remote Git source checkout: ${record.id}`);
    return;
  }
  const resource = record.kind === 'library' ? await readLibrary(home, record.id) : await readPackage(home, record.id);
  if (resource.root !== record.root) throw new BazframeError('MANAGED_GIT_REGISTRATION_MISMATCH', `Global ${record.kind} does not match remote Git source checkout: ${record.id}`);
  await verifySkillSnapshot(home, resource.digest);
}

async function assertResourceAvailableForAdd(home: string, kind: ManagedGitResourceKind, id: string, expectedRoot: string): Promise<void> {
  if (await pathExists(expectedRoot)) throw new BazframeError('MANAGED_GIT_DESTINATION_OCCUPIED', `Bazframe-managed checkout destination is occupied without matching provenance: ${expectedRoot}`);
  const path = kind === 'skill' ? join(defaultSkillCatalogRoot(home), id) : globalCollectionPath(home, kind, id);
  if (await pathExists(path)) throw new BazframeError('MANAGED_GIT_DESTINATION_OCCUPIED', `${title(kind)} ${id} is already registered at ${path}.`);
}

async function cleanManagedCheckout(record: ManagedGitRecord, environment: NodeJS.ProcessEnv, expectedIdentity: DirectoryIdentity): Promise<void> {
  await assertIdentity(record.root, expectedIdentity, 'Bazframe-managed package checkout changed before cleanup');
  const git = environment.BAZFRAME_GIT_COMMAND || 'git';
  const isolated = gitEnvironment(environment, true);
  await assertSafeLocalGitConfiguration(record.root, git, isolated);
  await required(git, repositoryArgs(record.root, ['reset', '--hard', record.revision]), record.root, isolated, 'restore Bazframe-managed package checkout');
  await required(git, repositoryArgs(record.root, ['clean', '-fdx']), record.root, isolated, 'clean Bazframe-managed package checkout');
  await verifyProvider(record, environment);
}

async function assertClean(root: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const git = environment.BAZFRAME_GIT_COMMAND || 'git';
  const isolated = gitEnvironment(environment, true);
  await assertSafeLocalGitConfiguration(root, git, isolated);
  const output = await requiredOutput(git, repositoryArgs(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']), root, isolated, 'inspect source checkout state');
  if (output !== '') throw new BazframeError('MANAGED_GIT_DIRTY', `Remote Git source checkout has local changes, including ignored additions: ${root}`);
  const indexFlags = await requiredOutput(git, repositoryArgs(root, ['ls-files', '-v', '-z']), root, isolated, 'inspect source index flags');
  for (const entry of indexFlags.split('\u0000').filter((value) => value.length > 0)) {
    const tag = entry[0];
    if (tag === 'S' || (tag !== undefined && tag >= 'a' && tag <= 'z')) {
      throw new BazframeError('MANAGED_GIT_DIRTY', `Remote Git source checkout uses index flags that can hide local changes: ${root}`);
    }
  }
}

async function assertEffectiveGitStorage(root: string, git: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const expectedGitDirectory = join(root, '.git');
  const expectedObjectDirectory = join(expectedGitDirectory, 'objects');
  const [gitDirectory, commonDirectory, objectDirectory] = requiredOutputLines(await requiredOutput(
    git,
    repositoryArgs(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir', '--git-path', 'objects']),
    root,
    environment,
    'resolve effective Git storage directories'
  ), 3, 'effective Git storage directories');
  await assertEffectiveGitDirectory(root, gitDirectory, expectedGitDirectory, 'Git directory');
  await assertEffectiveGitDirectory(root, commonDirectory, expectedGitDirectory, 'Git common directory');
  await assertEffectiveGitDirectory(root, objectDirectory, expectedObjectDirectory, 'Git object directory');
}

async function assertEffectiveGitDirectory(root: string, reported: string, expected: string, label: string): Promise<void> {
  const resolved = resolve(root, reported);
  if (resolved !== expected) {
    throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Bazframe-managed checkout ${label} must remain inside its physical .git directory: ${root}`);
  }
  try {
    const metadata = await lstat(expected);
    const canonical = await realpath(expected);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || canonical !== expected) {
      throw new Error(`${label} is not a physical in-tree directory`);
    }
  } catch (cause) {
    throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Bazframe-managed checkout ${label} must be a physical in-tree directory: ${root}`, { cause });
  }
}

async function assertSafeLocalGitConfiguration(root: string, git: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const output = await requiredOutput(git, repositoryArgs(root, ['config', '--local', '--no-includes', '--null', '--list']), root, environment, 'inspect local configuration');
  for (const entry of output.split('\u0000').filter((value) => value.length > 0)) {
    const separator = entry.indexOf('\n');
    const rawKey = separator === -1 ? entry : entry.slice(0, separator);
    const key = rawKey.toLowerCase();
    const value = separator === -1 ? '' : entry.slice(separator + 1);
    if (LOCAL_CONFIG_KEYS.has(key)) continue;
    const branch = /^branch\.(.+)\.(remote|merge)$/iu.exec(rawKey);
    if (branch !== null) {
      assertValidManagedGitBranch(branch[1]!);
      if ((branch[2] === 'remote' && value === 'origin') || (branch[2] === 'merge' && value === `refs/heads/${branch[1]}`)) continue;
    }
    throw new BazframeError('MANAGED_GIT_CONFIG_UNSAFE', `Bazframe-managed checkout local Git configuration contains unsupported key ${JSON.stringify(key)}: ${root}`);
  }
}

function repositoryArgs(_root: string, args: readonly string[]): string[] {
  return ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args];
}
function requiredSingleLine(output: string, label: string): string {
  return requiredOutputLines(output, 1, label)[0]!;
}
function requiredOutputLines(output: string, count: number, label: string): string[] {
  const normalized = output.replace(/\r\n/gu, '\n');
  const value = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const lines = value.split('\n');
  if (lines.length !== count || lines.some((line) => line.length === 0 || line.includes('\r'))) {
    throw new BazframeError('MANAGED_GIT_PROCESS_FAILED', `Git ${label} output must contain exactly ${count} nonempty line${count === 1 ? '' : 's'}.`);
  }
  return lines;
}

function requiredRevisionOutput(output: string, label: string): string {
  const revision = requiredSingleLine(output, label);
  assertValidManagedGitRevision(revision);
  return revision;
}

async function isAncestor(root: string, previous: string, next: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const git = environment.BAZFRAME_GIT_COMMAND || 'git';
  const isolated = gitEnvironment(environment, true);
  const available = await run(git, repositoryArgs(root, ['rev-parse', '--verify', '--quiet', `${previous}^{commit}`]), root, isolated);
  if (available.failure !== undefined || available.error !== undefined
    || (available.status !== 0 && !(available.status === 1 && available.stdout === '' && available.stderr === ''))) {
    throw processFailure('resolve prior branch revision', git, available);
  }
  if (available.status === 1) return false;
  if (requiredRevisionOutput(available.stdout, 'prior branch revision') !== previous) {
    throw new BazframeError('MANAGED_GIT_REVISION_MISMATCH', `Recorded prior revision did not resolve exactly: ${previous}`);
  }
  const result = await run(git, repositoryArgs(root, ['merge-base', '--is-ancestor', previous, next]), root, isolated);
  if (result.failure !== undefined || result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
    throw processFailure('verify branch ancestry', git, result);
  }
  return result.status === 0;
}

function makeRecord(kind: ManagedGitResourceKind, source: ManagedGitSource, root: string, branch: string, revision: string, transport: 'git' | 'gh'): ManagedGitRecord {
  return decodeManagedGitRecord({ schemaVersion: 1, kind, id: source.id, root, remote: source.remote, fetchUrl: source.fetchUrl, transport, branch, revision });
}
function lifecycleResult(action: ManagedGitLifecycleResult['action'], record: ManagedGitRecord): ManagedGitLifecycleResult { return { action, kind: record.kind, id: record.id, root: record.root, remote: record.remote, branch: record.branch, revision: record.revision }; }
function resolveHome(root: string): string { const marker = join('providers', 'git', 'checkouts'); const index = root.lastIndexOf(marker); if (index <= 0) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Bazframe-managed checkout root is outside its Bazframe-managed namespace: ${root}`); return root.slice(0, index - 1); }
async function canonicalManagedHome(entered: string): Promise<string> { const absolute = resolve(entered); await ensureManagedDirectory(absolute, absolute); return realpath(absolute); }
async function assertNoRecovery(home: string, kind: ManagedGitResourceKind, id: string): Promise<void> { const path = managedGitJournalPath(home, kind, id); if (await pathExists(path)) throw new BazframeError('MANAGED_GIT_RECOVERY_REQUIRED', `Inspect remote Git source recovery state before continuing: ${path}`); }

async function assertManagedGitResourceRecoveryAbsent(home: string, kind: ManagedGitResourceKind, id: string): Promise<void> {
  const recoveryRoot = managedGitRecoveryRoot(home);
  const journalPath = managedGitJournalPath(home, kind, id);
  const ancestorPaths = [home, join(home, 'providers'), join(home, 'providers', 'git')];
  const ancestors = await Promise.all(ancestorPaths.map((path) => recoveryDirectoryIdentity(path, journalPath)));
  let metadata;
  try { metadata = await lstat(recoveryRoot, { bigint: true }); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw recoveryAbsenceError(journalPath, error);
    const current = await Promise.all(ancestorPaths.map((path) => recoveryDirectoryIdentity(path, journalPath)));
    if (!current.every((identity, index) => sameDirectoryIdentity(identity, ancestors[index]!))) throw recoveryAbsenceError(journalPath);
    await assertRecoveryPathAbsent(recoveryRoot, journalPath);
    await assertRecoveryPathAbsent(journalPath, journalPath);
    return;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw recoveryAbsenceError(journalPath);
  let handle: FileHandle | undefined;
  let operationError: unknown;
  try {
    handle = await open(recoveryRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) throw recoveryAbsenceError(journalPath);
    await assertRecoveryPathAbsent(journalPath, journalPath);
    const finalHandle = await handle.stat({ bigint: true });
    const currentPath = await lstat(recoveryRoot, { bigint: true });
    const currentAncestors = await Promise.all(ancestorPaths.map((path) => recoveryDirectoryIdentity(path, journalPath)));
    if (!finalHandle.isDirectory() || currentPath.isSymbolicLink() || !currentPath.isDirectory()
      || finalHandle.dev !== metadata.dev || finalHandle.ino !== metadata.ino
      || currentPath.dev !== metadata.dev || currentPath.ino !== metadata.ino
      || !currentAncestors.every((identity, index) => sameDirectoryIdentity(identity, ancestors[index]!))) {
      throw recoveryAbsenceError(journalPath);
    }
    await assertRecoveryPathAbsent(journalPath, journalPath);
  } catch (error) { operationError = error instanceof BazframeError ? error : recoveryAbsenceError(journalPath, error); }
  if (handle !== undefined) {
    try { await handle.close(); }
    catch (error) { operationError ??= recoveryAbsenceError(journalPath, error); }
  }
  if (operationError !== undefined) throw operationError;
}

async function assertRecoveryPathAbsent(path: string, journalPath: string): Promise<void> {
  try { await lstat(path); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw recoveryAbsenceError(journalPath, error);
  }
  throw recoveryAbsenceError(journalPath);
}
async function recoveryDirectoryIdentity(path: string, journalPath: string): Promise<DirectoryIdentity> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw recoveryAbsenceError(journalPath);
    return { device: metadata.dev, inode: metadata.ino };
  } catch (error) { throw error instanceof BazframeError ? error : recoveryAbsenceError(journalPath, error); }
}
function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.device === right.device && left.inode === right.inode; }
function recoveryAbsenceError(path: string, cause?: unknown): BazframeError {
  return new BazframeError('MANAGED_GIT_RECOVERY_REQUIRED', `Remote Git recovery for this resource must be absent in a stable physical namespace: ${path}`, cause === undefined ? {} : { cause });
}

function gitEnvironment(environment: NodeJS.ProcessEnv, isolated: boolean): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|CONFIG_PARAMETERS|CEILING_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|SSH|SSH_COMMAND|PROXY_COMMAND|EXEC_PATH|TEMPLATE_DIR|EXTERNAL_DIFF|DIFF_OPTS|PAGER|EDITOR)$/u.test(key)) delete result[key];
  }
  delete result.GIT_CONFIG_GLOBAL;
  delete result.GIT_CONFIG_SYSTEM;
  delete result.GIT_CONFIG_NOSYSTEM;
  result.GIT_OPTIONAL_LOCKS = '0';
  result.GIT_ATTR_NOSYSTEM = '1';
  result.GIT_NO_REPLACE_OBJECTS = '1';
  result.GIT_GRAFT_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
  if (isolated) { result.GIT_CONFIG_NOSYSTEM = '1'; result.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'; }
  return result;
}
function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  monitor?: () => void | Promise<void>
): Promise<ManagedGitProcessResult> {
  const longRunning = args.includes('clone') || args.includes('fetch');
  return runManagedGitProcess(executable, args, cwd, environment, {
    timeoutMilliseconds: longRunning
      ? PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitCloneFetchMilliseconds
      : PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitMetadataMilliseconds,
    terminationGraceMilliseconds: PROFILE_PORTABILITY_PRODUCTION_LIMITS.processTerminationGraceMilliseconds,
    maxStreamBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes
  }, monitor === undefined ? {} : { monitor });
}
async function required(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, label: string): Promise<void> { const result = await run(executable, args, cwd, environment); if (result.status !== 0 || result.failure !== undefined) throw processFailure(label, executable, result); }
async function requiredWithMonitor(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, label: string, monitor: () => void | Promise<void>): Promise<void> { const result = await run(executable, args, cwd, environment, monitor); if (result.status !== 0 || result.failure !== undefined) throw processFailure(label, executable, result); }
async function requiredOutput(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, label: string): Promise<string> { const result = await run(executable, args, cwd, environment); if (result.status !== 0 || result.failure !== undefined) throw processFailure(label, executable, result); return result.stdout; }
class ManagedGitProcessError extends BazframeError {
  readonly processFailure: ManagedGitProcessResult['failure'];
  readonly uncertainTermination: boolean;
  readonly monitorError?: Error;
  constructor(label: string, target: string, result: ManagedGitProcessResult) {
    const termination = result.failure === undefined ? '' : result.uncertainTermination === true
      ? `process ${result.failure}; termination could not be confirmed`
      : `process ${result.failure}`;
    const diagnostic = safeDiagnostic(result.monitorError?.message || termination || result.stderr || result.error?.message || `status ${result.status ?? 1}`);
    const code = result.failure === 'monitor-failure' && result.monitorError instanceof BazframeError
      ? result.monitorError.code
      : 'MANAGED_GIT_PROCESS_FAILED';
    super(code, `Git ${label} failed for ${target}: ${diagnostic}`, {
      cause: result.monitorError ?? result.error
    });
    this.name = 'ManagedGitProcessError';
    this.processFailure = result.failure;
    this.uncertainTermination = result.uncertainTermination === true;
    this.monitorError = result.monitorError;
  }
}
class ManagedGitAcquisitionCleanupError extends BazframeError {
  readonly stagingPath: string;
  constructor(stagingPath: string, primary: unknown, cleanup: unknown) {
    super(
      'MANAGED_GIT_ACQUISITION_CLEANUP_UNPROVEN',
      `Remote Git acquisition failed and staging cleanup could not be proven at ${boundedPathForDisplay(stagingPath)}.`,
      { cause: cleanup }
    );
    this.name = 'ManagedGitAcquisitionCleanupError';
    this.stagingPath = stagingPath;
    this.errors = [primary, cleanup];
  }
  readonly errors: unknown[];
}
class ManagedGitAcquisitionQuarantineError extends BazframeError {
  readonly stagingPath: string;
  readonly uncertainTermination = true;
  constructor(stagingPath: string, cause: unknown) {
    super(
      'MANAGED_GIT_ACQUISITION_QUARANTINED',
      `Remote Git acquisition process termination was uncertain; retained quarantine at ${boundedPathForDisplay(stagingPath)}.`,
      { cause }
    );
    this.name = 'ManagedGitAcquisitionQuarantineError';
    this.stagingPath = stagingPath;
  }
}
function processFailure(label: string, target: string, result: ManagedGitProcessResult): ManagedGitProcessError {
  return new ManagedGitProcessError(label, target, result);
}
function requiresAcquisitionRecovery(error: unknown): boolean {
  return error instanceof ManagedGitAcquisitionCleanupError || isUncertainManagedGitProcessError(error);
}
function isUncertainManagedGitProcessError(error: unknown): boolean {
  if (error instanceof ManagedGitAcquisitionQuarantineError) return true;
  if (error instanceof ManagedGitProcessError) return error.uncertainTermination;
  if (error instanceof AggregateError) return error.errors.some(isUncertainManagedGitProcessError);
  return error instanceof Error && isUncertainManagedGitProcessError(error.cause);
}
export function safeDiagnostic(value: string): string {
  let redacted = value.replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[redacted]@').replace(/\b(authorization|token|access[_-]?token|oauth[_-]?token|password)\s*[:=]\s*[^\s]+/giu, '$1=[redacted]');
  redacted = replaceUnsafeDisplayCharacters(redacted, ' ').replace(/\s+/gu, ' ').trim();
  return redacted.slice(0, 1000);
}
async function directoryIdentity(path: string): Promise<DirectoryIdentity> { const metadata = await lstat(path, { bigint: true }); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Expected a physical Bazframe-managed directory: ${path}`); return { device: metadata.dev, inode: metadata.ino }; }
async function holdDirectoryIdentity(path: string): Promise<HeldDirectoryIdentity> { let handle: FileHandle | undefined; try { handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); const opened = await handle.stat({ bigint: true }); const current = await lstat(path, { bigint: true }); if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || opened.dev !== current.dev || opened.ino !== current.ino) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Expected a stable physical Bazframe-managed directory: ${path}`); return { handle, identity: { device: opened.dev, inode: opened.ino } }; } catch (error) { await handle?.close().catch(() => undefined); throw error; } }
async function assertIdentity(path: string, expected: DirectoryIdentity, message: string): Promise<void> { const current = await directoryIdentity(path); if (current.device !== expected.device || current.inode !== expected.inode) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `${message}: ${path}`); }
async function removeOwnedTree(path: string, expected: DirectoryIdentity): Promise<void> { await assertIdentity(path, expected, 'Bazframe-managed directory ownership changed before cleanup'); await rm(path, { recursive: true }); }
async function removeOwnedContainer(path: string, expected: DirectoryIdentity): Promise<void> { const metadata = await lstat(path, { bigint: true }).catch((error) => errorCode(error) === 'ENOENT' ? undefined : Promise.reject(error)); if (metadata === undefined) return; if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.dev !== expected.device || metadata.ino !== expected.inode) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed staging container ownership changed: ${path}`); await rm(path, { recursive: true }); }
async function clearPartialClone(container: string, expected: DirectoryIdentity, root: string): Promise<void> { await assertIdentity(container, expected, 'staging container changed before GitHub fallback'); await rm(root, { recursive: true, force: true }); }
async function throwAfterAcquiredTransactionFailure(
  error: unknown,
  transaction: TransactionState,
  acquired: AcquiredRepository,
  home: string,
  kind: ManagedGitResourceKind,
  id: string,
  committedDetail: string,
  cleanupDetail: string
): Promise<never> {
  if (transaction.journalState !== undefined) {
    if (error instanceof ManagedGitRecoveryError) throw error;
    throw recoveryError(
      error,
      home,
      kind,
      id,
      transaction.resourceCommitted ? committedDetail : 'transaction stopped with retained recovery state'
    );
  }
  try { await removeOwnedContainer(acquired.container, acquired.containerIdentity); }
  catch (cleanupError) { throw new AggregateError([error, cleanupError], `${cleanupDetail} at ${acquired.container}.`, { cause: cleanupError }); }
  throw error;
}
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; } }
async function createExclusiveFile(home: string, path: string, text: string): Promise<FileIdentity> { await ensureManagedDirectory(home, dirname(path)); let handle: FileHandle | undefined; try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle?.close(); } return physicalFileIdentity(path); }
async function createJournal(home: string, journal: ManagedGitJournal): Promise<FileIdentity> { return createExclusiveFile(home, managedGitJournalPath(home, journal.kind, journal.id), encodeManagedGitJournal(journal)); }
async function updateJournal(home: string, journal: ManagedGitJournal, expected: FileIdentity | undefined): Promise<FileIdentity> { const path = managedGitJournalPath(home, journal.kind, journal.id); if (expected === undefined) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed recovery record ownership is unavailable: ${path}`); const current = await physicalFileIdentity(path); if (!sameFileIdentity(expected, current)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed recovery record changed before update: ${path}`); await writeFileAtomic(path, encodeManagedGitJournal(journal), { managedRoot: home, mode: 0o600, commitOnRename: true }); return physicalFileIdentity(path); }
function journalFor(record: ManagedGitRecord, operation: ManagedGitJournal['operation'], phase: string, previousRevision: string | null, nextRevision: string, staging: string | null = null, backup: string | null = null, resourceStateSha256: string | null = null): ManagedGitJournal { return { schemaVersion: 1, operation, phase, kind: record.kind, id: record.id, remote: record.remote, fetchUrl: record.fetchUrl, transport: record.transport, branch: record.branch, previousRevision, nextRevision, root: record.root, staging, backup, resourceStateSha256 }; }
async function physicalFileIdentity(path: string): Promise<FileIdentity> { let handle: FileHandle | undefined; try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = await handle.stat({ bigint: true }); if (!before.isFile()) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Expected a physical Bazframe-managed file: ${path}`); const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const current = await lstat(path, { bigint: true }); if (!after.isFile() || current.isSymbolicLink() || !current.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed file changed while inspected: ${path}`); return { device: before.dev, inode: before.ino, sha256: createHash('sha256').update(bytes).digest('hex') }; } finally { await handle?.close(); } }
async function removeOwnedFile(path: string, expected: FileIdentity): Promise<void> { const current = await physicalFileIdentity(path); if (current.device !== expected.device || current.inode !== expected.inode || current.sha256 !== expected.sha256) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed file ownership changed before removal: ${path}`); await unlink(path); }
async function removeOwnedRecord(home: string, expected: ManagedGitRecordSnapshot): Promise<void> { const current = await readManagedGitRecord(home, expected.record.kind, expected.record.id); if (!sameRecordSnapshot(expected, current)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Remote Git provenance changed before removal: ${expected.path}`); await unlink(expected.path); }
async function restoreOwnedRecord(home: string, expected: ManagedGitRecordSnapshot, replacement: ManagedGitRecord): Promise<void> { const current = await readManagedGitRecord(home, expected.record.kind, expected.record.id); if (!sameRecordSnapshot(expected, current)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Remote Git provenance changed before rollback: ${expected.path}`); await writeFileAtomic(expected.path, encodeManagedGitRecord(replacement), { managedRoot: home, mode: 0o600, commitOnRename: true }); }
async function restoreOwnedDirectory(source: string, expected: DirectoryIdentity, destination: string): Promise<void> { await assertIdentity(source, expected, 'Bazframe-managed backup ownership changed before rollback'); if (await pathExists(destination)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed rollback destination became occupied: ${destination}`); await rename(source, destination); }
function sameRecordSnapshot(left: ManagedGitRecordSnapshot, right: ManagedGitRecordSnapshot): boolean { return left.device === right.device && left.inode === right.inode && left.contentSha256 === right.contentSha256; }
function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.device === right.device && left.inode === right.inode && left.sha256 === right.sha256; }
async function readStableSkillName(path: string): Promise<string> { let handle: FileHandle | undefined; try { try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Remote Git Skill definition must be a physical regular file: ${path}`, { cause: error }); } const before = await handle.stat({ bigint: true }); if (!before.isFile()) throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Remote Git Skill definition must be a physical regular file: ${path}`); const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const current = await lstat(path, { bigint: true }); if (!after.isFile() || current.isSymbolicLink() || !current.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Remote Git Skill definition changed while inspected: ${path}`); let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (error) { throw new BazframeError('INVALID_SKILL_DEFINITION', `Skill definition is not valid UTF-8: ${path}`, { cause: error }); } return parseSkillDeclaredName(text, path); } finally { await handle?.close(); } }
class ManagedGitRecoveryError extends AggregateError {
  constructor(errors: readonly unknown[], message: string, cause: unknown) {
    super(errors, message, { cause });
    this.name = 'ManagedGitRecoveryError';
  }
}
function recoveryError(error: unknown, home: string, kind: ManagedGitResourceKind, id: string, detail: string): ManagedGitRecoveryError {
  return new ManagedGitRecoveryError([error], `Remote Git source ${detail}; inspect ${managedGitJournalPath(home, kind, id)} before continuing.`, error);
}
function title(kind: ManagedGitResourceKind): string { return kind === 'skill' ? 'Skill' : kind === 'library' ? 'Library' : 'Package'; }
