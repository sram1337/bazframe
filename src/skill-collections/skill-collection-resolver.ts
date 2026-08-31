import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  readProfileCollectionReference,
  scanProfileCollectionReferences
} from '../profiles/profile-skill-collection-reference.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { SKILL_DEFINITION } from '../skills/skill-metadata.js';
import {
  collectionKey,
  idForRecord,
  kindForRecord,
  readCollection,
  scanGlobalSkillCollections,
  skillsRootForRecord,
  type SkillCollectionKind,
  type SkillCollectionRecord
} from './skill-collection-store.js';
import { resolvePhysicalRelativeDirectory, verifySkillSnapshot } from './skill-snapshot.js';

export const SKILL_COLLECTION_LIMITS = Object.freeze({ depth: 8, entries: 256, skills: 64 });
export const UNKNOWN_COLLECTION_ID = '<unknown>';

export interface FlatSkillIdentity { name: string; definitionPath: string; }
export function loadFlatSkillIdentities(skillDirectories: readonly string[]): FlatSkillIdentity[] {
  return skillDirectories.map((directory) => {
    const definitionPath = join(directory, SKILL_DEFINITION);
    let loaded: ReturnType<typeof loadSkillsFromDir>;
    try { loaded = loadSkillsFromDir({ dir: directory, source: 'bazframe-profile' }); }
    catch (error) { throw invalidFlatSkill(directory, [], error); }
    const hasLoaderError = loaded.diagnostics.some((diagnostic) => diagnostic.type === 'error');
    const skill = loaded.skills.length === 1 ? loaded.skills[0] : undefined;
    if (hasLoaderError || skill === undefined || skill.baseDir !== directory || skill.filePath !== definitionPath) {
      throw invalidFlatSkill(directory, loaded.diagnostics.map((diagnostic) => diagnostic.message));
    }
    return { name: skill.name, definitionPath: skill.filePath };
  });
}

export interface DirectSkillCollection {
  schemaVersion: 1;
  collectionKind: SkillCollectionKind;
  collectionId: string;
  collectionRoot?: string;
  snapshotDigest?: string;
  skillsRoot?: string;
  descriptorPath: string;
  relativeDescriptorPath: string;
  preparationState: 'ready' | 'failed';
  rebuildAvailability: 'available' | 'unavailable';
}
export interface DerivedSkill<T = unknown> {
  name: string; baseDir: string; definitionPath: string;
  collectionKind: SkillCollectionKind; collectionId: string; collectionRoot: string; relativePath: string; loaded?: T;
}
export interface DefinitionLoaderSkill<T = unknown> { name: string; baseDir: string; definitionPath: string; loaded?: T; }
export interface DefinitionLoaderDiagnostic { type?: 'error' | 'warning' | 'collision'; message: string; }
export interface DefinitionLoaderResult<T = unknown> { skills: DefinitionLoaderSkill<T>[]; diagnostics: DefinitionLoaderDiagnostic[]; }
export type DefinitionLoader<T = unknown> = (baseDir: string, definitionPath: string, kind?: SkillCollectionKind) => Promise<DefinitionLoaderResult<T>> | DefinitionLoaderResult<T>;

export type SkillCollectionDiagnostic =
  | { category: 'invalid-reference' | 'invalid-collection'; collectionKind: SkillCollectionKind; collectionId: string; path: string }
  | { category: 'broken-root' | 'broken-snapshot' | 'internal-symlink' | 'unsupported-entry' | 'mixed-root' | 'invalid-definition' | 'io-error'; collectionKind: SkillCollectionKind; collectionId: string; path: string }
  | { category: 'limit-exceeded'; collectionKind: SkillCollectionKind; collectionId: string; path: string; limit: 'depth' | 'entries' | 'skills' }
  | { category: 'duplicate-name'; collectionKind: SkillCollectionKind; collectionId: string; path: string; name: string }
  | { category: 'pi-loader'; collectionKind: SkillCollectionKind; collectionId: string; path: string; diagnosticIndex: number; message: string };

