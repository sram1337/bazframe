import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { replaceUnsafeDisplayCharacters } from '../core/safe-text.js';
import { readPackageManifest, samePackageManifestSnapshot, type PackageManifestSnapshot } from '../packages/package-manifest.js';
import {
  addDefaultSkill, defaultSkillCatalogRoot, readDefaultSkillRegistration, removeDefaultSkill
} from '../skills/default-skill-catalog.js';
import { assertSafeSkillId } from '../skills/skill-id.js';
import { parseSkillDeclaredName } from '../skills/skill-metadata.js';
import {
  addLibrary, addPackage, buildPackage, removeLibrary, removePackage, updateLibrary,
  type SkillCollectionLifecycleResult
} from '../skill-collections/skill-collection-lifecycle.js';
import {
  globalCollectionPath, readLibrary, readLibrarySnapshot, readPackage, readPackageSnapshot
} from '../skill-collections/skill-collection-store.js';
import { verifySkillSnapshot } from '../skill-collections/skill-snapshot.js';
import { ensureManagedDirectory, writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import {
  assertValidManagedGitBranch, assertValidManagedGitRevision, canonicalManagedGitRoot,
  decodeManagedGitRecord, encodeManagedGitJournal, encodeManagedGitRecord, managedGitCheckoutRoot,
  managedGitJournalPath, managedGitRecordPath, managedGitRecoveryRoot, managedGitStagingRoot,
  optionalManagedGitRecord, optionalManagedGitRecordInExistingNamespace, readManagedGitJournal, readManagedGitRecord, type ManagedGitJournal, type ManagedGitJournalSnapshot,
  type ManagedGitRecord, type ManagedGitRecordSnapshot, type ManagedGitResourceKind
} from './managed-git-record.js';

export interface ManagedGitSource {
  entered: string;
  remote: string;
  fetchUrl: string;
  id: string;
  githubRepository?: string;
}
export interface ManagedGitBuildAuthorization {
  remote: string;
  revision: string;
  root: string;
  build: readonly string[];
}
export interface ManagedGitOptions {
  bazframeHome: string;
  environment?: NodeJS.ProcessEnv;
  yes?: boolean;
  acceptRewrite?: boolean;
  reportPackageBuild?: (details: ManagedGitBuildAuthorization) => void | Promise<void>;
  confirmPackageBuild?: (details: ManagedGitBuildAuthorization) => boolean | Promise<boolean>;
  /** Internal deterministic fault-injection seams used only by lifecycle tests. */
  testHooks?: { afterRemoveResource?: () => void | Promise<void> };
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
interface AcquiredRepository {
  container: string;
  containerIdentity: DirectoryIdentity;
  root: string;
  identity: DirectoryIdentity;
  source: ManagedGitSource;
  branch: string;
  revision: string;
  transport: 'git' | 'gh';
}
interface DirectoryIdentity { device: bigint; inode: bigint }
interface HeldDirectoryIdentity { handle: FileHandle; identity: DirectoryIdentity }
interface FileIdentity { device: bigint; inode: bigint; sha256: string }
interface ProcessResult { status: number | null; stdout: string; stderr: string; error?: Error }
interface TransactionState { resourceCommitted: boolean; journalState?: FileIdentity }
export interface ManagedGitCloneInvocation { transport: 'gh' | 'git'; args: readonly string[] }

const LOCAL_CONFIG_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'remote.origin.url',
  'remote.origin.fetch', 'extensions.objectformat', 'extensions.refstorage'
]);

export function managedGitCloneInvocation(source: ManagedGitSource, root: string, githubAuthenticated: boolean): ManagedGitCloneInvocation {
  return source.githubRepository !== undefined && githubAuthenticated
    ? { transport: 'gh', args: ['repo', 'clone', source.githubRepository, root, '--', '--no-checkout', '--template='] }
    : {
        transport: 'git',
        args: [
          '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never',
          'clone', '--no-checkout', '--template=', '--origin', 'origin', source.fetchUrl, root
        ]
      };
}

