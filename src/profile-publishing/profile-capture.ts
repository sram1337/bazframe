import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeUtf8Instructions, MAX_EFFECTIVE_INSTRUCTION_BYTES } from '../core/content.js';
import { BazframeError } from '../core/errors.js';
import {
  captureManagedGitExportHealth,
  type ManagedGitExportHealthSnapshot
} from '../providers/managed-git.js';
import {
  managedGitCheckoutsRoot,
  optionalManagedGitRecord,
  pathFreeManagedGitIdentityFromRecord,
  type ManagedGitResourceKind
} from '../providers/managed-git-record.js';
import { profileDirectory } from '../profiles/profile-store.js';
import {
  readCollectionSnapshot,
  sameCollectionSnapshot,
  type SkillCollectionKind
} from '../skill-collections/skill-collection-store.js';
import { verifySkillSnapshot } from '../skill-collections/skill-snapshot.js';
import {
  readDefaultSkillRegistrationSnapshot,
  sameDefaultSkillRegistrationSnapshot
} from '../skills/default-skill-catalog.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { readArtifactTree } from './artifact-tree.js';
import { readStoredBlob } from './blob-store.js';
import {
  capturedResourceId,
  decodeCapturedProfileObject,
  encodeCapturedProfile,
  ordinaryResourceIdentity,
  profileInstanceIdFromPhysicalIdentity,
  profileLocalResourceIdentity,
  profileLocalResourceInstanceId,
  resourceIdentityDigest,
  type BlobFile,
  type BlobRecord,
  type BundledPayload,
  type CapturedProfileV1,
  type CapturedResource,
  type ExactRemoteGitIdentity,
  type ResourceKind,
  type Sha256
} from './captured-profile.js';
import { readOptionalManagedProfileState } from './managed-profile-state.js';
import {
  capturePhysicalProfileExpectation,
  physicalProfileLocalSkillNames,
  type PhysicalProfileExpectation
} from './physical-profile-closure.js';
import {
  assertStablePhysicalDirectory,
  compare,
  enumerateStableDirectory,
  openStablePhysicalDirectory,
  readStablePhysicalFile,
  stableReadChildPath
} from './profile-filesystem.js';
import {
  capturedProfileLimitPolicy,
  type CapturedProfileLimitPolicy
} from './profile-publishing-policy.js';

export interface ProfileCaptureOptions {
  bazframeHome: string;
  profileId: string;
  bundleRemote?: boolean;
  environment?: NodeJS.ProcessEnv;
}

export interface CapturedBlobSnapshot extends BlobRecord {
  bytesValue: Buffer;
}

export interface ProfileCapturePreviewEntry {
  path: string;
  sha256: Sha256;
  bytes: number;
  executable: boolean;
}

export interface ProfileCaptureSnapshot {
  /** Local-only identity used to classify physical profile-local Skills; never serialized in the transport manifest. */
  profileInstanceId: string;
  profile: CapturedProfileV1;
  manifestBytes: Buffer;
  blobs: CapturedBlobSnapshot[];
  preview: ProfileCapturePreviewEntry[];
  complete: boolean;
  missingResourceIds: Sha256[];
}

export interface CatalogResourceCaptureOptions {
  bazframeHome: string;
  kind: ResourceKind;
  name: string;
  capturedResourceId: Sha256;
  bundleRemote?: boolean;
  environment?: NodeJS.ProcessEnv;
}

export interface CatalogResourceCaptureSnapshot {
  resource: CapturedResource;
  blobs: CapturedBlobSnapshot[];
}

export interface ProfileCaptureDependencies {
  limitPolicy?: Partial<CapturedProfileLimitPolicy>;
  captureManagedGitHealth?: typeof captureManagedGitExportHealth;
  testHooks?: {
    afterPass?: (pass: 1 | 2) => void | Promise<void>;
    duringFileCapture?: (absolutePath: string) => void | Promise<void>;
  };
}

interface CaptureContext {
  home: string;
  profileId: string;
  bundleRemote: boolean;
  environment: NodeJS.ProcessEnv;
  policy: Readonly<CapturedProfileLimitPolicy>;
  captureManagedGitHealth: typeof captureManagedGitExportHealth;
  duringFileCapture?: (absolutePath: string) => void | Promise<void>;
  blobs: Map<Sha256, CapturedBlobSnapshot>;
  aggregateBlobBytes: number;
  traversedEntries: number;
  preview: ProfileCapturePreviewEntry[];
}

