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
import { assertSafeSkillId, isSafeSkillId } from '../skills/skill-id.js';
import { ensureManagedDirectory, writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import { readOptionalSourceBuildManifest } from '../source-units/source-build-manifest.js';
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
  globalSourcesDirectory,
  readGlobalSourceSnapshot,
  sameGlobalSourceSnapshot,
  type GlobalSourceRecord,
  type GlobalSourceRecordSnapshot
} from './source-store.js';

export interface SourceLifecycleOptions { bazframeHome: string; environment?: NodeJS.ProcessEnv; }
export interface SourceLifecycleDependencies {
  beforeReferenceIndexRevalidation?: () => Promise<void>;
  declaredBuild?: 'execute' | 'reject';
}
export type SourceLifecycleAction = 'added' | 'built' | 'removed';
export interface SourceLifecycleResult extends GlobalSourceRecord { action: SourceLifecycleAction; path: string; }

export async function addSource(
  options: SourceLifecycleOptions,
  root: string,
  dependencies: SourceLifecycleDependencies = {}
): Promise<SourceLifecycleResult> {
  const canonical = await canonicalPhysicalSourceRoot(root);
  const source = basename(canonical);
  if (!isSafeSkillId(source)) {
    throw new BazframeError(
      'SOURCE_NAME_INVALID',
      `Source directory name ${JSON.stringify(source)} is invalid. Source names must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`
    );
  }
  const path = globalSourcePath(options.bazframeHome, source);
  return withGlobalLock(options, 'bazframe sources add', path, async () => {
    if (await optionalSnapshot(options.bazframeHome, source) !== undefined) {
      throw occupied(path, 'source name is already registered');
    }
    if (
      dependencies.declaredBuild === 'reject'
      && await readOptionalSourceBuildManifest(canonical) !== undefined
    ) {
      throw new BazframeError(
        'SOURCE_BUILD_REQUIRES_CLI',
        'This source declares a build. Use `bazframe sources add <absolute-root>` in a terminal so the unsandboxed build and its output remain visible.'
      );
    }
    const prepared = await prepareSourceUnit(
      options.bazframeHome,
      canonical,
      options.environment,
      dependencies.declaredBuild === undefined
        ? {}
        : { declaredBuild: dependencies.declaredBuild }
    );
    const record = makeRecord(source, canonical, prepared.snapshot.digest, prepared.sourceUnitRoot);
    await validateIndependent(options.bazframeHome, record);
    const referenceIndex = await captureValidatedReferenceIndex(options.bazframeHome, source);
    await validateDependents(options.bazframeHome, record, path, referenceIndex);
    await ensureManagedDirectory(options.bazframeHome, globalSourcesDirectory(options.bazframeHome));
    await assertReferenceIndexUnchanged(options.bazframeHome, source, referenceIndex, dependencies);
    if (!await createExclusive(path, encodeGlobalSource(record), options.bazframeHome)) throw occupied(path, 'became occupied during add');
    return result(record, path, 'added');
  });
}

export async function buildSource(
  options: SourceLifecycleOptions,
  source: string,
  dependencies: SourceLifecycleDependencies = {}
): Promise<SourceLifecycleResult> {
  assertSafeSkillId(source);
  return withGlobalLock(options, 'bazframe sources build', globalSourcePath(options.bazframeHome, source), async () => {
    const path = globalSourcePath(options.bazframeHome, source);
    const initial = await requiredSnapshot(options.bazframeHome, source);
    const canonical = await canonicalPhysicalSourceRoot(initial.record.root);
    if (canonical !== initial.record.root || basename(canonical) !== source) throw occupied(path, 'source root no longer has its recorded canonical identity');
    const prepared = await prepareSourceUnit(options.bazframeHome, canonical, options.environment);
    const candidate = makeRecord(source, canonical, prepared.snapshot.digest, prepared.sourceUnitRoot);
    await validateIndependent(options.bazframeHome, candidate);
    const referenceIndex = await captureValidatedReferenceIndex(options.bazframeHome, source);
    await validateDependents(options.bazframeHome, candidate, path, referenceIndex);
    const current = await requiredSnapshot(options.bazframeHome, source);
    if (!sameGlobalSourceSnapshot(initial, current)) throw occupied(path, 'changed during build');
    await assertReferenceIndexUnchanged(options.bazframeHome, source, referenceIndex, dependencies);
    await writeFileAtomic(path, encodeGlobalSource(candidate), { managedRoot: options.bazframeHome, mode: 0o600, commitOnRename: true });
    return result(candidate, path, 'built');
  });
}

