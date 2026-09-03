import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { encodeProfileCollectionReference } from '../profiles/profile-skill-collection-reference.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { profileDirectory, readActiveProfile, readOptionalActiveProfileSnapshot, type ActiveProfileSnapshot } from '../profiles/profile-store.js';
import { readDefaultSkillRegistrationLink } from '../skills/default-skill-catalog.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import {
  capturedProfileContentBaselineSha256,
  capturedResourceId,
  ordinaryResourceIdentity,
  profileLocalResourceIdentity,
  profileLocalResourceInstanceId,
  resourceIdentityDigest,
  type CapturedProfileV1,
  type CapturedResource,
  type Sha256
} from './captured-profile.js';
import { readOptionalManagedProfileState, writeCandidateManagedProfileState } from './managed-profile-state.js';
import {
  assertPhysicalProfileExpectation,
  capturePhysicalCandidateExpectation,
  capturePhysicalProfileExpectation,
  samePhysicalProfileExpectation,
  type PhysicalProfileClosureEntryV1,
  type PhysicalProfileExpectation
} from './physical-profile-closure.js';
import {
  assertPhysicalDirectoryIdentity,
  openStablePhysicalDirectory,
  readStablePhysicalFile,
  stableReadChildPath,
  writeOwnedStagingFileAtomic
} from './profile-filesystem.js';
import {
  assertOperationMutationAuthority,
  operationAuthorityTransactionId,
  withProfileOperationLocks,
  type OperationMutationAuthority
} from './profile-operation-lock.js';
import { captureProfile, isExcludedCapturedResourcePath, type ProfileCaptureSnapshot } from './profile-capture.js';
import type { CanonicalProfileGithubSource, ProfileGithubRepositoryMetadata } from './profile-github.js';
import type { ProfileGithubGitBlob, ProfileGithubPublicationEffects, ProfileGithubRefUpdateIntent } from './profile-github-git.js';
import { encodeManagedProfileState, type CapturedResourceIdBinding, type ManagedProfileStateV1, type PublicationState } from './publication-state.js';
import { noProfileLifecycleMutationEffects, type ProfileLifecycleMutationEffects } from './profile-lifecycle-effects.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { newTransactionId, writeTransactionJournal, type PublicationJournalV1, type PublicationPhase } from './transaction-journal.js';

export type PublishConfirmation = 'publish-preview' | 'public-visibility';

export interface ProfilePublicationAdapter {
  resolveSource(profileName: string, linkedOrigin: string | null): Promise<CanonicalProfileGithubSource>;
  lookup(source: CanonicalProfileGithubSource): Promise<ProfileGithubRepositoryMetadata | undefined>;
  readTip(source: CanonicalProfileGithubSource): Promise<string | null>;
  createPrivate(source: CanonicalProfileGithubSource): Promise<{ metadata: ProfileGithubRepositoryMetadata; proof: unknown }>;
  push(options: {
    source: CanonicalProfileGithubSource;
    profile: CapturedProfileV1;
    blobs: readonly ProfileGithubGitBlob[];
    expectedOld: string | null;
    repositoryCreated: boolean;
    creationProof?: unknown;
    beforeRefUpdate(intent: ProfileGithubRefUpdateIntent): Promise<void>;
  }): Promise<ProfileGithubPublicationEffects>;
  setVisibility(source: CanonicalProfileGithubSource, visibility: 'private' | 'public'): Promise<ProfileGithubRepositoryMetadata>;
}

export interface PublishManagedProfileOptions {
  home: string;
  profileName?: string;
  visibility?: 'preserve' | 'private' | 'public';
  bundleRemote?: boolean;
  yes?: boolean;
  authorize?: (confirmations: readonly PublishConfirmation[], preview: readonly ProfileCaptureSnapshot['preview'][number][]) => boolean | Promise<boolean>;
}

export interface PublishManagedProfileResult {
  profileName: string;
  repository: string;
  commit: string;
  visibility: 'private' | 'public';
  captureSha256: Sha256;
  capturedProfile: CapturedProfileV1;
  preview: ProfileCaptureSnapshot['preview'];
  effects: ProfileLifecycleMutationEffects & Omit<ProfileGithubPublicationEffects, 'repositoryCreated' | 'visibilityChanged'>;
  transactionId: string;
}

