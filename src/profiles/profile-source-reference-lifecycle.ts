import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readUtf8InstructionFile } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { assertSafeSkillId } from '../skills/skill-id.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import { loadFlatSkillIdentities, validateProspectiveSourceUnit, type DirectSourceUnit } from '../source-units/source-unit-resolver.js';
import { verifySourceSnapshot } from '../source-units/source-snapshot.js';
import { globalSourcePath, readGlobalSourceSnapshot, sameGlobalSourceSnapshot, type GlobalSourceRecord } from '../sources/source-store.js';
import { assertSafeProfileId } from './profile-id.js';
import {
  encodeProfileSourceReference,
  profileSourceProviderDirectory,
  profileSourceReferencePath,
  profileSourcesDirectory,
  readProfileSourceReferenceSnapshot,
  sameProfileSourceReferenceSnapshot,
  scanProfileSourceReferences,
  type ProfileSourceReference,
  type ProfileSourceReferenceSnapshot
} from './profile-source-reference.js';
import { discoverSkillDirectories, profileDirectory, readActiveProfile } from './profile-store.js';

export interface ProfileSourceReferenceOptions { bazframeHome: string; }
export type ProfileSourceReferenceAction = 'added' | 'current' | 'removed' | 'absent';
export interface ProfileSourceReferenceResult extends ProfileSourceReference { action: ProfileSourceReferenceAction; profileId: string; path: string; }

export async function addActiveProfileSourceReference(options: ProfileSourceReferenceOptions, provider: string, source: string): Promise<ProfileSourceReferenceResult> {
  return addFor(options, undefined, provider, source);
}
export async function addProfileSourceReference(options: ProfileSourceReferenceOptions, profileId: string, provider: string, source: string): Promise<ProfileSourceReferenceResult> {
  assertSafeProfileId(profileId); return addFor(options, profileId, provider, source);
}
export async function removeActiveProfileSourceReference(options: ProfileSourceReferenceOptions, provider: string, source: string): Promise<ProfileSourceReferenceResult> {
  return removeFor(options, undefined, provider, source);
}
export async function removeProfileSourceReference(options: ProfileSourceReferenceOptions, profileId: string, provider: string, source: string): Promise<ProfileSourceReferenceResult> {
  assertSafeProfileId(profileId); return removeFor(options, profileId, provider, source);
}

async function addFor(options: ProfileSourceReferenceOptions, requestedProfileId: string | undefined, provider: string, source: string): Promise<ProfileSourceReferenceResult> {
  assertSafeSkillId(provider); assertSafeSkillId(source);
  return withReferenceLock(options, requestedProfileId, provider, source, 'bazframe profile sources add', async (profileId, directory, path) => {
    await assertValidNamespace(options.bazframeHome, profileId);
    const existing = await optionalReference(path, provider, source);
    const globalPath = globalSourcePath(options.bazframeHome, provider, source);
    const global = await readGlobalSourceSnapshot(globalPath, provider, source);
    await verifySourceSnapshot(options.bazframeHome, global.record.digest);
    const flat = loadFlatSkillIdentities(await discoverSkillDirectories(join(directory, 'skills')));
    await validateProspectiveSourceUnit(directory, flat, direct(global.record, globalPath));
    const revalidated = await readGlobalSourceSnapshot(globalPath, provider, source);
    if (!sameGlobalSourceSnapshot(global, revalidated)) throw new BazframeError('SOURCE_CHANGED', `Global source changed while adding reference: ${provider}/${source}`);
    if (existing !== undefined) {
      const current = await readProfileSourceReferenceSnapshot(path, provider, source);
      if (!sameProfileSourceReferenceSnapshot(existing, current)) throw new BazframeError('SOURCE_REFERENCE_CHANGED', `Profile source reference changed while validating: ${path}`);
      return result(current.reference, profileId, path, 'current');
    }
    await ensureManagedDirectory(options.bazframeHome, profileSourceProviderDirectory(options.bazframeHome, profileId, provider));
    const reference: ProfileSourceReference = { schemaVersion: 1, provider, source };
    if (!await createExclusive(path, encodeProfileSourceReference(reference), options.bazframeHome)) throw new BazframeError('SOURCE_REFERENCE_OCCUPIED', `Profile source reference became occupied: ${path}`);
    return result(reference, profileId, path, 'added');
  });
}

