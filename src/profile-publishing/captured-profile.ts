import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { BazframeError } from '../core/errors.js';
import {
  decodePathFreeManagedGitIdentity,
  type PathFreeManagedGitIdentity
} from '../providers/managed-git-record.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import {
  capturedProfileLimitPolicy,
  type CapturedProfileLimitPolicy
} from './profile-publishing-policy.js';

export type { CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
export type Sha256 = string;
export type ResourceKind = 'skill' | 'library' | 'package';
export type StableResourceIdentity = `catalog:${ResourceKind}:${string}` | `profileLocal:${string}` | `imported:${string}`;
export type ExactRemoteGitIdentity = PathFreeManagedGitIdentity;
export interface BlobFile { path: string; sha256: Sha256; bytes: number; executable: boolean }
export interface BlobRecord { sha256: Sha256; bytes: number }
export interface CapturedProfileHeader { name: string; instructions: BlobFile }
export interface CapturedResourceKey { kind: ResourceKind; name: string }
export interface BundledPayload { kind: 'bundled'; role: 'skill' | 'library' | 'packageArtifacts'; sourceForm?: 'profile-local'; origin?: ExactRemoteGitIdentity; files: BlobFile[] }
export interface RemoteGitPayload { kind: 'remoteGit'; identity: ExactRemoteGitIdentity }
export interface CapturedResource { id: Sha256; key: CapturedResourceKey; payload: BundledPayload | RemoteGitPayload }
export interface CapturedProfileV1 { schemaVersion: 1; kind: 'bazframe-captured-profile'; profile: CapturedProfileHeader; resources: CapturedResource[]; blobs: BlobRecord[] }

const ROOT_KEYS = ['blobs', 'kind', 'profile', 'resources', 'schemaVersion'] as const;
const PROFILE_KEYS = ['instructions', 'name'] as const;
const RESOURCE_KEYS = ['id', 'key', 'payload'] as const;
const KEY_KEYS = ['kind', 'name'] as const;
const BUNDLED_KEYS = ['files', 'kind', 'role'] as const;
const BUNDLED_SOURCE_FORM_KEYS = ['files', 'kind', 'role', 'sourceForm'] as const;
const BUNDLED_ORIGIN_KEYS = ['files', 'kind', 'origin', 'role'] as const;
const REMOTE_KEYS = ['identity', 'kind'] as const;
const FILE_KEYS = ['bytes', 'executable', 'path', 'sha256'] as const;
const BLOB_KEYS = ['bytes', 'sha256'] as const;
const IDENTITY_KEYS = ['branch', 'fetchUrl', 'remote', 'revision'] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DRIVE_PREFIX = /^[a-zA-Z]:/u;
const RESOURCE_KINDS = ['skill', 'library', 'package'] as const;

export function ordinaryResourceIdentity(kind: ResourceKind, canonicalCatalogId: string): StableResourceIdentity {
  if (!RESOURCE_KINDS.includes(kind) || !isSafeSkillId(canonicalCatalogId)) throw invalid('ordinary resource identity is invalid');
  return `catalog:${kind}:${canonicalCatalogId}`;
}

export function importedResourceIdentity(instanceId: string): StableResourceIdentity {
  if (!UUID_PATTERN.test(instanceId)) throw invalid('imported resource instance UUID is invalid');
  return `imported:${instanceId}`;
}

export function profileLocalResourceIdentity(instanceId: string): StableResourceIdentity {
  if (!UUID_PATTERN.test(instanceId)) throw invalid('profile-local resource instance UUID is invalid');
  return `profileLocal:${instanceId}`;
}

export function profileInstanceIdFromPhysicalIdentity(physicalIdentity: string): string {
  if (typeof physicalIdentity !== 'string' || physicalIdentity.length === 0) throw invalid('physical profile identity is invalid');
  return deterministicUuid('bazframe-physical-profile-instance-v1\0', physicalIdentity);
}

export function profileLocalResourceInstanceId(profileInstanceId: string, skillName: string): string {
  if (!UUID_PATTERN.test(profileInstanceId) || !isSafeSkillId(skillName)) throw invalid('profile-local resource identity input is invalid');
  return deterministicUuid('bazframe-profile-local-resource-instance-v1\0', `${profileInstanceId}\0${skillName}`);
}

export function capturedResourceId(kind: ResourceKind, identity: StableResourceIdentity): Sha256 {
  if (!RESOURCE_KINDS.includes(kind) || !isStableIdentity(identity, kind)) throw invalid('stable resource identity is invalid');
  return digest(['bazframe-captured-resource-v1\0', kind, '\0', identity]);
}

export function resourceIdentityDigest(identity: StableResourceIdentity): Sha256 {
  if (!isStableIdentity(identity)) throw invalid('stable resource identity is invalid');
  return digest(['bazframe-resource-identity-digest-v1\0', identity]);
}

export function decodeCapturedProfileObject(value: unknown, limits: CapturedProfileLimitPolicy): CapturedProfileV1 {
  const policy = copyPolicy(limits);
  const root = exactObject(value, ROOT_KEYS, 'captured profile');
  if (root.schemaVersion !== 1 || root.kind !== 'bazframe-captured-profile') throw invalid('schema identity is invalid');
  const profileValue = exactObject(root.profile, PROFILE_KEYS, 'profile');
  if (typeof profileValue.name !== 'string' || !isSafeProfileId(profileValue.name)) throw invalid('profile name is invalid');
  const instructions = decodeBlobFile(profileValue.instructions, 'profile instructions', policy, true);

  const resourcesValue = boundedArray(root.resources, 'resources', policy.maxResources);
  if (resourcesValue.length > policy.maxProfileEntries) throw invalid(`profile entries exceed the ${policy.maxProfileEntries}-entry limit`);
  const resources: CapturedResource[] = [];
  const resourceIds = new Set<string>();
  let previousResource: CapturedResource | undefined;
  let totalFiles = 1;
  for (const raw of resourcesValue) {
    const candidate = exactObject(raw, RESOURCE_KEYS, 'resource');
    const id = decodeSha(candidate.id, 'resource id');
    if (resourceIds.has(id)) throw invalid('resource IDs must be unique');
    resourceIds.add(id);
    const keyValue = exactObject(candidate.key, KEY_KEYS, 'resource key');
    const kind = decodeResourceKind(keyValue.kind);
    if (typeof keyValue.name !== 'string' || !isSafeSkillId(keyValue.name)) throw invalid('resource name is invalid');
    const key = { kind, name: keyValue.name };
    const payload = decodePayload(candidate.payload, key, policy);
    const resource = { id, key, payload } satisfies CapturedResource;
    if (previousResource !== undefined && compareResource(previousResource, resource) >= 0) throw invalid('resources must be in canonical order');
    previousResource = resource;
    totalFiles += payload.kind === 'bundled' ? payload.files.length : 0;
    if (totalFiles > policy.maxEntries) throw invalid(`files exceed the ${policy.maxEntries}-entry limit`);
    resources.push(resource);
  }

  const blobsValue = boundedArray(root.blobs, 'blobs', policy.maxEntries);
  const blobs: BlobRecord[] = [];
  let previousDigest: string | undefined;
  let aggregateBytes = 0;
  const blobByDigest = new Map<string, BlobRecord>();
  for (const raw of blobsValue) {
    const candidate = exactObject(raw, BLOB_KEYS, 'blob');
    const sha256 = decodeSha(candidate.sha256, 'blob sha256');
    const bytes = decodeBytes(candidate.bytes, 'blob bytes', policy.maxBlobBytes);
    if (previousDigest !== undefined && compareCodePoints(previousDigest, sha256) >= 0) throw invalid('blobs must be unique and ordered by digest');
    previousDigest = sha256;
    aggregateBytes += bytes;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > policy.maxAggregateBytes) throw invalid(`blob bytes exceed the ${policy.maxAggregateBytes}-byte aggregate limit`);
    const blob = { sha256, bytes };
    blobs.push(blob);
    blobByDigest.set(sha256, blob);
  }
  const referenced = new Set<string>();
  for (const file of allFiles(instructions, resources)) {
    const blob = blobByDigest.get(file.sha256);
    if (blob === undefined || blob.bytes !== file.bytes) throw invalid('a file has no exact matching blob');
    referenced.add(file.sha256);
  }
  if (referenced.size !== blobs.length) throw invalid('blob records must be referenced exactly by the file closure');

  const result: CapturedProfileV1 = { schemaVersion: 1, kind: 'bazframe-captured-profile', profile: { name: profileValue.name, instructions }, resources, blobs };
  assertManifestBound(result, policy);
  return result;
}