export async function publishManagedProfile(options: PublishManagedProfileOptions, adapter: ProfilePublicationAdapter): Promise<PublishManagedProfileResult> {
  const profileName = options.profileName ?? await readActiveProfile(options.home);
  assertSafeProfileId(profileName);
  const desiredVisibility = options.visibility ?? 'preserve';
  const initialExpectation = await capturePhysicalProfileExpectation(options.home, profileName);
  const initialState = await readOptionalManagedProfileState(options.home, profileName);
  if ((initialState?.sha256 ?? null) !== initialExpectation.sidecarSha256) throw changed();
  const captured = await captureProfile({ bazframeHome: options.home, profileId: profileName, bundleRemote: options.bundleRemote === true });
  await assertPhysicalProfileExpectation(options.home, profileName, initialExpectation);
  if (!captured.complete) throw new BazframeError('PROFILE_PUBLISH_INCOMPLETE', 'Incomplete profiles cannot be published; repair missing resources first.');
  const captureSha256 = sha256(captured.manifestBytes);
  const linked = initialState?.state.publication ?? null;
  if (linked !== null && linked.installedCommit !== linked.latestSeenCommit) {
    throw new BazframeError('PROFILE_VERSION_NOT_LATEST', 'Profile publishing requires the latest installed version.');
  }
  const source = await adapter.resolveSource(profileName, linked?.origin ?? null);
  if (linked !== null && source.origin !== linked.origin) throw invalid('publication adapter changed the linked origin');
  const repositoryBefore = await adapter.lookup(source);
  if (repositoryBefore !== undefined) assertRepositoryMetadata(repositoryBefore, source);
  if (linked === null && repositoryBefore !== undefined) throw new BazframeError('PROFILE_REPOSITORY_UNLINKED_EXISTS', 'The destination GitHub repository already exists but is not linked to this profile.');
  if (linked !== null && repositoryBefore === undefined) throw new BazframeError('PROFILE_REPOSITORY_MISSING', 'The linked GitHub repository no longer exists.');
  const remoteTip = await adapter.readTip(source);
  if (linked === null ? remoteTip !== null : remoteTip !== linked.installedCommit) throw new BazframeError('PROFILE_REMOTE_STALE', 'GitHub refs/heads/main is not the exact installed publication base.');

  const confirmations: PublishConfirmation[] = ['publish-preview'];
  if (desiredVisibility === 'public') confirmations.push('public-visibility');
  if (options.yes !== true && await options.authorize?.(confirmations, captured.preview) !== true) {
    throw new BazframeError('PROFILE_PUBLISH_CONFIRMATION_REQUIRED', 'Profile publication requires confirmation of the exact preview.');
  }
  await assertPhysicalProfileExpectation(options.home, profileName, initialExpectation);
  const transactionId = newTransactionId();
  return withProfileOperationLocks(options.home, [profileName, '@store'], (authority) => publishWithAuthority({
    options, adapter, profileName, desiredVisibility, captured, captureSha256, initialExpectation,
    previousState: initialState?.state, linked, source, repositoryBefore, authority
  }), transactionId);
}

