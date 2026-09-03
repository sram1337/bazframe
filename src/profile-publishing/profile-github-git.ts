import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  PROFILE_PORTABILITY_PRODUCTION_LIMITS,
  managedGitAcquisitionLimitPolicy,
  type ManagedGitAcquisitionLimitPolicy
} from '../profile-portability/profile-portability-policy.js';
import { canonicalProfileGitHubOrigin } from '../providers/managed-git-source.js';
import {
  assertBlobBytes,
  decodeCapturedProfileBytes,
  decodeCapturedProfileObject,
  encodeCapturedProfile,
  type CapturedProfileLimitPolicy,
  type CapturedProfileV1,
  type Sha256
} from './captured-profile.js';
import {
  assertProfileGithubCommand,
  assertProfileGithubOutputConsistency,
  createOwnedProfileGithubDirectory,
  runProfileGithubCommand,
  type OwnedProfileGithubDirectory,
  type ProfileGithubIsolation,
  type ProfileGithubProcess,
  type ProfileGithubProcessResult
} from './profile-github-process.js';
import {
  assertProfileGithubRepositoryCreationProof,
  lookupProfileGithubRepository,
  parseProfileGithubSource,
  type CanonicalProfileGithubSource,
  type ProfileGithubRepositoryCreationProof
} from './profile-github.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import {
  assertPhysicalAncestry,
  assertPhysicalDirectoryIdentity,
  enumerateStableDirectory,
  openStablePhysicalDirectory,
  readStablePhysicalFile,
  stableReadChildPath,
  type StableDirectory
} from './profile-filesystem.js';

export interface ProfileGithubGitBlob {
  sha256: Sha256;
  bytes: number;
  bytesValue: Uint8Array;
}

export interface ProfileGithubGitSnapshot {
  branch: 'main';
  tip: string;
  commit: string;
  /** Exact verified first parent; canonical Bazframe publication history is linear. */
  parent: string | null;
  tree: string;
  profile: CapturedProfileV1;
  manifestBytes: Buffer;
  blobs: Array<{ sha256: Sha256; bytes: number; bytesValue: Buffer }>;
}

export interface ProfileGithubGitOptions {
  process: ProfileGithubProcess;
  isolation: ProfileGithubIsolation;
  cwd: string;
  quarantineParent: string;
  /** Test-only opt-in. Production GitHub HTTPS flows must leave this false. */
  allowFileProtocol?: boolean;
  authenticated?: boolean;
  limitPolicy?: Partial<CapturedProfileLimitPolicy>;
  /** Lower-only resource limits; production defaults remain authoritative. */
  acquisitionLimits?: Partial<ManagedGitAcquisitionLimitPolicy>;
}

export interface ProfileGithubRefUpdateIntent {
  kind: 'profile-github-ref-update';
  ref: 'refs/heads/main';
  expectedOld: string | null;
  newCommit: string;
  capturedManifestSha256: Sha256;
}

export interface ProfileGithubPublicationEffects {
  kind: 'profile-github-publication-effects';
  repositoryCreated: boolean;
  refUpdated: true;
  commitCreated: true;
  visibilityChanged: false;
  ref: 'refs/heads/main';
  expectedOld: string | null;
  commit: string;
  tree: string;
  capturedManifestSha256: Sha256;
}

export interface PublishCanonicalProfileGitOptions extends ProfileGithubGitOptions {
  remoteUrl: string;
  profile: CapturedProfileV1;
  blobs: readonly ProfileGithubGitBlob[];
  expectedOld: string | null;
  /** True only for the explicit local-test exception or with the opaque production proof. */
  repositoryCreated: boolean;
  repositoryCreationProof?: ProfileGithubRepositoryCreationProof;
  beforeRefUpdate?(intent: ProfileGithubRefUpdateIntent): void | Promise<void>;
}

interface GitWorkspace {
  owned: OwnedProfileGithubDirectory;
  gitDirectory: StableDirectory;
  acquisitionLimits: Readonly<ManagedGitAcquisitionLimitPolicy>;
}

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REVISION = /^[a-f0-9]+$/u;
const TREE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAIN_REF = 'refs/heads/main' as const;
const MAIN_REMOTE_REF = 'refs/remotes/origin/main';