export interface ProfileSkillCollectionComposition<T = unknown> {
  directCollections: DirectSkillCollection[];
  derivedSkills: DerivedSkill<T>[];
  diagnostics: SkillCollectionDiagnostic[];
}
export interface GlobalSkillCollectionInspection<T = unknown> {
  record: SkillCollectionRecord;
  path: string;
  rebuildAvailability: 'available' | 'unavailable';
  skills: DerivedSkill<T>[];
  diagnostics: SkillCollectionDiagnostic[];
}
interface CandidateCollection<T> { direct: DirectSkillCollection; skills: DerivedSkill<T>[]; }
class SkillCollectionFailure extends Error {
  readonly diagnostic: SkillCollectionDiagnostic | SkillCollectionDiagnostic[];
  constructor(diagnostic: SkillCollectionDiagnostic | SkillCollectionDiagnostic[]) { super('skill collection resolution failed'); this.diagnostic = diagnostic; }
}

function homeForProfile(profileDirectory: string): string {
  const profileParent = dirname(profileDirectory);
  return profileParent.endsWith(`${sep}profiles`) ? dirname(profileParent) : profileParent;
}
function directFromReference(
  collectionKind: SkillCollectionKind,
  collectionId: string,
  referencePath: string,
  relativePath: string
): DirectSkillCollection {
  return {
    schemaVersion: 1,
    collectionKind,
    collectionId,
    descriptorPath: referencePath,
    relativeDescriptorPath: relativePath,
    preparationState: 'failed',
    rebuildAvailability: 'unavailable'
  };
}
function directFromRecord(record: SkillCollectionRecord, referencePath: string, relativePath: string, rebuild: 'available' | 'unavailable' = 'unavailable'): DirectSkillCollection {
  return {
    schemaVersion: 1,
    collectionKind: kindForRecord(record),
    collectionId: idForRecord(record),
    collectionRoot: record.root,
    snapshotDigest: record.digest,
    skillsRoot: skillsRootForRecord(record),
    descriptorPath: referencePath,
    relativeDescriptorPath: relativePath,
    preparationState: 'ready',
    rebuildAvailability: rebuild
  };
}