async function publishWithAuthority(context: {
  options: PublishManagedProfileOptions;
  adapter: ProfilePublicationAdapter;
  profileName: string;
  desiredVisibility: 'preserve' | 'private' | 'public';
  captured: ProfileCaptureSnapshot;
  captureSha256: Sha256;
  initialExpectation: PhysicalProfileExpectation;
  previousState?: ManagedProfileStateV1;
  linked: PublicationState | null;
  source: CanonicalProfileGithubSource;
  repositoryBefore?: ProfileGithubRepositoryMetadata;
  authority: OperationMutationAuthority;
}): Promise<PublishManagedProfileResult> {
  const transactionId = operationAuthorityTransactionId(context.authority);
  await assertPhysicalProfileExpectation(context.options.home, context.profileName, context.initialExpectation);
  let journal: PublicationJournalV1 = {
    schemaVersion: 1,
    kind: 'publication',
    transactionId,
    profileName: context.profileName,
    expectedProfile: persistedExpectation(context.initialExpectation),
    origin: context.source.origin,
    expectedBaseCommit: context.linked?.installedCommit ?? null,
    capturedManifestSha256: context.captureSha256,
    originalVisibility: context.repositoryBefore?.visibility ?? 'absent',
    desiredVisibility: context.desiredVisibility,
    repositoryCreated: false,
    repositoryId: context.repositoryBefore?.repositoryId ?? null,
    observedCommit: null,
    phase: 'INTENT'
  };
  journal = await writeTransactionJournal(context.options.home, context.authority, journal);
  const advance = async (phase: PublicationPhase, updates: Partial<PublicationJournalV1> = {}): Promise<void> => {
    journal = await writeTransactionJournal(context.options.home, context.authority, { ...journal, ...updates, phase } as PublicationJournalV1);
  };

  let creationProof: unknown;
  let metadata = context.repositoryBefore;
  let repositoryId = metadata?.repositoryId;
  let effects: ProfileGithubPublicationEffects | undefined;
  let visibilityChanged = false;
  if (metadata === undefined) {
      const created = await context.adapter.createPrivate(context.source);
      metadata = created.metadata;
      creationProof = created.proof;
      assertRepositoryMetadata(metadata, context.source);
      repositoryId = metadata.repositoryId;
      if (metadata.visibility !== 'private') throw invalid('private repository creation was not proved');
      await assertPhysicalProfileExpectation(context.options.home, context.profileName, context.initialExpectation);
    }
    await advance('REPOSITORY_CREATED', { repositoryCreated: context.repositoryBefore === undefined, repositoryId: metadata.repositoryId });

    await advance('PRIVATE_BEFORE_PUSH_INTENT');
    if (context.desiredVisibility === 'private' && metadata.visibility !== 'private') {
      metadata = await context.adapter.setVisibility(context.source, 'private');
      visibilityChanged = true;
      assertRepositoryMetadata(metadata, context.source);
      if (metadata.repositoryId !== repositoryId || metadata.visibility !== 'private') throw invalid('private visibility was not proved');
    }
    await assertPhysicalProfileExpectation(context.options.home, context.profileName, context.initialExpectation);
    await advance('PRIVATE_BEFORE_PUSH_PROVEN');

    const revalidatedTip = await context.adapter.readTip(context.source);
    if (revalidatedTip !== (context.linked?.installedCommit ?? null)) throw new BazframeError('PROFILE_REMOTE_STALE', 'GitHub refs/heads/main changed before publication.');
    await assertCapturedProfileUnchanged(context.options.home, context.profileName, context.captured, context.options.bundleRemote === true);
    let pushIntentRecorded = false;
    effects = await context.adapter.push({
      source: context.source,
      profile: context.captured.profile,
      blobs: context.captured.blobs,
      expectedOld: context.linked?.installedCommit ?? null,
      repositoryCreated: context.repositoryBefore === undefined,
      ...(creationProof === undefined ? {} : { creationProof }),
      beforeRefUpdate: async (intent) => {
        if (pushIntentRecorded || intent.expectedOld !== (context.linked?.installedCommit ?? null) || intent.capturedManifestSha256 !== context.captureSha256) throw invalid('publication push intent is inconsistent');
        pushIntentRecorded = true;
        await assertCapturedProfileUnchanged(context.options.home, context.profileName, context.captured, context.options.bundleRemote === true);
        await advance('PUSH_INTENT');
      }
    });
    if (!pushIntentRecorded || !validEffects(effects, context.linked?.installedCommit ?? null, context.captureSha256, context.repositoryBefore === undefined)) throw invalid('publication push effects are inconsistent');
    const afterPush = await context.adapter.lookup(context.source);
    if (afterPush === undefined) throw invalid('repository disappeared after push');
    assertRepositoryMetadata(afterPush, context.source);
    if (afterPush.repositoryId !== repositoryId || afterPush.visibility !== metadata.visibility) throw invalid('repository identity or visibility changed during push');
    metadata = afterPush;
    await advance('COMMIT_PUSH_PROVEN', { observedCommit: effects.commit });

    await advance('PUBLIC_AFTER_PUSH_INTENT');
    if (context.desiredVisibility === 'public' && metadata.visibility !== 'public') {
      metadata = await context.adapter.setVisibility(context.source, 'public');
      visibilityChanged = true;
      assertRepositoryMetadata(metadata, context.source);
      if (metadata.repositoryId !== repositoryId || metadata.visibility !== 'public') throw invalid('public visibility was not proved');
    }
    await advance('PUBLIC_AFTER_PUSH_PROVEN');

    const currentExpectation = await capturePhysicalProfileExpectation(context.options.home, context.profileName);
    if (currentExpectation.identity !== context.initialExpectation.identity || currentExpectation.sidecarSha256 !== context.initialExpectation.sidecarSha256) throw changed();
    const finalVisibility = context.desiredVisibility === 'preserve' ? metadata.visibility : context.desiredVisibility;
    const state = buildPublishedProfileState(context.previousState, context.captured.profile.resources, {
      transport: 'git', origin: context.source.origin, installedCommit: effects.commit,
      latestSeenCommit: effects.commit, baselineCaptureSha256: capturedProfileContentBaselineSha256(context.captured.profile, capturedProfileLimitPolicy()), visibility: finalVisibility
    }, context.captured.profileInstanceId);
    await advance('LOCAL_STATE_INTENT');
    await publishSidecarCandidate(context.options.home, context.profileName, currentExpectation, state, context.authority);
    await advance('LOCAL_STATE_PROVEN');
    await advance('COMMITTED');
    await cleanupPublicationBackup(context.options.home, context.profileName, transactionId, currentExpectation, context.authority).catch(() => undefined);
    return {
      profileName: context.profileName,
      repository: context.source.origin,
      commit: effects.commit,
      visibility: finalVisibility,
      captureSha256: context.captureSha256,
      capturedProfile: structuredClone(context.captured.profile),
      preview: context.captured.preview.map((entry) => ({ ...entry })),
      effects: {
        ...noProfileLifecycleMutationEffects(),
        ...effects,
        localStateWritten: true,
        profilePublished: true,
        lockAcquired: true,
        repositoryCreated: context.repositoryBefore === undefined,
        refUpdated: effects.refUpdated,
        commitCreated: effects.commitCreated,
        visibilityChanged
      },
      transactionId
    };
}

