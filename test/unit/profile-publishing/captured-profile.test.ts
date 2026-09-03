import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertBlobBytes,
  capturedProfileContentBaselineSha256,
  capturedResourceId,
  decodeCapturedProfileBytes,
  decodeCapturedProfileObject,
  encodeCapturedProfile,
  importedResourceIdentity,
  ordinaryResourceIdentity,
  profileInstanceIdFromPhysicalIdentity,
  profileLocalResourceIdentity,
  profileLocalResourceInstanceId,
  resourceIdentityDigest,
  type CapturedProfileV1
} from '../../../src/profile-publishing/captured-profile.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const policy = capturedProfileLimitPolicy({ maxManifestBytes: 64 * 1024, maxBlobBytes: 1024, maxAggregateBytes: 4096 });
const remote = (name: string) => ({ remote: `example.test/team/${name}`, fetchUrl: `https://example.test/team/${name}.git`, branch: 'main', revision: 'a'.repeat(40) });

function fixture(): CapturedProfileV1 {
  const instruction = Buffer.from('instructions\n');
  const skill = Buffer.from('skill\n');
  const skillIdentity = ordinaryResourceIdentity('skill', 'review');
  const libraryIdentity = ordinaryResourceIdentity('library', 'tools');
  return {
    schemaVersion: 1,
    kind: 'bazframe-captured-profile',
    profile: { name: 'work', instructions: { path: 'AGENTS.md', sha256: sha('instructions\n'), bytes: instruction.byteLength, executable: false } },
    resources: [
      { id: capturedResourceId('skill', skillIdentity), key: { kind: 'skill', name: 'review' }, payload: { kind: 'bundled', role: 'skill', files: [{ path: 'SKILL.md', sha256: sha('skill\n'), bytes: skill.byteLength, executable: false }] } },
      { id: capturedResourceId('library', libraryIdentity), key: { kind: 'library', name: 'tools' }, payload: { kind: 'remoteGit', identity: remote('tools') } }
    ],
    blobs: [
      { sha256: sha('skill\n'), bytes: skill.byteLength },
      { sha256: sha('instructions\n'), bytes: instruction.byteLength }
    ].sort((left, right) => left.sha256.localeCompare(right.sha256))
  };
}

