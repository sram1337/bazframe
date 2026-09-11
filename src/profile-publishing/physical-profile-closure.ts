import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
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
  isPosixPhysicalIdentityText,
  isWindowsPhysicalIdentityText,
  type WindowsPhysicalIdentityText,
  openStablePhysicalDirectory,
  readStablePhysicalFile,
  readStablePhysicalLink,
  stableReadChildPath,
  type StableDirectory
} from './profile-filesystem.js';

export type PhysicalProfileClosureEntryV1 =
  | { path: string; kind: 'file'; sha256: string; bytes: number; executable: boolean }
  | { path: string; kind: 'membership-link'; targetIdentity: string; sha256?: string; bytes?: number }
  | { path: string; kind: 'managed-sidecar'; sha256: string; bytes: number }
  // Capture-local read/use evidence; strict transport/lifecycle captures never produce these entries.
  | { path: string; kind: 'direct-skill-reference'; sha256: string; bytes: number }
  | { path: 'source-units'; kind: 'inert-directory'; identity: string };
export interface PhysicalProfileClosureV1 { schemaVersion: 1; profileName: string; entries: PhysicalProfileClosureEntryV1[] }
export interface PhysicalProfileExpectation { identity: string; sidecarSha256: string | null; profileClosureSha256: string; closure: PhysicalProfileClosureV1 }

export interface PhysicalProfileProof { identity: string; sidecarSha256: string | null; profileClosureSha256: string }
export interface WindowsPhysicalProfileProof extends PhysicalProfileProof { identity: WindowsPhysicalIdentityText }
export interface WindowsPhysicalProfileExpectation extends WindowsPhysicalProfileProof { closure: PhysicalProfileClosureV1 }
export type PosixPhysicalProfileProof = PhysicalProfileProof;

function validProofHashes(value: PhysicalProfileProof): boolean {
  const sha = (text: unknown) => typeof text === 'string' && /^[a-f0-9]{64}$/u.test(text);
  return (value.sidecarSha256 === null || sha(value.sidecarSha256)) && sha(value.profileClosureSha256);
}
/** Explicit POSIX V1 projection. */
export function serializePosixPhysicalProfileProof(value: PhysicalProfileProof): PosixPhysicalProfileProof {
  if (!isPosixPhysicalIdentityText(value.identity) || !validProofHashes(value)) throw invalid('POSIX physical proof is invalid');
  return { identity: value.identity, sidecarSha256: value.sidecarSha256, profileClosureSha256: value.profileClosureSha256 };
}
/** The reduced backup shape belongs exclusively to historical POSIX V1 storage. */
export function validatePosixBackupProof(value: Pick<PhysicalProfileProof, 'identity' | 'profileClosureSha256'>): void {
  if (!isPosixPhysicalIdentityText(value.identity) || typeof value.profileClosureSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.profileClosureSha256)) throw invalid('POSIX backup proof is invalid');
}
export function serializePosixBackupProof(value: PhysicalProfileProof): Pick<PosixPhysicalProfileProof, 'identity' | 'profileClosureSha256'> {
  const proof = serializePosixPhysicalProfileProof(value);
  return { identity: proof.identity, profileClosureSha256: proof.profileClosureSha256 };
}
export function serializeWindowsPhysicalProfileProof(value: PhysicalProfileProof): WindowsPhysicalProfileProof {
  if (!isWindowsPhysicalIdentityText(value.identity) || !validProofHashes(value)) throw invalid('Windows physical proof is invalid');
  return { identity: value.identity, sidecarSha256: value.sidecarSha256, profileClosureSha256: value.profileClosureSha256 };
}
/** Compare physical root identity and logical content, independently of its admitted path. */
export function samePhysicalProfileProof(left: PhysicalProfileProof, right: PhysicalProfileProof): boolean {
  try {
    const serialize = isWindowsPhysicalIdentityText(left.identity) ? serializeWindowsPhysicalProfileProof : serializePosixPhysicalProfileProof;
    return JSON.stringify(serialize(left)) === JSON.stringify(serialize(right));
  } catch { return false; }
}

