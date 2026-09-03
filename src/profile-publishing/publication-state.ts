import { types as utilTypes } from 'node:util';
import { BazframeError } from '../core/errors.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { decodePathFreeManagedGitIdentity } from '../providers/managed-git-record.js';
import { canonicalProfileGitHubOrigin } from '../providers/managed-git-source.js';
import {
  capturedProfileLimitPolicy,
  type CapturedProfileLimitPolicy
} from './profile-publishing-policy.js';
import {
  importedResourceIdentity,
  profileLocalResourceIdentity,
  resourceIdentityDigest,
  type CapturedResourceKey,
  type ExactRemoteGitIdentity,
  type ResourceKind,
  type Sha256
} from './captured-profile.js';

export interface PublicationState { transport: 'git'; origin: string; installedCommit: string; latestSeenCommit: string; baselineCaptureSha256: Sha256; visibility: 'private' | 'public' }
export type CapturedResourceIdentityKind = 'catalog' | 'profileLocal' | 'imported';
export interface CapturedResourceIdBinding { resourceIdentityDigest: Sha256; capturedResourceId: Sha256; identityKind: CapturedResourceIdentityKind; instanceId: string | null }
export type ImportedResourceSource =
  | { kind: 'artifact'; treeId: Sha256; origin?: ExactRemoteGitIdentity }
  | { kind: 'remoteGit'; identity: ExactRemoteGitIdentity; treeId: Sha256 }
  | { kind: 'missingRemoteGit'; identity: ExactRemoteGitIdentity; diagnosticCode: string };
export interface ImportedResourceState { instanceId: string; capturedResourceId: Sha256; key: CapturedResourceKey; source: ImportedResourceSource }
export interface ManagedProfileStateV1 { schemaVersion: 1; profileInstanceId: string; publication: PublicationState | null; capturedResourceIds: CapturedResourceIdBinding[]; importedResources: ImportedResourceState[] }

const ROOT_KEYS = ['capturedResourceIds', 'importedResources', 'profileInstanceId', 'publication', 'schemaVersion'] as const;
const PUBLICATION_KEYS = ['baselineCaptureSha256', 'installedCommit', 'latestSeenCommit', 'origin', 'transport', 'visibility'] as const;
const BINDING_KEYS = ['capturedResourceId', 'identityKind', 'instanceId', 'resourceIdentityDigest'] as const;
const IMPORTED_KEYS = ['capturedResourceId', 'instanceId', 'key', 'source'] as const;
const KEY_KEYS = ['kind', 'name'] as const;
const ARTIFACT_KEYS = ['kind', 'treeId'] as const;
const ARTIFACT_ORIGIN_KEYS = ['kind', 'origin', 'treeId'] as const;
const REMOTE_KEYS = ['identity', 'kind', 'treeId'] as const;
const MISSING_KEYS = ['diagnosticCode', 'identity', 'kind'] as const;
const IDENTITY_KEYS = ['branch', 'fetchUrl', 'remote', 'revision'] as const;
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIAGNOSTIC = /^[A-Z][A-Z0-9_]{0,127}$/u;
const KINDS = ['skill', 'library', 'package'] as const;