export interface ProfileGithubGitHistory {
  branch: 'main';
  tip: string;
  commits: string[];
}

/** Reads only the exact refs/heads/main tip without branch or HEAD fallback. */
export async function readCanonicalProfileGitTip(
  remoteUrl: string,
  options: ProfileGithubGitOptions
): Promise<string | null> {
  validateRemote(options, remoteUrl, false);
  const workspace = await createGitWorkspace(options, 'bazframe-profile-tip-');
  let operationError: unknown;
  let tip: string | null = null;
  try { tip = await remoteTip({ ...options, remoteUrl } as ProfileGithubGitOptions & { remoteUrl: string }, workspace); }
  catch (error) { operationError = error; }
  finally {
    try { await disposeGitWorkspace(workspace); }
    catch (cleanupError) { operationError = combineOperationAndCleanup(operationError, cleanupError); }
  }
  if (operationError !== undefined) throw operationError;
  return tip;
}

/** Lists the bounded reachable commit history of exactly refs/heads/main. */
export async function listCanonicalProfileGitVersions(
  remoteUrl: string,
  options: ProfileGithubGitOptions
): Promise<ProfileGithubGitHistory> {
  validateRemote(options, remoteUrl, false);
  const workspace = await createGitWorkspace(options, 'bazframe-profile-list-');
  let operationError: unknown;
  let history: ProfileGithubGitHistory | undefined;
  try {
    const commits = await fetchMainHistory(remoteUrl, options, workspace);
    if (commits.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileEntries) throw new BazframeError('PROFILE_GITHUB_GIT_OBJECT_LIMIT', 'GitHub profile version history exceeds its bounded entry limit.');
    history = { branch: 'main', tip: commits[0]!, commits };
  } catch (error) { operationError = error; }
  finally {
    try { await disposeGitWorkspace(workspace); }
    catch (cleanupError) { operationError = combineOperationAndCleanup(operationError, cleanupError); }
  }
  if (operationError !== undefined) throw operationError;
  return history!;
}

/** Fetches only refs/heads/main into a Bazframe-owned quarantine and reads reachable versions there. */
export async function readCanonicalProfileGitVersion(
  remoteUrl: string,
  revision: string | undefined,
  options: ProfileGithubGitOptions
): Promise<ProfileGithubGitSnapshot> {
  if ('branch' in options) throw invalid('branch selection is unsupported; versions are always refs/heads/main');
  validateRemote(options, remoteUrl, false);
  if (revision !== undefined && (!REVISION.test(revision) || revision.length > 64)) throw invalid('commit selector must be nonempty lowercase hexadecimal');
  const workspace = await createGitWorkspace(options, 'bazframe-profile-read-');
  let operationError: unknown;
  let snapshot: ProfileGithubGitSnapshot | undefined;
  try {
    const reachable = await fetchMainHistory(remoteUrl, options, workspace);
    const tip = reachable[0]!;
    const matches = revision === undefined ? [tip] : reachable.filter((commit) => commit.startsWith(revision));
    if (matches.length === 0) throw new BazframeError('PROFILE_GITHUB_COMMIT_UNREACHABLE', 'Requested commit is not reachable from refs/heads/main.');
    if (matches.length > 1) throw new BazframeError('PROFILE_GITHUB_COMMIT_AMBIGUOUS', 'Requested commit prefix is ambiguous on refs/heads/main.');
    const commit = matches[0]!;
    const parentLine = (await gitText(options, ['-C', workspace.owned.path, 'rev-list', '--parents', '-n', '1', commit], false, 'PROFILE_GITHUB_GIT_READ_FAILED', 'Git commit parent could not be read.', workspace)).trim();
    const parentFields = parentLine.split(' ');
    if (parentFields[0] !== commit || parentFields.length > 2 || (parentFields[1] !== undefined && !COMMIT.test(parentFields[1]))) throw invalid('commit parent proof is invalid or non-linear');
    const parent = parentFields[1] ?? null;
    const tree = (await gitText(options, ['-C', workspace.owned.path, 'rev-parse', `${commit}^{tree}`], false, 'PROFILE_GITHUB_GIT_READ_FAILED', 'Git commit tree could not be read.', workspace)).trim();
    if (!TREE.test(tree)) throw invalid('commit tree ID is invalid');
    const policy = capturedProfileLimitPolicy(options.limitPolicy);
    const treeOutput = await gitBytes(options, ['-C', workspace.owned.path, 'ls-tree', '-rz', '--full-tree', commit], PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes, workspace);
    const entries = decodeTreeEntries(treeOutput);
    if (entries.length < 1 || entries.some((entry) => entry.mode !== '100644' || entry.type !== 'blob')) {
      throw invalid('commit tree contains a non-regular canonical entry');
    }
    const checkedOut = await checkoutCanonicalCapture(options, workspace, commit, policy);
    const { manifestBytes, profile, blobs } = checkedOut;
    const expectedEntries = ['bazframe-profile.json', ...profile.blobs.map((blob) => `blobs/${blob.sha256}`)];
    if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry.path !== expectedEntries[index])) {
      throw invalid('commit tree is not the exact canonical captured-profile tree');
    }
    snapshot = { branch: 'main', tip, commit, parent, tree, profile, manifestBytes, blobs };
  } catch (error) {
    operationError = error;
  } finally {
    try { await disposeGitWorkspace(workspace); }
    catch (cleanupError) { operationError = combineOperationAndCleanup(operationError, cleanupError); }
  }
  if (operationError !== undefined) throw operationError;
  return snapshot!;
}