export async function inspectGlobalSkillCollections<T = unknown>(
  bazframeHome: string,
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<{ collections: GlobalSkillCollectionInspection<T>[]; diagnostics: SkillCollectionDiagnostic[] }> {
  const namespace = await scanGlobalSkillCollections(bazframeHome);
  const diagnostics: SkillCollectionDiagnostic[] = namespace.diagnostics.map((item) => ({
    category: 'invalid-collection', collectionKind: item.key.kind, collectionId: item.key.id, path: item.path
  }));
  const collections: GlobalSkillCollectionInspection<T>[] = [];
  for (const item of namespace.records) {
    try {
      const record = await readCollection(bazframeHome, item.key);
      const rebuild = await rebuildAvailability(record.root);
      const direct = directFromRecord(record, item.path, item.relativePath, rebuild);
      let skills: DerivedSkill<T>[] = [];
      const collectionDiagnostics: SkillCollectionDiagnostic[] = [];
      try { skills = await resolveOneCollection(direct, definitionLoader, bazframeHome); }
      catch (error) {
        if (error instanceof SkillCollectionFailure) collectionDiagnostics.push(...(Array.isArray(error.diagnostic) ? error.diagnostic : [error.diagnostic]));
        else collectionDiagnostics.push(baseDiagnostic('io-error', direct, '.'));
      }
      collections.push({ record, path: item.path, rebuildAvailability: rebuild, skills, diagnostics: sortDiagnostics(collectionDiagnostics) });
    } catch { diagnostics.push({ category: 'invalid-collection', collectionKind: item.key.kind, collectionId: item.key.id, path: item.relativePath }); }
  }
  return { collections, diagnostics: sortDiagnostics(diagnostics) };
}

export async function resolveGlobalSkillCollection<T = unknown>(
  bazframeHome: string,
  record: SkillCollectionRecord,
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<DerivedSkill<T>[]> {
  try {
    return await resolveOneCollection(
      directFromRecord(record, '', `${idForRecord(record)}.json`),
      definitionLoader,
      bazframeHome
    );
  } catch (error) {
    if (error instanceof SkillCollectionFailure) throw invalidCollectionCandidate(error);
    throw error;
  }
}

export async function resolveProfileSkillCollections<T = unknown>(
  profileDirectory: string,
  flatSkills: readonly FlatSkillIdentity[],
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<ProfileSkillCollectionComposition<T>> {
  const bazframeHome = homeForProfile(profileDirectory);
  const profileId = profileDirectory.split(sep).at(-1)!;
  const namespace = await scanProfileCollectionReferences(bazframeHome, profileId);
  const directCollections: DirectSkillCollection[] = [];
  const candidates: CandidateCollection<T>[] = [];
  const diagnostics: SkillCollectionDiagnostic[] = namespace.diagnostics.map((item) => ({
    category: 'invalid-reference' as const,
    collectionKind: item.key.kind,
    collectionId: item.key.id,
    path: item.path
  }));
  if (diagnostics.length > 0) {
    return { directCollections: [], derivedSkills: [], diagnostics: sortDiagnostics(diagnostics) };
  }
  for (const item of namespace.references) {
    try { await readProfileCollectionReference(bazframeHome, profileId, item.key); }
    catch {
      diagnostics.push({ category: 'invalid-reference', collectionKind: item.key.kind, collectionId: item.key.id, path: item.relativePath });
    }
  }
  if (diagnostics.length > 0) {
    return { directCollections: [], derivedSkills: [], diagnostics: sortDiagnostics(diagnostics) };
  }
  for (const item of namespace.references) {
    const referenceDirect = directFromReference(
      item.key.kind,
      item.key.id,
      item.path,
      item.relativePath
    );
    directCollections.push(referenceDirect);
    let record: SkillCollectionRecord;
    try { record = await readCollection(bazframeHome, item.key); }
    catch {
      diagnostics.push({ category: 'invalid-collection', collectionKind: item.key.kind, collectionId: item.key.id, path: item.relativePath });
      continue;
    }
    const direct = directFromRecord(record, item.path, item.relativePath, await rebuildAvailability(record.root));
    directCollections[directCollections.length - 1] = direct;
    try { candidates.push({ direct, skills: await resolveOneCollection(direct, definitionLoader, bazframeHome) }); }
    catch (error) {
      direct.preparationState = 'failed';
      if (error instanceof SkillCollectionFailure) {
        const failures = Array.isArray(error.diagnostic) ? error.diagnostic : [error.diagnostic];
        diagnostics.push(...failures);
      } else diagnostics.push(baseDiagnostic('io-error', direct, '.'));
    }
  }
  return composeCandidates(directCollections, candidates, flatSkills, diagnostics);
}

export function validateCapturedSkillComposition<T = unknown>(
  flatSkills: readonly FlatSkillIdentity[],
  collectionSkills: readonly DerivedSkill<T>[]
): SkillCollectionDiagnostic[] {
  const flatNames = new Set(flatSkills.map((skill) => skill.name));
  const byName = new Map<string, DerivedSkill<T>[]>();
  for (const skill of collectionSkills) {
    const group = byName.get(skill.name) ?? [];
    group.push(skill);
    byName.set(skill.name, group);
  }
  const diagnostics: SkillCollectionDiagnostic[] = [];
  for (const [name, skills] of [...byName.entries()].sort(([left], [right]) => compare(left, right))) {
    if (!flatNames.has(name) && skills.length < 2) continue;
    for (const skill of skills) {
      diagnostics.push({
        category: 'duplicate-name',
        collectionKind: skill.collectionKind,
        collectionId: skill.collectionId,
        path: skill.relativePath,
        name
      });
    }
  }
  return sortDiagnostics(diagnostics);
}

function composeCandidates<T>(directCollections: DirectSkillCollection[], candidates: CandidateCollection<T>[], flatSkills: readonly FlatSkillIdentity[], diagnostics: SkillCollectionDiagnostic[]): ProfileSkillCollectionComposition<T> {
  const capturedDiagnostics = validateCapturedSkillComposition(flatSkills, candidates.flatMap((candidate) => candidate.skills));
  const duplicateCollections = new Set(capturedDiagnostics.map((diagnostic) => collectionKey(diagnostic.collectionKind, diagnostic.collectionId)));
  return {
    directCollections,
    derivedSkills: candidates.filter((candidate) => !duplicateCollections.has(collectionKey(candidate.direct.collectionKind, candidate.direct.collectionId))).flatMap((candidate) => candidate.skills),
    diagnostics: sortDiagnostics([...diagnostics, ...capturedDiagnostics])
  };
}

async function rebuildAvailability(collectionRoot: string): Promise<'available' | 'unavailable'> {
  try { const metadata = await lstat(collectionRoot); return !metadata.isSymbolicLink() && metadata.isDirectory() && await realpath(collectionRoot) === collectionRoot ? 'available' : 'unavailable'; }
  catch { return 'unavailable'; }
}

export async function validateProspectiveSkillCollection<T = unknown>(
  profileDirectory: string,
  flatSkills: readonly FlatSkillIdentity[],
  candidate: DirectSkillCollection,
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<DerivedSkill<T>[]> {
  const bazframeHome = homeForProfile(profileDirectory);
  let skills: DerivedSkill<T>[];
  try { skills = await resolveOneCollection(candidate, definitionLoader, bazframeHome); }
  catch (error) {
    if (error instanceof SkillCollectionFailure) throw invalidCollectionCandidate(error);
    throw error;
  }
  const ownNames = new Map<string, number>();
  for (const skill of skills) ownNames.set(skill.name, (ownNames.get(skill.name) ?? 0) + 1);
  const occupied = new Set(flatSkills.map((skill) => skill.name));
  for (const skill of await structurallyValidExistingSkills(profileDirectory, collectionKey(candidate.collectionKind, candidate.collectionId), definitionLoader, bazframeHome)) occupied.add(skill.name);
  const conflict = skills.find((skill) => (ownNames.get(skill.name) ?? 0) > 1 || occupied.has(skill.name));
  if (conflict !== undefined) throw new BazframeError('SKILL_COLLECTION_CANDIDATE_DUPLICATE', `Candidate ${candidate.collectionKind} Skill name conflicts with the prospective profile: ${conflict.name}`);
  return skills;
}

async function structurallyValidExistingSkills<T>(profileDirectory: string, excludedCollectionKey: string, loader: DefinitionLoader<T>, bazframeHome: string): Promise<DerivedSkill<T>[]> {
  const profileId = profileDirectory.split(sep).at(-1)!;
  const namespace = await scanProfileCollectionReferences(bazframeHome, profileId);
  const skills: DerivedSkill<T>[] = [];
  for (const item of namespace.references) {
    if (collectionKey(item.key.kind, item.key.id) === excludedCollectionKey) continue;
    try {
      await readProfileCollectionReference(bazframeHome, profileId, item.key);
      const record = await readCollection(bazframeHome, item.key);
      skills.push(...await resolveOneCollection(directFromRecord(record, item.path, item.relativePath), loader, bazframeHome));
    } catch { /* unrelated failures do not block activation */ }
  }
  return skills;
}

async function resolveOneCollection<T>(
  direct: DirectSkillCollection,
  loader: DefinitionLoader<T>,
  bazframeHome: string
): Promise<DerivedSkill<T>[]> {
  let root: string;
  if (direct.snapshotDigest === undefined || direct.skillsRoot === undefined) {
    fail({
      category: 'invalid-collection',
      collectionKind: direct.collectionKind,
      collectionId: direct.collectionId,
      path: direct.relativeDescriptorPath
    });
  }
  try {
    const snapshot = await verifySkillSnapshot(bazframeHome, direct.snapshotDigest);
    root = await resolvePhysicalRelativeDirectory(snapshot.artifactPath, direct.skillsRoot);
  } catch {
    fail(baseDiagnostic('broken-snapshot', direct, '.'));
  }
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      fail(baseDiagnostic('broken-root', direct, '.'));
    }
    const canonical = await realpath(root);
    if (canonical !== root) fail(baseDiagnostic('broken-root', direct, '.'));
  } catch (error) {
    if (error instanceof SkillCollectionFailure) throw error;
    fail(baseDiagnostic('broken-root', direct, '.'));
  }

  let entries = 0;
  let skills = 0;
  const rootHasDefinition = await hasPhysicalRootDefinition(root, direct);
  const candidates: DerivedSkill<T>[] = [];

  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(directory)).sort(compare);
    } catch {
      fail(baseDiagnostic('io-error', direct, relativeDirectory));
    }
    for (const name of names) {
      const path = relativeDirectory === '.' ? name : `${relativeDirectory}/${name}`;
      const absolute = join(directory, name);
      let metadata;
      try {
        metadata = await lstat(absolute);
      } catch {
        fail(baseDiagnostic('io-error', direct, path));
      }
      if ((name === '.git' || name === 'node_modules')
        && (metadata.isDirectory() || metadata.isSymbolicLink())) continue;

      entries += 1;
      if (entries > SKILL_COLLECTION_LIMITS.entries) {
        fail(limitDiagnostic(direct, path, 'entries'));
      }
      if (metadata.isDirectory() && depth + 1 > SKILL_COLLECTION_LIMITS.depth) {
        fail(limitDiagnostic(direct, path, 'depth'));
      }
      if (metadata.isSymbolicLink()) {
        fail(baseDiagnostic('internal-symlink', direct, path));
      }
      if (!metadata.isDirectory() && !metadata.isFile()) {
        fail(baseDiagnostic('unsupported-entry', direct, path));
      }
      try {
        const canonical = await realpath(absolute);
        if (canonical !== resolve(absolute) || !isWithin(canonical, root)) {
          fail(baseDiagnostic('io-error', direct, path));
        }
      } catch (error) {
        if (error instanceof SkillCollectionFailure) throw error;
        fail(baseDiagnostic('io-error', direct, path));
      }
      if (metadata.isDirectory()) {
        await visit(absolute, path, depth + 1);
        continue;
      }
      if (name !== SKILL_DEFINITION) continue;

      skills += 1;
      if (skills > SKILL_COLLECTION_LIMITS.skills) {
        fail(limitDiagnostic(direct, path, 'skills'));
      }
      if (relativeDirectory !== '.' && rootHasDefinition) {
        fail(baseDiagnostic('mixed-root', direct, path));
      }

      const baseDir = directory;
      let loaded: DefinitionLoaderResult<T>;
      try {
        loaded = await loader(baseDir, absolute, direct.collectionKind);
      } catch {
        fail(baseDiagnostic('invalid-definition', direct, path));
      }
      const hasLoaderError = loaded.diagnostics.some((diagnostic) => diagnostic.type === 'error');
      const exact = loaded.skills.length === 1
        && loaded.skills[0]?.baseDir === baseDir
        && loaded.skills[0]?.definitionPath === absolute
        && isSafeSkillId(loaded.skills[0]?.name ?? '');
      if (hasLoaderError || !exact) {
        const diagnostics = loaded.diagnostics.length === 0
          ? [{ message: 'Pi loader rejected definition without a diagnostic' }]
          : loaded.diagnostics;
        fail(diagnostics.map((diagnostic, diagnosticIndex) => ({
          category: 'pi-loader' as const,
          collectionKind: direct.collectionKind,
          collectionId: direct.collectionId,
          path,
          diagnosticIndex,
          message: diagnostic.message
        })));
      }
      const skill = loaded.skills[0] as DefinitionLoaderSkill<T>;
      candidates.push({
        name: skill.name,
        baseDir: skill.baseDir,
        definitionPath: skill.definitionPath,
        collectionKind: direct.collectionKind,
        collectionId: direct.collectionId,
        collectionRoot: root,
        relativePath: path,
        ...(skill.loaded === undefined ? {} : { loaded: skill.loaded })
      });
    }
  }

  await visit(root, '.', 0);
  if (rootHasDefinition && candidates.some((candidate) => candidate.relativePath !== SKILL_DEFINITION)) {
    const descendant = candidates.find((candidate) => candidate.relativePath !== SKILL_DEFINITION);
    fail(baseDiagnostic('mixed-root', direct, descendant?.relativePath ?? '.'));
  }
  return candidates;
}

