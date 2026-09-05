import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { inspectDefaultSkillCatalog } from '../skills/default-skill-catalog.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { scanGlobalSkillCollections } from '../skill-collections/skill-collection-store.js';
import type { PublicationState, ImportedResourceSource } from './publication-state.js';
import { readOptionalManagedProfileState } from './managed-profile-state.js';
import { readArtifactTree } from './artifact-tree.js';
import {
  assertPhysicalProfileExpectation,
  capturePhysicalProfileExpectation,
  physicalProfileLocalSkillNames,
  type PhysicalProfileClosureEntryV1
} from './physical-profile-closure.js';
import {
  assertStablePhysicalDirectory,
  enumerateStableDirectory,
  openStablePhysicalDirectory
} from './profile-filesystem.js';
import { isReservedProfileSiblingName } from './publication-state.js';
import { importedResourceIdentity, profileInstanceIdFromPhysicalIdentity, profileLocalResourceIdentity, profileLocalResourceInstanceId, resourceIdentityDigest, type CapturedResourceKey, type ExactRemoteGitIdentity, type ResourceKind, type Sha256 } from './captured-profile.js';

export type ProfilePublicationVersionState = 'unpublished' | 'latest-installed' | 'older-installed';

export interface ProfileMissingResourceView {
  stableIdentity: string;
  capturedResourceId: Sha256;
  key: CapturedResourceKey;
  diagnosticCode: string;
}

export interface ProfileDomainView {
  name: string;
  profileInstanceId: string | null;
  publication: PublicationState | null;
  publicationVersionState: ProfilePublicationVersionState;
  incomplete: boolean;
  missingResources: ProfileMissingResourceView[];
  resourceIdentities: string[];
}

export type ProfileResourceMaterializationView =
  | { kind: 'ordinary' }
  | { kind: 'profileLocal'; root: string }
  | { kind: 'artifact'; treeId: Sha256; treeRoot: string; role: 'skill' | 'library' | 'packageArtifacts'; origin?: ExactRemoteGitIdentity }
  | { kind: 'remoteGit'; treeId: Sha256; treeRoot: string; role: 'skill' | 'library' | 'packageArtifacts'; identity: Extract<ImportedResourceSource, { kind: 'remoteGit' }>['identity'] }
  | { kind: 'missingRemoteGit'; diagnosticCode: string; identity: Extract<ImportedResourceSource, { kind: 'missingRemoteGit' }>['identity'] };

export interface ProfileResourceInstanceView {
  stableIdentity: string;
  key: CapturedResourceKey;
  ownerProfiles: string[];
  materialization: ProfileResourceMaterializationView;
  projected: boolean;
}

export interface ProfileNamespaceEntry {
  kind: ResourceKind;
  name: string;
  stableIdentity: string;
  displayName: string;
  ownerProfiles: string[];
  selectors: string[];
  projected: boolean;
}

export interface ProfileSkillNamespaceEntry {
  stableIdentity: string;
  sourceResourceIdentity: string;
  sourceKind: ResourceKind;
  name: string;
  displayName: string;
  ownerProfiles: string[];
  selectors: string[];
  directory: string;
  directlyAttachable: boolean;
}

export interface ProfileSystemView {
  profiles: ProfileDomainView[];
  resources: ProfileResourceInstanceView[];
  namespace: ProfileNamespaceEntry[];
  skills: ProfileSkillNamespaceEntry[];
}

export interface ProfileSystemViewReadServices {
  scanProfileNames: typeof scanProfileNames;
  captureExpectation: typeof capturePhysicalProfileExpectation;
  assertExpectation: typeof assertPhysicalProfileExpectation;
  readManagedState: typeof readOptionalManagedProfileState;
  inspectCatalog: typeof inspectDefaultSkillCatalog;
  scanCollections: typeof scanGlobalSkillCollections;
}
const defaultViewReads: ProfileSystemViewReadServices = {
  scanProfileNames, captureExpectation: capturePhysicalProfileExpectation,
  assertExpectation: assertPhysicalProfileExpectation, readManagedState: readOptionalManagedProfileState,
  inspectCatalog: inspectDefaultSkillCatalog, scanCollections: scanGlobalSkillCollections
};

