import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { profilePublishingTreeRoot } from '../state/paths.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { readOptionalManagedProfileState } from './managed-profile-state.js';
import { readStoredBlob } from './blob-store.js';
import { assertOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority } from './profile-operation-lock.js';
import { compare } from './profile-filesystem.js';
import { defaultPhysicalReads, type PhysicalProfileReadServices, type PhysicalProfileDirectory } from './physical-profile-closure.js';
import type { BlobFile, Sha256 } from './captured-profile.js';

export interface ArtifactTreeManifestV1 { schemaVersion: 1; kind: 'bazframe-artifact-tree'; role: 'skill' | 'library' | 'packageArtifacts'; files: BlobFile[] }
export interface ArtifactTreeSnapshot { treeId: Sha256; manifest: ArtifactTreeManifestV1; path: string }
export interface ArtifactTreePublicationResult extends ArtifactTreeSnapshot { reused: boolean }
const SHA = /^[a-f0-9]{64}$/u; const DRIVE = /^[A-Za-z]:/u; const MANIFEST = 'manifest.json'; const COMMITTED = 'COMMITTED';

export function encodeArtifactTreeManifest(value: ArtifactTreeManifestV1, lowerLimits: Partial<CapturedProfileLimitPolicy> = {}): string {
  const policy = capturedProfileLimitPolicy(lowerLimits);
  if (value.schemaVersion !== 1 || value.kind !== 'bazframe-artifact-tree' || !['skill', 'library', 'packageArtifacts'].includes(value.role) || !Array.isArray(value.files)) throw invalid('manifest identity is invalid');
  let previous: string | undefined; let total = 0;
  const files = value.files.map((file) => {
    if (file === null || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).sort().join(',') !== 'bytes,executable,path,sha256') throw invalid('file record is invalid');
    if (!portablePath(file.path, policy) || !SHA.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || Object.is(file.bytes, -0) || file.bytes > policy.maxBlobBytes || typeof file.executable !== 'boolean') throw invalid('file record is invalid');
    if (previous !== undefined && compare(previous, file.path) >= 0) throw invalid('files must be unique and canonically ordered');
    previous = file.path; total += file.bytes; if (!Number.isSafeInteger(total) || total > policy.maxAggregateBytes) throw invalid('tree exceeds aggregate byte limit');
    return { path: file.path, sha256: file.sha256, bytes: file.bytes, executable: file.executable };
  });
  if (files.length > policy.maxEntries) throw invalid('tree exceeds entry limit'); assertPortableUnique(files.map((file) => file.path));
  const canonical = `${JSON.stringify({ schemaVersion: 1, kind: 'bazframe-artifact-tree', role: value.role, files }, null, 2)}\n`;
  if (Buffer.byteLength(canonical) > policy.maxManifestBytes) throw invalid('manifest exceeds byte limit'); return canonical;
}

export function decodeArtifactTreeManifest(bytes: Uint8Array, lowerLimits: Partial<CapturedProfileLimitPolicy> = {}): ArtifactTreeManifestV1 {
  const policy = capturedProfileLimitPolicy(lowerLimits); if (bytes.byteLength > policy.maxManifestBytes) throw invalid('manifest exceeds byte limit'); let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (error) { throw new BazframeError('PROFILE_ARTIFACT_TREE_INVALID', 'Invalid artifact tree manifest.', { cause: error }); }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'files,kind,role,schemaVersion') throw invalid('manifest fields are invalid');
  const canonical = encodeArtifactTreeManifest(value as ArtifactTreeManifestV1, policy); if (!Buffer.from(canonical).equals(Buffer.from(bytes))) throw invalid('manifest is not canonical');
  return JSON.parse(canonical) as ArtifactTreeManifestV1;
}
export function artifactTreeId(manifest: ArtifactTreeManifestV1, lowerLimits: Partial<CapturedProfileLimitPolicy> = {}): Sha256 { return hash(Buffer.from(encodeArtifactTreeManifest(manifest, lowerLimits))); }
export function artifactTreePath(home: string, treeId: string): string { if (!SHA.test(treeId)) throw invalid('tree ID is invalid'); return join(profilePublishingTreeRoot(home), treeId); }

export interface ArtifactTreeEffects {
  join(...parts: string[]): string;
  ensureDirectory(home: string, path: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  writeFile(path: string, bytes: Uint8Array, executable: boolean): Promise<void>;
  /** POSIX directory durability effects; Windows publication drains each native/private file write. */
  syncTree?(path: string): Promise<void>;
  syncDirectory?(path: string): Promise<void>;
  readBlob: typeof readStoredBlob;
  reads(): PhysicalProfileReadServices;
  logicalExecutable: boolean;
  occupied(error: unknown): boolean;
}
const defaultTreeEffects: ArtifactTreeEffects = {
  join, ensureDirectory: ensureManagedDirectory,
  async createDirectory(path) { await mkdir(path, { mode: 0o700 }); },
  async writeFile(path, bytes, executable) { const mode = executable ? 0o700 : 0o600; const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode); try { await handle.writeFile(bytes); await chmod(path, mode); await handle.sync(); } finally { await handle.close(); } },
  syncTree: syncDirectoryTree, syncDirectory, readBlob: readStoredBlob,
  reads: () => defaultPhysicalReads, logicalExecutable: false,
  occupied: (error) => errorCode(error) === 'EEXIST'
};