const EXCLUDED_SEGMENTS = new Set([
  '.git', 'node_modules', 'test', 'tests',
  '.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials'
]);
const PRIVATE_KEY_FILENAME = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u;
const PRIVATE_KEY_EXTENSION = /\.(?:pem|key|p12|pfx)$/u;
const KIND_ORDER: Record<ResourceKind, number> = { skill: 0, library: 1, package: 2 };

export async function captureProfile(options: ProfileCaptureOptions, dependencies: ProfileCaptureDependencies = {}): Promise<ProfileCaptureSnapshot> {
  const copied = copyOptions(options);
  const policy = capturedProfileLimitPolicy(dependencies.limitPolicy);
  const captureManagedGitHealth = dependencies.captureManagedGitHealth ?? captureManagedGitExportHealth;
  const first = await captureOnce(copied, policy, captureManagedGitHealth, dependencies.testHooks?.duringFileCapture);
  await dependencies.testHooks?.afterPass?.(1);
  const second = await captureOnce(copied, policy, captureManagedGitHealth, dependencies.testHooks?.duringFileCapture);
  requireSameCapture(first, second);
  await dependencies.testHooks?.afterPass?.(2);
  return copySnapshot(second);
}

/** Captures one ordinary catalog instance twice for exact retained-identity reuse. */
export async function captureCatalogResource(
  options: CatalogResourceCaptureOptions,
  dependencies: ProfileCaptureDependencies = {}
): Promise<CatalogResourceCaptureSnapshot> {
  if (options === null || typeof options !== 'object'
    || (options.kind !== 'skill' && options.kind !== 'library' && options.kind !== 'package')
    || !isSafeSkillId(options.name)
    || !/^[a-f0-9]{64}$/u.test(options.capturedResourceId)) throw invalid('catalog resource capture options are invalid');
  const policy = capturedProfileLimitPolicy(dependencies.limitPolicy);
  const captureManagedGitHealth = dependencies.captureManagedGitHealth ?? captureManagedGitExportHealth;
  const copied = {
    bazframeHome: options.bazframeHome,
    kind: options.kind,
    name: options.name,
    capturedResourceId: options.capturedResourceId,
    bundleRemote: options.bundleRemote === true,
    environment: { ...(options.environment ?? process.env) }
  };
  const first = await captureCatalogOnce(copied, policy, captureManagedGitHealth, dependencies.testHooks?.duringFileCapture);
  await dependencies.testHooks?.afterPass?.(1);
  const second = await captureCatalogOnce(copied, policy, captureManagedGitHealth, dependencies.testHooks?.duringFileCapture);
  requireSameCatalogCapture(first, second);
  await dependencies.testHooks?.afterPass?.(2);
  return copyCatalogSnapshot(second);
}

async function captureCatalogOnce(
  options: Required<CatalogResourceCaptureOptions>,
  policy: Readonly<CapturedProfileLimitPolicy>,
  captureManagedGitHealth: typeof captureManagedGitExportHealth,
  duringFileCapture?: (absolutePath: string) => void | Promise<void>
): Promise<CatalogResourceCaptureSnapshot> {
  const context: CaptureContext = {
    home: options.bazframeHome,
    profileId: 'catalog-capture',
    bundleRemote: options.bundleRemote,
    environment: options.environment,
    policy,
    captureManagedGitHealth,
    ...(duringFileCapture === undefined ? {} : { duringFileCapture }),
    blobs: new Map(),
    aggregateBlobBytes: 0,
    traversedEntries: 0,
    preview: []
  };
  const resource = await captureOrdinaryResource(context, options.kind, options.name, options.capturedResourceId);
  const blobs = [...context.blobs.values()].sort((left, right) => compare(left.sha256, right.sha256));
  validateStandaloneResource(resource, blobs, policy);
  return { resource: structuredClone(resource), blobs: blobs.map(copyBlob) };
}

