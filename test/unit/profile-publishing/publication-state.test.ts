import { describe, expect, it } from 'vitest';
import {
  importedResourceIdentity,
  profileLocalResourceIdentity,
  resourceIdentityDigest
} from '../../../src/profile-publishing/captured-profile.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import {
  decodeManagedProfileStateBytes,
  decodeManagedProfileStateObject,
  encodeManagedProfileState,
  isReservedProfileSiblingName,
  type ManagedProfileStateV1
} from '../../../src/profile-publishing/publication-state.js';

const policy = capturedProfileLimitPolicy({ maxManifestBytes: 64 * 1024, maxResources: 8 });
const instanceId = '123e4567-e89b-12d3-a456-426614174000';
const capturedResourceId = 'a'.repeat(64);

function fixture(): ManagedProfileStateV1 {
  return {
    schemaVersion: 1,
    profileInstanceId: '123e4567-e89b-12d3-a456-426614174001',
    publication: {
      transport: 'git',
      origin: 'github.com/example/work',
      installedCommit: 'b'.repeat(40),
      latestSeenCommit: 'c'.repeat(40),
      baselineCaptureSha256: 'd'.repeat(64),
      visibility: 'private'
    },
    capturedResourceIds: [{ resourceIdentityDigest: resourceIdentityDigest(importedResourceIdentity(instanceId)), capturedResourceId, identityKind: 'imported', instanceId }],
    importedResources: [{
      instanceId,
      capturedResourceId,
      key: { kind: 'skill', name: 'review' },
      source: { kind: 'artifact', treeId: 'e'.repeat(64) }
    }]
  };
}