/** Creates one new commit from a config-free owned index and exact-leases refs/heads/main. */
export async function publishCanonicalProfileGit(
  options: PublishCanonicalProfileGitOptions
): Promise<ProfileGithubPublicationEffects> {
  validateRemote(options, options.remoteUrl, true);
  if (options.expectedOld !== null && !COMMIT.test(options.expectedOld)) throw invalid('expected old commit is invalid');
  if (options.expectedOld === null && options.repositoryCreated !== true) {
    throw new BazframeError('PROFILE_GITHUB_CREATION_PROOF_REQUIRED', 'First publication requires proof that Bazframe just created the private repository.');
  }
  const localTestRemote = isLocalTestRemote(options.remoteUrl);
  const createdRepository = options.expectedOld === null && !localTestRemote
    ? {
        repositoryId: assertProfileGithubRepositoryCreationProof(options.repositoryCreationProof, options.remoteUrl),
        source: profileGithubSourceFromRemote(options.remoteUrl)
      }
    : undefined;
  if (options.expectedOld !== null && (options.repositoryCreated || options.repositoryCreationProof !== undefined)) throw invalid('repository-created proof is invalid for an existing publication');
  const source = validateCaptureSource(options.profile, options.blobs, capturedProfileLimitPolicy(options.limitPolicy));
  const workspace = await createGitWorkspace(options, 'bazframe-profile-publish-');
  let operationError: unknown;
  let effects: ProfileGithubPublicationEffects | undefined;
  try {
    await assertRemoteTip(options, workspace, options.expectedOld);
    if (options.expectedOld !== null) {
      await gitRequired(options, ['-C', workspace.owned.path, 'fetch', '--no-tags', options.remoteUrl, `${MAIN_REF}:${MAIN_REMOTE_REF}`], true, workspace);
      const fetched = (await gitText(options, ['-C', workspace.owned.path, 'rev-parse', MAIN_REMOTE_REF], false, 'PROFILE_GITHUB_FETCH_FAILED', 'GitHub publication base fetch failed.', workspace)).trim();
      if (fetched !== options.expectedOld) throw stale();
    }
    await writeCanonicalTree(workspace, source.manifestBytes, source.blobs);
    await gitRequired(options, ['-C', workspace.owned.path, 'read-tree', '--empty'], false, workspace);
    await gitRequired(options, ['-C', workspace.owned.path, 'add', '--', 'bazframe-profile.json', 'blobs'], false, workspace);
    const tree = (await gitText(options, ['-C', workspace.owned.path, 'write-tree'], false, 'PROFILE_GITHUB_COMMIT_FAILED', 'Captured Git tree could not be created.', workspace)).trim();
    if (!TREE.test(tree)) throw invalid('created tree ID is invalid');
    await assertRemoteTip(options, workspace, options.expectedOld);
    const commitArgs = [
      '-c', 'user.name=Bazframe', '-c', 'user.email=bazframe@invalid.example',
      '-C', workspace.owned.path, 'commit-tree', tree,
      ...(options.expectedOld === null ? [] : ['-p', options.expectedOld]),
      '-m', 'Bazframe profile publication'
    ];
    const commit = (await gitText(options, commitArgs, false, 'PROFILE_GITHUB_COMMIT_FAILED', 'Captured Git commit could not be created.', workspace)).trim();
    if (!COMMIT.test(commit)) throw invalid('created commit ID is invalid');
    const capturedManifestSha256 = createHash('sha256').update(source.manifestBytes).digest('hex');
    const intent: ProfileGithubRefUpdateIntent = { kind: 'profile-github-ref-update', ref: MAIN_REF, expectedOld: options.expectedOld, newCommit: commit, capturedManifestSha256 };
    await options.beforeRefUpdate?.(intent);
    await proveGitWorkspace(workspace);
    if (createdRepository !== undefined) {
      const metadata = await lookupProfileGithubRepository({ process: options.process, isolation: options.isolation, cwd: options.cwd }, createdRepository.source);
      if (metadata === undefined || metadata.repositoryId !== createdRepository.repositoryId || metadata.visibility !== 'private') {
        throw new BazframeError('PROFILE_GITHUB_CREATION_PROOF_STALE', 'The newly created private GitHub repository identity changed before publication.');
      }
      await proveGitWorkspace(workspace);
    }
    const lease = `${MAIN_REF}:${options.expectedOld ?? ''}`;
    const pushed = await git(options, ['-C', workspace.owned.path, 'push', options.remoteUrl, `${commit}:${MAIN_REF}`, `--force-with-lease=${lease}`], true, undefined, workspace);
    if (pushed.status !== 0 || pushed.failure !== undefined || pushed.error !== undefined || pushed.uncertainTermination === true) throw stale();
    const observed = await remoteTip(options, workspace);
    if (observed !== commit) throw new BazframeError('PROFILE_GITHUB_PUSH_UNPROVEN', 'Published Git commit could not be proved at refs/heads/main.');
    effects = {
      kind: 'profile-github-publication-effects',
      repositoryCreated: options.repositoryCreated,
      refUpdated: true,
      commitCreated: true,
      visibilityChanged: false,
      ref: MAIN_REF,
      expectedOld: options.expectedOld,
      commit,
      tree,
      capturedManifestSha256
    };
  } catch (error) {
    operationError = error;
  } finally {
    try { await disposeGitWorkspace(workspace); }
    catch (cleanupError) { operationError = combineOperationAndCleanup(operationError, cleanupError); }
  }
  if (operationError !== undefined) throw operationError;
  return effects!;
}

