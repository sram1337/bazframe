import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { win32 } from 'node:path';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
import { addProfile, currentProfile } from '../../../src/profiles/profile-management.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { createWindowsProfileSelectionReadServicesForInternalTesting } from '../../../src/profiles/win32-profile-selection.js';
import { encodeProfileFavorites } from '../../../src/profiles/profile-favorites.js';
import { inspectManagedProfileActivation, removeManagedProfile, renameManagedProfile, useManagedProfile } from '../../../src/profile-publishing/profile-managed-lifecycle.js';
import { createWindowsProfileLifecycleServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-lifecycle.js';
import { createWindowsProfileActivationServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-activation.js';
import { recoverProfilePublishingTransactions } from '../../../src/profile-publishing/profile-recovery.js';
import { assertWindowsOperationMutationAuthority, type OperationMutationAuthority } from '../../../src/profile-publishing/profile-operation-lock.js';
import { readWindowsTransactionJournal, scanWindowsTransactionJournals } from '../../../src/profile-publishing/win32-transaction-journal.js';
import { type RenamePhase, type RemovePhase, encodeTransactionJournal } from '../../../src/profile-publishing/transaction-journal.js';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), readlink: vi.fn() }));
vi.mock('node:path', async (original) => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, basename: (path: string, suffix?: string) => path.includes('\\') ? actual.win32.basename(path, suffix) : actual.basename(path, suffix) };
});
afterEach(() => vi.restoreAllMocks());
const HOME = 'C:\\boundary\\home';
const stop = () => { throw new Error('simulated interruption'); };
async function fixture() {
  const f = windowsProvisioningFixture();
  const provisioningServices = createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io });
  for (const name of ['alpha', 'bravo']) await addProfile(HOME, name, { provisioningServices });
  const services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, { stateIo: f.io, lockIo: f.io, journal: { io: f.io } });
  const activation = createWindowsProfileActivationServicesForInternalTesting(f.backend, { selectionIo: f.io, lockIo: f.io, journal: { io: f.io } });
  const selection = createWindowsProfileSelectionReadServicesForInternalTesting(f.backend);
  await useManagedProfile(HOME, 'alpha', activation);
  const recover = () => recoverProfilePublishingTransactions(HOME, undefined, services);
  const favorites = (names: string[]) => f.file(`${HOME}\\profile-favorites.json`, encodeProfileFavorites(names));
  const journal = async () => {
    const names = await scanWindowsTransactionJournals(f.backend, HOME);
    expect(names).toHaveLength(1);
    return (await readWindowsTransactionJournal(f.backend, HOME, names[0]!.slice(0, -5)))!;
  };
  return { ...f, services, activation, selection, recover, favorites, journal };
}
async function membershipFixture() {
  const f = await fixture(), target = 'C:\\boundary\\demo-skill';
  f.directory(target); f.file(`${target}\\SKILL.md`, '---\nname: demo-skill\n---\n# Demo\n');
  f.directory(`${HOME}\\skills`); f.reparse(`${HOME}\\skills\\demo-skill`);
  f.reparse(`${HOME}\\profiles\\alpha\\skills\\demo-skill`);
  vi.mocked(fs.readlink).mockImplementation(async () => target);
  f.backend.inspectMembershipLink = (path) => {
    const value = f.backend.inspectPath(path), destination = f.backend.inspectPath(target);
    if (value.object.reparseTag !== 0xa0000003) throw new Error('not junction');
    return { ...value, normalizedTarget: destination.canonicalPath, targetVolumeIdentity: destination.object.volumeIdentity, targetFileId: destination.object.fileId };
  };
  return { ...f, target };
}

