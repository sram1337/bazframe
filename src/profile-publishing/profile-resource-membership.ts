import { BazframeError } from '../core/errors.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { capturePhysicalProfileExpectation } from './physical-profile-closure.js';
import { copyPhysicalProfileClosureToCandidate } from './profile-publication.js';
import { executeProfileCandidateSwap } from './profile-transaction.js';
import { importedResourceIdentity, profileInstanceIdFromPhysicalIdentity, type ResourceKind } from './captured-profile.js';
import { readOptionalManagedProfileState } from './managed-profile-state.js';
import { readProfileSystemView, resolveProfileResourceSelector, type ProfileResourceInstanceView } from './profile-view.js';
import type { CapturedResourceIdBinding, ImportedResourceState, ManagedProfileStateV1 } from './publication-state.js';

export interface ProfileResourceMembershipSelection {
  stableIdentity: string;
  resource: ProfileResourceInstanceView;
}

export interface ImportedProfileResourceMembershipResult {
  action: 'added' | 'current' | 'removed' | 'absent';
  profileId: string;
  stableIdentity: string;
  kind: ResourceKind;
  name: string;
}

export async function resolveProfileResourceMembershipSelection(
  home: string,
  kind: ResourceKind,
  selector: string
): Promise<ProfileResourceMembershipSelection> {
  const view = await readProfileSystemView(home);
  const stableIdentity = resolveProfileResourceSelector(view, kind, selector);
  const resource = view.resources.find((candidate) => candidate.stableIdentity === stableIdentity);
  if (resource === undefined) throw invalid('resolved resource is absent from the system view');
  return { stableIdentity, resource };
}

export async function mutateImportedProfileResourceMembership(
  home: string,
  profileId: string,
  stableIdentity: string,
  action: 'add' | 'remove'
): Promise<ImportedProfileResourceMembershipResult> {
  assertSafeProfileId(profileId);
  if (!stableIdentity.startsWith('imported:')) throw invalid('resource is not an imported immutable instance');
  const initialView = await readProfileSystemView(home);
  const selected = requiredImported(initialView.resources, stableIdentity);
  const target = initialView.profiles.find((profile) => profile.name === profileId);
  if (target === undefined) throw new BazframeError('PROFILE_NOT_FOUND', `Profile not found: ${profileId}`);
  const alreadyOwned = selected.ownerProfiles.includes(profileId);
  if ((action === 'add' && alreadyOwned) || (action === 'remove' && !alreadyOwned)) {
    return result(action === 'add' ? 'current' : 'absent', profileId, selected);
  }
  if (action === 'add' && initialView.resources.some((resource) => resource.stableIdentity !== stableIdentity
    && resource.key.kind === selected.key.kind && resource.key.name === selected.key.name && resource.ownerProfiles.includes(profileId))) {
    throw new BazframeError('PROFILE_RESOURCE_SELECTOR_INVALID', 'Profile resource selector is ambiguous, stale, or invalid.');
  }

  const source = await importedStateFor(initialView, home, selected);
  const expected = await capturePhysicalProfileExpectation(home, profileId);
  const targetSnapshot = await readOptionalManagedProfileState(home, profileId);
  if ((targetSnapshot?.sha256 ?? null) !== expected.sidecarSha256) throw changed();
  const targetState = targetSnapshot?.state ?? emptyState(profileInstanceIdFromPhysicalIdentity(expected.identity));
  const nextState = updateState(targetState, source.resource, source.binding, action);
  const lockKeys = selected.ownerProfiles.filter((owner) => owner !== profileId);

  await executeProfileCandidateSwap({
    home,
    profileName: profileId,
    operation: 'update',
    expectedOld: expected,
    additionalOperationLockKeys: lockKeys,
    beforePublication: async () => {
      const current = requiredImported((await readProfileSystemView(home)).resources, stableIdentity);
      if (JSON.stringify(current) !== JSON.stringify(selected)) throw changed();
    },
    materialize: async (candidateDirectory) => {
      await copyPhysicalProfileClosureToCandidate(home, profileId, expected, candidateDirectory);
      const currentView = await readProfileSystemView(home);
      const current = requiredImported(currentView.resources, stableIdentity);
      if (JSON.stringify(current) !== JSON.stringify(selected)) throw changed();
      const currentSource = await importedStateFor(currentView, home, current);
      if (JSON.stringify(currentSource) !== JSON.stringify(source)) throw changed();
      return { state: nextState };
    }
  });
  return result(action === 'add' ? 'added' : 'removed', profileId, selected);
}