export async function publishArtifactTree(home: string, authority: OperationMutationAuthority, manifest: ArtifactTreeManifestV1, lowerLimits: Partial<CapturedProfileLimitPolicy> = {}, effects: ArtifactTreeEffects = defaultTreeEffects): Promise<ArtifactTreePublicationResult> {
  const policy = capturedProfileLimitPolicy(lowerLimits);
  const transactionId = operationAuthorityTransactionId(authority);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  manifest = decodeArtifactTreeManifest(Buffer.from(encodeArtifactTreeManifest(manifest, policy)), policy);
  const treeId = artifactTreeId(manifest, policy);
  const root = effects.join(home, 'profile-publishing', 'trees');
  const destination = effects.join(root, treeId);
  await effects.ensureDirectory(home, root);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  try { await effects.createDirectory(destination); }
  catch (error) {
    if (!effects.occupied(error)) throw error;
    let existing: ArtifactTreeSnapshot;
    try { existing = await readArtifactTree(home, treeId, policy, effects); }
    catch (occupied) { throw new BazframeError('PROFILE_ARTIFACT_TREE_OCCUPIED', 'Profile artifact tree destination is occupied by incomplete or invalid state.', { cause: occupied }); }
    assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
    return { ...existing, reused: true };
  }
  const contentRoot = effects.join(destination, 'root');
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  await effects.createDirectory(contentRoot);
  for (const file of manifest.files) {
    assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
    const bytes = await effects.readBlob(home, file.sha256, policy);
    assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
    if (bytes.byteLength !== file.bytes || hash(bytes) !== file.sha256) throw invalid('blob does not match tree file');
    const parts = file.path.split('/'); const name = parts.pop()!;
    const parent = effects.join(contentRoot, ...parts);
    await effects.ensureDirectory(home, parent);
    assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
    await effects.writeFile(effects.join(parent, name), bytes, file.executable);
  }
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  await effects.writeFile(effects.join(destination, MANIFEST), Buffer.from(encodeArtifactTreeManifest(manifest, policy)), false);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  await effects.syncTree?.(contentRoot);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  await effects.syncDirectory?.(destination);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  await effects.writeFile(effects.join(destination, COMMITTED), Buffer.from(`${treeId}\n`), false);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  await effects.syncDirectory?.(destination);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  await effects.syncDirectory?.(root);
  const published = await readArtifactTree(home, treeId, policy, effects);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  return { ...published, reused: false };
}

