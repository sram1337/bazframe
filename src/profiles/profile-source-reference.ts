import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { isSafeProfileId } from './profile-id.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { profileDirectory } from './profile-store.js';

const REFERENCE_KEYS = ['provider', 'schemaVersion', 'source'] as const;
export const UNKNOWN_REFERENCE_PROVIDER = '<unknown-provider>';
export const UNKNOWN_REFERENCE_SOURCE = '<unknown-source>';

export interface ProfileSourceReference {
  schemaVersion: 1;
  provider: string;
  source: string;
}
export interface ProfileSourceReferencePath {
  provider: string;
  source: string;
  path: string;
  relativePath: string;
}
export interface ProfileSourceReferenceSnapshot {
  reference: ProfileSourceReference;
  path: string;
  device: bigint;
  inode: bigint;
  contentSha256: string;
}
export interface ProfileSourceReferenceDiagnostic {
  provider: string;
  source: string;
  path: string;
}
export interface ProfileSourceReferenceNamespace {
  references: ProfileSourceReferencePath[];
  diagnostics: ProfileSourceReferenceDiagnostic[];
}
export interface ReferencingProfiles {
  profileIds: string[];
  diagnostics: Array<{ profileId: string; diagnostic: ProfileSourceReferenceDiagnostic }>;
}
export interface ProfileSourceReferenceIndex extends ReferencingProfiles {
  identity: string;
}
export interface ProfileSourceReferenceBulkIndex {
  profileIdsBySource: ReadonlyMap<string, readonly string[]>;
  diagnostics: ReferencingProfiles['diagnostics'];
  identity: string;
}

export function profileSourcesDirectory(home: string, profileId: string): string {
  return join(profileDirectory(home, profileId), 'sources');
}
export function profileSourceProviderDirectory(home: string, profileId: string, provider: string): string {
  return join(profileSourcesDirectory(home, profileId), provider);
}
export function profileSourceReferencePath(home: string, profileId: string, provider: string, source: string): string {
  return join(profileSourceProviderDirectory(home, profileId, provider), `${source}.json`);
}
export function encodeProfileSourceReference(reference: ProfileSourceReference): string {
  return `${JSON.stringify({ schemaVersion: 1, provider: reference.provider, source: reference.source }, null, 2)}\n`;
}
export function decodeProfileSourceReference(value: unknown, expectedProvider?: string, expectedSource?: string): ProfileSourceReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('reference must be a JSON object');
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== REFERENCE_KEYS.length || !keys.every((key, index) => key === REFERENCE_KEYS[index])) throw invalid('reference must contain exactly the schema-v1 fields');
  if (candidate.schemaVersion !== 1) throw invalid('unsupported schemaVersion');
  if (typeof candidate.provider !== 'string' || !isSafeSkillId(candidate.provider)) throw invalid('provider is invalid');
  if (typeof candidate.source !== 'string' || !isSafeSkillId(candidate.source)) throw invalid('source is invalid');
  if (expectedProvider !== undefined && candidate.provider !== expectedProvider) throw invalid('provider does not match reference path');
  if (expectedSource !== undefined && candidate.source !== expectedSource) throw invalid('source does not match reference path');
  return { schemaVersion: 1, provider: candidate.provider, source: candidate.source };
}
export async function readProfileSourceReference(path: string, expectedProvider?: string, expectedSource?: string): Promise<ProfileSourceReference> {
  return (await readProfileSourceReferenceSnapshot(path, expectedProvider, expectedSource)).reference;
}
export async function readProfileSourceReferenceSnapshot(path: string, expectedProvider?: string, expectedSource?: string): Promise<ProfileSourceReferenceSnapshot> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw invalid('reference must be a physical regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    if (!after.isFile() || pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
      || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== pathMetadata.dev || after.ino !== pathMetadata.ino) throw invalid('reference identity changed while reading');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw new BazframeError('SOURCE_REFERENCE_INVALID', 'Profile source reference is not valid UTF-8.', { cause: error }); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error) { throw new BazframeError('SOURCE_REFERENCE_INVALID', 'Profile source reference is not valid JSON.', { cause: error }); }
    return {
      reference: decodeProfileSourceReference(value, expectedProvider, expectedSource),
      path,
      device: before.dev,
      inode: before.ino,
      contentSha256: createHash('sha256').update(bytes).digest('hex')
    };
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    if (errorCode(error) === 'ELOOP') throw invalid('reference must be a physical regular file');
    throw new BazframeError('SOURCE_REFERENCE_READ_FAILED', `Could not read profile source reference ${path}${formatCode(error)}`, { cause: error });
  } finally { await handle?.close().catch(() => undefined); }
}
export function sameProfileSourceReferenceSnapshot(left: ProfileSourceReferenceSnapshot, right: ProfileSourceReferenceSnapshot): boolean {
  return left.device === right.device && left.inode === right.inode && left.contentSha256 === right.contentSha256;
}

export async function scanProfileSourceReferences(home: string, profileId: string): Promise<ProfileSourceReferenceNamespace> {
  return scanReferenceRoot(profileSourcesDirectory(home, profileId));
}

