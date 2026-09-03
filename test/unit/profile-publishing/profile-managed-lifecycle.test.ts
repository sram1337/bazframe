import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import {
  duplicateManagedProfile,
  inspectManagedProfileActivation,
  removeManagedProfile,
  renameManagedProfile,
  useManagedProfile
} from '../../../src/profile-publishing/profile-managed-lifecycle.js';
import { encodeManagedProfileState, type ManagedProfileStateV1 } from '../../../src/profile-publishing/publication-state.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import { capturedResourceId, importedResourceIdentity, ordinaryResourceIdentity, profileLocalResourceIdentity, profileLocalResourceInstanceId, resourceIdentityDigest } from '../../../src/profile-publishing/captured-profile.js';
import { encodeProfileFavorites, readProfileFavorites } from '../../../src/profiles/profile-favorites.js';
import { readTransactionJournal } from '../../../src/profile-publishing/transaction-journal.js';
import { readOptionalManagedProfileState } from '../../../src/profile-publishing/managed-profile-state.js';
import { recoverProfilePublishingTransactions } from '../../../src/profile-publishing/profile-recovery.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

async function setup() {
  temporary = await createTempDirectory('/tmp/bzf-managed-lifecycle-');
  const home = temporary.path('home');
  await mkdir(join(home, 'profiles'), { recursive: true });
  return home;
}

async function plainProfile(home: string, name: string, instructions = `${name}\n`) {
  const root = join(home, 'profiles', name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), instructions);
  return root;
}

function managedState(): ManagedProfileStateV1 {
  const currentInstance = '11111111-1111-4111-8111-111111111111';
  const retainedInstance = '22222222-2222-4222-8222-222222222222';
  const currentCapture = 'a'.repeat(64);
  const retainedCapture = 'b'.repeat(64);
  const ordinaryCapture = 'c'.repeat(64);
  return {
    schemaVersion: 1,
    profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    publication: { transport: 'git', origin: 'github.com/owner/source', installedCommit: 'd'.repeat(40), latestSeenCommit: 'e'.repeat(40), baselineCaptureSha256: 'f'.repeat(64), visibility: 'private' },
    capturedResourceIds: [
      { resourceIdentityDigest: resourceIdentityDigest(importedResourceIdentity(currentInstance)), capturedResourceId: currentCapture, identityKind: 'imported' as const, instanceId: currentInstance },
      { resourceIdentityDigest: resourceIdentityDigest(importedResourceIdentity(retainedInstance)), capturedResourceId: retainedCapture, identityKind: 'imported' as const, instanceId: retainedInstance },
      { resourceIdentityDigest: resourceIdentityDigest(ordinaryResourceIdentity('skill', 'review')), capturedResourceId: ordinaryCapture, identityKind: 'catalog' as const, instanceId: null }
    ].sort((left, right) => left.resourceIdentityDigest.localeCompare(right.resourceIdentityDigest) || left.capturedResourceId.localeCompare(right.capturedResourceId)),
    importedResources: [{
      instanceId: currentInstance,
      capturedResourceId: currentCapture,
      key: { kind: 'skill', name: 'missing' },
      source: { kind: 'missingRemoteGit', identity: { remote: 'github.com/owner/missing', fetchUrl: 'https://github.com/owner/missing.git', branch: 'main', revision: '1'.repeat(40) }, diagnosticCode: 'OFFLINE' }
    }]
  };
}

async function installOrdinarySkill(home: string, profile: string) {
  const source = join(home, 'sources', 'review');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: review\ndescription: Review.\n---\n');
  await mkdir(join(home, 'skills'), { recursive: true });
  await symlink(source, join(home, 'skills', 'review'));
  await mkdir(join(profile, 'skills'), { recursive: true });
  await symlink(source, join(profile, 'skills', 'review'));
  return source;
}

async function writeManagedState(profile: string, state = managedState()) {
  await writeFile(join(profile, '.bazframe-profile-state.json'), encodeManagedProfileState(state, capturedProfileLimitPolicy()));
}

