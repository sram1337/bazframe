import { constants } from 'node:fs';
import { lstat, mkdir, open, readlink, realpath, readdir, symlink, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  captureProfileSkillReferenceIndex,
  sameProfileSkillReferenceIndex
} from '../profiles/profile-skill-reference-index.js';
import { withStateLock } from '../state/lock.js';
import { assertSafeSkillId, isSafeSkillId } from './skill-id.js';
import { readSkillDeclaredName } from './skill-metadata.js';
import { managedGitRecordForRoot } from '../providers/managed-git-record.js';

export const DEFAULT_SKILL_SOURCE_ID = 'default';
export const DEFAULT_SKILL_SOURCE_LABEL = '(default)';

export interface DefaultSkillRegistration {
  id: string;
  registrationPath: string;
  target: string;
}

export interface DefaultSkillRegistrationSnapshot extends DefaultSkillRegistration {
  catalogDevice: bigint;
  catalogInode: bigint;
  registrationDevice: bigint;
  registrationInode: bigint;
  targetDevice: bigint;
  targetInode: bigint;
}
export interface DefaultSkillRegistrationSnapshotOptions {
  /** Repair-oriented callers may validate only the registration target identity. */
  validateDeclaredName?: boolean;
  /** Internal close-failure seam used only by focused tests. */
  testHooks?: { afterClose?: () => void | Promise<void> };
}
export interface DefaultSkillCatalog {
  root: string;
  registrations: DefaultSkillRegistration[];
  skillIds: string[];
  diagnostics: string[];
}
export type DefaultSkillCatalogAction = 'added' | 'current' | 'removed' | 'absent';
export interface DefaultSkillCatalogResult extends DefaultSkillRegistration {
  action: DefaultSkillCatalogAction;
}

/** Deterministic namespace-substitution seam used only by lifecycle tests. */
export interface DefaultSkillCatalogTestHooks {
  beforeCommit?: () => void | Promise<void>;
  beforePublish?: () => void | Promise<void>;
  /** Internal seam for a managed-provider operation already holding the global state lock. */
  stateLockHeld?: boolean;
}

interface DirectoryIdentity { device: bigint; inode: bigint }
interface OpenDirectory { path: string; handle: FileHandle; identity: DirectoryIdentity }
interface RawRegistration { kind: 'link' | 'physical'; target: string; device: bigint; inode: bigint }

export function defaultSkillCatalogRoot(bazframeHome: string): string {
  return join(bazframeHome, 'skills');
}

export async function inspectDefaultSkillCatalog(bazframeHome: string): Promise<DefaultSkillCatalog> {
  const rootPath = defaultSkillCatalogRoot(bazframeHome);
  const root = await openCatalogRoot(bazframeHome, false);
  if (root === undefined) return { root: rootPath, registrations: [], skillIds: [], diagnostics: [] };
  try {
    const names = await enumerateDirectory(root);
    const registrations: DefaultSkillRegistration[] = [];
    const diagnostics: string[] = [];
    for (const name of names) {
      if (!isSafeSkillId(name)) {
        diagnostics.push(`Skipping unsafe default skill entry ${JSON.stringify(name)}.`);
        continue;
      }
      try {
        registrations.push(await readValidRegistrationFromRoot(bazframeHome, root, name));
      } catch (error) {
        diagnostics.push(`Skipping invalid default skill ${JSON.stringify(name)}: ${message(error)}`);
      }
    }
    await assertDirectoryStable(root);
    return { root: rootPath, registrations, skillIds: registrations.map((item) => item.id), diagnostics };
  } finally {
    await root.handle.close().catch(() => undefined);
  }
}

export async function readDefaultSkillRegistration(
  bazframeHome: string,
  skillId: string
): Promise<DefaultSkillRegistration> {
  assertSafeSkillId(skillId);
  const root = await openCatalogRoot(bazframeHome, false);
  if (root === undefined) throw notFound(skillId);
  try {
    return await readValidRegistrationFromRoot(bazframeHome, root, skillId);
  } finally {
    await root.handle.close().catch(() => undefined);
  }
}

