import { describe, expect, it } from 'vitest';
import { capturedResourceId, importedResourceIdentity, profileLocalResourceIdentity, profileLocalResourceInstanceId, resourceIdentityDigest } from '../../../src/profile-publishing/captured-profile.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import {
  duplicateManagedProfileState,
  initialManagedProfileState,
  planProfileStateMigration
} from '../../../src/profile-publishing/profile-state-migration.js';
import { encodeManagedProfileState, type CapturedResourceIdBinding, type ManagedProfileStateV1 } from '../../../src/profile-publishing/publication-state.js';

const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const duplicateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const importedId = '11111111-1111-4111-8111-111111111111';
const retainedId = '22222222-2222-4222-8222-222222222222';
const currentCapture = '1'.repeat(64);
const retainedCapture = '2'.repeat(64);
const ordinaryCapture = '3'.repeat(64);

function importedBinding(instanceId: string, capturedResourceId: string): CapturedResourceIdBinding {
  return { resourceIdentityDigest: resourceIdentityDigest(importedResourceIdentity(instanceId)), capturedResourceId, identityKind: 'imported', instanceId };
}

function managedState(): ManagedProfileStateV1 {
  const bindings: CapturedResourceIdBinding[] = [
    importedBinding(importedId, currentCapture),
    importedBinding(retainedId, retainedCapture),
    { resourceIdentityDigest: 'f'.repeat(64), capturedResourceId: ordinaryCapture, identityKind: 'catalog' as const, instanceId: null }
  ].sort((left, right) => left.resourceIdentityDigest.localeCompare(right.resourceIdentityDigest) || left.capturedResourceId.localeCompare(right.capturedResourceId));
  return {
    schemaVersion: 1,
    profileInstanceId: profileId,
    publication: {
      transport: 'git', origin: 'github.com/owner/profile', installedCommit: 'a'.repeat(40), latestSeenCommit: 'b'.repeat(40),
      baselineCaptureSha256: 'c'.repeat(64), visibility: 'private'
    },
    capturedResourceIds: bindings,
    importedResources: [{
      instanceId: importedId,
      capturedResourceId: currentCapture,
      key: { kind: 'skill', name: 'review' },
      source: { kind: 'artifact', treeId: 'd'.repeat(64) }
    }]
  };
}