describe('shared ordinary Windows lifecycle with actual native effects and V2 journals', () => {
  it.each([false, true])('renames contents, junctions and favorites with active=%s, then ordinary use/current remains available', async (active) => {
    const f = await membershipFixture();
    f.nodes.get(`${HOME}\\profiles\\alpha\\AGENTS.md`)!.bytes = Buffer.from('# instructions\n');
    f.favorites(['alpha', 'bravo']);
    if (!active) await useManagedProfile(HOME, 'bravo', f.activation);
    const old = (await f.services.capture(HOME, 'alpha'))!;
    const target = JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(f.target)));
    const result = await renameManagedProfile(HOME, 'alpha', 'charlie', {}, f.services);
    expect(result).toMatchObject({ activeSelectionUpdated: active, journal: { schemaVersion: 2, identityDomain: 'win32-ntfs', phase: 'COMMITTED' } });
    const renamed = (await f.services.capture(HOME, 'charlie'))!;
    expect(renamed.identity).toBe(old.identity);
    expect(renamed.closure.entries).toEqual(old.closure.entries);
    expect(renamed.profileClosureSha256).not.toBe(old.profileClosureSha256);
    expect((await f.services.readFavorites(HOME)).favorites).toEqual(['bravo', 'charlie']);
    expect(await currentProfile(HOME, f.selection)).toBe(active ? 'charlie' : 'bravo');
    const snapshot = f.snapshot();
    await inspectManagedProfileActivation(HOME, 'charlie', f.activation);
    expect(f.snapshot()).toBe(snapshot);
    await useManagedProfile(HOME, 'charlie', f.activation);
    expect(await currentProfile(HOME, f.selection)).toBe('charlie');
    expect(JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(f.target)))).toBe(target);
  });

  it('requires generated-empty or exact preview confirmation, refuses active/stale, and retains removed junction closure and target', async () => {
    const f = await membershipFixture(); f.favorites(['alpha', 'bravo']);
    await expect(removeManagedProfile(HOME, 'alpha', { expectedRemovalIdentity: (await f.services.capture(HOME, 'alpha'))! }, f.services)).rejects.toMatchObject({ code: 'ACTIVE_PROFILE_REMOVE_REFUSED' });
    await useManagedProfile(HOME, 'bravo', f.activation);
    await expect(removeManagedProfile(HOME, 'alpha', {}, f.services)).rejects.toMatchObject({ code: 'PROFILE_NOT_EMPTY' });
    const preview = (await f.services.capture(HOME, 'alpha'))!;
    f.nodes.get(`${HOME}\\profiles\\alpha\\AGENTS.md`)!.bytes = Buffer.from('changed');
    await expect(removeManagedProfile(HOME, 'alpha', { expectedRemovalIdentity: preview }, f.services)).rejects.toMatchObject({ code: 'PROFILE_REMOVE_AUTHORIZATION_STALE' });
    const current = (await f.services.capture(HOME, 'alpha'))!;
    const target = JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(f.target)));
    const result = await removeManagedProfile(HOME, 'alpha', { expectedRemovalIdentity: current }, f.services);
    expect(result.action).toBe('removed');
    expect(await f.services.capture(HOME, 'alpha')).toBeUndefined();
    expect(await f.services.capture(HOME, 'alpha', win32.basename(result.retainedPath!))).toEqual(current);
    expect(JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(f.target)))).toBe(target);
    expect((await f.services.readFavorites(HOME)).favorites).toEqual(['bravo']);
    await useManagedProfile(HOME, 'bravo', f.activation);
    expect(await currentProfile(HOME, f.selection)).toBe('bravo');
    expect(await f.recover()).toEqual([expect.objectContaining({ action: 'terminal' })]);
  });

  it.each(['content', 'root'] as const)('refuses %s changes between preview validation and removal baseline before any lifecycle effect', async (change) => {
    const f = await fixture(); f.favorites(['alpha', 'bravo']);
    const preview = (await f.services.capture(HOME, 'bravo'))!;
    const favorites = JSON.stringify(f.nodes.get(`${HOME}\\profile-favorites.json`));
    const selection = JSON.stringify(f.nodes.get(`${HOME}\\active-profile`));
    const original = f.services.removalIdentity;
    const validation = vi.spyOn(f.services, 'removalIdentity').mockImplementation(async (...args) => {
      const validated = await original(...args);
      expect(validated).toEqual(preview);
      if (change === 'content') f.nodes.get(`${HOME}\\profiles\\bravo\\AGENTS.md`)!.bytes = Buffer.from('unconfirmed edit');
      else f.directory(`${HOME}\\profiles\\bravo`);
      return validated;
    });
    const journal = vi.spyOn(f.services, 'writeJournal');
    const publishFavorites = vi.spyOn(f.services, 'publishFavorites');
    const move = vi.spyOn(f.services, 'move');
    await expect(removeManagedProfile(HOME, 'bravo', { expectedRemovalIdentity: preview }, f.services)).rejects.toMatchObject({ code: 'PROFILE_REMOVE_AUTHORIZATION_STALE' });
    expect(validation).toHaveBeenCalledOnce();
    expect(journal).not.toHaveBeenCalled();
    expect(publishFavorites).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(await scanWindowsTransactionJournals(f.backend, HOME)).toEqual([]);
    expect([...f.nodes.keys()].some((path) => path.includes('.bazframe-backup-'))).toBe(false);
    const current = (await f.services.capture(HOME, 'bravo'))!;
    if (change === 'root') expect(current.identity).not.toBe(preview.identity);
    else expect(f.nodes.get(`${HOME}\\profiles\\bravo\\AGENTS.md`)!.bytes?.toString()).toBe('unconfirmed edit');
    expect(JSON.stringify(f.nodes.get(`${HOME}\\profile-favorites.json`))).toBe(favorites);
    expect(JSON.stringify(f.nodes.get(`${HOME}\\active-profile`))).toBe(selection);
  });

  it('removes generated-empty, preserves absent semantics and clears valid absent favorites', async () => {
    const f = await fixture(); f.favorites(['alpha', 'bravo', 'missing']);
    await expect(removeManagedProfile(HOME, 'bravo', { requireGeneratedEmpty: true }, f.services)).resolves.toMatchObject({ action: 'removed' });
    await expect(removeManagedProfile(HOME, 'missing', {}, f.services)).resolves.toEqual({ profileName: 'missing', action: 'absent', retainedPath: null });
    expect((await f.services.readFavorites(HOME)).favorites).toEqual(['alpha']);
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
  });

  it.each(['rename', 'remove', 'absent'] as const)('preserves malformed optional favorites during %s', async (operation) => {
    const f = await fixture();
    f.file(`${HOME}\\profile-favorites.json`, '{malformed');
    const before = { ...f.nodes.get(`${HOME}\\profile-favorites.json`)! };
    if (operation === 'rename') await renameManagedProfile(HOME, 'alpha', 'charlie', {}, f.services);
    else await removeManagedProfile(HOME, operation === 'remove' ? 'bravo' : 'missing', {}, f.services);
    expect(f.nodes.get(`${HOME}\\profile-favorites.json`)).toEqual(before);
    await f.recover();
    expect(f.nodes.get(`${HOME}\\profile-favorites.json`)).toEqual(before);
  });

  it.each(['bravo', 'ALPHA', 'BRAVO', 'CON', 'charlie'] as const)('refuses occupied/aliased/invalid destination %s', async (name) => {
    const f = await fixture(); if (name === 'charlie') f.file(`${HOME}\\profiles\\charlie`, 'occupied');
    const old = await f.services.capture(HOME, 'alpha');
    await expect(renameManagedProfile(HOME, 'alpha', name, {}, f.services)).rejects.toThrow();
    expect(await f.services.capture(HOME, 'alpha')).toEqual(old);
    expect(await scanWindowsTransactionJournals(f.backend, HOME)).toEqual([]);
  });

  it.each(['INTENT', 'DIRECTORY_RENAME_INTENT', 'DIRECTORY_RENAME_PROVEN', 'ACTIVE_SELECTION_INTENT', 'ACTIVE_SELECTION_PROVEN', 'FAVORITES_INTENT', 'FAVORITES_PROVEN', 'COMMITTED'] as RenamePhase[])('recovers interrupted rename after durable %s using shared phases', async (phase) => {
    const f = await fixture(); f.favorites(['alpha', 'bravo']);
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', { afterPhase(value) { if (value === phase) stop(); } }, f.services)).rejects.toThrow('simulated interruption');
    expect((await f.journal()).phase).toBe(phase);
    const beforeView = f.snapshot();
    if (phase !== 'COMMITTED') await expect(inspectManagedProfileActivation(HOME, phase === 'INTENT' || phase === 'DIRECTORY_RENAME_INTENT' ? 'alpha' : 'charlie', f.activation)).rejects.toThrow();
    expect(f.snapshot()).toBe(beforeView);
    const result = await f.recover();
    expect(result[0]!.action).toBe(phase === 'INTENT' ? 'aborted' : phase === 'COMMITTED' ? 'terminal' : 'committed');
    const name = phase === 'INTENT' ? 'alpha' : 'charlie';
    expect(await currentProfile(HOME, f.selection)).toBe(name);
    expect((await f.services.readFavorites(HOME)).favorites).toEqual([name, 'bravo'].sort());
    await useManagedProfile(HOME, name, f.activation);
  });

  it.each(['INTENT', 'FAVORITES_MUTATION_INTENT', 'FAVORITES_MUTATION_PROVEN', 'DIRECTORY_QUARANTINE_INTENT', 'DIRECTORY_QUARANTINE_PROVEN', 'COMMITTED'] as RemovePhase[])('recovers interrupted removal after durable %s', async (phase) => {
    const f = await fixture(); f.favorites(['alpha', 'bravo']);
    const before = await f.services.capture(HOME, 'bravo');
    await expect(removeManagedProfile(HOME, 'bravo', { afterPhase(value) { if (value === phase) stop(); } }, f.services)).rejects.toThrow('simulated interruption');
    expect((await f.journal()).phase).toBe(phase);
    expect((await f.recover())[0]!.action).toBe(phase === 'COMMITTED' ? 'terminal' : 'committed');
    expect(await f.services.capture(HOME, 'bravo')).toBeUndefined();
    const journal = await f.journal();
    expect(await f.services.capture(HOME, 'bravo', `.bazframe-backup-${journal.transactionId}`)).toEqual(before);
    expect((await f.services.readFavorites(HOME)).favorites).toEqual(['alpha']);
    await useManagedProfile(HOME, 'alpha', f.activation);
  });

  it.each(['rename-move', 'rename-selection', 'rename-favorites', 'remove-favorites', 'remove-move'] as const)('recovers effect window %s', async (window) => {
    const f = await fixture(); f.favorites(['alpha', 'bravo']);
    if (window === 'rename-selection' || window === 'rename-favorites') {
      const key = window === 'rename-selection' ? 'publishSelection' : 'publishFavorites';
      const original = f.services[key];
      // Wrap the actual publication, not the transaction or native move.
      if (key === 'publishSelection') {
        const actual = f.services.publishSelection;
        f.services.publishSelection = async (...args) => { await actual(...args); stop(); };
      } else {
        const actual = f.services.publishFavorites;
        f.services.publishFavorites = async (...args) => { await actual(...args); stop(); };
      }
      await expect(renameManagedProfile(HOME, 'alpha', 'charlie', {}, f.services)).rejects.toThrow('simulated interruption');
      Object.assign(f.services, { [key]: original });
    } else if (window === 'rename-move') await expect(renameManagedProfile(HOME, 'alpha', 'charlie', { afterDirectoryRename: stop }, f.services)).rejects.toThrow();
    else await expect(removeManagedProfile(HOME, 'bravo', window === 'remove-move' ? { afterDirectoryQuarantine: stop } : { afterFavoritesMutation: stop }, f.services)).rejects.toThrow();
    expect((await f.recover())[0]!.action).toBe('committed');
  });

  it('effectful activation recovers nonterminal lifecycle before reading its view', async () => {
    const f = await fixture();
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', { afterDirectoryRename: stop }, f.services)).rejects.toThrow();
    await useManagedProfile(HOME, 'charlie', f.activation);
    expect((await f.journal()).phase).toBe('COMMITTED');
    expect(await currentProfile(HOME, f.selection)).toBe('charlie');
  });

  it.each([false, true])('reconciles directory syscall rejection committed=%s and retries proved no-effect', async (committed) => {
    const f = await fixture(), move = f.backend.renameDirectoryNoReplace;
    f.backend.renameDirectoryNoReplace = async (...args) => { if (committed) await move(...args); throw new Error('sharing-style error'); };
    if (committed) await expect(renameManagedProfile(HOME, 'alpha', 'charlie', {}, f.services)).resolves.toMatchObject({ journal: { phase: 'COMMITTED' } });
    else {
      await expect(renameManagedProfile(HOME, 'alpha', 'charlie', {}, f.services)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_MOVE_NO_EFFECT' });
      expect((await f.journal()).phase).toBe('DIRECTORY_RENAME_INTENT');
      f.backend.renameDirectoryNoReplace = move;
      expect((await f.recover())[0]!.action).toBe('committed');
    }
  });

  it('retains ambiguous drift, re-reads under authority, skips busy locks and expires released authority', async () => {
    const f = await fixture();
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', { afterDirectoryRename: stop }, f.services)).rejects.toThrow();
    const journal = await f.journal();
    let escaped: OperationMutationAuthority | undefined;
    await f.services.withOperationLocks(HOME, ['alpha', 'charlie', '@store'], async (authority) => {
      escaped = authority;
      expect((await f.recover())[0]!.action).toBe('skipped-busy');
      expect(() => assertWindowsOperationMutationAuthority(authority, windowsProvisioningFixture().backend, HOME, ['alpha'], journal.transactionId)).toThrow();
    }, journal.transactionId);
    expect(() => assertWindowsOperationMutationAuthority(escaped!, f.backend, HOME, ['alpha'], journal.transactionId)).toThrow();
    f.nodes.get(`${HOME}\\profiles\\charlie\\AGENTS.md`)!.bytes = Buffer.from('drift');
    expect((await f.recover())[0]!.action).toBe('ambiguous');
    expect((await f.journal()).phase).toBe('AMBIGUOUS');
    await expect(useManagedProfile(HOME, 'bravo', f.activation)).rejects.toThrow();
    expect(await f.services.capture(HOME, 'charlie')).toBeDefined();
    // Recovery may acquire/release operation guards, but must not change profiles or state.
    expect(f.nodes.get(`${HOME}\\active-profile`)!.bytes?.toString()).toBe('alpha\n');
    expect(f.nodes.get(`${HOME}\\profiles\\charlie\\AGENTS.md`)!.bytes?.toString()).toBe('drift');
  });

  it.each(['empty', 'partial', 'old-v2', 'publication', 'candidate', 'alias', 'unknown'] as const)('refuses discovered %s journal without replay or POSIX effects', async (kind) => {
    const f = await fixture();
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', { afterPhase: stop }, f.services)).rejects.toThrow();
    const journal = await f.journal(), path = `${HOME}\\profile-publishing\\transactions\\${journal.transactionId}.json`;
    if (kind === 'empty') f.nodes.get(path)!.bytes = Buffer.alloc(0);
    if (kind === 'partial') f.nodes.get(path)!.bytes = Buffer.from('{');
    if (kind === 'old-v2' && journal.kind === 'rename-profile') f.nodes.get(path)!.bytes = Buffer.from(`${JSON.stringify({ ...journal, expectedOld: { ...journal.expectedOld, observationIdentity: 'f'.repeat(64) } }, null, 2)}\n`);
    if (kind === 'publication' && journal.kind === 'rename-profile') f.nodes.get(path)!.bytes = Buffer.from(encodeTransactionJournal({ schemaVersion: 2, identityDomain: 'win32-ntfs', kind: 'publication', transactionId: journal.transactionId, profileName: 'alpha', expectedProfile: journal.expectedOld, origin: 'github.com/example/profile', expectedBaseCommit: null, capturedManifestSha256: 'a'.repeat(64), originalVisibility: 'absent', desiredVisibility: 'private', repositoryCreated: false, repositoryId: null, observedCommit: null, phase: 'INTENT' }));
    if (kind === 'candidate') f.nodes.get(path)!.bytes = Buffer.from(encodeTransactionJournal({ schemaVersion: 2, identityDomain: 'win32-ntfs', kind: 'candidate-swap', transactionId: journal.transactionId, operation: 'fresh-import', profileName: 'alpha', expectedOld: { kind: 'absent' }, candidate: { token: `candidate:${journal.transactionId}`, identity: null, sidecarSha256: null, profileClosureSha256: null }, backup: null, activeProfileBefore: null, phase: 'PLANNED', possiblePackageEffects: [] }));
    if (kind === 'alias') { f.nodes.set(win32.join(win32.dirname(path), win32.basename(path).toUpperCase()), f.nodes.get(path)!); f.nodes.delete(path); }
    if (kind === 'unknown') f.file(`${HOME}\\profile-publishing\\transactions\\unknown`, 'keep');
    const before = f.snapshot();
    if (kind === 'candidate') {
      expect(await f.recover()).toEqual([expect.objectContaining({ action: 'ambiguous', kind: 'candidate-swap' })]);
      expect((await f.journal()).phase).toBe('AMBIGUOUS');
    } else if (kind === 'publication') {
      const bytes = Buffer.from(f.nodes.get(path)!.bytes!);
      const profiles = JSON.stringify([...f.nodes].filter(([entry]) => entry.startsWith(`${HOME}\\profiles\\`)));
      await expect(f.recover()).rejects.toMatchObject({ code: 'PROFILE_RECOVERY_ADAPTER_REQUIRED' });
      expect(f.nodes.get(path)!.bytes).toEqual(bytes);
      expect(JSON.stringify([...f.nodes].filter(([entry]) => entry.startsWith(`${HOME}\\profiles\\`)))).toBe(profiles);
    } else {
      await expect(f.recover()).rejects.toThrow();
      expect(f.snapshot()).toBe(before);
    }
  });

  it('retains partial initial final creation and never reclassifies it as absent', async () => {
    const f = await fixture();
    const services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, { stateIo: f.io, lockIo: f.io, journal: { io: f.io, hooks: { afterPrivateCreation: stop } } });
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', {}, services)).rejects.toMatchObject({ code: 'WINDOWS_TRANSACTION_JOURNAL_BEFORE_REPLACEMENT' });
    await expect(f.recover()).rejects.toThrow();
    expect(await f.services.capture(HOME, 'alpha')).toBeDefined();
  });

  it('refuses changed selection/favorites baseline after state-lock entry without overwriting it', async () => {
    const f = await fixture(); f.favorites(['alpha']);
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', { afterPhase(phase) {
      if (phase === 'ACTIVE_SELECTION_INTENT') f.file(`${HOME}\\active-profile`, 'bravo\n');
    } }, f.services)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_LIFECYCLE_REFUSED' });
    expect(await currentProfile(HOME, f.selection)).toBe('bravo');
    expect((await f.recover())[0]!.action).toBe('ambiguous');
  });

  it.each(['sidecar', 'local-skill', 'favorites-alias', 'favorites-oversize'] as const)('refuses unsupported %s before profile movement', async (kind) => {
    const f = await fixture();
    if (kind === 'sidecar') f.file(`${HOME}\\profiles\\bravo\\.bazframe-profile-state.json`, '{}');
    if (kind === 'local-skill') f.directory(`${HOME}\\profiles\\bravo\\skills\\local`);
    if (kind === 'favorites-alias') f.file(`${HOME}\\PROFILE-FAVORITES.JSON`, encodeProfileFavorites(['bravo']));
    if (kind === 'favorites-oversize') f.file(`${HOME}\\profile-favorites.json`, 'x'.repeat(64 * 1024 + 1));
    const root = f.nodes.get(`${HOME}\\profiles\\bravo`);
    await expect(renameManagedProfile(HOME, 'bravo', 'charlie', {}, f.services)).rejects.toThrow();
    await expect(removeManagedProfile(HOME, 'bravo', {}, f.services)).rejects.toThrow();
    expect(f.nodes.get(`${HOME}\\profiles\\bravo`)).toBe(root);
    expect(f.nodes.has(`${HOME}\\profiles\\charlie`)).toBe(false);
  });

  it.each(['selection', 'favorites'] as const)('classifies %s no-effect versus committed-after-error using actual state publication', async (kind) => {
    const f = await fixture(); f.favorites(['alpha']);
    const destination = `${HOME}\\${kind === 'selection' ? 'active-profile' : 'profile-favorites.json'}`;
    let commit = false;
    const io = { ...f.io, async rename(source: string, target: string) {
      if (target !== destination) return f.io.rename(source, target);
      if (commit) await f.io.rename(source, target);
      throw new Error('sharing-style state failure');
    } };
    const services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, { stateIo: io, lockIo: f.io, journal: { io: f.io } });
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', {}, services)).rejects.toMatchObject({
      code: 'WINDOWS_SELECTION_NO_EFFECT',
      message: expect.stringContaining(kind === 'selection' ? 'Selection replacement had no effect' : 'Favorites replacement had no effect')
    });
    expect(await currentProfile(HOME, f.selection)).toBe(kind === 'selection' ? 'alpha' : 'charlie');
    expect((await services.readFavorites(HOME)).favorites).toEqual(['alpha']);
    expect((await f.journal()).phase).toBe(kind === 'selection' ? 'ACTIVE_SELECTION_INTENT' : 'FAVORITES_INTENT');
    commit = true;
    expect((await recoverProfilePublishingTransactions(HOME, undefined, services))[0]!.action).toBe('committed');
    expect(await currentProfile(HOME, f.selection)).toBe('charlie');
    expect((await services.readFavorites(HOME)).favorites).toEqual(['charlie']);
  });

  it('identifies favorites candidate failure after active rename and retains recoverable state', async () => {
    const f = await fixture(); f.favorites(['alpha']);
    const favorites = JSON.stringify(f.nodes.get(`${HOME}\\profile-favorites.json`));
    const io = { ...f.io, async writeExistingFile(path: string, bytes: Uint8Array) {
      await f.io.writeExistingFile(path, bytes);
      if (win32.basename(path).startsWith('favorites-')) throw new Error('favorites candidate write failure');
    } };
    const services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, { stateIo: io, lockIo: f.io, journal: { io: f.io } });
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', {}, services)).rejects.toMatchObject({
      code: 'WINDOWS_SELECTION_BEFORE_EFFECT',
      message: expect.stringMatching(/^Favorites were not replaced;.*Retry from current favorites\.$/u)
    });
    expect(await currentProfile(HOME, f.selection)).toBe('charlie');
    expect(await services.capture(HOME, 'alpha')).toBeUndefined();
    expect(await services.capture(HOME, 'charlie')).toBeDefined();
    expect(JSON.stringify(f.nodes.get(`${HOME}\\profile-favorites.json`))).toBe(favorites);
    expect((await f.journal()).phase).toBe('FAVORITES_INTENT');
    const candidates = [...f.nodes.keys()].filter((path) => /favorites-[a-f0-9]{32}\.tmp$/u.test(path));
    expect(candidates).toHaveLength(1);
    const candidate = JSON.stringify(f.nodes.get(candidates[0]!));
    expect(f.nodes.get(candidates[0]!)!.bytes).toEqual(Buffer.from(encodeProfileFavorites(['charlie'])));
    expect((await f.recover())[0]!.action).toBe('committed');
    expect((await services.readFavorites(HOME)).favorites).toEqual(['charlie']);
    expect(JSON.stringify(f.nodes.get(candidates[0]!))).toBe(candidate);
  });

  it('refuses favorites drift after durable intent instead of overwriting the new preference', async () => {
    const f = await fixture(); f.favorites(['alpha']);
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', { afterPhase(phase) {
      if (phase === 'FAVORITES_INTENT') f.favorites(['bravo']);
    } }, f.services)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_LIFECYCLE_REFUSED' });
    expect((await f.services.readFavorites(HOME)).favorites).toEqual(['bravo']);
    expect((await f.recover())[0]!.action).toBe('ambiguous');
    expect((await f.services.readFavorites(HOME)).favorites).toEqual(['bravo']);
  });

  it('re-reads journal identity under locks and refuses substitution', async () => {
    const f = await fixture();
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', { afterPhase: stop }, f.services)).rejects.toThrow();
    const journal = await f.journal();
    if (journal.kind !== 'rename-profile') throw new Error('kind');
    const original = f.services.withOperationLocks;
    f.services.withOperationLocks = (home, keys, operation, id) => original(home, keys, async (authority) => {
      f.nodes.get(`${HOME}\\profile-publishing\\transactions\\${journal.transactionId}.json`)!.bytes = Buffer.from(encodeTransactionJournal({ ...journal, newName: 'delta' }));
      return operation(authority);
    }, id);
    await expect(f.recover()).rejects.toMatchObject({ code: 'PROFILE_RECOVERY_INVALID' });
    expect(await f.services.capture(HOME, 'alpha')).toBeDefined();
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
  });

  it('discovers settled journals deterministically and ignores admitted retained temporary contents', async () => {
    const f = await fixture();
    await renameManagedProfile(HOME, 'alpha', 'charlie', {}, f.services);
    await removeManagedProfile(HOME, 'bravo', {}, f.services);
    f.file(`${HOME}\\profile-publishing\\transactions\\.tmp-${'f'.repeat(32)}`, 'partial retained temp');
    const names = await scanWindowsTransactionJournals(f.backend, HOME);
    expect(names).toHaveLength(2); expect(names).toEqual([...names].sort());
    expect((await f.recover()).map((value) => value.action)).toEqual(['terminal', 'terminal']);
    await useManagedProfile(HOME, 'charlie', f.activation);
    expect(await currentProfile(HOME, f.selection)).toBe('charlie');
  });


  it('revalidates the renamed closure after state candidate preparation before replacement', async () => {
    const f = await fixture();
    const io = { ...f.io, async writeExistingFile(path: string, bytes: Uint8Array) {
      await f.io.writeExistingFile(path, bytes);
      if (win32.basename(path).startsWith('selection-')) f.nodes.get(`${HOME}\\profiles\\charlie\\AGENTS.md`)!.bytes = Buffer.from('late drift');
    } };
    const services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, { stateIo: io, lockIo: f.io, journal: { io: f.io } });
    await expect(renameManagedProfile(HOME, 'alpha', 'charlie', {}, services)).rejects.toMatchObject({ code: 'WINDOWS_SELECTION_BEFORE_EFFECT' });
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
    expect((await f.recover())[0]!.action).toBe('ambiguous');
  });

});