async function captureOnce(
  options: Required<ProfileCaptureOptions>,
  policy: Readonly<CapturedProfileLimitPolicy>,
  captureManagedGitHealth: typeof captureManagedGitExportHealth,
  duringFileCapture?: (absolutePath: string) => void | Promise<void>
): Promise<ProfileCaptureSnapshot> {
  const context: CaptureContext = {
    home: options.bazframeHome,
    profileId: options.profileId,
    bundleRemote: options.bundleRemote,
    environment: options.environment,
    policy,
    captureManagedGitHealth,
    ...(duringFileCapture === undefined ? {} : { duringFileCapture }),
    blobs: new Map(),
    aggregateBlobBytes: 0,
    traversedEntries: 0,
    preview: []
  };
  const physical = await capturePhysicalProfileExpectation(context.home, context.profileId, policy);
  const instructionsPath = join(profileDirectory(context.home, context.profileId), 'AGENTS.md');
  const instructionFile = await readStablePhysicalFile(instructionsPath, Math.min(policy.maxBlobBytes, MAX_EFFECTIVE_INSTRUCTION_BYTES));
  decodeUtf8Instructions(instructionFile.bytes, `Profile ${JSON.stringify(context.profileId)} instructions`, instructionsPath);
  const instructions = addBlobFile(context, 'AGENTS.md', instructionFile.bytes, instructionFile.executable, 'profile/AGENTS.md');

  const managedState = await readOptionalManagedProfileState(context.home, context.profileId, policy);
  const profileInstanceId = managedState?.state.profileInstanceId ?? profileInstanceIdFromPhysicalIdentity(physical.identity);
  const retainedIds = new Map<string, Sha256>();
  if (managedState !== undefined) {
    for (const binding of managedState.state.capturedResourceIds) retainedIds.set(binding.resourceIdentityDigest, binding.capturedResourceId);
  }

  const resources: CapturedResource[] = [];
  const seenResourceIds = new Set<string>();
  for (const entry of physical.closure.entries) {
    if (entry.kind !== 'membership-link') continue;
    const parsed = parseOrdinaryIdentity(entry.targetIdentity);
    const identity = ordinaryResourceIdentity(parsed.kind, parsed.name);
    const id = retainedIds.get(resourceIdentityDigest(identity)) ?? capturedResourceId(parsed.kind, identity);
    const resource = await captureOrdinaryResource(context, parsed.kind, parsed.name, id);
    addResource(resources, seenResourceIds, resource, policy);
  }
  for (const name of physicalProfileLocalSkillNames(physical.closure)) {
    const instanceId = profileLocalResourceInstanceId(profileInstanceId, name);
    const identity = profileLocalResourceIdentity(instanceId);
    const canonicalId = capturedResourceId('skill', identity);
    const retainedId = retainedIds.get(resourceIdentityDigest(identity));
    const id = retainedId ?? canonicalId;
    const payload = await captureBundledRoot(context, 'skill', name, id, join(profileDirectory(context.home, context.profileId), 'skills', name), undefined, 'profile-local');
    addResource(resources, seenResourceIds, { id, key: { kind: 'skill', name }, payload }, policy);
  }

  const missingResourceIds: Sha256[] = [];
  if (managedState !== undefined) {
    for (const imported of managedState.state.importedResources) {
      if (seenResourceIds.has(imported.capturedResourceId)) continue;
      const resource = await captureImportedResource(context, imported);
      addResource(resources, seenResourceIds, resource, policy);
      if (imported.source.kind === 'missingRemoteGit') missingResourceIds.push(imported.capturedResourceId);
    }
  }

  resources.sort(compareResources);
  const blobs = [...context.blobs.values()].sort((left, right) => compare(left.sha256, right.sha256));
  const profile = decodeCapturedProfileObject({
    schemaVersion: 1,
    kind: 'bazframe-captured-profile',
    profile: { name: context.profileId, instructions },
    resources,
    blobs: blobs.map(({ sha256, bytes }) => ({ sha256, bytes }))
  }, policy);
  const manifestBytes = Buffer.from(encodeCapturedProfile(profile, policy));
  await assertPhysicalExpectationUnchanged(context, physical);
  context.preview.sort((left, right) => compare(left.path, right.path));
  missingResourceIds.sort(compare);
  return { profileInstanceId, profile, manifestBytes, blobs, preview: context.preview, complete: missingResourceIds.length === 0, missingResourceIds };
}