export async function publishSidecarCandidate(
  home: string,
  profileName: string,
  expected: PhysicalProfileExpectation,
  state: ManagedProfileStateV1,
  authority: OperationMutationAuthority
): Promise<void> {
  const transactionId = operationAuthorityTransactionId(authority);
  assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
  const profilesRoot = join(home, 'profiles');
  const candidatePath = join(profilesRoot, `.bazframe-candidate-${transactionId}`);
  const backupPath = join(profilesRoot, `.bazframe-backup-${transactionId}`);
  await ensureManagedDirectory(home, profilesRoot);
  assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
  await assertAbsent(candidatePath, 'publication candidate');
  await assertAbsent(backupPath, 'publication backup');
  await mkdir(candidatePath, { mode: 0o700 });
  const candidate = await openStablePhysicalDirectory(candidatePath, home);
  try {
    await copyPhysicalClosure(home, profileName, expected, candidate);
    await writeCandidateManagedProfileState(home, candidatePath, state);
    await assertPhysicalDirectoryIdentity(candidate);
  } finally { await candidate.handle.close().catch(() => undefined); }
  const candidateExpectation = await capturePhysicalCandidateExpectation(home, candidatePath, profileName);
  const activeBefore = await readOptionalActiveProfileSnapshot(home);
  await withStateLock(join(home, 'locks', 'state.lock'), { command: 'profile-publish-state', target: profileName }, async () => {
    await assertPhysicalProfileExpectation(home, profileName, expected);
    await assertSameActive(activeBefore, await readOptionalActiveProfileSnapshot(home));
    await assertAbsent(backupPath, 'publication backup');
    assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
    await rename(profileDirectory(home, profileName), backupPath);
    await syncDirectory(profilesRoot);
    const backupExpectation = await capturePhysicalCandidateExpectation(home, backupPath, profileName);
    if (!samePhysicalProfileExpectation(backupExpectation, expected)) throw changed();
    assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
    await rename(candidatePath, profileDirectory(home, profileName));
    await syncDirectory(profilesRoot);
    const published = await capturePhysicalProfileExpectation(home, profileName);
    if (published.identity !== candidateExpectation.identity || published.profileClosureSha256 !== candidateExpectation.profileClosureSha256 || published.sidecarSha256 !== candidateExpectation.sidecarSha256) throw changed();
    await assertSameActive(activeBefore, await readOptionalActiveProfileSnapshot(home));
  }, { managedRoot: home });
}