export async function readDefaultSkillRegistrationSnapshot(
  bazframeHome: string,
  skillId: string,
  options: DefaultSkillRegistrationSnapshotOptions = {}
): Promise<DefaultSkillRegistrationSnapshot> {
  assertSafeSkillId(skillId);
  const root = await openCatalogRoot(bazframeHome, false);
  if (root === undefined) throw notFound(skillId);
  let result: DefaultSkillRegistrationSnapshot | undefined;
  let operationError: unknown;
  try {
    const registrationPath = join(root.path, skillId);
    const raw = await inspectRawRegistration(registrationPath);
    if (raw === undefined) throw notFound(skillId);
    if (raw.kind !== 'link' || !isAbsolute(raw.target)) {
      throw occupiedRegistration(registrationPath, raw);
    }
    let canonical: string;
    try { canonical = await realpath(raw.target); }
    catch (error) {
      throw new BazframeError(
        'DEFAULT_SKILL_BROKEN',
        `Default skill registration is broken: ${registrationPath} -> ${raw.target}${formatCode(error)}`,
        { cause: error }
      );
    }
    if (canonical !== raw.target) {
      throw new BazframeError(
        'DEFAULT_SKILL_TARGET_NOT_CANONICAL',
        `Default skill registration target must be canonical: ${registrationPath} -> ${raw.target}`
      );
    }
    const metadata = await lstat(canonical, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new BazframeError(
        'DEFAULT_SKILL_TARGET_NOT_PHYSICAL',
        `Default skill target must be a physical directory: ${canonical}`
      );
    }
    await assertAllowedSkillLocation(bazframeHome, canonical, skillId);
    if (basename(canonical) !== skillId) {
      throw new BazframeError(
        'DEFAULT_SKILL_NAME_MISMATCH',
        `Default skill target basename does not match ${JSON.stringify(skillId)}: ${canonical}`
      );
    }
    if (options.validateDeclaredName !== false) {
      const declared = await readSkillDeclaredName(canonical);
      if (declared !== skillId) {
        throw new BazframeError(
          'DEFAULT_SKILL_NAME_MISMATCH',
          `Default skill ${JSON.stringify(skillId)} declares name ${JSON.stringify(declared)}.`
        );
      }
    }
    const [currentRaw, currentCanonical, currentMetadata] = await Promise.all([
      inspectRawRegistration(registrationPath),
      realpath(raw.target),
      lstat(canonical, { bigint: true })
    ]);
    if (currentRaw?.kind !== 'link'
      || currentRaw.target !== raw.target
      || currentRaw.device !== raw.device
      || currentRaw.inode !== raw.inode
      || currentCanonical !== canonical
      || currentMetadata.isSymbolicLink()
      || !currentMetadata.isDirectory()
      || currentMetadata.dev !== metadata.dev
      || currentMetadata.ino !== metadata.ino) {
      throw new BazframeError(
        'DEFAULT_SKILL_CHANGED',
        `Default skill registration changed while reading: ${registrationPath}`
      );
    }
    await assertDirectoryStable(root);
    result = {
      id: skillId,
      registrationPath,
      target: canonical,
      catalogDevice: root.identity.device,
      catalogInode: root.identity.inode,
      registrationDevice: raw.device,
      registrationInode: raw.inode,
      targetDevice: metadata.dev,
      targetInode: metadata.ino
    };
  } catch (error) { operationError = error; }
  try {
    await root.handle.close();
    await options.testHooks?.afterClose?.();
  } catch (error) {
    operationError ??= new BazframeError('DEFAULT_SKILL_CATALOG_READ_FAILED', `Could not close default skill catalog: ${root.path}${formatCode(error)}`, { cause: error });
  }
  if (operationError !== undefined) throw operationError;
  if (result === undefined) throw new BazframeError('DEFAULT_SKILL_CATALOG_READ_FAILED', `Could not read default skill registration: ${skillId}`);
  return result;
}

export function sameDefaultSkillRegistrationSnapshot(
  left: DefaultSkillRegistrationSnapshot,
  right: DefaultSkillRegistrationSnapshot
): boolean {
  return left.id === right.id
    && left.registrationPath === right.registrationPath
    && left.target === right.target
    && left.catalogDevice === right.catalogDevice
    && left.catalogInode === right.catalogInode
    && left.registrationDevice === right.registrationDevice
    && left.registrationInode === right.registrationInode
    && left.targetDevice === right.targetDevice
    && left.targetInode === right.targetInode;
}

export async function readDefaultSkillRegistrationLink(
  bazframeHome: string,
  skillId: string
): Promise<DefaultSkillRegistration> {
  assertSafeSkillId(skillId);
  const root = await openCatalogRoot(bazframeHome, false);
  if (root === undefined) throw notFound(skillId);
  try {
    const registrationPath = join(root.path, skillId);
    const raw = await inspectRawRegistration(registrationPath);
    if (raw === undefined) throw notFound(skillId);
    if (raw.kind !== 'link' || !isAbsolute(raw.target)) throw occupiedRegistration(registrationPath, raw);
    await assertDirectoryStable(root);
    return { id: skillId, registrationPath, target: raw.target };
  } finally {
    await root.handle.close().catch(() => undefined);
  }
}