export interface PhysicalProfileDirectory {
  identity: string;
  trustedRoot: string;
  childPath(name: string): string;
  enumerate(maxEntries: number): Promise<string[]>;
  assertStable(): Promise<void>;
  close(): Promise<void>;
}
export interface PhysicalProfileReadServices {
  collectionReferenceBytes?: boolean;
  inertSourceUnits?: boolean;
  ordinarySkillReference?(home: string, path: string, name: string, maxBytes: number): Promise<{ catalogIdentity?: string; sha256: string; bytes: number }>;
  retainedRootFile?(path: string, name: string): Promise<boolean>;
  retainedCollectionFile?(path: string, name: string): Promise<boolean>;
  rootMetadata?: { name: string; validate(bytes: Buffer, policy: CapturedProfileLimitPolicy): number; validateClosure?(): void };
  openDirectory(path: string, trustedRoot: string): Promise<PhysicalProfileDirectory>;
  readFile(path: string, maxBytes: number): Promise<{ bytes: Buffer; executable: boolean }>;
  inspectKind(path: string): Promise<'link' | 'directory' | 'file' | 'other'>;
  membershipIdentity(home: string, path: string, name: string): Promise<string>;
}
export const defaultPhysicalReads: PhysicalProfileReadServices = {
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

/** Ordinary view/use only. Strict export, candidates, lifecycle and recovery keep defaultPhysicalReads. */
export const ordinaryPhysicalReads: PhysicalProfileReadServices = {
  ...defaultPhysicalReads,
  inertSourceUnits: true,
  async ordinarySkillReference(home, path, name, maxBytes) {
    const link = await readStablePhysicalLink(path);
    if (!isAbsolute(link.target)) throw invalid('direct Skill reference target must be absolute');
    // Reuse the POSIX external-root boundary: no-follow target leaf, not new host-root ancestry policy.
    const target = await openStablePhysicalDirectory(link.target, link.target);
    try {
      const definitionPath = stableReadChildPath(target, 'SKILL.md');
      const definition = await readStablePhysicalFile(definitionPath, Math.min(maxBytes, 1024 * 1024));
      if (parseSkillDeclaredName(decodeUtf8Instructions(definition.bytes, 'Skill definition', definitionPath, Math.min(maxBytes, 1024 * 1024)), definitionPath) !== name) throw invalid('direct Skill reference declares another name');
      let catalogIdentity: string | undefined;
      try {
        const registration = await readDefaultSkillRegistrationLink(home, name);
        if (registration.target === link.target) catalogIdentity = `catalog:skill:${name}`;
      } catch (error) { if (errorCode(error) !== 'DEFAULT_SKILL_NOT_FOUND') throw error; }
      const after = await readStablePhysicalLink(path);
      if (after.target !== link.target || identityText(after.identity) !== identityText(link.identity)) throw invalid('direct Skill reference changed');
      await assertStablePhysicalDirectory(target);
      const sha256 = hash(Buffer.from(JSON.stringify({ link: identityText(link.identity), target: link.target, targetIdentity: identityText(target.identity), definition: hash(definition.bytes) })));
      return { ...(catalogIdentity === undefined ? {} : { catalogIdentity }), sha256, bytes: definition.bytes.length };
    } finally { await target.handle.close(); }
  }
};

export function captureOrdinaryProfileExpectation(home: string, name: string, limits: Partial<CapturedProfileLimitPolicy> = {}, hooks: { beforeSecondPass?: () => Promise<void> } = {}, reads: PhysicalProfileReadServices = ordinaryPhysicalReads): Promise<PhysicalProfileExpectation> {
  return capturePhysicalProfileExpectation(home, name, limits, hooks, reads);
}
export async function assertOrdinaryProfileExpectation(home: string, name: string, expected: PhysicalProfileExpectation): Promise<void> {
  if (!samePhysicalProfileExpectation(await captureOrdinaryProfileExpectation(home, name), expected)) throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_CHANGED', `Profile ${JSON.stringify(name)} changed while in use.`);
}

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

export async function capturePhysicalProfileAtPath(
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
    return { identity: profile.identity, sidecarSha256: second.sidecarSha256, profileClosureSha256, closure: second.closure };
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
  return samePhysicalProfileProof(left, right);
}

export async function assertPhysicalProfileExpectation(home: string, profileId: string, expected: PhysicalProfileExpectation): Promise<void> {
  const current = await capturePhysicalProfileExpectation(home, profileId);
  if (!samePhysicalProfileExpectation(current, expected)) throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_CHANGED', `Profile ${JSON.stringify(profileId)} changed while in use.`);
}

async function captureClosurePass(home: string, profileId: string, profile: PhysicalProfileDirectory, policy: CapturedProfileLimitPolicy, sourceReads: PhysicalProfileReadServices): Promise<{ closure: PhysicalProfileClosureV1; canonical: string; sidecarSha256: string | null }> {
  const countedFiles = new Set<string>(); let aggregateBytes = 0;
  const reads: PhysicalProfileReadServices = { ...sourceReads, async readFile(path, maximum) {
    const file = await sourceReads.readFile(path, maximum);
    if (!countedFiles.has(path)) { countedFiles.add(path); aggregateBytes += file.bytes.length; }
    if (file.bytes.length > maximum || aggregateBytes > policy.maxAggregateBytes) throw invalid('profile closure exceeds its byte limit');
    return file;
  } };
  const rootNames = await profile.enumerate(policy.maxEntries);
  for (const name of rootNames) {
    if (!ROOT_ENTRIES.has(name) && name !== reads.rootMetadata?.name && !(reads.inertSourceUnits && name === 'source-units') && !await reads.retainedRootFile?.(profile.childPath(name), name)) throw invalid(`profile contains an unknown managed entry ${JSON.stringify(name)}`);
  }
  if (!rootNames.includes('AGENTS.md')) throw invalid('profile instructions are missing');
  const entries: PhysicalProfileClosureEntryV1[] = [await fileEntry(profile.childPath('AGENTS.md'), 'AGENTS.md', policy, reads, true)];
  if (reads.inertSourceUnits && rootNames.includes('source-units')) {
    const inert = await reads.openDirectory(profile.childPath('source-units'), home);
    try {
      entries.push({ path: 'source-units', kind: 'inert-directory', identity: inert.identity });
      await inert.assertStable();
    } finally { await inert.close(); }
  }
  const traversed = { count: rootNames.length };
  if (reads.rootMetadata !== undefined && rootNames.includes(reads.rootMetadata.name)) {
    const file = await reads.readFile(profile.childPath(reads.rootMetadata.name), policy.maxManifestBytes);
    traversed.count += reads.rootMetadata.validate(file.bytes, policy);
    entries.push({ path: reads.rootMetadata.name, kind: 'file', sha256: hash(file.bytes), bytes: file.bytes.length, executable: false });
  }
  if (traversed.count > policy.maxEntries) throw invalid('profile closure exceeds its traversal limit');
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
  reads.rootMetadata?.validateClosure?.();
  if (entries.reduce((total, entry) => total + ('bytes' in entry ? entry.bytes ?? 0 : 0), 0) > policy.maxAggregateBytes) throw invalid('profile closure exceeds its aggregate byte limit');
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
          if (reads.ordinarySkillReference !== undefined) {
            const reference = await reads.ordinarySkillReference(home, path, name, policy.maxBlobBytes);
            result.push(reference.catalogIdentity === undefined
              ? { path: `skills/${name}`, kind: 'direct-skill-reference', sha256: reference.sha256, bytes: reference.bytes }
              : { path: `skills/${name}`, kind: 'membership-link', targetIdentity: reference.catalogIdentity, sha256: reference.sha256, bytes: reference.bytes });
          } else {
            const targetIdentity = await reads.membershipIdentity(home, path, name);
            result.push({ path: `skills/${name}`, kind: 'membership-link', targetIdentity });
          }
        } else if (kind === 'directory') {
          result.push(...await physicalSkillEntries(root, name, policy, traversed, reads));
        } else {
          throw invalid('profile Skill entry is neither a catalog membership nor a physical Skill directory');
        }
      } else {
        if (await reads.retainedCollectionFile?.(root.childPath(name), name)) continue;
        if (!name.endsWith('.json') || !isSafeSkillId(name.slice(0, -5))) throw invalid(`profile contains an unsafe ${namespace} reference name`);
        const id = name.slice(0, -5);
        const kind = namespace === 'libraries' ? 'library' : 'package';
        const file = await reads.readFile(root.childPath(name), policy.maxManifestBytes);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)); }
        catch (error) { throw new BazframeError('PROFILE_PHYSICAL_CLOSURE_INVALID', `Invalid profile ${kind} reference.`, { cause: error }); }
        decodeProfileCollectionReference(value, kind, id);
        result.push({ path: `${namespace}/${name}`, kind: 'membership-link', targetIdentity: `catalog:${kind}:${id}`, ...(reads.collectionReferenceBytes ? { sha256: hash(file.bytes), bytes: file.bytes.length } : {}) });
      }
    }
    await root.assertStable();
    return result;
  } catch (error) {
    // Ordinary read/use requires complete member evidence, including missing targets.
    if (reads.ordinarySkillReference === undefined && errorCode(error) === 'ENOENT') return [];
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