export async function recoverPublishedSidecarCandidate(
  home: string,
  profileName: string,
  prior: PublicationJournalV1['expectedProfile'],
  state: ManagedProfileStateV1,
  authority: OperationMutationAuthority
): Promise<void> {
  const transactionId = operationAuthorityTransactionId(authority);
  assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
  const profilesRoot = join(home, 'profiles');
  const destination = profileDirectory(home, profileName);
  const candidatePath = join(profilesRoot, `.bazframe-candidate-${transactionId}`);
  const backupPath = join(profilesRoot, `.bazframe-backup-${transactionId}`);
  const desiredSidecar = sha256(Buffer.from(encodeManagedProfileState(state, capturedProfileLimitPolicy())));
  const [current, candidate, backup] = await Promise.all([
    optionalProfileExpectation(home, profileName),
    optionalCandidateExpectation(home, candidatePath, profileName),
    optionalCandidateExpectation(home, backupPath, profileName)
  ]);
  const priorMatches = (value: PhysicalProfileExpectation | undefined): boolean => value !== undefined && value.identity === prior.identity && value.sidecarSha256 === prior.sidecarSha256;
  const publishedMatches = (value: PhysicalProfileExpectation | undefined): boolean => value !== undefined && value.sidecarSha256 === desiredSidecar;
  if (current !== undefined && priorMatches(current) && candidate === undefined && backup === undefined) {
    await publishSidecarCandidate(home, profileName, current, state, authority);
    return;
  }
  if (publishedMatches(current) && candidate === undefined && backup === undefined) return;
  const activeBefore = await readOptionalActiveProfileSnapshot(home);
  await withStateLock(join(home, 'locks', 'state.lock'), { command: 'profile-publish-recovery', target: profileName }, async () => {
    await assertSameActive(activeBefore, await readOptionalActiveProfileSnapshot(home));
    assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
    if (current !== undefined && priorMatches(current) && publishedMatches(candidate) && backup === undefined && sameContentIgnoringSidecar(current, candidate!)) {
      await rename(destination, backupPath); await syncDirectory(profilesRoot);
      const moved = await capturePhysicalCandidateExpectation(home, backupPath, profileName);
      if (!priorMatches(moved)) throw changed();
      assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
      await rename(candidatePath, destination); await syncDirectory(profilesRoot);
    } else if (current === undefined && priorMatches(backup) && publishedMatches(candidate) && sameContentIgnoringSidecar(backup!, candidate!)) {
      await rename(candidatePath, destination); await syncDirectory(profilesRoot);
    } else if (!(publishedMatches(current) && priorMatches(backup) && sameContentIgnoringSidecar(backup!, current!))) {
      throw changed();
    }
    const proved = await capturePhysicalProfileExpectation(home, profileName);
    if (!publishedMatches(proved)) throw changed();
    await assertSameActive(activeBefore, await readOptionalActiveProfileSnapshot(home));
  }, { managedRoot: home });
}

