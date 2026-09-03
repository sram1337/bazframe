import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { decodeUtf8Instructions, MAX_EFFECTIVE_INSTRUCTION_BYTES } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { profileDirectory } from '../profiles/profile-store.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { decodeProfileCollectionReference } from '../profiles/profile-skill-collection-reference.js';
import { readDefaultSkillRegistrationLink } from '../skills/default-skill-catalog.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { parseSkillDeclaredName } from '../skills/skill-metadata.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { decodeManagedProfileStateBytes, publicationSidecarName } from './publication-state.js';
import {
  assertStablePhysicalDirectory,
  compare,
  enumerateStableDirectory,
  identityText,
  openStablePhysicalDirectory,
  readStablePhysicalFile,
  readStablePhysicalLink,
  stableReadChildPath,
  type StableDirectory
} from './profile-filesystem.js';

export type PhysicalProfileClosureEntryV1 =
  | { path: string; kind: 'file'; sha256: string; bytes: number; executable: boolean }
  | { path: string; kind: 'membership-link'; targetIdentity: string }
  | { path: string; kind: 'managed-sidecar'; sha256: string; bytes: number };
export interface PhysicalProfileClosureV1 { schemaVersion: 1; profileName: string; entries: PhysicalProfileClosureEntryV1[] }
export interface PhysicalProfileExpectation { identity: string; sidecarSha256: string | null; profileClosureSha256: string; closure: PhysicalProfileClosureV1 }

const ROOT_ENTRIES = new Set(['AGENTS.md', 'skills', 'libraries', 'packages', publicationSidecarName()]);

export async function capturePhysicalProfileExpectation(
  home: string,
  profileId: string,
  lowerLimits: Partial<CapturedProfileLimitPolicy> = {},
  hooks: { beforeSecondPass?: () => Promise<void> } = {}
): Promise<PhysicalProfileExpectation> {
  assertSafeProfileId(profileId);
  return capturePhysicalProfileAtPath(home, profileDirectory(home, profileId), profileId, lowerLimits, hooks);
}

export async function capturePhysicalCandidateExpectation(
  home: string,
  candidateDirectory: string,
  logicalProfileId: string,
  lowerLimits: Partial<CapturedProfileLimitPolicy> = {},
  hooks: { beforeSecondPass?: () => Promise<void> } = {}
): Promise<PhysicalProfileExpectation> {
  assertSafeProfileId(logicalProfileId);
  const candidatePath = resolve(candidateDirectory);
  if (dirname(candidatePath) !== resolve(home, 'profiles') || !/^\.bazframe-(?:candidate|backup)-[a-f0-9]{32}$/u.test(basename(candidatePath))) {
    throw new BazframeError('PROFILE_PUBLICATION_CANDIDATE_INVALID', 'Physical profile proof requires a reserved candidate or backup directory.');
  }
  return capturePhysicalProfileAtPath(home, candidatePath, logicalProfileId, lowerLimits, hooks);
}

async function capturePhysicalProfileAtPath(
  home: string,
  path: string,
  profileId: string,
  lowerLimits: Partial<CapturedProfileLimitPolicy>,
  hooks: { beforeSecondPass?: () => Promise<void> }
): Promise<PhysicalProfileExpectation> {
  const policy = capturedProfileLimitPolicy(lowerLimits);
  const profile = await openStablePhysicalDirectory(path, home);
  try {
    const first = await captureClosurePass(home, profileId, profile, policy);
    await hooks.beforeSecondPass?.();
    const second = await captureClosurePass(home, profileId, profile, policy);
    if (first.canonical !== second.canonical || first.sidecarSha256 !== second.sidecarSha256) {
      throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_CHANGED', `Profile ${JSON.stringify(profileId)} changed while capturing its closure.`);
    }
    await assertStablePhysicalDirectory(profile);
    const profileClosureSha256 = createHash('sha256').update('bazframe-physical-profile-closure-v1\0').update(second.canonical).digest('hex');
    return { identity: identityText(profile.identity), sidecarSha256: second.sidecarSha256, profileClosureSha256, closure: second.closure };
  } finally { await profile.handle.close().catch(() => undefined); }
}

