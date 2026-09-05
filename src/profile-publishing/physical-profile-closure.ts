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
export interface PhysicalProfileExpectation { identity: string; sidecarSha256: string | null; profileClosureSha256: string; closure: PhysicalProfileClosureV1; observationIdentity?: string }

export interface PhysicalProfileDirectory {
  identity: string;
  trustedRoot: string;
  childPath(name: string): string;
  enumerate(maxEntries: number): Promise<string[]>;
  assertStable(): Promise<void>;
  close(): Promise<void>;
}
export interface PhysicalProfileReadServices {
  openDirectory(path: string, trustedRoot: string): Promise<PhysicalProfileDirectory>;
  readFile(path: string, maxBytes: number): Promise<{ bytes: Buffer; executable: boolean }>;
  inspectKind(path: string): Promise<'link' | 'directory' | 'file' | 'other'>;
  membershipIdentity(home: string, path: string, name: string): Promise<string>;
  observationIdentity?(): string;
}
const defaultPhysicalReads: PhysicalProfileReadServices = {
  async openDirectory(path, trustedRoot) {
    const directory: StableDirectory = await openStablePhysicalDirectory(path, trustedRoot);
    return { identity: identityText(directory.identity), trustedRoot,
      childPath: (name) => stableReadChildPath(directory, name),
      enumerate: (max) => enumerateStableDirectory(directory, max),
      assertStable: () => assertStablePhysicalDirectory(directory),
      close: () => directory.handle.close() };
  },
  readFile: readStablePhysicalFile,
  async inspectKind(path) {
    const metadata = await lstat(path, { bigint: true });
    return metadata.isSymbolicLink() ? 'link' : metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other';
  },
  async membershipIdentity(home, path, name) {
    const membership = await readStablePhysicalLink(path);
    const registration = await readDefaultSkillRegistrationLink(home, name);
    if (membership.target !== registration.target) throw invalid('Skill membership target does not match the default catalog');
    return `catalog:skill:${name}`;
  }
};

const ROOT_ENTRIES = new Set(['AGENTS.md', 'skills', 'libraries', 'packages', publicationSidecarName()]);

export async function capturePhysicalProfileExpectation(
  home: string,
  profileId: string,
  lowerLimits: Partial<CapturedProfileLimitPolicy> = {},
  hooks: { beforeSecondPass?: () => Promise<void> } = {},
  reads: PhysicalProfileReadServices = defaultPhysicalReads
): Promise<PhysicalProfileExpectation> {
  assertSafeProfileId(profileId);
  return capturePhysicalProfileAtPath(home, profileDirectory(home, profileId), profileId, lowerLimits, hooks, reads);
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
  return capturePhysicalProfileAtPath(home, candidatePath, logicalProfileId, lowerLimits, hooks, defaultPhysicalReads);
}

async function capturePhysicalProfileAtPath(
  home: string,
  path: string,
  profileId: string,
  lowerLimits: Partial<CapturedProfileLimitPolicy>,
  hooks: { beforeSecondPass?: () => Promise<void> },
  reads: PhysicalProfileReadServices
): Promise<PhysicalProfileExpectation> {
  const policy = capturedProfileLimitPolicy(lowerLimits);
  const profile = await reads.openDirectory(path, home);
  try {
    const first = await captureClosurePass(home, profileId, profile, policy, reads);
    await hooks.beforeSecondPass?.();
    const second = await captureClosurePass(home, profileId, profile, policy, reads);
    if (first.canonical !== second.canonical || first.sidecarSha256 !== second.sidecarSha256) {
      throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_CHANGED', `Profile ${JSON.stringify(profileId)} changed while capturing its closure.`);
    }
    await profile.assertStable();
    const profileClosureSha256 = createHash('sha256').update('bazframe-physical-profile-closure-v1\0').update(second.canonical).digest('hex');
    return { identity: profile.identity, sidecarSha256: second.sidecarSha256, profileClosureSha256, closure: second.closure, ...(reads.observationIdentity === undefined ? {} : { observationIdentity: reads.observationIdentity() }) };
  } finally { await profile.close().catch(() => undefined); }
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
  return left.identity === right.identity && left.sidecarSha256 === right.sidecarSha256 && left.profileClosureSha256 === right.profileClosureSha256 && left.observationIdentity === right.observationIdentity;
}

