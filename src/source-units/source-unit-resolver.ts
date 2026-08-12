import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent';
import { BazframeError, errorCode } from '../core/errors.js';
import { readSourceDescriptor, type SourceDescriptor } from '../profiles/profile-source-membership.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { SKILL_DEFINITION } from '../skills/skill-metadata.js';
import { resolvePhysicalRelativeDirectory, verifySourceSnapshot } from './source-snapshot.js';

export const SOURCE_UNIT_LIMITS = Object.freeze({
  depth: 8,
  entries: 256,
  skills: 64
});
export const UNKNOWN_PROVIDER_ID = '<unknown-provider>';
export const UNKNOWN_SOURCE_ID = '<unknown-source>';

export interface FlatSkillIdentity {
  name: string;
  definitionPath: string;
}

export function loadFlatSkillIdentities(
  skillDirectories: readonly string[]
): FlatSkillIdentity[] {
  return skillDirectories.map((directory) => {
    const definitionPath = join(directory, SKILL_DEFINITION);
    let loaded: ReturnType<typeof loadSkillsFromDir>;
    try {
      loaded = loadSkillsFromDir({ dir: directory, source: 'bazframe-profile' });
    } catch (error) {
      throw invalidFlatSkill(directory, [], error);
    }
    const hasLoaderError = loaded.diagnostics.some((diagnostic) => diagnostic.type === 'error');
    const skill = loaded.skills.length === 1 ? loaded.skills[0] : undefined;
    if (hasLoaderError
      || skill === undefined
      || skill.baseDir !== directory
      || skill.filePath !== definitionPath) {
      throw invalidFlatSkill(
        directory,
        loaded.diagnostics.map((diagnostic) => diagnostic.message)
      );
    }
    return { name: skill.name, definitionPath: skill.filePath };
  });
}

export type DirectSourceUnit = SourceDescriptor & {
  descriptorPath: string;
  relativeDescriptorPath: string;
  preparationState: 'ready' | 'build-required' | 'failed';
  rebuildAvailability: 'available' | 'unavailable';
};

export interface DerivedSkill<T = unknown> {
  name: string;
  baseDir: string;
  definitionPath: string;
  providerId: string;
  sourceId: string;
  sourceRoot: string;
  relativePath: string;
  loaded?: T;
}

export interface DefinitionLoaderSkill<T = unknown> {
  name: string;
  baseDir: string;
  definitionPath: string;
  loaded?: T;
}

export interface DefinitionLoaderDiagnostic {
  type?: 'error' | 'warning' | 'collision';
  message: string;
}

export interface DefinitionLoaderResult<T = unknown> {
  skills: DefinitionLoaderSkill<T>[];
  diagnostics: DefinitionLoaderDiagnostic[];
}

export type DefinitionLoader<T = unknown> = (
  baseDir: string,
  definitionPath: string
) => Promise<DefinitionLoaderResult<T>> | DefinitionLoaderResult<T>;

export type SourceDiagnostic =
  | {
      category: 'invalid-descriptor';
      providerId: string;
      sourceId: string;
      path: string;
    }
  | {
      category: 'broken-root' | 'broken-snapshot' | 'build-required' | 'internal-symlink' | 'unsupported-entry'
        | 'mixed-root' | 'invalid-definition' | 'io-error';
      providerId: string;
      sourceId: string;
      path: string;
    }
  | {
      category: 'limit-exceeded';
      providerId: string;
      sourceId: string;
      path: string;
      limit: 'depth' | 'entries' | 'skills';
    }
  | {
      category: 'duplicate-name';
      providerId: string;
      sourceId: string;
      path: string;
      name: string;
    }
  | {
      category: 'pi-loader';
      providerId: string;
      sourceId: string;
      path: string;
      diagnosticIndex: number;
      message: string;
    };

export interface ProfileSourceComposition<T = unknown> {
  directSourceUnits: DirectSourceUnit[];
  derivedSkills: DerivedSkill<T>[];
  diagnostics: SourceDiagnostic[];
}

interface NamespaceDescriptorPath {
  providerId: string;
  sourceId: string;
  descriptorPath: string;
  relativeDescriptorPath: string;
}

interface CandidateSource<T> {
  direct: DirectSourceUnit;
  skills: DerivedSkill<T>[];
}

class SourceFailure extends Error {
  readonly diagnostic: SourceDiagnostic | SourceDiagnostic[];

  constructor(diagnostic: SourceDiagnostic | SourceDiagnostic[]) {
    super('source-unit resolution failed');
    this.diagnostic = diagnostic;
  }
}

