import { types as utilTypes } from 'node:util';
import { BazframeError } from '../core/errors.js';
import { capturedResourceId, profileLocalResourceIdentity, profileLocalResourceInstanceId, resourceIdentityDigest } from './captured-profile.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import {
  decodeManagedProfileStateObject,
  encodeManagedProfileState,
  type ManagedProfileStateV1
} from './publication-state.js';

export type ProfileStateMigrationPlan =
  | { action: 'none'; state: null }
  | { action: 'write'; state: ManagedProfileStateV1 }
  | { action: 'retain'; state: ManagedProfileStateV1 };

export interface ProfileStateMigrationInput {
  intent: 'inspect' | 'adopt';
  existingState?: unknown;
  desiredState: unknown;
}

/** Creates the canonical empty state used only when a mutating operation adopts a sidecar-free profile. */
export function initialManagedProfileState(profileInstanceId: string): ManagedProfileStateV1 {
  return validateState({
    schemaVersion: 1,
    profileInstanceId,
    publication: null,
    capturedResourceIds: [],
    importedResources: []
  });
}

/** Pure lazy-adoption planner. Inspection never requests an eager sidecar write. */
export function planProfileStateMigration(input: ProfileStateMigrationInput): ProfileStateMigrationPlan {
  if (!plainRecord(input) || (input.intent !== 'inspect' && input.intent !== 'adopt') || !Object.hasOwn(input, 'desiredState')) throw invalid('migration input is malformed');
  const expectedKeys = input.existingState === undefined
    ? ['desiredState', 'intent']
    : ['desiredState', 'existingState', 'intent'];
  if (Object.keys(input).sort().join(',') !== expectedKeys.join(',')) throw invalid('migration input has unexpected fields');
  const desired = validateState(input.desiredState);
  if (input.existingState === undefined) {
    return input.intent === 'inspect'
      ? { action: 'none', state: null }
      : { action: 'write', state: cloneState(desired) };
  }
  const existing = validateState(input.existingState);
  if (canonical(existing) !== canonical(desired)) throw conflict();
  return { action: 'retain', state: cloneState(existing) };
}

/** Plans the managed-state part of profile duplication without carrying publication linkage. */
export function duplicateManagedProfileState(sourceState: unknown | undefined, newProfileInstanceId: string, profileLocalSkillNames: readonly string[] = []): ManagedProfileStateV1 | undefined {
  initialManagedProfileState(newProfileInstanceId);
  if (sourceState === undefined) return undefined;
  const source = validateState(sourceState);
  const names = [...profileLocalSkillNames];
  if (new Set(names).size !== names.length) throw invalid('profile-local Skill names are not unique');
  const capturedResourceIds = source.capturedResourceIds
    .filter((binding) => binding.identityKind === 'imported')
    .map((binding) => ({ ...binding }));
  for (const binding of source.capturedResourceIds.filter((item) => item.identityKind === 'profileLocal')) {
    const matches = names.filter((name) => resourceIdentityDigest(profileLocalResourceIdentity(profileLocalResourceInstanceId(source.profileInstanceId, name))) === binding.resourceIdentityDigest);
    if (matches.length !== 1) throw invalid('profile-local binding does not match one physical Skill');
    const instanceId = profileLocalResourceInstanceId(newProfileInstanceId, matches[0]!);
    const identity = profileLocalResourceIdentity(instanceId);
    capturedResourceIds.push({ resourceIdentityDigest: resourceIdentityDigest(identity), capturedResourceId: capturedResourceId('skill', identity), identityKind: 'profileLocal', instanceId });
  }
  capturedResourceIds.sort((left, right) => left.resourceIdentityDigest.localeCompare(right.resourceIdentityDigest) || left.capturedResourceId.localeCompare(right.capturedResourceId));
  const duplicate: ManagedProfileStateV1 = {
    schemaVersion: 1,
    profileInstanceId: newProfileInstanceId,
    publication: null,
    capturedResourceIds,
    importedResources: structuredClone(source.importedResources)
  };
  return cloneState(validateState(duplicate));
}

function validateState(value: unknown): ManagedProfileStateV1 {
  try { return decodeManagedProfileStateObject(value, capturedProfileLimitPolicy()); }
  catch (error) {
    if (error instanceof BazframeError && error.code === 'PROFILE_PUBLICATION_STATE_INVALID') {
      throw new BazframeError('PROFILE_STATE_MIGRATION_INVALID', 'Profile state migration input is invalid.', { cause: error });
    }
    throw error;
  }
}
function canonical(state: ManagedProfileStateV1): string { return encodeManagedProfileState(state, capturedProfileLimitPolicy()); }
function cloneState(state: ManagedProfileStateV1): ManagedProfileStateV1 { return validateState(structuredClone(state)); }
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
  });
}
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_STATE_MIGRATION_INVALID', `Invalid profile state migration: ${detail}.`); }
function conflict(): BazframeError { return new BazframeError('PROFILE_STATE_MIGRATION_CONFLICT', 'Existing managed profile state conflicts with the requested migration state.'); }
