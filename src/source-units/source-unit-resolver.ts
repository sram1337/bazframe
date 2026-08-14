import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  readProfileSourceReference,
  scanProfileSourceReferences
} from '../profiles/profile-source-reference.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { SKILL_DEFINITION } from '../skills/skill-metadata.js';
import {
  readGlobalSource,
  scanGlobalSourceNamespace,
  type GlobalSourceRecord
} from '../sources/source-store.js';
import { resolvePhysicalRelativeDirectory, verifySourceSnapshot } from './source-snapshot.js';

export const SOURCE_UNIT_LIMITS = Object.freeze({ depth: 8, entries: 256, skills: 64 });
export const UNKNOWN_PROVIDER_ID = '<unknown-provider>';
export const UNKNOWN_SOURCE_ID = '<unknown-source>';

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

/** Compatibility-shaped projection of a referenced global source. */
export interface DirectSourceUnit {
  schemaVersion: 1 | 2;
  providerId: string;
  sourceId: string;
  sourceRoot?: string;
  snapshotDigest?: string;
  sourceUnitRoot?: string;
  descriptorPath: string;
  relativeDescriptorPath: string;
  preparationState: 'ready' | 'failed';
  rebuildAvailability: 'available' | 'unavailable';
}
export interface DerivedSkill<T = unknown> {
  name: string; baseDir: string; definitionPath: string;
  providerId: string; sourceId: string; sourceRoot: string; relativePath: string; loaded?: T;
}
export interface DefinitionLoaderSkill<T = unknown> { name: string; baseDir: string; definitionPath: string; loaded?: T; }
export interface DefinitionLoaderDiagnostic { type?: 'error' | 'warning' | 'collision'; message: string; }
export interface DefinitionLoaderResult<T = unknown> { skills: DefinitionLoaderSkill<T>[]; diagnostics: DefinitionLoaderDiagnostic[]; }
export type DefinitionLoader<T = unknown> = (baseDir: string, definitionPath: string) => Promise<DefinitionLoaderResult<T>> | DefinitionLoaderResult<T>;

export type SourceDiagnostic =
  | { category: 'invalid-reference' | 'invalid-source'; providerId: string; sourceId: string; path: string }
  | { category: 'broken-root' | 'broken-snapshot' | 'internal-symlink' | 'unsupported-entry' | 'mixed-root' | 'invalid-definition' | 'io-error'; providerId: string; sourceId: string; path: string }
  | { category: 'limit-exceeded'; providerId: string; sourceId: string; path: string; limit: 'depth' | 'entries' | 'skills' }
  | { category: 'duplicate-name'; providerId: string; sourceId: string; path: string; name: string }
  | { category: 'pi-loader'; providerId: string; sourceId: string; path: string; diagnosticIndex: number; message: string };

export interface ProfileSourceComposition<T = unknown> {
  directSourceUnits: DirectSourceUnit[];
  derivedSkills: DerivedSkill<T>[];
  diagnostics: SourceDiagnostic[];
}
export interface GlobalSourceInspection<T = unknown> {
  record: GlobalSourceRecord;
  path: string;
  rebuildAvailability: 'available' | 'unavailable';
  skills: DerivedSkill<T>[];
  diagnostics: SourceDiagnostic[];
}
interface CandidateSource<T> { direct: DirectSourceUnit; skills: DerivedSkill<T>[]; }
class SourceFailure extends Error {
  readonly diagnostic: SourceDiagnostic | SourceDiagnostic[];
  constructor(diagnostic: SourceDiagnostic | SourceDiagnostic[]) { super('source-unit resolution failed'); this.diagnostic = diagnostic; }
}

function homeForProfile(profileDirectory: string): string {
  const profileParent = dirname(profileDirectory);
  return profileParent.endsWith(`${sep}profiles`) ? dirname(profileParent) : profileParent;
}
function directFromReference(
  providerId: string,
  sourceId: string,
  referencePath: string,
  relativePath: string
): DirectSourceUnit {
  return {
    schemaVersion: 1,
    providerId,
    sourceId,
    descriptorPath: referencePath,
    relativeDescriptorPath: relativePath,
    preparationState: 'failed',
    rebuildAvailability: 'unavailable'
  };
}
function directFromRecord(record: GlobalSourceRecord, referencePath: string, relativePath: string, rebuild: 'available' | 'unavailable' = 'unavailable'): DirectSourceUnit {
  return {
    schemaVersion: 1,
    providerId: record.provider,
    sourceId: record.source,
    sourceRoot: record.root,
    snapshotDigest: record.digest,
    sourceUnitRoot: record.sourceUnitRoot,
    descriptorPath: referencePath,
    relativeDescriptorPath: relativePath,
    preparationState: 'ready',
    rebuildAvailability: rebuild
  };
}