async function hasPhysicalRootDefinition(
  root: string,
  direct: DirectSkillCollection
): Promise<boolean> {
  try {
    const metadata = await lstat(join(root, SKILL_DEFINITION));
    return !metadata.isSymbolicLink() && metadata.isFile();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    fail(baseDiagnostic('io-error', direct, SKILL_DEFINITION));
  }
}

async function defaultDefinitionLoader(
  baseDir: string,
  definitionPath: string,
  kind: SkillCollectionKind = 'library'
): Promise<DefinitionLoaderResult<Skill>> {
  const loaded = loadSkillsFromDir({ dir: baseDir, source: kind === 'library' ? 'bazframe-library' : 'bazframe-package' });
  return {
    skills: loaded.skills
      .filter((skill) => skill.baseDir === baseDir && skill.filePath === definitionPath)
      .map((skill) => ({
        name: skill.name,
        baseDir: skill.baseDir,
        definitionPath: skill.filePath,
        loaded: skill
      })),
    diagnostics: loaded.diagnostics.map((diagnostic) => ({
      type: diagnostic.type,
      message: diagnostic.message
    }))
  };
}

function invalidFlatSkill(
  directory: string,
  diagnostics: readonly string[],
  cause?: unknown
): BazframeError {
  return new BazframeError(
    'INVALID_SKILL_DEFINITION',
    [`Invalid profile skill: ${directory}`, ...diagnostics].join('\n'),
    cause === undefined ? undefined : { cause }
  );
}