export function decodeCapturedProfileBytes(bytes: Uint8Array, limits: CapturedProfileLimitPolicy): CapturedProfileV1 {
  const policy = copyPolicy(limits);
  if (bytes.byteLength > policy.maxManifestBytes) throw invalid(`manifest exceeds the ${policy.maxManifestBytes}-byte limit`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw new BazframeError('CAPTURED_PROFILE_INVALID', 'Invalid captured profile: manifest is not valid UTF-8.', { cause: error }); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new BazframeError('CAPTURED_PROFILE_INVALID', 'Invalid captured profile: manifest is not valid JSON.', { cause: error }); }
  const result = decodeCapturedProfileObject(value, policy);
  if (!Buffer.from(encodeCanonical(result)).equals(Buffer.from(bytes))) throw invalid('manifest bytes are not canonical');
  return result;
}

export function encodeCapturedProfile(profile: CapturedProfileV1, limits: CapturedProfileLimitPolicy): string {
  return encodeCanonical(decodeCapturedProfileObject(profile, limits));
}

/** Canonical publication baseline over all transported content except the local display/profile name. */
export function capturedProfileContentBaselineSha256(profile: CapturedProfileV1, limits: CapturedProfileLimitPolicy): Sha256 {
  const canonical = decodeCapturedProfileObject(profile, limits);
  return createHash('sha256').update(encodeCanonical({ ...canonical, profile: { ...canonical.profile, name: 'profile' } })).digest('hex');
}

