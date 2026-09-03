import { createHash, randomUUID } from 'node:crypto';
import { mkdir, symlink } from 'node:fs/promises';
import { types as utilTypes } from 'node:util';
import { basename, join } from 'node:path';
import { BazframeError } from '../core/errors.js';
import { encodeProfileCollectionReference } from '../profiles/profile-skill-collection-reference.js';
import { readDefaultSkillRegistrationLink } from '../skills/default-skill-catalog.js';
import { publishArtifactTree, readArtifactTree, type ArtifactTreeManifestV1 } from './artifact-tree.js';
import { publishStoredBlob } from './blob-store.js';
import {
  assertBlobBytes,
  decodeCapturedProfileObject,
  importedResourceIdentity,
  ordinaryResourceIdentity,
  profileLocalResourceIdentity,
  profileLocalResourceInstanceId,
  resourceIdentityDigest,
  type CapturedProfileV1,
  type CapturedResource,
  type ExactRemoteGitIdentity,
  type Sha256
} from './captured-profile.js';
import { openStablePhysicalDirectory, writeOwnedStagingFileAtomic } from './profile-filesystem.js';
import { operationAuthorityTransactionId, type OperationMutationAuthority } from './profile-operation-lock.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { readProfileSystemView } from './profile-view.js';
import type {
  CapturedResourceIdBinding,
  ImportedResourceState,
  ManagedProfileStateV1,
  PublicationState
} from './publication-state.js';

export interface CapturedBlobSource {
  sha256: Sha256;
  bytes: number;
  bytesValue: Uint8Array;
}

export type RemoteMaterializationResult =
  | { kind: 'ready'; treeId: Sha256; identity: ExactRemoteGitIdentity; cacheWritten: boolean; buildExecuted: boolean }
  /** Only exact-revision acquisition unavailability may use this branch; authorization, build, drift, and integrity failures throw. */
  | { kind: 'acquisitionUnavailable'; diagnosticCode: string; cacheWritten: boolean; buildExecuted: boolean };

export interface OrdinaryResourceMaterializationSnapshot {
  resource: CapturedResource;
  blobs: readonly CapturedBlobSource[];
}

export interface ProfileMaterializationOptions {
  home: string;
  candidateDirectory: string;
  authority: OperationMutationAuthority;
  captured: CapturedProfileV1;
  blobs: readonly CapturedBlobSource[];
  previousState?: ManagedProfileStateV1;
  publication?: PublicationState | null;
  allowIncomplete: boolean;
  /** Retains Git-linked captured-resource bindings across version removal/reintroduction. */
  preserveCapturedResourceBindings?: boolean;
  captureOrdinary?(resource: CapturedResource): Promise<OrdinaryResourceMaterializationSnapshot>;
  materializeRemote(resource: CapturedResource): Promise<RemoteMaterializationResult>;
}

export interface ProfileMaterializationResult {
  state: ManagedProfileStateV1;
  missingResourceIds: Sha256[];
  treeIds: Sha256[];
  effects: { cacheWritten: boolean; buildExecuted: boolean };
  revalidateOrdinary(): Promise<void>;
}

