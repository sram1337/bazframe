import { createWindowsAddedSkillPlatformServicesForInternalTesting } from '../../../src/skills/added-skill-platform-services.js';
import type { WindowsPathInspection } from '../../../src/core/win32-native.js';
import { createHash } from 'node:crypto';
import { serializeWindowsPhysicalProfileProof, samePhysicalProfileProof } from '../../../src/profile-publishing/physical-profile-closure.js';
import { encodeTransactionJournal, decodeTransactionJournalBytes, type RenameProfileJournalV2 } from '../../../src/profile-publishing/transaction-journal.js';
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
import { BazframeError } from '../../../src/core/errors.js';
import * as operationLocks from '../../../src/profile-publishing/profile-operation-lock.js';
import { addProfile, currentProfile, listProfiles } from '../../../src/profiles/profile-management.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { createWindowsProfileSelectionReadServicesForInternalTesting } from '../../../src/profiles/win32-profile-selection.js';
import { loadProfile } from '../../../src/profiles/profile-store.js';
import { addProfileSkill, removeProfileSkill } from '../../../src/profiles/profile-skill-membership.js';
import { createWindowsOrdinaryProfileReads } from '../../../src/profile-publishing/win32-physical-profile-reads.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import { encodeManagedProfileState } from '../../../src/profile-publishing/publication-state.js';
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

async function membershipFixture() {
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
  return { ...f, target, catalog, link };
}