export async function inspectGlobalSources<T = unknown>(
  bazframeHome: string,
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<{ sources: GlobalSourceInspection<T>[]; diagnostics: SourceDiagnostic[] }> {
  const namespace = await scanGlobalSourceNamespace(bazframeHome);
  const diagnostics: SourceDiagnostic[] = namespace.diagnostics.map((item) => ({
    category: 'invalid-source', providerId: item.provider, sourceId: item.source, path: item.path
  }));
  const sources: GlobalSourceInspection<T>[] = [];
  for (const item of namespace.sources) {
    try {
      const record = await readGlobalSource(bazframeHome, item.provider, item.source);
      const rebuild = await rebuildAvailability(record.root);
      const direct = directFromRecord(record, item.path, item.relativePath, rebuild);
      let skills: DerivedSkill<T>[] = [];
      const sourceDiagnostics: SourceDiagnostic[] = [];
      try { skills = await resolveOneSource(direct, definitionLoader, bazframeHome); }
      catch (error) {
        if (error instanceof SourceFailure) sourceDiagnostics.push(...(Array.isArray(error.diagnostic) ? error.diagnostic : [error.diagnostic]));
        else sourceDiagnostics.push(baseDiagnostic('io-error', direct, '.'));
      }
      sources.push({ record, path: item.path, rebuildAvailability: rebuild, skills, diagnostics: sortDiagnostics(sourceDiagnostics) });
    } catch { diagnostics.push({ category: 'invalid-source', providerId: item.provider, sourceId: item.source, path: item.relativePath }); }
  }
  return { sources, diagnostics: sortDiagnostics(diagnostics) };
}

export async function resolveGlobalSource<T = unknown>(
  bazframeHome: string,
  record: GlobalSourceRecord,
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<DerivedSkill<T>[]> {
  return resolveOneSource(directFromRecord(record, '', `${record.provider}/${record.source}.json`), definitionLoader, bazframeHome);
}

export async function resolveProfileSourceUnits<T = unknown>(
  profileDirectory: string,
  flatSkills: readonly FlatSkillIdentity[],
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<ProfileSourceComposition<T>> {
  const bazframeHome = homeForProfile(profileDirectory);
  const profileId = profileDirectory.split(sep).at(-1)!;
  const namespace = await scanProfileSourceReferences(bazframeHome, profileId);
  const directSourceUnits: DirectSourceUnit[] = [];
  const candidates: CandidateSource<T>[] = [];
  const diagnostics: SourceDiagnostic[] = namespace.diagnostics.map((item) => ({
    category: 'invalid-reference' as const,
    providerId: item.provider,
    sourceId: item.source,
    path: item.path
  }));
  if (diagnostics.length > 0) {
    return { directSourceUnits: [], derivedSkills: [], diagnostics: sortDiagnostics(diagnostics) };
  }
  for (const item of namespace.references) {
    try { await readProfileSourceReference(bazframeHome, profileId, item.provider, item.source); }
    catch {
      diagnostics.push({ category: 'invalid-reference', providerId: item.provider, sourceId: item.source, path: item.relativePath });
    }
  }
  if (diagnostics.length > 0) {
    return { directSourceUnits: [], derivedSkills: [], diagnostics: sortDiagnostics(diagnostics) };
  }
  for (const item of namespace.references) {
    const referenceDirect = directFromReference(
      item.provider,
      item.source,
      item.path,
      item.relativePath
    );
    directSourceUnits.push(referenceDirect);
    let record: GlobalSourceRecord;
    try { record = await readGlobalSource(bazframeHome, item.provider, item.source); }
    catch {
      diagnostics.push({ category: 'invalid-source', providerId: item.provider, sourceId: item.source, path: item.relativePath });
      continue;
    }
    const direct = directFromRecord(record, item.path, item.relativePath, await rebuildAvailability(record.root));
    directSourceUnits[directSourceUnits.length - 1] = direct;
    try { candidates.push({ direct, skills: await resolveOneSource(direct, definitionLoader, bazframeHome) }); }
    catch (error) {
      direct.preparationState = 'failed';
      if (error instanceof SourceFailure) {
        const failures = Array.isArray(error.diagnostic) ? error.diagnostic : [error.diagnostic];
        diagnostics.push(...failures);
      } else diagnostics.push(baseDiagnostic('io-error', direct, '.'));
    }
  }
  return composeCandidates(directSourceUnits, candidates, flatSkills, diagnostics);
}

function composeCandidates<T>(directSourceUnits: DirectSourceUnit[], candidates: CandidateSource<T>[], flatSkills: readonly FlatSkillIdentity[], diagnostics: SourceDiagnostic[]): ProfileSourceComposition<T> {
  const duplicateUnits = new Set<string>();
  const flatNames = new Set(flatSkills.map((skill) => skill.name));
  const byName = new Map<string, DerivedSkill<T>[]>();
  for (const candidate of candidates) for (const skill of candidate.skills) {
    const group = byName.get(skill.name) ?? []; group.push(skill); byName.set(skill.name, group);
  }
  for (const [name, skills] of [...byName.entries()].sort(([left], [right]) => compare(left, right))) {
    if (!flatNames.has(name) && skills.length < 2) continue;
    for (const skill of skills) {
      duplicateUnits.add(sourceKey(skill.providerId, skill.sourceId));
      diagnostics.push({ category: 'duplicate-name', providerId: skill.providerId, sourceId: skill.sourceId, path: skill.relativePath, name });
    }
  }
  return {
    directSourceUnits,
    derivedSkills: candidates.filter((candidate) => !duplicateUnits.has(sourceKey(candidate.direct.providerId, candidate.direct.sourceId))).flatMap((candidate) => candidate.skills),
    diagnostics: sortDiagnostics(diagnostics)
  };
}

async function rebuildAvailability(sourceRoot: string): Promise<'available' | 'unavailable'> {
  try { const metadata = await lstat(sourceRoot); return !metadata.isSymbolicLink() && metadata.isDirectory() && await realpath(sourceRoot) === sourceRoot ? 'available' : 'unavailable'; }
  catch { return 'unavailable'; }
}

export async function validateProspectiveSourceUnit<T = unknown>(
  profileDirectory: string,
  flatSkills: readonly FlatSkillIdentity[],
  candidate: DirectSourceUnit,
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<DerivedSkill<T>[]> {
  const bazframeHome = homeForProfile(profileDirectory);
  let skills: DerivedSkill<T>[];
  try { skills = await resolveOneSource(candidate, definitionLoader, bazframeHome); }
  catch (error) {
    if (error instanceof SourceFailure) throw new BazframeError('SOURCE_CANDIDATE_INVALID', formatSourceDiagnostic(Array.isArray(error.diagnostic) ? error.diagnostic[0]! : error.diagnostic));
    throw error;
  }
  const ownNames = new Map<string, number>();
  for (const skill of skills) ownNames.set(skill.name, (ownNames.get(skill.name) ?? 0) + 1);
  const occupied = new Set(flatSkills.map((skill) => skill.name));
  for (const skill of await structurallyValidExistingSkills(profileDirectory, candidate.providerId, candidate.sourceId, definitionLoader, bazframeHome)) occupied.add(skill.name);
  const conflict = skills.find((skill) => (ownNames.get(skill.name) ?? 0) > 1 || occupied.has(skill.name));
  if (conflict !== undefined) throw new BazframeError('SOURCE_CANDIDATE_DUPLICATE', `Candidate source skill name conflicts with the prospective profile: ${conflict.name}`);
  return skills;
}

async function structurallyValidExistingSkills<T>(profileDirectory: string, excludedProviderId: string, excludedSourceId: string, loader: DefinitionLoader<T>, bazframeHome: string): Promise<DerivedSkill<T>[]> {
  const profileId = profileDirectory.split(sep).at(-1)!;
  const namespace = await scanProfileSourceReferences(bazframeHome, profileId);
  const skills: DerivedSkill<T>[] = [];
  for (const item of namespace.references) {
    if (item.provider === excludedProviderId && item.source === excludedSourceId) continue;
    try {
      await readProfileSourceReference(bazframeHome, profileId, item.provider, item.source);
      const record = await readGlobalSource(bazframeHome, item.provider, item.source);
      skills.push(...await resolveOneSource(directFromRecord(record, item.path, item.relativePath), loader, bazframeHome));
    } catch { /* unrelated failures do not block activation */ }
  }
  return skills;
}

async function resolveOneSource<T>(
  direct: DirectSourceUnit,
  loader: DefinitionLoader<T>,
  bazframeHome: string
): Promise<DerivedSkill<T>[]> {
  let root: string;
  if (direct.snapshotDigest === undefined || direct.sourceUnitRoot === undefined) {
    fail({
      category: 'invalid-source',
      providerId: direct.providerId,
      sourceId: direct.sourceId,
      path: direct.relativeDescriptorPath
    });
  }
  try {
    const snapshot = await verifySourceSnapshot(bazframeHome, direct.snapshotDigest);
    root = await resolvePhysicalRelativeDirectory(snapshot.artifactRoot, direct.sourceUnitRoot);
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
    if (error instanceof SourceFailure) throw error;
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
      if (entries > SOURCE_UNIT_LIMITS.entries) {
        fail(limitDiagnostic(direct, path, 'entries'));
      }
      if (metadata.isDirectory() && depth + 1 > SOURCE_UNIT_LIMITS.depth) {
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
        if (error instanceof SourceFailure) throw error;
        fail(baseDiagnostic('io-error', direct, path));
      }
      if (metadata.isDirectory()) {
        await visit(absolute, path, depth + 1);
        continue;
      }
      if (name !== SKILL_DEFINITION) continue;

      skills += 1;
      if (skills > SOURCE_UNIT_LIMITS.skills) {
        fail(limitDiagnostic(direct, path, 'skills'));
      }
      if (relativeDirectory !== '.' && rootHasDefinition) {
        fail(baseDiagnostic('mixed-root', direct, path));
      }

      const baseDir = directory;
      let loaded: DefinitionLoaderResult<T>;
      try {
        loaded = await loader(baseDir, absolute);
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
          providerId: direct.providerId,
          sourceId: direct.sourceId,
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
        providerId: direct.providerId,
        sourceId: direct.sourceId,
        sourceRoot: root,
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
  direct: DirectSourceUnit
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
  definitionPath: string
): Promise<DefinitionLoaderResult<Skill>> {
  const loaded = loadSkillsFromDir({ dir: baseDir, source: 'bazframe-source-unit' });
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
  category: Extract<SourceDiagnostic['category'],
    'broken-root' | 'broken-snapshot' | 'internal-symlink' | 'unsupported-entry' | 'mixed-root'
    | 'invalid-definition' | 'io-error'>,
  direct: DirectSourceUnit,
  path: string
): SourceDiagnostic {
  return { category, providerId: direct.providerId, sourceId: direct.sourceId, path };
}

function limitDiagnostic(
  direct: DirectSourceUnit,
  path: string,
  limit: 'depth' | 'entries' | 'skills'
): SourceDiagnostic {
  return {
    category: 'limit-exceeded',
    providerId: direct.providerId,
    sourceId: direct.sourceId,
    path,
    limit
  };
}

function fail(diagnostic: SourceDiagnostic | SourceDiagnostic[]): never {
  throw new SourceFailure(diagnostic);
}

function sortDiagnostics(diagnostics: readonly SourceDiagnostic[]): SourceDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const base = compare(left.providerId, right.providerId)
      || compare(left.sourceId, right.sourceId)
      || compare(left.path, right.path)
      || compare(left.category, right.category);
    if (base !== 0) return base;
    if (left.category === 'pi-loader' && right.category === 'pi-loader') {
      return left.diagnosticIndex - right.diagnosticIndex || compare(left.message, right.message);
    }
    return 0;
  });
}

export function formatSourceDiagnostic(diagnostic: SourceDiagnostic): string {
  const identity = `${diagnostic.providerId}/${diagnostic.sourceId}:${diagnostic.path}`;
  if (diagnostic.category === 'limit-exceeded') {
    return `${identity} ${diagnostic.category} (${diagnostic.limit})`;
  }
  if (diagnostic.category === 'duplicate-name') {
    return `${identity} ${diagnostic.category} (${diagnostic.name})`;
  }
  if (diagnostic.category === 'pi-loader') {
    return `${identity} ${diagnostic.category}[${diagnostic.diagnosticIndex}]: ${diagnostic.message}`;
  }
  return `${identity} ${diagnostic.category}`;
}

function sourceKey(providerId: string, sourceId: string): string {
  return `${providerId}\0${sourceId}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === ''
    || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}
