import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  rename as nativeRename,
  rmdir,
  symlink,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isUint8Array } from 'node:util/types';
import { decodeUtf8Instructions, MAX_EFFECTIVE_INSTRUCTION_BYTES } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { boundedPathForDisplay } from '../core/safe-text.js';
import {
  encodeProfileCollectionReference,
  type ProfileSkillCollectionReference
} from '../profiles/profile-skill-collection-reference.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { profileDirectory } from '../profiles/profile-store.js';
import { managedGitCheckoutRoot } from '../providers/managed-git-record.js';
import { assertSafeSkillId } from '../skills/skill-id.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type ProfileImportPublicationCommitState = 'not-published' | 'published' | 'commit-ambiguous';
/** `discarded` only means the owned staging tree was removed; it makes no destination-profile claim. */
export type ProfileImportPublicationAction = 'published' | 'discarded';

export interface ProfileImportPublicationSkillTarget {
  id: string;
  target: string;
  device: bigint;
  inode: bigint;
}

export interface ProfileImportPublicationOptions {
  bazframeHome: string;
  destinationProfileId: string;
  instructionBytes: Uint8Array;
  skills: readonly ProfileImportPublicationSkillTarget[];
  libraryIds: readonly string[];
  packageIds?: readonly string[];
  commit: (publish: () => Promise<void>) => Promise<ProfileImportPublicationAction>;
}

export interface ProfileImportPublicationResult {
  action: ProfileImportPublicationAction;
  destinationPath: string;
  identity?: { path: string; device: bigint; inode: bigint };
}

export class ProfileImportPublicationError extends BazframeError {
  readonly commitState: ProfileImportPublicationCommitState;
  readonly destinationPath: string;
  readonly stagingPath: string;

  constructor(
    commitState: ProfileImportPublicationCommitState,
    destinationPath: string,
    stagingPath: string,
    cause: unknown
  ) {
    super(
      'PROFILE_IMPORT_PUBLICATION_FAILED',
      `Could not publish imported profile at ${boundedPathForDisplay(destinationPath)} `
        + `(${commitState}; staging: ${boundedPathForDisplay(stagingPath)}).`,
      { cause }
    );
    this.name = 'ProfileImportPublicationError';
    this.commitState = commitState;
    this.destinationPath = destinationPath;
    this.stagingPath = stagingPath;
  }
}

export interface ProfileImportPublicationTestHooks {
  atPhase?: (phase:
    | 'after-staging-created'
    | 'after-tree-written'
    | 'before-final-validation'
    | 'after-rename-attempt'
  ) => void | Promise<void>;
  rename?: (stagingPath: string, destinationPath: string) => Promise<void>;
  beforeCleanupEntry?: (path: string) => void | Promise<void>;
}

interface DirectoryIdentity { path: string; device: bigint; inode: bigint }
interface HeldDirectory extends DirectoryIdentity { handle: FileHandle; closed: boolean }
interface FileIdentity { path: string; device: bigint; inode: bigint; size: bigint; bytes: Uint8Array }
interface LinkIdentity { path: string; device: bigint; inode: bigint; target: string; targetDevice: bigint; targetInode: bigint }
interface PreparedSkill extends ProfileImportPublicationSkillTarget { linkPath: string }
interface PreparedPublication {
  home: string;
  profilesRoot: string;
  destinationProfileId: string;
  destinationPath: string;
  stagingPath: string;
  instructionBytes: Uint8Array;
  skills: PreparedSkill[];
  libraryIds: string[];
  packageIds: string[];
  commit: ProfileImportPublicationOptions['commit'];
}
interface CreatedTree {
  staging?: HeldDirectory;
  skills?: HeldDirectory;
  libraries?: HeldDirectory;
  packages?: HeldDirectory;
  instructions?: FileIdentity;
  links: LinkIdentity[];
  references: FileIdentity[];
}

type PublicationProbe = 'not-published' | 'published' | 'commit-ambiguous';

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsicTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength'
)?.get as (this: Uint8Array) => number;
const intrinsicTypedArraySet = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'set'
)?.value as (this: Uint8Array, source: Uint8Array, offset?: number) => void;

