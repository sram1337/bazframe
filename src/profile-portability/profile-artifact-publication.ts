import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Dir } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename as nativeRename,
  rmdir,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isUint8Array } from 'node:util/types';
import {
  decodeUtf8Instructions,
  MAX_EFFECTIVE_INSTRUCTION_BYTES
} from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { escapeUnsafeDisplayCharacters } from '../core/safe-text.js';
import {
  readProfileArtifactDirectory,
  type PhysicalArtifactDirectoryIdentity
} from './profile-artifact-io.js';
import {
  encodeProfileArtifact,
  type ProfileArtifact,
  type ProfileArtifactLimitPolicy
} from './profile-artifact.js';

export type ProfileArtifactPublicationCommitState =
  | 'not-published'
  | 'published'
  | 'commit-ambiguous';

export interface ProfileArtifactPublicationOptions {
  bazframeHome: string;
  outputDirectory: string;
  artifact: ProfileArtifact;
  instructionBytes: Uint8Array;
  limitPolicy: ProfileArtifactLimitPolicy;
  /** Production revalidation performed after staged-tree validation and before commit checks. */
  beforeCommit?: () => void | Promise<void>;
}

export interface ProfileArtifactPublicationResult {
  outputPath: string;
  identity: PhysicalArtifactDirectoryIdentity;
}

export class ProfileArtifactPublicationError extends BazframeError {
  readonly commitState: ProfileArtifactPublicationCommitState;
  readonly outputPath: string;
  readonly stagingPath: string;

  constructor(
    commitState: ProfileArtifactPublicationCommitState,
    outputPath: string,
    stagingPath: string,
    cause: unknown
  ) {
    super(
      'PROFILE_ARTIFACT_PUBLICATION_FAILED',
      `Could not publish profile artifact directory to ${escapeUnsafeDisplayCharacters(outputPath)} `
        + `(${commitState}; staging: ${escapeUnsafeDisplayCharacters(stagingPath)}).`,
      { cause }
    );
    this.name = 'ProfileArtifactPublicationError';
    this.commitState = commitState;
    this.outputPath = outputPath;
    this.stagingPath = stagingPath;
  }
}

export interface ProfileArtifactPublicationTestHooks {
  atPhase?: (
    phase:
      | 'after-staging-created'
      | 'after-tree-written'
      | 'before-commit-checks'
      | 'before-rename'
      | 'after-rename-attempt'
  ) => void | Promise<void>;
  rename?: (stagingPath: string, outputPath: string) => Promise<void>;
  afterFileSync?: (
    entry: 'manifest' | 'instructions',
    path: string
  ) => void | Promise<void>;
  afterClose?: (
    target:
      | 'manifest'
      | 'instructions'
      | 'profile-directory'
      | 'staging-directory'
      | 'home-directory'
      | 'output-parent',
    path: string
  ) => void | Promise<void>;
  beforeCleanupEntry?: (
    entry: 'instructions' | 'profile-directory' | 'manifest' | 'staging-directory',
    path: string
  ) => void | Promise<void>;
}

interface PreparedPublication {
  homePath: string;
  outputPath: string;
  stagingPath: string;
  manifestBytes: Uint8Array;
  instructionBytes: Uint8Array;
  policy: ProfileArtifactLimitPolicy;
  beforeCommit?: () => void | Promise<void>;
}

interface HeldDirectory extends PhysicalArtifactDirectoryIdentity {
  handle: FileHandle;
  target: 'profile-directory' | 'staging-directory' | 'home-directory' | 'output-parent';
  closed: boolean;
}

interface CreatedFile {
  path: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface CreatedEntries {
  stagingCreationObserved: boolean;
  profileCreationObserved: boolean;
  manifestCreationObserved: boolean;
  instructionsCreationObserved: boolean;
  staging?: HeldDirectory;
  profile?: HeldDirectory;
  manifest?: CreatedFile;
  instructions?: CreatedFile;
}

type IdentityProbe =
  | { kind: 'identity'; identity: PhysicalArtifactDirectoryIdentity }
  | { kind: 'absent' }
  | { kind: 'foreign' }
  | { kind: 'unreadable'; error: unknown };

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsicTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength'
)?.get as (this: Uint8Array) => number;
const intrinsicTypedArraySet = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'set'
)?.value as (this: Uint8Array, source: Uint8Array, offset?: number) => void;