/** Reads only trees whose final marker proves complete publication. */
export async function readArtifactTree(home: string, treeId: string, lowerLimits: Partial<CapturedProfileLimitPolicy> = {}, effects: ArtifactTreeEffects = defaultTreeEffects): Promise<ArtifactTreeSnapshot> {
  const policy = capturedProfileLimitPolicy(lowerLimits); const path = effects.join(home, 'profile-publishing', 'trees', treeId); if (!SHA.test(treeId)) throw invalid('tree ID is invalid'); const reads = effects.reads(); let directory;
  try { directory = await reads.openDirectory(path, home); }
  catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND' || error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT') throw new BazframeError('PROFILE_ARTIFACT_TREE_ABSENT', 'Profile artifact tree is absent.'); throw error; }
  try {
    const top = await directory.enumerate(3); if (top.join(',') !== 'COMMITTED,manifest.json,root') throw invalid('tree is not atomically committed');
    const marker = await reads.readFile(directory.childPath(COMMITTED), 65); if (!marker.bytes.equals(Buffer.from(`${treeId}\n`))) throw invalid('tree commit marker is invalid');
    const manifestFile = await reads.readFile(directory.childPath(MANIFEST), policy.maxManifestBytes); const manifest = decodeArtifactTreeManifest(manifestFile.bytes, policy);
    if (hash(manifestFile.bytes) !== treeId) throw invalid('manifest hash does not match tree ID');
    const root = await reads.openDirectory(directory.childPath('root'), home);
    try {
      const directories = new Set(manifest.files.flatMap((file) => { const parts = file.path.split('/'); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/')); }));
      for (let pass = 0; pass < (effects.logicalExecutable ? 2 : 1); pass++) {
      const actual = await enumerateFiles(root, home, policy, reads, directories); if (actual.length !== manifest.files.length) throw invalid('tree file closure is invalid');
      for (let index = 0; index < manifest.files.length; index += 1) { const expected = manifest.files[index]!; const current = actual[index]!; if (current.path !== expected.path || current.bytes.byteLength !== expected.bytes || hash(current.bytes) !== expected.sha256 || !effects.logicalExecutable && current.executable !== expected.executable) throw invalid('tree file does not match manifest'); }
      }
      await root.assertStable();
    } finally { await root.close().catch(() => undefined); }
    if (effects.logicalExecutable && (!(await reads.readFile(directory.childPath(MANIFEST), policy.maxManifestBytes)).bytes.equals(manifestFile.bytes)
      || !(await reads.readFile(directory.childPath(COMMITTED), 65)).bytes.equals(marker.bytes))) throw invalid('tree publication changed');
    await directory.assertStable(); return { treeId, manifest, path };
  } finally { await directory.close().catch(() => undefined); }
}

/** Safe read-only root discovery. Journal/staging roots are added by the later transaction module before cleanup exists. */
export async function collectArtifactRoots(home: string, extraTreeIds: ReadonlySet<string> = new Set()): Promise<Set<string>> {
  const retained = new Set(extraTreeIds); const profiles = join(home, 'profiles'); let names: string[];
  try { names = (await readdir(profiles)).sort(compare); } catch (error) { if (errorCode(error) === 'ENOENT') return retained; throw error; }
  for (const name of names) { if (!isSafeProfileId(name)) continue; const state = await readOptionalManagedProfileState(home, name); if (state === undefined) continue; for (const resource of state.state.importedResources) if (resource.source.kind !== 'missingRemoteGit') retained.add(resource.source.treeId); }
  return retained;
}

async function enumerateFiles(directory: PhysicalProfileDirectory, trustedRoot: string, policy: CapturedProfileLimitPolicy, reads: PhysicalProfileReadServices, directories: Set<string>, depth = 0, prefix = '', budget = { entries: 0, bytes: 0 }): Promise<Array<{ path: string; bytes: Buffer; executable: boolean }>> {
  if (depth > policy.maxDepth) throw invalid('tree depth exceeds limit'); const result: Array<{ path: string; bytes: Buffer; executable: boolean }> = [];
  for (const name of await directory.enumerate(policy.maxEntries)) {
    if (++budget.entries > policy.maxEntries) throw invalid('tree exceeds entry limit');
    const path = directory.childPath(name); const logicalPath = prefix === '' ? name : `${prefix}/${name}`;
    if (Buffer.byteLength(logicalPath) > policy.maxPathBytes) throw invalid('tree path exceeds limit');
    const kind = await reads.inspectKind(path);
    if (kind === 'directory') { if (!directories.has(logicalPath)) throw invalid('tree contains an unexpected directory'); const child = await reads.openDirectory(path, trustedRoot); try { result.push(...await enumerateFiles(child, trustedRoot, policy, reads, directories, depth + 1, logicalPath, budget)); } finally { await child.close().catch(() => undefined); } }
    else if (kind === 'file') { const file = await reads.readFile(path, policy.maxBlobBytes); budget.bytes += file.bytes.length; if (budget.bytes > policy.maxAggregateBytes) throw invalid('tree exceeds aggregate byte limit'); result.push({ path: logicalPath, bytes: file.bytes, executable: file.executable }); }
    else throw invalid('tree contains a link or special entry');
  }
  await directory.assertStable();
  return result.sort((left, right) => compare(left.path, right.path));
}

function portablePath(path: string, policy: CapturedProfileLimitPolicy): boolean { if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || DRIVE.test(path) || path.includes('\\') || path.includes('\0') || Buffer.byteLength(path) > policy.maxPathBytes || hasForbiddenPathCodePoint(path)) return false; const parts = path.split('/'); return parts.length <= policy.maxDepth && parts.every((part) => part !== '' && part !== '.' && part !== '..'); }
function hasForbiddenPathCodePoint(path: string): boolean { for (let index = 0; index < path.length; index += 1) { const value = path.charCodeAt(index); if (value < 0x20 || value === 0x7f || (value >= 0xd800 && value <= 0xdfff)) return true; } return false; }
function assertPortableUnique(paths: readonly string[]): void { const seen = new Set<string>(); for (const path of paths) { const key = path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase(); if (seen.has(key)) throw invalid('tree paths have a portable collision'); seen.add(key); } }

async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function syncDirectoryTree(path: string): Promise<void> { for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await syncDirectoryTree(join(path, entry.name)); await syncDirectory(path); }
function hash(bytes: Uint8Array): Sha256 { return createHash('sha256').update(bytes).digest('hex'); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_ARTIFACT_TREE_INVALID', `Invalid profile artifact tree: ${detail}.`); }