export async function assertPhysicalProfileExpectation(home: string, profileId: string, expected: PhysicalProfileExpectation): Promise<void> {
  const current = await capturePhysicalProfileExpectation(home, profileId);
  if (!samePhysicalProfileExpectation(current, expected)) throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_CHANGED', `Profile ${JSON.stringify(profileId)} changed while in use.`);
}

async function captureClosurePass(home: string, profileId: string, profile: PhysicalProfileDirectory, policy: CapturedProfileLimitPolicy, reads: PhysicalProfileReadServices): Promise<{ closure: PhysicalProfileClosureV1; canonical: string; sidecarSha256: string | null }> {
  const rootNames = await profile.enumerate(policy.maxEntries);
  if (rootNames.some((name) => !ROOT_ENTRIES.has(name))) throw invalid('profile contains an unknown managed entry');
  if (!rootNames.includes('AGENTS.md')) throw invalid('profile instructions are missing');
  const entries: PhysicalProfileClosureEntryV1[] = [await fileEntry(profile.childPath('AGENTS.md'), 'AGENTS.md', policy, reads, true)];
  const traversed = { count: rootNames.length };
  for (const kind of ['skills', 'libraries', 'packages'] as const) {
    if (rootNames.includes(kind)) entries.push(...await membershipEntries(home, profileId, profile.childPath(kind), kind, policy, traversed, reads));
  }
  let sidecarSha256: string | null = null;
  if (rootNames.includes(publicationSidecarName())) {
    const file = await reads.readFile(profile.childPath(publicationSidecarName()), policy.maxManifestBytes);
    decodeManagedProfileStateBytes(file.bytes, policy);
    sidecarSha256 = hash(file.bytes);
    entries.push({ path: publicationSidecarName(), kind: 'managed-sidecar', sha256: sidecarSha256, bytes: file.bytes.byteLength });
  }
  entries.sort((left, right) => compare(left.path, right.path));
  assertUniquePortablePaths(entries.map((entry) => entry.path));
  if (entries.length > policy.maxEntries) throw invalid('profile closure exceeds its entry limit');
  await profile.assertStable();
  const closure: PhysicalProfileClosureV1 = { schemaVersion: 1, profileName: profileId, entries };
  return { closure, canonical: `${JSON.stringify(closure, null, 2)}\n`, sidecarSha256 };
}

async function fileEntry(path: string, relativePath: string, policy: CapturedProfileLimitPolicy, reads: PhysicalProfileReadServices, instructions = false): Promise<PhysicalProfileClosureEntryV1> {
  const file = await reads.readFile(path, instructions ? Math.min(policy.maxBlobBytes, MAX_EFFECTIVE_INSTRUCTION_BYTES) : policy.maxBlobBytes);
  if (instructions) decodeUtf8Instructions(file.bytes, 'Profile instructions', path);
  return { path: relativePath, kind: 'file', sha256: hash(file.bytes), bytes: file.bytes.byteLength, executable: file.executable };
}

