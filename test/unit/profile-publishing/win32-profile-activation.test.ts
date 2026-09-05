import * as fs from 'node:fs/promises';
import { win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readlink: vi.fn(actual.readlink) };
});
vi.mock('node:path', async (original) => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, basename: (path: string, suffix?: string) => path.includes('\\') ? actual.win32.basename(path, suffix) : actual.basename(path, suffix) };
});
afterEach(() => vi.restoreAllMocks());
import { addProfile, currentProfile } from '../../../src/profiles/profile-management.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { createWindowsProfileSelectionReadServicesForInternalTesting } from '../../../src/profiles/win32-profile-selection.js';
import { inspectManagedProfileActivation, useManagedProfile } from '../../../src/profile-publishing/profile-managed-lifecycle.js';
import { createWindowsProfileActivationServicesForInternalTesting, type WindowsProfileActivationTestOptions } from '../../../src/profile-publishing/win32-profile-activation.js';
import { ensureWindowsPrivateDirectoryPath } from '../../../src/state/win32-private-directory.js';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
const HOME = 'C:\\boundary\\home';
async function fixture() {
  const f = windowsProvisioningFixture();
  const provisioningServices = createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io });
  await addProfile(HOME, 'alpha', { provisioningServices }); await addProfile(HOME, 'bravo', { provisioningServices });
  f.nodes.get(`${HOME}\\profiles\\alpha\\AGENTS.md`)!.bytes = Buffer.from('# Alpha\n');
  f.nodes.get(`${HOME}\\profiles\\bravo\\AGENTS.md`)!.bytes = Buffer.from('# Bravo\n');
  const io = { ...f.io, async rename(source: string, target: string) { const node = f.nodes.get(source)!; f.nodes.delete(source); f.nodes.set(target, node); } };
  const services = (options: WindowsProfileActivationTestOptions = {}) => createWindowsProfileActivationServicesForInternalTesting(f.backend, { lockIo: f.io, selectionIo: io, ...options });
  return { ...f, services, selection: createWindowsProfileSelectionReadServicesForInternalTesting(f.backend) };
}

