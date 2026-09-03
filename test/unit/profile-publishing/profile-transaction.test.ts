import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { executeProfileCandidateSwap } from '../../../src/profile-publishing/profile-transaction.js';
import { readOptionalManagedProfileState } from '../../../src/profile-publishing/managed-profile-state.js';
import { readActiveProfile, writeActiveProfile } from '../../../src/profiles/profile-store.js';
import { readTransactionJournal } from '../../../src/profile-publishing/transaction-journal.js';
import { encodeManagedProfileState, type ManagedProfileStateV1 } from '../../../src/profile-publishing/publication-state.js';
import { importedResourceIdentity, resourceIdentityDigest } from '../../../src/profile-publishing/captured-profile.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

function state(id = '123e4567-e89b-42d3-a456-426614174000'): ManagedProfileStateV1 {
  return { schemaVersion: 1, profileInstanceId: id, publication: null, capturedResourceIds: [], importedResources: [] };
}

function missingState(capturedResourceId: string, revision = 'f'.repeat(40)): ManagedProfileStateV1 {
  const instanceId = '123e4567-e89b-42d3-a456-426614174000';
  return {
    schemaVersion: 1,
    profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    publication: null,
    capturedResourceIds: [{ resourceIdentityDigest: resourceIdentityDigest(importedResourceIdentity(instanceId)), capturedResourceId, identityKind: 'imported', instanceId }],
    importedResources: [{
      instanceId,
      capturedResourceId,
      key: { kind: 'skill', name: 'review' },
      source: { kind: 'missingRemoteGit', identity: { remote: 'github.com/owner/review', fetchUrl: 'https://github.com/owner/review.git', branch: 'main', revision }, diagnosticCode: 'OFFLINE' }
    }]
  };
}

async function materialize(candidate: string, instructions: string, value = state()): Promise<{ state: ManagedProfileStateV1 }> {
  await writeFile(`${candidate}/AGENTS.md`, instructions);
  return { state: value };
}

