import { BazframeError } from '../core/errors.js';
import {
  decodePathFreeManagedGitIdentity,
  type PathFreeManagedGitIdentity
} from '../providers/managed-git-record.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import {
  profileArtifactLimitPolicy,
  type ProfileArtifactLimitPolicy
} from './profile-portability-policy.js';

export type { ProfileArtifactLimitPolicy } from './profile-portability-policy.js';

export interface RemoteGitArtifactSource extends PathFreeManagedGitIdentity {
  type: 'remoteGit';
}

export interface LocalMappingArtifactSource {
  type: 'localMapping';
}

export type ProfileArtifactResourceKind = 'skill' | 'library' | 'package';

export type ProfileArtifactRemoteResource =
  | { kind: 'skill'; id: string; source: RemoteGitArtifactSource }
  | { kind: 'library'; id: string; source: RemoteGitArtifactSource }
  | { kind: 'package'; id: string; source: RemoteGitArtifactSource };

export type ProfileArtifactLocalResource =
  | { kind: 'library'; id: string; source: LocalMappingArtifactSource }
  | { kind: 'package'; id: string; source: LocalMappingArtifactSource };

export type ProfileArtifactResource = ProfileArtifactRemoteResource | ProfileArtifactLocalResource;

export interface ProfileArtifactProfile {
  id: string;
  instructions: {
    path: 'profile/AGENTS.md';
    sha256: string;
  };
  skills: string[];
  omittedLocalSkills: string[];
  libraries: string[];
  packages: string[];
}

export interface ProfileArtifact {
  schemaVersion: 1;
  kind: 'bazframe-profile-export';
  profile: ProfileArtifactProfile;
  resources: ProfileArtifactResource[];
}

const TOP_LEVEL_KEYS = ['kind', 'profile', 'resources', 'schemaVersion'] as const;
const PROFILE_KEYS = ['id', 'instructions', 'libraries', 'omittedLocalSkills', 'packages', 'skills'] as const;
const INSTRUCTION_KEYS = ['path', 'sha256'] as const;
const RESOURCE_KEYS = ['id', 'kind', 'source'] as const;
const REMOTE_GIT_SOURCE_KEYS = ['branch', 'fetchUrl', 'remote', 'revision', 'type'] as const;
const LOCAL_SOURCE_KEYS = ['type'] as const;
const RESOURCE_KINDS = ['skill', 'library', 'package'] as const;
const SHA256 = /^[a-f0-9]{64}$/u;