export async function readProfileSystemView(home: string, reads: ProfileSystemViewReadServices = defaultViewReads): Promise<ProfileSystemView> {
  const profileNames = await reads.scanProfileNames(home);
  const profiles: ProfileDomainView[] = [];
  const instances = new Map<string, MutableInstance>();
  const profileInstanceIds = new Set<string>();
  let membershipCount = 0;

  const [ordinarySkills, ordinaryCollections] = await Promise.all([
    reads.inspectCatalog(home),
    reads.scanCollections(home)
  ]);
  for (const registration of ordinarySkills.registrations) {
    addOwnership(instances, `catalog:skill:${registration.id}`, { kind: 'skill', name: registration.id }, undefined, { kind: 'ordinary' });
  }
  for (const record of ordinaryCollections.records) {
    addOwnership(instances, `catalog:${record.key.kind}:${record.key.id}`, { kind: record.key.kind, name: record.key.id }, undefined, { kind: 'ordinary' });
  }

  for (const profileName of profileNames) {
    const expectation = await reads.captureExpectation(home, profileName);
    const stateSnapshot = await reads.readManagedState(home, profileName);
    if (stateSnapshot !== undefined) {
      if (profileInstanceIds.has(stateSnapshot.state.profileInstanceId)) throw invalid('profile instance identity is referenced by more than one profile');
      profileInstanceIds.add(stateSnapshot.state.profileInstanceId);
    }
    const resourceIdentities: string[] = [];
    const missingResources: ProfileMissingResourceView[] = [];

    for (const entry of expectation.closure.entries) {
      const ordinary = ordinaryMembership(entry);
      if (ordinary === undefined) continue;
      addOwnership(instances, ordinary.stableIdentity, ordinary.key, profileName, { kind: 'ordinary' });
      resourceIdentities.push(ordinary.stableIdentity);
      membershipCount += 1;
    }
    const profileInstanceId = stateSnapshot?.state.profileInstanceId ?? profileInstanceIdFromPhysicalIdentity(expectation.identity);
    const matchedProfileLocalBindings = new Set<string>();
    for (const name of physicalProfileLocalSkillNames(expectation.closure)) {
      const instanceId = profileLocalResourceInstanceId(profileInstanceId, name);
      const stableIdentity = profileLocalResourceIdentity(instanceId);
      if (stateSnapshot !== undefined) {
        const digest = resourceIdentityDigest(stableIdentity);
        const binding = stateSnapshot.state.capturedResourceIds.find((candidate) => candidate.resourceIdentityDigest === digest);
        if (binding?.identityKind !== 'profileLocal' || binding.instanceId !== instanceId) throw invalid(`physical profile-local Skill ${JSON.stringify(name)} has no exact state binding`);
        matchedProfileLocalBindings.add(binding.capturedResourceId);
      }
      addOwnership(instances, stableIdentity, { kind: 'skill', name }, profileName, { kind: 'profileLocal', root: join(home, 'profiles', profileName, 'skills', name) });
      resourceIdentities.push(stableIdentity);
      membershipCount += 1;
    }
    if (stateSnapshot !== undefined && stateSnapshot.state.capturedResourceIds.some((binding) => binding.identityKind === 'profileLocal' && !matchedProfileLocalBindings.has(binding.capturedResourceId))) throw invalid(`profile ${JSON.stringify(profileName)} has a stale profile-local resource binding`);

    if (stateSnapshot !== undefined) {
      if (stateSnapshot.sha256 !== expectation.sidecarSha256) throw changed(profileName);
      for (const imported of stateSnapshot.state.importedResources) {
        const stableIdentity = importedResourceIdentity(imported.instanceId);
        let materialization: ProfileResourceMaterializationView;
        if (imported.source.kind === 'missingRemoteGit') {
          materialization = {
            kind: 'missingRemoteGit',
            diagnosticCode: imported.source.diagnosticCode,
            identity: structuredClone(imported.source.identity)
          };
          missingResources.push({
            stableIdentity,
            capturedResourceId: imported.capturedResourceId,
            key: { ...imported.key },
            diagnosticCode: imported.source.diagnosticCode
          });
        } else {
          const tree = await readArtifactTree(home, imported.source.treeId);
          const expectedRole = roleFor(imported.key.kind);
          if (tree.manifest.role !== expectedRole) throw invalid(`artifact role does not match ${imported.key.kind} resource ${JSON.stringify(imported.key.name)}`);
          const treeRoot = join(tree.path, 'root');
          materialization = imported.source.kind === 'remoteGit'
            ? { kind: 'remoteGit', treeId: tree.treeId, treeRoot, role: tree.manifest.role, identity: structuredClone(imported.source.identity) }
            : imported.source.origin === undefined
              ? { kind: 'artifact', treeId: tree.treeId, treeRoot, role: tree.manifest.role }
              : { kind: 'artifact', treeId: tree.treeId, treeRoot, role: tree.manifest.role, origin: structuredClone(imported.source.origin) };
        }
        addOwnership(instances, stableIdentity, imported.key, profileName, materialization);
        resourceIdentities.push(stableIdentity);
        membershipCount += 1;
      }
    }
    if (membershipCount > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries) throw limit();
    if (new Set(resourceIdentities).size !== resourceIdentities.length) throw invalid(`profile ${JSON.stringify(profileName)} contains duplicate resource identities`);
    resourceIdentities.sort(compare);
    missingResources.sort((left, right) => compareKey(left.key, right.key) || compare(left.stableIdentity, right.stableIdentity));
    const publication = stateSnapshot?.state.publication ?? null;
    profiles.push({
      name: profileName,
      profileInstanceId: stateSnapshot?.state.profileInstanceId ?? null,
      publication: publication === null ? null : structuredClone(publication),
      publicationVersionState: publication === null
        ? 'unpublished'
        : publication.installedCommit === publication.latestSeenCommit ? 'latest-installed' : 'older-installed',
      incomplete: missingResources.length > 0,
      missingResources,
      resourceIdentities
    });
    await reads.assertExpectation(home, profileName, expectation);
  }

  const resources = [...instances.values()].map(finishInstance).sort(compareInstances);
  const namespace = buildNamespace(resources);
  const skills = await buildSkillNamespace(home, resources, ordinarySkills.registrations);
  if (resources.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries
    || namespace.reduce((total, entry) => total + entry.selectors.length, 0) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries
    || skills.reduce((total, entry) => total + entry.selectors.length, 0) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries) throw limit();
  return { profiles, resources, namespace, skills };
}