async function membershipEntries(home: string, profileId: string, rootPath: string, namespace: 'skills' | 'libraries' | 'packages', policy: CapturedProfileLimitPolicy, traversed: { count: number }, reads: PhysicalProfileReadServices): Promise<PhysicalProfileClosureEntryV1[]> {
  const root = await reads.openDirectory(rootPath, home);
  try {
    const names = await root.enumerate(policy.maxEntries);
    traversed.count += names.length;
    if (traversed.count > policy.maxEntries) throw invalid('profile closure exceeds its traversal limit');
    const result: PhysicalProfileClosureEntryV1[] = [];
    for (const name of names) {
      if (namespace === 'skills') {
        if (!isSafeSkillId(name)) throw invalid('profile contains an unsafe Skill membership name');
        const path = root.childPath(name);
        const kind = await reads.inspectKind(path);
        if (kind === 'link') {
          const targetIdentity = await reads.membershipIdentity(home, path, name);
          result.push({ path: `skills/${name}`, kind: 'membership-link', targetIdentity });
        } else if (kind === 'directory') {
          result.push(...await physicalSkillEntries(root, name, policy, traversed, reads));
        } else {
          throw invalid('profile Skill entry is neither a catalog membership nor a physical Skill directory');
        }
      } else {
        if (!name.endsWith('.json') || !isSafeSkillId(name.slice(0, -5))) throw invalid(`profile contains an unsafe ${namespace} reference name`);
        const id = name.slice(0, -5);
        const kind = namespace === 'libraries' ? 'library' : 'package';
        const file = await reads.readFile(root.childPath(name), policy.maxManifestBytes);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)); }
        catch (error) { throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_INVALID', `Invalid profile ${kind} reference.`, { cause: error }); }
        decodeProfileCollectionReference(value, kind, id);
        result.push({ path: `${namespace}/${name}`, kind: 'membership-link', targetIdentity: `catalog:${kind}:${id}` });
      }
    }
    await root.assertStable();
    return result;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  } finally { await root.close().catch(() => undefined); }
}

async function physicalSkillEntries(parent: PhysicalProfileDirectory, name: string, policy: CapturedProfileLimitPolicy, traversed: { count: number }, reads: PhysicalProfileReadServices): Promise<PhysicalProfileClosureEntryV1[]> {
  const root = await reads.openDirectory(parent.childPath(name), parent.trustedRoot);
  try {
    const result: PhysicalProfileClosureEntryV1[] = [];
    await physicalDirectoryEntries(root, `skills/${name}`, 0, policy, traversed, result, reads);
    const definition = result.find((entry) => entry.path === `skills/${name}/SKILL.md`);
    if (definition === undefined || definition.kind !== 'file') throw invalid('physical profile Skill has no regular SKILL.md');
    const file = await reads.readFile(root.childPath('SKILL.md'), policy.maxBlobBytes);
    let declared: string;
    try { declared = parseSkillDeclaredName(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes), root.childPath('SKILL.md')); }
    catch (error) { throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_INVALID', 'Invalid physical profile Skill definition.', { cause: error }); }
    if (declared !== name) throw invalid('physical profile Skill name does not match its directory');
    await root.assertStable();
    return result;
  } finally { await root.close().catch(() => undefined); }
}

async function physicalDirectoryEntries(directory: PhysicalProfileDirectory, prefix: string, depth: number, policy: CapturedProfileLimitPolicy, traversed: { count: number }, result: PhysicalProfileClosureEntryV1[], reads: PhysicalProfileReadServices): Promise<void> {
  if (depth > policy.maxDepth) throw invalid('physical profile Skill exceeds its depth limit');
  const names = await directory.enumerate(policy.maxEntries);
  traversed.count += names.length;
  if (traversed.count > policy.maxEntries) throw invalid('profile closure exceeds its traversal limit');
  for (const name of names) {
    const path = directory.childPath(name);
    const relativePath = `${prefix}/${name}`;
    if (Buffer.byteLength(relativePath, 'utf8') > policy.maxPathBytes) throw invalid('physical profile Skill path exceeds its limit');
    const kind = await reads.inspectKind(path);
    if (kind === 'link') throw invalid('physical profile Skill contains a symbolic link');
    if (kind === 'directory') {
      const child = await reads.openDirectory(path, directory.trustedRoot);
      try { await physicalDirectoryEntries(child, relativePath, depth + 1, policy, traversed, result, reads); }
      finally { await child.close().catch(() => undefined); }
    } else if (kind === 'file') {
      result.push(await fileEntry(path, relativePath, policy, reads));
    } else {
      throw invalid('physical profile Skill contains a special file');
    }
  }
  await directory.assertStable();
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