describe('actual managed activation with native observations', () => {
  it('captures edited closures, uses shared view/projection, locks in order, activates and switches without profile writes', async () => {
    const f = await fixture();
    const events: string[] = [];
    const services = f.services({ hooks: { afterOperationLock(key) { events.push(key); }, afterStateLock() { events.push('state'); }, beforeReplacement() { events.push('replace'); }, beforeReturn() { events.push('return'); } } });
    const before = [...f.nodes].filter(([path]) => path.startsWith(`${HOME}\\profiles\\`));
    const readOnly = f.snapshot();
    const inspection = await inspectManagedProfileActivation(HOME, 'alpha', services);
    expect(f.snapshot()).toBe(readOnly);
    expect(inspection.expectation.closure.entries).toEqual([{ path: 'AGENTS.md', kind: 'file', bytes: 8, executable: false, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }]);
    expect(inspection.profile).toMatchObject({ name: 'alpha', resourceIdentities: [], incomplete: false });
    expect((await services.readSystemView(HOME)).profiles.map((profile) => profile.name)).toEqual(['alpha', 'bravo']);
    expect(await useManagedProfile(HOME, 'alpha', services)).toMatchObject({ active: true, incomplete: false, warning: null });
    expect(events).toEqual(['@store', 'alpha', 'state', 'replace', 'return']);
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
    const prior = f.nodes.get(`${HOME}\\active-profile`)!.id;
    await useManagedProfile(HOME, 'bravo', services);
    expect(await currentProfile(HOME, f.selection)).toBe('bravo');
    expect(f.nodes.get(`${HOME}\\active-profile`)!.id).not.toBe(prior);
    expect([...f.nodes].filter(([path]) => path.startsWith(`${HOME}\\profiles\\`))).toEqual(before);
  });
  it('consumes native junction observations in the real closure, ownership, selector and projection algorithms', async () => {
    const f = await fixture();
    const target = 'C:\\boundary\\demo-skill';
    f.directory(target); f.file(`${target}\\SKILL.md`, '---\nname: demo-skill\n---\n# Demo\n');
    f.directory(`${HOME}\\skills`);
    const catalog = `${HOME}\\skills\\demo-skill`;
    const link = `${HOME}\\profiles\\alpha\\skills\\demo-skill`;
    f.reparse(catalog); f.reparse(link);
    vi.mocked(fs.readlink).mockImplementation(async () => target);
    f.backend.inspectMembershipLink = (path) => {
      const value = f.backend.inspectPath(path);
      if (value.object.reparseTag !== 0xa0000003) throw new Error('not a junction');
      const destination = f.backend.inspectPath(target);
      return { ...value, normalizedTarget: destination.canonicalPath, targetVolumeIdentity: destination.object.volumeIdentity, targetFileId: destination.object.fileId };
    };
    const services = f.services();
    const inspection = await inspectManagedProfileActivation(HOME, 'alpha', services);
    expect(inspection.expectation.closure.entries).toContainEqual({ path: 'skills/demo-skill', kind: 'membership-link', targetIdentity: 'catalog:skill:demo-skill' });
    const view = await services.readSystemView(HOME);
    expect(view.profiles.find((profile) => profile.name === 'alpha')?.resourceIdentities).toEqual(['catalog:skill:demo-skill']);
    expect(view.resources).toEqual([{ stableIdentity: 'catalog:skill:demo-skill', key: { kind: 'skill', name: 'demo-skill' }, ownerProfiles: ['alpha'], materialization: { kind: 'ordinary' }, projected: true }]);
    expect(view.skills[0]).toMatchObject({ ownerProfiles: ['alpha'], selectors: ['demo-skill', 'alpha/demo-skill'], directory: target, directlyAttachable: true });
    expect((await useManagedProfile(HOME, 'alpha', services)).active).toBe(true);
    const old = { ...f.nodes.get(`${HOME}\\active-profile`)! };
    await expect(useManagedProfile(HOME, 'alpha', f.services({ hooks: { afterStateLock() { f.reparse(link); } } }))).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ACTIVATION_CHANGED' });
    expect(f.nodes.get(`${HOME}\\active-profile`)).toEqual(old);
    expect(f.nodes.get(win32.join(target, 'SKILL.md'))?.bytes?.toString()).toContain('# Demo');
  });

  it.each(['sidecar', 'local-skill', 'collections', 'imported', 'other-profile'] as const)('refuses occupied %s before lock/publication and never enters ordinary fallback', async (kind) => {
    const f = await fixture();
    if (kind === 'sidecar' || kind === 'other-profile') f.file(`${HOME}\\profiles\\${kind === 'sidecar' ? 'alpha' : 'bravo'}\\.bazframe-profile-state.json`, '{}');
    if (kind === 'local-skill') f.directory(`${HOME}\\profiles\\alpha\\skills\\demo-skill`);
    if (kind === 'collections') { f.directory(`${HOME}\\libraries`); f.file(`${HOME}\\libraries\\demo.json`, '{}'); }
    if (kind === 'imported') { ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profile-publishing\\trees`); f.file(`${HOME}\\profile-publishing\\trees\\occupied`, 'keep'); }
    const before = f.snapshot();
    await expect(useManagedProfile(HOME, 'alpha', f.services())).rejects.toThrow();
    expect(f.snapshot()).toBe(before);
  });
  it('resolves expected old selection only after state lock and refuses profile drift there', async () => {
    const f = await fixture(); f.file(`${HOME}\\active-profile`, 'bravo\r\n');
    await useManagedProfile(HOME, 'alpha', f.services({ hooks: { afterStateLock() { f.file(`${HOME}\\active-profile`, 'missing\r\n'); } } }));
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
    const old = { ...f.nodes.get(`${HOME}\\active-profile`)! };
    await expect(useManagedProfile(HOME, 'bravo', f.services({ hooks: { afterStateLock() { f.nodes.get(`${HOME}\\profiles\\bravo\\AGENTS.md`)!.bytes = Buffer.from('drift'); } } }))).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ACTIVATION_CHANGED' });
    expect(f.nodes.get(`${HOME}\\active-profile`)).toEqual(old);
  });
  it('revalidates dependent profile bytes immediately before replacement, after candidate preparation', async () => {
    const f = await fixture(); f.file(`${HOME}\\active-profile`, 'bravo\r\n');
    const before = { ...f.nodes.get(`${HOME}\\active-profile`)! };
    await expect(useManagedProfile(HOME, 'alpha', f.services({ hooks: { beforeReplacement() { f.nodes.get(`${HOME}\\profiles\\alpha\\AGENTS.md`)!.bytes = Buffer.from('drift'); } } }))).rejects.toMatchObject({ code: 'WINDOWS_SELECTION_BEFORE_EFFECT' });
    expect(f.nodes.get(`${HOME}\\active-profile`)).toEqual(before);
  });

  it.each(['file', 'directory'] as const)('reconciles enumerated %s metadata with opened observations', async (kind) => {
    const f = await fixture();
    const enumerate = f.backend.enumerateStableDirectory;
    f.backend.enumerateStableDirectory = async (...args) => {
      const value = await enumerate(...args);
      return { ...value, entries: value.entries.map((entry) => entry.name === (kind === 'file' ? 'AGENTS.md' : 'skills') ? { ...entry, size: '0000000000000042', allocationSize: '0000000000000042' } : entry) };
    };
    if (kind === 'file') await expect(inspectManagedProfileActivation(HOME, 'alpha', f.services())).rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED' });
    else expect((await inspectManagedProfileActivation(HOME, 'alpha', f.services())).profile.name).toBe('alpha');
  });

  it('reports committed selection honestly on dependent postcheck failure', async () => {
    const f = await fixture();
    await expect(useManagedProfile(HOME, 'alpha', f.services({ hooks: { afterReplacement() { f.nodes.get(`${HOME}\\profiles\\alpha\\AGENTS.md`)!.bytes = Buffer.from('drift'); } } }))).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ACTIVATION_COMMITTED_CHECK_FAILED' });
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
    expect(f.nodes.get(`${HOME}\\active-profile`)?.bytes).toEqual(Buffer.from('alpha\n'));
  });
  it('validates keys, releases partial acquisitions, and expires escaped authority', async () => {
    const f = await fixture(); const services = f.services(); const transaction = 'a'.repeat(32);
    for (const keys of [[], ['alpha', 'alpha'], ['../bad']]) await expect(services.withOperationLocks(HOME, keys, transaction, async () => undefined)).rejects.toMatchObject({ code: 'PROFILE_OPERATION_LOCK_INVALID' });
    let escaped: { assertHeld(): void } | undefined;
    await services.withOperationLocks(HOME, ['bravo', '@store'], transaction, async (authority) => { escaped = authority; authority.assertHeld(HOME, 'bravo'); expect(() => authority.assertHeld(`${HOME}-other`, 'bravo')).toThrow(); expect(() => authority.assertHeld(HOME, 'alpha')).toThrow(); });
    expect(() => escaped!.assertHeld()).toThrow();
    await expect(f.services({ hooks: { afterOperationLock(key) { if (key === 'alpha') throw new Error('partial'); } } }).withOperationLocks(HOME, ['alpha', '@store'], transaction, async () => undefined)).rejects.toThrow('partial');
    await expect(services.withOperationLocks(HOME, ['alpha', '@store'], transaction, async () => 'retry')).resolves.toBe('retry');
  });
});