export async function publishProfileArtifactDirectory(
  options: ProfileArtifactPublicationOptions,
  testHooks: ProfileArtifactPublicationTestHooks = {}
): Promise<ProfileArtifactPublicationResult> {
  // An async function executes through its first await synchronously. Keep every caller-owned
  // value out of the asynchronous portion by preparing it here.
  const initialOutput = normalizeOutputPath(options.outputDirectory);
  const initialStaging = join(dirname(initialOutput), `.bazframe-profile-staging-${randomUUID()}`);
  let prepared: PreparedPublication;
  try {
    if (options.outputDirectory.includes('\0')) {
      throw new Error('output path contains a NUL byte');
    }
    const enteredBasename = basename(options.outputDirectory);
    if (enteredBasename.length === 0
      || enteredBasename === '.'
      || enteredBasename === '..'
      || initialOutput === resolve(initialOutput, '..')) {
      throw new Error('output path must have a valid directory basename below a parent');
    }
    const homePath = copyPath(options.bazframeHome, 'BAZFRAME_HOME');
    const policy = {
      maxManifestBytes: options.limitPolicy.maxManifestBytes,
      maxProfileEntries: options.limitPolicy.maxProfileEntries,
      maxResources: options.limitPolicy.maxResources
    };
    const instructionPath = join(initialStaging, 'profile', 'AGENTS.md');
    const instructionBytes = copyInstructionBytes(options.instructionBytes, instructionPath);
    decodeUtf8Instructions(
      instructionBytes,
      'Profile artifact instructions',
      instructionPath
    );
    const manifestBytes = Buffer.from(encodeProfileArtifact(options.artifact, policy), 'utf8');
    const digest = createHash('sha256').update(instructionBytes).digest('hex');
    if (digest !== options.artifact.profile.instructions.sha256) {
      throw new BazframeError(
        'PROFILE_ARTIFACT_INSTRUCTION_DIGEST_MISMATCH',
        'Profile artifact instruction digest does not match the prepared instruction bytes.'
      );
    }
    prepared = {
      homePath,
      outputPath: initialOutput,
      stagingPath: initialStaging,
      manifestBytes: Uint8Array.from(manifestBytes),
      instructionBytes,
      policy,
      ...(options.beforeCommit === undefined ? {} : { beforeCommit: options.beforeCommit })
    };
  } catch (error) {
    throw new ProfileArtifactPublicationError(
      'not-published',
      initialOutput,
      initialStaging,
      error
    );
  }

  return await publishPrepared(prepared, testHooks);
}

function normalizeOutputPath(value: string): string {
  if (typeof value !== 'string') return resolve('<invalid-output-path>');
  return resolve(value);
}

function copyInstructionBytes(value: Uint8Array, instructionPath: string): Uint8Array {
  if (!isUint8Array(value)) {
    throw new TypeError('Profile artifact instruction bytes must be a Uint8Array');
  }
  const byteLength = Reflect.apply(intrinsicTypedArrayByteLength, value, []);
  if (byteLength > MAX_EFFECTIVE_INSTRUCTION_BYTES) {
    throw new BazframeError(
      'INSTRUCTION_TOO_LARGE',
      `Profile artifact instructions exceed the ${MAX_EFFECTIVE_INSTRUCTION_BYTES}-byte instruction limit: ${escapeUnsafeDisplayCharacters(instructionPath)}`
    );
  }
  const copied = new Uint8Array(byteLength);
  Reflect.apply(intrinsicTypedArraySet, copied, [value, 0]);
  return copied;
}