async function captureOrdinaryResource(context: CaptureContext, kind: ResourceKind, name: string, id: Sha256): Promise<CapturedResource> {
  if (kind === 'skill') {
    const registration = await readDefaultSkillRegistrationSnapshot(context.home, name);
    const managed = await optionalManaged(context, 'skill', name);
    if (managed !== undefined) {
      if (managed.recordSnapshot.record.root !== registration.target) throw invalid(`remote Git provenance does not match Skill ${JSON.stringify(name)}`);
      if (!context.bundleRemote) return remoteResource(kind, name, id, pathFreeManagedGitIdentityFromRecord(managed.recordSnapshot.record));
    } else if (isWithin(managedGitCheckoutsRoot(context.home), registration.target)) {
      throw invalid(`managed checkout Skill ${JSON.stringify(name)} has no exact provenance`);
    }
    const payload = await captureBundledRoot(context, kind, name, id, registration.target, managed === undefined ? undefined : pathFreeManagedGitIdentityFromRecord(managed.recordSnapshot.record));
    const final = await readDefaultSkillRegistrationSnapshot(context.home, name);
    if (!sameDefaultSkillRegistrationSnapshot(registration, final)) throw changed();
    return { id, key: { kind, name }, payload };
  }

  const collectionKind = kind as SkillCollectionKind;
  const record = await readCollectionSnapshot(context.home, { kind: collectionKind, id: name }, { maxBytes: context.policy.maxManifestBytes });
  const managed = await optionalManaged(context, collectionKind, name);
  if (managed !== undefined) {
    if (managed.recordSnapshot.record.root !== record.record.root || managed.collectionSnapshot === undefined || !sameCollectionSnapshot(record, managed.collectionSnapshot)) throw changed();
    if (!context.bundleRemote) return remoteResource(kind, name, id, pathFreeManagedGitIdentityFromRecord(managed.recordSnapshot.record));
  } else if (isWithin(managedGitCheckoutsRoot(context.home), record.record.root)) {
    throw invalid(`${kind} ${JSON.stringify(name)} has managed checkout state without provenance`);
  }
  let snapshot;
  try { snapshot = await verifySkillSnapshot(context.home, record.record.digest); }
  catch (error) {
    if (kind === 'package') throw new BazframeError('PROFILE_PACKAGE_ARTIFACT_UNAVAILABLE', `Package ${JSON.stringify(name)} has no healthy build artifacts. Run \`bazframe package build ${name}\`.`, { cause: error });
    throw error;
  }
  const payload = await captureBundledRoot(context, kind, name, id, snapshot.artifactPath, managed === undefined ? undefined : pathFreeManagedGitIdentityFromRecord(managed.recordSnapshot.record));
  const final = await readCollectionSnapshot(context.home, { kind: collectionKind, id: name }, { maxBytes: context.policy.maxManifestBytes });
  if (!sameCollectionSnapshot(record, final)) throw changed();
  return { id, key: { kind, name }, payload };
}

async function captureImportedResource(
  context: CaptureContext,
  imported: NonNullable<Awaited<ReturnType<typeof readOptionalManagedProfileState>>>['state']['importedResources'][number]
): Promise<CapturedResource> {
  const { source, key, capturedResourceId: id } = imported;
  if (source.kind === 'missingRemoteGit') return remoteResource(key.kind, key.name, id, source.identity);
  if (source.kind === 'remoteGit' && !context.bundleRemote) return remoteResource(key.kind, key.name, id, source.identity);
  const tree = await readArtifactTree(context.home, source.treeId, context.policy);
  const expectedRole = key.kind === 'package' ? 'packageArtifacts' : key.kind;
  if (tree.manifest.role !== expectedRole) throw invalid('imported artifact-tree role does not match its resource kind');
  const files: BlobFile[] = [];
  for (const file of tree.manifest.files) {
    const bytes = await readStoredBlob(context.home, file.sha256, context.policy);
    files.push(addBlobFile(context, file.path, bytes, file.executable, previewPath(id, file.path)));
  }
  const origin = source.kind === 'artifact' ? source.origin : source.identity;
  const payload: BundledPayload = origin === undefined
    ? { kind: 'bundled', role: expectedRole, files }
    : { kind: 'bundled', role: expectedRole, origin, files };
  return { id, key: { ...key }, payload };
}

async function captureBundledRoot(
  context: CaptureContext,
  kind: ResourceKind,
  name: string,
  resourceId: Sha256,
  rootPath: string,
  origin?: ExactRemoteGitIdentity,
  sourceForm?: 'profile-local'
): Promise<BundledPayload> {
  const files: BlobFile[] = [];
  const root = await openStablePhysicalDirectory(rootPath);
  try {
    await captureDirectory(context, root, '', 0, files, resourceId);
    await assertStablePhysicalDirectory(root);
  } finally { await root.handle.close().catch(() => undefined); }
  const role = kind === 'package' ? 'packageArtifacts' : kind;
  if (origin !== undefined && sourceForm !== undefined) throw invalid('bundled capture cannot combine origin and source form');
  return origin !== undefined
    ? { kind: 'bundled', role, origin, files }
    : sourceForm === 'profile-local'
      ? { kind: 'bundled', role, sourceForm, files }
      : { kind: 'bundled', role, files };
}