export function decodeProfileArtifactObject(
  value: unknown,
  limitPolicy: ProfileArtifactLimitPolicy
): ProfileArtifact {
  const policy = copyLimitPolicy(limitPolicy);
  const root = exactObject(value, TOP_LEVEL_KEYS, 'artifact');
  if (root.schemaVersion !== 1) throw invalid('unsupported schemaVersion');
  if (root.kind !== 'bazframe-profile-export') throw invalid('kind is invalid');

  const profileValue = exactObject(root.profile, PROFILE_KEYS, 'profile');
  if (typeof profileValue.id !== 'string' || !isSafeProfileId(profileValue.id)) {
    throw invalid('profile id is invalid');
  }
  const instructionValue = exactObject(profileValue.instructions, INSTRUCTION_KEYS, 'instructions');
  if (instructionValue.path !== 'profile/AGENTS.md') throw invalid('instruction path is invalid');
  if (typeof instructionValue.sha256 !== 'string' || !SHA256.test(instructionValue.sha256)) {
    throw invalid('instruction sha256 is invalid');
  }

  const skillsValue = boundedArray(profileValue.skills, 'profile.skills', policy.maxProfileEntries);
  const omittedValue = boundedArray(profileValue.omittedLocalSkills, 'profile.omittedLocalSkills', policy.maxProfileEntries);
  const librariesValue = boundedArray(profileValue.libraries, 'profile.libraries', policy.maxProfileEntries);
  const packagesValue = boundedArray(profileValue.packages, 'profile.packages', policy.maxProfileEntries);
  const profileEntryCount = skillsValue.length + omittedValue.length + librariesValue.length + packagesValue.length;
  if (!Number.isSafeInteger(profileEntryCount) || profileEntryCount > policy.maxProfileEntries) {
    throw invalid(`profile entries exceed the ${policy.maxProfileEntries}-entry limit`);
  }

  const skills = decodeOrderedIds(skillsValue, 'profile.skills');
  const omittedLocalSkills = decodeOrderedIds(omittedValue, 'profile.omittedLocalSkills');
  const libraries = decodeOrderedIds(librariesValue, 'profile.libraries');
  const packages = decodeOrderedIds(packagesValue, 'profile.packages');
  const includedSkills = new Set(skills);
  if (omittedLocalSkills.some((id) => includedSkills.has(id))) {
    throw invalid('profile.omittedLocalSkills must be disjoint from profile.skills');
  }

  const resourcesValue = boundedArray(root.resources, 'resources', policy.maxResources);
  const resources: ProfileArtifactResource[] = [];
  let previousResourceKey: string | undefined;
  const resourceKeys = new Set<string>();
  for (const rawResource of resourcesValue) {
    const candidate = exactObject(rawResource, RESOURCE_KEYS, 'resource');
    if (typeof candidate.kind !== 'string' || !isResourceKind(candidate.kind)) {
      throw invalid('resource kind is invalid');
    }
    if (typeof candidate.id !== 'string' || !isSafeSkillId(candidate.id)) {
      throw invalid('resource id is invalid');
    }
    const resourceKey = orderedResourceKey(candidate.kind, candidate.id);
    if (previousResourceKey !== undefined && compare(previousResourceKey, resourceKey) >= 0) {
      throw invalid('resources must be unique and ordered by kind and id');
    }
    previousResourceKey = resourceKey;
    resourceKeys.add(`${candidate.kind}:${candidate.id}`);
    const source = decodeArtifactSource(candidate.source, candidate.id);
    if (candidate.kind === 'skill') {
      if (source.type === 'localMapping') {
        throw invalid('local direct-Skill resources are not portable; use profile.omittedLocalSkills');
      }
      resources.push({ kind: 'skill', id: candidate.id, source });
    } else if (candidate.kind === 'library') {
      resources.push(source.type === 'remoteGit'
        ? { kind: 'library', id: candidate.id, source }
        : { kind: 'library', id: candidate.id, source });
    } else {
      resources.push(source.type === 'remoteGit'
        ? { kind: 'package', id: candidate.id, source }
        : { kind: 'package', id: candidate.id, source });
    }
  }

  for (const omittedId of omittedLocalSkills) {
    if (resourceKeys.has(`skill:${omittedId}`)) {
      throw invalid('omitted local Skills must not have matching resources');
    }
  }
  assertExactClosure(skills, libraries, packages, resourceKeys, resources.length);

  const artifact: ProfileArtifact = {
    schemaVersion: 1,
    kind: 'bazframe-profile-export',
    profile: {
      id: profileValue.id,
      instructions: {
        path: 'profile/AGENTS.md',
        sha256: instructionValue.sha256
      },
      skills,
      omittedLocalSkills,
      libraries,
      packages
    },
    resources
  };
  assertManifestBound(artifact, policy.maxManifestBytes);
  return artifact;
}

export function decodeProfileArtifactBytes(
  bytes: Uint8Array,
  limitPolicy: ProfileArtifactLimitPolicy
): ProfileArtifact {
  const policy = copyLimitPolicy(limitPolicy);
  if (bytes.byteLength > policy.maxManifestBytes) {
    throw invalid(`manifest exceeds the ${policy.maxManifestBytes}-byte limit`);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BazframeError(
      'PROFILE_ARTIFACT_INVALID',
      'Invalid profile artifact: manifest is not valid UTF-8.',
      { cause: error }
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new BazframeError(
      'PROFILE_ARTIFACT_INVALID',
      'Invalid profile artifact: manifest is not valid JSON.',
      { cause: error }
    );
  }

  const artifact = decodeProfileArtifactObject(value, policy);
  const canonicalBytes = Buffer.from(canonicalEncoding(artifact), 'utf8');
  if (!canonicalBytes.equals(Buffer.from(bytes))) {
    throw invalid('manifest bytes are not canonical');
  }
  return artifact;
}

export function encodeProfileArtifact(
  artifact: ProfileArtifact,
  limitPolicy: ProfileArtifactLimitPolicy
): string {
  const decoded = decodeProfileArtifactObject(artifact, limitPolicy);
  return canonicalEncoding(decoded);
}

export function assertStage1ProfileArtifactCapabilities(artifact: ProfileArtifact): void {
  if (artifact.profile.packages.length > 0 || artifact.resources.some((resource) => resource.kind === 'package')) {
    throw new BazframeError(
      'PROFILE_ARTIFACT_STAGE1_UNSUPPORTED',
      'Stage 1 profile portability does not support packages.'
    );
  }
  if (artifact.resources.some((resource) => resource.source.type === 'localMapping')) {
    throw new BazframeError(
      'PROFILE_ARTIFACT_STAGE1_UNSUPPORTED',
      'Stage 1 profile portability does not support local mappings.'
    );
  }
}

export function assertStage2ProfileArtifactCapabilities(artifact: ProfileArtifact): void {
  if (artifact.profile.packages.length > 0 || artifact.resources.some((resource) => resource.kind === 'package')) {
    throw new BazframeError(
      'PROFILE_ARTIFACT_STAGE2_UNSUPPORTED',
      'Stage 2 profile portability does not support packages.'
    );
  }
  if (artifact.resources.some((resource) => resource.source.type === 'localMapping' && resource.kind !== 'library')) {
    throw new BazframeError(
      'PROFILE_ARTIFACT_STAGE2_UNSUPPORTED',
      'Stage 2 profile portability supports local mappings only for libraries.'
    );
  }
}

function decodeArtifactSource(value: unknown, resourceId: string): RemoteGitArtifactSource | LocalMappingArtifactSource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('resource source must be a JSON object');
  }
  const source = value as Record<string, unknown>;
  if (source.type === 'remoteGit') {
    exactObject(source, REMOTE_GIT_SOURCE_KEYS, 'remote Git source');
    try {
      const identity = decodePathFreeManagedGitIdentity({
        remote: source.remote,
        fetchUrl: source.fetchUrl,
        branch: source.branch,
        revision: source.revision
      }, resourceId);
      return { type: 'remoteGit', ...identity };
    } catch (error) {
      throw new BazframeError(
        'PROFILE_ARTIFACT_INVALID',
        'Invalid profile artifact: remote Git source identity is invalid.',
        { cause: error }
      );
    }
  }
  if (source.type === 'localMapping') {
    exactObject(source, LOCAL_SOURCE_KEYS, 'local source');
    return { type: 'localMapping' };
  }
  throw invalid('resource source type is invalid');
}