export async function materializeCapturedProfile(options: ProfileMaterializationOptions): Promise<ProfileMaterializationResult> {
  const transactionId = operationAuthorityTransactionId(options.authority);
  if (basename(options.candidateDirectory) !== `.bazframe-candidate-${transactionId}`) throw invalid('candidate does not belong to the active transaction');
  const captured = decodeCapturedProfileObject(options.captured, capturedProfileLimitPolicy());
  const blobByDigest = validatedBlobMap(captured, options.blobs);
  const instructions = requiredBlob(captured.profile.instructions.sha256, blobByDigest);
  const candidate = await openStablePhysicalDirectory(options.candidateDirectory, options.home);
  try {
    await writeOwnedStagingFileAtomic(candidate, 'AGENTS.md', instructions.bytesValue, options.captured.profile.instructions.executable ? 0o700 : 0o600);
  } finally { await candidate.handle.close().catch(() => undefined); }

  const profileInstanceId = options.previousState?.profileInstanceId ?? randomUUID();
  const previousByCapture = new Map((options.previousState?.importedResources ?? []).map((resource) => [resource.capturedResourceId, resource]));
  const retainedBindings = (options.preserveCapturedResourceBindings ?? options.previousState !== undefined)
    ? new Map((options.previousState?.capturedResourceIds ?? []).map((binding) => [binding.capturedResourceId, { ...binding }]))
    : new Map<Sha256, CapturedResourceIdBinding>();
  const importedResources: ImportedResourceState[] = [];
  const currentBindings: CapturedResourceIdBinding[] = [];
  const missingResourceIds: Sha256[] = [];
  const treeIds = new Set<Sha256>();
  const ordinaryProofs: Array<{ resource: CapturedResource; snapshot: OrdinaryResourceMaterializationSnapshot }> = [];
  let cacheWritten = false;
  let buildExecuted = false;

  for (const resource of captured.resources) {
    const previous = previousByCapture.get(resource.id);
    const retained = retainedBindings.get(resource.id);
    if (retained?.identityKind === 'catalog') {
      const expectedDigest = resourceIdentityDigest(ordinaryResourceIdentity(resource.key.kind, resource.key.name));
      if (retained.resourceIdentityDigest !== expectedDigest || previous !== undefined) throw invalid('retained ordinary binding does not match its resource key');
      if (options.captureOrdinary === undefined) throw invalid('retained ordinary resource cannot be proved from the catalog');
      const snapshot = copyOrdinarySnapshot(await options.captureOrdinary(resource));
      assertOrdinarySnapshot(resource, snapshot, blobByDigest);
      await writeOrdinaryMembership(options.home, options.candidateDirectory, resource);
      currentBindings.push({ ...retained });
      ordinaryProofs.push({ resource: structuredClone(resource), snapshot });
      continue;
    }
    const expectedLocalInstanceId = resource.key.kind === 'skill' ? profileLocalResourceInstanceId(profileInstanceId, resource.key.name) : undefined;
    const expectedLocalIdentity = expectedLocalInstanceId === undefined ? undefined : profileLocalResourceIdentity(expectedLocalInstanceId);
    const markedProfileLocal = resource.payload.kind === 'bundled' && resource.payload.sourceForm === 'profile-local';
    const isProfileLocalSourceForm = resource.key.kind === 'skill' && markedProfileLocal;
    if (retained?.identityKind === 'profileLocal' || (retained === undefined && isProfileLocalSourceForm)) {
      if (resource.key.kind !== 'skill' || resource.payload.kind !== 'bundled' || resource.payload.role !== 'skill' || resource.payload.origin !== undefined || resource.payload.sourceForm !== 'profile-local' || previous !== undefined || expectedLocalInstanceId === undefined || expectedLocalIdentity === undefined) throw invalid('retained profile-local resource is not a marked local bundled Skill');
      const expectedDigest = resourceIdentityDigest(expectedLocalIdentity);
      if (retained !== undefined && (retained.instanceId !== expectedLocalInstanceId || retained.resourceIdentityDigest !== expectedDigest)) throw invalid('retained profile-local binding does not match its resource key');
      await writeProfileLocalSkill(options.candidateDirectory, resource, blobByDigest);
      currentBindings.push(retained ?? { resourceIdentityDigest: expectedDigest, capturedResourceId: resource.id, identityKind: 'profileLocal', instanceId: expectedLocalInstanceId });
      continue;
    }
    if (retained !== undefined && retained.identityKind !== 'imported') throw invalid('retained resource binding kind is invalid');
    const instanceId = previous?.instanceId
      ?? retained?.instanceId
      ?? derivedImportedInstanceId(profileInstanceId, resource.id);
    const identityDigest = resourceIdentityDigest(importedResourceIdentity(instanceId));
    currentBindings.push({ resourceIdentityDigest: identityDigest, capturedResourceId: resource.id, identityKind: 'imported', instanceId });

    if (resource.payload.kind === 'bundled') {
      for (const file of resource.payload.files) {
        const blob = requiredBlob(file.sha256, blobByDigest);
        const published = await publishStoredBlob(options.home, options.authority, blob.bytesValue, blob.sha256);
        cacheWritten ||= !published.reused;
      }
      const manifest: ArtifactTreeManifestV1 = {
        schemaVersion: 1,
        kind: 'bazframe-artifact-tree',
        role: resource.payload.role,
        files: resource.payload.files.map((file) => ({ ...file }))
      };
      const tree = await publishArtifactTree(options.home, options.authority, manifest);
      cacheWritten ||= !tree.reused;
      treeIds.add(tree.treeId);
      importedResources.push({
        instanceId,
        capturedResourceId: resource.id,
        key: { ...resource.key },
        source: resource.payload.origin === undefined
          ? { kind: 'artifact', treeId: tree.treeId }
          : { kind: 'artifact', treeId: tree.treeId, origin: structuredClone(resource.payload.origin) }
      });
      continue;
    }

    const cachedTreeId = await findCachedRemoteTree(options.home, resource);
    const remote = cachedTreeId === undefined
      ? validateRemoteResult(await options.materializeRemote(resource))
      : { kind: 'ready' as const, treeId: cachedTreeId, identity: structuredClone(resource.payload.identity), cacheWritten: false, buildExecuted: false };
    cacheWritten ||= remote.cacheWritten;
    buildExecuted ||= remote.buildExecuted;
    if (remote.kind === 'ready') {
      if (!sameExactIdentity(remote.identity, resource.payload.identity)) throw invalid('remote materialization identity does not match the captured exact revision');
      const tree = await readArtifactTree(options.home, remote.treeId);
      if (tree.manifest.role !== roleFor(resource.key.kind)) throw invalid('remote materialization artifact role does not match the captured resource');
      treeIds.add(remote.treeId);
      importedResources.push({
        instanceId,
        capturedResourceId: resource.id,
        key: { ...resource.key },
        source: { kind: 'remoteGit', identity: structuredClone(resource.payload.identity), treeId: remote.treeId }
      });
      continue;
    }
    if (remote.kind !== 'acquisitionUnavailable') throw invalid('remote materializer returned an unknown result');
    if (!options.allowIncomplete) {
      throw new BazframeError('PROFILE_REMOTE_RESOURCE_UNAVAILABLE', `Required remote resource ${JSON.stringify(resource.key.name)} is unavailable.`);
    }
    missingResourceIds.push(resource.id);
    importedResources.push({
      instanceId,
      capturedResourceId: resource.id,
      key: { ...resource.key },
      source: { kind: 'missingRemoteGit', identity: structuredClone(resource.payload.identity), diagnosticCode: remote.diagnosticCode }
    });
  }

  for (const binding of currentBindings) {
    for (const [capturedId, retained] of retainedBindings) {
      if (capturedId !== binding.capturedResourceId && retained.resourceIdentityDigest === binding.resourceIdentityDigest) retainedBindings.delete(capturedId);
    }
    retainedBindings.set(binding.capturedResourceId, binding);
  }
  const currentProfileLocalIds = new Set(currentBindings.filter((binding) => binding.identityKind === 'profileLocal').map((binding) => binding.capturedResourceId));
  for (const [capturedId, binding] of retainedBindings) if (binding.identityKind === 'profileLocal' && !currentProfileLocalIds.has(capturedId)) retainedBindings.delete(capturedId);
  const capturedResourceIds = [...retainedBindings.values()];
  capturedResourceIds.sort((left, right) => left.resourceIdentityDigest.localeCompare(right.resourceIdentityDigest) || left.capturedResourceId.localeCompare(right.capturedResourceId));
  importedResources.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  missingResourceIds.sort();
  const state: ManagedProfileStateV1 = {
    schemaVersion: 1,
    profileInstanceId,
    publication: options.publication === undefined ? options.previousState?.publication ?? null : options.publication,
    capturedResourceIds,
    importedResources
  };
  return {
    state,
    missingResourceIds,
    treeIds: [...treeIds].sort(),
    effects: { cacheWritten, buildExecuted },
    revalidateOrdinary: async () => {
      for (const proof of ordinaryProofs) {
        if (options.captureOrdinary === undefined) throw invalid('retained ordinary resource revalidation is unavailable');
        const current = copyOrdinarySnapshot(await options.captureOrdinary(proof.resource));
        assertSameOrdinarySnapshot(proof.snapshot, current);
        assertOrdinarySnapshot(proof.resource, current, blobByDigest);
      }
    }
  };
}