async function removeFor(options: ProfileSourceReferenceOptions, requestedProfileId: string | undefined, provider: string, source: string): Promise<ProfileSourceReferenceResult> {
  assertSafeSkillId(provider); assertSafeSkillId(source);
  return withReferenceLock(options, requestedProfileId, provider, source, 'bazframe profile sources remove', async (profileId, _directory, path) => {
    const initial = await optionalReference(path, provider, source);
    if (initial === undefined) return result({ schemaVersion: 1, provider, source }, profileId, path, 'absent');
    const current = await readProfileSourceReferenceSnapshot(path, provider, source);
    if (!sameProfileSourceReferenceSnapshot(initial, current)) throw new BazframeError('SOURCE_REFERENCE_CHANGED', `Profile source reference changed during removal: ${path}`);
    await unlink(path);
    await prune(profileSourceProviderDirectory(options.bazframeHome, profileId, provider));
    await prune(profileSourcesDirectory(options.bazframeHome, profileId));
    return result(initial.reference, profileId, path, 'removed');
  });
}

async function withReferenceLock<T>(options: ProfileSourceReferenceOptions, requestedProfileId: string | undefined, provider: string, source: string, command: string, operation: (profileId: string, directory: string, path: string) => Promise<T>): Promise<T> {
  return withStateLock(join(options.bazframeHome, 'locks', 'state.lock'), {
    command,
    target: requestedProfileId === undefined ? join(options.bazframeHome, 'active-profile') : profileDirectory(options.bazframeHome, requestedProfileId)
  }, async () => {
    const profileId = requestedProfileId ?? await readActiveProfile(options.bazframeHome);
    const directory = profileDirectory(options.bazframeHome, profileId);
    const path = profileSourceReferencePath(options.bazframeHome, profileId, provider, source);
    return withStateLock(join(options.bazframeHome, 'locks', 'profiles', `${profileId}.sources.lock`), { command, target: path }, async () => {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('PROFILE_NOT_PHYSICAL', `Profile must be a physical directory: ${directory}`);
      await readUtf8InstructionFile(join(directory, 'AGENTS.md'), `Profile ${JSON.stringify(profileId)} instructions`);
      const skillMetadata = await lstat(join(directory, 'skills'));
      if (skillMetadata.isSymbolicLink() || !skillMetadata.isDirectory()) throw new BazframeError('PROFILE_SKILLS_INVALID', `Profile skills must be a physical directory: ${join(directory, 'skills')}`);
      return operation(profileId, directory, path);
    }, { managedRoot: options.bazframeHome });
  }, { managedRoot: options.bazframeHome });
}
async function assertValidNamespace(home: string, profileId: string): Promise<void> {
  const namespace = await scanProfileSourceReferences(home, profileId);
  if (namespace.diagnostics.length > 0) throw new BazframeError('SOURCE_REFERENCE_NAMESPACE_INVALID', `Profile source reference namespace is invalid: ${namespace.diagnostics.map((item) => item.path).join(', ')}`);
  for (const path of namespace.references) await readProfileSourceReferenceSnapshot(path.path, path.provider, path.source);
}
function direct(record: GlobalSourceRecord, path: string): DirectSourceUnit {
  return { schemaVersion: 1, providerId: record.provider, sourceId: record.source, sourceRoot: record.root, snapshotDigest: record.digest, sourceUnitRoot: record.sourceUnitRoot, descriptorPath: path, relativeDescriptorPath: `${record.provider}/${record.source}.json`, preparationState: 'ready', rebuildAvailability: 'available' };
}
async function optionalReference(path: string, provider: string, source: string): Promise<ProfileSourceReferenceSnapshot | undefined> {
  try { return await readProfileSourceReferenceSnapshot(path, provider, source); }
  catch (error) {
    if (error instanceof BazframeError && error.code === 'SOURCE_REFERENCE_READ_FAILED' && error.cause !== undefined && errorCode(error.cause) === 'ENOENT') return undefined;
    throw error;
  }
}
async function createExclusive(path: string, contents: string, home: string): Promise<boolean> {
  const temporaryDirectory = join(home, 'tmp', 'source-references'); await ensureManagedDirectory(home, temporaryDirectory);
  const temporaryPath = join(temporaryDirectory, `${process.pid}.${randomUUID()}.${basename(path)}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    try { await link(temporaryPath, path); return true; } catch (error) { if (errorCode(error) === 'EEXIST') return false; throw error; }
  } finally { await handle?.close().catch(() => undefined); await unlink(temporaryPath).catch(() => undefined); }
}
async function prune(path: string): Promise<void> { try { await rmdir(path); } catch (error) { if (!new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST']).has(errorCode(error) ?? '')) throw error; } }
function result(reference: ProfileSourceReference, profileId: string, path: string, action: ProfileSourceReferenceAction): ProfileSourceReferenceResult { return { ...reference, action, profileId, path }; }