export function decodeManagedProfileStateObject(value: unknown, limits: CapturedProfileLimitPolicy): ManagedProfileStateV1 {
  const policy = copyPolicy(limits);
  const root = exactObject(value, ROOT_KEYS, 'profile state');
  if (root.schemaVersion !== 1) throw invalid('schemaVersion is invalid');
  if (typeof root.profileInstanceId !== 'string' || !UUID.test(root.profileInstanceId)) throw invalid('profileInstanceId is invalid');
  const publication = root.publication === null ? null : decodePublication(root.publication);

  const bindingsValue = boundedArray(root.capturedResourceIds, 'capturedResourceIds', policy.maxResources);
  const capturedResourceIds: CapturedResourceIdBinding[] = [];
  const bindingResourceIds = new Set<string>();
  const bindingIdentityDigests = new Set<string>();
  const bindingDigestByResourceId = new Map<string, string>();
  let previousBinding: CapturedResourceIdBinding | undefined;
  for (const raw of bindingsValue) {
    const candidate = exactObject(raw, BINDING_KEYS, 'captured resource binding');
    const identityKind = identityKindValue(candidate.identityKind);
    const instanceId = candidate.instanceId === null ? null : uuid(candidate.instanceId, 'binding instanceId');
    const binding = { resourceIdentityDigest: sha(candidate.resourceIdentityDigest, 'resourceIdentityDigest'), capturedResourceId: sha(candidate.capturedResourceId, 'capturedResourceId'), identityKind, instanceId };
    if (identityKind === 'catalog') {
      if (instanceId !== null) throw invalid('catalog binding must not have an instanceId');
    } else {
      if (instanceId === null) throw invalid('non-catalog binding requires an instanceId');
      const stableIdentity = identityKind === 'imported' ? importedResourceIdentity(instanceId) : profileLocalResourceIdentity(instanceId);
      if (binding.resourceIdentityDigest !== resourceIdentityDigest(stableIdentity)) throw invalid('binding instanceId does not match its resource identity digest');
    }
    if (previousBinding !== undefined && compareBinding(previousBinding, binding) >= 0) throw invalid('capturedResourceIds must be in canonical order');
    if (bindingResourceIds.has(binding.capturedResourceId)) throw invalid('capturedResourceIds must contain unique capturedResourceId values');
    if (bindingIdentityDigests.has(binding.resourceIdentityDigest)) throw invalid('capturedResourceIds must contain unique resourceIdentityDigest values');
    previousBinding = binding;
    bindingResourceIds.add(binding.capturedResourceId);
    bindingIdentityDigests.add(binding.resourceIdentityDigest);
    bindingDigestByResourceId.set(binding.capturedResourceId, binding.resourceIdentityDigest);
    capturedResourceIds.push(binding);
  }

  const importedValue = boundedArray(root.importedResources, 'importedResources', policy.maxResources);
  if (bindingsValue.length + importedValue.length > policy.maxProfileEntries) throw invalid(`state entries exceed the ${policy.maxProfileEntries}-entry limit`);
  const importedResources: ImportedResourceState[] = [];
  let previousInstance: string | undefined;
  const importedCaptureIds = new Set<string>();
  for (const raw of importedValue) {
    const candidate = exactObject(raw, IMPORTED_KEYS, 'imported resource');
    if (typeof candidate.instanceId !== 'string' || !UUID.test(candidate.instanceId)) throw invalid('imported instanceId is invalid');
    if (previousInstance !== undefined && candidate.instanceId <= previousInstance) throw invalid('importedResources must be ordered by unique instanceId');
    previousInstance = candidate.instanceId;
    const capturedResourceId = sha(candidate.capturedResourceId, 'imported capturedResourceId');
    if (importedCaptureIds.has(capturedResourceId) || !bindingResourceIds.has(capturedResourceId)) throw invalid('imported capturedResourceId must identify one unique binding');
    const expectedIdentityDigest = resourceIdentityDigest(importedResourceIdentity(candidate.instanceId));
    const binding = capturedResourceIds.find((item) => item.capturedResourceId === capturedResourceId);
    if (bindingDigestByResourceId.get(capturedResourceId) !== expectedIdentityDigest || binding?.identityKind !== 'imported' || binding.instanceId !== candidate.instanceId) throw invalid('imported instanceId does not match its resource identity binding');
    importedCaptureIds.add(capturedResourceId);
    const key = decodeKey(candidate.key);
    importedResources.push({ instanceId: candidate.instanceId, capturedResourceId, key, source: decodeSource(candidate.source, key.name) });
  }

  const result: ManagedProfileStateV1 = { schemaVersion: 1, profileInstanceId: root.profileInstanceId, publication, capturedResourceIds, importedResources };
  if (Buffer.byteLength(canonical(result), 'utf8') > policy.maxManifestBytes) throw invalid(`canonical state exceeds the ${policy.maxManifestBytes}-byte limit`);
  return result;
}

