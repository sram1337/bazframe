import type { SkillCollectionLifecycleDependencies } from '../skill-collections/skill-collection-lifecycle.js';
import type { AddedSkillPlatformServices } from '../skills/added-skill-platform-services.js';
import { decodeManagedGitTreeEvidence, assertManagedGitIndexMatchesTree, type ManagedGitTreeEvidence } from './managed-git-tree.js';
import { sameResourceIdentity, resourceIdentityText, type ResourceIdentity } from '../skill-collections/resource-identity.js';

import { resolveControlledExecutable, executableEnvironmentValue } from '../core/executable-resolution.js';

import { createHash, randomUUID } from 'node:crypto';

import { constants } from 'node:fs';

import { lstat, mkdtemp as posixMkdtemp, open, realpath as posixRealpath, rename, rm, unlink, type FileHandle } from 'node:fs/promises';

import { basename as posixBasename, dirname as posixDirname, join as posixJoin, relative as posixRelative, resolve as posixResolve, sep as posixSep } from 'node:path';

import { BazframeError, errorCode } from '../core/errors.js';

import type {
  BoundedPackageProcessOptions,
  BoundedPackageProcessResult,
  ChildOutputPolicy
} from '../core/child-process.js';

import { boundedPathForDisplay, boundedTextForDisplay, replaceUnsafeDisplayCharacters } from '../core/safe-text.js';

import {
  PROFILE_PORTABILITY_PRODUCTION_LIMITS,
  managedGitAcquisitionLimitPolicy,
  type ManagedGitAcquisitionLimitPolicy
} from '../profile-portability/profile-portability-policy.js';

import { readPackageManifest as posixReadPackageManifest, samePackageManifestSnapshot, type PackageManifestSnapshot } from '../packages/package-manifest.js';

import {
  addDefaultSkill as sharedAddDefaultSkill, defaultSkillCatalogRoot, readDefaultSkillRegistration as posixReadDefaultSkillRegistration,
  readDefaultSkillRegistrationSnapshot as posixReadDefaultSkillRegistrationSnapshot, removeDefaultSkill as sharedRemoveDefaultSkill
} from '../skills/default-skill-catalog.js';

import { assertSafeSkillId } from '../skills/skill-id.js';

import { parseSkillDeclaredName } from '../skills/skill-metadata.js';

import {
  addLibrary as sharedAddLibrary, addPackage as sharedAddPackage, buildPackage as sharedBuildPackage, removeLibrary as sharedRemoveLibrary, removePackage as sharedRemovePackage, updateLibrary as sharedUpdateLibrary,
  type SkillCollectionLifecycleResult
} from '../skill-collections/skill-collection-lifecycle.js';

import {
  globalCollectionPath as posixGlobalCollectionPath, readCollectionSnapshot as posixReadCollectionSnapshot, readLibrary as posixReadLibrary, readLibrarySnapshot as posixReadLibrarySnapshot, readPackage as posixReadPackage, readPackageSnapshot as posixReadPackageSnapshot,
  sameCollectionSnapshot, type SkillCollectionRecordSnapshot
} from '../skill-collections/skill-collection-store.js';

import {
  isUncertainPackageBuildError,
  type BeforePackageBuildContext
} from '../skill-collections/skill-collection-preparation.js';

import { verifySkillSnapshot as posixVerifySkillSnapshot } from '../skill-collections/skill-snapshot.js';

import { ensureManagedDirectory as posixEnsureManagedDirectory, writeFileAtomic as posixWriteFileAtomic } from '../state/atomic-file.js';

import { withStateLock as posixWithStateLock } from '../state/lock.js';

import {
  assertReadOnlyPathAnchor as posixAssertReadOnlyPathAnchor,
  closeReadOnlyPathAnchor as posixCloseReadOnlyPathAnchor,
  holdReadOnlyPathAnchor as posixHoldReadOnlyPathAnchor
} from '../state/read-only-path-anchor.js';

import {
  assertValidManagedGitBranch, assertValidManagedGitRevision, canonicalManagedGitRoot as posixCanonicalManagedGitRoot,
  decodeManagedGitRecord as posixDecodeManagedGitRecord, decodePathFreeManagedGitIdentity, encodeManagedGitJournal, encodeManagedGitRecord, managedGitCheckoutRoot as posixManagedGitCheckoutRoot,
  managedGitJournalPath as posixManagedGitJournalPath, managedGitRecordPath as posixManagedGitRecordPath, managedGitRecoveryRoot as posixManagedGitRecoveryRoot, managedGitStagingRoot as posixManagedGitStagingRoot,
  optionalManagedGitRecord as posixOptionalManagedGitRecord, optionalManagedGitRecordInExistingNamespace as posixOptionalManagedGitRecordInExistingNamespace, readManagedGitJournal as posixReadManagedGitJournal, readManagedGitRecord as posixReadManagedGitRecord, type ManagedGitJournal, type ManagedGitJournalSnapshot,
  type ManagedGitRecord, type ManagedGitRecordSnapshot, type ManagedGitResourceKind,
  type PathFreeManagedGitIdentity
} from './managed-git-record.js';

import { managedGithubCloneEnvironment, runManagedGitProcess, type ManagedGitProcessResult } from './managed-git-process.js';