export function parseManagedGitSource(value: string): ManagedGitSource {
  if (value.length === 0 || value.includes('\u0000') || value.startsWith('-')) throw invalidSource('source is empty, option-shaped, or contains NUL');
  if (value.startsWith('git:')) {
    const repository = value.slice(4);
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)$/u.exec(repository);
    if (match === null) throw invalidSource('GitHub shorthand must be git:<owner>/<repository> with a Bazframe-safe repository name');
    const owner = match[1]!.toLowerCase();
    const id = match[2]!.toLowerCase();
    assertSafeSkillId(id);
    return { entered: value, remote: `github.com/${owner}/${id}`, fetchUrl: `https://github.com/${owner}/${id}.git`, id, githubRepository: `${owner}/${id}` };
  }
  if (/^[^/\s@]+@[^:]+:/u.test(value) || value.startsWith('file:')) throw invalidSource('use an HTTPS or ssh:// URL');
  let url: URL;
  try { url = new URL(value); } catch { throw invalidSource('use git:<owner>/<repository>, HTTPS, or ssh://'); }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') throw invalidSource('URL protocol must be HTTPS or ssh');
  if (url.password !== '' || (url.protocol === 'https:' && url.username !== '')) throw invalidSource('URL must not contain credentials');
  if (url.protocol === 'ssh:' && url.username !== '' && url.username !== 'git') throw invalidSource('ssh:// username must be git when present');
  if (url.search !== '' || url.hash !== '') throw invalidSource('URL query strings and fragments are not supported');
  if (url.hostname.length === 0 || url.pathname.length < 2 || url.pathname.includes('..') || url.pathname.includes('%')) throw invalidSource('URL host or repository path is invalid');
  const segments = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  if (segments.length < 2 || segments.some((segment) => segment.length === 0 || !/^[A-Za-z0-9._~-]+$/u.test(segment))) throw invalidSource('URL must identify an owner and repository using portable path segments');
  let rawId = segments.at(-1)!.replace(/\.git$/u, '');
  if (url.hostname.toLowerCase() === 'github.com') {
    segments[0] = segments[0]!.toLowerCase();
    rawId = rawId.toLowerCase();
  }
  assertSafeSkillId(rawId);
  segments[segments.length - 1] = rawId;
  const port = url.port === '' ? '' : `:${url.port}`;
  const remote = `${url.hostname.toLowerCase()}${port}/${segments.join('/')}`;
  const username = url.protocol === 'ssh:' && url.username !== '' ? `${url.username}@` : '';
  const fetchUrl = `${url.protocol}//${username}${url.host.toLowerCase()}/${segments.join('/')}.git`;
  return { entered: value, remote, fetchUrl, id: rawId };
}

export function normalizeManagedGitOrigin(value: string): ManagedGitSource {
  const scp = /^git@([^/:\s]+):(.+)$/u.exec(value);
  return scp === null ? parseManagedGitSource(value) : parseManagedGitSource(`ssh://git@${scp[1]}/${scp[2]}`);
}
export function isManagedGitSource(value: string): boolean {
  return value.startsWith('git:') || value.startsWith('https://') || value.startsWith('ssh://')
    || value.startsWith('file:') || /^[^/\s@]+@[^:]+:/u.test(value);
}

export async function addManagedGitSkill(options: ManagedGitOptions, entered: string): Promise<ManagedGitLifecycleResult> { return addManaged(options, 'skill', parseManagedGitSource(entered)); }
export async function addManagedGitLibrary(options: ManagedGitOptions, entered: string): Promise<ManagedGitLifecycleResult> { return addManaged(options, 'library', parseManagedGitSource(entered)); }
export async function addManagedGitPackage(options: ManagedGitOptions, entered: string): Promise<ManagedGitLifecycleResult> { return addManaged(options, 'package', parseManagedGitSource(entered)); }
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