async function fetchMainHistory(remoteUrl: string, options: ProfileGithubGitOptions, workspace: GitWorkspace): Promise<string[]> {
  const fetched = await git(options, ['-C', workspace.owned.path, 'fetch', '--no-tags', remoteUrl, `${MAIN_REF}:${MAIN_REMOTE_REF}`], true, undefined, workspace);
  if (fetched.status !== 0 || fetched.failure !== undefined || fetched.error !== undefined || fetched.uncertainTermination === true) {
    throw new BazframeError('PROFILE_GITHUB_MAIN_UNAVAILABLE', 'GitHub profile repository has no readable refs/heads/main.');
  }
  const commitsText = await gitText(options, ['-C', workspace.owned.path, 'rev-list', MAIN_REMOTE_REF], false, 'PROFILE_GITHUB_GIT_READ_FAILED', 'Git main history could not be read.', workspace);
  const commits = nonemptyLines(commitsText);
  if (commits.length === 0 || commits.some((commit) => !COMMIT.test(commit)) || new Set(commits).size !== commits.length) throw invalid('refs/heads/main has no valid unique commits');
  return commits;
}

async function createGitWorkspace(options: ProfileGithubGitOptions, prefix: string): Promise<GitWorkspace> {
  await assertPhysicalDirectoryIdentity(options.isolation.directory);
  const owned = await createOwnedProfileGithubDirectory(options.quarantineParent, prefix);
  let gitDirectory: StableDirectory | undefined;
  try {
    await gitRequired(options, ['init', '--quiet', '--template=', owned.path], false, undefined, owned.path);
    const config = join(owned.path, '.git', 'config');
    await rm(config, { force: true });
    gitDirectory = await openStablePhysicalDirectory(join(owned.path, '.git'), owned.path);
    const workspace = { owned, gitDirectory, acquisitionLimits: managedGitAcquisitionLimitPolicy(options.acquisitionLimits) };
    await proveGitWorkspace(workspace);
    return workspace;
  } catch (error) {
    let failure: unknown = error;
    if (gitDirectory !== undefined) {
      try { await gitDirectory.handle.close(); }
      catch (closeError) { failure = combineOperationAndCleanup(failure, closeError); }
    }
    try { await owned.dispose(); }
    catch (cleanupError) { failure = combineOperationAndCleanup(failure, cleanupError); }
    throw failure;
  }
}

