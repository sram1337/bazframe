import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { withProfileOperationLocks } from '../../../src/profile-publishing/profile-operation-lock.js';
import { capturePhysicalCandidateExpectation, capturePhysicalProfileExpectation } from '../../../src/profile-publishing/physical-profile-closure.js';
import { writeCandidateManagedProfileState } from '../../../src/profile-publishing/managed-profile-state.js';
import { readTransactionJournal, writeTransactionJournal, type CandidatePhase, type CandidateSwapJournalV1, type PublicationJournalV1, type RenamePhase, type RenameProfileJournalV1 } from '../../../src/profile-publishing/transaction-journal.js';
import { recoverProfilePublishingTransactions } from '../../../src/profile-publishing/profile-recovery.js';
import type { ManagedProfileStateV1 } from '../../../src/profile-publishing/publication-state.js';
import { capturedProfileContentBaselineSha256, encodeCapturedProfile, profileInstanceIdFromPhysicalIdentity, profileLocalResourceInstanceId, type CapturedProfileV1 } from '../../../src/profile-publishing/captured-profile.js';
import { captureProfile } from '../../../src/profile-publishing/profile-capture.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import { buildPublishedProfileState } from '../../../src/profile-publishing/profile-publication.js';
import { encodeProfileFavorites, writeProfileFavoritesUnlocked } from '../../../src/profiles/profile-favorites.js';
import { writeActiveProfile } from '../../../src/profiles/profile-store.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });
const tx = '0123456789abcdef0123456789abcdef';
const state: ManagedProfileStateV1 = { schemaVersion: 1, profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publication: null, capturedResourceIds: [], importedResources: [] };
async function setup() { temporary = await createTempDirectory('/tmp/bzf-recover-'); await mkdir(temporary.path('profiles'), { recursive: true }); return temporary.root; }

async function stageCandidate(home: string, name: string) {
  const path = join(home, 'profiles', `.bazframe-candidate-${tx}`);
  await mkdir(path); await writeFile(join(path, 'AGENTS.md'), `${name}\n`);
  await withProfileOperationLocks(home, [name, '@store'], async () => { await writeCandidateManagedProfileState(home, path, state); }, tx);
  return { path, expectation: await capturePhysicalCandidateExpectation(home, path, name) };
}

function publicationProof(profile: CapturedProfileV1, origin: string, commit: string, repositoryId = 42, blobBytes?: readonly { sha256: string; bytes: number; bytesValue: Uint8Array }[]) {
  const manifestBytes = Buffer.from(encodeCapturedProfile(profile, capturedProfileLimitPolicy()));
  return {
    captureSha: createHash('sha256').update(manifestBytes).digest('hex'),
    proof: {
      repositoryIdentityProven: true as const, repositoryId, origin, visibility: 'private' as const,
      tip: commit, tipParent: null, tree: 'b'.repeat(40), canonicalTreeProven: true,
      capturedManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), manifestBytes, profile,
      blobs: blobBytes?.map((blob) => ({ ...blob, bytesValue: Buffer.from(blob.bytesValue) })) ?? profile.blobs.map((blob) => ({ sha256: blob.sha256, bytes: blob.bytes, bytesValue: Buffer.from('work\n') }))
    }
  };
}

function baseCandidate(name: string, expectation: Awaited<ReturnType<typeof capturePhysicalCandidateExpectation>>, old?: Awaited<ReturnType<typeof capturePhysicalProfileExpectation>>): CandidateSwapJournalV1 {
  return {
    schemaVersion: 1, kind: 'candidate-swap', transactionId: tx, operation: old === undefined ? 'fresh-import' : 'update', profileName: name,
    expectedOld: old === undefined ? { kind: 'absent' } : { kind: 'physical-directory', identity: old.identity, sidecarSha256: old.sidecarSha256, profileClosureSha256: old.profileClosureSha256 },
    candidate: { token: `candidate:${tx}`, identity: expectation.identity, sidecarSha256: expectation.sidecarSha256, profileClosureSha256: expectation.profileClosureSha256 },
    backup: null, activeProfileBefore: null, phase: 'CANDIDATE_READY', possiblePackageEffects: []
  };
}