export async function resolveProfileSourceUnits<T = unknown>(
  profileDirectory: string,
  flatSkills: readonly FlatSkillIdentity[],
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<ProfileSourceComposition<T>> {
  const sourceUnitsRoot = join(profileDirectory, 'source-units');
  const namespace = await validateNamespace(sourceUnitsRoot);
  if (namespace.diagnostics.length > 0) {
    return {
      directSourceUnits: [],
      derivedSkills: [],
      diagnostics: sortDiagnostics(namespace.diagnostics)
    };
  }

  const directSourceUnits: DirectSourceUnit[] = [];
  const candidates: CandidateSource<T>[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  for (const path of namespace.descriptors) {
    let descriptor: SourceDescriptor;
    try {
      descriptor = await readSourceDescriptor(
        path.descriptorPath,
        path.providerId,
        path.sourceId
      );
    } catch {
      diagnostics.push(invalidDescriptor(path.providerId, path.sourceId, path.relativeDescriptorPath));
      continue;
    }
    const direct: DirectSourceUnit = {
      ...descriptor,
      descriptorPath: path.descriptorPath,
      relativeDescriptorPath: path.relativeDescriptorPath,
      preparationState: descriptor.schemaVersion === 1 ? 'build-required' : 'ready',
      rebuildAvailability: await rebuildAvailability(descriptor.sourceRoot)
    };
    directSourceUnits.push(direct);
    try {
      const profileParent = dirname(profileDirectory);
      const bazframeHome = profileParent.endsWith(`${sep}profiles`) ? dirname(profileParent) : profileParent;
      candidates.push({ direct, skills: await resolveOneSource(direct, definitionLoader, bazframeHome) });
    } catch (error) {
      if (error instanceof SourceFailure) {
        const failures = Array.isArray(error.diagnostic) ? error.diagnostic : [error.diagnostic];
        if (failures.some((failure) => failure.category === 'broken-snapshot')) direct.preparationState = 'failed';
        diagnostics.push(...failures);
      } else {
        diagnostics.push(baseDiagnostic('io-error', direct, '.'));
      }
    }
  }

  const duplicateUnits = new Set<string>();
  const flatNames = new Set(flatSkills.map((skill) => skill.name));
  const byName = new Map<string, DerivedSkill<T>[]>();
  for (const candidate of candidates) {
    for (const skill of candidate.skills) {
      const group = byName.get(skill.name) ?? [];
      group.push(skill);
      byName.set(skill.name, group);
    }
  }
  for (const [name, skills] of [...byName.entries()].sort(([left], [right]) => compare(left, right))) {
    if (!flatNames.has(name) && skills.length < 2) continue;
    for (const skill of skills) {
      const key = sourceKey(skill.providerId, skill.sourceId);
      duplicateUnits.add(key);
      diagnostics.push({
        category: 'duplicate-name',
        providerId: skill.providerId,
        sourceId: skill.sourceId,
        path: skill.relativePath,
        name
      });
    }
  }

  const derivedSkills = candidates
    .filter((candidate) => !duplicateUnits.has(sourceKey(
      candidate.direct.providerId,
      candidate.direct.sourceId
    )))
    .flatMap((candidate) => candidate.skills);
  return {
    directSourceUnits,
    derivedSkills,
    diagnostics: sortDiagnostics(diagnostics)
  };
}

async function rebuildAvailability(sourceRoot: string): Promise<'available' | 'unavailable'> {
  try {
    const metadata = await lstat(sourceRoot);
    return !metadata.isSymbolicLink() && metadata.isDirectory() && await realpath(sourceRoot) === sourceRoot
      ? 'available' : 'unavailable';
  } catch { return 'unavailable'; }
}

export async function validateProspectiveSourceUnit<T = unknown>(
  profileDirectory: string,
  flatSkills: readonly FlatSkillIdentity[],
  candidate: DirectSourceUnit,
  definitionLoader: DefinitionLoader<T> = defaultDefinitionLoader as unknown as DefinitionLoader<T>
): Promise<DerivedSkill<T>[]> {
  const profileParent = dirname(profileDirectory);
  const bazframeHome = profileParent.endsWith(`${sep}profiles`) ? dirname(profileParent) : profileParent;
  let skills: DerivedSkill<T>[];
  try { skills = await resolveOneSource(candidate, definitionLoader, bazframeHome); }
  catch (error) {
    if (error instanceof SourceFailure) throw new BazframeError('SOURCE_CANDIDATE_INVALID', formatSourceDiagnostic(Array.isArray(error.diagnostic) ? error.diagnostic[0]! : error.diagnostic));
    throw error;
  }
  const ownNames = new Map<string, number>();
  for (const skill of skills) ownNames.set(skill.name, (ownNames.get(skill.name) ?? 0) + 1);
  const occupied = new Set(flatSkills.map((skill) => skill.name));
  for (const skill of await structurallyValidExistingSkills(
    profileDirectory,
    candidate.providerId,
    candidate.sourceId,
    definitionLoader,
    bazframeHome
  )) occupied.add(skill.name);
  const conflict = skills.find((skill) => (ownNames.get(skill.name) ?? 0) > 1 || occupied.has(skill.name));
  if (conflict !== undefined) throw new BazframeError('SOURCE_CANDIDATE_DUPLICATE', `Candidate source skill name conflicts with the prospective profile: ${conflict.name}`);
  return skills;
}

/** Returns every structurally/Pi-valid existing child before profile duplicate filtering. */
async function structurallyValidExistingSkills<T>(
  profileDirectory: string,
  excludedProviderId: string,
  excludedSourceId: string,
  loader: DefinitionLoader<T>,
  bazframeHome: string
): Promise<DerivedSkill<T>[]> {
  const namespace = await validateNamespace(join(profileDirectory, 'source-units'));
  const skills: DerivedSkill<T>[] = [];
  for (const path of namespace.descriptors) {
    if (path.providerId === excludedProviderId && path.sourceId === excludedSourceId) continue;
    try {
      const descriptor = await readSourceDescriptor(path.descriptorPath, path.providerId, path.sourceId);
      const direct: DirectSourceUnit = {
        ...descriptor,
        descriptorPath: path.descriptorPath,
        relativeDescriptorPath: path.relativeDescriptorPath,
        preparationState: descriptor.schemaVersion === 1 ? 'build-required' : 'ready',
        rebuildAvailability: await rebuildAvailability(descriptor.sourceRoot)
      };
      skills.push(...await resolveOneSource(direct, loader, bazframeHome));
    } catch {
      // Unrelated malformed, unbuilt, or otherwise failing sources do not block activation.
    }
  }
  return skills;
}

interface PhysicalIdentity {
  device: bigint;
  inode: bigint;
}

interface OpenDirectory {
  path: string;
  handle: FileHandle;
  identity: PhysicalIdentity;
}

async function validateNamespace(sourceUnitsRoot: string): Promise<{
  descriptors: NamespaceDescriptorPath[];
  diagnostics: SourceDiagnostic[];
}> {
  let rootMetadata;
  try {
    rootMetadata = await lstat(sourceUnitsRoot, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { descriptors: [], diagnostics: [] };
    return invalidNamespaceRoot();
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return invalidNamespaceRoot();

  let root: OpenDirectory | undefined;
  try {
    root = await openPhysicalDirectory(sourceUnitsRoot, identityOf(rootMetadata));
    const providerNames = await enumerateStableDirectory(root);
    const diagnostics: SourceDiagnostic[] = [];
    const validProviders: Array<{ id: string; identity: PhysicalIdentity }> = [];

    for (const providerName of providerNames) {
      const providerPath = join(sourceUnitsRoot, providerName);
      let metadata;
      try {
        metadata = await lstat(providerPath, { bigint: true });
      } catch {
        diagnostics.push(invalidDescriptor(
          isSafeSkillId(providerName) ? providerName : UNKNOWN_PROVIDER_ID,
          UNKNOWN_SOURCE_ID,
          providerName
        ));
        continue;
      }
      if (!isSafeSkillId(providerName) || metadata.isSymbolicLink() || !metadata.isDirectory()) {
        diagnostics.push(invalidDescriptor(
          isSafeSkillId(providerName) ? providerName : UNKNOWN_PROVIDER_ID,
          UNKNOWN_SOURCE_ID,
          providerName
        ));
        continue;
      }
      validProviders.push({ id: providerName, identity: identityOf(metadata) });
    }

    const descriptors: NamespaceDescriptorPath[] = [];
    const descriptorIdentities = new Map<string, PhysicalIdentity>();
    for (const provider of validProviders) {
      const providerPath = join(sourceUnitsRoot, provider.id);
      let openedProvider: OpenDirectory | undefined;
      try {
        openedProvider = await openPhysicalDirectory(providerPath, provider.identity);
        const childNames = await enumerateStableDirectory(openedProvider);
        for (const childName of childNames) {
          const childPath = join(providerPath, childName);
          const sourceId = sourceIdFromDescriptorName(childName);
          let metadata;
          try {
            metadata = await lstat(childPath, { bigint: true });
          } catch {
            diagnostics.push(invalidDescriptor(
              provider.id,
              sourceId ?? UNKNOWN_SOURCE_ID,
              `${provider.id}/${childName}`
            ));
            continue;
          }
          if (sourceId === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
            diagnostics.push(invalidDescriptor(
              provider.id,
              sourceId ?? UNKNOWN_SOURCE_ID,
              `${provider.id}/${childName}`
            ));
            continue;
          }
          descriptors.push({
            providerId: provider.id,
            sourceId,
            descriptorPath: childPath,
            relativeDescriptorPath: `${provider.id}/${childName}`
          });
          descriptorIdentities.set(childPath, identityOf(metadata));
        }
        await assertStableDirectory(openedProvider);
      } catch {
        diagnostics.push(invalidDescriptor(provider.id, UNKNOWN_SOURCE_ID, provider.id));
      } finally {
        await openedProvider?.handle.close().catch(() => undefined);
      }
    }

    for (const descriptor of descriptors) {
      try {
        const metadata = await lstat(descriptor.descriptorPath, { bigint: true });
        if (metadata.isSymbolicLink()
          || !metadata.isFile()
          || !sameIdentity(identityOf(metadata), descriptorIdentities.get(descriptor.descriptorPath))) {
          throw new Error('descriptor namespace entry changed');
        }
      } catch {
        diagnostics.push(invalidDescriptor(
          descriptor.providerId,
          descriptor.sourceId,
          descriptor.relativeDescriptorPath
        ));
      }
    }
    await assertStableDirectory(root);
    return { descriptors, diagnostics };
  } catch {
    return invalidNamespaceRoot();
  } finally {
    await root?.handle.close().catch(() => undefined);
  }
}

function invalidNamespaceRoot(): {
  descriptors: NamespaceDescriptorPath[];
  diagnostics: SourceDiagnostic[];
} {
  return {
    descriptors: [],
    diagnostics: [invalidDescriptor(UNKNOWN_PROVIDER_ID, UNKNOWN_SOURCE_ID, '.')]
  };
}

async function openPhysicalDirectory(
  path: string,
  expectedIdentity: PhysicalIdentity
): Promise<OpenDirectory> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isDirectory() || !sameIdentity(identityOf(metadata), expectedIdentity)) {
      throw new Error('directory identity changed');
    }
    const opened = { path, handle, identity: expectedIdentity };
    await assertStableDirectory(opened);
    return opened;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function enumerateStableDirectory(directory: OpenDirectory): Promise<string[]> {
  await assertStableDirectory(directory);
  const names = (await readdir(directory.path)).sort(compare);
  await assertStableDirectory(directory);
  return names;
}

async function assertStableDirectory(directory: OpenDirectory): Promise<void> {
  const [openedMetadata, pathMetadata] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directory.path, { bigint: true })
  ]);
  if (!openedMetadata.isDirectory()
    || pathMetadata.isSymbolicLink()
    || !pathMetadata.isDirectory()
    || !sameIdentity(identityOf(openedMetadata), directory.identity)
    || !sameIdentity(identityOf(pathMetadata), directory.identity)) {
    throw new Error('directory identity changed');
  }
}

function identityOf(metadata: { dev: bigint; ino: bigint }): PhysicalIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameIdentity(
  left: PhysicalIdentity | undefined,
  right: PhysicalIdentity | undefined
): boolean {
  return left !== undefined
    && right !== undefined
    && left.device === right.device
    && left.inode === right.inode;
}

async function resolveOneSource<T>(
  direct: DirectSourceUnit,
  loader: DefinitionLoader<T>,
  bazframeHome: string
): Promise<DerivedSkill<T>[]> {
  if (direct.schemaVersion === 1) fail(baseDiagnostic('build-required', direct, '.'));
  let root: string;
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

function sourceIdFromDescriptorName(name: string): string | undefined {
  if (!name.endsWith('.json')) return undefined;
  const sourceId = name.slice(0, -'.json'.length);
  return isSafeSkillId(sourceId) ? sourceId : undefined;
}

function invalidDescriptor(providerId: string, sourceId: string, path: string): SourceDiagnostic {
  return { category: 'invalid-descriptor', providerId, sourceId, path };
}

function baseDiagnostic(
  category: Extract<SourceDiagnostic['category'],
    'broken-root' | 'broken-snapshot' | 'build-required' | 'internal-symlink' | 'unsupported-entry' | 'mixed-root'
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