export async function removeSource(
  options: SourceLifecycleOptions,
  source: string,
  dependencies: SourceLifecycleDependencies = {}
): Promise<SourceLifecycleResult> {
  assertSafeSkillId(source);
  return withGlobalLock(options, 'bazframe sources remove', globalSourcePath(options.bazframeHome, source), async () => {
    const path = globalSourcePath(options.bazframeHome, source);
    const initial = await requiredSnapshot(options.bazframeHome, source);
    const referenceIndex = await captureValidatedReferenceIndex(options.bazframeHome, source);
    if (referenceIndex.profileIds.length > 0) throw new BazframeError('SOURCE_REFERENCED', `Cannot remove ${source}; referenced by profiles: ${referenceIndex.profileIds.join(', ')}`);
    const current = await requiredSnapshot(options.bazframeHome, source);
    if (!sameGlobalSourceSnapshot(initial, current)) throw occupied(path, 'changed during remove');
    await assertReferenceIndexUnchanged(options.bazframeHome, source, referenceIndex, dependencies);
    const beforeUnlink = await requiredSnapshot(options.bazframeHome, source);
    if (!sameGlobalSourceSnapshot(initial, beforeUnlink)) throw occupied(path, 'changed before remove commit');
    await unlink(path);
    return result(initial.record, path, 'removed');
  });
}

function makeRecord(source: string, root: string, digest: string, sourceUnitRoot: string): GlobalSourceRecord {
  return { schemaVersion: 1, source, root, digest, sourceUnitRoot };
}
function direct(record: GlobalSourceRecord, path: string): DirectSourceUnit {
  return { schemaVersion: 1, sourceId: record.source, sourceRoot: record.root, snapshotDigest: record.digest, sourceUnitRoot: record.sourceUnitRoot, descriptorPath: path, relativeDescriptorPath: `${record.source}.json`, preparationState: 'ready', rebuildAvailability: 'available' };
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
  source: string
): Promise<ProfileSourceReferenceIndex> {
  const index = await captureProfileSourceReferenceIndex(home, source);
  if (index.diagnostics.length > 0) {
    const details = index.diagnostics.map((item) => `${item.profileId}:${item.diagnostic.path}`).join(', ');
    throw new BazframeError('SOURCE_REFERENCE_INDEX_INVALID', `Cannot prove complete source references: ${details}`);
  }
  return index;
}
async function assertReferenceIndexUnchanged(
  home: string,
  source: string,
  initial: ProfileSourceReferenceIndex,
  dependencies: SourceLifecycleDependencies
): Promise<void> {
  await dependencies.beforeReferenceIndexRevalidation?.();
  const current = await captureProfileSourceReferenceIndex(home, source);
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
async function optionalSnapshot(home: string, source: string): Promise<GlobalSourceRecordSnapshot | undefined> {
  const path = globalSourcePath(home, source);
  try { return await readGlobalSourceSnapshot(home, source); }
  catch (error) {
    if (error instanceof BazframeError && error.code === 'SOURCE_RECORD_READ_FAILED' && error.cause !== undefined && errorCode(error.cause) === 'ENOENT') return undefined;
    throw occupied(path, error instanceof Error ? error.message : String(error));
  }
}
async function requiredSnapshot(home: string, source: string): Promise<GlobalSourceRecordSnapshot> {
  const path = globalSourcePath(home, source);
  const value = await optionalSnapshot(home, source);
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