function copyOrdinarySnapshot(value: OrdinaryResourceMaterializationSnapshot): OrdinaryResourceMaterializationSnapshot {
  if (!plainDataRecord(value) || Object.keys(value).sort().join(',') !== 'blobs,resource' || !plainDenseArray(value.blobs)) throw invalid('ordinary catalog capture is malformed');
  const blobs = value.blobs.map((blob) => {
    if (!plainDataRecord(blob) || Object.keys(blob).sort().join(',') !== 'bytes,bytesValue,sha256'
      || typeof blob.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(blob.sha256)
      || !Number.isSafeInteger(blob.bytes) || blob.bytes < 0 || Object.is(blob.bytes, -0)
      || (!(blob.bytesValue instanceof Uint8Array) && !Buffer.isBuffer(blob.bytesValue)) || utilTypes.isProxy(blob.bytesValue)) throw invalid('ordinary catalog blob is malformed');
    return { sha256: blob.sha256, bytes: blob.bytes, bytesValue: Buffer.from(blob.bytesValue) };
  });
  const emptySha = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  const records = new Map<Sha256, { sha256: Sha256; bytes: number }>(blobs.map((blob) => [blob.sha256, { sha256: blob.sha256, bytes: blob.bytes }]));
  if (!records.has(emptySha)) records.set(emptySha, { sha256: emptySha, bytes: 0 });
  let decoded: CapturedProfileV1;
  try {
    decoded = decodeCapturedProfileObject({
      schemaVersion: 1, kind: 'bazframe-captured-profile',
      profile: { name: 'catalog-capture', instructions: { path: 'AGENTS.md', sha256: emptySha, bytes: 0, executable: false } },
      resources: [value.resource], blobs: [...records.values()].sort((left, right) => left.sha256.localeCompare(right.sha256))
    }, capturedProfileLimitPolicy());
  } catch { throw invalid('ordinary catalog resource is malformed'); }
  return { resource: decoded.resources[0]!, blobs };
}