function baseDiagnostic(
  category: Extract<SkillCollectionDiagnostic['category'],
    'broken-root' | 'broken-snapshot' | 'internal-symlink' | 'unsupported-entry' | 'mixed-root'
    | 'invalid-definition' | 'io-error'>,
  direct: DirectSkillCollection,
  path: string
): SkillCollectionDiagnostic {
  return { category, collectionKind: direct.collectionKind, collectionId: direct.collectionId, path };
}

function limitDiagnostic(
  direct: DirectSkillCollection,
  path: string,
  limit: 'depth' | 'entries' | 'skills'
): SkillCollectionDiagnostic {
  return {
    category: 'limit-exceeded',
    collectionKind: direct.collectionKind,
    collectionId: direct.collectionId,
    path,
    limit
  };
}

function fail(diagnostic: SkillCollectionDiagnostic | SkillCollectionDiagnostic[]): never {
  throw new SkillCollectionFailure(diagnostic);
}

function invalidCollectionCandidate(error: SkillCollectionFailure): BazframeError {
  const diagnostic = Array.isArray(error.diagnostic) ? error.diagnostic[0]! : error.diagnostic;
  return new BazframeError(
    'SKILL_COLLECTION_CANDIDATE_INVALID',
    formatSkillCollectionDiagnostic(diagnostic),
    { cause: error }
  );
}