describe('profile candidate swap transaction', () => {
  it('publishes a fresh imported profile without changing active selection', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await temporary.mkdir('profiles/active');
    await temporary.write('profiles/active/AGENTS.md', 'active\n');
    await writeActiveProfile(temporary.root, 'active');
    const result = await executeProfileCandidateSwap({
      home: temporary.root,
      profileName: 'imported',
      operation: 'fresh-import',
      materialize: (candidate) => materialize(candidate, 'imported\n')
    });
    expect(result.journal.phase).toBe('COMMITTED');
    expect(result.backupRetained).toBe(false);
    expect(await temporary.readText('profiles/imported/AGENTS.md')).toBe('imported\n');
    expect((await readOptionalManagedProfileState(temporary.root, 'imported'))?.state.profileInstanceId).toBe(state().profileInstanceId);
    expect(await readActiveProfile(temporary.root)).toBe('active');
  });

  it('rechecks the inactive-fresh invariant under the final state lock', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await temporary.mkdir('profiles');
    await expect(executeProfileCandidateSwap({
      home: temporary.root,
      profileName: 'imported',
      operation: 'fresh-import',
      freshImportMustRemainInactive: true,
      beforePublication: async () => { await temporary!.write('active-profile', 'imported\n'); },
      materialize: (candidate) => materialize(candidate, 'imported\n')
    })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_DANGLING_ACTIVE' });
    await expect(temporary.readText('profiles/imported/AGENTS.md')).rejects.toBeDefined();
    expect(await temporary.readText('active-profile')).toBe('imported\n');
  });

  it('atomically overwrites the active profile and retains the proved backup', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await temporary.mkdir('profiles/work');
    await temporary.write('profiles/work/AGENTS.md', 'old\n');
    await writeActiveProfile(temporary.root, 'work');
    const result = await executeProfileCandidateSwap({
      home: temporary.root,
      profileName: 'work',
      operation: 'overwrite',
      materialize: (candidate) => materialize(candidate, 'new\n')
    });
    expect(await temporary.readText('profiles/work/AGENTS.md')).toBe('new\n');
    expect(await temporary.readText(`profiles/.bazframe-backup-${result.transactionId}/AGENTS.md`)).toBe('old\n');
    expect(await readActiveProfile(temporary.root)).toBe('work');
  });

  it('aborts before mutation and preserves the existing profile', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await temporary.mkdir('profiles/work');
    await temporary.write('profiles/work/AGENTS.md', 'old\n');
    await expect(executeProfileCandidateSwap({
      home: temporary.root,
      profileName: 'work',
      operation: 'update',
      materialize: async () => { throw new Error('stop'); }
    })).rejects.toThrow('stop');
    expect(await temporary.readText('profiles/work/AGENTS.md')).toBe('old\n');
    const names = await readdir(temporary.path('profile-publishing/transactions'));
    const transactionId = names.find((name) => name.endsWith('.json'))!.slice(0, -5);
    expect((await readTransactionJournal(temporary.root, transactionId)).phase).toBe('ABORTED');
  });

  it('rejects replacement of one missing identity by another at the same count', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await mkdir(temporary.path('profiles/work'), { recursive: true });
    await temporary.write('profiles/work/AGENTS.md', 'old\n');
    await writeFile(temporary.path('profiles/work/.bazframe-profile-state.json'), encodeManagedProfileState(missingState('a'.repeat(64)), capturedProfileLimitPolicy()));
    await expect(executeProfileCandidateSwap({
      home: temporary.root,
      profileName: 'work',
      operation: 'repair',
      materialize: (candidate) => materialize(candidate, 'new\n', missingState('b'.repeat(64)))
    })).rejects.toMatchObject({ code: 'PROFILE_MUTATION_WOULD_WORSEN' });
    expect(await temporary.readText('profiles/work/AGENTS.md')).toBe('old\n');
  });

  it('rejects a changed missing exact identity even when a hostile candidate reuses its captured ID', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await mkdir(temporary.path('profiles/work'), { recursive: true });
    await temporary.write('profiles/work/AGENTS.md', 'old\n');
    const capturedId = 'a'.repeat(64);
    await writeFile(temporary.path('profiles/work/.bazframe-profile-state.json'), encodeManagedProfileState(missingState(capturedId), capturedProfileLimitPolicy()));
    await expect(executeProfileCandidateSwap({
      home: temporary.root,
      profileName: 'work',
      operation: 'update',
      materialize: (candidate) => materialize(candidate, 'new\n', missingState(capturedId, 'e'.repeat(40)))
    })).rejects.toMatchObject({ code: 'PROFILE_MUTATION_WOULD_WORSEN' });
  });

  it('refuses an occupied predictable backup before replacing the old profile', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await temporary.mkdir('profiles/work');
    await temporary.write('profiles/work/AGENTS.md', 'old\n');
    await expect(executeProfileCandidateSwap({
      home: temporary.root,
      profileName: 'work',
      operation: 'update',
      materialize: (candidate) => materialize(candidate, 'new\n'),
      hooks: { afterPhase: async (phase) => {
        if (phase !== 'CANDIDATE_READY') return;
        const journals = await readdir(temporary!.path('profile-publishing/transactions'));
        const id = journals.find((name) => name.endsWith('.json'))!.slice(0, -5);
        await mkdir(temporary!.path(`profiles/.bazframe-backup-${id}`));
      } }
    })).rejects.toMatchObject({ code: 'PROFILE_TRANSACTION_BACKUP_OCCUPIED' });
    expect(await temporary.readText('profiles/work/AGENTS.md')).toBe('old\n');
  });

  it('retains ambiguous state after an old-profile rename failure', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await temporary.mkdir('profiles/work');
    await temporary.write('profiles/work/AGENTS.md', 'old\n');
    await expect(executeProfileCandidateSwap({
      home: temporary.root,
      profileName: 'work',
      operation: 'version-use',
      materialize: (candidate) => materialize(candidate, 'new\n'),
      hooks: { afterOldRename: () => { throw new Error('uncertain'); } }
    })).rejects.toThrow('uncertain');
    const names = await readdir(temporary.path('profile-publishing/transactions'));
    const transactionId = names.find((name) => name.endsWith('.json'))!.slice(0, -5);
    const journal = await readTransactionJournal(temporary.root, transactionId);
    expect(journal.phase).toBe('AMBIGUOUS');
    expect(await temporary.readText(`profiles/.bazframe-backup-${transactionId}/AGENTS.md`)).toBe('old\n');
    await expect(temporary.readText('profiles/work/AGENTS.md')).rejects.toBeDefined();
  });
});