import {
  inspectManagedGitAcquisition as posixInspectManagedGitAcquisition,
  inspectManagedGitPublishedCheckout as posixInspectManagedGitPublishedCheckout,
  sampleManagedGitAcquisitionInProgress as posixSampleManagedGitAcquisitionInProgress
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
  /** Additional authorization/revalidation invoked within the adjacent managed-package callback. */
  beforePackageBuild?: (context: BeforePackageBuildContext) => void | Promise<void>;
  /** Import-only accounting after managed pre-spawn revalidation succeeds. Must not await. */
  onPackageBuildReady?: (context: BeforePackageBuildContext) => void;
  /** Internal deterministic fault-injection seams used only by lifecycle tests. */
  testHooks?: {
    afterRemoveResource?: () => void | Promise<void>;
    afterStateLockAcquired?: () => void | Promise<void>;
    afterCloneOriginValidated?: () => void | Promise<void>;
    beforeExactRefUpdate?: () => void | Promise<void>;
    afterPublishedCheckout?: () => void | Promise<void>;
    /** Deterministic preflight drift seam used only by managed-package tests. */
    beforePackageBuildPreflight?: () => void | Promise<void>;
    /** Deterministic process-tree uncertainty seam used only by acquisition tests. */
    injectUncertainAcquisitionFailure?: boolean;
    /** Deterministic uncertain package-process seam used only by recovery tests. */
    injectUncertainPackageBuildFailure?: boolean;
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
  root: ResourceIdentity & { path: string };
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

type DirectoryIdentity = ResourceIdentity;

interface HeldDirectoryIdentity { handle: { close(): Promise<void> }; identity: DirectoryIdentity }

type FileIdentity = ResourceIdentity & { sha256: string };

interface TransactionState { resourceCommitted: boolean; journalState?: FileIdentity }

type ManagedGitRevisionSelection =
  | { mode: 'branchHead'; branch?: string }
  | { mode: 'exact'; branch: string; revision: string };

export interface ManagedGitCloneInvocation { transport: 'gh' | 'git'; args: readonly string[] }


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


export type ImportOccupancy = 'absent' | ResourceIdentity & {
  type: string;
  mtimeNs: bigint | string;
  ctimeNs: bigint | string;
};

interface HeldImportDirectory {
  path: string;
  handle: FileHandle;
  device: bigint;
  inode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

class ManagedGitProcessError extends BazframeError {
  readonly operation: string;
  readonly status: number | null;
  readonly processFailure: ManagedGitProcessResult['failure'];
  readonly definiteNetworkUnavailable: boolean;
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
    this.operation = label;
    this.status = result.status;
    this.processFailure = result.failure;
    this.definiteNetworkUnavailable = !failedManagedGitProcess(result) && /(?:could not resolve host|failed to connect|network is unreachable|connection (?:timed out|refused)|couldn't connect)/iu.test(result.stderr || result.error?.message || '');
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

function failedManagedGitProcess(result: ManagedGitProcessResult): boolean {
  return result.failure !== undefined || result.error !== undefined || result.monitorError !== undefined || result.uncertainTermination === true || result.signal !== undefined;
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


/** True only when a clone/fetch process settled unsuccessfully with confirmed termination. */
export function isDefiniteManagedGitAcquisitionUnavailable(error: unknown): boolean {
  return error instanceof ManagedGitProcessError
    && error.operation === 'clone'
    && error.status !== null
    && error.status !== 0
    && error.processFailure === undefined
    && error.monitorError === undefined
    && error.definiteNetworkUnavailable
    && !error.uncertainTermination;
}


/** Retain an isolated home whenever managed-Git/package cleanup or process settlement is uncertain. */
export function isUncertainManagedGitOperation(error: unknown): boolean {
  if (isUncertainManagedGitProcessError(error) || isUncertainPackageBuildError(error)) return true;
  if (error instanceof BazframeError && [
    'MANAGED_GIT_ACQUISITION_CLEANUP_UNPROVEN',
    'MANAGED_GIT_ACQUISITION_QUARANTINED',
    'MANAGED_GIT_RECOVERY_REQUIRED',
    'PACKAGE_BUILD_TERMINATION_UNCERTAIN'
  ].includes(error.code)) return true;
  if (error instanceof AggregateError && error.errors.some(isUncertainManagedGitOperation)) return true;
  return error instanceof Error && error.cause !== undefined && isUncertainManagedGitOperation(error.cause);
}


export function safeDiagnostic(value: string): string {
  let redacted = value.replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[redacted]@').replace(/\b(authorization|token|access[_-]?token|oauth[_-]?token|password)\s*[:=]\s*[^\s]+/giu, '$1=[redacted]');
  redacted = replaceUnsafeDisplayCharacters(redacted, ' ').replace(/\s+/gu, ' ').trim();
  return redacted.slice(0, 1000);
}

class ManagedGitRecoveryError extends AggregateError {
  constructor(errors: readonly unknown[], message: string, cause: unknown) {
    super(errors, message, { cause });
    this.name = 'ManagedGitRecoveryError';
  }
}
export interface ManagedGitReadAnchor { path: string; assertStable(): Promise<void>; close(): Promise<void> }
export interface ManagedGitServices {
platform: NodeJS.Platform;
recordTreeEvidence(root: string, evidence: ManagedGitTreeEvidence): void;
assertAuthority(): void;
collectionDependencies: SkillCollectionLifecycleDependencies;
catalogServices: AddedSkillPlatformServices;
runProcess: typeof runManagedGitProcess;
writeProviderFile(path: string, text: string, expected: (ResourceIdentity & { sha256: string }) | null): Promise<void>;
physicalDirectory(path: string): Promise<void>;
moveDirectory(source: string, destination: string, expected: ResourceIdentity): Promise<void>;

readPackageManifest: typeof posixReadPackageManifest;
readDefaultSkillRegistration: typeof posixReadDefaultSkillRegistration;
captureSkillRegistrationIdentity(home: string, id: string): Promise<string>;
readCollectionSnapshot: typeof posixReadCollectionSnapshot;
readLibrary: typeof posixReadLibrary;
readLibrarySnapshot: typeof posixReadLibrarySnapshot;
readPackage: typeof posixReadPackage;
readPackageSnapshot: typeof posixReadPackageSnapshot;
verifySkillSnapshot: typeof posixVerifySkillSnapshot;
ensureManagedDirectory: typeof posixEnsureManagedDirectory;
writeFileAtomic: typeof posixWriteFileAtomic;
withStateLock: typeof posixWithStateLock;
holdReadOnlyPathAnchor(path: string): Promise<ManagedGitReadAnchor>;
canonicalManagedGitRoot: typeof posixCanonicalManagedGitRoot;
decodeManagedGitRecord: typeof posixDecodeManagedGitRecord;
managedGitCheckoutRoot: typeof posixManagedGitCheckoutRoot;
managedGitJournalPath: typeof posixManagedGitJournalPath;
managedGitRecordPath: typeof posixManagedGitRecordPath;
managedGitRecoveryRoot: typeof posixManagedGitRecoveryRoot;
managedGitStagingRoot: typeof posixManagedGitStagingRoot;
optionalManagedGitRecord: typeof posixOptionalManagedGitRecord;
optionalManagedGitRecordInExistingNamespace: typeof posixOptionalManagedGitRecordInExistingNamespace;
readManagedGitJournal: typeof posixReadManagedGitJournal;
readManagedGitRecord: typeof posixReadManagedGitRecord;
inspectManagedGitAcquisition: typeof posixInspectManagedGitAcquisition;
inspectManagedGitPublishedCheckout: typeof posixInspectManagedGitPublishedCheckout;
sampleManagedGitAcquisitionInProgress: typeof posixSampleManagedGitAcquisitionInProgress;
basename: typeof posixBasename;
dirname: typeof posixDirname;
join: typeof posixJoin;
relative: typeof posixRelative;
resolve: typeof posixResolve;
sep: string;
realpath(path: string): Promise<string>;
mkdtemp(prefix: string): Promise<string>;
captureImportOccupancy: (home: string, paths: Readonly<Record<string, string>>) => Promise<ReadonlyMap<string, ImportOccupancy>>;
repositoryArgs: (_root: string, args: readonly string[]) => string[];
assertManagedGitResourceRecoveryAbsent: (home: string, kind: ManagedGitResourceKind, id: string) => Promise<void>;
resolveManagedGitCommand: (environment: NodeJS.ProcessEnv, excludedRoot: string) => Promise<string>;
resolveManagedGithubCommand: (environment: NodeJS.ProcessEnv, excludedRoot: string) => Promise<string | undefined>;
gitEnvironment: (environment: NodeJS.ProcessEnv, isolated: boolean) => NodeJS.ProcessEnv;
directoryIdentity: (path: string) => Promise<DirectoryIdentity>;
holdDirectoryIdentity: (path: string) => Promise<HeldDirectoryIdentity>;
removeOwnedTree: (path: string, expected: DirectoryIdentity) => Promise<void>;
removeOwnedContainer: (path: string, expected: DirectoryIdentity) => Promise<void>;
clearPartialClone: (container: string, expected: DirectoryIdentity, root: string) => Promise<void>;
pathExists: (path: string) => Promise<boolean>;
createExclusiveFile: (home: string, path: string, text: string) => Promise<FileIdentity>;
physicalFileIdentity: (path: string) => Promise<FileIdentity>;
removeOwnedFile: (path: string, expected: FileIdentity) => Promise<void>;
removeOwnedRecord: (home: string, expected: ManagedGitRecordSnapshot) => Promise<void>;
restoreOwnedRecord: (home: string, expected: ManagedGitRecordSnapshot, replacement: ManagedGitRecord) => Promise<void>;
restoreOwnedDirectory: (source: string, expected: DirectoryIdentity, destination: string) => Promise<void>;
readStableSkillName: (path: string) => Promise<string>;
}

/** One shared provider engine; platform services supply physical effects, never lifecycle outcomes. */
export function createManagedGitProvider(services?: ManagedGitServices) {
const globalCollectionPath: typeof posixGlobalCollectionPath = services === undefined ? posixGlobalCollectionPath : (home, kind, id) => services.join(home, kind === 'library' ? 'libraries' : 'packages', `${id}.json`);
const collectionDeps = (deps: SkillCollectionLifecycleDependencies): SkillCollectionLifecycleDependencies => services === undefined ? deps : { ...deps, ...services.collectionDependencies };
const addLibrary: typeof sharedAddLibrary = (options, root, deps = {}) => sharedAddLibrary(options, root, collectionDeps(deps));
const addPackage: typeof sharedAddPackage = (options, root, deps = {}) => sharedAddPackage(options, root, collectionDeps(deps));
const buildPackage: typeof sharedBuildPackage = (options, id, deps = {}) => sharedBuildPackage(options, id, collectionDeps(deps));
const updateLibrary: typeof sharedUpdateLibrary = (options, id, deps = {}) => sharedUpdateLibrary(options, id, collectionDeps(deps));
const removeLibrary: typeof sharedRemoveLibrary = (options, id, deps = {}) => sharedRemoveLibrary(options, id, collectionDeps(deps));
const removePackage: typeof sharedRemovePackage = (options, id, deps = {}) => sharedRemovePackage(options, id, collectionDeps(deps));
const addDefaultSkill: typeof sharedAddDefaultSkill = (home, root, deps = {}) => sharedAddDefaultSkill(home, root, services === undefined ? deps : { ...deps, stateLockHeld: false, platformServices: services.catalogServices });
const removeDefaultSkill: typeof sharedRemoveDefaultSkill = (home, id, deps = {}) => sharedRemoveDefaultSkill(home, id, services === undefined ? deps : { ...deps, stateLockHeld: false, platformServices: services.catalogServices });
const readPackageManifest = services?.readPackageManifest ?? posixReadPackageManifest;
const readDefaultSkillRegistration = services?.readDefaultSkillRegistration ?? posixReadDefaultSkillRegistration;
const readDefaultSkillRegistrationSnapshot = posixReadDefaultSkillRegistrationSnapshot;
const readCollectionSnapshot = services?.readCollectionSnapshot ?? posixReadCollectionSnapshot;
const readLibrary = services?.readLibrary ?? posixReadLibrary;
const readLibrarySnapshot = services?.readLibrarySnapshot ?? posixReadLibrarySnapshot;
const readPackage = services?.readPackage ?? posixReadPackage;
const readPackageSnapshot = services?.readPackageSnapshot ?? posixReadPackageSnapshot;
const verifySkillSnapshot = services?.verifySkillSnapshot ?? posixVerifySkillSnapshot;
const ensureManagedDirectory = services?.ensureManagedDirectory ?? posixEnsureManagedDirectory;
const writeFileAtomic = services?.writeFileAtomic ?? posixWriteFileAtomic;
const withStateLock = services?.withStateLock ?? posixWithStateLock;
const assertReadOnlyPathAnchor = (anchor: ManagedGitReadAnchor) => anchor.assertStable();
const closeReadOnlyPathAnchor = (anchor: ManagedGitReadAnchor) => anchor.close();
const holdReadOnlyPathAnchor = services?.holdReadOnlyPathAnchor ?? (async (path: string): Promise<ManagedGitReadAnchor> => { const anchor = await posixHoldReadOnlyPathAnchor(path); return { path: anchor.path, assertStable: () => posixAssertReadOnlyPathAnchor(anchor), close: () => posixCloseReadOnlyPathAnchor(anchor) }; });
const canonicalManagedGitRoot = services?.canonicalManagedGitRoot ?? posixCanonicalManagedGitRoot;
const decodeManagedGitRecord = services?.decodeManagedGitRecord ?? posixDecodeManagedGitRecord;
const managedGitCheckoutRoot = services?.managedGitCheckoutRoot ?? posixManagedGitCheckoutRoot;
const managedGitJournalPath = services?.managedGitJournalPath ?? posixManagedGitJournalPath;
const managedGitRecordPath = services?.managedGitRecordPath ?? posixManagedGitRecordPath;
const managedGitRecoveryRoot = services?.managedGitRecoveryRoot ?? posixManagedGitRecoveryRoot;
const managedGitStagingRoot = services?.managedGitStagingRoot ?? posixManagedGitStagingRoot;
const optionalManagedGitRecord = services?.optionalManagedGitRecord ?? posixOptionalManagedGitRecord;
const optionalManagedGitRecordInExistingNamespace = services?.optionalManagedGitRecordInExistingNamespace ?? posixOptionalManagedGitRecordInExistingNamespace;
const readManagedGitJournal = services?.readManagedGitJournal ?? posixReadManagedGitJournal;
const readManagedGitRecord = services?.readManagedGitRecord ?? posixReadManagedGitRecord;
const inspectManagedGitAcquisition = services?.inspectManagedGitAcquisition ?? posixInspectManagedGitAcquisition;
const inspectManagedGitPublishedCheckout = services?.inspectManagedGitPublishedCheckout ?? posixInspectManagedGitPublishedCheckout;
const sampleManagedGitAcquisitionInProgress = services?.sampleManagedGitAcquisitionInProgress ?? posixSampleManagedGitAcquisitionInProgress;
const basename = services?.basename ?? posixBasename;
const dirname = services?.dirname ?? posixDirname;
const join = services?.join ?? posixJoin;
const relative = services?.relative ?? posixRelative;
const resolve = services?.resolve ?? posixResolve;
const sep = services?.sep ?? posixSep;
const realpath = services?.realpath ?? posixRealpath;
const mkdtemp = services?.mkdtemp ?? posixMkdtemp;


const LOCAL_CONFIG_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'remote.origin.url',
  'remote.origin.fetch', 'extensions.objectformat', 'extensions.refstorage'
]);


function managedGitCloneInvocation(source: ManagedGitSource, root: string, githubAuthenticated: boolean): ManagedGitCloneInvocation {
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


async function addManagedGitSkill(options: ManagedGitOptions, entered: string): Promise<ManagedGitLifecycleResult> { return addManaged(options, 'skill', parseManagedGitSource(entered)); }

async function addManagedGitLibrary(options: ManagedGitOptions, entered: string): Promise<ManagedGitLifecycleResult> { return addManaged(options, 'library', parseManagedGitSource(entered)); }

async function addManagedGitPackage(options: ManagedGitOptions, entered: string): Promise<ManagedGitLifecycleResult> { return addManaged(options, 'package', parseManagedGitSource(entered)); }

async function addManagedGitSkillAtRevision(
  options: ManagedGitOptions,
  id: string,
  enteredIdentity: PathFreeManagedGitIdentity,
  requirement?: ManagedGitExactRevisionReuseRequirement
): Promise<ManagedGitLifecycleResult> {
  return addManagedAtRevision(options, 'skill', id, enteredIdentity, requirement);
}

async function addManagedGitLibraryAtRevision(
  options: ManagedGitOptions,
  id: string,
  enteredIdentity: PathFreeManagedGitIdentity,
  requirement?: ManagedGitExactRevisionReuseRequirement
): Promise<ManagedGitLifecycleResult> {
  return addManagedAtRevision(options, 'library', id, enteredIdentity, requirement);
}

async function addManagedGitPackageAtRevision(
  options: ManagedGitOptions,
  id: string,
  enteredIdentity: PathFreeManagedGitIdentity,
  requirement?: ManagedGitExactRevisionReuseRequirement
): Promise<ManagedGitLifecycleResult> {
  return addManagedAtRevision(options, 'package', id, enteredIdentity, requirement);
}

async function updateManagedGitSkill(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return updateManaged(options, 'skill', id); }

async function updateManagedGitLibrary(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return updateManaged(options, 'library', id); }

async function updateManagedGitPackage(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return updateManaged(options, 'package', id); }

async function removeManagedGitSkill(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return removeManaged(options, 'skill', id); }

async function removeManagedGitLibrary(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return removeManaged(options, 'library', id); }

async function removeManagedGitPackage(options: ManagedGitOptions, id: string): Promise<ManagedGitLifecycleResult> { return removeManaged(options, 'package', id); }


async function isManagedGitResource(options: { bazframeHome: string }, kind: ManagedGitResourceKind, id: string): Promise<boolean> {
  if (await optionalManagedGitRecord(options.bazframeHome, kind, id) !== undefined) return true;
  const journalPath = managedGitJournalPath(options.bazframeHome, kind, id);
  return await pathExists(journalPath) && (await readManagedGitJournal(options.bazframeHome, kind, id)).journal.operation === 'remove';
}

async function verifyManagedGitResource(home: string, kind: ManagedGitResourceKind, id: string, environment: NodeJS.ProcessEnv = process.env): Promise<ManagedGitRecord> {
  const record = (await readManagedGitRecord(home, kind, id)).record;
  await verifyProvider(record, environment);
  await verifyResourceRegistration(record);
  return record;
}


async function captureManagedGitExportHealth(
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


function sameManagedGitExportHealth(
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
    && sameResourceIdentity(left.root, right.root)
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
      ...health.recordSnapshot,
      record: { ...health.recordSnapshot.record },
      path: health.recordSnapshot.path,
      contentSha256: health.recordSnapshot.contentSha256
    },
    root: { ...health.root },
    resourceIdentity: health.resourceIdentity,
    ...(health.collectionSnapshot === undefined ? {} : {
      collectionSnapshot: {
        ...health.collectionSnapshot,
        record: { ...health.collectionSnapshot.record }
      }
    })
  };
}


function assertExpectedExactReuseHealth(
  home: string,
  kind: ManagedGitResourceKind,
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


/** Read-only exact-state classification for post-error import accounting. */
async function classifyManagedGitImportOutcome(
  home: string,
  kind: ManagedGitResourceKind,
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


/** Read-only provider-only occupancy probe for local profile-import classification. */
async function classifyManagedGitProviderOccupancy(
  home: string,
  kind: 'library' | 'package',
  id: string,
  testHooks: ManagedGitImportResourceTestHooks = {}
): Promise<'absent' | 'occupied'> {
  assertSafeSkillId(id);
  const anchor = await holdReadOnlyPathAnchor(home);
  try {
    const paths = {
      record: managedGitRecordPath(anchor.path, kind, id),
      journal: managedGitJournalPath(anchor.path, kind, id),
      root: managedGitCheckoutRoot(anchor.path, kind, id)
    };
    const initial = await captureImportOccupancy(anchor.path, paths);
    await testHooks.afterInitialOccupancy?.();
    const current = await captureImportOccupancy(anchor.path, paths);
    if (!sameImportOccupancy(initial, current)) {
      throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git ${kind} ${id} provider occupancy changed during inspection.`);
    }
    await assertReadOnlyPathAnchor(anchor);
    return Object.values(paths).every((path) => initial.get(path) === 'absent') ? 'absent' : 'occupied';
  } finally {
    await closeReadOnlyPathAnchor(anchor);
  }
}


/** Read-only exact-state classification for profile-import planning. */
async function classifyManagedGitImportResource(
  home: string,
  kind: ManagedGitResourceKind,
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
  kind: ManagedGitResourceKind,
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


function importResourcePaths(home: string, kind: ManagedGitResourceKind, id: string): {
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
  paths: Readonly<Record<string, string>>
): Promise<ReadonlyMap<string, ImportOccupancy>> { if (services !== undefined) return services.captureImportOccupancy(home, paths);
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
  if (expected.domain === 'windows') throw new BazframeError('MANAGED_GIT_DOMAIN_INVALID', 'POSIX import observation cannot consume Windows identity.');
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
      mtimeNs: opened.mtimeNs,
      ctimeNs: opened.ctimeNs
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
  return sameResourceIdentity(left, right)
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
    if (services !== undefined) return { identity: await services.captureSkillRegistrationIdentity(home, record.id) };
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
    identity: `${collectionSnapshot.path}:${resourceIdentityText(collectionSnapshot)}:${collectionSnapshot.contentSha256}`,
    collectionSnapshot
  };
}


async function buildManagedGitPackage(options: ManagedGitOptions, id: string): Promise<SkillCollectionLifecycleResult> {
  options = await resolveManagedGitOptions(options);
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
        const expectedManifest = await readPackageManifest(record.root);
        transaction.journalState = await createJournal(home, journalFor(record, 'build', 'building', record.revision, record.revision));
        try {
          const built = await buildPackage(
            { bazframeHome: home, environment: options.environment, childOutputPolicy: options.childOutputPolicy },
            id,
            {
              stateLockHeld: true,
              afterPackageSnapshot: () => cleanManagedCheckout(record, options.environment ?? process.env, rootIdentity),
              ...managedPackageActivationDependencies(options, record, rootIdentity, expectedManifest),
              ...packageProcessTestDependency(options)
            }
          );
          transaction.resourceCommitted = true;
          transaction.journalState = await updateJournal(home, journalFor(record, 'build', 'activated', record.revision, record.revision), transaction.journalState);
          return built;
        } catch (error) {
          if (transaction.resourceCommitted) throw recoveryError(error, home, 'package', id, 'build activation committed before journal finalization');
          if (isUncertainPackageBuildError(error)) {
            transaction.journalState = await updateJournal(home, journalFor(record, 'build', 'cleanup-required', record.revision, record.revision), transaction.journalState).catch(() => transaction.journalState);
            throw recoveryError(error, home, 'package', id, 'package build termination was uncertain; retained checkout and recovery state');
          }
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


async function inspectManagedGitRecordHealth(record: ManagedGitRecord, environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
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
  kind: ManagedGitResourceKind,
  id: string,
  enteredIdentity: PathFreeManagedGitIdentity,
  requirement?: ManagedGitExactRevisionReuseRequirement
): Promise<ManagedGitLifecycleResult> {
  options = await resolveManagedGitOptions(options);
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
  options = await resolveManagedGitOptions(options);
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
    if (!sameResourceIdentity(currentJournal, transaction.journalState)
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
    await moveDirectory(acquired.root, expectedRoot, acquired.identity);
    published = true;
    transaction.journalState = await updateJournal(home, journalFor(record, addOperation, 'provider-published', null, record.revision, acquired.container), transaction.journalState);
    await options.testHooks?.afterPublishedCheckout?.();
    await inspectManagedGitPublishedCheckout(expectedRoot, acquired.acquisitionPolicy);
    await verifyProvider(record, options.environment ?? process.env);
    if (services !== undefined) await services.writeProviderFile(managedGitRecordPath(home, kind, source.id), encodeManagedGitRecord(record), null);
    else await writeFileAtomic(managedGitRecordPath(home, kind, source.id), encodeManagedGitRecord(record), { managedRoot: home, mode: 0o600, commitOnRename: true });
    recordSnapshot = await readManagedGitRecord(home, kind, source.id);
    transaction.journalState = await updateJournal(home, journalFor(record, addOperation, 'provenance-published', null, record.revision, acquired.container), transaction.journalState);
    let collection: SkillCollectionLifecycleResult | undefined;
    if (kind === 'skill') await addDefaultSkill(home, expectedRoot, { stateLockHeld: true });
    else if (kind === 'library') collection = await addLibrary({ bazframeHome: home, environment: options.environment }, expectedRoot, { stateLockHeld: true });
    else collection = await addPackage(
      { bazframeHome: home, environment: options.environment, childOutputPolicy: options.childOutputPolicy }, expectedRoot,
      {
        stateLockHeld: true,
        afterPackageSnapshot: () => cleanManagedCheckout(record, options.environment ?? process.env, acquired.identity),
        ...managedPackageActivationDependencies(options, record, acquired.identity, requiredAuthorizedManifest(authorizedManifest)),
        ...packageProcessTestDependency(options)
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
    if (isUncertainPackageBuildError(error)) {
      transaction.journalState = await updateJournal(
        home,
        journalFor(record, addOperation, 'cleanup-required', null, record.revision, acquired.container),
        transaction.journalState
      ).catch(() => transaction.journalState);
      throw recoveryError(error, home, kind, source.id, 'package build termination was uncertain; retained checkout, staging, provenance, and recovery state');
    }
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
  options = await resolveManagedGitOptions(options);
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
  options = await resolveManagedGitOptions(options);
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
    await moveDirectory(initial.root, backup, previousIdentity); oldMoved = true;
    await assertIdentity(acquired.root, acquired.identity, 'candidate changed before update publication');
    await moveDirectory(acquired.root, initial.root, acquired.identity); newPublished = true;
    transaction.journalState = await updateJournal(home, journalFor(next, 'update', 'provider-published', initial.revision, next.revision, acquired.container, backup), transaction.journalState);
    await options.testHooks?.afterPublishedCheckout?.();
    await inspectManagedGitPublishedCheckout(initial.root, acquired.acquisitionPolicy);
    await verifyProvider(next, environment);
    if (services !== undefined) await services.writeProviderFile(managedGitRecordPath(home, initial.kind, initial.id), encodeManagedGitRecord(next), { ...initialSnapshot, sha256: initialSnapshot.contentSha256 });
    else await writeFileAtomic(managedGitRecordPath(home, initial.kind, initial.id), encodeManagedGitRecord(next), { managedRoot: home, mode: 0o600, commitOnRename: true });
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
      {
        stateLockHeld: true,
        afterPackageSnapshot: () => cleanManagedCheckout(next, environment, acquired.identity),
        ...managedPackageActivationDependencies(options, next, acquired.identity, requiredAuthorizedManifest(authorizedManifest)),
        ...packageProcessTestDependency(options)
      }
    )).action;
    transaction.resourceCommitted = true;
    await removeOwnedTree(backup, previousIdentity);
    await removeOwnedContainer(acquired.container, acquired.containerIdentity);
    transaction.journalState = await updateJournal(home, journalFor(next, 'update', 'activated', initial.revision, next.revision, null, null), transaction.journalState);
    return { ...lifecycleResult('updated', next), resourceAction };
  } catch (error) {
    if (transaction.resourceCommitted) throw recoveryError(error, home, initial.kind, initial.id, 'updated resource activated before cleanup completed');
    if (isUncertainPackageBuildError(error)) {
      transaction.journalState = await updateJournal(
        home,
        journalFor(next, 'update', 'cleanup-required', initial.revision, next.revision, acquired.container, backup),
        transaction.journalState
      ).catch(() => transaction.journalState);
      throw recoveryError(error, home, initial.kind, initial.id, 'package build termination was uncertain; retained checkout, backup, staging, provenance, and recovery state');
    }
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
  options = await resolveManagedGitOptions(options);
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

function sameJournalSnapshot(left: ManagedGitJournalSnapshot, right: ManagedGitJournalSnapshot): boolean { return sameResourceIdentity(left, right) && left.contentSha256 === right.contentSha256; }

function journalFileIdentity(snapshot: ManagedGitJournalSnapshot): FileIdentity { return { ...snapshot, sha256: snapshot.contentSha256 }; }


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
    const git = await resolveManagedGitCommand(environment, root);
    const gh = source.githubRepository === undefined ? undefined : await resolveManagedGithubCommand(environment, root);
    const authEnvironment = gitEnvironment(environment, false);
    const authStatus = source.githubRepository === undefined || gh === undefined
      ? undefined
      : await runAcquisition(gh, ['auth', 'status', '--hostname', 'github.com'], home, authEnvironment);
    if (authStatus !== undefined && failedManagedGitProcess(authStatus)) throw processFailure('inspect GitHub authentication', gh ?? 'gh', authStatus);
    const githubAuthenticated = authStatus?.status === 0;
    let invocation = managedGitCloneInvocation(source, root, githubAuthenticated);
    const cloneEnvironment = invocation.transport === 'gh' && (services?.platform ?? process.platform) === 'win32'
      ? managedGithubCloneEnvironment(git, authEnvironment, [container])
      : authEnvironment;
    let clone = await runAcquisition(invocation.transport === 'gh' ? gh! : git, invocation.args, home, cloneEnvironment);
    if (failedManagedGitProcess(clone)) throw processFailure('clone', source.remote, clone);
    if (clone.status !== 0 && invocation.transport === 'gh') {
      if (environment.BAZFRAME_STRICT_GIT_ENVIRONMENT === '1') throw processFailure('clone', source.remote, clone);
      await clearPartialClone(container, containerIdentity, root);
      invocation = managedGitCloneInvocation(source, root, false);
      clone = await runAcquisition(git, invocation.args, home, authEnvironment);
    }
    if (clone.status !== 0 || failedManagedGitProcess(clone)) throw processFailure('clone', source.remote, clone);
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
    if (services?.platform === 'win32') await readTreeEvidence(root, revision, git, isolated);
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


async function moveDirectory(source: string, destination: string, expected: ResourceIdentity): Promise<void> {
  if (services !== undefined) return services.moveDirectory(source, destination, expected);
  await assertIdentity(source, expected, 'Managed checkout changed before movement');
  await rename(source, destination);
}
async function physicalDirectory(path: string): Promise<void> {
  if (services !== undefined) return services.physicalDirectory(path);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Expected physical Git directory: ${path}`);
}
async function validateCandidate(kind: ManagedGitResourceKind, root: string, id: string): Promise<void> {
  if (basename(root) !== id) throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Remote Git source ${kind} root basename must be ${id}.`);
  if (kind === 'skill') {
    const declared = await readStableSkillName(join(root, 'SKILL.md'));
    if (declared !== id) throw new BazframeError('SKILL_NAME_MISMATCH', `Remote Git Skill ${id} declares name ${JSON.stringify(declared)}.`);
    return;
  }
  if (kind === 'package') { await readPackageManifest(root); return; }
  try { if (!await pathExists(join(root, 'bazframe-package.json'))) return; throw new BazframeError('LIBRARY_IS_PACKAGE', 'Remote Git library source contains bazframe-package.json; use `bazframe package add` for this repository.'); }
  catch (error) { if (error instanceof BazframeError) throw error; if (errorCode(error) !== 'ENOENT') throw error; }
}


async function authorizeManagedGitPackageBuild(options: ManagedGitOptions, root: string, remote: string, revision: string, managedRoot?: string): Promise<PackageManifestSnapshot> {
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
  environment = resolvedGitEnvironment(environment, await resolveManagedGitCommand(environment, record.root));
  await canonicalManagedGitRoot(record);
  await verifyCheckoutState(record, environment);
}


async function verifyCheckoutState(
  record: Pick<ManagedGitRecord, 'root' | 'remote' | 'fetchUrl' | 'branch' | 'revision'>,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  await physicalDirectory(join(record.root, '.git'));
  const git = await resolveManagedGitCommand(environment, record.root);
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
  if (services?.platform === 'win32') await captureTreeEvidence(record.root, record.revision, git, isolated);
  if (head !== record.revision || branchRevision !== record.revision) throw new BazframeError('MANAGED_GIT_REVISION_MISMATCH', `Bazframe-managed checkout revision changed: ${record.root}`);
}


async function readTreeEvidence(root: string, revision: string, git: string, environment: NodeJS.ProcessEnv): Promise<ManagedGitTreeEvidence> {
  return decodeManagedGitTreeEvidence(await exactOutput(git, repositoryArgs(root, ['ls-tree', '-rz', '--full-tree', revision]), root, environment), 'tree');
}
async function exactOutput(git: string, args: string[], root: string, environment: NodeJS.ProcessEnv): Promise<Uint8Array> {
  const result = await run(git, args, root, environment);
  if (result.status !== 0 || failedManagedGitProcess(result)) throw processFailure('read exact tree/index', git, result);
  if (result.stdoutBytes === undefined) throw new BazframeError('MANAGED_GIT_OUTPUT_INVALID', 'Exact Git byte evidence is required.');
  return result.stdoutBytes;
}
async function captureTreeEvidence(root: string, revision: string, git: string, environment: NodeJS.ProcessEnv): Promise<ManagedGitTreeEvidence> {
  const tree = await readTreeEvidence(root, revision, git, environment);
  const index = decodeManagedGitTreeEvidence(await exactOutput(git, repositoryArgs(root, ['ls-files', '--stage', '-z']), root, environment), 'index');
  assertManagedGitIndexMatchesTree(tree, index);
  services?.recordTreeEvidence(root, tree);
  return tree;
}
async function captureManagedGitTreeEvidence(root: string, revision: string, environment: NodeJS.ProcessEnv = process.env): Promise<ManagedGitTreeEvidence> {
  const before = await directoryIdentity(root);
  const evidence = await captureTreeEvidence(root, revision, await resolveManagedGitCommand(environment, root), gitEnvironment(environment, true));
  await assertIdentity(root, before, 'Git mode source changed'); return evidence;
}
async function captureManagedGitTree(record: ManagedGitRecord, environment: NodeJS.ProcessEnv = process.env): Promise<ManagedGitTreeEvidence> {
  const before = await directoryIdentity(record.root);
  await verifyProvider(record, environment);
  const tree = await captureTreeEvidence(record.root, record.revision, await resolveManagedGitCommand(environment, record.root), gitEnvironment(environment, true));
  await assertIdentity(record.root, before, 'Managed source changed during exact tree capture');
  return tree;
}

async function assertDetachedHead(root: string, git: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const result = await run(git, repositoryArgs(root, ['symbolic-ref', '-q', 'HEAD']), root, environment);
  if (failedManagedGitProcess(result) || (result.status !== 0 && result.status !== 1)) {
    throw processFailure('inspect detached HEAD', git, result);
  }
  if (result.status === 0 || result.stdout !== '' || result.stderr !== '') {
    throw new BazframeError('MANAGED_GIT_REVISION_MISMATCH', `Bazframe-managed checkout HEAD must be detached: ${root}`);
  }
}


async function assertDirectGitReference(root: string, reference: string, git: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const result = await run(git, repositoryArgs(root, ['symbolic-ref', '-q', reference]), root, environment);
  if (failedManagedGitProcess(result) || (result.status !== 0 && result.status !== 1)) {
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
  const git = await resolveManagedGitCommand(environment, record.root);
  const isolated = gitEnvironment(environment, true);
  await assertSafeLocalGitConfiguration(record.root, git, isolated);
  await required(git, repositoryArgs(record.root, ['reset', '--hard', record.revision]), record.root, isolated, 'restore Bazframe-managed package checkout');
  await required(git, repositoryArgs(record.root, ['clean', '-fdx']), record.root, isolated, 'clean Bazframe-managed package checkout');
  await verifyProvider(record, environment);
}


async function assertClean(root: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const git = await resolveManagedGitCommand(environment, root);
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
    await physicalDirectory(expected);
    const canonical = await realpath(expected);
    if (canonical !== expected) {
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


function repositoryArgs(_root: string, args: readonly string[]): string[] { if (services !== undefined) return services.repositoryArgs(_root, args);
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
  const git = await resolveManagedGitCommand(environment, root);
  const isolated = gitEnvironment(environment, true);
  const available = await run(git, repositoryArgs(root, ['rev-parse', '--verify', '--quiet', `${previous}^{commit}`]), root, isolated);
  if (failedManagedGitProcess(available)
    || (available.status !== 0 && !(available.status === 1 && available.stdout === '' && available.stderr === ''))) {
    throw processFailure('resolve prior branch revision', git, available);
  }
  if (available.status === 1) return false;
  if (requiredRevisionOutput(available.stdout, 'prior branch revision') !== previous) {
    throw new BazframeError('MANAGED_GIT_REVISION_MISMATCH', `Recorded prior revision did not resolve exactly: ${previous}`);
  }
  const result = await run(git, repositoryArgs(root, ['merge-base', '--is-ancestor', previous, next]), root, isolated);
  if (failedManagedGitProcess(result) || (result.status !== 0 && result.status !== 1)) {
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


async function assertManagedGitResourceRecoveryAbsent(home: string, kind: ManagedGitResourceKind, id: string): Promise<void> { if (services !== undefined) return services.assertManagedGitResourceRecoveryAbsent(home, kind, id);
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

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return sameResourceIdentity(left, right); }

function recoveryAbsenceError(path: string, cause?: unknown): BazframeError {
  return new BazframeError('MANAGED_GIT_RECOVERY_REQUIRED', `Remote Git recovery for this resource must be absent in a stable physical namespace: ${path}`, cause === undefined ? {} : { cause });
}


const resolvedManagedEnvironments = new WeakSet<object>();

function resolvedGitEnvironment(environment: NodeJS.ProcessEnv, executable: string): NodeJS.ProcessEnv { const result = { ...environment }; if ((services?.platform ?? process.platform) === 'win32') for (const key of Object.keys(result)) if (key.toUpperCase() === 'BAZFRAME_GIT_COMMAND') delete result[key]; result.BAZFRAME_GIT_COMMAND = executable; return result; }
async function resolveManagedGitOptions(options: ManagedGitOptions): Promise<ManagedGitOptions> {
  if (options.environment !== undefined && resolvedManagedEnvironments.has(options.environment)) return options;
  const environment = { ...(options.environment ?? process.env) };
  const selected = await resolveManagedGitCommand(environment, resolve(options.bazframeHome, 'providers'));
  if ((services?.platform ?? process.platform) === 'win32') for (const key of Object.keys(environment)) if (key.toUpperCase() === 'BAZFRAME_GIT_COMMAND') delete environment[key];
  environment.BAZFRAME_GIT_COMMAND = selected;
  resolvedManagedEnvironments.add(environment);
  return { ...options, environment };
}

async function resolveManagedGitCommand(environment: NodeJS.ProcessEnv, excludedRoot: string): Promise<string> { if (services !== undefined) return services.resolveManagedGitCommand(environment, excludedRoot);
  return resolveControlledExecutable(executableEnvironmentValue(environment, 'BAZFRAME_GIT_COMMAND') || 'git', { cwd: process.cwd(), environment, excludedRoots: [excludedRoot] });
}

async function resolveManagedGithubCommand(environment: NodeJS.ProcessEnv, excludedRoot: string): Promise<string | undefined> { if (services !== undefined) return services.resolveManagedGithubCommand(environment, excludedRoot);
  try { return await resolveControlledExecutable(executableEnvironmentValue(environment, 'BAZFRAME_GH_COMMAND') || 'gh', { cwd: process.cwd(), environment, excludedRoots: [excludedRoot] }); }
  catch (error) { if (error instanceof BazframeError && error.code === 'EXECUTABLE_NOT_FOUND') return undefined; throw error; }
}


function gitEnvironment(environment: NodeJS.ProcessEnv, isolated: boolean): NodeJS.ProcessEnv { if (services !== undefined) return services.gitEnvironment(environment, isolated);
  const strict = environment.BAZFRAME_STRICT_GIT_ENVIRONMENT === '1';
  const result: NodeJS.ProcessEnv = strict ? {} : { ...environment };
  if (strict) {
    for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'GH_CONFIG_DIR', 'BAZFRAME_GIT_COMMAND', 'BAZFRAME_GH_COMMAND'] as const) {
      const value = executableEnvironmentValue(environment, key);
      if (value !== undefined) result[key] = value;
    }
    result.HOME = requiredStrictEnvironmentValue(environment, 'BAZFRAME_STRICT_GIT_HOME');
    result.XDG_CONFIG_HOME = requiredStrictEnvironmentValue(environment, 'BAZFRAME_STRICT_GIT_XDG_HOME');
    result.GIT_CONFIG_GLOBAL = requiredStrictEnvironmentValue(environment, 'BAZFRAME_STRICT_GIT_GLOBAL_CONFIG');
    result.GIT_CONFIG_NOSYSTEM = '1';
    result.GIT_TERMINAL_PROMPT = '0';
    result.LANG = 'C';
    result.LC_ALL = 'C';
    result.GIT_CONFIG_COUNT = '4';
    result.GIT_CONFIG_KEY_0 = 'credential.helper'; result.GIT_CONFIG_VALUE_0 = '';
    result.GIT_CONFIG_KEY_1 = 'core.hooksPath'; result.GIT_CONFIG_VALUE_1 = requiredStrictEnvironmentValue(environment, 'BAZFRAME_STRICT_GIT_HOOKS');
    result.GIT_CONFIG_KEY_2 = 'protocol.allow'; result.GIT_CONFIG_VALUE_2 = 'never';
    result.GIT_CONFIG_KEY_3 = 'protocol.https.allow'; result.GIT_CONFIG_VALUE_3 = 'always';
  } else {
    for (const key of Object.keys(result)) {
      if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|CONFIG_PARAMETERS|CEILING_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|SSH|SSH_COMMAND|PROXY_COMMAND|EXEC_PATH|TEMPLATE_DIR|EXTERNAL_DIFF|DIFF_OPTS|PAGER|EDITOR)$/u.test(key)) delete result[key];
    }
    delete result.GIT_CONFIG_GLOBAL;
    delete result.GIT_CONFIG_SYSTEM;
    delete result.GIT_CONFIG_NOSYSTEM;
  }
  result.GIT_OPTIONAL_LOCKS = '0';
  result.GIT_ATTR_NOSYSTEM = '1';
  result.GIT_NO_REPLACE_OBJECTS = '1';
  result.GIT_GRAFT_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
  if (isolated) { result.GIT_CONFIG_NOSYSTEM = '1'; result.GIT_CONFIG_GLOBAL = strict ? result.GIT_CONFIG_GLOBAL : process.platform === 'win32' ? 'NUL' : '/dev/null'; }
  return result;
}

function requiredStrictEnvironmentValue(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) throw new BazframeError('MANAGED_GIT_ENVIRONMENT_INVALID', `Strict Git environment is missing ${key}.`);
  return value;
}

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  monitor?: () => void | Promise<void>
): Promise<ManagedGitProcessResult> {
  const longRunning = args.includes('clone') || args.includes('fetch');
  const result = await (services?.runProcess ?? runManagedGitProcess)(executable, args, cwd, environment, {
    timeoutMilliseconds: longRunning
      ? PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitCloneFetchMilliseconds
      : PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitMetadataMilliseconds,
    terminationGraceMilliseconds: PROFILE_PORTABILITY_PRODUCTION_LIMITS.processTerminationGraceMilliseconds,
    maxStreamBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes
  }, monitor === undefined ? {} : { monitor });
  if ((result.stdoutBytes?.byteLength ?? Buffer.byteLength(result.stdout)) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes || Buffer.byteLength(result.stderr) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes) throw new BazframeError('MANAGED_GIT_OUTPUT_INVALID', 'Managed Git exceeded its bounded output receipt.');
  if (result.stdoutBytes !== undefined && Buffer.from(result.stdoutBytes).toString('utf8') !== result.stdout) throw new BazframeError('MANAGED_GIT_OUTPUT_INVALID', 'Managed Git returned contradictory stdout representations.');
  return result;
}

async function required(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, label: string): Promise<void> { const result = await run(executable, args, cwd, environment); if (result.status !== 0 || failedManagedGitProcess(result)) throw processFailure(label, executable, result); }

async function requiredWithMonitor(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, label: string, monitor: () => void | Promise<void>): Promise<void> { const result = await run(executable, args, cwd, environment, monitor); if (result.status !== 0 || failedManagedGitProcess(result)) throw processFailure(label, executable, result); }

async function requiredOutput(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, label: string): Promise<string> { const result = await run(executable, args, cwd, environment); if (result.status !== 0 || failedManagedGitProcess(result)) throw processFailure(label, executable, result); return result.stdout; }

function processFailure(label: string, target: string, result: ManagedGitProcessResult): ManagedGitProcessError {
  return new ManagedGitProcessError(label, target, result);
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> { if (services !== undefined) return services.directoryIdentity(path); const metadata = await lstat(path, { bigint: true }); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Expected a physical Bazframe-managed directory: ${path}`); return { device: metadata.dev, inode: metadata.ino }; }

async function holdDirectoryIdentity(path: string): Promise<HeldDirectoryIdentity> { if (services !== undefined) return services.holdDirectoryIdentity(path); let handle: FileHandle | undefined; try { handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); const opened = await handle.stat({ bigint: true }); const current = await lstat(path, { bigint: true }); if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || opened.dev !== current.dev || opened.ino !== current.ino) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Expected a stable physical Bazframe-managed directory: ${path}`); return { handle, identity: { device: opened.dev, inode: opened.ino } }; } catch (error) { await handle?.close().catch(() => undefined); throw error; } }

async function assertIdentity(path: string, expected: DirectoryIdentity, message: string): Promise<void> { const current = await directoryIdentity(path); if (!sameResourceIdentity(current, expected)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `${message}: ${path}`); }

async function removeOwnedTree(path: string, expected: DirectoryIdentity): Promise<void> { if (services !== undefined) return services.removeOwnedTree(path, expected); await assertIdentity(path, expected, 'Bazframe-managed directory ownership changed before cleanup'); await rm(path, { recursive: true }); }

async function removeOwnedContainer(path: string, expected: DirectoryIdentity): Promise<void> { if (services !== undefined) return services.removeOwnedContainer(path, expected); const metadata = await lstat(path, { bigint: true }).catch((error) => errorCode(error) === 'ENOENT' ? undefined : Promise.reject(error)); if (metadata === undefined) return; if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.dev !== expected.device || metadata.ino !== expected.inode) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed staging container ownership changed: ${path}`); await rm(path, { recursive: true }); }

async function clearPartialClone(container: string, expected: DirectoryIdentity, root: string): Promise<void> { if (services !== undefined) return services.clearPartialClone(container, expected, root); await assertIdentity(container, expected, 'staging container changed before GitHub fallback'); await rm(root, { recursive: true, force: true }); }


function requiredAuthorizedManifest(manifest: PackageManifestSnapshot | undefined): PackageManifestSnapshot {
  if (manifest === undefined) {
    throw new BazframeError('MANAGED_GIT_BUILD_AUTHORIZATION_MISSING', 'Remote package build is missing its authorized manifest snapshot.');
  }
  return manifest;
}


function managedPackageActivationDependencies(
  options: ManagedGitOptions,
  record: ManagedGitRecord,
  expectedIdentity: DirectoryIdentity,
  expectedManifest: PackageManifestSnapshot
): {
  expectedRootIdentity: ResourceIdentity & { root: string };
  expectedPackageManifest: PackageManifestSnapshot;
  beforePackageBuild: (context: BeforePackageBuildContext) => Promise<void>;
} {
  const revalidateBuildInputs = async (context: BeforePackageBuildContext): Promise<void> => {
    if (context.packageId !== record.id
      || context.rootIdentity.root !== record.root
      || !sameResourceIdentity(context.rootIdentity, expectedIdentity)
      || !samePackageManifestSnapshot(context.manifestSnapshot, expectedManifest)) {
      throw new BazframeError('MANAGED_GIT_CHANGED', `Remote Git package ${record.id} no longer matches its authorized build inputs.`);
    }
    await assertIdentity(record.root, expectedIdentity, 'Bazframe-managed package checkout changed before build');
    await canonicalManagedGitRoot(record);
    await verifyProvider(record, options.environment ?? process.env);
    const currentManifest = await readPackageManifest(record.root);
    if (!samePackageManifestSnapshot(expectedManifest, currentManifest)
      || !samePackageManifestSnapshot(context.manifestSnapshot, currentManifest)) {
      throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package manifest changed after build authorization.');
    }
  };
  return {
    expectedRootIdentity: { root: record.root, ...expectedIdentity },
    expectedPackageManifest: expectedManifest,
    beforePackageBuild: async (context) => {
      await options.testHooks?.beforePackageBuildPreflight?.();
      await revalidateBuildInputs(context);
      await options.beforePackageBuild?.(context);
      await revalidateBuildInputs(context);
      options.onPackageBuildReady?.(context);
    }
  };
}


function packageProcessTestDependency(options: ManagedGitOptions): {
  packageProcessRunner?: (
    executable: string,
    args: readonly string[],
    processOptions: BoundedPackageProcessOptions
  ) => Promise<BoundedPackageProcessResult>;
} {
  if (options.testHooks?.injectUncertainPackageBuildFailure !== true) return {};
  return {
    packageProcessRunner: async () => ({
      exitCode: null,
      signal: null,
      failure: 'termination-uncertain',
      uncertainTermination: true
    })
  };
}


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

async function pathExists(path: string): Promise<boolean> { if (services !== undefined) return services.pathExists(path); try { await lstat(path); return true; } catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; } }

async function createExclusiveFile(home: string, path: string, text: string): Promise<FileIdentity> { if (services !== undefined) return services.createExclusiveFile(home, path, text); await ensureManagedDirectory(home, dirname(path)); let handle: FileHandle | undefined; try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle?.close(); } return physicalFileIdentity(path); }

async function createJournal(home: string, journal: ManagedGitJournal): Promise<FileIdentity> { return createExclusiveFile(home, managedGitJournalPath(home, journal.kind, journal.id), encodeManagedGitJournal(journal)); }

async function updateJournal(home: string, journal: ManagedGitJournal, expected: FileIdentity | undefined): Promise<FileIdentity> { const path = managedGitJournalPath(home, journal.kind, journal.id); if (expected === undefined) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed recovery record ownership is unavailable: ${path}`); const current = await physicalFileIdentity(path); if (!sameFileIdentity(expected, current)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed recovery record changed before update: ${path}`); if (services !== undefined) await services.writeProviderFile(path, encodeManagedGitJournal(journal), expected); else await writeFileAtomic(path, encodeManagedGitJournal(journal), { managedRoot: home, mode: 0o600, commitOnRename: true }); return physicalFileIdentity(path); }

function journalFor(record: ManagedGitRecord, operation: ManagedGitJournal['operation'], phase: string, previousRevision: string | null, nextRevision: string, staging: string | null = null, backup: string | null = null, resourceStateSha256: string | null = null): ManagedGitJournal { return { schemaVersion: 1, operation, phase, kind: record.kind, id: record.id, remote: record.remote, fetchUrl: record.fetchUrl, transport: record.transport, branch: record.branch, previousRevision, nextRevision, root: record.root, staging, backup, resourceStateSha256 }; }

async function physicalFileIdentity(path: string): Promise<FileIdentity> { if (services !== undefined) return services.physicalFileIdentity(path); let handle: FileHandle | undefined; try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = await handle.stat({ bigint: true }); if (!before.isFile()) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Expected a physical Bazframe-managed file: ${path}`); const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const current = await lstat(path, { bigint: true }); if (!after.isFile() || current.isSymbolicLink() || !current.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed file changed while inspected: ${path}`); return { device: before.dev, inode: before.ino, sha256: createHash('sha256').update(bytes).digest('hex') }; } finally { await handle?.close(); } }