export async function addDefaultSkill(
  bazframeHome: string,
  enteredRoot: string,
  testHooks: DefaultSkillCatalogTestHooks = {}
): Promise<DefaultSkillCatalogResult> {
  if (!isAbsolute(enteredRoot) || enteredRoot.length === 0 || enteredRoot.includes('\0')) {
    throw new BazframeError('INVALID_SKILL_ROOT', 'Skill root must be a non-empty absolute path without NUL bytes.');
  }
  let target: string;
  try { target = await realpath(enteredRoot); }
  catch (error) { throw new BazframeError('SKILL_ROOT_READ_FAILED', `Could not resolve skill root: ${enteredRoot}${formatCode(error)}`, { cause: error }); }
  const metadata = await lstat(target).catch((error: unknown) => {
    throw new BazframeError('SKILL_ROOT_READ_FAILED', `Could not inspect skill root: ${target}${formatCode(error)}`, { cause: error });
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError('SKILL_ROOT_NOT_PHYSICAL', `Skill root must resolve to a physical directory: ${target}`);
  }
  const id = basename(target);
  await assertAllowedSkillLocation(bazframeHome, target, id);
  assertSafeSkillId(id);
  const declared = await readSkillDeclaredName(target);
  if (declared !== id) {
    throw new BazframeError('SKILL_NAME_MISMATCH', `Skill root ${target} declares name ${JSON.stringify(declared)} instead of canonical basename ${JSON.stringify(id)}.`);
  }
  const registrationPath = join(defaultSkillCatalogRoot(bazframeHome), id);
  return withCatalogLock(
    bazframeHome,
    'bazframe skill add',
    registrationPath,
    testHooks.stateLockHeld === true,
    async () => {
      await ensureCatalogRoot(bazframeHome);
      const root = await openCatalogRoot(bazframeHome, true);
      if (root === undefined) throw invalidCatalog(defaultSkillCatalogRoot(bazframeHome));
      try {
        const existing = await inspectRawRegistration(registrationPath);
        if (existing !== undefined) {
          if (existing.kind === 'link' && existing.target === target) {
            await readValidRegistrationFromRoot(bazframeHome, root, id);
            return { action: 'current', id, registrationPath, target };
          }
          throw occupiedRegistration(registrationPath, existing);
        }
        await assertExternalSkillTarget(bazframeHome, target, id);
        await testHooks.beforeCommit?.();
        await assertDirectoryStable(root);
        await assertExternalSkillTarget(bazframeHome, target, id);
        const occupied = await inspectRawRegistration(registrationPath);
        if (occupied !== undefined) throw occupiedRegistration(registrationPath, occupied);
        await testHooks.beforePublish?.();
        await assertDirectoryStable(root);
        try { await symlink(target, registrationPath, 'dir'); }
        catch (error) {
          if (errorCode(error) === 'EEXIST') throw occupiedRegistration(registrationPath, await inspectRawRegistration(registrationPath));
          throw new BazframeError('DEFAULT_SKILL_ADD_FAILED', `Could not register default skill: ${registrationPath}${formatCode(error)}`, { cause: error });
        }
        await assertDirectoryStable(root);
        return { action: 'added', id, registrationPath, target };
      } finally {
        await root.handle.close().catch(() => undefined);
      }
    }
  );
}

export async function removeDefaultSkill(
  bazframeHome: string,
  skillId: string,
  testHooks: DefaultSkillCatalogTestHooks = {}
): Promise<DefaultSkillCatalogResult> {
  assertSafeSkillId(skillId);
  const registrationPath = join(defaultSkillCatalogRoot(bazframeHome), skillId);
  return withCatalogLock(
    bazframeHome,
    'bazframe skill remove',
    registrationPath,
    testHooks.stateLockHeld === true,
    async () => {
      const root = await openCatalogRoot(bazframeHome, false);
      if (root === undefined) return { action: 'absent', id: skillId, registrationPath, target: '' };
      try {
        const before = await inspectRawRegistration(registrationPath);
        if (before === undefined) return { action: 'absent', id: skillId, registrationPath, target: '' };
        if (before.kind !== 'link' || !isAbsolute(before.target)) throw occupiedRegistration(registrationPath, before);
        const index = await captureProfileSkillReferenceIndex(bazframeHome, skillId, before.target);
        if (index.diagnostics.length > 0) {
          throw new BazframeError('DEFAULT_SKILL_REFERENCE_INDEX_INVALID', `Refusing to remove ${JSON.stringify(skillId)} because profile skill references could not be verified.`);
        }
        if (index.profileIds.length > 0) {
          throw new BazframeError('DEFAULT_SKILL_REFERENCED', `Refusing to remove ${JSON.stringify(skillId)} because it is referenced by profiles: ${index.profileIds.join(', ')}.`);
        }
        await testHooks.beforeCommit?.();
        await assertDirectoryStable(root);
        const [current, currentIndex] = await Promise.all([
          inspectRawRegistration(registrationPath),
          captureProfileSkillReferenceIndex(bazframeHome, skillId, before.target)
        ]);
        await assertDirectoryStable(root);
        if (current?.kind !== 'link' || current.target !== before.target
          || current.device !== before.device || current.inode !== before.inode
          || currentIndex.diagnostics.length > 0 || !sameProfileSkillReferenceIndex(index, currentIndex)) {
          throw new BazframeError('DEFAULT_SKILL_CHANGED', `Refusing to remove changed default skill registration: ${registrationPath}`);
        }
        try { await unlink(registrationPath); }
        catch (error) {
          if (errorCode(error) === 'ENOENT') return { action: 'absent', id: skillId, registrationPath, target: before.target };
          throw new BazframeError('DEFAULT_SKILL_REMOVE_FAILED', `Could not remove default skill registration: ${registrationPath}${formatCode(error)}`, { cause: error });
        }
        await assertDirectoryStable(root);
        return { action: 'removed', id: skillId, registrationPath, target: before.target };
      } finally {
        await root.handle.close().catch(() => undefined);
      }
    }
  );
}

function withCatalogLock<T>(
  bazframeHome: string,
  command: string,
  target: string,
  stateLockHeld: boolean,
  operation: () => Promise<T>
): Promise<T> {
  return stateLockHeld
    ? operation()
    : withStateLock(
        join(bazframeHome, 'locks', 'state.lock'),
        { command, target },
        operation,
        { managedRoot: bazframeHome }
      );
}

async function inspectRawRegistration(path: string): Promise<RawRegistration | undefined> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isSymbolicLink()) return { kind: 'physical', target: '', device: metadata.dev, inode: metadata.ino };
    return { kind: 'link', target: await readlink(path), device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new BazframeError('DEFAULT_SKILL_READ_FAILED', `Could not inspect default skill registration: ${path}${formatCode(error)}`, { cause: error });
  }
}