function assertOrdinarySnapshot(resource: CapturedResource, snapshot: OrdinaryResourceMaterializationSnapshot, capturedBlobs: ReadonlyMap<Sha256, CapturedBlobSource>): void {
  if (JSON.stringify(snapshot.resource) !== JSON.stringify(resource)) throw invalid('ordinary catalog resource does not match the captured resource');
  const expected = resource.payload.kind === 'bundled'
    ? [...new Map(resource.payload.files.map((file) => [file.sha256, file.bytes])).entries()].sort(([left], [right]) => left.localeCompare(right))
    : [];
  if (snapshot.blobs.length !== expected.length) throw invalid('ordinary catalog blob closure does not match the captured resource');
  for (let index = 0; index < expected.length; index += 1) {
    const [sha256, bytes] = expected[index]!;
    const actual = snapshot.blobs[index];
    const captured = capturedBlobs.get(sha256);
    if (actual === undefined || actual.sha256 !== sha256 || actual.bytes !== bytes || captured === undefined) throw invalid('ordinary catalog blob closure does not match the captured resource');
    assertBlobBytes({ sha256, bytes }, actual.bytesValue);
    if (!Buffer.from(actual.bytesValue).equals(Buffer.from(captured.bytesValue))) throw invalid('ordinary catalog bytes do not match the captured profile');
  }
}