function sortDiagnostics(diagnostics: readonly SkillCollectionDiagnostic[]): SkillCollectionDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const base = compare(left.collectionKind, right.collectionKind)
      || compare(left.collectionId, right.collectionId)
      || compare(left.path, right.path)
      || compare(left.category, right.category);
    if (base !== 0) return base;
    if (left.category === 'pi-loader' && right.category === 'pi-loader') {
      return left.diagnosticIndex - right.diagnosticIndex || compare(left.message, right.message);
    }
    return 0;
  });
}

export function formatSkillCollectionDiagnostic(diagnostic: SkillCollectionDiagnostic): string {
  const identity = `${diagnostic.collectionKind} ${diagnostic.collectionId}:${diagnostic.path}`;
  const category = diagnostic.category === 'invalid-collection'
    ? `invalid-${diagnostic.collectionKind}`
    : diagnostic.category;
  if (diagnostic.category === 'limit-exceeded') {
    return `${identity} ${category} (${diagnostic.limit})`;
  }
  if (diagnostic.category === 'duplicate-name') {
    return `${identity} ${category} (${diagnostic.name})`;
  }
  if (diagnostic.category === 'pi-loader') {
    return `${identity} ${category}[${diagnostic.diagnosticIndex}]: ${diagnostic.message}`;
  }
  return `${identity} ${category}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === ''
    || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}