async function removeOwnedFile(path: string, expected: FileIdentity): Promise<void> { if (services !== undefined) return services.removeOwnedFile(path, expected); const current = await physicalFileIdentity(path); if (!sameResourceIdentity(current, expected) || current.sha256 !== expected.sha256) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed file ownership changed before removal: ${path}`); await unlink(path); }

async function removeOwnedRecord(home: string, expected: ManagedGitRecordSnapshot): Promise<void> { if (services !== undefined) return services.removeOwnedRecord(home, expected); const current = await readManagedGitRecord(home, expected.record.kind, expected.record.id); if (!sameRecordSnapshot(expected, current)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Remote Git provenance changed before removal: ${expected.path}`); await unlink(expected.path); }

async function restoreOwnedRecord(home: string, expected: ManagedGitRecordSnapshot, replacement: ManagedGitRecord): Promise<void> { if (services !== undefined) return services.restoreOwnedRecord(home, expected, replacement); const current = await readManagedGitRecord(home, expected.record.kind, expected.record.id); if (!sameRecordSnapshot(expected, current)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Remote Git provenance changed before rollback: ${expected.path}`); await writeFileAtomic(expected.path, encodeManagedGitRecord(replacement), { managedRoot: home, mode: 0o600, commitOnRename: true }); }

async function restoreOwnedDirectory(source: string, expected: DirectoryIdentity, destination: string): Promise<void> { if (services !== undefined) return services.restoreOwnedDirectory(source, expected, destination); await assertIdentity(source, expected, 'Bazframe-managed backup ownership changed before rollback'); if (await pathExists(destination)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Bazframe-managed rollback destination became occupied: ${destination}`); await rename(source, destination); }