export async function publishImportedProfile(
  options: ProfileImportPublicationOptions,
  hooks: ProfileImportPublicationTestHooks = {}
): Promise<ProfileImportPublicationResult> {
  const prepared = prepare(options);
  return await publishPrepared(prepared, hooks);
}

function prepare(options: ProfileImportPublicationOptions): PreparedPublication {
  if (options === null || typeof options !== 'object') throw new TypeError('Profile import publication options are required.');
  if (typeof options.bazframeHome !== 'string' || options.bazframeHome.length === 0 || options.bazframeHome.includes('\0')) {
    throw new BazframeError('PROFILE_IMPORT_PUBLICATION_INVALID', 'Bazframe home must be a non-empty path without NUL bytes.');
  }
  if (typeof options.commit !== 'function') throw new BazframeError('PROFILE_IMPORT_PUBLICATION_INVALID', 'A commit callback is required.');
  if (!Array.isArray(options.skills) || !Array.isArray(options.libraryIds)
    || (options.packageIds !== undefined && !Array.isArray(options.packageIds))) {
    throw new BazframeError('PROFILE_IMPORT_PUBLICATION_INVALID', 'Skill targets, library IDs, and package IDs must be arrays.');
  }
  assertSafeProfileId(options.destinationProfileId);
  const home = resolve(options.bazframeHome);
  const profilesRoot = join(home, 'profiles');
  const destinationPath = profileDirectory(home, options.destinationProfileId);
  const stagingPath = join(profilesRoot, `.${options.destinationProfileId}.${process.pid}.${randomUUID()}.import.tmp`);
  const instructionBytes = copyBytes(options.instructionBytes);
  decodeUtf8Instructions(instructionBytes, 'Imported profile instructions', join(stagingPath, 'AGENTS.md'));

  const skills = options.skills.map((entered): PreparedSkill => {
    if (entered === null || typeof entered !== 'object') throw invalid('Skill target is invalid');
    assertSafeSkillId(entered.id);
    if (typeof entered.target !== 'string' || entered.target.length === 0 || entered.target.includes('\0')
      || resolve(entered.target) !== entered.target || basename(entered.target) !== entered.id
      || entered.target !== managedGitCheckoutRoot(home, 'skill', entered.id)
      || typeof entered.device !== 'bigint' || typeof entered.inode !== 'bigint') {
      throw invalid(`Skill target is invalid for ${entered.id}`);
    }
    return {
      id: entered.id,
      target: entered.target,
      device: entered.device,
      inode: entered.inode,
      linkPath: join(stagingPath, 'skills', entered.id)
    };
  });
  assertSortedUnique(skills.map((skill) => skill.id), 'Skill IDs');
  const libraryIds = [...options.libraryIds];
  for (const id of libraryIds) assertSafeSkillId(id);
  assertSortedUnique(libraryIds, 'library IDs');
  const packageIds = [...(options.packageIds ?? [])];
  for (const id of packageIds) assertSafeSkillId(id);
  assertSortedUnique(packageIds, 'package IDs');
  return {
    home,
    profilesRoot,
    destinationProfileId: options.destinationProfileId,
    destinationPath,
    stagingPath,
    instructionBytes,
    skills,
    libraryIds,
    packageIds,
    commit: options.commit
  };
}