async function optionalProfileExpectation(home: string, profileName: string): Promise<PhysicalProfileExpectation | undefined> {
  try { return await capturePhysicalProfileExpectation(home, profileName); }
  catch (error) { if (errorCode(error) === 'ENOENT' || (error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT')) return undefined; throw error; }
}
async function optionalCandidateExpectation(home: string, path: string, profileName: string): Promise<PhysicalProfileExpectation | undefined> {
  try { return await capturePhysicalCandidateExpectation(home, path, profileName); }
  catch (error) { if (errorCode(error) === 'ENOENT' || (error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT')) return undefined; throw error; }
}
function sameContentIgnoringSidecar(left: PhysicalProfileExpectation, right: PhysicalProfileExpectation): boolean {
  const strip = (value: PhysicalProfileExpectation) => value.closure.entries.filter((entry) => entry.kind !== 'managed-sidecar');
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

export async function copyPhysicalProfileClosureToCandidate(home: string, profileName: string, expected: PhysicalProfileExpectation, candidatePath: string): Promise<void> {
  const resolvedCandidate = resolve(candidatePath);
  if (dirname(resolvedCandidate) !== resolve(home, 'profiles') || !/^\.bazframe-candidate-[a-f0-9]{32}$/u.test(basename(resolvedCandidate))) throw invalid('profile copy destination is not a reserved candidate');
  const candidate = await openStablePhysicalDirectory(resolvedCandidate, home);
  try { await copyPhysicalClosure(home, profileName, expected, candidate); }
  finally { await candidate.handle.close().catch(() => undefined); }
}

async function copyPhysicalClosure(home: string, profileName: string, expected: PhysicalProfileExpectation, candidate: Awaited<ReturnType<typeof openStablePhysicalDirectory>>): Promise<void> {
  await assertPhysicalProfileExpectation(home, profileName, expected);
  const source = await openStablePhysicalDirectory(profileDirectory(home, profileName), home);
  try {
    const instructionEntry = expected.closure.entries.find((entry) => entry.path === 'AGENTS.md');
    if (instructionEntry === undefined || instructionEntry.kind !== 'file') throw invalid('profile instruction closure is absent');
    const instructions = await readStablePhysicalFile(stableReadChildPath(source, 'AGENTS.md'), instructionEntry.bytes);
    if (instructions.bytes.byteLength !== instructionEntry.bytes || instructions.executable !== instructionEntry.executable || sha256(instructions.bytes) !== instructionEntry.sha256) throw changed();
    await writeOwnedStagingFileAtomic(candidate, 'AGENTS.md', instructions.bytes, instructions.executable ? 0o700 : 0o600);
    for (const entry of expected.closure.entries) await copyProfileEntry(home, source.path, candidate.path, entry);
    await assertPhysicalProfileExpectation(home, profileName, expected);
  } finally { await source.handle.close().catch(() => undefined); }
}

export async function copyPhysicalProfileLocalExcludedToCandidate(home: string, profileName: string, expected: PhysicalProfileExpectation, candidatePath: string, retainedSkillNames: ReadonlySet<string>): Promise<void> {
  const sourcePath = profileDirectory(home, profileName);
  for (const entry of expected.closure.entries) {
    if (entry.kind !== 'file') continue;
    const match = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/u.exec(entry.path);
    if (match === null || !retainedSkillNames.has(match[1]!) || !isExcludedCapturedResourcePath(match[2]!)) continue;
    await copyProfileEntry(home, sourcePath, candidatePath, entry);
  }
  await assertPhysicalProfileExpectation(home, profileName, expected);
}

async function copyProfileEntry(home: string, sourcePath: string, candidatePath: string, entry: PhysicalProfileClosureEntryV1): Promise<void> {
  if (entry.kind === 'file') {
    if (entry.path === 'AGENTS.md') return;
    const source = await readStablePhysicalFile(join(sourcePath, ...entry.path.split('/')), entry.bytes);
    if (source.bytes.byteLength !== entry.bytes || source.executable !== entry.executable || sha256(source.bytes) !== entry.sha256) throw changed();
    const parts = entry.path.split('/');
    const name = parts.pop()!;
    const parentPath = join(candidatePath, ...parts);
    await mkdir(parentPath, { recursive: true, mode: 0o700 });
    const parent = await openStablePhysicalDirectory(parentPath, candidatePath);
    try { await writeOwnedStagingFileAtomic(parent, name, source.bytes, source.executable ? 0o700 : 0o600); }
    finally { await parent.handle.close().catch(() => undefined); }
    return;
  }
  if (entry.kind !== 'membership-link') return;
  const [catalog, kind, name] = entry.targetIdentity.split(':');
  if (catalog !== 'catalog' || name === undefined) throw invalid('ordinary membership identity is malformed');
  if (kind === 'skill') {
    const registration = await readDefaultSkillRegistrationLink(home, name);
    await mkdir(join(candidatePath, 'skills'), { recursive: true, mode: 0o700 });
    await symlink(registration.target, join(candidatePath, entry.path));
    await syncDirectory(join(candidatePath, 'skills'));
    return;
  }
  if (kind !== 'library' && kind !== 'package') throw invalid('ordinary membership kind is malformed');
  const directory = kind === 'library' ? 'libraries' : 'packages';
  await mkdir(join(candidatePath, directory), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(encodeProfileCollectionReference(kind === 'library' ? { schemaVersion: 1, library: name } : { schemaVersion: 1, package: name }));
  const target = await openStablePhysicalDirectory(join(candidatePath, directory), candidatePath);
  try { await writeOwnedStagingFileAtomic(target, `${name}.json`, bytes); }
  finally { await target.handle.close().catch(() => undefined); }
}

export function buildPublishedProfileState(previous: ManagedProfileStateV1 | undefined, resources: readonly CapturedResource[], publication: PublicationState, requestedProfileInstanceId?: string): ManagedProfileStateV1 {
  const profileInstanceId = previous?.profileInstanceId ?? requestedProfileInstanceId ?? randomUUID();
  if (previous !== undefined && requestedProfileInstanceId !== undefined && requestedProfileInstanceId !== previous.profileInstanceId) throw invalid('captured profile instance identity changed');
  const previousBindingByCapture = new Map((previous?.capturedResourceIds ?? []).map((binding) => [binding.capturedResourceId, { ...binding }]));
  const importedIds = new Set((previous?.importedResources ?? []).map((resource) => resource.capturedResourceId));
  for (const resource of resources) {
    const ordinaryIdentity = ordinaryResourceIdentity(resource.key.kind, resource.key.name);
    const ordinaryDigest = resourceIdentityDigest(ordinaryIdentity);
    const localInstanceId = resource.key.kind === 'skill' ? profileLocalResourceInstanceId(profileInstanceId, resource.key.name) : undefined;
    const localIdentity = localInstanceId === undefined ? undefined : profileLocalResourceIdentity(localInstanceId);
    const localDigest = localIdentity === undefined ? undefined : resourceIdentityDigest(localIdentity);
    const retained = previousBindingByCapture.get(resource.id);
    if (retained !== undefined) {
      if (retained.identityKind === 'catalog' && (retained.instanceId !== null || retained.resourceIdentityDigest !== ordinaryDigest)) throw invalid('retained ordinary resource binding does not match its key');
      if (retained.identityKind === 'profileLocal' && (localInstanceId === undefined || retained.instanceId !== localInstanceId || retained.resourceIdentityDigest !== localDigest)) throw invalid('retained profile-local resource binding does not match its key');
      if (retained.identityKind === 'imported' && !importedIds.has(resource.id)) throw invalid('retained imported resource binding has no imported resource state');
      continue;
    }
    if (importedIds.has(resource.id)) throw invalid('imported resource binding was lost');
    let binding: CapturedResourceIdBinding;
    if (resource.id === capturedResourceId(resource.key.kind, ordinaryIdentity)) {
      binding = { resourceIdentityDigest: ordinaryDigest, capturedResourceId: resource.id, identityKind: 'catalog', instanceId: null };
    } else if (localIdentity !== undefined && localDigest !== undefined && resource.id === capturedResourceId('skill', localIdentity)) {
      binding = { resourceIdentityDigest: localDigest, capturedResourceId: resource.id, identityKind: 'profileLocal', instanceId: localInstanceId! };
    } else {
      throw invalid('new captured resource has no proved catalog or profile-local identity');
    }
    for (const [capturedId, existing] of previousBindingByCapture) if (existing.resourceIdentityDigest === binding.resourceIdentityDigest) previousBindingByCapture.delete(capturedId);
    previousBindingByCapture.set(resource.id, binding);
  }
  const currentIds = new Set(resources.map((resource) => resource.id));
  for (const [capturedId, binding] of previousBindingByCapture) if (binding.identityKind === 'profileLocal' && !currentIds.has(capturedId)) previousBindingByCapture.delete(capturedId);
  const capturedResourceIds: CapturedResourceIdBinding[] = [...previousBindingByCapture.values()]
    .sort((left, right) => left.resourceIdentityDigest.localeCompare(right.resourceIdentityDigest) || left.capturedResourceId.localeCompare(right.capturedResourceId));
  return {
    schemaVersion: 1,
    profileInstanceId,
    publication,
    capturedResourceIds,
    importedResources: structuredClone(previous?.importedResources ?? [])
  };
}

function persistedExpectation(value: PhysicalProfileExpectation): PublicationJournalV1['expectedProfile'] {
  return { identity: value.identity, sidecarSha256: value.sidecarSha256, profileClosureSha256: value.profileClosureSha256 };
}
async function assertAbsent(path: string, label: string): Promise<void> { try { await lstat(path); } catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; } throw invalid(`${label} is occupied`); }
async function assertSameActive(left: ActiveProfileSnapshot | undefined, right: ActiveProfileSnapshot | undefined): Promise<void> { if (left === undefined || right === undefined) { if (left === right) return; throw changed(); } if (left.profileId !== right.profileId || left.device !== right.device || left.inode !== right.inode || left.contentSha256 !== right.contentSha256) throw changed(); }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
function assertRepositoryMetadata(metadata: ProfileGithubRepositoryMetadata, source: CanonicalProfileGithubSource): void {
  if (!Number.isSafeInteger(metadata.repositoryId) || metadata.repositoryId <= 0 || metadata.origin !== source.origin
    || metadata.owner !== source.owner || metadata.repository !== source.repository
    || (metadata.visibility !== 'private' && metadata.visibility !== 'public')) throw invalid('repository metadata is inconsistent');
}
function validEffects(effects: ProfileGithubPublicationEffects, expectedOld: string | null, captureSha256: Sha256, repositoryCreated: boolean): boolean {
  return effects.kind === 'profile-github-publication-effects' && effects.repositoryCreated === repositoryCreated
    && effects.refUpdated === true && effects.commitCreated === true && effects.visibilityChanged === false
    && effects.ref === 'refs/heads/main' && effects.expectedOld === expectedOld
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(effects.commit)
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(effects.tree)
    && effects.capturedManifestSha256 === captureSha256;
}
async function assertCapturedProfileUnchanged(home: string, profileName: string, expected: ProfileCaptureSnapshot, bundleRemote: boolean): Promise<void> {
  const current = await captureProfile({ bazframeHome: home, profileId: profileName, bundleRemote });
  if (!current.manifestBytes.equals(expected.manifestBytes)
    || current.blobs.length !== expected.blobs.length
    || current.blobs.some((blob, index) => blob.sha256 !== expected.blobs[index]?.sha256 || !blob.bytesValue.equals(expected.blobs[index]!.bytesValue))) throw changed();
}

async function cleanupPublicationBackup(home: string, profileName: string, transactionId: string, expected: PhysicalProfileExpectation, authority: OperationMutationAuthority): Promise<void> {
  assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
  const profilesRoot = join(home, 'profiles');
  const backupPath = join(profilesRoot, `.bazframe-backup-${transactionId}`);
  const backup = await capturePhysicalCandidateExpectation(home, backupPath, profileName);
  if (!samePhysicalProfileExpectation(backup, expected)) throw changed();
  assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
  const retainedPath = join(profilesRoot, `.bazframe-backup-${randomBytes(16).toString('hex')}`);
  await rename(backupPath, retainedPath);
  await syncDirectory(profilesRoot);
  const retained = await capturePhysicalCandidateExpectation(home, retainedPath, profileName);
  if (!samePhysicalProfileExpectation(retained, expected)) throw changed();
  // Retain the proved backup outside the live transaction namespace. Node has
  // no handle-relative recursive removal primitive, so pathname deletion would
  // permit a same-user substitution after the identity proof.
}

function sha256(bytes: Uint8Array): Sha256 { return createHash('sha256').update(bytes).digest('hex'); }
function changed(): BazframeError { return new BazframeError('PROFILE_PUBLICATION_CHANGED', 'Profile changed during publication; remote effects were retained for recovery and local state was not overwritten.'); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_PUBLICATION_INVALID', `Invalid profile publication operation: ${detail}.`); }