describe('hidden profile state migration planning', () => {
  it('creates canonical empty initial state and does not eagerly adopt during inspection', () => {
    const initial = initialManagedProfileState(profileId);
    expect(encodeManagedProfileState(initial, capturedProfileLimitPolicy())).toBe(`${JSON.stringify({
      schemaVersion: 1,
      profileInstanceId: profileId,
      publication: null,
      capturedResourceIds: [],
      importedResources: []
    }, null, 2)}\n`);
    expect(planProfileStateMigration({ intent: 'inspect', desiredState: initial })).toEqual({ action: 'none', state: null });
    expect(planProfileStateMigration({ intent: 'adopt', desiredState: initial })).toEqual({ action: 'write', state: initial });
  });

  it('retains an identical existing state and refuses a conflict', () => {
    const desired = managedState();
    const retained = planProfileStateMigration({ intent: 'adopt', existingState: structuredClone(desired), desiredState: desired });
    expect(retained).toEqual({ action: 'retain', state: desired });
    if (retained.state !== null) retained.state.profileInstanceId = duplicateId;
    expect(desired.profileInstanceId).toBe(profileId);
    const conflicting = { ...desired, publication: null };
    expect(() => planProfileStateMigration({ intent: 'adopt', existingState: conflicting, desiredState: desired }))
      .toThrow(expect.objectContaining({ code: 'PROFILE_STATE_MIGRATION_CONFLICT' }));
  });

  it('duplicates lazily with a new profile identity, no publication, and only imported retained bindings', () => {
    expect(duplicateManagedProfileState(undefined, duplicateId)).toBeUndefined();
    const source = managedState();
    const duplicate = duplicateManagedProfileState(source, duplicateId)!;
    expect(duplicate.profileInstanceId).toBe(duplicateId);
    expect(duplicate.publication).toBeNull();
    expect(duplicate.importedResources).toEqual(source.importedResources);
    expect(duplicate.capturedResourceIds).toEqual(source.capturedResourceIds.filter((binding) => binding.instanceId !== null));
    expect(duplicate.capturedResourceIds.map((binding) => binding.instanceId)).toContain(retainedId);
    duplicate.importedResources[0]!.key.name = 'changed';
    duplicate.capturedResourceIds[0]!.capturedResourceId = '9'.repeat(64);
    expect(source.importedResources[0]!.key.name).toBe('review');
    expect(source.capturedResourceIds.some((binding) => binding.capturedResourceId === '9'.repeat(64))).toBe(false);
  });

  it('forks mutable physical profile-local identity while retaining imported immutable identity', () => {
    const source = managedState();
    const sourceLocalInstance = profileLocalResourceInstanceId(profileId, 'local');
    const sourceLocalIdentity = profileLocalResourceIdentity(sourceLocalInstance);
    source.capturedResourceIds.push({
      resourceIdentityDigest: resourceIdentityDigest(sourceLocalIdentity),
      capturedResourceId: capturedResourceId('skill', sourceLocalIdentity),
      identityKind: 'profileLocal',
      instanceId: sourceLocalInstance
    });
    source.capturedResourceIds.sort((left, right) => left.resourceIdentityDigest.localeCompare(right.resourceIdentityDigest) || left.capturedResourceId.localeCompare(right.capturedResourceId));

    const duplicate = duplicateManagedProfileState(source, duplicateId, ['local'])!;
    const duplicateLocalInstance = profileLocalResourceInstanceId(duplicateId, 'local');
    const duplicateLocalIdentity = profileLocalResourceIdentity(duplicateLocalInstance);
    expect(duplicate.capturedResourceIds).toContainEqual({
      resourceIdentityDigest: resourceIdentityDigest(duplicateLocalIdentity),
      capturedResourceId: capturedResourceId('skill', duplicateLocalIdentity),
      identityKind: 'profileLocal',
      instanceId: duplicateLocalInstance
    });
    expect(duplicate.capturedResourceIds).not.toContainEqual(expect.objectContaining({ instanceId: sourceLocalInstance }));
    expect(duplicate.capturedResourceIds).toContainEqual(expect.objectContaining({ instanceId: importedId, identityKind: 'imported' }));
  });

  it('rejects malformed, accessor, proxy, and invalid duplicate inputs', () => {
    const desired = initialManagedProfileState(profileId);
    expect(() => planProfileStateMigration({ intent: 'write' as never, desiredState: desired })).toThrow(expect.objectContaining({ code: 'PROFILE_STATE_MIGRATION_INVALID' }));
    const accessor = Object.defineProperty({}, 'intent', { get: () => 'adopt', enumerable: true });
    expect(() => planProfileStateMigration(accessor as never)).toThrow(expect.objectContaining({ code: 'PROFILE_STATE_MIGRATION_INVALID' }));
    expect(() => planProfileStateMigration(new Proxy({ intent: 'adopt', desiredState: desired }, {}) as never)).toThrow(expect.objectContaining({ code: 'PROFILE_STATE_MIGRATION_INVALID' }));
    expect(() => duplicateManagedProfileState(undefined, 'not-a-uuid')).toThrow(expect.objectContaining({ code: 'PROFILE_STATE_MIGRATION_INVALID' }));
    expect(() => duplicateManagedProfileState(desired, 'not-a-uuid')).toThrow(expect.objectContaining({ code: 'PROFILE_STATE_MIGRATION_INVALID' }));
    expect(() => duplicateManagedProfileState({ ...desired, extra: true }, duplicateId)).toThrow(expect.objectContaining({ code: 'PROFILE_STATE_MIGRATION_INVALID' }));
  });
});