async function publishPrepared(
  prepared: PreparedPublication,
  hooks: ProfileImportPublicationTestHooks
): Promise<ProfileImportPublicationResult> {
  if (process.platform === 'win32') {
    throw new ProfileImportPublicationError(
      'not-published', prepared.destinationPath, prepared.stagingPath,
      new Error('Windows imported-profile publication guarantees have not been validated')
    );
  }
  const tree: CreatedTree = { links: [], references: [] };
  let parent: HeldDirectory | undefined;
  let primaryError: unknown;
  let action: ProfileImportPublicationAction | undefined;
  let publishCalls = 0;
  let publishPromise: Promise<void> | undefined;
  let commitOpen = true;
  let stagingCleaned = false;
  try {
    const canonicalHome = await realpath(prepared.home);
    if (canonicalHome !== prepared.home) throw invalid('Bazframe home must be canonical');
    await assertPhysicalDirectory(prepared.home, 'Bazframe home');
    const canonicalProfiles = await realpath(prepared.profilesRoot);
    if (canonicalProfiles !== prepared.profilesRoot) throw invalid('Profiles parent must be canonical');
    parent = await holdDirectory(prepared.profilesRoot, 'Profiles parent');
    await assertAbsent(prepared.destinationPath, 'Imported profile destination is occupied');
    await assertAbsent(prepared.stagingPath, 'Imported profile staging path is occupied');
    for (const skill of prepared.skills) await assertTarget(skill);

    await mkdir(prepared.stagingPath, { mode: DIRECTORY_MODE });
    tree.staging = await holdDirectory(prepared.stagingPath, 'Imported profile staging');
    await hooks.atPhase?.('after-staging-created');

    const skillsPath = join(prepared.stagingPath, 'skills');
    await mkdir(skillsPath, { mode: DIRECTORY_MODE });
    tree.skills = await holdDirectory(skillsPath, 'Imported profile skills');
    tree.instructions = await createFile(join(prepared.stagingPath, 'AGENTS.md'), prepared.instructionBytes);
    for (const skill of prepared.skills) {
      await symlink(skill.target, skill.linkPath);
      const metadata = await lstat(skill.linkPath, { bigint: true });
      if (!metadata.isSymbolicLink()) throw invalid(`Skill membership is not a link: ${skill.linkPath}`);
      tree.links.push({
        path: skill.linkPath,
        device: metadata.dev,
        inode: metadata.ino,
        target: skill.target,
        targetDevice: skill.device,
        targetInode: skill.inode
      });
    }
    if (prepared.libraryIds.length > 0) {
      const librariesPath = join(prepared.stagingPath, 'libraries');
      await mkdir(librariesPath, { mode: DIRECTORY_MODE });
      tree.libraries = await holdDirectory(librariesPath, 'Imported profile libraries');
      for (const id of prepared.libraryIds) {
        const reference: ProfileSkillCollectionReference = { schemaVersion: 1, library: id };
        tree.references.push(await createFile(
          join(librariesPath, `${id}.json`),
          Buffer.from(encodeProfileCollectionReference(reference), 'utf8')
        ));
      }
    }
    if (prepared.packageIds.length > 0) {
      const packagesPath = join(prepared.stagingPath, 'packages');
      await mkdir(packagesPath, { mode: DIRECTORY_MODE });
      tree.packages = await holdDirectory(packagesPath, 'Imported profile packages');
      for (const id of prepared.packageIds) {
        const reference: ProfileSkillCollectionReference = { schemaVersion: 1, package: id };
        tree.references.push(await createFile(
          join(packagesPath, `${id}.json`),
          Buffer.from(encodeProfileCollectionReference(reference), 'utf8')
        ));
      }
    }
    await syncDirectory(tree.skills);
    if (tree.libraries !== undefined) await syncDirectory(tree.libraries);
    if (tree.packages !== undefined) await syncDirectory(tree.packages);
    await syncDirectory(tree.staging);
    await hooks.atPhase?.('after-tree-written');
    await validateTree(prepared, parent, tree, prepared.stagingPath);

    const publish = (): Promise<void> => {
      if (!commitOpen) return Promise.reject(invalid('Commit callback invoked profile publication after returning'));
      publishCalls += 1;
      if (publishCalls !== 1) return Promise.reject(invalid('Commit callback invoked profile publication more than once'));
      publishPromise = performPublication(prepared, parent!, tree, hooks);
      return publishPromise;
    };

    let commitError: unknown;
    try { action = await prepared.commit(publish); }
    catch (error) { commitError = error; }
    finally { commitOpen = false; }
    let publishError: unknown;
    if (publishPromise !== undefined) {
      try { await publishPromise; }
      catch (error) { publishError = error; }
    }
    if (commitError !== undefined || publishError !== undefined) {
      throw combine(commitError, publishError);
    }
    if (action !== 'published' && action !== 'discarded') throw invalid('Commit callback returned an invalid action');
    if ((action === 'published' && publishCalls !== 1) || (action === 'discarded' && publishCalls !== 0)) {
      throw invalid('Commit callback action does not match its publication call');
    }
    if (action === 'published') {
      const state = await probePublication(prepared, tree.staging);
      if (state !== 'published') throw invalid('Published profile identity could not be proven');
      await validateTree(prepared, parent, tree, prepared.destinationPath);
      await assertDirectoryIdentity(parent, 'Profiles parent changed before publication completed');
      if (await probePublication(prepared, tree.staging) !== 'published') {
        throw invalid('Published profile identity changed before publication completed');
      }
      await closeTree(tree);
      await closeDirectory(parent);
      return {
        action,
        destinationPath: prepared.destinationPath,
        identity: {
          path: prepared.destinationPath,
          device: tree.staging.device,
          inode: tree.staging.inode
        }
      };
    }
    await closeTree(tree);
    await cleanupOwnedTree(prepared, parent, tree, hooks);
    stagingCleaned = true;
    await assertDirectoryIdentity(parent, 'Profiles parent changed after staging cleanup');
    await closeDirectory(parent);
    return { action, destinationPath: prepared.destinationPath };
  } catch (error) {
    primaryError = error;
  }

  commitOpen = false;
  if (publishPromise !== undefined) {
    await publishPromise.catch((error) => { primaryError = combine(primaryError, error); });
  }
  let commitState = tree.staging === undefined || stagingCleaned
    ? 'not-published'
    : await probePublication(prepared, tree.staging).catch(() => 'commit-ambiguous' as const);
  let cleanupError: unknown;
  await closeTree(tree).catch((error) => { cleanupError = error; });
  if (commitState === 'not-published' && !stagingCleaned && tree.staging !== undefined && parent !== undefined) {
    try {
      await cleanupOwnedTree(prepared, parent, tree, hooks);
      stagingCleaned = true;
    } catch (error) {
      cleanupError = combine(cleanupError, error);
      commitState = await probePublication(prepared, tree.staging).catch(() => 'commit-ambiguous' as const);
    }
  }
  if (parent !== undefined) await closeDirectory(parent).catch((error) => { cleanupError = combine(cleanupError, error); });
  throw new ProfileImportPublicationError(
    commitState,
    prepared.destinationPath,
    prepared.stagingPath,
    cleanupError === undefined ? primaryError : new AggregateError([primaryError, cleanupError], 'Profile import publication and cleanup failed')
  );
}