interface DirectoryIdentity { device: bigint; inode: bigint }
interface OpenDirectory { path: string; handle: FileHandle; identity: DirectoryIdentity }

export function profileSourceReferenceKey(provider: string, source: string): string {
  return `${provider}/${source}`;
}

export async function findReferencingProfiles(home: string, provider: string, source: string): Promise<ReferencingProfiles> {
  const { profileIds, diagnostics } = await captureProfileSourceReferenceIndex(home, provider, source);
  return { profileIds, diagnostics };
}

export async function captureProfileSourceReferenceIndex(
  home: string,
  provider: string,
  source: string
): Promise<ProfileSourceReferenceIndex> {
  const bulk = await captureProfileSourceReferenceBulkIndex(home);
  return {
    profileIds: [...(bulk.profileIdsBySource.get(profileSourceReferenceKey(provider, source)) ?? [])],
    diagnostics: bulk.diagnostics,
    identity: bulk.identity
  };
}

export async function captureProfileSourceReferenceBulkIndex(
  home: string
): Promise<ProfileSourceReferenceBulkIndex> {
  const rootPath = join(home, 'profiles');
  let rootMetadata;
  try { rootMetadata = await lstat(rootPath, { bigint: true }); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return bulkIndexed(new Map(), [], ['profiles:absent']);
    return invalidProfileBulkIndex();
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return invalidProfileBulkIndex();
  let root: OpenDirectory | undefined;
  try {
    root = await openDirectory(rootPath, identity(rootMetadata));
    const names = await enumerateDirectory(root);
    const profileIdsBySource = new Map<string, string[]>();
    const diagnostics: ReferencingProfiles['diagnostics'] = [];
    const identityParts = [`profiles:${identityText(identity(rootMetadata))}`];
    for (const profileId of names) {
      const safe = isSafeProfileId(profileId);
      const profilePath = join(rootPath, profileId);
      let metadata;
      try { metadata = await lstat(profilePath, { bigint: true }); }
      catch {
        diagnostics.push(indexDiagnostic(safe ? profileId : '<unknown-profile>'));
        identityParts.push(`profile:${profileId}:missing`);
        continue;
      }
      identityParts.push(`profile:${profileId}:${metadata.isSymbolicLink() ? 'link' : metadata.isDirectory() ? 'directory' : 'other'}:${identityText(identity(metadata))}`);
      if (!safe || metadata.isSymbolicLink() || !metadata.isDirectory()) {
        diagnostics.push(indexDiagnostic(safe ? profileId : '<unknown-profile>'));
        continue;
      }
      let profile: OpenDirectory | undefined;
      try {
        profile = await openDirectory(profilePath, identity(metadata));
        const namespace = await scanProfileSourceReferences(home, profileId);
        for (const diagnostic of namespace.diagnostics) diagnostics.push({ profileId, diagnostic });
        for (const path of namespace.references) {
          try {
            const snapshot = await readProfileSourceReferenceSnapshot(path.path, path.provider, path.source);
            identityParts.push(`reference:${profileId}/${path.relativePath}:${snapshot.device}:${snapshot.inode}:${snapshot.contentSha256}:${snapshot.reference.provider}/${snapshot.reference.source}`);
            const key = profileSourceReferenceKey(snapshot.reference.provider, snapshot.reference.source);
            const profileIds = profileIdsBySource.get(key) ?? [];
            profileIds.push(profileId);
            profileIdsBySource.set(key, profileIds);
          } catch {
            diagnostics.push({ profileId, diagnostic: diag(path.provider, path.source, path.relativePath) });
            identityParts.push(`reference:${profileId}/${path.relativePath}:invalid`);
          }
        }
        await assertDirectoryStable(profile);
      } catch {
        diagnostics.push(indexDiagnostic(profileId));
        identityParts.push(`profile:${profileId}:unstable`);
      } finally { await profile?.handle.close().catch(() => undefined); }
    }
    await assertDirectoryStable(root);
    return bulkIndexed(profileIdsBySource, diagnostics, identityParts);
  } catch { return invalidProfileBulkIndex(); }
  finally { await root?.handle.close().catch(() => undefined); }
}

export function sameProfileSourceReferenceIndex(
  left: ProfileSourceReferenceIndex,
  right: ProfileSourceReferenceIndex
): boolean {
  return left.identity === right.identity;
}

async function scanReferenceRoot(rootPath: string): Promise<ProfileSourceReferenceNamespace> {
  let rootMetadata;
  try { rootMetadata = await lstat(rootPath, { bigint: true }); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { references: [], diagnostics: [] };
    return invalidRoot();
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return invalidRoot();
  let root: OpenDirectory | undefined;
  try {
    root = await openDirectory(rootPath, identity(rootMetadata));
    const providers = await enumerateDirectory(root);
    const references: ProfileSourceReferencePath[] = [];
    const diagnostics: ProfileSourceReferenceDiagnostic[] = [];
    for (const providerName of providers) {
      const providerPath = join(rootPath, providerName);
      let providerMetadata;
      try { providerMetadata = await lstat(providerPath, { bigint: true }); }
      catch { diagnostics.push(diag(isSafeSkillId(providerName) ? providerName : UNKNOWN_REFERENCE_PROVIDER, UNKNOWN_REFERENCE_SOURCE, providerName)); continue; }
      if (!isSafeSkillId(providerName) || providerMetadata.isSymbolicLink() || !providerMetadata.isDirectory()) {
        diagnostics.push(diag(isSafeSkillId(providerName) ? providerName : UNKNOWN_REFERENCE_PROVIDER, UNKNOWN_REFERENCE_SOURCE, providerName));
        continue;
      }
      let provider: OpenDirectory | undefined;
      try {
        provider = await openDirectory(providerPath, identity(providerMetadata));
        for (const name of await enumerateDirectory(provider)) {
          const source = sourceFromName(name);
          const path = join(providerPath, name);
          let child;
          try { child = await lstat(path); }
          catch { diagnostics.push(diag(providerName, source ?? UNKNOWN_REFERENCE_SOURCE, `${providerName}/${name}`)); continue; }
          if (source === undefined || child.isSymbolicLink() || !child.isFile()) {
            diagnostics.push(diag(providerName, source ?? UNKNOWN_REFERENCE_SOURCE, `${providerName}/${name}`));
            continue;
          }
          references.push({ provider: providerName, source, path, relativePath: `${providerName}/${name}` });
        }
        await assertDirectoryStable(provider);
      } catch { diagnostics.push(diag(providerName, UNKNOWN_REFERENCE_SOURCE, providerName)); }
      finally { await provider?.handle.close().catch(() => undefined); }
    }
    await assertDirectoryStable(root);
    return { references, diagnostics };
  } catch { return invalidRoot(); }
  finally { await root?.handle.close().catch(() => undefined); }
}

async function openDirectory(path: string, expected: DirectoryIdentity): Promise<OpenDirectory> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(identity(opened), expected)) throw new Error('directory identity changed');
    const directory = { path, handle, identity: expected };
    await assertDirectoryStable(directory);
    return directory;
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}
async function enumerateDirectory(directory: OpenDirectory): Promise<string[]> {
  await assertDirectoryStable(directory);
  const names = (await readdir(directory.path)).sort(compare);
  await assertDirectoryStable(directory);
  return names;
}
async function assertDirectoryStable(directory: OpenDirectory): Promise<void> {
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }), lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || !sameIdentity(identity(opened), directory.identity) || !sameIdentity(identity(current), directory.identity)) {
    throw new Error('directory identity changed');
  }
}
function identity(metadata: { dev: bigint; ino: bigint }): DirectoryIdentity { return { device: metadata.dev, inode: metadata.ino }; }
function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.device === right.device && left.inode === right.inode; }
function bulkIndexed(
  profileIdsBySource: Map<string, string[]>,
  diagnostics: ReferencingProfiles['diagnostics'],
  identityParts: string[]
): ProfileSourceReferenceBulkIndex {
  const sortedDiagnostics = [...diagnostics].sort((left, right) => compare(
    `${left.profileId}\0${left.diagnostic.provider}\0${left.diagnostic.source}\0${left.diagnostic.path}`,
    `${right.profileId}\0${right.diagnostic.provider}\0${right.diagnostic.source}\0${right.diagnostic.path}`
  ));
  const sortedProfileIdsBySource = new Map(
    [...profileIdsBySource.entries()]
      .sort(([left], [right]) => compare(left, right))
      .map(([key, profileIds]) => [key, [...new Set(profileIds)].sort(compare)] as const)
  );
  const material = [
    ...identityParts.sort(compare),
    ...sortedDiagnostics.map((item) => `diagnostic:${item.profileId}:${item.diagnostic.provider}:${item.diagnostic.source}:${item.diagnostic.path}`)
  ].join('\n');
  return {
    profileIdsBySource: sortedProfileIdsBySource,
    diagnostics: sortedDiagnostics,
    identity: createHash('sha256').update(material).digest('hex')
  };
}
function invalidProfileBulkIndex(): ProfileSourceReferenceBulkIndex {
  return bulkIndexed(new Map(), [indexDiagnostic('<unknown-profile>')], ['profiles:invalid']);
}
function identityText(value: DirectoryIdentity): string { return `${value.device}:${value.inode}`; }
function indexDiagnostic(profileId: string): ReferencingProfiles['diagnostics'][number] {
  return { profileId, diagnostic: diag(UNKNOWN_REFERENCE_PROVIDER, UNKNOWN_REFERENCE_SOURCE, '.') };
}
function sourceFromName(name: string): string | undefined { if (!name.endsWith('.json')) return undefined; const source = name.slice(0, -5); return isSafeSkillId(source) ? source : undefined; }
function invalidRoot(): ProfileSourceReferenceNamespace { return { references: [], diagnostics: [diag(UNKNOWN_REFERENCE_PROVIDER, UNKNOWN_REFERENCE_SOURCE, '.')] }; }
function diag(provider: string, source: string, path: string): ProfileSourceReferenceDiagnostic { return { provider, source, path }; }
function invalid(detail: string): BazframeError { return new BazframeError('SOURCE_REFERENCE_INVALID', `Invalid profile source reference: ${detail}.`); }
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