export function assertBlobBytes(record: BlobRecord, bytes: Uint8Array): void {
  if (bytes.byteLength !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw invalid('physical blob bytes do not match their record');
}

function decodePayload(value: unknown, key: CapturedResourceKey, policy: CapturedProfileLimitPolicy): BundledPayload | RemoteGitPayload {
  if (!isPlainDataRecord(value)) throw invalid('resource payload must be a plain data object');
  const payload = value;
  if (payload.kind === 'remoteGit') {
    exactObject(payload, REMOTE_KEYS, 'remote payload');
    return { kind: 'remoteGit', identity: decodeIdentity(payload.identity, key.name) };
  }
  if (payload.kind !== 'bundled') throw invalid('resource payload kind is invalid');
  const hasOrigin = Object.hasOwn(payload, 'origin');
  const hasSourceForm = Object.hasOwn(payload, 'sourceForm');
  if (hasOrigin && hasSourceForm) throw invalid('bundled payload cannot combine origin and source form');
  exactObject(payload, hasOrigin ? BUNDLED_ORIGIN_KEYS : hasSourceForm ? BUNDLED_SOURCE_FORM_KEYS : BUNDLED_KEYS, 'bundled payload');
  const expectedRole = key.kind === 'package' ? 'packageArtifacts' : key.kind;
  if (payload.role !== expectedRole) throw invalid('bundled payload role does not match resource kind');
  if (hasSourceForm && (payload.sourceForm !== 'profile-local' || key.kind !== 'skill' || expectedRole !== 'skill')) throw invalid('bundled payload source form is invalid');
  const filesValue = boundedArray(payload.files, 'resource files', policy.maxEntries);
  const files: BlobFile[] = [];
  let previousPath: string | undefined;
  const portable = new Set<string>();
  for (const raw of filesValue) {
    const file = decodeBlobFile(raw, 'resource file', policy, false);
    if (previousPath !== undefined && compareCodePoints(previousPath, file.path) >= 0) throw invalid('resource files must be unique and ordered by path');
    previousPath = file.path;
    const folded = portablePathCollisionKey(file.path);
    if (portable.has(folded)) throw invalid('resource files have a portable case collision');
    portable.add(folded);
    files.push(file);
  }
  const origin = hasOrigin ? decodeIdentity(payload.origin, key.name) : undefined;
  return origin !== undefined
    ? { kind: 'bundled', role: expectedRole, origin, files }
    : hasSourceForm
      ? { kind: 'bundled', role: expectedRole, sourceForm: 'profile-local', files }
      : { kind: 'bundled', role: expectedRole, files };
}

function decodeBlobFile(value: unknown, label: string, policy: CapturedProfileLimitPolicy, instructions: boolean): BlobFile {
  const candidate = exactObject(value, FILE_KEYS, label);
  if (typeof candidate.path !== 'string' || (instructions ? candidate.path !== 'AGENTS.md' : !isPortablePath(candidate.path, policy))) throw invalid(`${label} path is invalid`);
  const sha256 = decodeSha(candidate.sha256, `${label} sha256`);
  const bytes = decodeBytes(candidate.bytes, `${label} bytes`, policy.maxBlobBytes);
  if (typeof candidate.executable !== 'boolean') throw invalid(`${label} executable is invalid`);
  return { path: candidate.path, sha256, bytes, executable: candidate.executable };
}

function decodeIdentity(value: unknown, expectedName: string): ExactRemoteGitIdentity {
  const candidate = exactObject(value, IDENTITY_KEYS, 'remote Git identity');
  try {
    const identity = decodePathFreeManagedGitIdentity(candidate, expectedName);
    const url = new URL(identity.fetchUrl);
    if (url.username !== '' || url.password !== '') throw new Error('userinfo is forbidden');
    return identity;
  } catch (error) {
    throw new BazframeError('CAPTURED_PROFILE_INVALID', 'Invalid captured profile: remote Git identity is invalid.', { cause: error });
  }
}

function isPortablePath(path: string, policy: CapturedProfileLimitPolicy): boolean {
  if (!isUnicodeScalarString(path) || path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || DRIVE_PREFIX.test(path) || Buffer.byteLength(path, 'utf8') > policy.maxPathBytes) return false;
  for (const character of path) if (character.codePointAt(0)! < 0x20 || character.codePointAt(0) === 0x7f) return false;
  const segments = path.split('/');
  return segments.length <= policy.maxDepth && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function portablePathCollisionKey(path: string): string {
  // This deterministic, locale-independent normalized lower→upper→lower fold
  // joins characters such as ß/ẞ/ss and sigma/final-sigma without dependencies.
  return path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
}

function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function decodeResourceKind(value: unknown): ResourceKind {
  if (typeof value !== 'string' || !(RESOURCE_KINDS as readonly string[]).includes(value)) throw invalid('resource kind is invalid');
  return value as ResourceKind;
}
function decodeSha(value: unknown, label: string): Sha256 { if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw invalid(`${label} is invalid`); return value; }
function decodeBytes(value: unknown, label: string, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0) || (value as number) > maximum) throw invalid(`${label} is invalid`); return value as number; }
function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { if (!isPlainDataRecord(value)) throw invalid(`${label} must be a plain data object`); const candidate = value; const actual = Object.keys(candidate).sort(compareCodePoints); const expected = [...keys].sort(compareCodePoints); if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) throw invalid(`${label} has unexpected fields`); return candidate; }
function isPlainDataRecord(value: unknown): value is Record<string, unknown> { if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) return false; const keys = Reflect.ownKeys(value); return keys.every((key) => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value') && Object.getOwnPropertyDescriptor(value, key)!.enumerable === true); }
function boundedArray(value: unknown, label: string, maximum: number): unknown[] { if (!isPlainDenseArray(value)) throw invalid(`${label} must be a plain dense array`); if (value.length > maximum) throw invalid(`${label} exceeds the ${maximum}-entry limit`); return value; }
function isPlainDenseArray(value: unknown): value is unknown[] { if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false; const descriptors = Object.getOwnPropertyDescriptors(value); for (let index = 0; index < value.length; index += 1) { const descriptor = descriptors[String(index)]; if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return false; } return true; }
function copyPolicy(policy: CapturedProfileLimitPolicy): CapturedProfileLimitPolicy { try { return capturedProfileLimitPolicy(policy); } catch (error) { throw new BazframeError('CAPTURED_PROFILE_INVALID', 'Invalid captured profile: limit policy is invalid.', { cause: error }); } }
function assertManifestBound(value: CapturedProfileV1, policy: CapturedProfileLimitPolicy): void { if (Buffer.byteLength(encodeCanonical(value), 'utf8') > policy.maxManifestBytes) throw invalid(`canonical manifest exceeds the ${policy.maxManifestBytes}-byte limit`); }
function encodeCanonical(value: CapturedProfileV1): string { return `${JSON.stringify(value, null, 2)}\n`; }
function allFiles(instructions: BlobFile, resources: readonly CapturedResource[]): BlobFile[] { return [instructions, ...resources.flatMap((resource) => resource.payload.kind === 'bundled' ? resource.payload.files : [])]; }
function compareResource(left: CapturedResource, right: CapturedResource): number { return RESOURCE_KINDS.indexOf(left.key.kind) - RESOURCE_KINDS.indexOf(right.key.kind) || compareCodePoints(left.key.name, right.key.name) || compareCodePoints(left.id, right.id); }
function compareCodePoints(left: string, right: string): number { const a = [...left].map((character) => character.codePointAt(0)!); const b = [...right].map((character) => character.codePointAt(0)!); for (let i = 0; i < Math.min(a.length, b.length); i += 1) { if (a[i] !== b[i]) return a[i]! - b[i]!; } return a.length - b.length; }
function isStableIdentity(value: string, kind?: ResourceKind): value is StableResourceIdentity { if (value.startsWith('imported:')) return UUID_PATTERN.test(value.slice('imported:'.length)); if (value.startsWith('profileLocal:')) return kind === undefined || kind === 'skill' ? UUID_PATTERN.test(value.slice('profileLocal:'.length)) : false; if (!value.startsWith('catalog:')) return false; const parts = value.split(':'); return parts.length === 3 && (RESOURCE_KINDS as readonly string[]).includes(parts[1]!) && (kind === undefined || parts[1] === kind) && isSafeSkillId(parts[2]!); }
function deterministicUuid(domain: string, value: string): string { const bytes = createHash('sha256').update(domain).update(value).digest().subarray(0, 16); bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80; const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`; }
function digest(parts: readonly string[]): Sha256 { const hash = createHash('sha256'); for (const part of parts) hash.update(part, 'utf8'); return hash.digest('hex'); }
function invalid(detail: string): BazframeError { return new BazframeError('CAPTURED_PROFILE_INVALID', `Invalid captured profile: ${detail}.`); }