async function performPublication(
  prepared: PreparedPublication,
  parent: HeldDirectory,
  tree: CreatedTree,
  hooks: ProfileImportPublicationTestHooks
): Promise<void> {
  await hooks.atPhase?.('before-final-validation');
  await validateTree(prepared, parent, tree, prepared.stagingPath);
  await assertAbsent(prepared.destinationPath, 'Imported profile destination became occupied');
  let renameError: unknown;
  try { await (hooks.rename ?? nativeRename)(prepared.stagingPath, prepared.destinationPath); }
  catch (error) { renameError = error; }
  try { await hooks.atPhase?.('after-rename-attempt'); }
  catch (error) { renameError = combine(renameError, error); }
  const state = await probePublication(prepared, tree.staging!);
  if (state !== 'published') throw renameError ?? invalid('Final rename did not publish the owned staging directory');
  await validateTree(prepared, parent, tree, prepared.destinationPath);
  if (renameError !== undefined) throw renameError;
  await syncDirectory(parent);
  await assertDirectoryIdentity(parent, 'Profiles parent changed after publication');
}

function copyBytes(value: Uint8Array): Uint8Array {
  if (!isUint8Array(value)) throw invalid('Instruction bytes must be a Uint8Array');
  const byteLength = Reflect.apply(intrinsicTypedArrayByteLength, value, []);
  if (byteLength > MAX_EFFECTIVE_INSTRUCTION_BYTES) throw invalid('Instruction bytes exceed the supported limit');
  const copy = new Uint8Array(byteLength);
  Reflect.apply(intrinsicTypedArraySet, copy, [value, 0]);
  return copy;
}