export function resolveProfileResourceSelector(view: ProfileSystemView, kind: ResourceKind, selector: string): string {
  if (!validSelector(selector)) throw selectorInvalid();
  const matches = view.namespace.filter((entry) => entry.kind === kind && entry.selectors.includes(selector));
  if (matches.length !== 1) throw selectorInvalid();
  return matches[0]!.stableIdentity;
}

interface MutableInstance {
  stableIdentity: string;
  key: CapturedResourceKey;
  owners: Set<string>;
  materialization: ProfileResourceMaterializationView;
}

function addOwnership(
  instances: Map<string, MutableInstance>,
  stableIdentity: string,
  key: CapturedResourceKey,
  profileName: string | undefined,
  materialization: ProfileResourceMaterializationView
): void {
  const current = instances.get(stableIdentity);
  if (current === undefined) {
    instances.set(stableIdentity, { stableIdentity, key: { ...key }, owners: new Set(profileName === undefined ? [] : [profileName]), materialization });
    return;
  }
  if (compareKey(current.key, key) !== 0 || canonicalMaterialization(current.materialization) !== canonicalMaterialization(materialization)) {
    throw invalid(`stable resource identity ${JSON.stringify(stableIdentity)} has conflicting definitions`);
  }
  if (profileName !== undefined) current.owners.add(profileName);
}

function finishInstance(value: MutableInstance): ProfileResourceInstanceView {
  const ownerProfiles = [...value.owners].sort(compare);
  return {
    stableIdentity: value.stableIdentity,
    key: { ...value.key },
    ownerProfiles,
    materialization: structuredClone(value.materialization),
    projected: value.materialization.kind !== 'missingRemoteGit'
  };
}