function sameRecordSnapshot(left: ManagedGitRecordSnapshot, right: ManagedGitRecordSnapshot): boolean { return sameResourceIdentity(left, right) && left.contentSha256 === right.contentSha256; }

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean { return sameResourceIdentity(left, right) && left.sha256 === right.sha256; }

async function readStableSkillName(path: string): Promise<string> { if (services !== undefined) return services.readStableSkillName(path); let handle: FileHandle | undefined; try { try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Remote Git Skill definition must be a physical regular file: ${path}`, { cause: error }); } const before = await handle.stat({ bigint: true }); if (!before.isFile()) throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Remote Git Skill definition must be a physical regular file: ${path}`); const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const current = await lstat(path, { bigint: true }); if (!after.isFile() || current.isSymbolicLink() || !current.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Remote Git Skill definition changed while inspected: ${path}`); let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (error) { throw new BazframeError('INVALID_SKILL_DEFINITION', `Skill definition is not valid UTF-8: ${path}`, { cause: error }); } return parseSkillDeclaredName(text, path); } finally { await handle?.close(); } }

function recoveryError(error: unknown, home: string, kind: ManagedGitResourceKind, id: string, detail: string): ManagedGitRecoveryError {
  return new ManagedGitRecoveryError([error], `Remote Git source ${detail}; inspect ${managedGitJournalPath(home, kind, id)} before continuing.`, error);
}

function title(kind: ManagedGitResourceKind): string { return kind === 'skill' ? 'Skill' : kind === 'library' ? 'Library' : 'Package'; }
return { captureManagedGitTreeEvidence, captureManagedGitTree, managedGitCloneInvocation, addManagedGitSkill, addManagedGitLibrary, addManagedGitPackage, addManagedGitSkillAtRevision, addManagedGitLibraryAtRevision, addManagedGitPackageAtRevision, updateManagedGitSkill, updateManagedGitLibrary, updateManagedGitPackage, removeManagedGitSkill, removeManagedGitLibrary, removeManagedGitPackage, isManagedGitResource, verifyManagedGitResource, captureManagedGitExportHealth, sameManagedGitExportHealth, classifyManagedGitImportOutcome, classifyManagedGitProviderOccupancy, classifyManagedGitImportResource, buildManagedGitPackage, inspectManagedGitRecordHealth, authorizeManagedGitPackageBuild };
}
export const { managedGitCloneInvocation, addManagedGitSkill, addManagedGitLibrary, addManagedGitPackage, addManagedGitSkillAtRevision, addManagedGitLibraryAtRevision, addManagedGitPackageAtRevision, updateManagedGitSkill, updateManagedGitLibrary, updateManagedGitPackage, removeManagedGitSkill, removeManagedGitLibrary, removeManagedGitPackage, isManagedGitResource, verifyManagedGitResource, captureManagedGitExportHealth, sameManagedGitExportHealth, classifyManagedGitImportOutcome, classifyManagedGitProviderOccupancy, classifyManagedGitImportResource, buildManagedGitPackage, inspectManagedGitRecordHealth, authorizeManagedGitPackageBuild } = createManagedGitProvider();