async function createFile(path: string, bytes: Uint8Array): Promise<FileIdentity> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
    await handle.chmod(FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size !== BigInt(bytes.byteLength)) throw invalid(`Created file is invalid: ${path}`);
    const result = { path, device: metadata.dev, inode: metadata.ino, size: metadata.size, bytes: Uint8Array.from(bytes) };
    await handle.close();
    handle = undefined;
    return result;
  } finally { await handle?.close().catch(() => undefined); }
}

async function holdDirectory(path: string, label: string): Promise<HeldDirectory> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalid(`${label} must be a physical directory`);
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) throw invalid(`${label} changed while opening`);
    return { path, handle, device: opened.dev, inode: opened.ino, closed: false };
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}

async function assertPhysicalDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(path) !== path) throw invalid(`${label} must be a canonical physical directory`);
}

async function assertDirectoryIdentity(directory: DirectoryIdentity, detail: string): Promise<void> {
  const metadata = await lstat(directory.path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.dev !== directory.device || metadata.ino !== directory.inode) throw invalid(detail);
  if ('handle' in directory && !(directory as HeldDirectory).closed) {
    const opened = await (directory as HeldDirectory).handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== directory.device || opened.ino !== directory.inode) throw invalid(detail);
  }
}

async function assertTarget(skill: ProfileImportPublicationSkillTarget): Promise<void> {
  const canonical = await realpath(skill.target);
  const metadata = await lstat(skill.target, { bigint: true });
  if (canonical !== skill.target || metadata.isSymbolicLink() || !metadata.isDirectory()
    || metadata.dev !== skill.device || metadata.ino !== skill.inode) {
    throw invalid(`Skill target changed: ${skill.target}`);
  }
}

async function validateTree(
  prepared: PreparedPublication,
  parent: HeldDirectory,
  tree: CreatedTree,
  rootPath: string
): Promise<void> {
  if (tree.staging === undefined || tree.skills === undefined || tree.instructions === undefined) throw invalid('Imported profile staging is incomplete');
  const skillsPath = join(rootPath, 'skills');
  const librariesPath = join(rootPath, 'libraries');
  const packagesPath = join(rootPath, 'packages');
  await assertDirectoryIdentity(parent, 'Profiles parent changed during publication');
  await assertDirectoryIdentity({ ...tree.staging, path: rootPath }, 'Imported profile staging changed');
  await assertDirectoryIdentity({ ...tree.skills, path: skillsPath }, 'Imported profile skills directory changed');
  if (tree.libraries !== undefined) {
    await assertDirectoryIdentity({ ...tree.libraries, path: librariesPath }, 'Imported profile libraries directory changed');
  }
  if (tree.packages !== undefined) {
    await assertDirectoryIdentity({ ...tree.packages, path: packagesPath }, 'Imported profile packages directory changed');
  }
  await assertMode(rootPath, DIRECTORY_MODE);
  await assertMode(skillsPath, DIRECTORY_MODE);
  if (tree.libraries !== undefined) await assertMode(librariesPath, DIRECTORY_MODE);
  if (tree.packages !== undefined) await assertMode(packagesPath, DIRECTORY_MODE);
  const rootNames = [
    'AGENTS.md', 'skills',
    ...(tree.libraries === undefined ? [] : ['libraries']),
    ...(tree.packages === undefined ? [] : ['packages'])
  ].sort(compare);
  await assertExactNames(rootPath, rootNames);
  await assertExactNames(skillsPath, prepared.skills.map((skill) => skill.id));
  if (tree.libraries !== undefined) await assertExactNames(librariesPath, prepared.libraryIds.map((id) => `${id}.json`));
  if (tree.packages !== undefined) await assertExactNames(packagesPath, prepared.packageIds.map((id) => `${id}.json`));
  await assertFile({ ...tree.instructions, path: join(rootPath, 'AGENTS.md') });
  for (const [index, reference] of tree.references.entries()) {
    if (index < prepared.libraryIds.length) {
      await assertFile({ ...reference, path: join(librariesPath, `${prepared.libraryIds[index]!}.json`) });
    } else {
      await assertFile({ ...reference, path: join(packagesPath, `${prepared.packageIds[index - prepared.libraryIds.length]!}.json`) });
    }
  }
  if (tree.links.length !== prepared.skills.length
    || tree.references.length !== prepared.libraryIds.length + prepared.packageIds.length) {
    throw invalid('Imported profile staging entries are incomplete');
  }
  for (const [index, link] of tree.links.entries()) {
    const skill = prepared.skills[index]!;
    if (link.target !== skill.target) throw invalid('Imported profile Skill evidence changed');
    const linkPath = join(skillsPath, skill.id);
    const metadata = await lstat(linkPath, { bigint: true });
    if (!metadata.isSymbolicLink() || metadata.dev !== link.device || metadata.ino !== link.inode
      || await readlink(linkPath) !== link.target) throw invalid(`Imported profile Skill link changed: ${linkPath}`);
    await assertTarget(skill);
  }
}