function buildNamespace(resources: readonly ProfileResourceInstanceView[]): ProfileNamespaceEntry[] {
  const byKey = new Map<string, ProfileResourceInstanceView[]>();
  for (const resource of resources) {
    const key = `${resource.key.kind}\0${resource.key.name}`;
    const group = byKey.get(key) ?? [];
    group.push(resource);
    byKey.set(key, group);
  }
  const entries: ProfileNamespaceEntry[] = [];
  for (const group of byKey.values()) {
    group.sort(compareInstances);
    const aliases = new Set<string>();
    for (const resource of group) {
      const ordinary = resource.materialization.kind === 'ordinary';
      const qualified = resource.ownerProfiles.map((owner) => `${owner}/${resource.key.name}`);
      const selectors = ordinary || group.length === 1 ? [resource.key.name, ...qualified] : qualified;
      for (const selector of selectors) {
        if (aliases.has(selector)) throw invalid(`selector ${JSON.stringify(selector)} is ambiguous within one profile`);
        aliases.add(selector);
      }
      if (!ordinary && group.length > 1 && resource.ownerProfiles.length === 0) throw invalid('colliding non-ordinary resource has no owning profile');
      entries.push({
        kind: resource.key.kind,
        name: resource.key.name,
        stableIdentity: resource.stableIdentity,
        displayName: ordinary || group.length === 1 ? resource.key.name : `${resource.ownerProfiles[0]!}/${resource.key.name}`,
        ownerProfiles: [...resource.ownerProfiles],
        selectors,
        projected: resource.projected
      });
    }
  }
  return entries.sort((left, right) => compare(left.kind, right.kind) || compare(left.name, right.name) || compare(left.stableIdentity, right.stableIdentity));
}

async function buildSkillNamespace(
  home: string,
  resources: readonly ProfileResourceInstanceView[],
  registrations: readonly { id: string; target: string }[]
): Promise<ProfileSkillNamespaceEntry[]> {
  const candidates: Array<Omit<ProfileSkillNamespaceEntry, 'displayName'|'selectors'>> = registrations.map((registration) => ({
    stableIdentity: `catalog:skill:${registration.id}`,
    sourceResourceIdentity: `catalog:skill:${registration.id}`,
    sourceKind: 'skill' as const,
    name: registration.id,
    ownerProfiles: resources.find((resource) => resource.stableIdentity === `catalog:skill:${registration.id}`)?.ownerProfiles ?? [],
    directory: registration.target,
    directlyAttachable: true
  }));
  for (const resource of resources) {
    if(resource.materialization.kind==='profileLocal'){
      candidates.push({stableIdentity:resource.stableIdentity,sourceResourceIdentity:resource.stableIdentity,sourceKind:'skill',name:resource.key.name,ownerProfiles:[...resource.ownerProfiles],directory:resource.materialization.root,directlyAttachable:false});
      continue;
    }
    if (!resource.stableIdentity.startsWith('imported:') || !resource.projected) continue;
    const materialization = resource.materialization;
    if (materialization.kind === 'ordinary' || materialization.kind === 'missingRemoteGit') continue;
    const tree = await readArtifactTree(home, materialization.treeId);
    const directories = tree.manifest.files.flatMap((file) => file.path === 'SKILL.md'
      ? [materialization.treeRoot]
      : file.path.endsWith('/SKILL.md') ? [join(materialization.treeRoot, ...file.path.split('/').slice(0, -1))] : []);
    const seen = new Set<string>();
    for (const [index, directory] of directories.entries()) {
      const name = resource.key.kind==='skill'?resource.key.name:directory.split('/').at(-1)!;
      if (!isSafeSkillId(name) || seen.has(name)) throw invalid(`imported ${resource.key.kind} has an invalid or duplicate child Skill name`);
      seen.add(name);
      if (resource.key.kind === 'skill' && (index !== 0 || directories.length !== 1 || directory !== materialization.treeRoot)) throw invalid('imported direct Skill artifact does not match its resource key');
      candidates.push({
        stableIdentity: resource.key.kind === 'skill' ? resource.stableIdentity : `${resource.stableIdentity}#skill:${name}`,
        sourceResourceIdentity: resource.stableIdentity,
        sourceKind: resource.key.kind,
        name,
        ownerProfiles: [...resource.ownerProfiles],
        directory,
        directlyAttachable: resource.key.kind === 'skill'
      });
    }
  }
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) { const group=groups.get(candidate.name)??[];group.push(candidate);groups.set(candidate.name,group); }
  const result: ProfileSkillNamespaceEntry[]=[];
  for(const group of groups.values()){
    group.sort((left,right)=>compare(left.stableIdentity,right.stableIdentity));
    const aliases=new Set<string>();
    for(const candidate of group){
      const ordinary=candidate.stableIdentity.startsWith('catalog:skill:');
      const qualified=candidate.ownerProfiles.map((owner)=>`${owner}/${candidate.name}`);
      const selectors=ordinary||group.length===1?[candidate.name,...qualified]:qualified;
      for(const selector of selectors){if(aliases.has(selector))throw invalid(`Skill selector ${JSON.stringify(selector)} is ambiguous within one profile`);aliases.add(selector);}
      result.push({...candidate,displayName:ordinary||group.length===1?candidate.name:`${candidate.ownerProfiles[0]!}/${candidate.name}`,selectors});
    }
  }
  return result.sort((left,right)=>compare(left.name,right.name)||compare(left.stableIdentity,right.stableIdentity));
}