function copyPath(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty path without NUL bytes`);
  }
  return resolve(value);
}

async function publishPrepared(
  prepared: PreparedPublication,
  hooks: ProfileArtifactPublicationTestHooks
): Promise<ProfileArtifactPublicationResult> {
  const entries: CreatedEntries = {
    stagingCreationObserved: false,
    profileCreationObserved: false,
    manifestCreationObserved: false,
    instructionsCreationObserved: false
  };
  let home: HeldDirectory | undefined;
  let parent: HeldDirectory | undefined;
  let primaryError: unknown;
  let publicationObserved = false;
  let renameInvoked = false;
  let cleanupBeganDestructiveMutation = false;
  let resultIdentity: PhysicalArtifactDirectoryIdentity | undefined;

  try {
    if (process.platform === 'win32') {
      throw new Error('This platform cannot establish the required no-follow private publication guarantees');
    }

    const canonicalHome = await canonicalPhysicalDirectory(prepared.homePath, 'BAZFRAME_HOME');
    home = await holdPhysicalDirectory(canonicalHome, 'home-directory');

    const requestedParent = dirname(prepared.outputPath);
    const canonicalParent = await canonicalPhysicalDirectory(requestedParent, 'Output parent');
    parent = await holdPhysicalDirectory(canonicalParent, 'output-parent');
    prepared.outputPath = join(canonicalParent, basename(prepared.outputPath));
    prepared.stagingPath = join(canonicalParent, basename(prepared.stagingPath));

    assertDisjoint(prepared.outputPath, canonicalHome, 'output and BAZFRAME_HOME');
    assertDisjoint(prepared.stagingPath, canonicalHome, 'staging and BAZFRAME_HOME');
    assertDisjoint(prepared.outputPath, prepared.stagingPath, 'output and staging');
    await assertDirectoryStable(home, 'BAZFRAME_HOME');
    await assertDirectoryStable(parent, 'Output parent');
    await assertAbsent(prepared.outputPath, 'Output path is occupied');

    await mkdir(prepared.stagingPath, { mode: 0o700 });
    entries.stagingCreationObserved = true;
    entries.staging = await holdCreatedDirectory(
      prepared.stagingPath,
      'staging-directory',
      parent,
      (created) => { entries.staging = created; }
    );
    await hooks.atPhase?.('after-staging-created');

    const profilePath = join(prepared.stagingPath, 'profile');
    await mkdir(profilePath, { mode: 0o700 });
    entries.profileCreationObserved = true;
    entries.profile = await holdCreatedDirectory(
      profilePath,
      'profile-directory',
      entries.staging,
      (created) => { entries.profile = created; }
    );

    entries.manifest = await createAndWriteFile(
      join(prepared.stagingPath, 'bazframe-profile.json'),
      prepared.manifestBytes,
      'manifest',
      hooks,
      () => { entries.manifestCreationObserved = true; },
      (created) => { entries.manifest = created; }
    );
    entries.instructions = await createAndWriteFile(
      join(profilePath, 'AGENTS.md'),
      prepared.instructionBytes,
      'instructions',
      hooks,
      () => { entries.instructionsCreationObserved = true; },
      (created) => { entries.instructions = created; }
    );
    await syncDirectoryHandle(entries.profile.handle);
    await syncDirectoryHandle(entries.staging.handle);
    await hooks.atPhase?.('after-tree-written');

    const staged = await readProfileArtifactDirectory(prepared.stagingPath, prepared.policy);
    requireSameIdentity(staged.root, entries.staging, 'Staged artifact root changed during validation');
    requireSameIdentity(
      staged.profileDirectory,
      entries.profile,
      'Staged profile directory changed during validation'
    );
    if (!Buffer.from(staged.manifestBytes).equals(Buffer.from(prepared.manifestBytes))) {
      throw new Error('Staged manifest bytes differ from the prepared canonical bytes');
    }
    if (!Buffer.from(staged.instructions.bytes).equals(Buffer.from(prepared.instructionBytes))) {
      throw new Error('Staged instruction bytes differ from the prepared bytes');
    }
    requireFileIdentity(staged.instructions, entries.instructions, 'Staged instructions changed during validation');
    await assertCreatedFileStable(entries.manifest, 'Staged manifest');
    await assertCreatedFileStable(entries.instructions, 'Staged instructions');

    await prepared.beforeCommit?.();
    await hooks.atPhase?.('before-commit-checks');
    await assertDirectoryStable(home, 'BAZFRAME_HOME');
    await assertDirectoryStable(parent, 'Output parent');
    await validateCompleteTree(entries);
    assertDisjoint(prepared.outputPath, home.path, 'output and BAZFRAME_HOME');
    assertDisjoint(prepared.stagingPath, home.path, 'staging and BAZFRAME_HOME');
    assertDisjoint(prepared.outputPath, prepared.stagingPath, 'output and staging');
    // In production this is deliberately the final filesystem operation before rename.
    await assertAbsent(prepared.outputPath, 'Output path became occupied');
    await hooks.atPhase?.('before-rename');

    renameInvoked = true;
    try {
      await (hooks.rename ?? nativeRename)(prepared.stagingPath, prepared.outputPath);
    } catch (error) {
      primaryError = error;
    }
    try {
      await hooks.atPhase?.('after-rename-attempt');
    } catch (error) {
      primaryError = combineFailures(primaryError, error);
    }

    const commitState = await classifyCommit(prepared, entries.staging);
    if (commitState !== 'published') {
      throw primaryError ?? new Error(
        commitState === 'not-published'
          ? 'Rename did not publish the created staging directory'
          : 'Could not determine whether rename published the created staging directory'
      );
    }
    publicationObserved = true;
    if (primaryError !== undefined) throw primaryError;

    await syncDirectoryHandle(parent.handle);
    await assertDirectoryStable(parent, 'Output parent');
    const destination = await physicalDirectoryIdentity(prepared.outputPath, 'Published output');
    requireSameIdentity(destination, entries.staging, 'Published output identity does not match staging');
    resultIdentity = destination;
  } catch (error) {
    primaryError = combineFailures(primaryError, error);
  }

  let cleanupCompleted = false;
  if (primaryError !== undefined || resultIdentity === undefined) {
    const beforeCleanup = publicationObserved
      ? 'published'
      : await classifyCommit(prepared, entries.staging);
    if (beforeCleanup === 'not-published') {
      const cleanupFailure = await cleanupCreatedTree(
        prepared,
        entries,
        parent,
        hooks,
        () => { cleanupBeganDestructiveMutation = true; }
      );
      primaryError = combineFailures(primaryError, cleanupFailure);
      cleanupCompleted = cleanupFailure === undefined;
    }
  }

  const closeFailure = await closeDirectories(
    [entries.profile, entries.staging, home, parent],
    hooks
  );
  primaryError = combineFailures(primaryError, closeFailure);

  const freshlyClassified = cleanupCompleted
    ? 'not-published'
    : await classifyCommit(prepared, entries.staging);
  const commitState = !renameInvoked
    ? 'not-published'
    : cleanupBeganDestructiveMutation && freshlyClassified === 'published'
      ? 'commit-ambiguous'
      : freshlyClassified;

  if (primaryError === undefined && resultIdentity !== undefined && commitState === 'published') {
    return { outputPath: prepared.outputPath, identity: resultIdentity };
  }
  if (primaryError === undefined) {
    primaryError = new Error(
      commitState === 'not-published'
        ? 'Published output identity was not retained at the destination'
        : 'Published output identity became ambiguous after publication'
    );
  }

  throw new ProfileArtifactPublicationError(
    commitState,
    prepared.outputPath,
    prepared.stagingPath,
    primaryError ?? new Error('Profile artifact publication failed without a diagnostic')
  );
}

async function canonicalPhysicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const initial = await physicalDirectoryIdentity(path, label);
  const canonical = await realpath(path);
  const [current, resolved] = await Promise.all([
    physicalDirectoryIdentity(path, label),
    physicalDirectoryIdentity(canonical, label)
  ]);
  requireSameIdentity(initial, current, `${label} changed while resolving`);
  requireSameIdentity(initial, resolved, `${label} resolved through a substituted entry`);
  return canonical;
}

async function holdPhysicalDirectory(
  path: string,
  target: HeldDirectory['target']
): Promise<HeldDirectory> {
  const expected = await physicalDirectoryIdentity(path, target);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== expected.device || opened.ino !== expected.inode) {
      throw new Error('directory identity changed while opening');
    }
    return { ...expected, handle, target, closed: false };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw new Error(`Could not hold physical directory ${escapeUnsafeDisplayCharacters(path)}`, { cause: error });
  }
}

async function holdCreatedDirectory(
  path: string,
  target: 'profile-directory' | 'staging-directory',
  parent: HeldDirectory,
  recordCreated: (directory: HeldDirectory) => void
): Promise<HeldDirectory> {
  if (dirname(path) !== parent.path) throw new Error('Created directory is not a direct child of its held parent');
  await assertDirectoryStable(parent, 'Created directory parent');
  const directory = await holdPhysicalDirectory(path, target);
  recordCreated(directory);
  await assertPrivateMode(path, true);
  await assertDirectoryStable(parent, 'Created directory parent');
  return directory;
}

async function physicalDirectoryIdentity(
  path: string,
  label: string
): Promise<PhysicalArtifactDirectoryIdentity> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('not a physical directory');
    return { path, device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    throw new Error(`${label} must be an existing physical directory: ${escapeUnsafeDisplayCharacters(path)}`, {
      cause: error
    });
  }
}

async function assertDirectoryStable(directory: HeldDirectory, label: string): Promise<void> {
  if (directory.closed) throw new Error(`${label} handle is already closed`);
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory()
    || current.isSymbolicLink()
    || !current.isDirectory()
    || opened.dev !== directory.device
    || opened.ino !== directory.inode
    || current.dev !== directory.device
    || current.ino !== directory.inode) {
    throw new Error(`${label} identity changed: ${escapeUnsafeDisplayCharacters(directory.path)}`);
  }
}

async function createAndWriteFile(
  path: string,
  bytes: Uint8Array,
  entry: 'manifest' | 'instructions',
  hooks: ProfileArtifactPublicationTestHooks,
  recordCreationObserved: () => void,
  recordCreated: (file: CreatedFile) => void
): Promise<CreatedFile> {
  let handle: FileHandle | undefined;
  let created: CreatedFile | undefined;
  let primary: unknown;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    recordCreationObserved();
    const initial = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!initial.isFile()
      || current.isSymbolicLink()
      || !current.isFile()
      || initial.dev !== current.dev
      || initial.ino !== current.ino) {
      throw new Error('exclusive file identity could not be established');
    }
    created = fileFromStats(path, initial);
    recordCreated(created);
    await assertPrivateMode(path, false);
    await handle.writeFile(bytes);
    await handle.sync();
    await hooks.afterFileSync?.(entry, path);
    const final = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (!final.isFile()
      || finalPath.isSymbolicLink()
      || !finalPath.isFile()
      || final.dev !== created.device
      || final.ino !== created.inode
      || finalPath.dev !== created.device
      || finalPath.ino !== created.inode
      || final.size !== BigInt(bytes.byteLength)
      || finalPath.size !== final.size) {
      throw new Error(`Created ${entry} changed while being written`);
    }
    await assertPrivateMode(path, false);
    created = fileFromStats(path, final);
    recordCreated(created);
  } catch (error) {
    primary = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
      await hooks.afterClose?.(entry, path);
    } catch (error) {
      primary = combineFailures(primary, error);
    }
  }
  if (primary !== undefined) throw primary;
  if (created === undefined) throw new Error(`Could not create ${entry}`);
  return created;
}

function fileFromStats(path: string, metadata: BigIntStats): CreatedFile {
  return {
    path,
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  };
}

async function assertCreatedFileStable(file: CreatedFile, label: string): Promise<void> {
  const metadata = await lstat(file.path, { bigint: true });
  if (metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.dev !== file.device
    || metadata.ino !== file.inode
    || metadata.size !== file.size
    || metadata.mtimeNs !== file.mtimeNs
    || metadata.ctimeNs !== file.ctimeNs) {
    throw new Error(`${label} identity or metadata changed: ${escapeUnsafeDisplayCharacters(file.path)}`);
  }
}

async function assertPrivateMode(path: string, directory: boolean): Promise<void> {
  if (process.platform === 'win32') throw new Error('Private POSIX mode semantics are unavailable');
  const metadata = await lstat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Created ${directory ? 'directory' : 'file'} is not private: ${escapeUnsafeDisplayCharacters(path)}`);
  }
}