async function readValidRegistrationFromRoot(
  bazframeHome: string,
  root: OpenDirectory,
  id: string
): Promise<DefaultSkillRegistration> {
  const registrationPath = join(root.path, id);
  const raw = await inspectRawRegistration(registrationPath);
  if (raw === undefined) throw notFound(id);
  if (raw.kind !== 'link' || !isAbsolute(raw.target)) throw occupiedRegistration(registrationPath, raw);
  let canonical: string;
  try { canonical = await realpath(raw.target); }
  catch (error) { throw new BazframeError('DEFAULT_SKILL_BROKEN', `Default skill registration is broken: ${registrationPath} -> ${raw.target}${formatCode(error)}`, { cause: error }); }
  if (canonical !== raw.target) throw new BazframeError('DEFAULT_SKILL_TARGET_NOT_CANONICAL', `Default skill registration target must be canonical: ${registrationPath} -> ${raw.target}`);
  const metadata = await lstat(canonical);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('DEFAULT_SKILL_TARGET_NOT_PHYSICAL', `Default skill target must be a physical directory: ${canonical}`);
  await assertAllowedSkillLocation(bazframeHome, canonical, id);
  if (basename(canonical) !== id) throw new BazframeError('DEFAULT_SKILL_NAME_MISMATCH', `Default skill target basename does not match ${JSON.stringify(id)}: ${canonical}`);
  const declared = await readSkillDeclaredName(canonical);
  if (declared !== id) throw new BazframeError('DEFAULT_SKILL_NAME_MISMATCH', `Default skill ${JSON.stringify(id)} declares name ${JSON.stringify(declared)}.`);
  await assertDirectoryStable(root);
  return { id, registrationPath, target: canonical };
}

async function assertExternalSkillTarget(home: string, target: string, id: string): Promise<void> {
  const canonical = await realpath(target);
  if (canonical !== target) throw new BazframeError('DEFAULT_SKILL_TARGET_NOT_CANONICAL', `Default skill target must be canonical: ${target}`);
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('DEFAULT_SKILL_TARGET_NOT_PHYSICAL', `Default skill target must be a physical directory: ${target}`);
  await assertAllowedSkillLocation(home, target, id);
  if (basename(target) !== id || await readSkillDeclaredName(target) !== id) throw new BazframeError('DEFAULT_SKILL_NAME_MISMATCH', `Default skill target identity changed: ${target}`);
}