function requiredImported(resources: readonly ProfileResourceInstanceView[], stableIdentity: string): ProfileResourceInstanceView {
  const resource = resources.find((candidate) => candidate.stableIdentity === stableIdentity);
  if (resource === undefined || resource.materialization.kind === 'ordinary' || resource.materialization.kind === 'profileLocal') {
    throw new BazframeError('PROFILE_RESOURCE_SELECTOR_INVALID', 'Profile resource selector is ambiguous, stale, or invalid.');
  }
  return resource;
}

async function importedStateFor(
  view: Awaited<ReturnType<typeof readProfileSystemView>>,
  home: string,
  resource: ProfileResourceInstanceView
): Promise<{ resource: ImportedResourceState; binding: CapturedResourceIdBinding }> {
  let found: { resource: ImportedResourceState; binding: CapturedResourceIdBinding } | undefined;
  for (const owner of resource.ownerProfiles) {
    const snapshot = await readOptionalManagedProfileState(home, owner);
    if (snapshot === undefined) throw changed();
    const imported = snapshot.state.importedResources.find((candidate) => importedResourceIdentity(candidate.instanceId) === resource.stableIdentity);
    if (imported === undefined) throw changed();
    const binding = snapshot.state.capturedResourceIds.find((candidate) => candidate.capturedResourceId === imported.capturedResourceId);
    if (binding === undefined || binding.identityKind !== 'imported' || binding.instanceId !== imported.instanceId) throw changed();
    const candidate = { resource: structuredClone(imported), binding: { ...binding } };
    if (found !== undefined && JSON.stringify(found) !== JSON.stringify(candidate)) throw invalid('shared imported instance has conflicting transported identity or source');
    found = candidate;
  }
  if (found === undefined || !view.resources.some((candidate) => candidate.stableIdentity === resource.stableIdentity)) throw changed();
  return found;
}

function emptyState(profileInstanceId: string): ManagedProfileStateV1 {
  return { schemaVersion: 1, profileInstanceId, publication: null, capturedResourceIds: [], importedResources: [] };
}

function updateState(
  state: ManagedProfileStateV1,
  resource: ImportedResourceState,
  binding: CapturedResourceIdBinding,
  action: 'add' | 'remove'
): ManagedProfileStateV1 {
  const importedResources = state.importedResources.filter((candidate) => candidate.instanceId !== resource.instanceId);
  const capturedResourceIds = state.capturedResourceIds.map((candidate) => ({ ...candidate }));
  if (action === 'add') {
    const capturedConflict = capturedResourceIds.find((candidate) => candidate.capturedResourceId === binding.capturedResourceId);
    const identityConflict = capturedResourceIds.find((candidate) => candidate.resourceIdentityDigest === binding.resourceIdentityDigest);
    if ((capturedConflict !== undefined && JSON.stringify(capturedConflict) !== JSON.stringify(binding))
      || (identityConflict !== undefined && JSON.stringify(identityConflict) !== JSON.stringify(binding))) {
      throw invalid('target profile has a conflicting captured-resource binding');
    }
    if (capturedConflict === undefined && identityConflict === undefined) capturedResourceIds.push({ ...binding });
    importedResources.push(structuredClone(resource));
  }
  capturedResourceIds.sort(compareBindings);
  importedResources.sort((left, right) => compare(left.instanceId, right.instanceId));
  return { ...structuredClone(state), capturedResourceIds, importedResources };
}

function compareBindings(left: CapturedResourceIdBinding, right: CapturedResourceIdBinding): number {
  return compare(left.resourceIdentityDigest, right.resourceIdentityDigest) || compare(left.capturedResourceId, right.capturedResourceId);
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function result(action: ImportedProfileResourceMembershipResult['action'], profileId: string, resource: ProfileResourceInstanceView): ImportedProfileResourceMembershipResult {
  return { action, profileId, stableIdentity: resource.stableIdentity, kind: resource.key.kind, name: resource.key.name };
}
function changed(): BazframeError { return new BazframeError('PROFILE_LIFECYCLE_CHANGED', 'Profile resource membership changed during lifecycle authorization.'); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_LIFECYCLE_INVALID', `Invalid profile resource membership: ${detail}.`); }