async function assertFile(file: FileIdentity): Promise<void> {
  const metadata = await lstat(file.path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1n || metadata.dev !== file.device || metadata.ino !== file.inode || metadata.size !== file.size) {
    throw invalid(`Imported profile file changed: ${file.path}`);
  }
  await assertMode(file.path, FILE_MODE);
  let handle: FileHandle | undefined;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== file.device || opened.ino !== file.inode || opened.size !== file.size) throw invalid(`Imported profile file changed while opening: ${file.path}`);
    const bytes = await handle.readFile();
    if (!Buffer.from(bytes).equals(Buffer.from(file.bytes))) throw invalid(`Imported profile file bytes changed: ${file.path}`);
    const final = await handle.stat({ bigint: true });
    const finalPath = await lstat(file.path, { bigint: true });
    if (!final.isFile() || final.nlink !== 1n || final.dev !== file.device || final.ino !== file.inode || final.size !== file.size
      || finalPath.isSymbolicLink() || !finalPath.isFile() || finalPath.nlink !== 1n || finalPath.dev !== file.device || finalPath.ino !== file.inode || finalPath.size !== file.size) {
      throw invalid(`Imported profile file changed while reading: ${file.path}`);
    }
  } finally { await handle?.close().catch(() => undefined); }
}

async function assertMode(path: string, expected: number): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  if (Number(metadata.mode & 0o777n) !== expected) throw invalid(`Imported profile entry has unsafe mode: ${path}`);
}

async function assertExactNames(path: string, expected: readonly string[]): Promise<void> {
  const names: string[] = [];
  const directory = await opendir(path);
  try {
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      if (names.length === expected.length) throw invalid(`Imported profile staging contains unexpected entries: ${path}`);
      names.push(entry.name);
    }
  } finally { await directory.close().catch(() => undefined); }
  names.sort(compare);
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw invalid(`Imported profile staging tree differs: ${path}`);
}

async function assertAbsent(path: string, detail: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
  throw invalid(`${detail}: ${path}`);
}

