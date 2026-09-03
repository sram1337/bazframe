import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { profilePublishingTreeRoot } from '../state/paths.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { readOptionalManagedProfileState } from './managed-profile-state.js';
import { readStoredBlob } from './blob-store.js';
import { assertOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority } from './profile-operation-lock.js';
import { assertStablePhysicalDirectory, compare, enumerateStableDirectory, openStablePhysicalDirectory, readStablePhysicalFile, stableReadChildPath } from './profile-filesystem.js';
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

export async function publishArtifactTree(home: string, authority: OperationMutationAuthority, manifest: ArtifactTreeManifestV1, lowerLimits: Partial<CapturedProfileLimitPolicy> = {}): Promise<ArtifactTreePublicationResult> {
  const policy = capturedProfileLimitPolicy(lowerLimits);
  const transactionId = operationAuthorityTransactionId(authority);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  const treeId = artifactTreeId(manifest, policy);
  const root = profilePublishingTreeRoot(home);
  const destination = artifactTreePath(home, treeId);
  await ensureManagedDirectory(home, root);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  try { await mkdir(destination, { mode: 0o700 }); }
  catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    try { return { ...await readArtifactTree(home, treeId, policy), reused: true }; }
    catch (occupied) { throw new BazframeError('PROFILE_ARTIFACT_TREE_OCCUPIED', 'Profile artifact tree destination is occupied by incomplete or invalid state.', { cause: occupied }); }
  }
  const contentRoot = join(destination, 'root');
  await mkdir(contentRoot, { mode: 0o700 });
  for (const file of manifest.files) {
    const bytes = await readStoredBlob(home, file.sha256, policy);
    if (bytes.byteLength !== file.bytes) throw invalid('blob size does not match tree file');
    const target = join(contentRoot, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, file.executable ? 0o700 : 0o600);
    try { await handle.writeFile(bytes); await chmod(target, file.executable ? 0o700 : 0o600); await handle.sync(); } finally { await handle.close(); }
  }
  await writeCommittedFile(join(destination, MANIFEST), Buffer.from(encodeArtifactTreeManifest(manifest, policy)), 0o600);
  await syncDirectoryTree(contentRoot);
  await syncDirectory(destination);
  assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  await writeCommittedFile(join(destination, COMMITTED), Buffer.from(`${treeId}\n`), 0o600);
  await syncDirectory(destination); await syncDirectory(root);
  return { ...await readArtifactTree(home, treeId, policy), reused: false };
}