describe('hidden managed profile lifecycle', () => {
  it('duplicates sidecar-free profiles without eager state and keeps the result inactive', async () => {
    const home = await setup();
    await plainProfile(home, 'active');
    const source = await plainProfile(home, 'source', 'source bytes\n');
    const target = await installOrdinarySkill(home, source);
    await writeFile(join(home, 'active-profile'), 'active\n');
    const result = await duplicateManagedProfile(home, 'source', 'copy');
    expect(result).toMatchObject({ sourceProfileName: 'source', profileName: 'copy', active: false, managed: false });
    expect(await readFile(join(home, 'profiles', 'copy', 'AGENTS.md'), 'utf8')).toBe('source bytes\n');
    expect(await readlink(join(home, 'profiles', 'copy', 'skills', 'review'))).toBe(target);
    await expect(lstat(join(home, 'profiles', 'copy', '.bazframe-profile-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readTransactionJournal(home, result.transactionId)).phase).toBe('COMMITTED');
    expect(await readFile(join(home, 'active-profile'), 'utf8')).toBe('active\n');
  });

  it('duplicates managed state with a new profile identity, no publication, and shared imported current/retained IDs', async () => {
    const home = await setup();
    const source = await plainProfile(home, 'source');
    await installOrdinarySkill(home, source);
    const original = managedState();
    await writeManagedState(source, original);
    const result = await duplicateManagedProfile(home, 'source', 'copy');
    const copied = (await readOptionalManagedProfileState(home, 'copy'))!.state;
    expect(copied.profileInstanceId).not.toBe(original.profileInstanceId);
    expect(copied.publication).toBeNull();
    expect(copied.importedResources).toEqual(original.importedResources);
    expect(copied.capturedResourceIds).toEqual(original.capturedResourceIds.filter((binding) => binding.instanceId !== null));
    expect(await readlink(join(home, 'profiles', 'copy', 'skills', 'review'))).toBe(await readlink(join(source, 'skills', 'review')));
    expect((await readTransactionJournal(home, result.transactionId)).phase).toBe('COMMITTED');
  });

  it('duplicates physical profile-local Skills with forked mutable identity and exact local bytes', async () => {
    const home = await setup();
    const source = await plainProfile(home, 'source');
    await mkdir(join(source, 'skills', 'local'), { recursive: true });
    await writeFile(join(source, 'skills', 'local', 'SKILL.md'), '---\nname: local\ndescription: Local.\n---\n');
    await writeFile(join(source, 'skills', 'local', '.env'), 'TOKEN=local\n');
    const sourceProfileInstance = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sourceLocalInstance = profileLocalResourceInstanceId(sourceProfileInstance, 'local');
    const sourceIdentity = profileLocalResourceIdentity(sourceLocalInstance);
    await writeManagedState(source, {
      schemaVersion: 1,
      profileInstanceId: sourceProfileInstance,
      publication: null,
      capturedResourceIds: [{ resourceIdentityDigest: resourceIdentityDigest(sourceIdentity), capturedResourceId: capturedResourceId('skill', sourceIdentity), identityKind: 'profileLocal', instanceId: sourceLocalInstance }],
      importedResources: []
    });

    await duplicateManagedProfile(home, 'source', 'copy');

    const copied = (await readOptionalManagedProfileState(home, 'copy'))!.state;
    const copiedLocalInstance = profileLocalResourceInstanceId(copied.profileInstanceId, 'local');
    const copiedIdentity = profileLocalResourceIdentity(copiedLocalInstance);
    expect(copied.capturedResourceIds).toEqual([{ resourceIdentityDigest: resourceIdentityDigest(copiedIdentity), capturedResourceId: capturedResourceId('skill', copiedIdentity), identityKind: 'profileLocal', instanceId: copiedLocalInstance }]);
    expect(copiedLocalInstance).not.toBe(sourceLocalInstance);
    expect(await readFile(join(home, 'profiles', 'copy', 'skills', 'local', 'SKILL.md'), 'utf8')).toContain('name: local');
    expect(await readFile(join(home, 'profiles', 'copy', 'skills', 'local', '.env'), 'utf8')).toBe('TOKEN=local\n');
  });

  it('refuses dangling-active duplicate destinations and source drift before publication', async () => {
    const home = await setup();
    const source = await plainProfile(home, 'source');
    await writeFile(join(home, 'active-profile'), 'copy\n');
    await expect(duplicateManagedProfile(home, 'source', 'copy')).rejects.toMatchObject({ code: 'PROFILE_IMPORT_DANGLING_ACTIVE' });
    await rm(join(home, 'active-profile'));
    await expect(duplicateManagedProfile(home, 'source', 'copy', { afterCandidateCopy: () => writeFile(join(source, 'AGENTS.md'), 'changed\n') }))
      .rejects.toMatchObject({ code: 'PROFILE_PHYSICAL_CLOSURE_CHANGED' });
    await expect(lstat(join(home, 'profiles', 'copy'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renames with durable intent-before-mutation phases while preserving state and updating active/favorites', async () => {
    const home = await setup();
    const source = await plainProfile(home, 'source');
    const state = managedState(); await writeManagedState(source, state);
    await writeFile(join(home, 'active-profile'), 'source\n');
    await writeFile(join(home, 'profile-favorites.json'), encodeProfileFavorites(['source']));
    const phases: RenamePhase[] = [];
    const result = await renameManagedProfile(home, 'source', 'renamed', { afterPhase: (phase) => { phases.push(phase); } });
    expect(phases).toEqual(['INTENT','DIRECTORY_RENAME_INTENT','DIRECTORY_RENAME_PROVEN','ACTIVE_SELECTION_INTENT','ACTIVE_SELECTION_PROVEN','FAVORITES_INTENT','FAVORITES_PROVEN','COMMITTED']);
    expect(await readFile(join(home, 'active-profile'), 'utf8')).toBe('renamed\n');
    expect(JSON.parse(await readFile(join(home, 'profile-favorites.json'), 'utf8')).favorites).toEqual(['renamed']);
    expect((await readOptionalManagedProfileState(home, 'renamed'))!.state).toEqual(state);
    expect((await readTransactionJournal(home, result.transactionId)).phase).toBe('COMMITTED');
  });

  it('allows incomplete activation with deterministic warning and exact selection', async () => {
    const home = await setup();
    const profile = await plainProfile(home, 'source');
    await writeManagedState(profile);
    const inspection = await inspectManagedProfileActivation(home, 'source');
    expect(inspection.incomplete).toBe(true);
    expect(inspection.warning).toBe('Profile "source" is incomplete; missing resources: skill missing (OFFLINE). Activation is allowed; run `bazframe profile update --profile source` to retry.');
    const used = await useManagedProfile(home, 'source');
    expect(used.active).toBe(true);
    expect(await readFile(join(home, 'active-profile'), 'utf8')).toBe('source\n');
  });

  it('recovers forward from both present-removal mutation windows and keeps transient faults nonterminal', async () => {
    for (const fault of ['intent', 'favorites', 'directory'] as const) {
      await temporary?.cleanup(); temporary = undefined;
      const home = await setup();
      await plainProfile(home, 'source', 'keep exact\n');
      await writeFile(join(home, 'active-profile'), 'other\n');
      await writeFile(join(home, 'profile-favorites.json'), encodeProfileFavorites(['source']));
      let injected = false;
      await expect(removeManagedProfile(home, 'source', fault === 'intent'
        ? { afterPhase: (phase) => { if (phase === 'INTENT') { injected = true; throw new Error('transient intent fault'); } } }
        : fault === 'favorites'
          ? { afterFavoritesMutation: () => { injected = true; throw new Error('transient favorites fault'); } }
          : { afterDirectoryQuarantine: () => { injected = true; throw new Error('transient directory fault'); } }))
        .rejects.toThrow(`transient ${fault} fault`);
      expect(injected).toBe(true);
      const names = (await readdir(join(home, 'profile-publishing', 'transactions'))).filter((name) => name.endsWith('.json'));
      const before = await readTransactionJournal(home, names[0]!.slice(0, -5));
      expect(before).toMatchObject({ kind: 'remove-profile', phase: fault === 'intent' ? 'INTENT' : fault === 'favorites' ? 'FAVORITES_MUTATION_INTENT' : 'DIRECTORY_QUARANTINE_INTENT' });
      expect((await readProfileFavorites(home)).favorites).toEqual(fault === 'intent' ? ['source'] : []);
      await expect(recoverProfilePublishingTransactions(home)).resolves.toEqual([expect.objectContaining({ kind: 'remove-profile', action: 'committed' })]);
      expect((await readTransactionJournal(home, names[0]!.slice(0, -5))).phase).toBe('COMMITTED');
      await expect(lstat(join(home, 'profiles', 'source'))).rejects.toMatchObject({ code: 'ENOENT' });
      const quarantine = join(home, 'profiles', `.bazframe-backup-${names[0]!.slice(0, -5)}`);
      expect(await readFile(join(quarantine, 'AGENTS.md'), 'utf8')).toBe('keep exact\n');
      await expect(recoverProfilePublishingTransactions(home)).resolves.toEqual([expect.objectContaining({ kind: 'remove-profile', action: 'terminal' })]);
    }
  });

  it('marks contradictory exact active predicates ambiguous without removing the profile', async () => {
    const home = await setup();
    await plainProfile(home, 'source', 'keep exact\n');
    await writeFile(join(home, 'active-profile'), 'other\n');
    await expect(removeManagedProfile(home, 'source', { afterPhase: async (phase) => {
      if (phase === 'FAVORITES_MUTATION_INTENT') await writeFile(join(home, 'active-profile'), 'third\n');
    } })).rejects.toMatchObject({ code: 'PROFILE_RECOVERY_AMBIGUOUS' });
    expect(await readFile(join(home, 'profiles', 'source', 'AGENTS.md'), 'utf8')).toBe('keep exact\n');
    const names = (await readdir(join(home, 'profile-publishing', 'transactions'))).filter((name) => name.endsWith('.json'));
    expect((await readTransactionJournal(home, names[0]!.slice(0, -5))).phase).toBe('AMBIGUOUS');
  });

  it('removes only exact inactive local state into a proved retained quarantine and refuses active removal', async () => {
    const home = await setup();
    const profile = await plainProfile(home, 'source', 'keep exact\n');
    await writeManagedState(profile);
    await writeFile(join(home, 'profile-favorites.json'), encodeProfileFavorites(['source']));
    await writeFile(join(home, 'active-profile'), 'source\n');
    await expect(removeManagedProfile(home, 'source')).rejects.toMatchObject({ code: 'ACTIVE_PROFILE_REMOVE_REFUSED' });
    expect((await readProfileFavorites(home)).favorites).toEqual(['source']);
    await writeFile(join(home, 'active-profile'), 'other\n');
    const removed = await removeManagedProfile(home, 'source');
    expect(removed.action).toBe('removed');
    expect(removed.retainedPath).toMatch(/\.bazframe-backup-[a-f0-9]{32}$/u);
    expect(await readFile(join(removed.retainedPath!, 'AGENTS.md'), 'utf8')).toBe('keep exact\n');
    expect(JSON.parse(await readFile(join(removed.retainedPath!, '.bazframe-profile-state.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, publication: { transport: 'git', origin: 'github.com/owner/source' } });
    await expect(lstat(join(home, 'profiles', 'source'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readProfileFavorites(home)).favorites).toEqual([]);
    await writeFile(join(home, 'profile-favorites.json'), encodeProfileFavorites(['source']));
    expect(await removeManagedProfile(home, 'source')).toEqual({ profileName: 'source', action: 'absent', retainedPath: null });
    expect((await readProfileFavorites(home)).favorites).toEqual([]);
  });
});

type RenamePhase = import('../../../src/profile-publishing/transaction-journal.js').RenamePhase;