export function physicalProfileLocalSkillNames(closure: PhysicalProfileClosureV1): string[] {
  const names = new Set<string>();
  for (const entry of closure.entries) {
    if (entry.kind !== 'file') continue;
    const match = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\//u.exec(entry.path);
    if (match !== null) names.add(match[1]!);
  }
  return [...names].sort(compare);
}

export function samePhysicalProfileExpectation(left: PhysicalProfileExpectation, right: PhysicalProfileExpectation): boolean {
  return left.identity === right.identity && left.sidecarSha256 === right.sidecarSha256 && left.profileClosureSha256 === right.profileClosureSha256;
}

export async function assertPhysicalProfileExpectation(home: string, profileId: string, expected: PhysicalProfileExpectation): Promise<void> {
  const current = await capturePhysicalProfileExpectation(home, profileId);
  if (!samePhysicalProfileExpectation(current, expected)) throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_CHANGED', `Profile ${JSON.stringify(profileId)} changed while in use.`);
}

async function captureClosurePass(home: string, profileId: string, profile: StableDirectory, policy: CapturedProfileLimitPolicy): Promise<{ closure: PhysicalProfileClosureV1; canonical: string; sidecarSha256: string | null }> {
  const rootNames = await enumerateStableDirectory(profile, policy.maxEntries);
  if (rootNames.some((name) => !ROOT_ENTRIES.has(name))) throw invalid('profile contains an unknown managed entry');
  if (!rootNames.includes('AGENTS.md')) throw invalid('profile instructions are missing');
  const entries: PhysicalProfileClosureEntryV1[] = [await fileEntry(stableReadChildPath(profile, 'AGENTS.md'), 'AGENTS.md', policy, true)];
  const traversed = { count: rootNames.length };
  for (const kind of ['skills', 'libraries', 'packages'] as const) {
    if (rootNames.includes(kind)) entries.push(...await membershipEntries(home, profileId, stableReadChildPath(profile, kind), kind, policy, traversed));
  }
  let sidecarSha256: string | null = null;
  if (rootNames.includes(publicationSidecarName())) {
    const file = await readStablePhysicalFile(stableReadChildPath(profile, publicationSidecarName()), policy.maxManifestBytes);
    decodeManagedProfileStateBytes(file.bytes, policy);
    sidecarSha256 = hash(file.bytes);
    entries.push({ path: publicationSidecarName(), kind: 'managed-sidecar', sha256: sidecarSha256, bytes: file.bytes.byteLength });
  }
  entries.sort((left, right) => compare(left.path, right.path));
  assertUniquePortablePaths(entries.map((entry) => entry.path));
  if (entries.length > policy.maxEntries) throw invalid('profile closure exceeds its entry limit');
  await assertStablePhysicalDirectory(profile);
  const closure: PhysicalProfileClosureV1 = { schemaVersion: 1, profileName: profileId, entries };
  return { closure, canonical: `${JSON.stringify(closure, null, 2)}\n`, sidecarSha256 };
}

async function fileEntry(path: string, relativePath: string, policy: CapturedProfileLimitPolicy, instructions = false): Promise<PhysicalProfileClosureEntryV1> {
  const file = await readStablePhysicalFile(path, instructions ? Math.min(policy.maxBlobBytes, MAX_EFFECTIVE_INSTRUCTION_BYTES) : policy.maxBlobBytes);
  if (instructions) decodeUtf8Instructions(file.bytes, 'Profile instructions', path);
  return { path: relativePath, kind: 'file', sha256: hash(file.bytes), bytes: file.bytes.byteLength, executable: file.executable };
}