async function syncDirectory(directory: HeldDirectory): Promise<void> {
  try { await directory.handle.sync(); }
  catch (error) {
    if (!new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM']).has(errorCode(error) ?? '')) throw error;
  }
}

async function probePublication(prepared: PreparedPublication, staging: DirectoryIdentity): Promise<PublicationProbe> {
  const [stagingProbe, destinationProbe] = await Promise.all([
    probeIdentity(prepared.stagingPath, staging),
    probeIdentity(prepared.destinationPath, staging)
  ]);
  if (stagingProbe === 'absent' && destinationProbe === 'same') return 'published';
  if (stagingProbe === 'same' && destinationProbe !== 'same') return 'not-published';
  return 'commit-ambiguous';
}

async function probeIdentity(path: string, expected: DirectoryIdentity): Promise<'absent' | 'same' | 'foreign'> {
  try {
    const metadata = await lstat(path, { bigint: true });
    return !metadata.isSymbolicLink() && metadata.isDirectory() && metadata.dev === expected.device && metadata.ino === expected.inode
      ? 'same'
      : 'foreign';
  } catch (error) { if (errorCode(error) === 'ENOENT') return 'absent'; throw error; }
}

async function closeTree(tree: CreatedTree): Promise<void> {
  for (const directory of [tree.packages, tree.libraries, tree.skills, tree.staging]) {
    if (directory !== undefined) await closeDirectory(directory);
  }
}

async function closeDirectory(directory: HeldDirectory): Promise<void> {
  if (directory.closed) return;
  await directory.handle.close();
  directory.closed = true;
}

async function cleanupOwnedTree(
  prepared: PreparedPublication,
  parent: HeldDirectory,
  tree: CreatedTree,
  hooks: ProfileImportPublicationTestHooks
): Promise<void> {
  if (tree.staging === undefined || tree.skills === undefined || tree.instructions === undefined) return;
  await assertDirectoryIdentity(parent, 'Refusing to clean through a changed profiles parent');
  await assertExactNames(tree.staging.path, [
    'AGENTS.md', 'skills',
    ...(tree.libraries === undefined ? [] : ['libraries']),
    ...(tree.packages === undefined ? [] : ['packages'])
  ].sort(compare));
  await assertExactNames(tree.skills.path, prepared.skills.map((skill) => skill.id));
  if (tree.libraries !== undefined) await assertExactNames(tree.libraries.path, prepared.libraryIds.map((id) => `${id}.json`));
  if (tree.packages !== undefined) await assertExactNames(tree.packages.path, prepared.packageIds.map((id) => `${id}.json`));
  for (const file of [...tree.references].reverse()) {
    await hooks.beforeCleanupEntry?.(file.path);
    await assertFile(file);
    await unlink(file.path);
  }
  if (tree.packages !== undefined) {
    await hooks.beforeCleanupEntry?.(tree.packages.path);
    await assertDirectoryIdentity(tree.packages, 'Refusing to clean changed packages directory');
    await rmdir(tree.packages.path);
  }
  if (tree.libraries !== undefined) {
    await hooks.beforeCleanupEntry?.(tree.libraries.path);
    await assertDirectoryIdentity(tree.libraries, 'Refusing to clean changed libraries directory');
    await rmdir(tree.libraries.path);
  }
  for (const link of [...tree.links].reverse()) {
    await hooks.beforeCleanupEntry?.(link.path);
    const metadata = await lstat(link.path, { bigint: true });
    if (!metadata.isSymbolicLink() || metadata.dev !== link.device || metadata.ino !== link.inode || await readlink(link.path) !== link.target) throw invalid(`Refusing to clean changed Skill link: ${link.path}`);
    await unlink(link.path);
  }
  await hooks.beforeCleanupEntry?.(tree.instructions.path);
  await assertFile(tree.instructions);
  await unlink(tree.instructions.path);
  await hooks.beforeCleanupEntry?.(tree.skills.path);
  await assertDirectoryIdentity(tree.skills, 'Refusing to clean changed skills directory');
  await rmdir(tree.skills.path);
  await hooks.beforeCleanupEntry?.(tree.staging.path);
  await assertDirectoryIdentity(tree.staging, 'Refusing to clean changed staging directory');
  await rmdir(tree.staging.path);
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1]!, values[index]!) >= 0) throw invalid(`${label} must be unique and lexically ordered`);
  }
}
function combine(left: unknown, right: unknown): unknown { return left === undefined ? right : right === undefined ? left : new AggregateError([left, right]); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_IMPORT_PUBLICATION_INVALID', `Invalid imported profile publication: ${detail}.`); }