describe('actual managed activation with native observations', () => {
  it.each([false, true])('loads/lists/uses unregistered references and inert legacy content with sidecar=%s', async (sidecar) => {
    const f = await membershipFixture(); f.nodes.delete(f.catalog);
    const inert = `${HOME}\\profiles\\alpha\\source-units`;
    f.directory(inert); f.reparse(`${inert}\\opaque`);
    const enumerate = f.backend.enumerateStableDirectory;
    f.backend.enumerateStableDirectory = async (path, max) => { if (path.startsWith(inert)) throw new Error('inert contents must not be traversed'); return enumerate(path, max); };
    if (sidecar) f.file(`${HOME}\\profiles\\alpha\\.bazframe-profile-state.json`, encodeManagedProfileState({ schemaVersion: 1, profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publication: null, capturedResourceIds: [], importedResources: [] }, capturedProfileLimitPolicy()));
    const platform = createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend);
    const before = f.snapshot();
    expect((await loadProfile(HOME, 'alpha', { platformServices: platform })).skillDirectories).toEqual([f.target]);
    expect(await listProfiles(HOME, { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend) })).toEqual({ profileIds: ['alpha', 'bravo'], diagnostics: [] });
    const view = await f.services().readSystemView(HOME);
    expect(view.resources).toEqual([]); expect(view.skills).toEqual([]);
    expect(view.profiles.find((profile) => profile.name === 'alpha')?.resourceIdentities).toEqual([]);
    expect(f.snapshot()).toBe(before);
    await expect(createWindowsOrdinaryProfileReads(f.backend).captureExpectation(HOME, 'alpha')).rejects.toThrow('source-units');
    const preserved = JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(`${HOME}\\profiles\\`) || path.startsWith(f.target) || path.startsWith(`${HOME}\\skills`)));
    expect((await useManagedProfile(HOME, 'alpha', f.services())).active).toBe(true);
    expect(JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(`${HOME}\\profiles\\`) || path.startsWith(f.target) || path.startsWith(`${HOME}\\skills`)))).toBe(preserved);
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
    await expect(useManagedProfile(HOME, 'sram-dev', f.services())).rejects.toThrow();
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
  });

  it('keeps unregistered management and strict capture refused with no profile/source writes', async () => {
    const f = await membershipFixture(); f.nodes.delete(f.catalog);
    const platformServices = createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend, { lockIo: f.io });
    await expect(createWindowsOrdinaryProfileReads(f.backend).captureExpectation(HOME, 'alpha')).rejects.toMatchObject({ code: 'DEFAULT_SKILL_NOT_FOUND' });
    const source = JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(`${HOME}\\profiles\\`) || path.startsWith(f.target)));
    await expect(addProfileSkill({ bazframeHome: HOME, platformServices }, 'alpha', 'demo-skill')).rejects.toThrow();
    await expect(removeProfileSkill({ bazframeHome: HOME, platformServices }, 'alpha', 'demo-skill')).rejects.toThrow();
    expect(JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(`${HOME}\\profiles\\`) || path.startsWith(f.target)))).toBe(source);
  });

  it('does not grant same-name foreign references catalog ownership', async () => {
    const f = await membershipFixture(); const other = 'C:\\boundary\\other\\demo-skill';
    f.directory('C:\\boundary\\other'); f.directory(other); f.file(`${other}\\SKILL.md`, '---\nname: demo-skill\n---\n');
    const membership = f.backend.inspectMembershipLink;
    f.backend.inspectMembershipLink = (path) => { const value = membership(path); const destination = f.backend.inspectPath(path === f.link ? other : f.target); return { ...value, normalizedTarget: destination.canonicalPath, targetVolumeIdentity: destination.object.volumeIdentity, targetFileId: destination.object.fileId }; };
    vi.mocked(fs.readlink).mockImplementation(async (path) => String(path) === f.link ? other : f.target);
    expect((await loadProfile(HOME, 'alpha', { platformServices: createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend) })).skillDirectories).toEqual([other]);
    const view = await f.services().readSystemView(HOME);
    expect(view.profiles.find((profile) => profile.name === 'alpha')?.resourceIdentities).toEqual([]);
    expect(view.skills[0]).toMatchObject({ ownerProfiles: [], selectors: ['demo-skill'], directory: f.target });
    await expect(createWindowsOrdinaryProfileReads(f.backend).captureExpectation(HOME, 'alpha')).rejects.toThrow();
    expect((await useManagedProfile(HOME, 'alpha', f.services())).active).toBe(true);
  });

  it.each(['definition', 'retarget'] as const)('refuses direct reference %s drift at final selection checks', async (variant) => {
    const f = await membershipFixture(); f.nodes.delete(f.catalog);
    await useManagedProfile(HOME, 'bravo', f.services());
    await expect(useManagedProfile(HOME, 'alpha', f.services({ hooks: { beforeReplacement() {
      if (variant === 'definition') f.nodes.get(`${f.target}\\SKILL.md`)!.bytes = Buffer.from('---\nname: demo-skill\n---\nchanged');
      else f.reparse(f.link);
    } } }))).rejects.toThrow();
    expect(await currentProfile(HOME, f.selection)).toBe('bravo');
  });

  it('refuses a link replaced during ordinary load definition reads', async () => {
    const f = await membershipFixture(); f.nodes.delete(f.catalog);
    const read = f.backend.readStableFile;
    f.backend.readStableFile = async (...args) => { const value = await read(...args); if (args[0] === `${f.target}\\SKILL.md`) f.reparse(f.link); return value; };
    await expect(loadProfile(HOME, 'alpha', { platformServices: createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend) })).rejects.toMatchObject({ code: 'SKILL_READ_FAILED' });
  });

  it('refuses direct definition drift between native capture passes', async () => {
    const f = await membershipFixture(); f.nodes.delete(f.catalog);
    await expect(f.services().captureExpectation(HOME, 'alpha', {}, { async beforeSecondPass() { f.nodes.get(`${f.target}\\SKILL.md`)!.bytes = Buffer.from('---\nname: demo-skill\n---\nchanged'); } })).rejects.toThrow();
  });

  it('reports bounded actionable per-profile load failures and keeps listing healthy siblings', async () => {
    const f = await membershipFixture(); f.nodes.delete(f.catalog);
    f.nodes.get(`${f.target}\\SKILL.md`)!.bytes = Buffer.from('invalid definition');
    const before = f.snapshot();
    const result = await listProfiles(HOME, { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend) });
    expect(result.profileIds).toEqual(['bravo']);
    expect(result.diagnostics[0]).toContain('alpha'); expect(result.diagnostics[0]).toContain('SKILL_READ_FAILED'); expect(result.diagnostics[0]).toContain('INVALID_SKILL_DEFINITION'); expect(result.diagnostics[0]).toContain('YAML frontmatter');
    expect(f.snapshot()).toBe(before);
  });

  it.each(['volumeIdentity', 'fileId', 'size', 'allocationSize', 'numberOfLinks', 'creationTime', 'lastWriteTime', 'changeTime', 'attributes', 'reparseTag', 'deletePending', 'directory'] as const)('retains native membership object %s across actual closure passes', async (field) => {
    const f = await membershipFixture(), membership = f.backend.inspectMembershipLink;
    let drift = false;
    f.backend.inspectMembershipLink = (path) => {
      const value = membership(path);
      if (!drift || path !== f.link) return value;
      const prior = value.object[field];
      return { ...value, object: { ...value.object, [field]: typeof prior === 'boolean' ? !prior : typeof prior === 'number' ? prior ^ 1 : 'f'.repeat(String(prior).length) } };
    };
    const before = f.snapshot();
    await expect(f.services().captureExpectation(HOME, 'alpha', {}, { async beforeSecondPass() { drift = true; } })).rejects.toThrow();
    expect(f.snapshot()).toBe(before);
  });

  it.each(['canonicalPath', 'normalizedTarget', 'targetVolumeIdentity', 'targetFileId'] as const)('retains native membership %s in the actual observation map', async (field) => {
    const f = await membershipFixture(), membership = f.backend.inspectMembershipLink;
    let drift = false;
    f.backend.inspectMembershipLink = (path) => {
      const value = membership(path);
      if (!drift || path !== f.link) return value;
      return { ...value, [field]: `${value[field]}-changed` };
    };
    const before = f.snapshot();
    await expect(f.services().captureExpectation(HOME, 'alpha', {}, { async beforeSecondPass() { drift = true; } })).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ACTIVATION_CHANGED' });
    expect(f.snapshot()).toBe(before);
  });

  it.each(['root', 'skills', 'instructions', 'profiles-parent'] as const)('accepts independent %s access-only drift in actual capture/assert/use', async (kind) => {
    const f = await fixture(), services = f.services();
    const original = (await inspectManagedProfileActivation(HOME, 'alpha', services)).expectation;
    const path = kind === 'profiles-parent' ? `${HOME}\\profiles` : `${HOME}\\profiles\\alpha${kind === 'skills' ? '\\skills' : kind === 'instructions' ? '\\AGENTS.md' : ''}`;
    const inspect = f.backend.inspectPath, enumerate = f.backend.enumerateStableDirectory, read = f.backend.readStableFile;
    let clock = 10, changed = 0;
    const time = () => (++clock).toString(16).padStart(16, '0');
    const access = (value: WindowsPathInspection) => { changed++; return { ...value, object: { ...value.object, lastAccessTime: time() } }; };
    f.backend.inspectPath = (name) => { const value = inspect(name); return win32.normalize(name) === path ? access(value) : value; };
    f.backend.enumerateStableDirectory = async (...args) => { const value = await enumerate(...args); return win32.normalize(args[0]) === path ? { ...value, directoryBefore: access(value.directoryBefore), directoryAfter: access(value.directoryAfter) } : value; };
    f.backend.readStableFile = async (...args) => { const value = await read(...args); return win32.normalize(args[0]) === path ? { ...value, before: { ...value.before, lastAccessTime: time() }, after: { ...value.after, lastAccessTime: time() } } : value; };
    const before = f.snapshot(), observed = (await inspectManagedProfileActivation(HOME, 'alpha', services)).expectation;
    expect(observed).toEqual(original); expect(f.snapshot()).toBe(before); expect(changed).toBeGreaterThan(0);
    await expect(services.assertExpectation(HOME, 'alpha', original)).resolves.toBeUndefined();
    expect((await useManagedProfile(HOME, 'alpha', services)).active).toBe(true);
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
    expect((await inspectManagedProfileActivation(HOME, 'alpha', services)).expectation).toEqual(original);
  });

  it('asserts fresh admission and core proof after unrelated sibling changes between captures', async () => {
    const f = await fixture(), services = f.services();
    const expected = await services.captureExpectation(HOME, 'alpha');
    f.directory(`${HOME}\\profiles\\unrelated`);
    await expect(services.assertExpectation(HOME, 'alpha', expected)).resolves.toBeUndefined();
    expect(await services.captureExpectation(HOME, 'alpha')).toEqual(expected);
  });

  it.each(['lastWriteTime', 'changeTime', 'entry'] as const)('retains final profiles-parent %s binding even with unchanged profile closure', async (field) => {
    const f = await fixture(), services = f.services(), path = `${HOME}\\profiles`;
    const inspect = f.backend.inspectPath, enumerate = f.backend.enumerateStableDirectory;
    let drift = false;
    const change = (value: WindowsPathInspection) => field === 'entry' ? value : { ...value, object: { ...value.object, [field]: '0000000000000099' } };
    f.backend.inspectPath = (name) => { const value = inspect(name); return drift && name === path ? change(value) : value; };
    f.backend.enumerateStableDirectory = async (...args) => {
      const value = await enumerate(...args);
      return drift && args[0] === path ? { ...value, directoryBefore: change(value.directoryBefore), directoryAfter: change(value.directoryAfter), entries: field === 'entry' ? value.entries.map((entry) => entry.name === 'bravo' ? { ...entry, fileId: 'f'.repeat(32) } : entry) : value.entries } : value;
    };
    const before = f.snapshot();
    await expect(services.captureExpectation(HOME, 'alpha', {}, { async beforeSecondPass() { drift = true; } })).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ACTIVATION_CHANGED' });
    expect(f.snapshot()).toBe(before);
  });

  it('captures edited closures, uses shared view/projection, locks in order, activates and switches without profile writes', async () => {
    const f = await fixture();
    const assertShared = operationLocks.assertOperationMutationAuthority;
    const sharedChecks = vi.spyOn(operationLocks, 'assertOperationMutationAuthority').mockImplementation((authority, home, keys, transactionId) => {
      assertShared(authority, home, keys, transactionId);
      expect(operationLocks.operationAuthorityTransactionId(authority)).toBe(transactionId);
    });
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
    expect(sharedChecks).toHaveBeenCalledWith(expect.anything(), HOME, ['@store', 'alpha'], expect.stringMatching(/^[a-f0-9]{32}$/u));
    expect(() => operationLocks.operationAuthorityTransactionId(sharedChecks.mock.calls[0]![0])).toThrow();
    expect(await currentProfile(HOME, f.selection)).toBe('alpha');
    const prior = f.nodes.get(`${HOME}\\active-profile`)!.id;
    await useManagedProfile(HOME, 'bravo', services);
    expect(await currentProfile(HOME, f.selection)).toBe('bravo');
    expect(f.nodes.get(`${HOME}\\active-profile`)!.id).not.toBe(prior);
    expect([...f.nodes].filter(([path]) => path.startsWith(`${HOME}\\profiles\\`))).toEqual(before);
  });
  it('round trips core activation proof and moves the same logical profile to a freshly admitted home', async () => {
    const f = await fixture(), services = f.services();
    const expectation = await services.captureExpectation(HOME, 'alpha');
    const proof = serializeWindowsPhysicalProfileProof(expectation);
    expect(proof.identity).toMatch(/^win32-ntfs:[a-f0-9]{16}:[a-f0-9]{32}$/u);
    expect(Object.keys(proof)).toEqual(['identity', 'sidecarSha256', 'profileClosureSha256']);
    const canonical = `${JSON.stringify(expectation.closure, null, 2)}\n`;
    expect(proof.profileClosureSha256).toBe(createHash('sha256').update('bazframe-physical-profile-closure-v1\0').update(canonical).digest('hex'));
    const journal: RenameProfileJournalV2 = {
      schemaVersion: 2, identityDomain: 'win32-ntfs', kind: 'rename-profile', transactionId: 'a'.repeat(32),
      oldName: 'alpha', newName: 'charlie', expectedOld: proof, expectedNew: { kind: 'absent' },
      activeBefore: null, activeAfter: null, favoritesBeforeSha256: null, favoritesAfterCanonicalBytesSha256: null, phase: 'INTENT'
    };
    const decoded = decodeTransactionJournalBytes(Buffer.from(encodeTransactionJournal(journal)));
    if (decoded.kind !== 'rename-profile' || decoded.schemaVersion !== 2) throw new Error('wrong codec domain');
    expect(decoded.expectedOld).toEqual(proof);
    const legacy = { ...journal, expectedOld: { ...proof, observationIdentity: 'f'.repeat(64) } };
    expect(() => decodeTransactionJournalBytes(Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`))).toThrow();
    const destination = `${HOME}-moved`;
    for (const [path, node] of [...f.nodes]) {
      if (path === HOME || path.startsWith(`${HOME}\\`)) { f.nodes.delete(path); f.nodes.set(destination + path.slice(HOME.length), node); }
    }
    const moved = await services.captureExpectation(destination, 'alpha');
    expect(samePhysicalProfileProof(moved, expectation)).toBe(true);
    await expect(services.assertExpectation(destination, 'alpha', expectation)).resolves.toBeUndefined();
    f.directory(`${destination}\\profiles\\alpha`);
    await expect(services.assertExpectation(destination, 'alpha', expectation)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ACTIVATION_CHANGED' });
  });
  it.each([false, true, 'native-link-only'] as const)('consumes native junction observations with access drift=%s in real capture/assert/use and catalog proofs', async (accessDrift) => {
    const f = await membershipFixture();
    const { target, link } = f;
    const services = f.services();
    const baseline = await inspectManagedProfileActivation(HOME, 'alpha', services);
    const platform = createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend);
    const linkProof = platform.inspectSkillLink(win32.dirname(link), 'demo-skill', target);
    const inspect = f.backend.inspectPath, membership = f.backend.inspectMembershipLink;
    let clock = 10;
    if (accessDrift === true) {
      f.backend.inspectPath = (path) => { const value = inspect(path); return { ...value, object: { ...value.object, lastAccessTime: (++clock).toString(16).padStart(16, '0') } }; };
    }
    if (accessDrift) {
      f.backend.inspectMembershipLink = (path) => { const value = membership(path); return { ...value, object: { ...value.object, lastAccessTime: (++clock).toString(16).padStart(16, '0') } }; };
    }
    expect(platform.inspectSkillLink(win32.dirname(link), 'demo-skill', target)).toEqual(linkProof);
    const inspection = await inspectManagedProfileActivation(HOME, 'alpha', services);
    expect(inspection.expectation).toEqual(baseline.expectation);
    await expect(services.assertExpectation(HOME, 'alpha', baseline.expectation)).resolves.toBeUndefined();
    expect(inspection.expectation.closure.entries).toContainEqual(expect.objectContaining({ path: 'skills/demo-skill', kind: 'membership-link', targetIdentity: 'catalog:skill:demo-skill' }));
    const view = await services.readSystemView(HOME);
    expect(view.profiles.find((profile) => profile.name === 'alpha')?.resourceIdentities).toEqual(['catalog:skill:demo-skill']);
    expect(view.resources).toEqual([{ stableIdentity: 'catalog:skill:demo-skill', key: { kind: 'skill', name: 'demo-skill' }, ownerProfiles: ['alpha'], materialization: { kind: 'ordinary' }, projected: true }]);
    expect(view.skills[0]).toMatchObject({ ownerProfiles: ['alpha'], selectors: ['demo-skill', 'alpha/demo-skill'], directory: target, directlyAttachable: true });
    expect((await useManagedProfile(HOME, 'alpha', services)).active).toBe(true);
    // Read/use binds the physical reference, not just its logical catalog identity.
    await expect(useManagedProfile(HOME, 'alpha', f.services({ hooks: { afterStateLock() { f.reparse(link); } } }))).rejects.toThrow();
    const old = { ...f.nodes.get(`${HOME}\\active-profile`)! };
    await expect(useManagedProfile(HOME, 'alpha', f.services({ hooks: { afterStateLock() { f.file(link, 'not a junction'); } } }))).rejects.toThrow();
    expect(f.nodes.get(`${HOME}\\active-profile`)).toEqual(old);
    expect(f.nodes.get(win32.join(target, 'SKILL.md'))?.bytes?.toString()).toContain('# Demo');
  });

  it.each(['sidecar', 'local-skill', 'collections', 'imported', 'other-profile'] as const)('refuses occupied %s before lock/publication and never enters ordinary fallback', async (kind) => {
    const f = await fixture();
    const sidecar = kind === 'sidecar' || kind === 'other-profile' ? `${HOME}\\profiles\\${kind === 'sidecar' ? 'alpha' : 'bravo'}\\.bazframe-profile-state.json` : undefined;
    if (sidecar !== undefined) {
      await useManagedProfile(HOME, 'alpha', f.services());
      f.file(sidecar, '{}');
    }
    const selectionBefore = { ...f.nodes.get(`${HOME}\\active-profile`) };
    if (kind === 'local-skill') f.directory(`${HOME}\\profiles\\alpha\\skills\\demo-skill`);
    if (kind === 'collections') { f.directory(`${HOME}\\libraries`); f.file(`${HOME}\\libraries\\demo.json`, '{}'); }
    if (kind === 'imported') { ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profile-publishing\\trees`); f.file(`${HOME}\\profile-publishing\\trees\\occupied`, 'keep'); }
    const before = f.snapshot();
    const refused = expect(useManagedProfile(HOME, 'alpha', f.services())).rejects;
    if (sidecar === undefined) await refused.toThrow();
    else {
      await refused.toMatchObject({ code: 'PROFILE_PUBLICATION_STATE_INVALID' });
      expect(await currentProfile(HOME, f.selection)).toBe('alpha');
      expect(f.nodes.get(`${HOME}\\active-profile`)).toEqual(selectionBefore);
      expect(f.nodes.get(sidecar)?.bytes).toEqual(Buffer.from('{}'));
    }
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
    await services.withOperationLocks(HOME, ['bravo', '@store'], transaction, async (authority) => { escaped = authority; authority.assertHeld(HOME, 'bravo'); expect(() => authority.assertHeld(`${HOME}-other`, 'bravo')).toThrow(expect.objectContaining({ code: 'WINDOWS_PROFILE_ACTIVATION_CHANGED' })); expect(() => authority.assertHeld(HOME, 'alpha')).toThrow(expect.objectContaining({ code: 'WINDOWS_PROFILE_ACTIVATION_CHANGED' })); });
    expect(() => escaped!.assertHeld()).toThrow(expect.objectContaining({ code: 'WINDOWS_PROFILE_ACTIVATION_CHANGED' }));
    await expect(f.services({ hooks: { afterOperationLock(key) { if (key === 'alpha') throw new Error('partial'); } } }).withOperationLocks(HOME, ['alpha', '@store'], transaction, async () => undefined)).rejects.toThrow('partial');
    await expect(services.withOperationLocks(HOME, ['alpha', '@store'], transaction, async () => 'retry')).resolves.toBe('retry');
  });
  it.each(['home', 'admission', 'capability'] as const)('preserves activation %s refusal instead of masking the first native failure', async (kind) => {
    const f = await fixture();
    const nativeFailure = new BazframeError('WINDOWS_NATIVE_TEST_REFUSAL', 'first native refusal');
    let refusing = false;
    const inspect = f.backend.inspectPath;
    f.backend.inspectPath = (path) => {
      if (refusing && kind === 'admission' && path === HOME) throw nativeFailure;
      return inspect(path);
    };
    const acquire = f.backend.acquireFileLock;
    f.backend.acquireFileLock = (path) => {
      const result = acquire(path);
      if (result.state !== 'acquired') return result;
      return { ...result, capability: { release: () => result.capability.release(), assertHeld() {
        if (refusing && kind === 'capability') throw nativeFailure;
        result.capability.assertHeld();
      } } };
    };
    await f.services().withOperationLocks(HOME, ['alpha', '@store'], 'a'.repeat(32), async (authority) => {
      const before = f.nodes.get(HOME)!;
      if (kind === 'home') f.directory(HOME);
      refusing = true;
      try {
        if (kind === 'home') expect(() => authority.assertHeld(HOME, 'alpha')).toThrow(expect.objectContaining({ code: 'WINDOWS_PROFILE_ACTIVATION_CHANGED' }));
        else {
          try { authority.assertHeld(HOME, 'alpha'); expect.fail('authority accepted invalid native proof'); }
          catch (error) { expect(error).toBe(nativeFailure); }
        }
      } finally { refusing = false; f.nodes.set(HOME, before); }
    });
  });

});