export async function buildManagedGitPackage(options: ManagedGitOptions, id: string): Promise<SkillCollectionLifecycleResult> {
  assertSafeSkillId(id);
  const home = await canonicalManagedHome(options.bazframeHome);
  await assertNoRecovery(home, 'package', id);
  const transaction: TransactionState = { resourceCommitted: false };
  let result: SkillCollectionLifecycleResult;
  try {
    result = await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: 'bazframe packages build', target: managedGitCheckoutRoot(home, 'package', id) },
      async () => {
        const snapshot = await readManagedGitRecord(home, 'package', id);
        const record = snapshot.record;
        await verifyProvider(record, options.environment ?? process.env);
        await verifyResourceRegistration(record);
        const rootIdentity = await directoryIdentity(record.root);
        transaction.journalState = await createJournal(home, journalFor(record, 'build', 'building', record.revision, record.revision));
        try {
          const built = await buildPackage(
            { bazframeHome: home, environment: options.environment },
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
            throw new AggregateError([error, cleanupError], `Managed package build failed and checkout cleanup could not be proven; inspect ${managedGitJournalPath(home, 'package', id)}.`, { cause: cleanupError });
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

async function addManaged(options: ManagedGitOptions, kind: ManagedGitResourceKind, source: ManagedGitSource): Promise<ManagedGitLifecycleResult> {
  const home = await canonicalManagedHome(options.bazframeHome);
  const expectedRoot = managedGitCheckoutRoot(home, kind, source.id);
  const existing = await optionalManagedGitRecord(home, kind, source.id);
  if (existing !== undefined) {
    return await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${kind === 'skill' ? 'add skill' : kind === 'library' ? 'libraries add' : 'packages add'}`, target: expectedRoot },
      async () => {
        const current = await readManagedGitRecord(home, kind, source.id);
        if (!sameRecordSnapshot(existing, current)) throw new BazframeError('MANAGED_GIT_CHANGED', `Managed Git provenance changed while verifying current ${kind} ${source.id}.`);
        if (current.record.remote !== source.remote || current.record.fetchUrl !== source.fetchUrl || current.record.root !== expectedRoot) throw new BazframeError('MANAGED_GIT_IDENTITY_MISMATCH', `Managed ${kind} ${source.id} is already bound to ${current.record.remote}.`);
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
  const acquired = await acquireRepository(home, source, options.environment ?? process.env);
  let authorizedManifest: PackageManifestSnapshot | undefined;
  try {
    await validateCandidate(kind, acquired.root, source.id);
    if (kind === 'package') authorizedManifest = await authorizeManagedGitPackageBuild(options, acquired.root, source.remote, acquired.revision, expectedRoot);
  } catch (error) {
    await removeOwnedContainer(acquired.container, acquired.containerIdentity).catch((cleanupError) => { throw new AggregateError([error, cleanupError], `Managed Git validation failed and staging cleanup could not be proven at ${acquired.container}.`, { cause: cleanupError }); });
    throw error;
  }
  const transaction: TransactionState = { resourceCommitted: false };
  let result: ManagedGitLifecycleResult;
  try {
    result = await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${kind === 'skill' ? 'add skill' : kind === 'library' ? 'libraries add' : 'packages add'}`, target: expectedRoot },
      () => commitAdd(options, home, kind, source, acquired, authorizedManifest, transaction),
      { managedRoot: home }
    );
  } catch (error) {
    return await throwAfterAcquiredTransactionFailure(
      error, transaction, acquired, home, kind, source.id,
      'resource activation committed before lock release completed',
      'Managed Git add failed before its transaction started and staging cleanup could not be proven'
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
  await assertNoRecovery(home, kind, source.id);
  if (await optionalManagedGitRecord(home, kind, source.id) !== undefined) throw new BazframeError('MANAGED_GIT_DESTINATION_OCCUPIED', `Managed Git provenance became occupied: ${source.id}`);
  await assertResourceAvailableForAdd(home, kind, source.id, expectedRoot);
  const record = makeRecord(kind, source, expectedRoot, acquired.branch, acquired.revision, acquired.transport);
  let published = false;
  let recordSnapshot: ManagedGitRecordSnapshot | undefined;
  transaction.journalState = await createJournal(home, journalFor(record, 'add', 'staged', null, record.revision, acquired.container));
  try {
    await ensureManagedDirectory(home, dirname(expectedRoot));
    await assertIdentity(acquired.root, acquired.identity, 'acquired repository changed before publication');
    await rename(acquired.root, expectedRoot);
    published = true;
    transaction.journalState = await updateJournal(home, journalFor(record, 'add', 'provider-published', null, record.revision, acquired.container), transaction.journalState);
    await verifyProvider(record, options.environment ?? process.env);
    await writeFileAtomic(managedGitRecordPath(home, kind, source.id), encodeManagedGitRecord(record), { managedRoot: home, mode: 0o600, commitOnRename: true });
    recordSnapshot = await readManagedGitRecord(home, kind, source.id);
    transaction.journalState = await updateJournal(home, journalFor(record, 'add', 'provenance-published', null, record.revision, acquired.container), transaction.journalState);
    let collection: SkillCollectionLifecycleResult | undefined;
    if (kind === 'skill') await addDefaultSkill(home, expectedRoot, { stateLockHeld: true });
    else if (kind === 'library') collection = await addLibrary({ bazframeHome: home, environment: options.environment }, expectedRoot, { stateLockHeld: true });
    else collection = await addPackage(
      { bazframeHome: home, environment: options.environment }, expectedRoot,
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
    transaction.journalState = await updateJournal(home, journalFor(record, 'add', 'activated', null, record.revision, null), transaction.journalState);
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
    if (recovery.length > 0) throw new AggregateError([error, ...recovery], `Managed Git add stopped with recovery state for ${kind} ${source.id}; inspect ${managedGitJournalPath(home, kind, source.id)}.`, { cause: error });
    throw error;
  }
}

async function updateManaged(options: ManagedGitOptions, kind: ManagedGitResourceKind, id: string): Promise<ManagedGitLifecycleResult> {
  assertSafeSkillId(id);
  const home = await canonicalManagedHome(options.bazframeHome);
  await assertNoRecovery(home, kind, id);
  const initial = await optionalManagedGitRecord(home, kind, id);
  if (initial === undefined) throw new BazframeError('MANAGED_GIT_NOT_FOUND', `${title(kind)} ${id} is not a managed Git provider.`);
  await verifyProvider(initial.record, options.environment ?? process.env);
  await verifyResourceRegistration(initial.record);
  const source: ManagedGitSource = {
    entered: initial.record.fetchUrl, remote: initial.record.remote, fetchUrl: initial.record.fetchUrl, id,
    ...(initial.record.transport === 'gh' ? { githubRepository: initial.record.remote.slice('github.com/'.length) } : {})
  };
  const acquired = await acquireRepository(home, source, options.environment ?? process.env, initial.record.branch);
  let authorizedManifest: PackageManifestSnapshot | undefined;
  try {
    if (acquired.branch !== initial.record.branch || acquired.source.remote !== initial.record.remote) throw new BazframeError('MANAGED_GIT_IDENTITY_MISMATCH', `Managed Git update changed remote or branch identity for ${kind} ${id}.`);
    if (acquired.revision === initial.record.revision) return await verifyCurrentUpdate(options, home, initial, acquired);
    if (options.acceptRewrite !== true && !isAncestor(acquired.root, initial.record.revision, acquired.revision, options.environment ?? process.env)) throw new BazframeError('MANAGED_GIT_NON_FAST_FORWARD', `Recorded branch ${initial.record.branch} no longer advances from ${initial.record.revision}. Retry with --accept-rewrite after reviewing the remote history.`);
    await validateCandidate(kind, acquired.root, id);
    if (kind === 'package') authorizedManifest = await authorizeManagedGitPackageBuild(options, acquired.root, initial.record.remote, acquired.revision, initial.record.root);
  } catch (error) {
    await removeOwnedContainer(acquired.container, acquired.containerIdentity).catch((cleanupError) => { throw new AggregateError([error, cleanupError], `Managed Git update failed and staging cleanup could not be proven at ${acquired.container}.`, { cause: cleanupError }); });
    throw error;
  }
  const transaction: TransactionState = { resourceCommitted: false };
  let result: ManagedGitLifecycleResult;
  try {
    result = await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${kind === 'skill' ? 'skill' : kind === 'library' ? 'libraries' : 'packages'} update`, target: initial.record.root },
      () => commitUpdate(options, initial, acquired, authorizedManifest, transaction),
      { managedRoot: home }
    );
  } catch (error) {
    return await throwAfterAcquiredTransactionFailure(
      error, transaction, acquired, home, kind, id,
      'updated resource committed before lock release completed',
      'Managed Git update failed before its transaction started and staging cleanup could not be proven'
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
    { command: `bazframe ${initial.record.kind === 'skill' ? 'skill' : initial.record.kind === 'library' ? 'libraries' : 'packages'} update`, target: initial.record.root },
    async () => {
      const current = await readManagedGitRecord(home, initial.record.kind, initial.record.id);
      if (!sameRecordSnapshot(initial, current)) throw new BazframeError('MANAGED_GIT_CHANGED', `Managed Git provenance changed while verifying current ${initial.record.kind} ${initial.record.id}.`);
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
  if (!sameRecordSnapshot(initialSnapshot, current)) throw new BazframeError('MANAGED_GIT_CHANGED', `Managed Git provenance changed during update for ${initial.kind} ${initial.id}.`);
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
      { bazframeHome: home, environment }, initial.id,
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
    if (recoveryErrors.length > 0) throw new AggregateError([error, ...recoveryErrors], `Managed Git update could not prove complete recovery for ${initial.kind} ${initial.id}; inspect ${managedGitJournalPath(home, initial.kind, initial.id)}.`, { cause: error });
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
  if (initial === undefined) throw new BazframeError('MANAGED_GIT_NOT_FOUND', `${title(kind)} ${id} is not a managed Git provider.`);
  await verifyProvider(initial.record, options.environment ?? process.env);
  await verifyResourceRegistration(initial.record);
  const transaction: TransactionState = { resourceCommitted: false };
  let result: ManagedGitLifecycleResult;
  try {
    result = await withStateLock(
      join(home, 'locks', 'state.lock'),
      { command: `bazframe ${kind === 'skill' ? 'remove skill' : kind === 'library' ? 'libraries remove' : 'packages remove'}`, target: initial.record.root },
      async () => {
        const current = await readManagedGitRecord(home, kind, id);
        if (!sameRecordSnapshot(initial, current)) throw new BazframeError('MANAGED_GIT_CHANGED', `Managed Git provenance changed during removal for ${kind} ${id}.`);
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
    if (transaction.resourceCommitted && transaction.journalState !== undefined) throw recoveryError(error, home, kind, id, 'resource record was removed before managed checkout cleanup completed');
    if (!transaction.resourceCommitted && transaction.journalState !== undefined) {
      try {
        await removeOwnedFile(managedGitJournalPath(home, kind, id), transaction.journalState);
        transaction.journalState = undefined;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Managed Git removal failed and journal cleanup could not be proven; inspect ${managedGitJournalPath(home, kind, id)}.`, { cause: cleanupError });
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
      { command: `bazframe ${record.kind === 'skill' ? 'remove skill' : record.kind === 'library' ? 'libraries remove' : 'packages remove'}`, target: record.root },
      async () => {
        const currentJournal = await readManagedGitJournal(home, record.kind, record.id);
        if (!sameJournalSnapshot(initialJournal, currentJournal)) throw new BazframeError('MANAGED_GIT_CHANGED', `Managed Git recovery record changed during removal for ${record.kind} ${record.id}.`);
        const resourcePath = record.kind === 'skill' ? join(defaultSkillCatalogRoot(home), record.id) : globalCollectionPath(home, record.kind, record.id);
        let resourceAction = 'absent';
        if (await pathExists(resourcePath)) {
          if (!await pathExists(record.root)) throw new BazframeError('MANAGED_GIT_RECOVERY_REQUIRED', `Managed ${record.kind} registration remains but its provider root is absent: ${record.root}`);
          await verifyProvider(record, options.environment ?? process.env);
          await verifyResourceRegistration(record);
          const currentResourceState = await managedResourceStateSha256(home, record);
          if (currentResourceState !== initialJournal.journal.resourceStateSha256) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed ${record.kind} registration changed before removal recovery: ${resourcePath}`);
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
          if (!sameManagedGitRecord(provenance.record, record)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed provenance changed before removal recovery: ${provenance.path}`);
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
  if (journal.operation !== 'remove' || journal.resourceStateSha256 === null) throw new BazframeError('MANAGED_GIT_JOURNAL_INVALID', 'Managed Git removal recovery record is incomplete.');
  return decodeManagedGitRecord({ schemaVersion: 1, kind: journal.kind, id: journal.id, root: journal.root, remote: journal.remote, fetchUrl: journal.fetchUrl, transport: journal.transport, branch: journal.branch, revision: journal.nextRevision });
}
function sameManagedGitRecord(left: ManagedGitRecord, right: ManagedGitRecord): boolean { return encodeManagedGitRecord(left) === encodeManagedGitRecord(right); }
function sameJournalSnapshot(left: ManagedGitJournalSnapshot, right: ManagedGitJournalSnapshot): boolean { return left.device === right.device && left.inode === right.inode && left.contentSha256 === right.contentSha256; }
function journalFileIdentity(snapshot: ManagedGitJournalSnapshot): FileIdentity { return { device: snapshot.device, inode: snapshot.inode, sha256: snapshot.contentSha256 }; }

async function acquireRepository(home: string, source: ManagedGitSource, environment: NodeJS.ProcessEnv, recordedBranch?: string): Promise<AcquiredRepository> {
  await ensureManagedDirectory(home, managedGitStagingRoot(home));
  const container = await mkdtemp(join(managedGitStagingRoot(home), 'acquire-'));
  const containerIdentity = await directoryIdentity(container);
  const root = join(container, source.id);
  try {
    const git = environment.BAZFRAME_GIT_COMMAND || 'git';
    const gh = environment.BAZFRAME_GH_COMMAND || 'gh';
    const authEnvironment = gitEnvironment(environment, false);
    const githubAuthenticated = source.githubRepository !== undefined && run(gh, ['auth', 'status', '--hostname', 'github.com'], home, authEnvironment).status === 0;
    let invocation = managedGitCloneInvocation(source, root, githubAuthenticated);
    let clone = run(invocation.transport === 'gh' ? gh : git, invocation.args, home, authEnvironment);
    if (clone.status !== 0 && invocation.transport === 'gh') {
      await clearPartialClone(container, containerIdentity, root);
      invocation = managedGitCloneInvocation(source, root, false);
      clone = run(git, invocation.args, home, authEnvironment);
    }
    if (clone.status !== 0) throw processFailure('clone', source.remote, clone);
    const isolated = gitEnvironment(environment, true);
    await assertSafeLocalGitConfiguration(root, git, isolated);
    const rawOrigin = requiredOutput(git, repositoryArgs(root, ['config', '--local', '--no-includes', '--get', 'remote.origin.url']), root, isolated, 'read origin URL').trim();
    const actual = normalizeManagedGitOrigin(rawOrigin);
    if (actual.remote !== source.remote) throw new BazframeError('MANAGED_GIT_IDENTITY_MISMATCH', `Cloned origin ${actual.remote} does not match requested remote ${source.remote}.`);
    let branch = recordedBranch;
    if (branch === undefined) {
      const symbolic = requiredOutput(git, repositoryArgs(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']), root, isolated, 'read default branch').trim();
      if (!symbolic.startsWith('origin/')) throw new BazframeError('MANAGED_GIT_BRANCH_INVALID', `Remote default branch is unavailable for ${source.remote}.`);
      branch = symbolic.slice('origin/'.length);
    }
    assertValidManagedGitBranch(branch);
    const revision = requiredOutput(git, repositoryArgs(root, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]), root, isolated, 'resolve revision').trim();
    assertValidManagedGitRevision(revision);
    required(git, repositoryArgs(root, ['checkout', '--detach', revision]), root, isolated, 'materialize revision');
    const identity = await directoryIdentity(root);
    await assertClean(root, environment);
    return { container, containerIdentity, root, identity, source, branch, revision, transport: invocation.transport };
  } catch (error) {
    try { await removeOwnedContainer(container, containerIdentity); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Managed Git acquisition failed and staging cleanup could not be proven at ${container}.`, { cause: cleanupError }); }
    throw error;
  }
}

async function validateCandidate(kind: ManagedGitResourceKind, root: string, id: string): Promise<void> {
  if (basename(root) !== id) throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Managed ${kind} root basename must be ${id}.`);
  if (kind === 'skill') {
    const declared = await readStableSkillName(join(root, 'SKILL.md'));
    if (declared !== id) throw new BazframeError('SKILL_NAME_MISMATCH', `Managed Skill ${id} declares name ${JSON.stringify(declared)}.`);
    return;
  }
  if (kind === 'package') { await readPackageManifest(root); return; }
  try { await lstat(join(root, 'bazframe-package.json')); throw new BazframeError('LIBRARY_IS_PACKAGE', 'Managed library contains bazframe-package.json; use `bazframe packages add` for this repository.'); }
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
  const gitMetadata = await lstat(join(record.root, '.git'));
  if (gitMetadata.isSymbolicLink() || !gitMetadata.isDirectory()) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Managed provider .git must be a physical directory: ${record.root}`);
  const git = environment.BAZFRAME_GIT_COMMAND || 'git';
  const isolated = gitEnvironment(environment, true);
  await assertSafeLocalGitConfiguration(record.root, git, isolated);
  await assertClean(record.root, environment);
  const origin = normalizeManagedGitOrigin(requiredOutput(git, repositoryArgs(record.root, ['config', '--local', '--no-includes', '--get', 'remote.origin.url']), record.root, isolated, 'read origin URL').trim());
  if (origin.remote !== record.remote) throw new BazframeError('MANAGED_GIT_IDENTITY_MISMATCH', `Managed provider origin changed: ${record.root}`);
  const head = requiredOutput(git, repositoryArgs(record.root, ['rev-parse', '--verify', 'HEAD^{commit}']), record.root, isolated, 'read provider revision').trim();
  const branchRevision = requiredOutput(git, repositoryArgs(record.root, ['rev-parse', '--verify', `refs/remotes/origin/${record.branch}^{commit}`]), record.root, isolated, 'read recorded branch').trim();
  if (head !== record.revision || branchRevision !== record.revision) throw new BazframeError('MANAGED_GIT_REVISION_MISMATCH', `Managed provider revision changed: ${record.root}`);
}

async function verifyResourceRegistration(record: ManagedGitRecord): Promise<void> {
  const home = resolveHome(record.root);
  if (record.kind === 'skill') {
    const registration = await readDefaultSkillRegistration(home, record.id);
    if (registration.target !== record.root) throw new BazframeError('MANAGED_GIT_REGISTRATION_MISMATCH', `Added Skill registration does not match managed provider: ${record.id}`);
    return;
  }
  const resource = record.kind === 'library' ? await readLibrary(home, record.id) : await readPackage(home, record.id);
  if (resource.root !== record.root) throw new BazframeError('MANAGED_GIT_REGISTRATION_MISMATCH', `Global ${record.kind} does not match managed provider: ${record.id}`);
  await verifySkillSnapshot(home, resource.digest);
}

async function assertResourceAvailableForAdd(home: string, kind: ManagedGitResourceKind, id: string, expectedRoot: string): Promise<void> {
  if (await pathExists(expectedRoot)) throw new BazframeError('MANAGED_GIT_DESTINATION_OCCUPIED', `Managed Git provider destination is occupied without matching provenance: ${expectedRoot}`);
  const path = kind === 'skill' ? join(defaultSkillCatalogRoot(home), id) : globalCollectionPath(home, kind, id);
  if (await pathExists(path)) throw new BazframeError('MANAGED_GIT_DESTINATION_OCCUPIED', `${title(kind)} ${id} is already registered at ${path}.`);
}

async function cleanManagedCheckout(record: ManagedGitRecord, environment: NodeJS.ProcessEnv, expectedIdentity: DirectoryIdentity): Promise<void> {
  await assertIdentity(record.root, expectedIdentity, 'managed package checkout changed before cleanup');
  const git = environment.BAZFRAME_GIT_COMMAND || 'git';
  const isolated = gitEnvironment(environment, true);
  await assertSafeLocalGitConfiguration(record.root, git, isolated);
  required(git, repositoryArgs(record.root, ['reset', '--hard', record.revision]), record.root, isolated, 'restore managed package checkout');
  required(git, repositoryArgs(record.root, ['clean', '-fdx']), record.root, isolated, 'clean managed package checkout');
  await verifyProvider(record, environment);
}

async function assertClean(root: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const git = environment.BAZFRAME_GIT_COMMAND || 'git';
  const isolated = gitEnvironment(environment, true);
  await assertSafeLocalGitConfiguration(root, git, isolated);
  const output = requiredOutput(git, repositoryArgs(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']), root, isolated, 'inspect provider state');
  if (output !== '') throw new BazframeError('MANAGED_GIT_DIRTY', `Managed Git provider has local changes, including ignored additions: ${root}`);
}

async function assertSafeLocalGitConfiguration(root: string, git: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const output = requiredOutput(git, repositoryArgs(root, ['config', '--local', '--no-includes', '--null', '--list']), root, environment, 'inspect local configuration');
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
    throw new BazframeError('MANAGED_GIT_CONFIG_UNSAFE', `Managed provider local Git configuration contains unsupported key ${JSON.stringify(key)}: ${root}`);
  }
}

function repositoryArgs(root: string, args: readonly string[]): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${join(root, '.git', 'bazframe-hooks-disabled')}`, ...args];
}
function isAncestor(root: string, previous: string, next: string, environment: NodeJS.ProcessEnv): boolean {
  return run(environment.BAZFRAME_GIT_COMMAND || 'git', repositoryArgs(root, ['merge-base', '--is-ancestor', previous, next]), root, gitEnvironment(environment, true)).status === 0;
}

function makeRecord(kind: ManagedGitResourceKind, source: ManagedGitSource, root: string, branch: string, revision: string, transport: 'git' | 'gh'): ManagedGitRecord {
  return decodeManagedGitRecord({ schemaVersion: 1, kind, id: source.id, root, remote: source.remote, fetchUrl: source.fetchUrl, transport, branch, revision });
}
function lifecycleResult(action: ManagedGitLifecycleResult['action'], record: ManagedGitRecord): ManagedGitLifecycleResult { return { action, kind: record.kind, id: record.id, root: record.root, remote: record.remote, branch: record.branch, revision: record.revision }; }
function resolveHome(root: string): string { const marker = join('providers', 'git', 'checkouts'); const index = root.lastIndexOf(marker); if (index <= 0) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Managed Git provider root is outside its managed namespace: ${root}`); return root.slice(0, index - 1); }
async function canonicalManagedHome(entered: string): Promise<string> { const absolute = resolve(entered); await ensureManagedDirectory(absolute, absolute); return realpath(absolute); }
async function assertNoRecovery(home: string, kind: ManagedGitResourceKind, id: string): Promise<void> { const path = managedGitJournalPath(home, kind, id); if (await pathExists(path)) throw new BazframeError('MANAGED_GIT_RECOVERY_REQUIRED', `Inspect managed Git recovery state before continuing: ${path}`); }

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
  if (isolated) { result.GIT_CONFIG_NOSYSTEM = '1'; result.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'; }
  return result;
}
function run(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): ProcessResult { const result = spawnSync(executable, [...args], { cwd, env: environment, encoding: 'utf8', shell: false, stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }); return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error === undefined ? {} : { error: result.error }) }; }
function required(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, label: string): void { const result = run(executable, args, cwd, environment); if (result.status !== 0) throw processFailure(label, executable, result); }
function requiredOutput(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, label: string): string { const result = run(executable, args, cwd, environment); if (result.status !== 0) throw processFailure(label, executable, result); return result.stdout; }
function processFailure(label: string, target: string, result: ProcessResult): BazframeError { const diagnostic = safeDiagnostic(result.stderr || result.error?.message || `status ${result.status ?? 1}`); return new BazframeError('MANAGED_GIT_PROCESS_FAILED', `Git ${label} failed for ${target}: ${diagnostic}`); }
export function safeDiagnostic(value: string): string {
  let redacted = value.replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[redacted]@').replace(/\b(authorization|token|access[_-]?token|oauth[_-]?token|password)\s*[:=]\s*[^\s]+/giu, '$1=[redacted]');
  redacted = replaceUnsafeDisplayCharacters(redacted, ' ').replace(/\s+/gu, ' ').trim();
  return redacted.slice(0, 1000);
}
async function directoryIdentity(path: string): Promise<DirectoryIdentity> { const metadata = await lstat(path, { bigint: true }); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Expected a physical managed directory: ${path}`); return { device: metadata.dev, inode: metadata.ino }; }
async function holdDirectoryIdentity(path: string): Promise<HeldDirectoryIdentity> { let handle: FileHandle | undefined; try { handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); const opened = await handle.stat({ bigint: true }); const current = await lstat(path, { bigint: true }); if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || opened.dev !== current.dev || opened.ino !== current.ino) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Expected a stable physical managed directory: ${path}`); return { handle, identity: { device: opened.dev, inode: opened.ino } }; } catch (error) { await handle?.close().catch(() => undefined); throw error; } }
async function assertIdentity(path: string, expected: DirectoryIdentity, message: string): Promise<void> { const current = await directoryIdentity(path); if (current.device !== expected.device || current.inode !== expected.inode) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `${message}: ${path}`); }
async function removeOwnedTree(path: string, expected: DirectoryIdentity): Promise<void> { await assertIdentity(path, expected, 'managed directory ownership changed before cleanup'); await rm(path, { recursive: true }); }
async function removeOwnedContainer(path: string, expected: DirectoryIdentity): Promise<void> { const metadata = await lstat(path, { bigint: true }).catch((error) => errorCode(error) === 'ENOENT' ? undefined : Promise.reject(error)); if (metadata === undefined) return; if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.dev !== expected.device || metadata.ino !== expected.inode) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed staging container ownership changed: ${path}`); await rm(path, { recursive: true }); }
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
  if (transaction.resourceCommitted && transaction.journalState !== undefined) throw recoveryError(error, home, kind, id, committedDetail);
  if (transaction.journalState === undefined) {
    try { await removeOwnedContainer(acquired.container, acquired.containerIdentity); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `${cleanupDetail} at ${acquired.container}.`, { cause: cleanupError }); }
  }
  throw error;
}
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; } }
async function createExclusiveFile(home: string, path: string, text: string): Promise<FileIdentity> { await ensureManagedDirectory(home, dirname(path)); let handle: FileHandle | undefined; try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle?.close(); } return physicalFileIdentity(path); }
async function createJournal(home: string, journal: ManagedGitJournal): Promise<FileIdentity> { return createExclusiveFile(home, managedGitJournalPath(home, journal.kind, journal.id), encodeManagedGitJournal(journal)); }
async function updateJournal(home: string, journal: ManagedGitJournal, expected: FileIdentity | undefined): Promise<FileIdentity> { const path = managedGitJournalPath(home, journal.kind, journal.id); if (expected === undefined) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed recovery record ownership is unavailable: ${path}`); const current = await physicalFileIdentity(path); if (!sameFileIdentity(expected, current)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed recovery record changed before update: ${path}`); await writeFileAtomic(path, encodeManagedGitJournal(journal), { managedRoot: home, mode: 0o600, commitOnRename: true }); return physicalFileIdentity(path); }
function journalFor(record: ManagedGitRecord, operation: ManagedGitJournal['operation'], phase: string, previousRevision: string | null, nextRevision: string, staging: string | null = null, backup: string | null = null, resourceStateSha256: string | null = null): ManagedGitJournal { return { schemaVersion: 1, operation, phase, kind: record.kind, id: record.id, remote: record.remote, fetchUrl: record.fetchUrl, transport: record.transport, branch: record.branch, previousRevision, nextRevision, root: record.root, staging, backup, resourceStateSha256 }; }
async function physicalFileIdentity(path: string): Promise<FileIdentity> { let handle: FileHandle | undefined; try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = await handle.stat({ bigint: true }); if (!before.isFile()) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Expected a physical managed file: ${path}`); const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const current = await lstat(path, { bigint: true }); if (!after.isFile() || current.isSymbolicLink() || !current.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed file changed while inspected: ${path}`); return { device: before.dev, inode: before.ino, sha256: createHash('sha256').update(bytes).digest('hex') }; } finally { await handle?.close(); } }
async function removeOwnedFile(path: string, expected: FileIdentity): Promise<void> { const current = await physicalFileIdentity(path); if (current.device !== expected.device || current.inode !== expected.inode || current.sha256 !== expected.sha256) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed file ownership changed before removal: ${path}`); await unlink(path); }
async function removeOwnedRecord(home: string, expected: ManagedGitRecordSnapshot): Promise<void> { const current = await readManagedGitRecord(home, expected.record.kind, expected.record.id); if (!sameRecordSnapshot(expected, current)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed provenance changed before removal: ${expected.path}`); await unlink(expected.path); }
async function restoreOwnedRecord(home: string, expected: ManagedGitRecordSnapshot, replacement: ManagedGitRecord): Promise<void> { const current = await readManagedGitRecord(home, expected.record.kind, expected.record.id); if (!sameRecordSnapshot(expected, current)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed provenance changed before rollback: ${expected.path}`); await writeFileAtomic(expected.path, encodeManagedGitRecord(replacement), { managedRoot: home, mode: 0o600, commitOnRename: true }); }
async function restoreOwnedDirectory(source: string, expected: DirectoryIdentity, destination: string): Promise<void> { await assertIdentity(source, expected, 'managed backup ownership changed before rollback'); if (await pathExists(destination)) throw new BazframeError('MANAGED_GIT_OWNERSHIP_CHANGED', `Managed rollback destination became occupied: ${destination}`); await rename(source, destination); }
function sameRecordSnapshot(left: ManagedGitRecordSnapshot, right: ManagedGitRecordSnapshot): boolean { return left.device === right.device && left.inode === right.inode && left.contentSha256 === right.contentSha256; }
function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.device === right.device && left.inode === right.inode && left.sha256 === right.sha256; }
async function readStableSkillName(path: string): Promise<string> { let handle: FileHandle | undefined; try { try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Managed Skill definition must be a physical regular file: ${path}`, { cause: error }); } const before = await handle.stat({ bigint: true }); if (!before.isFile()) throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Managed Skill definition must be a physical regular file: ${path}`); const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const current = await lstat(path, { bigint: true }); if (!after.isFile() || current.isSymbolicLink() || !current.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new BazframeError('MANAGED_GIT_RESOURCE_INVALID', `Managed Skill definition changed while inspected: ${path}`); let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (error) { throw new BazframeError('INVALID_SKILL_DEFINITION', `Skill definition is not valid UTF-8: ${path}`, { cause: error }); } return parseSkillDeclaredName(text, path); } finally { await handle?.close(); } }
function recoveryError(error: unknown, home: string, kind: ManagedGitResourceKind, id: string, detail: string): AggregateError { return new AggregateError([error], `Managed Git ${detail}; inspect ${managedGitJournalPath(home, kind, id)} before continuing.`, { cause: error }); }
function invalidSource(detail: string): BazframeError { return new BazframeError('MANAGED_GIT_SOURCE_INVALID', `Invalid managed Git source: ${detail}.`); }
function title(kind: ManagedGitResourceKind): string { return kind === 'skill' ? 'Skill' : kind === 'library' ? 'Library' : 'Package'; }