function assertSameOrdinarySnapshot(left: OrdinaryResourceMaterializationSnapshot, right: OrdinaryResourceMaterializationSnapshot): void {
  if (JSON.stringify(left.resource) !== JSON.stringify(right.resource)
    || left.blobs.length !== right.blobs.length
    || left.blobs.some((blob, index) => blob.sha256 !== right.blobs[index]?.sha256 || blob.bytes !== right.blobs[index]?.bytes || !Buffer.from(blob.bytesValue).equals(Buffer.from(right.blobs[index]!.bytesValue)))) {
    throw new BazframeError('PROFILE_MATERIALIZATION_CHANGED', 'Ordinary catalog resource changed before profile publication.');
  }
}

async function writeProfileLocalSkill(candidateDirectory: string, resource: CapturedResource, blobs: ReadonlyMap<Sha256, CapturedBlobSource>): Promise<void> {
  if (resource.key.kind !== 'skill' || resource.payload.kind !== 'bundled') throw invalid('profile-local resource must be a bundled Skill');
  const rootPath = join(candidateDirectory, 'skills', resource.key.name);
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  for (const file of resource.payload.files) {
    const parts = file.path.split('/');
    const name = parts.pop()!;
    const parentPath = join(rootPath, ...parts);
    await mkdir(parentPath, { recursive: true, mode: 0o700 });
    const directory = await openStablePhysicalDirectory(parentPath, candidateDirectory);
    try {
      const blob = requiredBlob(file.sha256, blobs);
      await writeOwnedStagingFileAtomic(directory, name, blob.bytesValue, file.executable ? 0o700 : 0o600);
    } finally { await directory.handle.close().catch(() => undefined); }
  }
}

async function writeOrdinaryMembership(home: string, candidateDirectory: string, resource: CapturedResource): Promise<void> {
  if (resource.key.kind === 'skill') {
    const registration = await readDefaultSkillRegistrationLink(home, resource.key.name);
    const directoryPath = join(candidateDirectory, 'skills');
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    await symlink(registration.target, join(directoryPath, resource.key.name));
    const directory = await openStablePhysicalDirectory(directoryPath, candidateDirectory);
    try { await directory.handle.sync(); } finally { await directory.handle.close().catch(() => undefined); }
    return;
  }
  const namespace = resource.key.kind === 'library' ? 'libraries' : 'packages';
  const directoryPath = join(candidateDirectory, namespace);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const reference = resource.key.kind === 'library'
    ? { schemaVersion: 1 as const, library: resource.key.name }
    : { schemaVersion: 1 as const, package: resource.key.name };
  const directory = await openStablePhysicalDirectory(directoryPath, candidateDirectory);
  try {
    await writeOwnedStagingFileAtomic(directory, `${resource.key.name}.json`, Buffer.from(encodeProfileCollectionReference(reference)));
    await directory.handle.sync();
  } finally { await directory.handle.close().catch(() => undefined); }
}

function validateRemoteResult(value: unknown): RemoteMaterializationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) throw invalid('remote materializer returned a malformed result');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).some((key) => typeof key !== 'string') || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw invalid('remote materializer returned a malformed result');
  const result = value as Record<string, unknown>;
  if (result.kind === 'ready') {
    if (Object.keys(result).sort().join(',') !== 'buildExecuted,cacheWritten,identity,kind,treeId' || typeof result.treeId !== 'string' || !/^[a-f0-9]{64}$/u.test(result.treeId) || !plainRemoteIdentity(result.identity) || typeof result.cacheWritten !== 'boolean' || typeof result.buildExecuted !== 'boolean') throw invalid('remote materializer returned a malformed ready result');
    const identity = result.identity as ExactRemoteGitIdentity;
    return { kind: 'ready', treeId: result.treeId, identity: { remote: identity.remote, fetchUrl: identity.fetchUrl, branch: identity.branch, revision: identity.revision }, cacheWritten: result.cacheWritten, buildExecuted: result.buildExecuted };
  }
  if (result.kind === 'acquisitionUnavailable') {
    if (Object.keys(result).sort().join(',') !== 'buildExecuted,cacheWritten,diagnosticCode,kind' || typeof result.diagnosticCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(result.diagnosticCode) || typeof result.cacheWritten !== 'boolean' || typeof result.buildExecuted !== 'boolean') throw invalid('remote materializer returned a malformed unavailable result');
    return { kind: 'acquisitionUnavailable', diagnosticCode: result.diagnosticCode, cacheWritten: result.cacheWritten, buildExecuted: result.buildExecuted };
  }
  throw invalid('remote materializer returned an unknown result');
}

function plainDataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
  });
}
function plainDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return false;
  }
  return true;
}
function plainRemoteIdentity(value: unknown): value is ExactRemoteGitIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(value).sort().join(',') === 'branch,fetchUrl,remote,revision'
    && Object.values(descriptors).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true)
    && Object.values(value).every((item) => typeof item === 'string');
}

function validatedBlobMap(captured: CapturedProfileV1, sources: readonly CapturedBlobSource[]): Map<Sha256, CapturedBlobSource> {
  const expected = new Map(captured.blobs.map((blob) => [blob.sha256, blob]));
  const result = new Map<Sha256, CapturedBlobSource>();
  for (const source of sources) {
    const record = expected.get(source.sha256);
    if (record === undefined || record.bytes !== source.bytes || result.has(source.sha256)) throw invalid('blob source closure does not match the capture');
    assertBlobBytes(record, source.bytesValue);
    result.set(source.sha256, { sha256: source.sha256, bytes: source.bytes, bytesValue: Buffer.from(source.bytesValue) });
  }
  if (result.size !== expected.size) throw invalid('blob source closure is incomplete');
  return result;
}

function requiredBlob(sha256: Sha256, blobs: ReadonlyMap<Sha256, CapturedBlobSource>): CapturedBlobSource {
  const blob = blobs.get(sha256);
  if (blob === undefined) throw invalid('referenced blob is absent');
  return blob;
}

function roleFor(kind: CapturedResource['key']['kind']): ArtifactTreeManifestV1['role'] {
  return kind === 'package' ? 'packageArtifacts' : kind;
}

async function findCachedRemoteTree(home: string, resource: CapturedResource): Promise<Sha256 | undefined> {
  if (resource.payload.kind !== 'remoteGit') return undefined;
  const view = await readProfileSystemView(home);
  const treeIds = new Set<Sha256>();
  for (const existing of view.resources) {
    if (existing.key.kind !== resource.key.kind || existing.key.name !== resource.key.name) continue;
    const materialization = existing.materialization;
    if (materialization.kind === 'remoteGit' && sameExactIdentity(materialization.identity, resource.payload.identity)) {
      treeIds.add(materialization.treeId);
    } else if (materialization.kind === 'artifact' && materialization.origin !== undefined
      && sameExactIdentity(materialization.origin, resource.payload.identity)) {
      treeIds.add(materialization.treeId);
    }
  }
  if (treeIds.size > 1) throw invalid('same exact remote identity has conflicting cached artifact trees');
  return treeIds.values().next().value as Sha256 | undefined;
}

function sameExactIdentity(left: ExactRemoteGitIdentity, right: ExactRemoteGitIdentity): boolean {
  return left.remote === right.remote && left.fetchUrl === right.fetchUrl && left.branch === right.branch && left.revision === right.revision;
}

function derivedImportedInstanceId(profileInstanceId: string, capturedResourceId: Sha256): string {
  const bytes = createHash('sha256')
    .update('bazframe-imported-instance-v1\0')
    .update(profileInstanceId)
    .update('\0')
    .update(capturedResourceId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function invalid(detail: string): BazframeError {
  return new BazframeError('PROFILE_MATERIALIZATION_INVALID', `Invalid profile materialization: ${detail}.`);
}