export function decodeManagedProfileStateBytes(bytes: Uint8Array, limits: CapturedProfileLimitPolicy): ManagedProfileStateV1 {
  const policy = copyPolicy(limits);
  if (bytes.byteLength > policy.maxManifestBytes) throw invalid(`state exceeds the ${policy.maxManifestBytes}-byte limit`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw new BazframeError('PROFILE_PUBLICATION_STATE_INVALID', 'Invalid profile publication state: state is not valid UTF-8.', { cause: error }); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new BazframeError('PROFILE_PUBLICATION_STATE_INVALID', 'Invalid profile publication state: state is not valid JSON.', { cause: error }); }
  const state = decodeManagedProfileStateObject(value, policy);
  if (!Buffer.from(canonical(state)).equals(Buffer.from(bytes))) throw invalid('state bytes are not canonical');
  return state;
}

export function encodeManagedProfileState(state: ManagedProfileStateV1, limits: CapturedProfileLimitPolicy): string {
  return canonical(decodeManagedProfileStateObject(state, limits));
}

export function publicationSidecarName(): '.bazframe-profile-state.json' { return '.bazframe-profile-state.json'; }
export function isReservedProfileSiblingName(name: string): boolean { return /^\.bazframe-(?:candidate|backup)-[a-f0-9]{32}$/u.test(name); }
export function assertProfileNameNotReserved(name: string): void { if (!isSafeProfileId(name) || isReservedProfileSiblingName(name)) throw invalid('profile name is invalid or reserved'); }