async function persistCandidateJournal(home: string, ready: CandidateSwapJournalV1, finalPhase: CandidateSwapJournalV1['phase']) {
  await withProfileOperationLocks(home, [ready.profileName, '@store'], async (authority) => {
    let journal = { ...ready, candidate: { ...ready.candidate, identity: null, sidecarSha256: null, profileClosureSha256: null }, phase: 'PLANNED' } as CandidateSwapJournalV1;
    journal = await writeTransactionJournal(home, authority, journal);
    for (const phase of ['MATERIALIZING', 'PACKAGES_LAST', 'CANDIDATE_READY'] as const) journal = await writeTransactionJournal(home, authority, { ...journal, candidate: phase === 'CANDIDATE_READY' ? ready.candidate : journal.candidate, phase });
    if (finalPhase === 'OLD_RENAME_INTENT') await writeTransactionJournal(home, authority, { ...journal, phase: finalPhase });
  }, tx);
}

describe('hidden transaction crash recovery', () => {
  it.each(['PLANNED','MATERIALIZING','PACKAGES_LAST','CANDIDATE_READY','CANDIDATE_RENAME_INTENT','CANDIDATE_RENAME_PROVEN','ACTIVE_SELECTION_PROVEN'] as CandidatePhase[])('recovers a fresh candidate crash after durable phase %s', async (faultPhase) => {
    const home = await setup();
    const candidate = await stageCandidate(home, 'work');
    const ready = baseCandidate('work', candidate.expectation);
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      let journal = { ...ready, candidate: { ...ready.candidate, identity: null, sidecarSha256: null, profileClosureSha256: null }, phase: 'PLANNED' } as CandidateSwapJournalV1;
      journal = await writeTransactionJournal(home, authority, journal);
      if (faultPhase === 'PLANNED') return;
      for (const phase of ['MATERIALIZING','PACKAGES_LAST','CANDIDATE_READY'] as const) {
        journal = await writeTransactionJournal(home, authority, { ...journal, candidate: phase === 'CANDIDATE_READY' ? ready.candidate : journal.candidate, phase });
        if (phase === faultPhase) return;
      }
      journal = await writeTransactionJournal(home, authority, { ...journal, phase: 'CANDIDATE_RENAME_INTENT' });
      if (faultPhase === 'CANDIDATE_RENAME_INTENT') return;
      await rename(candidate.path, join(home, 'profiles', 'work'));
      journal = await writeTransactionJournal(home, authority, { ...journal, phase: 'CANDIDATE_RENAME_PROVEN' });
      if (faultPhase === 'CANDIDATE_RENAME_PROVEN') return;
      await writeTransactionJournal(home, authority, { ...journal, phase: 'ACTIVE_SELECTION_PROVEN' });
    }, tx);

    const result = (await recoverProfilePublishingTransactions(home))[0]!;
    expect(result.action).toBe(['PLANNED','MATERIALIZING','PACKAGES_LAST'].includes(faultPhase) ? 'aborted' : 'committed');
  });

  it.each(['INTENT','DIRECTORY_RENAME_INTENT','DIRECTORY_RENAME_PROVEN','ACTIVE_SELECTION_INTENT','ACTIVE_SELECTION_PROVEN','FAVORITES_INTENT','FAVORITES_PROVEN'] as RenamePhase[])('recovers a rename crash after durable phase %s', async (faultPhase) => {
    const home = await setup();
    await mkdir(join(home, 'profiles', 'work'));
    await writeFile(join(home, 'profiles', 'work', 'AGENTS.md'), 'work\n');
    const expected = await capturePhysicalProfileExpectation(home, 'work');
    const initial: RenameProfileJournalV1 = {
      schemaVersion: 1, kind: 'rename-profile', transactionId: tx, oldName: 'work', newName: 'renamed',
      expectedOld: { identity: expected.identity, sidecarSha256: expected.sidecarSha256, profileClosureSha256: expected.profileClosureSha256 },
      expectedNew: { kind: 'absent' }, activeBefore: null, activeAfter: null,
      favoritesBeforeSha256: null, favoritesAfterCanonicalBytesSha256: null, phase: 'INTENT'
    };
    await withProfileOperationLocks(home, ['work', 'renamed', '@store'], async (authority) => {
      let journal = await writeTransactionJournal(home, authority, initial);
      if (faultPhase === 'INTENT') return;
      journal = await writeTransactionJournal(home, authority, { ...journal, phase: 'DIRECTORY_RENAME_INTENT' });
      if (faultPhase === 'DIRECTORY_RENAME_INTENT') return;
      await rename(join(home, 'profiles', 'work'), join(home, 'profiles', 'renamed'));
      for (const phase of ['DIRECTORY_RENAME_PROVEN','ACTIVE_SELECTION_INTENT','ACTIVE_SELECTION_PROVEN','FAVORITES_INTENT','FAVORITES_PROVEN'] as const) {
        journal = await writeTransactionJournal(home, authority, { ...journal, phase });
        if (phase === faultPhase) return;
      }
    }, tx);

    const result = (await recoverProfilePublishingTransactions(home))[0]!;
    expect(result.action).toBe(faultPhase === 'INTENT' ? 'aborted' : 'committed');
  });

  it('skips a live operation lock nonblocking, then finishes a proved fresh candidate rename', async () => {
    const home = await setup(); const candidate = await stageCandidate(home, 'work');
    await persistCandidateJournal(home, baseCandidate('work', candidate.expectation), 'CANDIDATE_READY');
    await withProfileOperationLocks(home, ['work', '@store'], async () => {
      expect(await recoverProfilePublishingTransactions(home)).toEqual([{ transactionId: tx, kind: 'candidate-swap', action: 'skipped-busy' }]);
    }, tx);
    expect(await recoverProfilePublishingTransactions(home)).toEqual([{ transactionId: tx, kind: 'candidate-swap', action: 'committed' }]);
    expect(await temporary!.readText('profiles/work/AGENTS.md')).toBe('work\n');
  });

  it('finishes both existing-profile rename windows only from exact old/candidate proofs', async () => {
    const home = await setup(); await mkdir(join(home, 'profiles', 'work')); await writeFile(join(home, 'profiles', 'work', 'AGENTS.md'), 'old\n');
    const old = await capturePhysicalProfileExpectation(home, 'work'); const candidate = await stageCandidate(home, 'work');
    await persistCandidateJournal(home, baseCandidate('work', candidate.expectation, old), 'OLD_RENAME_INTENT');
    await rename(join(home, 'profiles', 'work'), join(home, 'profiles', `.bazframe-backup-${tx}`));
    expect((await recoverProfilePublishingTransactions(home))[0]).toMatchObject({ action: 'committed' });
    expect(await temporary!.readText('profiles/work/AGENTS.md')).toBe('work\n');
    expect(await recoverProfilePublishingTransactions(home)).toEqual([{ transactionId: tx, kind: 'candidate-swap', action: 'terminal' }]);
  });

  it('recovers an exact pushed publication and finishes the local sidecar transaction', async () => {
    const home = await setup(); await mkdir(join(home, 'profiles', 'work')); await writeFile(join(home, 'profiles', 'work', 'AGENTS.md'), 'work\n');
    const expected = await capturePhysicalProfileExpectation(home, 'work');
    const bytes = Buffer.from('work\n'); const digest = createHash('sha256').update(bytes).digest('hex');
    const profile: CapturedProfileV1 = { schemaVersion: 1, kind: 'bazframe-captured-profile', profile: { name: 'work', instructions: { path: 'AGENTS.md', sha256: digest, bytes: bytes.length, executable: false } }, resources: [], blobs: [{ sha256: digest, bytes: bytes.length }] };
    const commit = 'a'.repeat(40); const remote = publicationProof(profile, 'github.com/owner/work', commit);
    const journal: PublicationJournalV1 = { schemaVersion: 1, kind: 'publication', transactionId: tx, profileName: 'work', expectedProfile: { identity: expected.identity, sidecarSha256: null, profileClosureSha256: expected.profileClosureSha256 }, origin: 'github.com/owner/work', expectedBaseCommit: null, capturedManifestSha256: remote.captureSha, originalVisibility: 'absent', desiredVisibility: 'private', repositoryCreated: true, repositoryId: 42, observedCommit: null, phase: 'PUSH_INTENT' };
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      let current = { ...journal, repositoryCreated: false, repositoryId: null, phase: 'INTENT' } as PublicationJournalV1;
      current = await writeTransactionJournal(home, authority, current);
      for (const phase of ['REPOSITORY_CREATED','PRIVATE_BEFORE_PUSH_INTENT','PRIVATE_BEFORE_PUSH_PROVEN','PUSH_INTENT'] as const) current = await writeTransactionJournal(home, authority, { ...current, repositoryCreated: true, repositoryId: 42, phase });
    }, tx);
    const result = await recoverProfilePublishingTransactions(home, { prove: async () => remote.proof });
    expect(result[0]).toMatchObject({ action: 'committed' });
    const sidecar = JSON.parse(await temporary!.readText('profiles/work/.bazframe-profile-state.json'));
    expect(sidecar.publication).toMatchObject({ installedCommit: commit, baselineCaptureSha256: capturedProfileContentBaselineSha256(profile, capturedProfileLimitPolicy()) });
    expect(sidecar.profileInstanceId).toBe(profileInstanceIdFromPhysicalIdentity(expected.identity));
  });

  it('recovers a sidecar-free ordinary-only publication with its deterministic profile identity', async () => {
    const home = await setup();
    const enteredSkill = join(home, '..', 'catalog', 'review');
    await mkdir(enteredSkill, { recursive: true });
    await writeFile(join(enteredSkill, 'SKILL.md'), '---\nname: review\ndescription: Review.\n---\n');
    const skill = await realpath(enteredSkill);
    await mkdir(join(home, 'skills'));
    await symlink(skill, join(home, 'skills', 'review'));
    await mkdir(join(home, 'profiles', 'work', 'skills'), { recursive: true });
    await writeFile(join(home, 'profiles', 'work', 'AGENTS.md'), 'work\n');
    await symlink(skill, join(home, 'profiles', 'work', 'skills', 'review'));
    const captured = await captureProfile({ bazframeHome: home, profileId: 'work' });
    const expected = await capturePhysicalProfileExpectation(home, 'work');
    const commit = 'a'.repeat(40);
    const remote = publicationProof(captured.profile, 'github.com/owner/work', commit, 42, captured.blobs);
    const initial: PublicationJournalV1 = {
      schemaVersion: 1, kind: 'publication', transactionId: tx, profileName: 'work',
      expectedProfile: { identity: expected.identity, sidecarSha256: null, profileClosureSha256: expected.profileClosureSha256 },
      origin: 'github.com/owner/work', expectedBaseCommit: null, capturedManifestSha256: remote.captureSha,
      originalVisibility: 'absent', desiredVisibility: 'private', repositoryCreated: false, repositoryId: null,
      observedCommit: null, phase: 'INTENT'
    };
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      let current = await writeTransactionJournal(home, authority, initial);
      for (const phase of ['REPOSITORY_CREATED','PRIVATE_BEFORE_PUSH_INTENT','PRIVATE_BEFORE_PUSH_PROVEN','PUSH_INTENT'] as const) current = await writeTransactionJournal(home, authority, { ...current, repositoryCreated: true, repositoryId: 42, phase });
    }, tx);

    expect((await recoverProfilePublishingTransactions(home, { prove: async () => remote.proof }))[0]).toMatchObject({ action: 'committed' });
    const sidecar = JSON.parse(await temporary!.readText('profiles/work/.bazframe-profile-state.json'));
    expect(sidecar.profileInstanceId).toBe(profileInstanceIdFromPhysicalIdentity(expected.identity));
    expect(sidecar.capturedResourceIds).toEqual([expect.objectContaining({ identityKind: 'catalog', instanceId: null })]);
  });

  it('recovers a sidecar-free publication with the exact deterministic profile-local identity', async () => {
    const home = await setup();
    await mkdir(join(home, 'profiles', 'work', 'skills', 'local'), { recursive: true });
    await writeFile(join(home, 'profiles', 'work', 'AGENTS.md'), 'work\n');
    await writeFile(join(home, 'profiles', 'work', 'skills', 'local', 'SKILL.md'), '---\nname: local\ndescription: Local.\n---\n');
    const captured = await captureProfile({ bazframeHome: home, profileId: 'work' });
    const expected = await capturePhysicalProfileExpectation(home, 'work');
    const commit = 'a'.repeat(40);
    const remote = publicationProof(captured.profile, 'github.com/owner/work', commit, 42, captured.blobs);
    const initial: PublicationJournalV1 = {
      schemaVersion: 1, kind: 'publication', transactionId: tx, profileName: 'work',
      expectedProfile: { identity: expected.identity, sidecarSha256: null, profileClosureSha256: expected.profileClosureSha256 },
      origin: 'github.com/owner/work', expectedBaseCommit: null, capturedManifestSha256: remote.captureSha,
      originalVisibility: 'absent', desiredVisibility: 'private', repositoryCreated: false, repositoryId: null,
      observedCommit: null, phase: 'INTENT'
    };
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      let current = await writeTransactionJournal(home, authority, initial);
      for (const phase of ['REPOSITORY_CREATED','PRIVATE_BEFORE_PUSH_INTENT','PRIVATE_BEFORE_PUSH_PROVEN','PUSH_INTENT'] as const) current = await writeTransactionJournal(home, authority, { ...current, repositoryCreated: true, repositoryId: 42, phase });
    }, tx);

    expect((await recoverProfilePublishingTransactions(home, { prove: async () => remote.proof }))[0]).toMatchObject({ action: 'committed' });
    const sidecar = JSON.parse(await temporary!.readText('profiles/work/.bazframe-profile-state.json'));
    const profileInstanceId = profileInstanceIdFromPhysicalIdentity(expected.identity);
    expect(sidecar.profileInstanceId).toBe(profileInstanceId);
    expect(sidecar.capturedResourceIds).toEqual([expect.objectContaining({ identityKind: 'profileLocal', instanceId: profileLocalResourceInstanceId(profileInstanceId, 'local') })]);
  });

  it.each(['old-present', 'old-renamed'] as const)('recovers the publication local-swap %s window', async (window) => {
    const home = await setup(); await mkdir(join(home, 'profiles', 'work')); await writeFile(join(home, 'profiles', 'work', 'AGENTS.md'), 'work\n');
    const expected = await capturePhysicalProfileExpectation(home, 'work');
    const bytes = Buffer.from('work\n'); const digest = createHash('sha256').update(bytes).digest('hex'); const commit = 'a'.repeat(40);
    const profile: CapturedProfileV1 = { schemaVersion: 1, kind: 'bazframe-captured-profile', profile: { name: 'work', instructions: { path: 'AGENTS.md', sha256: digest, bytes: bytes.length, executable: false } }, resources: [], blobs: [{ sha256: digest, bytes: bytes.length }] };
    const remote = publicationProof(profile, 'github.com/owner/work', commit); const captureSha = remote.captureSha;
    const publishedState = buildPublishedProfileState(undefined, [], { transport: 'git', origin: 'github.com/owner/work', installedCommit: commit, latestSeenCommit: commit, baselineCaptureSha256: capturedProfileContentBaselineSha256(profile, capturedProfileLimitPolicy()), visibility: 'private' }, profileInstanceIdFromPhysicalIdentity(expected.identity));
    const candidatePath = join(home, 'profiles', `.bazframe-candidate-${tx}`); await mkdir(candidatePath); await writeFile(join(candidatePath, 'AGENTS.md'), bytes); await writeCandidateManagedProfileState(home, candidatePath, publishedState);
    const initial: PublicationJournalV1 = { schemaVersion: 1, kind: 'publication', transactionId: tx, profileName: 'work', expectedProfile: { identity: expected.identity, sidecarSha256: null, profileClosureSha256: expected.profileClosureSha256 }, origin: 'github.com/owner/work', expectedBaseCommit: null, capturedManifestSha256: captureSha, originalVisibility: 'absent', desiredVisibility: 'private', repositoryCreated: false, repositoryId: null, observedCommit: null, phase: 'INTENT' };
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      let current = await writeTransactionJournal(home, authority, initial);
      for (const phase of ['REPOSITORY_CREATED','PRIVATE_BEFORE_PUSH_INTENT','PRIVATE_BEFORE_PUSH_PROVEN','PUSH_INTENT','COMMIT_PUSH_PROVEN','PUBLIC_AFTER_PUSH_INTENT','PUBLIC_AFTER_PUSH_PROVEN','LOCAL_STATE_INTENT'] as const) {
        current = await writeTransactionJournal(home, authority, { ...current, repositoryCreated: true, repositoryId: 42, observedCommit: phase === 'COMMIT_PUSH_PROVEN' || current.observedCommit !== null ? commit : null, phase });
      }
    }, tx);
    if (window === 'old-renamed') await rename(join(home, 'profiles', 'work'), join(home, 'profiles', `.bazframe-backup-${tx}`));
    const result = await recoverProfilePublishingTransactions(home, { prove: async () => remote.proof });
    expect(result[0]).toMatchObject({ action: 'committed' });
    expect(JSON.parse(await temporary!.readText('profiles/work/.bazframe-profile-state.json')).publication.installedCommit).toBe(commit);
    expect(await recoverProfilePublishingTransactions(home, { prove: async () => remote.proof })).toEqual([{ transactionId: tx, kind: 'publication', action: 'terminal' }]);
  });

  it('marks unproved physical state ambiguous without deleting it', async () => {
    const home = await setup(); const candidate = await stageCandidate(home, 'work'); const ready = baseCandidate('work', candidate.expectation); ready.candidate.profileClosureSha256 = 'f'.repeat(64);
    await persistCandidateJournal(home, ready, 'CANDIDATE_READY');
    expect((await recoverProfilePublishingTransactions(home))[0]).toMatchObject({ action: 'ambiguous' });
    expect(await temporary!.readText(`profiles/.bazframe-candidate-${tx}/AGENTS.md`)).toBe('work\n');
  });

  it('finishes a proved rename through active selection and favorites, then recovers idempotently', async () => {
    const home = await setup(); await mkdir(join(home, 'profiles', 'work')); await writeFile(join(home, 'profiles', 'work', 'AGENTS.md'), 'old\n');
    await writeActiveProfile(home, 'work'); await writeProfileFavoritesUnlocked(home, ['work']);
    const expected = await capturePhysicalProfileExpectation(home, 'work');
    const beforeFavorites = Buffer.from(encodeProfileFavorites(['work'])); const afterFavorites = Buffer.from(encodeProfileFavorites(['renamed']));
    const journal: RenameProfileJournalV1 = {
      schemaVersion: 1, kind: 'rename-profile', transactionId: tx, oldName: 'work', newName: 'renamed',
      expectedOld: { identity: expected.identity, sidecarSha256: expected.sidecarSha256, profileClosureSha256: expected.profileClosureSha256 }, expectedNew: { kind: 'absent' },
      activeBefore: 'work', activeAfter: 'renamed', favoritesBeforeSha256: createHash('sha256').update(beforeFavorites).digest('hex'),
      favoritesAfterCanonicalBytesSha256: createHash('sha256').update(afterFavorites).digest('hex'), phase: 'INTENT'
    };
    await withProfileOperationLocks(home, ['work', 'renamed', '@store'], async (authority) => {
      const current = await writeTransactionJournal(home, authority, journal);
      await writeTransactionJournal(home, authority, { ...current, phase: 'DIRECTORY_RENAME_INTENT' });
    }, tx);
    await rename(join(home, 'profiles', 'work'), join(home, 'profiles', 'renamed'));
    const renameResult = await recoverProfilePublishingTransactions(home);
    expect(renameResult).toEqual([{ transactionId: tx, kind: 'rename-profile', action: 'committed' }]);
    expect(await temporary!.readText('active-profile')).toBe('renamed\n');
    expect(JSON.parse(await temporary!.readText('profile-favorites.json')).favorites).toEqual(['renamed']);
    expect(await recoverProfilePublishingTransactions(home)).toEqual([{ transactionId: tx, kind: 'rename-profile', action: 'terminal' }]);
  });

  it('ignores canonical journal temporary entries but rejects unknown namespace occupants', async () => {
    const home = await setup(); await mkdir(join(home, 'profile-publishing', 'transactions'), { recursive: true });
    await writeFile(join(home, 'profile-publishing', 'transactions', `.tmp-${'a'.repeat(32)}`), 'partial');
    await expect(recoverProfilePublishingTransactions(home)).resolves.toEqual([]);
    await writeFile(join(home, 'profile-publishing', 'transactions', 'unexpected'), 'x');
    await expect(recoverProfilePublishingTransactions(home)).rejects.toMatchObject({ code: 'PROFILE_RECOVERY_INVALID' });
  });

  it('propagates transient publication proof failures without converting the journal to ambiguity', async () => {
    const home = await setup(); await mkdir(join(home, 'profiles', 'work')); await writeFile(join(home, 'profiles', 'work', 'AGENTS.md'), 'work\n');
    const expected = await capturePhysicalProfileExpectation(home, 'work');
    const initial: PublicationJournalV1 = { schemaVersion: 1, kind: 'publication', transactionId: tx, profileName: 'work', expectedProfile: { identity: expected.identity, sidecarSha256: null, profileClosureSha256: expected.profileClosureSha256 }, origin: 'github.com/owner/work', expectedBaseCommit: null, capturedManifestSha256: 'd'.repeat(64), originalVisibility: 'absent', desiredVisibility: 'private', repositoryCreated: false, repositoryId: null, observedCommit: null, phase: 'INTENT' };
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      let current = await writeTransactionJournal(home, authority, initial);
      for (const phase of ['REPOSITORY_CREATED','PRIVATE_BEFORE_PUSH_INTENT','PRIVATE_BEFORE_PUSH_PROVEN','PUSH_INTENT'] as const) current = await writeTransactionJournal(home, authority, { ...current, repositoryCreated: true, repositoryId: 42, phase });
    }, tx);
    const transient = new Error('network unavailable');
    await expect(recoverProfilePublishingTransactions(home, { prove: async () => { throw transient; } })).rejects.toBe(transient);
    expect((await readTransactionJournal(home, tx)).phase).toBe('PUSH_INTENT');
  });

  it('rejects a remote proof whose canonical tree or blob closure is not proved', async () => {
    const home = await setup(); await mkdir(join(home, 'profiles', 'work')); await writeFile(join(home, 'profiles', 'work', 'AGENTS.md'), 'work\n');
    const expected = await capturePhysicalProfileExpectation(home, 'work'); const bytes = Buffer.from('work\n'); const digest = createHash('sha256').update(bytes).digest('hex'); const commit = 'a'.repeat(40);
    const profile: CapturedProfileV1 = { schemaVersion: 1, kind: 'bazframe-captured-profile', profile: { name: 'work', instructions: { path: 'AGENTS.md', sha256: digest, bytes: bytes.length, executable: false } }, resources: [], blobs: [{ sha256: digest, bytes: bytes.length }] };
    const remote = publicationProof(profile, 'github.com/owner/work', commit);
    const initial: PublicationJournalV1 = { schemaVersion: 1, kind: 'publication', transactionId: tx, profileName: 'work', expectedProfile: { identity: expected.identity, sidecarSha256: null, profileClosureSha256: expected.profileClosureSha256 }, origin: 'github.com/owner/work', expectedBaseCommit: null, capturedManifestSha256: remote.captureSha, originalVisibility: 'absent', desiredVisibility: 'private', repositoryCreated: false, repositoryId: null, observedCommit: null, phase: 'INTENT' };
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      let current = await writeTransactionJournal(home, authority, initial);
      for (const phase of ['REPOSITORY_CREATED','PRIVATE_BEFORE_PUSH_INTENT','PRIVATE_BEFORE_PUSH_PROVEN','PUSH_INTENT'] as const) current = await writeTransactionJournal(home, authority, { ...current, repositoryCreated: true, repositoryId: 42, phase });
    }, tx);
    const bad = { ...remote.proof, canonicalTreeProven: false };
    expect((await recoverProfilePublishingTransactions(home, { prove: async () => bad }))[0]).toMatchObject({ action: 'ambiguous' });
    expect((await readTransactionJournal(home, tx)).phase).toBe('AMBIGUOUS');
  });
});