function assertExactClosure(
  skills: readonly string[],
  libraries: readonly string[],
  packages: readonly string[],
  resourceKeys: ReadonlySet<string>,
  resourceCount: number
): void {
  const expectedCount = skills.length + libraries.length + packages.length;
  if (resourceCount !== expectedCount) throw invalid('resources must exactly match the included profile closure');
  for (const [kind, ids] of [
    ['skill', skills],
    ['library', libraries],
    ['package', packages]
  ] as const) {
    for (const id of ids) {
      if (!resourceKeys.has(`${kind}:${id}`)) {
        throw invalid(`profile ${kind} ${id} has no matching resource`);
      }
    }
  }
}

function decodeOrderedIds(values: readonly unknown[], label: string): string[] {
  const ids: string[] = [];
  let previous: string | undefined;
  for (const value of values) {
    if (typeof value !== 'string' || !isSafeSkillId(value)) throw invalid(`${label} contains an invalid ID`);
    if (previous !== undefined && compare(previous, value) >= 0) {
      throw invalid(`${label} must contain unique IDs in lexical order`);
    }
    ids.push(value);
    previous = value;
  }
  return ids;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object`);
  }
  const candidate = value as Record<string, unknown>;
  const actual = Object.keys(candidate).sort(compare);
  if (actual.length !== keys.length || !actual.every((key, index) => key === keys[index])) {
    throw invalid(`${label} must contain exactly the schema-v1 fields`);
  }
  return candidate;
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  if (value.length > maximum) throw invalid(`${label} exceeds the ${maximum}-entry limit`);
  return value;
}

function copyLimitPolicy(policy: ProfileArtifactLimitPolicy): ProfileArtifactLimitPolicy {
  if (policy === null || typeof policy !== 'object') throw invalid('limit policy is invalid');
  try { return profileArtifactLimitPolicy(policy); }
  catch (error) { throw invalidLimitPolicy(error); }
}

function assertManifestBound(artifact: ProfileArtifact, maximum: number): void {
  const byteCount = Buffer.byteLength(canonicalEncoding(artifact), 'utf8');
  if (byteCount > maximum) throw invalid(`canonical manifest exceeds the ${maximum}-byte limit`);
}

function canonicalEncoding(artifact: ProfileArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function isResourceKind(value: string): value is ProfileArtifactResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

function orderedResourceKey(kind: ProfileArtifactResourceKind, id: string): string {
  return `${String(RESOURCE_KINDS.indexOf(kind))}:${id}`;
}

function invalid(detail: string): BazframeError {
  return new BazframeError('PROFILE_ARTIFACT_INVALID', `Invalid profile artifact: ${detail}.`);
}
function invalidLimitPolicy(error: unknown): BazframeError {
  const detail = error instanceof Error ? error.message : String(error);
  return new BazframeError('PROFILE_ARTIFACT_INVALID', `Invalid profile artifact limit policy: ${detail}`, { cause: error });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