function decodePublication(value: unknown): PublicationState {
  const candidate = exactObject(value, PUBLICATION_KEYS, 'publication');
  if (candidate.transport !== 'git') throw invalid('publication transport is invalid');
  if (typeof candidate.origin !== 'string') throw invalid('publication origin is invalid');
  let origin: string;
  try { origin = canonicalProfileGitHubOrigin(candidate.origin); }
  catch (error) { throw new BazframeError('PROFILE_PUBLICATION_STATE_INVALID', 'Invalid profile publication state: publication origin is invalid.', { cause: error }); }
  const installedCommit = commit(candidate.installedCommit, 'installedCommit');
  const latestSeenCommit = commit(candidate.latestSeenCommit, 'latestSeenCommit');
  const baselineCaptureSha256 = sha(candidate.baselineCaptureSha256, 'baselineCaptureSha256');
  if (candidate.visibility !== 'private' && candidate.visibility !== 'public') throw invalid('publication visibility is invalid');
  return { transport: 'git', origin, installedCommit, latestSeenCommit, baselineCaptureSha256, visibility: candidate.visibility };
}
function decodeKey(value: unknown): CapturedResourceKey { const candidate = exactObject(value, KEY_KEYS, 'resource key'); if (typeof candidate.kind !== 'string' || !(KINDS as readonly string[]).includes(candidate.kind)) throw invalid('resource key kind is invalid'); if (typeof candidate.name !== 'string' || !isSafeSkillId(candidate.name)) throw invalid('resource key name is invalid'); return { kind: candidate.kind as ResourceKind, name: candidate.name }; }
function decodeSource(value: unknown, expectedName: string): ImportedResourceSource {
  if (!isPlainDataRecord(value)) throw invalid('imported resource source must be a plain data object');
  const source = value;
  if (source.kind === 'artifact') { const hasOrigin = Object.hasOwn(source, 'origin'); exactObject(source, hasOrigin ? ARTIFACT_ORIGIN_KEYS : ARTIFACT_KEYS, 'artifact source'); const treeId = sha(source.treeId, 'treeId'); const origin = hasOrigin ? identity(source.origin, expectedName) : undefined; return origin === undefined ? { kind: 'artifact', treeId } : { kind: 'artifact', treeId, origin }; }
  if (source.kind === 'remoteGit') { exactObject(source, REMOTE_KEYS, 'remote source'); return { kind: 'remoteGit', identity: identity(source.identity, expectedName), treeId: sha(source.treeId, 'treeId') }; }
  if (source.kind === 'missingRemoteGit') { exactObject(source, MISSING_KEYS, 'missing remote source'); if (typeof source.diagnosticCode !== 'string' || !DIAGNOSTIC.test(source.diagnosticCode)) throw invalid('diagnosticCode is invalid'); return { kind: 'missingRemoteGit', identity: identity(source.identity, expectedName), diagnosticCode: source.diagnosticCode }; }
  throw invalid('imported resource source kind is invalid');
}
function identity(value: unknown, expectedName: string): ExactRemoteGitIdentity { const candidate = exactObject(value, IDENTITY_KEYS, 'remote Git identity'); try { const result = decodePathFreeManagedGitIdentity(candidate, expectedName); const url = new URL(result.fetchUrl); if (url.username !== '' || url.password !== '') throw new Error('userinfo is forbidden'); return result; } catch (error) { throw new BazframeError('PROFILE_PUBLICATION_STATE_INVALID', 'Invalid profile publication state: remote Git identity is invalid.', { cause: error }); } }
function identityKindValue(value: unknown): CapturedResourceIdentityKind { if (value !== 'catalog' && value !== 'profileLocal' && value !== 'imported') throw invalid('binding identityKind is invalid'); return value; }
function uuid(value: unknown, label: string): string { if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`${label} is invalid`); return value; }
function sha(value: unknown, label: string): Sha256 { if (typeof value !== 'string' || !SHA.test(value)) throw invalid(`${label} is invalid`); return value; }
function commit(value: unknown, label: string): string { if (typeof value !== 'string' || !COMMIT.test(value)) throw invalid(`${label} is invalid`); return value; }
function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { if (!isPlainDataRecord(value)) throw invalid(`${label} must be a plain data object`); const candidate = value; const actual = Object.keys(candidate).sort(compareCodePoints); const expected = [...keys].sort(compareCodePoints); if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) throw invalid(`${label} has unexpected fields`); return candidate; }
function isPlainDataRecord(value: unknown): value is Record<string, unknown> { if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) return false; const keys = Reflect.ownKeys(value); return keys.every((key) => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value') && Object.getOwnPropertyDescriptor(value, key)!.enumerable === true); }
function boundedArray(value: unknown, label: string, maximum: number): unknown[] { if (!isPlainDenseArray(value)) throw invalid(`${label} must be a plain dense array`); if (value.length > maximum) throw invalid(`${label} exceeds the ${maximum}-entry limit`); return value; }
function isPlainDenseArray(value: unknown): value is unknown[] { if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false; const descriptors = Object.getOwnPropertyDescriptors(value); for (let index = 0; index < value.length; index += 1) { const descriptor = descriptors[String(index)]; if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return false; } return true; }
function copyPolicy(policy: CapturedProfileLimitPolicy): CapturedProfileLimitPolicy { try { return capturedProfileLimitPolicy(policy); } catch (error) { throw new BazframeError('PROFILE_PUBLICATION_STATE_INVALID', 'Invalid profile publication state: limit policy is invalid.', { cause: error }); } }
function canonical(value: ManagedProfileStateV1): string { return `${JSON.stringify(value, null, 2)}\n`; }
function compareBinding(left: CapturedResourceIdBinding, right: CapturedResourceIdBinding): number { return compareCodePoints(left.resourceIdentityDigest, right.resourceIdentityDigest) || compareCodePoints(left.capturedResourceId, right.capturedResourceId); }
function compareCodePoints(left: string, right: string): number { const a = [...left].map((character) => character.codePointAt(0)!); const b = [...right].map((character) => character.codePointAt(0)!); for (let index = 0; index < Math.min(a.length, b.length); index += 1) { if (a[index] !== b[index]) return a[index]! - b[index]!; } return a.length - b.length; }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_PUBLICATION_STATE_INVALID', `Invalid profile publication state: ${detail}.`); }