async function ensureCatalogRoot(home: string): Promise<void> {
  const root = defaultSkillCatalogRoot(home);
  try { await mkdir(root); }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalidCatalog(root);
}

async function openCatalogRoot(home: string, required: boolean): Promise<OpenDirectory | undefined> {
  const path = defaultSkillCatalogRoot(home);
  let metadata;
  try { metadata = await lstat(path, { bigint: true }); }
  catch (error) {
    if (!required && errorCode(error) === 'ENOENT') return undefined;
    throw new BazframeError('DEFAULT_SKILL_CATALOG_READ_FAILED', `Could not inspect default skill catalog: ${path}${formatCode(error)}`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalidCatalog(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    const directory = { path, handle, identity: identity(metadata) };
    if (!opened.isDirectory() || !sameIdentity(identity(opened), directory.identity)) throw invalidCatalog(path);
    await assertDirectoryStable(directory);
    return directory;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof BazframeError) throw error;
    throw new BazframeError('DEFAULT_SKILL_CATALOG_INVALID', `Default skill catalog must remain a stable physical directory: ${path}${formatCode(error)}`, { cause: error });
  }
}

async function enumerateDirectory(directory: OpenDirectory): Promise<string[]> {
  await assertDirectoryStable(directory);
  const names = (await readdir(directory.path)).sort(compare);
  await assertDirectoryStable(directory);
  return names;
}

async function assertDirectoryStable(directory: OpenDirectory): Promise<void> {
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }), lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || !sameIdentity(identity(opened), directory.identity) || !sameIdentity(identity(current), directory.identity)) {
    throw new BazframeError('DEFAULT_SKILL_CATALOG_CHANGED', `Default skill catalog changed while in use: ${directory.path}`);
  }
}

function identity(metadata: { dev: bigint; ino: bigint }): DirectoryIdentity { return { device: metadata.dev, inode: metadata.ino }; }
function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.device === right.device && left.inode === right.inode; }
function invalidCatalog(path: string): BazframeError { return new BazframeError('DEFAULT_SKILL_CATALOG_INVALID', `Default skill catalog must be a physical directory: ${path}`); }
function notFound(skillId: string): BazframeError { return new BazframeError('DEFAULT_SKILL_NOT_FOUND', `Default skill ${JSON.stringify(skillId)} is not registered. Run \`bazframe skill add <absolute-root>\`.`); }
function occupiedRegistration(path: string, raw: RawRegistration | undefined): BazframeError {
  const detail = raw?.kind === 'link' ? `targets ${JSON.stringify(raw.target)}` : 'is a physical or unreadable entry';
  return new BazframeError('DEFAULT_SKILL_OCCUPIED', `Default skill registration is occupied: ${path} ${detail}.`);
}
async function assertAllowedSkillLocation(home: string, target: string, id: string): Promise<void> {
  const canonicalHome = await canonicalExistingPath(home);
  if (!isWithin(canonicalHome, target) && !isWithin(target, canonicalHome)) return;
  const managed = await managedGitRecordForRoot(home, 'skill', target);
  if (managed?.id === id) return;
  throw new BazframeError('DEFAULT_SKILL_TARGET_OVERLAPS_BAZFRAME_HOME', `Default skill target and BAZFRAME_HOME must not overlap: ${target}`);
}

async function canonicalExistingPath(path: string): Promise<string> {
  const missing: string[] = [];
  let cursor = resolve(path);
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}
function isWithin(home: string, target: string): boolean { const path = relative(home, target); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function suggestSkillIds(requested: string, candidates: readonly string[], limit = 3): string[] {
  const maximumDistance = requested.length <= 4 ? 1 : requested.length <= 8 ? 2 : 3;
  return candidates
    .map((candidate) => ({ candidate, distance: editDistance(requested, candidate) }))
    .filter(({ distance }) => distance <= maximumDistance)
    .sort((left, right) => left.distance - right.distance || compare(left.candidate, right.candidate))
    .slice(0, limit)
    .map((candidate) => candidate.candidate);
}
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious: number[] | undefined;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      let distance = Math.min((previous[rightIndex] ?? 0) + 1, (current[rightIndex - 1] ?? 0) + 1, substitution);
      if (beforePrevious !== undefined && leftIndex > 1 && rightIndex > 1
        && left[leftIndex - 1] === right[rightIndex - 2]
        && left[leftIndex - 2] === right[rightIndex - 1]) {
        distance = Math.min(distance, (beforePrevious[rightIndex - 2] ?? 0) + 1);
      }
      current.push(distance);
    }
    beforePrevious = previous.slice();
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? left.length;
}