function ordinaryMembership(entry: PhysicalProfileClosureEntryV1): { stableIdentity: string; key: CapturedResourceKey } | undefined {
  if (entry.kind !== 'membership-link') return undefined;
  const match = /^catalog:(skill|library|package):([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(entry.targetIdentity);
  if (match === null) throw invalid('ordinary membership identity is invalid');
  return { stableIdentity: entry.targetIdentity, key: { kind: match[1] as ResourceKind, name: match[2]! } };
}

async function scanProfileNames(home: string): Promise<string[]> {
  let root;
  try { root = await openStablePhysicalDirectory(join(home, 'profiles'), home); }
  catch (error) {
    if (errorCode(error) === 'ENOENT' || (error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT')) return [];
    throw error;
  }
  try {
    const names = await enumerateStableDirectory(root, PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries);
    const profiles: string[] = [];
    for (const name of names) {
      if (isSafeProfileId(name)) profiles.push(name);
      else if (!isReservedProfileSiblingName(name)) throw invalid(`profiles namespace contains unsupported entry ${JSON.stringify(name)}`);
      if (profiles.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries) throw limit();
    }
    await assertStablePhysicalDirectory(root);
    return profiles;
  } finally { await root.handle.close().catch(() => undefined); }
}

function roleFor(kind: ResourceKind): 'skill' | 'library' | 'packageArtifacts' {
  return kind === 'skill' ? 'skill' : kind === 'library' ? 'library' : 'packageArtifacts';
}
function canonicalMaterialization(value: ProfileResourceMaterializationView): string { return JSON.stringify(value); }
function compareInstances(left: ProfileResourceInstanceView, right: ProfileResourceInstanceView): number { return compareKey(left.key, right.key) || compare(left.stableIdentity, right.stableIdentity); }
function compareKey(left: CapturedResourceKey, right: CapturedResourceKey): number { return kindIndex(left.kind) - kindIndex(right.kind) || compare(left.name, right.name); }
function kindIndex(kind: ResourceKind): number { return kind === 'skill' ? 0 : kind === 'library' ? 1 : 2; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function validSelector(value: string): boolean { return /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/u.test(value); }
function selectorInvalid(): BazframeError { return new BazframeError('PROFILE_RESOURCE_SELECTOR_INVALID', 'Profile resource selector is ambiguous, stale, or invalid.'); }
function changed(profileName: string): BazframeError { return new BazframeError('PROFILE_VIEW_CHANGED', `Profile ${JSON.stringify(profileName)} changed while building its view.`); }
function limit(): BazframeError { return new BazframeError('PROFILE_VIEW_LIMIT', 'Profile namespace exceeds its bounded entry limit.'); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_VIEW_INVALID', `Invalid managed profile view: ${detail}.`); }
