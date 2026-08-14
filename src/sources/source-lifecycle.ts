import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  captureProfileSourceReferenceIndex,
  sameProfileSourceReferenceIndex,
  type ProfileSourceReferenceIndex
} from '../profiles/profile-source-reference.js';
import { discoverSkillDirectories, profileDirectory } from '../profiles/profile-store.js';
import { assertSafeSkillId } from '../skills/skill-id.js';
import { ensureManagedDirectory, writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import { prepareSourceUnit } from '../source-units/source-unit-preparation.js';
import {
  loadFlatSkillIdentities,
  resolveGlobalSource,
  validateProspectiveSourceUnit,
  type DirectSourceUnit
} from '../source-units/source-unit-resolver.js';
import {
  canonicalPhysicalSourceRoot,
  encodeGlobalSource,
  globalSourcePath,
  globalSourceProviderDirectory,
  readGlobalSourceSnapshot,
  sameGlobalSourceSnapshot,
  type GlobalSourceRecord,
  type GlobalSourceRecordSnapshot
} from './source-store.js';

export interface SourceLifecycleOptions { bazframeHome: string; environment?: NodeJS.ProcessEnv; }
export interface SourceLifecycleDependencies {
  beforeReferenceIndexRevalidation?: () => Promise<void>;
}
export type SourceLifecycleAction = 'added' | 'built' | 'current' | 'removed';
export interface SourceLifecycleResult extends GlobalSourceRecord { action: SourceLifecycleAction; path: string; }

export async function addSource(
  options: SourceLifecycleOptions,
  provider: string,
  source: string,
  root: string,
  dependencies: SourceLifecycleDependencies = {}
): Promise<SourceLifecycleResult> {
  assertSafeSkillId(provider); assertSafeSkillId(source);
  const canonical = await canonicalPhysicalSourceRoot(root);
  return withGlobalLock(options, 'bazframe sources add', globalSourcePath(options.bazframeHome, provider, source), async () => {
    const path = globalSourcePath(options.bazframeHome, provider, source);
    const existing = await optionalSnapshot(path, provider, source);
    if (existing !== undefined) {
      if (existing.record.root !== canonical) throw occupied(path, 'names a different canonical provider root');
      return result(existing.record, path, 'current');
    }
    const prepared = await prepareSourceUnit(options.bazframeHome, canonical, options.environment);
    const record = makeRecord(provider, source, canonical, prepared.snapshot.digest, prepared.sourceUnitRoot);
    await validateIndependent(options.bazframeHome, record);
    const referenceIndex = await captureValidatedReferenceIndex(options.bazframeHome, provider, source);
    await validateDependents(options.bazframeHome, record, path, referenceIndex);
    await ensureManagedDirectory(options.bazframeHome, globalSourceProviderDirectory(options.bazframeHome, provider));
    await assertReferenceIndexUnchanged(options.bazframeHome, provider, source, referenceIndex, dependencies);
    if (!await createExclusive(path, encodeGlobalSource(record), options.bazframeHome)) throw occupied(path, 'became occupied during add');
    return result(record, path, 'added');
  });
}

export async function buildSource(
  options: SourceLifecycleOptions,
  provider: string,
  source: string,
  dependencies: SourceLifecycleDependencies = {}
): Promise<SourceLifecycleResult> {
  assertSafeSkillId(provider); assertSafeSkillId(source);
  return withGlobalLock(options, 'bazframe sources build', globalSourcePath(options.bazframeHome, provider, source), async () => {
    const path = globalSourcePath(options.bazframeHome, provider, source);
    const initial = await requiredSnapshot(path, provider, source);
    const canonical = await canonicalPhysicalSourceRoot(initial.record.root);
    if (canonical !== initial.record.root) throw occupied(path, 'provider root no longer has its recorded canonical identity');
    const prepared = await prepareSourceUnit(options.bazframeHome, canonical, options.environment);
    const candidate = makeRecord(provider, source, canonical, prepared.snapshot.digest, prepared.sourceUnitRoot);
    await validateIndependent(options.bazframeHome, candidate);
    const referenceIndex = await captureValidatedReferenceIndex(options.bazframeHome, provider, source);
    await validateDependents(options.bazframeHome, candidate, path, referenceIndex);
    const current = await requiredSnapshot(path, provider, source);
    if (!sameGlobalSourceSnapshot(initial, current)) throw occupied(path, 'changed during build');
    await assertReferenceIndexUnchanged(options.bazframeHome, provider, source, referenceIndex, dependencies);
    await writeFileAtomic(path, encodeGlobalSource(candidate), { managedRoot: options.bazframeHome, mode: 0o600, commitOnRename: true });
    return result(candidate, path, 'built');
  });
}

export async function removeSource(
  options: SourceLifecycleOptions,
  provider: string,
  source: string,
  dependencies: SourceLifecycleDependencies = {}
): Promise<SourceLifecycleResult> {
  assertSafeSkillId(provider); assertSafeSkillId(source);
  return withGlobalLock(options, 'bazframe sources remove', globalSourcePath(options.bazframeHome, provider, source), async () => {
    const path = globalSourcePath(options.bazframeHome, provider, source);
    const initial = await requiredSnapshot(path, provider, source);
    const referenceIndex = await captureValidatedReferenceIndex(options.bazframeHome, provider, source);
    if (referenceIndex.profileIds.length > 0) throw new BazframeError('SOURCE_REFERENCED', `Cannot remove ${provider}/${source}; referenced by profiles: ${referenceIndex.profileIds.join(', ')}`);
    const current = await requiredSnapshot(path, provider, source);
    if (!sameGlobalSourceSnapshot(initial, current)) throw occupied(path, 'changed during remove');
    await assertReferenceIndexUnchanged(options.bazframeHome, provider, source, referenceIndex, dependencies);
    await unlink(path);
    return result(initial.record, path, 'removed');
  });
}

function makeRecord(provider: string, source: string, root: string, digest: string, sourceUnitRoot: string): GlobalSourceRecord {
  return { schemaVersion: 1, provider, source, root, digest, sourceUnitRoot };
}
function direct(record: GlobalSourceRecord, path: string): DirectSourceUnit {
  return { schemaVersion: 1, providerId: record.provider, sourceId: record.source, sourceRoot: record.root, snapshotDigest: record.digest, sourceUnitRoot: record.sourceUnitRoot, descriptorPath: path, relativeDescriptorPath: `${record.provider}/${record.source}.json`, preparationState: 'ready', rebuildAvailability: 'available' };
}
async function validateIndependent(home: string, record: GlobalSourceRecord): Promise<void> {
  const skills = await resolveGlobalSource(home, record);
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) throw new BazframeError('SOURCE_CANDIDATE_DUPLICATE', `Candidate source contains duplicate skill name: ${skill.name}`);
    names.add(skill.name);
  }
}
async function captureValidatedReferenceIndex(
  home: string,
  provider: string,
  source: string
): Promise<ProfileSourceReferenceIndex> {
  const index = await captureProfileSourceReferenceIndex(home, provider, source);
  if (index.diagnostics.length > 0) {
    const details = index.diagnostics.map((item) => `${item.profileId}:${item.diagnostic.path}`).join(', ');
    throw new BazframeError('SOURCE_REFERENCE_INDEX_INVALID', `Cannot prove complete source references: ${details}`);
  }
  return index;
}
async function assertReferenceIndexUnchanged(
  home: string,
  provider: string,
  source: string,
  initial: ProfileSourceReferenceIndex,
  dependencies: SourceLifecycleDependencies
): Promise<void> {
  await dependencies.beforeReferenceIndexRevalidation?.();
  const current = await captureProfileSourceReferenceIndex(home, provider, source);
  if (current.diagnostics.length > 0 || !sameProfileSourceReferenceIndex(initial, current)) {
    throw new BazframeError(
      'SOURCE_REFERENCE_INDEX_CHANGED',
      'Profile source reference index changed during the global source transaction.'
    );
  }
}
async function validateDependents(
  home: string,
  record: GlobalSourceRecord,
  path: string,
  referenceIndex: ProfileSourceReferenceIndex
): Promise<void> {
  const failures: string[] = [];
  for (const profileId of referenceIndex.profileIds) {
    try {
      const directory = profileDirectory(home, profileId);
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`Profile must be a physical directory: ${directory}`);
      const flat = loadFlatSkillIdentities(await discoverSkillDirectories(join(directory, 'skills')));
      await validateProspectiveSourceUnit(directory, flat, direct(record, path));
    } catch (error) { failures.push(`${profileId}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length > 0) {
    throw new BazframeError('SOURCE_DEPENDENT_INVALID', `Source activation would invalidate referencing profiles:\n${failures.join('\n')}`);
  }
}
async function optionalSnapshot(path: string, provider: string, source: string): Promise<GlobalSourceRecordSnapshot | undefined> {
  try { return await readGlobalSourceSnapshot(path, provider, source); }
  catch (error) {
    if (error instanceof BazframeError && error.code === 'SOURCE_RECORD_READ_FAILED' && error.cause !== undefined && errorCode(error.cause) === 'ENOENT') return undefined;
    throw occupied(path, error instanceof Error ? error.message : String(error));
  }
}
async function requiredSnapshot(path: string, provider: string, source: string): Promise<GlobalSourceRecordSnapshot> {
  const value = await optionalSnapshot(path, provider, source);
  if (value === undefined) throw new BazframeError('SOURCE_NOT_FOUND', `Global source does not exist: ${path}`);
  return value;
}
async function createExclusive(path: string, contents: string, home: string): Promise<boolean> {
  const temporaryDirectory = join(home, 'tmp', 'sources');
  await ensureManagedDirectory(home, temporaryDirectory);
  const temporaryPath = join(temporaryDirectory, `${process.pid}.${randomUUID()}.${basename(path)}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    try { await link(temporaryPath, path); return true; }
    catch (error) { if (errorCode(error) === 'EEXIST') return false; throw error; }
  } finally { await handle?.close().catch(() => undefined); await unlink(temporaryPath).catch(() => undefined); }
}
function withGlobalLock<T>(options: SourceLifecycleOptions, command: string, target: string, operation: () => Promise<T>): Promise<T> {
  return withStateLock(join(options.bazframeHome, 'locks', 'state.lock'), { command, target }, operation, { managedRoot: options.bazframeHome });
}
function occupied(path: string, detail: string): BazframeError { return new BazframeError('SOURCE_DESTINATION_OCCUPIED', `Refusing global source at ${path}: ${detail}.`); }
function result(record: GlobalSourceRecord, path: string, action: SourceLifecycleAction): SourceLifecycleResult { return { ...record, action, path }; }