async function validateCompleteTree(entries: CreatedEntries): Promise<void> {
  if (entries.staging === undefined
    || entries.profile === undefined
    || entries.manifest === undefined
    || entries.instructions === undefined) {
    throw new Error('Staging tree is incomplete');
  }
  await assertDirectoryStable(entries.staging, 'Staging directory');
  await assertPrivateMode(entries.staging.path, true);
  await enumerateExact(entries.staging.path, ['bazframe-profile.json', 'profile']);
  await assertDirectoryStable(entries.profile, 'Profile directory');
  await assertPrivateMode(entries.profile.path, true);
  await enumerateExact(entries.profile.path, ['AGENTS.md']);
  await assertCreatedFileStable(entries.manifest, 'Manifest');
  await assertPrivateMode(entries.manifest.path, false);
  await assertCreatedFileStable(entries.instructions, 'Instructions');
  await assertPrivateMode(entries.instructions.path, false);
  await assertDirectoryStable(entries.profile, 'Profile directory');
  await assertDirectoryStable(entries.staging, 'Staging directory');
}

async function enumerateExact(path: string, expected: readonly string[]): Promise<void> {
  const wanted = new Set(expected);
  const observed = new Set<string>();
  let stream: Dir | undefined;
  let failure: unknown;
  try {
    stream = await opendir(path);
    while (true) {
      const entry = await stream.read();
      if (entry === null) break;
      if (!wanted.has(entry.name) || observed.has(entry.name)) {
        throw new Error(`Directory has missing or unexpected entries: ${escapeUnsafeDisplayCharacters(path)}`);
      }
      observed.add(entry.name);
    }
  } catch (error) {
    failure = error;
  }
  if (stream !== undefined) {
    try {
      await stream.close();
    } catch (error) {
      failure = combineFailures(failure, error);
    }
  }
  if (failure !== undefined) throw failure;
  if (observed.size !== wanted.size) {
    throw new Error(`Directory has missing or unexpected entries: ${escapeUnsafeDisplayCharacters(path)}`);
  }
}