async function membershipEntries(home: string, profileId: string, rootPath: string, namespace: 'skills' | 'libraries' | 'packages', policy: CapturedProfileLimitPolicy, traversed: { count: number }): Promise<PhysicalProfileClosureEntryV1[]> {
  const root = await openStablePhysicalDirectory(rootPath, home);
  try {
    const names = await enumerateStableDirectory(root, policy.maxEntries);
    traversed.count += names.length;
    if (traversed.count > policy.maxEntries) throw invalid('profile closure exceeds its traversal limit');
    const result: PhysicalProfileClosureEntryV1[] = [];
    for (const name of names) {
      if (namespace === 'skills') {
        if (!isSafeSkillId(name)) throw invalid('profile contains an unsafe Skill membership name');
        const path = stableReadChildPath(root, name);
        const metadata = await lstat(path, { bigint: true });
        if (metadata.isSymbolicLink()) {
          const membership = await readStablePhysicalLink(path);
          const registration = await readDefaultSkillRegistrationLink(home, name);
          if (membership.target !== registration.target) throw invalid('Skill membership target does not match the default catalog');
          result.push({ path: `skills/${name}`, kind: 'membership-link', targetIdentity: `catalog:skill:${name}` });
        } else if (metadata.isDirectory()) {
          result.push(...await physicalSkillEntries(root, name, policy, traversed));
        } else {
          throw invalid('profile Skill entry is neither a catalog membership nor a physical Skill directory');
        }
      } else {
        if (!name.endsWith('.json') || !isSafeSkillId(name.slice(0, -5))) throw invalid(`profile contains an unsafe ${namespace} reference name`);
        const id = name.slice(0, -5);
        const kind = namespace === 'libraries' ? 'library' : 'package';
        const file = await readStablePhysicalFile(stableReadChildPath(root, name), policy.maxManifestBytes);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)); }
        catch (error) { throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_INVALID', `Invalid profile ${kind} reference.`, { cause: error }); }
        decodeProfileCollectionReference(value, kind, id);
        result.push({ path: `${namespace}/${name}`, kind: 'membership-link', targetIdentity: `catalog:${kind}:${id}` });
      }
    }
    await assertStablePhysicalDirectory(root);
    return result;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  } finally { await root.handle.close().catch(() => undefined); }
}

async function physicalSkillEntries(parent: StableDirectory, name: string, policy: CapturedProfileLimitPolicy, traversed: { count: number }): Promise<PhysicalProfileClosureEntryV1[]> {
  const root = await openStablePhysicalDirectory(stableReadChildPath(parent, name), parent.trustedRoot);
  try {
    const result: PhysicalProfileClosureEntryV1[] = [];
    await physicalDirectoryEntries(root, `skills/${name}`, 0, policy, traversed, result);
    const definition = result.find((entry) => entry.path === `skills/${name}/SKILL.md`);
    if (definition === undefined || definition.kind !== 'file') throw invalid('physical profile Skill has no regular SKILL.md');
    const file = await readStablePhysicalFile(stableReadChildPath(root, 'SKILL.md'), policy.maxBlobBytes);
    let declared: string;
    try { declared = parseSkillDeclaredName(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes), stableReadChildPath(root, 'SKILL.md')); }
    catch (error) { throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_INVALID', 'Invalid physical profile Skill definition.', { cause: error }); }
    if (declared !== name) throw invalid('physical profile Skill name does not match its directory');
    await assertStablePhysicalDirectory(root);
    return result;
  } finally { await root.handle.close().catch(() => undefined); }
}

async function physicalDirectoryEntries(directory: StableDirectory, prefix: string, depth: number, policy: CapturedProfileLimitPolicy, traversed: { count: number }, result: PhysicalProfileClosureEntryV1[]): Promise<void> {
  if (depth > policy.maxDepth) throw invalid('physical profile Skill exceeds its depth limit');
  const names = await enumerateStableDirectory(directory, policy.maxEntries);
  traversed.count += names.length;
  if (traversed.count > policy.maxEntries) throw invalid('profile closure exceeds its traversal limit');
  for (const name of names) {
    const path = stableReadChildPath(directory, name);
    const relativePath = `${prefix}/${name}`;
    if (Buffer.byteLength(relativePath, 'utf8') > policy.maxPathBytes) throw invalid('physical profile Skill path exceeds its limit');
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink()) throw invalid('physical profile Skill contains a symbolic link');
    if (metadata.isDirectory()) {
      const child = await openStablePhysicalDirectory(path, directory.trustedRoot);
      try { await physicalDirectoryEntries(child, relativePath, depth + 1, policy, traversed, result); }
      finally { await child.handle.close().catch(() => undefined); }
    } else if (metadata.isFile()) {
      result.push(await fileEntry(path, relativePath, policy));
    } else {
      throw invalid('physical profile Skill contains a special file');
    }
  }
  await assertStablePhysicalDirectory(directory);
}

function assertUniquePortablePaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
    if (seen.has(key)) throw invalid('profile entries have a portable path collision');
    seen.add(key);
  }
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_PHYSICAL_CLOSURE_INVALID', `Invalid physical profile closure: ${detail}.`); }