async function proveGitWorkspace(workspace: GitWorkspace): Promise<void> {
  await assertPhysicalDirectoryIdentity(workspace.owned.parent);
  await assertPhysicalDirectoryIdentity(workspace.owned.directory);
  await assertPhysicalDirectoryIdentity(workspace.gitDirectory);
  await assertAbsent(join(workspace.gitDirectory.path, 'config'), 'local Git config');
  await assertPhysicalAncestry(workspace.gitDirectory.path, join(workspace.gitDirectory.path, 'objects', 'info'));
  await assertAbsent(join(workspace.gitDirectory.path, 'objects', 'info', 'alternates'), 'Git object alternates');
  await inspectGitObjectsStable(workspace);
}

async function disposeGitWorkspace(workspace: GitWorkspace): Promise<void> {
  let failure: unknown;
  try { await workspace.gitDirectory.handle.close(); }
  catch (error) { failure = combineOperationAndCleanup(failure, error); }
  try { await workspace.owned.dispose(); }
  catch (error) { failure = combineOperationAndCleanup(failure, error); }
  if (failure !== undefined) throw failure;
}

function combineOperationAndCleanup(operation: unknown, cleanup: unknown): unknown {
  return operation === undefined
    ? cleanup
    : new AggregateError([operation, cleanup], 'GitHub operation and owned workspace cleanup both failed.', { cause: cleanup });
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try { await lstat(path); throw invalid(`${label} is forbidden`); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
}

async function assertRemoteTip(options: ProfileGithubGitOptions, workspace: GitWorkspace, expected: string | null): Promise<void> {
  const observed = await remoteTip(options, workspace);
  if (observed !== expected) throw stale();
}
async function remoteTip(options: ProfileGithubGitOptions, workspace: GitWorkspace): Promise<string | null> {
  const text = await gitText(options, ['-C', workspace.owned.path, 'ls-remote', '--heads', optionsRemote(options), MAIN_REF], true, 'PROFILE_GITHUB_REMOTE_FAILED', 'GitHub refs/heads/main could not be inspected.', workspace);
  if (text === '') return null;
  const lines = nonemptyLines(text);
  if (lines.length !== 1) throw invalid('remote refs/heads/main response is invalid');
  const [commit, ref, extra] = lines[0]!.split(/\s+/u);
  if (!COMMIT.test(commit ?? '') || ref !== MAIN_REF || extra !== undefined) throw invalid('remote refs/heads/main response is invalid');
  return commit!;
}
function optionsRemote(options: ProfileGithubGitOptions): string {
  if (!('remoteUrl' in options) || typeof options.remoteUrl !== 'string') throw invalid('publication remote is absent');
  return options.remoteUrl;
}

async function checkoutCanonicalCapture(
  options: ProfileGithubGitOptions,
  workspace: GitWorkspace,
  commit: string,
  policy: Readonly<CapturedProfileLimitPolicy>
): Promise<{ manifestBytes: Buffer; profile: CapturedProfileV1; blobs: ProfileGithubGitSnapshot['blobs'] }> {
  await gitRequired(options, ['-C', workspace.owned.path, 'read-tree', commit], false, workspace);
  const checkoutPath = join(workspace.owned.path, 'capture');
  await mkdir(checkoutPath, { mode: 0o700 });
  await gitRequired(options, ['-C', workspace.owned.path, 'checkout-index', '--all', `--prefix=${checkoutPath}/`], false, workspace);
  const root = await openStablePhysicalDirectory(checkoutPath, workspace.owned.path);
  let blobs: StableDirectory | undefined;
  try {
    const rootNames = await enumerateStableDirectory(root, 2);
    if (rootNames.join(',') !== 'bazframe-profile.json,blobs') throw invalid('checked-out capture root is not canonical');
    const manifest = await readStablePhysicalFile(stableReadChildPath(root, 'bazframe-profile.json'), policy.maxManifestBytes);
    const manifestBytes = Buffer.from(manifest.bytes);
    const profile = decodeCapturedProfileBytes(manifestBytes, policy);
    blobs = await openStablePhysicalDirectory(stableReadChildPath(root, 'blobs'), workspace.owned.path);
    const blobNames = await enumerateStableDirectory(blobs, policy.maxEntries);
    if (blobNames.length !== profile.blobs.length || blobNames.some((name, index) => name !== profile.blobs[index]!.sha256)) {
      throw invalid('checked-out blob closure does not match the canonical manifest');
    }
    const capturedBlobs: ProfileGithubGitSnapshot['blobs'] = [];
    for (const record of profile.blobs) {
      const file = await readStablePhysicalFile(stableReadChildPath(blobs, record.sha256), policy.maxBlobBytes);
      const bytesValue = Buffer.from(file.bytes);
      assertBlobBytes(record, bytesValue);
      capturedBlobs.push({ sha256: record.sha256, bytes: record.bytes, bytesValue });
    }
    await blobs.handle.close();
    blobs = undefined;
    return { manifestBytes, profile, blobs: capturedBlobs };
  } catch (error) {
    await blobs?.handle.close().catch(() => undefined);
    throw error;
  } finally {
    await root.handle.close().catch(() => undefined);
  }
}

async function writeCanonicalTree(workspace: GitWorkspace, manifestBytes: Buffer, blobs: readonly { sha256: Sha256; bytesValue: Buffer }[]): Promise<void> {
  await proveGitWorkspace(workspace);
  const blobsDirectory = join(workspace.owned.path, 'blobs');
  await mkdir(blobsDirectory, { mode: 0o700 });
  await writeExclusive(join(workspace.owned.path, 'bazframe-profile.json'), manifestBytes);
  for (const blob of blobs) await writeExclusive(join(blobsDirectory, blob.sha256), blob.bytesValue);
  await proveGitWorkspace(workspace);
}
async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function validateCaptureSource(profile: CapturedProfileV1, blobs: readonly ProfileGithubGitBlob[], policy: Readonly<CapturedProfileLimitPolicy>): { manifestBytes: Buffer; blobs: Array<{ sha256: Sha256; bytesValue: Buffer }> } {
  const validated = decodeCapturedProfileObject(profile, policy);
  if (blobs.length !== validated.blobs.length) throw invalid('blob source closure does not match manifest');
  const normalized = blobs.map((blob, index) => {
    const record = validated.blobs[index];
    if (record === undefined || record.sha256 !== blob.sha256 || record.bytes !== blob.bytes) throw invalid('blob source order does not match manifest');
    assertBlobBytes(record, blob.bytesValue);
    return { sha256: record.sha256, bytesValue: Buffer.from(blob.bytesValue) };
  });
  return { manifestBytes: Buffer.from(encodeCapturedProfile(validated, policy)), blobs: normalized };
}

function profileGithubSourceFromRemote(remoteUrl: string): CanonicalProfileGithubSource {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/u.exec(remoteUrl);
  if (match === null) throw invalid('canonical GitHub remote could not be decoded');
  return parseProfileGithubSource(`git:${match[1]}/${match[2]}`);
}

function isLocalTestRemote(remoteUrl: string): boolean {
  return remoteUrl.startsWith('file:') || remoteUrl.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(remoteUrl);
}
function validateRemote(options: ProfileGithubGitOptions, remoteUrl: string, publication: boolean): void {
  if (isLocalTestRemote(remoteUrl)) {
    if (options.allowFileProtocol !== true) throw invalid('local Git remotes require explicit test-only file protocol authority');
    return;
  }
  if (options.allowFileProtocol === true) throw invalid('file protocol authority is forbidden for production GitHub HTTPS');
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/u.exec(remoteUrl);
  try {
    if (match === null || canonicalProfileGitHubOrigin(`github.com/${match[1]}/${match[2]}`) !== `github.com/${match[1]}/${match[2]}`) throw new Error('noncanonical');
  } catch { throw invalid('remote must be canonical GitHub HTTPS'); }
  if (publication && options.authenticated !== true) throw new BazframeError('PROFILE_GITHUB_AUTH_REQUIRED', 'Publishing to GitHub requires authenticated gh credential-helper authority.');
}

async function gitRequired(options: ProfileGithubGitOptions, args: readonly string[], transfer = false, workspace?: GitWorkspace, cwd?: string): Promise<void> {
  const result = await git(options, args, transfer, undefined, workspace, cwd);
  assertProfileGithubCommand(result, 'PROFILE_GITHUB_GIT_FAILED', 'Isolated Git operation failed.');
}
async function gitText(options: ProfileGithubGitOptions, args: readonly string[], transfer: boolean, code: string, message: string, workspace?: GitWorkspace): Promise<string> {
  const result = await git(options, args, transfer, undefined, workspace);
  const text = assertProfileGithubCommand(result, code, message);
  if (Buffer.byteLength(text, 'utf8') > PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes) {
    throw new BazframeError('PROFILE_GITHUB_OUTPUT_LIMIT', 'Git text output exceeded its bounded capture limit.');
  }
  return text.trimEnd();
}
async function gitBytes(options: ProfileGithubGitOptions, args: readonly string[], maximum: number, workspace: GitWorkspace): Promise<Buffer> {
  const result = await git(options, args, false, maximum, workspace);
  assertProfileGithubCommand(result, 'PROFILE_GITHUB_GIT_READ_FAILED', 'Git captured-profile object could not be read.');
  const bytes = Buffer.from(result.stdoutBytes ?? Buffer.from(result.stdout, 'utf8'));
  if (bytes.byteLength > maximum) throw new BazframeError('PROFILE_GITHUB_OUTPUT_LIMIT', 'Git object output exceeded its bounded capture limit.');
  return bytes;
}
async function git(options: ProfileGithubGitOptions, args: readonly string[], transfer: boolean, maximum?: number, workspace?: GitWorkspace, cwd = options.cwd): Promise<ProfileGithubProcessResult> {
  await assertPhysicalDirectoryIdentity(options.isolation.directory);
  if (workspace !== undefined) await proveGitWorkspace(workspace);
  const result = await runProfileGithubCommand(options.process, options.isolation, 'git', args, workspace?.owned.path ?? cwd, {
    transfer,
    authenticated: options.authenticated,
    allowFileProtocol: options.allowFileProtocol,
    ...(maximum === undefined ? {} : { maxStdoutBytes: maximum }),
    ...(transfer && workspace !== undefined ? { monitor: () => inspectGitObjectsInProgress(workspace) } : {})
  });
  if (result.failure === 'monitor-failure' && result.monitorError instanceof BazframeError) throw result.monitorError;
  assertProfileGithubOutputConsistency(result);
  const stdout = result.stdoutBytes?.byteLength ?? Buffer.byteLength(result.stdout);
  if (stdout > (maximum ?? PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes)
    || Buffer.byteLength(result.stderr) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes) {
    throw new BazframeError('PROFILE_GITHUB_OUTPUT_LIMIT', 'Git process output exceeded its bounded capture limit.');
  }
  await assertPhysicalDirectoryIdentity(options.isolation.directory);
  if (workspace !== undefined) await proveGitWorkspace(workspace);
  return result;
}

interface GitObjectInspection { entries: number; bytes: number; evidence: string }

async function inspectGitObjectsInProgress(workspace: GitWorkspace): Promise<void> {
  await inspectGitObjects(workspace, false);
}

async function inspectGitObjectsStable(workspace: GitWorkspace): Promise<void> {
  const first = await inspectGitObjects(workspace, true);
  const second = await inspectGitObjects(workspace, true);
  if (first.entries !== second.entries || first.bytes !== second.bytes || first.evidence !== second.evidence) {
    throw invalid('Git object storage changed while being proved');
  }
}

async function inspectGitObjects(workspace: GitWorkspace, stable: boolean): Promise<GitObjectInspection> {
  const root = join(workspace.gitDirectory.path, 'objects');
  const state = { entries: 0n, bytes: 0n, evidence: [] as string[] };
  await inspectGitObjectDirectory(root, '', 0, workspace.acquisitionLimits, state, stable, true);
  return { entries: Number(state.entries), bytes: Number(state.bytes), evidence: state.evidence.join('\n') };
}

async function inspectGitObjectDirectory(
  path: string,
  relativePath: string,
  depth: number,
  limits: Readonly<ManagedGitAcquisitionLimitPolicy>,
  state: { entries: bigint; bytes: bigint; evidence: string[] },
  stable: boolean,
  root: boolean
): Promise<void> {
  let before;
  try { before = await lstat(path, { bigint: true }); }
  catch (error) {
    if (!root && !stable && errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) throw invalid('Git object storage contains a link or non-directory');
  let directory;
  try { directory = await opendir(path); }
  catch (error) {
    if (!root && !stable && errorCode(error) === 'ENOENT') return;
    throw error;
  }
  const names: string[] = [];
  try {
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      names.push(entry.name);
    }
  } finally { await directory.close().catch(() => undefined); }
  names.sort();
  for (const name of names) {
    const childRelative = relativePath === '' ? name : `${relativePath}/${name}`;
    const childDepth = depth + 1;
    if (childDepth > limits.maxStagingDepth || Buffer.byteLength(childRelative, 'utf8') > limits.maxStagingPathBytes) {
      throw objectLimit('path depth or bytes');
    }
    let metadata;
    try { metadata = await lstat(join(path, name), { bigint: true }); }
    catch (error) {
      if (!stable && errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    state.entries += 1n;
    if (state.entries > BigInt(limits.maxStagingEntries)) throw objectLimit('entry count');
    if (metadata.isSymbolicLink()) throw invalid('Git object storage contains a symbolic link');
    if (metadata.isDirectory()) {
      state.evidence.push(`d\0${childRelative}\0${metadata.dev}:${metadata.ino}`);
      await inspectGitObjectDirectory(join(path, name), childRelative, childDepth, limits, state, stable, false);
      continue;
    }
    if (!metadata.isFile()) throw invalid('Git object storage contains a special file');
    if (stable && metadata.nlink !== 1n) throw invalid('Git object storage contains a hard-linked file');
    state.bytes += metadata.size;
    if (state.bytes > BigInt(limits.maxGitObjectBytes) || state.bytes > BigInt(limits.maxStagingBytes)) throw objectLimit('aggregate bytes');
    state.evidence.push(`f\0${childRelative}\0${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`);
  }
  if (stable) {
    const after = await lstat(path, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw invalid('Git object directory changed while being proved');
  }
}

function objectLimit(detail: string): BazframeError {
  return new BazframeError('PROFILE_GITHUB_GIT_OBJECT_LIMIT', `Git object quarantine exceeded its bounded ${detail} limit.`);
}

function decodeTreeEntries(bytes: Uint8Array): Array<{ mode: string; type: string; path: string }> {
  const fields = Buffer.from(bytes).toString('utf8').split('\0');
  if (fields.at(-1) !== '') throw invalid('Git tree output is truncated');
  fields.pop();
  return fields.map((field) => {
    const match = /^(\d+) ([a-z]+) [a-f0-9]+\t(.+)$/u.exec(field);
    if (match === null) throw invalid('Git tree output is malformed');
    return { mode: match[1]!, type: match[2]!, path: match[3]! };
  });
}
function nonemptyLines(value: string): string[] { return value === '' ? [] : value.split('\n').filter((line) => line !== ''); }
function stale(): BazframeError { return new BazframeError('PROFILE_GITHUB_LEASE_STALE', 'GitHub refs/heads/main changed; publication was refused without merge, rewrite, or retry.'); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_GITHUB_GIT_INVALID', `Invalid captured-profile Git repository: ${detail}.`); }