function assertDisjoint(left: string, right: string, label: string): void {
  if (pathContains(left, right) || pathContains(right, left)) {
    throw new Error(`${label} must be disjoint`);
  }
}

function pathContains(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && value !== '..' && !isAbsolute(value));
}

async function assertAbsent(path: string, detail: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${detail}: ${escapeUnsafeDisplayCharacters(path)}`);
}

async function syncDirectoryHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (!new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM']).has(errorCode(error) ?? '')) throw error;
  }
}

async function classifyCommit(
  prepared: PreparedPublication,
  staging: HeldDirectory | undefined
): Promise<ProfileArtifactPublicationCommitState> {
  if (staging === undefined) return 'not-published';
  const [destination, source] = await Promise.all([
    probeDirectoryIdentity(prepared.outputPath),
    probeDirectoryIdentity(prepared.stagingPath)
  ]);
  const destinationIsCreated = probeMatches(destination, staging);
  const sourceIsCreated = probeMatches(source, staging);
  if (destinationIsCreated && sourceIsCreated) return 'commit-ambiguous';
  if (destinationIsCreated) return 'published';
  if (destination.kind === 'unreadable') return 'commit-ambiguous';
  if (sourceIsCreated && (destination.kind === 'absent' || destination.kind === 'foreign' || destination.kind === 'identity')) {
    return 'not-published';
  }
  return 'commit-ambiguous';
}

async function probeDirectoryIdentity(path: string): Promise<IdentityProbe> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return { kind: 'foreign' };
    return { kind: 'identity', identity: { path, device: metadata.dev, inode: metadata.ino } };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', error };
  }
}

function probeMatches(probe: IdentityProbe, expected: PhysicalArtifactDirectoryIdentity): boolean {
  return probe.kind === 'identity' && sameIdentity(probe.identity, expected);
}

async function closeDirectories(
  directories: readonly (HeldDirectory | undefined)[],
  hooks: ProfileArtifactPublicationTestHooks
): Promise<unknown> {
  let failure: unknown;
  for (const directory of directories) {
    if (directory === undefined || directory.closed) continue;
    try {
      await directory.handle.close();
      directory.closed = true;
      await hooks.afterClose?.(directory.target, directory.path);
    } catch (error) {
      directory.closed = true;
      failure = combineFailures(failure, error);
    }
  }
  return failure;
}

async function cleanupCreatedTree(
  prepared: PreparedPublication,
  entries: CreatedEntries,
  parent: HeldDirectory | undefined,
  hooks: ProfileArtifactPublicationTestHooks,
  recordDestructiveMutation: () => void
): Promise<unknown> {
  if (entries.staging === undefined) {
    return entries.stagingCreationObserved
      ? new Error(
        `Created staging identity could not be established; staging cleanup is uncertain: ${escapeUnsafeDisplayCharacters(prepared.stagingPath)}`
      )
      : undefined;
  }
  if (parent === undefined) {
    return new Error(
      `Held output parent is unavailable; staging cleanup is uncertain: ${escapeUnsafeDisplayCharacters(prepared.stagingPath)}`
    );
  }
  try {
    if (entries.profileCreationObserved && entries.profile === undefined) {
      throw new Error('Created profile directory identity could not be established; staging cleanup is uncertain');
    }
    if (entries.manifestCreationObserved && entries.manifest === undefined) {
      throw new Error('Created manifest identity could not be established; staging cleanup is uncertain');
    }
    if (entries.instructionsCreationObserved && entries.instructions === undefined) {
      throw new Error('Created instructions identity could not be established; staging cleanup is uncertain');
    }

    await assertDirectoryStable(parent, 'Output parent before cleanup');
    await assertDirectoryStable(entries.staging, 'Staging before cleanup');

    const rootNames: string[] = [];
    if (entries.manifest !== undefined) rootNames.push('bazframe-profile.json');
    if (entries.profile !== undefined) rootNames.push('profile');
    await enumerateExact(prepared.stagingPath, rootNames);
    if (entries.profile !== undefined) {
      await assertDirectoryStable(entries.profile, 'Profile directory before cleanup');
      await enumerateExact(entries.profile.path, entries.instructions === undefined ? [] : ['AGENTS.md']);
    }

    if (entries.instructions !== undefined && entries.profile !== undefined) {
      await hooks.beforeCleanupEntry?.('instructions', entries.instructions.path);
      await assertDirectoryStable(entries.staging, 'Staging before instruction cleanup');
      await enumerateExact(entries.staging.path, rootNames);
      await assertDirectoryStable(entries.profile, 'Profile before instruction cleanup');
      await enumerateExact(entries.profile.path, ['AGENTS.md']);
      await assertCreatedFileIdentity(entries.instructions, 'Instructions changed before cleanup');
      recordDestructiveMutation();
      await unlink(entries.instructions.path);
      await assertAbsent(entries.instructions.path, 'Instructions remained after cleanup');
      await assertDirectoryStable(entries.profile, 'Profile after instruction cleanup');
    }

    if (entries.profile !== undefined) {
      await hooks.beforeCleanupEntry?.('profile-directory', entries.profile.path);
      await assertDirectoryStable(entries.staging, 'Staging before profile cleanup');
      await enumerateExact(entries.staging.path, rootNames);
      await assertDirectoryStable(entries.profile, 'Profile before cleanup');
      await enumerateExact(entries.profile.path, []);
      recordDestructiveMutation();
      await rmdir(entries.profile.path);
      await assertAbsent(entries.profile.path, 'Profile directory remained after cleanup');
      await assertDirectoryStable(entries.staging, 'Staging after profile cleanup');
    }

    if (entries.manifest !== undefined) {
      await hooks.beforeCleanupEntry?.('manifest', entries.manifest.path);
      await assertDirectoryStable(entries.staging, 'Staging before manifest cleanup');
      await enumerateExact(entries.staging.path, ['bazframe-profile.json']);
      await assertCreatedFileIdentity(entries.manifest, 'Manifest changed before cleanup');
      recordDestructiveMutation();
      await unlink(entries.manifest.path);
      await assertAbsent(entries.manifest.path, 'Manifest remained after cleanup');
      await assertDirectoryStable(entries.staging, 'Staging after manifest cleanup');
    }

    await hooks.beforeCleanupEntry?.('staging-directory', entries.staging.path);
    await assertDirectoryStable(parent, 'Output parent before staging cleanup');
    await assertDirectoryStable(entries.staging, 'Staging before cleanup');
    await enumerateExact(entries.staging.path, []);
    recordDestructiveMutation();
    await rmdir(entries.staging.path);
    await assertAbsent(entries.staging.path, 'Staging directory remained after cleanup');
    await assertDirectoryStable(parent, 'Output parent after staging cleanup');
    return undefined;
  } catch (error) {
    return error;
  }
}

async function assertCreatedFileIdentity(file: CreatedFile, detail: string): Promise<void> {
  const metadata = await lstat(file.path, { bigint: true });
  if (metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.dev !== file.device
    || metadata.ino !== file.inode) {
    throw new Error(detail);
  }
}

function requireFileIdentity(
  observed: { device: bigint; inode: bigint },
  expected: CreatedFile,
  detail: string
): void {
  if (observed.device !== expected.device || observed.inode !== expected.inode) throw new Error(detail);
}

function requireSameIdentity(
  observed: PhysicalArtifactDirectoryIdentity,
  expected: PhysicalArtifactDirectoryIdentity,
  detail: string
): void {
  if (!sameIdentity(observed, expected)) throw new Error(detail);
}

function sameIdentity(
  left: PhysicalArtifactDirectoryIdentity,
  right: PhysicalArtifactDirectoryIdentity
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function combineFailures(primary: unknown, secondary: unknown): unknown {
  if (primary === undefined) return secondary;
  if (secondary === undefined || secondary === primary) return primary;
  return new AggregateError(
    [primary, secondary],
    primary instanceof Error ? primary.message : 'Profile artifact publication failed',
    { cause: primary }
  );
}