async function captureDirectory(
  context: CaptureContext,
  directory: Awaited<ReturnType<typeof openStablePhysicalDirectory>>,
  prefix: string,
  depth: number,
  files: BlobFile[],
  resourceId: Sha256
): Promise<void> {
  if (depth > context.policy.maxDepth) throw invalid('resource tree exceeds its depth limit');
  for (const name of await enumerateStableDirectory(directory, context.policy.maxEntries)) {
    context.traversedEntries += 1;
    if (context.traversedEntries > context.policy.maxEntries) throw invalid('captured closure exceeds its entry limit');
    if (isExcludedCapturedResourcePath(name)) continue;
    const logical = prefix === '' ? name : `${prefix}/${name}`;
    const path = stableReadChildPath(directory, name);
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink()) throw invalid('ready-to-use content contains a symbolic link');
    if (metadata.isDirectory()) {
      const child = await openStablePhysicalDirectory(path, directory.trustedRoot);
      try { await captureDirectory(context, child, logical, depth + 1, files, resourceId); }
      finally { await child.handle.close().catch(() => undefined); }
    } else if (metadata.isFile()) {
      await context.duringFileCapture?.(path);
      const file = await readStablePhysicalFile(path, context.policy.maxBlobBytes);
      files.push(addBlobFile(context, logical, file.bytes, file.executable, previewPath(resourceId, logical)));
    } else {
      throw invalid('ready-to-use content contains a special file');
    }
  }
  files.sort((left, right) => compare(left.path, right.path));
  await assertStablePhysicalDirectory(directory);
}

function addBlobFile(context: CaptureContext, path: string, bytes: Uint8Array, executable: boolean, preview: string): BlobFile {
  const value = Buffer.from(bytes);
  const sha256 = createHash('sha256').update(value).digest('hex');
  const existing = context.blobs.get(sha256);
  if (existing === undefined) {
    context.aggregateBlobBytes += value.byteLength;
    if (!Number.isSafeInteger(context.aggregateBlobBytes) || context.aggregateBlobBytes > context.policy.maxAggregateBytes) throw invalid('captured blob bytes exceed their aggregate limit');
    context.blobs.set(sha256, { sha256, bytes: value.byteLength, bytesValue: value });
  } else if (existing.bytes !== value.byteLength || !existing.bytesValue.equals(value)) {
    throw invalid('captured blob digest collision');
  }
  const result = { path, sha256, bytes: value.byteLength, executable };
  context.preview.push({ path: preview, sha256, bytes: value.byteLength, executable });
  return result;
}

async function optionalManaged(context: CaptureContext, kind: ManagedGitResourceKind, id: string): Promise<ManagedGitExportHealthSnapshot | undefined> {
  const provenance = await optionalManagedGitRecord(context.home, kind, id);
  if (provenance === undefined) return undefined;
  return context.captureManagedGitHealth(context.home, kind, id, context.environment);
}

function remoteResource(kind: ResourceKind, name: string, id: Sha256, identity: ExactRemoteGitIdentity): CapturedResource {
  return { id, key: { kind, name }, payload: { kind: 'remoteGit', identity } };
}

function addResource(resources: CapturedResource[], seen: Set<string>, resource: CapturedResource, policy: Readonly<CapturedProfileLimitPolicy>): void {
  if (seen.has(resource.id)) throw invalid('captured resource IDs are not unique');
  seen.add(resource.id);
  resources.push(resource);
  if (resources.length > policy.maxResources || resources.length > policy.maxProfileEntries) throw invalid('captured resources exceed their limit');
}

function parseOrdinaryIdentity(value: string): { kind: ResourceKind; name: string } {
  const match = /^catalog:(skill|library|package):(.+)$/u.exec(value);
  if (match === null || !isSafeSkillId(match[2]!)) throw invalid('profile membership identity is invalid');
  return { kind: match[1] as ResourceKind, name: match[2]! };
}

function compareResources(left: CapturedResource, right: CapturedResource): number {
  return KIND_ORDER[left.key.kind] - KIND_ORDER[right.key.kind] || compare(left.key.name, right.key.name) || compare(left.id, right.id);
}

export function isExcludedCapturedResourcePath(path: string): boolean {
  return path.split('/').some((segment) => {
    const normalized = segment.normalize('NFC').toLowerCase();
    return EXCLUDED_SEGMENTS.has(normalized)
      || normalized.startsWith('.env.')
      || normalized.startsWith('.git-credentials.')
      || normalized.startsWith('credentials.')
      || PRIVATE_KEY_FILENAME.test(normalized)
      || PRIVATE_KEY_EXTENSION.test(normalized);
  });
}