describe('captured profile codec', () => {
  it('round-trips exact canonical bytes and validates physical blobs', () => {
    const value = fixture();
    const encoded = encodeCapturedProfile(value, policy);
    expect(decodeCapturedProfileBytes(Buffer.from(encoded), policy)).toEqual(value);
    expect(() => assertBlobBytes(value.blobs.find((blob) => blob.sha256 === sha('skill\n'))!, Buffer.from('skill\n'))).not.toThrow();
    expect(() => assertBlobBytes(value.blobs[0]!, Buffer.from('wrong'))).toThrow(/physical blob bytes/u);
    expect(() => decodeCapturedProfileBytes(Buffer.from(encoded.trimEnd()), policy)).toThrow(/not canonical/u);
  });

  it('accepts only the non-identifying profile-local source-form marker on bundled direct Skills', () => {
    const marked = fixture();
    const payload = marked.resources[0]!.payload;
    if (payload.kind !== 'bundled') throw new Error('fixture error');
    payload.sourceForm = 'profile-local';
    expect(decodeCapturedProfileObject(marked, policy).resources[0]!.payload).toMatchObject({ sourceForm: 'profile-local' });
    const wrongRole = structuredClone(marked);
    object(object(array(object(wrongRole).resources)[0]).key).kind = 'library';
    object(object(array(object(wrongRole).resources)[0]).payload).role = 'library';
    expect(() => decodeCapturedProfileObject(wrongRole, policy)).toThrow(/source form/u);
    const withOrigin = structuredClone(marked);
    object(object(array(object(withOrigin).resources)[0]).payload).origin = remote('review');
    expect(() => decodeCapturedProfileObject(withOrigin, policy)).toThrow(/cannot combine/u);
  });

  it('derives a name-invariant content baseline that changes for transported bytes', () => {
    const value = fixture();
    const renamed = { ...value, profile: { ...value.profile, name: 'renamed' } };
    const changed = { ...value, profile: { ...value.profile, instructions: { ...value.profile.instructions, executable: true } } };
    expect(capturedProfileContentBaselineSha256(renamed, policy)).toBe(capturedProfileContentBaselineSha256(value, policy));
    expect(capturedProfileContentBaselineSha256(changed, policy)).not.toBe(capturedProfileContentBaselineSha256(value, policy));
  });

  it('derives domain-separated stable identities without encoding UUIDs in a capture', () => {
    const ordinary = ordinaryResourceIdentity('skill', 'review');
    const imported = importedResourceIdentity('123e4567-e89b-12d3-a456-426614174000');
    const profileInstance = profileInstanceIdFromPhysicalIdentity('1:2');
    const localInstance = profileLocalResourceInstanceId(profileInstance, 'review');
    const local = profileLocalResourceIdentity(localInstance);
    expect(profileInstance).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(profileInstanceIdFromPhysicalIdentity('1:2')).toBe(profileInstance);
    expect(local).toBe(`profileLocal:${localInstance}`);
    expect(capturedResourceId('skill', ordinary)).toBe(sha(`bazframe-captured-resource-v1\0skill\0${ordinary}`));
    expect(resourceIdentityDigest(imported)).toBe(sha(`bazframe-resource-identity-digest-v1\0${imported}`));
    expect(capturedResourceId('skill', local)).not.toBe(capturedResourceId('skill', ordinary));
    expect(() => importedResourceIdentity('not-a-uuid')).toThrow(/UUID/u);
  });

  const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
  const array = (value: unknown): unknown[] => value as unknown[];

  it.each([
    ['negative byte count', (value: unknown) => { object(object(object(value).profile).instructions).bytes = -1; }],
    ['negative zero byte count', (value: unknown) => { object(object(object(value).profile).instructions).bytes = -0; }],
    ['unsafe integer byte count', (value: unknown) => { object(object(object(value).profile).instructions).bytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['orphan blob', (value: unknown) => { array(object(value).blobs).push({ sha256: 'f'.repeat(64), bytes: 1 }); }],
    ['duplicate blob', (value: unknown) => { array(object(value).blobs).push({ ...array(object(value).blobs)[0] as object }); }],
    ['missing blob', (value: unknown) => { array(object(value).blobs).pop(); }],
    ['unsafe path', (value: unknown) => { object(array(object(object(array(object(value).resources)[0]).payload).files)[0]).path = '../SKILL.md'; }],
    ['unpaired surrogate path', (value: unknown) => { object(array(object(object(array(object(value).resources)[0]).payload).files)[0]).path = 'bad\ud800'; }],
    ['wrong payload role', (value: unknown) => { object(object(array(object(value).resources)[0]).payload).role = 'library'; }],
    ['unordered resources', (value: unknown) => { array(object(value).resources).reverse(); }],
    ['duplicate resource ID', (value: unknown) => { array(object(value).resources)[1] = { ...object(array(object(value).resources)[1]), id: object(array(object(value).resources)[0]).id }; }],
    ['unknown root field', (value: unknown) => { object(value).extra = true; }],
    ['unknown nested field', (value: unknown) => { object(object(array(object(value).resources)[0]).key).extra = true; }]
  ])('rejects %s', (_label, mutate) => {
    const value: unknown = structuredClone(fixture());
    mutate(value);
    expect(() => decodeCapturedProfileObject(value, policy)).toThrow(/Invalid captured profile/u);
  });

  it('rejects duplicate keys, malformed UTF-8, and every noncanonical byte form', () => {
    const encoded = encodeCapturedProfile(fixture(), policy);
    const duplicateKey = encoded.replace('  "schemaVersion": 1,', '  "schemaVersion": 1,\n  "schemaVersion": 1,');
    expect(() => decodeCapturedProfileBytes(Buffer.from(duplicateKey), policy)).toThrow(/not canonical/u);
    expect(() => decodeCapturedProfileBytes(Uint8Array.from([0xc3, 0x28]), policy)).toThrow(/not valid UTF-8/u);
    expect(() => decodeCapturedProfileBytes(Buffer.from(JSON.stringify(fixture())), policy)).toThrow(/not canonical/u);
  });

  it('enforces exact numeric, aggregate, path byte, and depth boundaries', () => {
    expect(() => decodeCapturedProfileObject(fixture(), capturedProfileLimitPolicy({ maxBlobBytes: 13, maxAggregateBytes: 19, maxPathBytes: 8, maxDepth: 1 }))).not.toThrow();
    expect(() => decodeCapturedProfileObject(fixture(), capturedProfileLimitPolicy({ maxAggregateBytes: 18 }))).toThrow(/aggregate limit/u);
    const pathValue = fixture();
    const pathPayload = pathValue.resources[0]!.payload;
    if (pathPayload.kind !== 'bundled') throw new Error('fixture error');
    pathPayload.files[0]!.path = '123456789';
    expect(() => decodeCapturedProfileObject(pathValue, capturedProfileLimitPolicy({ maxPathBytes: 8 }))).toThrow(/path is invalid/u);
    pathPayload.files[0]!.path = 'a/b';
    expect(() => decodeCapturedProfileObject(pathValue, capturedProfileLimitPolicy({ maxDepth: 1 }))).toThrow(/path is invalid/u);
  });

  it.each([
    ['absolute path', '/root'],
    ['backslash', 'a\\b'],
    ['drive prefix', 'C:file'],
    ['empty segment', 'a//b'],
    ['dot segment', 'a/./b'],
    ['control character', 'a\u001fb']
  ])('rejects %s path forms', (_label, path) => {
    const value = fixture();
    const payload = value.resources[0]!.payload;
    if (payload.kind !== 'bundled') throw new Error('fixture error');
    payload.files[0]!.path = path;
    expect(() => decodeCapturedProfileObject(value, policy)).toThrow(/path is invalid/u);
  });

  it.each([
    ['normalization', ['e\u0301', '\u00e9']],
    ['sigma/final-sigma fold', ['\u03a3', '\u03c2']],
    ['lowercase sharp-s expansion', ['ss', '\u00df']],
    ['uppercase sharp-s expansion', ['ss', '\u1e9e']],
    ['ASCII case', ['A', 'a']]
  ])('rejects %s portable path collisions', (_label, paths) => {
    const value = fixture();
    const payload = value.resources[0]!.payload;
    if (payload.kind !== 'bundled') throw new Error('fixture error');
    payload.files = paths.map((path) => ({ ...payload.files[0]!, path }));
    expect(() => decodeCapturedProfileObject(value, policy)).toThrow(/portable case collision/u);
  });

  it('rejects hostile remote identities, including all URL userinfo, and accepts 64-hex revisions', () => {
    const valid = fixture();
    const payload = valid.resources[1]!.payload;
    if (payload.kind !== 'remoteGit') throw new Error('fixture error');
    payload.identity.revision = 'f'.repeat(64);
    expect(() => decodeCapturedProfileObject(valid, policy)).not.toThrow();
    for (const identity of [
      { ...remote('tools'), fetchUrl: 'https://user@example.test/team/tools.git' },
      { ...remote('tools'), fetchUrl: 'ssh://git@example.test/team/tools.git', remote: 'example.test/team/tools' },
      { ...remote('tools'), fetchUrl: 'https://example.test/team/tools.git?token=x' },
      { ...remote('tools'), fetchUrl: 'https://example.test/team/tools.git#x' },
      { ...remote('tools'), remote: 'other.test/team/tools' }
    ]) {
      const value = fixture();
      const candidate = value.resources[1]!.payload;
      if (candidate.kind !== 'remoteGit') throw new Error('fixture error');
      candidate.identity = identity;
      expect(() => decodeCapturedProfileObject(value, policy)).toThrow(/remote Git identity is invalid/u);
    }
  });

  it('rejects a time-varying Proxy before reading any fields', () => {
    let reads = 0;
    const proxied = new Proxy(fixture(), {
      get(target, property, receiver) {
        reads += 1;
        if (property === 'schemaVersion') return reads % 2;
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => decodeCapturedProfileObject(proxied, policy)).toThrow(/plain data object/u);
    expect(reads).toBe(0);
  });

  it('uses generic path diagnostics and rejects accessor or custom-prototype objects', () => {
    const hostile = fixture();
    const payload = hostile.resources[0]!.payload;
    if (payload.kind !== 'bundled') throw new Error('fixture error');
    payload.files[0]!.path = 'safe\u202espell';
    payload.files[0]!.sha256 = 'f'.repeat(64);
    try { decodeCapturedProfileObject(hostile, policy); } catch (error) { expect(String(error)).not.toContain('safe'); }
    const accessor = structuredClone(fixture()) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, 'kind', { enumerable: true, get: () => 'bazframe-captured-profile' });
    expect(() => decodeCapturedProfileObject(accessor, policy)).toThrow(/plain data object/u);
    expect(() => decodeCapturedProfileObject(Object.assign(Object.create({}), fixture()), policy)).toThrow(/plain data object/u);
  });
});