describe('managed profile publication state', () => {
  it('round-trips canonical sidecar bytes', () => {
    const value = fixture();
    const encoded = encodeManagedProfileState(value, policy);
    expect(decodeManagedProfileStateBytes(Buffer.from(encoded), policy)).toEqual(value);
    expect(() => decodeManagedProfileStateBytes(Buffer.from(` ${encoded}`), policy)).toThrow(/not canonical/u);
  });

  it('validates explicit profile-local bindings without treating them as imported artifacts', () => {
    const localInstance = '223e4567-e89b-82d3-a456-426614174000';
    const localIdentity = profileLocalResourceIdentity(localInstance);
    const value = fixture();
    value.capturedResourceIds.push({
      resourceIdentityDigest: resourceIdentityDigest(localIdentity),
      capturedResourceId: 'f'.repeat(64),
      identityKind: 'profileLocal',
      instanceId: localInstance
    });
    value.capturedResourceIds.sort((left, right) => left.resourceIdentityDigest.localeCompare(right.resourceIdentityDigest) || left.capturedResourceId.localeCompare(right.capturedResourceId));
    expect(decodeManagedProfileStateObject(value, policy)).toEqual(value);
    value.capturedResourceIds.find((binding) => binding.identityKind === 'profileLocal')!.identityKind = 'imported';
    expect(() => decodeManagedProfileStateObject(value, policy)).toThrow(/does not match its resource identity/u);
  });

  it('validates remote source identity variants', () => {
    const value = fixture();
    value.importedResources[0]!.source = {
      kind: 'remoteGit',
      identity: { remote: 'example.test/team/review', fetchUrl: 'https://example.test/team/review.git', branch: 'main', revision: 'f'.repeat(40) },
      treeId: 'e'.repeat(64)
    };
    expect(decodeManagedProfileStateObject(value, policy)).toEqual(value);
  });

  it('rejects bindings and imported instances that are not canonical or closed', () => {
    const orphan = fixture();
    orphan.importedResources[0]!.capturedResourceId = 'f'.repeat(64);
    expect(() => decodeManagedProfileStateObject(orphan, policy)).toThrow(/one unique binding/u);

    const duplicate = fixture();
    duplicate.capturedResourceIds.push({ ...duplicate.capturedResourceIds[0]! });
    expect(() => decodeManagedProfileStateObject(duplicate, policy)).toThrow(/canonical order/u);

    const unsorted = fixture();
    unsorted.importedResources.push({ ...unsorted.importedResources[0]! });
    expect(() => decodeManagedProfileStateObject(unsorted, policy)).toThrow(/ordered/u);
  });

  it('rejects duplicate resource identity digests even with distinct captured resource IDs', () => {
    const duplicateIdentity = fixture();
    duplicateIdentity.capturedResourceIds.push({
      resourceIdentityDigest: duplicateIdentity.capturedResourceIds[0]!.resourceIdentityDigest,
      capturedResourceId: 'b'.repeat(64),
      identityKind: 'imported',
      instanceId
    });
    expect(() => decodeManagedProfileStateObject(duplicateIdentity, policy)).toThrow(/unique resourceIdentityDigest values/u);
  });

  it('rejects binding digests that do not match the imported instance identity', () => {
    const wrongInstance = fixture();
    wrongInstance.importedResources[0]!.instanceId = '123e4567-e89b-12d3-a456-426614174002';
    expect(() => decodeManagedProfileStateObject(wrongInstance, policy)).toThrow(/does not match its resource identity binding/u);

    const catalogDigest = fixture();
    catalogDigest.capturedResourceIds[0]!.resourceIdentityDigest = '0'.repeat(64);
    expect(() => decodeManagedProfileStateObject(catalogDigest, policy)).toThrow(/does not match its resource identity/u);
  });

  it.each([
    'github.com/example/.',
    'github.com/example/..',
    'github.com/example/_repo',
    'github.com/example/-repo',
    'github.com/example/repo.git',
    `github.com/example/${'a'.repeat(101)}`,
    'github.com/Example/work',
    'github.com/example/Work',
    'git:example/work',
    'gitlab.com/example/work'
  ])('rejects noncanonical publication origin %s', (origin) => {
    const value = fixture();
    value.publication!.origin = origin;
    expect(() => decodeManagedProfileStateObject(value, policy)).toThrow(/publication origin is invalid/u);
  });

  it('accepts canonical generic GitHub profile repository names', () => {
    const value = fixture();
    value.publication!.origin = `github.com/example/repo_name-${'a'.repeat(70)}`;
    expect(decodeManagedProfileStateObject(value, policy).publication?.origin).toBe(value.publication!.origin);
  });

  it('accepts 40- and 64-hex commits and rejects other commit forms', () => {
    const value = fixture();
    value.publication!.installedCommit = 'a'.repeat(64);
    value.publication!.latestSeenCommit = 'f'.repeat(64);
    expect(() => decodeManagedProfileStateObject(value, policy)).not.toThrow();
    value.publication!.installedCommit = 'a'.repeat(39);
    expect(() => decodeManagedProfileStateObject(value, policy)).toThrow(/installedCommit/u);
  });

  it('rejects hostile imported remote identities including ssh git userinfo', () => {
    for (const identity of [
      { remote: 'example.test/team/review', fetchUrl: 'https://user@example.test/team/review.git', branch: 'main', revision: 'f'.repeat(40) },
      { remote: 'example.test/team/review', fetchUrl: 'ssh://git@example.test/team/review.git', branch: 'main', revision: 'f'.repeat(40) },
      { remote: 'example.test/team/review', fetchUrl: 'https://example.test/team/review.git?q=x', branch: 'main', revision: 'f'.repeat(40) },
      { remote: 'other.test/team/review', fetchUrl: 'https://example.test/team/review.git', branch: 'main', revision: 'f'.repeat(40) }
    ]) {
      const value = fixture();
      value.importedResources[0]!.source = { kind: 'remoteGit', identity, treeId: 'e'.repeat(64) };
      expect(() => decodeManagedProfileStateObject(value, policy)).toThrow(/remote Git identity is invalid/u);
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
    expect(() => decodeManagedProfileStateObject(proxied, policy)).toThrow(/plain data object/u);
    expect(reads).toBe(0);
  });

  it('rejects duplicate keys, malformed UTF-8, noncanonical bytes, and non-plain objects', () => {
    const encoded = encodeManagedProfileState(fixture(), policy);
    expect(() => decodeManagedProfileStateBytes(Buffer.from(encoded.replace('  "schemaVersion": 1,', '  "schemaVersion": 1,\n  "schemaVersion": 1,')), policy)).toThrow(/not canonical/u);
    expect(() => decodeManagedProfileStateBytes(Uint8Array.from([0xc3, 0x28]), policy)).toThrow(/not valid UTF-8/u);
    expect(() => decodeManagedProfileStateBytes(Buffer.from(JSON.stringify(fixture())), policy)).toThrow(/not canonical/u);
    const accessor = structuredClone(fixture()) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, 'publication', { enumerable: true, get: () => null });
    expect(() => decodeManagedProfileStateObject(accessor, policy)).toThrow(/plain data object/u);
    expect(() => decodeManagedProfileStateObject(Object.assign(Object.create({}), fixture()), policy)).toThrow(/plain data object/u);
  });

  it('recognizes only exact reserved candidate and backup sibling names', () => {
    expect(isReservedProfileSiblingName(`.bazframe-candidate-${'a'.repeat(32)}`)).toBe(true);
    expect(isReservedProfileSiblingName(`.bazframe-backup-${'0'.repeat(32)}`)).toBe(true);
    expect(isReservedProfileSiblingName('.bazframe-candidate-nope')).toBe(false);
  });
});