function previewPath(resourceId: string, relativePath: string): string { return `resources/${resourceId}/${relativePath}`; }

function copyOptions(options: ProfileCaptureOptions): Required<ProfileCaptureOptions> {
  if (options === null || typeof options !== 'object' || typeof options.bazframeHome !== 'string' || typeof options.profileId !== 'string') throw invalid('capture options are invalid');
  return {
    bazframeHome: options.bazframeHome,
    profileId: options.profileId,
    bundleRemote: options.bundleRemote === true,
    environment: { ...(options.environment ?? process.env) }
  };
}

function requireSameCatalogCapture(left: CatalogResourceCaptureSnapshot, right: CatalogResourceCaptureSnapshot): void {
  if (JSON.stringify(left.resource) !== JSON.stringify(right.resource)
    || left.blobs.length !== right.blobs.length
    || left.blobs.some((blob, index) => blob.sha256 !== right.blobs[index]?.sha256 || blob.bytes !== right.blobs[index]?.bytes || !blob.bytesValue.equals(right.blobs[index]!.bytesValue))) throw changed();
}

function validateStandaloneResource(resource: CapturedResource, blobs: readonly CapturedBlobSnapshot[], policy: Readonly<CapturedProfileLimitPolicy>): void {
  const emptySha = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  const records = new Map<Sha256, BlobRecord>(blobs.map((blob) => [blob.sha256, { sha256: blob.sha256, bytes: blob.bytes }]));
  if (!records.has(emptySha)) records.set(emptySha, { sha256: emptySha, bytes: 0 });
  decodeCapturedProfileObject({
    schemaVersion: 1,
    kind: 'bazframe-captured-profile',
    profile: { name: 'catalog-capture', instructions: { path: 'AGENTS.md', sha256: emptySha, bytes: 0, executable: false } },
    resources: [resource],
    blobs: [...records.values()].sort((left, right) => compare(left.sha256, right.sha256))
  }, policy);
}

function requireSameCapture(left: ProfileCaptureSnapshot, right: ProfileCaptureSnapshot): void {
  if (left.profileInstanceId !== right.profileInstanceId
    || !left.manifestBytes.equals(right.manifestBytes)
    || left.blobs.length !== right.blobs.length
    || left.blobs.some((blob, index) => blob.sha256 !== right.blobs[index]!.sha256 || !blob.bytesValue.equals(right.blobs[index]!.bytesValue))) {
    throw changed();
  }
}

function copyBlob(blob: CapturedBlobSnapshot): CapturedBlobSnapshot { return { sha256: blob.sha256, bytes: blob.bytes, bytesValue: Buffer.from(blob.bytesValue) }; }
function copyCatalogSnapshot(snapshot: CatalogResourceCaptureSnapshot): CatalogResourceCaptureSnapshot {
  return { resource: structuredClone(snapshot.resource), blobs: snapshot.blobs.map(copyBlob) };
}

function copySnapshot(snapshot: ProfileCaptureSnapshot): ProfileCaptureSnapshot {
  return {
    profileInstanceId: snapshot.profileInstanceId,
    profile: structuredClone(snapshot.profile),
    manifestBytes: Buffer.from(snapshot.manifestBytes),
    blobs: snapshot.blobs.map((blob) => ({ sha256: blob.sha256, bytes: blob.bytes, bytesValue: Buffer.from(blob.bytesValue) })),
    preview: snapshot.preview.map((entry) => ({ ...entry })),
    complete: snapshot.complete,
    missingResourceIds: [...snapshot.missingResourceIds]
  };
}

async function assertPhysicalExpectationUnchanged(context: CaptureContext, expected: PhysicalProfileExpectation): Promise<void> {
  const current = await capturePhysicalProfileExpectation(context.home, context.profileId, context.policy);
  if (current.identity !== expected.identity || current.sidecarSha256 !== expected.sidecarSha256 || current.profileClosureSha256 !== expected.profileClosureSha256) throw changed();
}

function isWithin(parent: string, child: string): boolean {
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child === parent || child.startsWith(prefix);
}

function changed(): BazframeError { return new BazframeError('PROFILE_CAPTURE_CHANGED', 'Profile or ready-to-use resources changed during capture.'); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_CAPTURE_INVALID', `Invalid profile capture: ${detail}.`); }