/** Reads only trees whose final marker proves complete publication. */
export async function readArtifactTree(home: string, treeId: string, lowerLimits: Partial<CapturedProfileLimitPolicy> = {}): Promise<ArtifactTreeSnapshot> {
  const policy = capturedProfileLimitPolicy(lowerLimits); const path = artifactTreePath(home, treeId); let directory;
  try { directory = await openStablePhysicalDirectory(path, home); }
  catch (error) { if (error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT') throw new BazframeError('PROFILE_ARTIFACT_TREE_ABSENT', 'Profile artifact tree is absent.'); throw error; }
  try {
    const top = await enumerateStableDirectory(directory, 3); if (top.join(',') !== 'COMMITTED,manifest.json,root') throw invalid('tree is not atomically committed');
    const marker = await readStablePhysicalFile(stableReadChildPath(directory, COMMITTED), 65); if (!marker.bytes.equals(Buffer.from(`${treeId}\n`))) throw invalid('tree commit marker is invalid');
    const manifestFile = await readStablePhysicalFile(stableReadChildPath(directory, MANIFEST), policy.maxManifestBytes); const manifest = decodeArtifactTreeManifest(manifestFile.bytes, policy);
    if (hash(manifestFile.bytes) !== treeId) throw invalid('manifest hash does not match tree ID');
    const root = await openStablePhysicalDirectory(stableReadChildPath(directory, 'root'), home);
    try {
      const actual = await enumerateFiles(root, home, policy); if (actual.length !== manifest.files.length) throw invalid('tree file closure is invalid');
      for (let index = 0; index < manifest.files.length; index += 1) { const expected = manifest.files[index]!; const current = actual[index]!; if (current.path !== expected.path || current.bytes.byteLength !== expected.bytes || hash(current.bytes) !== expected.sha256 || current.executable !== expected.executable) throw invalid('tree file does not match manifest'); }
      await assertStablePhysicalDirectory(root);
    } finally { await root.handle.close().catch(() => undefined); }
    await assertStablePhysicalDirectory(directory); return { treeId, manifest, path };
  } finally { await directory.handle.close().catch(() => undefined); }
}

/** Safe read-only root discovery. Journal/staging roots are added by the later transaction module before cleanup exists. */
export async function collectArtifactRoots(home: string, extraTreeIds: ReadonlySet<string> = new Set()): Promise<Set<string>> {
  const retained = new Set(extraTreeIds); const profiles = join(home, 'profiles'); let names: string[];
  try { names = (await readdir(profiles)).sort(compare); } catch (error) { if (errorCode(error) === 'ENOENT') return retained; throw error; }
  for (const name of names) { if (!isSafeProfileId(name)) continue; const state = await readOptionalManagedProfileState(home, name); if (state === undefined) continue; for (const resource of state.state.importedResources) if (resource.source.kind !== 'missingRemoteGit') retained.add(resource.source.treeId); }
  return retained;
}

async function enumerateFiles(directory: Awaited<ReturnType<typeof openStablePhysicalDirectory>>, trustedRoot: string, policy: CapturedProfileLimitPolicy, depth = 0, prefix = ''): Promise<Array<{ path: string; bytes: Buffer; executable: boolean }>> {
  if (depth > policy.maxDepth) throw invalid('tree depth exceeds limit'); const result: Array<{ path: string; bytes: Buffer; executable: boolean }> = [];
  for (const name of await enumerateStableDirectory(directory, policy.maxEntries)) {
    const path = stableReadChildPath(directory, name); const logicalPath = prefix === '' ? name : `${prefix}/${name}`; const metadata = await lstat(path, { bigint: true }); if (metadata.isSymbolicLink()) throw invalid('tree contains a link');
    if (metadata.isDirectory()) { const child = await openStablePhysicalDirectory(path, trustedRoot); try { result.push(...await enumerateFiles(child, trustedRoot, policy, depth + 1, logicalPath)); } finally { await child.handle.close().catch(() => undefined); } }
    else if (metadata.isFile()) { const file = await readStablePhysicalFile(path, policy.maxBlobBytes); result.push({ path: logicalPath, bytes: file.bytes, executable: file.executable }); }
    else throw invalid('tree contains a special entry'); if (result.length > policy.maxEntries) throw invalid('tree exceeds entry limit');
  }
  return result.sort((left, right) => compare(left.path, right.path));
}
function portablePath(path: string, policy: CapturedProfileLimitPolicy): boolean { if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || DRIVE.test(path) || path.includes('\\') || path.includes('\0') || Buffer.byteLength(path) > policy.maxPathBytes || hasForbiddenPathCodePoint(path)) return false; const parts = path.split('/'); return parts.length <= policy.maxDepth && parts.every((part) => part !== '' && part !== '.' && part !== '..'); }
function hasForbiddenPathCodePoint(path: string): boolean { for (let index = 0; index < path.length; index += 1) { const value = path.charCodeAt(index); if (value < 0x20 || value === 0x7f || (value >= 0xd800 && value <= 0xdfff)) return true; } return false; }
function assertPortableUnique(paths: readonly string[]): void { const seen = new Set<string>(); for (const path of paths) { const key = path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase(); if (seen.has(key)) throw invalid('tree paths have a portable collision'); seen.add(key); } }
async function writeCommittedFile(path: string, bytes: Uint8Array, mode: number): Promise<void> { const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function syncDirectoryTree(path: string): Promise<void> { for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await syncDirectoryTree(join(path, entry.name)); await syncDirectory(path); }
function hash(bytes: Uint8Array): Sha256 { return createHash('sha256').update(bytes).digest('hex'); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_ARTIFACT_TREE_INVALID', `Invalid profile artifact tree: ${detail}.`); }
