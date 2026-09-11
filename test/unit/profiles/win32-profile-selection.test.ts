import { createHash } from 'node:crypto';
import { stableWindowsPathInspection } from '../../../src/core/win32-stable-observation.js';
import { describe, expect, it } from 'vitest';
import { currentProfile, addProfile } from '../../../src/profiles/profile-management.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { createWindowsProfileSelectionReadServicesForInternalTesting, readWindowsSelectionSnapshot, readWindowsPhysicalFileSnapshot } from '../../../src/profiles/win32-profile-selection.js';
import { ensureWindowsPrivateDirectoryPath } from '../../../src/state/win32-private-directory.js';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
const HOME = 'C:\\boundary\\home';

describe('native selected-ID read-only composition', () => {
  it('stabilizes access-only admission/read/reinspection and successive selection proofs without replacing raw evidence', async () => {
    const f = windowsProvisioningFixture(); ensureWindowsPrivateDirectoryPath(f.backend, HOME);
    const path = `${HOME}\\active-profile`; f.file(path, 'alpha\r\n');
    const baseline = await readWindowsSelectionSnapshot(f.backend, HOME), state = f.snapshot();
    const inspect = f.backend.inspectPath, read = f.backend.readStableFile;
    let clock = 10;
    const time = () => (++clock).toString(16).padStart(16, '0');
    f.backend.inspectPath = (name) => { const value = inspect(name); return { ...value, object: { ...value.object, lastAccessTime: time() } }; };
    let raw = '', receipt: Awaited<ReturnType<typeof read>> | undefined;
    f.backend.readStableFile = async (...args) => { const value = await read(...args); receipt = { ...value, before: { ...value.before, lastAccessTime: time() }, after: { ...value.after, lastAccessTime: time() } }; raw = JSON.stringify(receipt); return receipt; };
    const first = await readWindowsSelectionSnapshot(f.backend, HOME), second = await readWindowsSelectionSnapshot(f.backend, HOME);
    expect(first.digest).toBe(baseline.digest); expect(second.digest).toBe(first.digest);
    expect(first.inspection?.object.lastAccessTime).not.toBe(second.inspection?.object.lastAccessTime);
    expect(first.bytes).toEqual(Buffer.from('alpha\r\n')); expect(first.inspection).not.toHaveProperty('security');
    expect(JSON.stringify(receipt)).toBe(raw); expect(second.bytes).not.toBe(receipt!.bytes);
    expect(f.snapshot()).toBe(state);
    const payload = JSON.stringify(stableWindowsPathInspection(first.inspection!));
    expect(first.digest).toBe(createHash('sha256').update('bazframe-win32-profile-add-selection-v2\0').update(payload).update(first.bytes!).digest('hex'));
    expect(first.digest).not.toBe(createHash('sha256').update('bazframe-win32-profile-add-selection-v1\0').update(JSON.stringify(baseline.inspection)).update(first.bytes!).digest('hex'));
  });
  it.each(['ceiling', 'byte-count', 'size', 'write', 'change', 'creation', 'allocation', 'attributes', 'delete'] as const)('retains bounded file %s refusal', async (kind) => {
    const f = windowsProvisioningFixture(); ensureWindowsPrivateDirectoryPath(f.backend, HOME);
    const path = `${HOME}\\active-profile`; f.file(path, 'alpha\n');
    const read = f.backend.readStableFile;
    f.backend.readStableFile = async (...args) => {
      const value = await read(...args);
      if (kind === 'ceiling') return { ...value, bytes: Buffer.alloc(100) };
      if (kind === 'byte-count') return { ...value, byteCount: '0000000000000001' };
      const overrides = { size: { size: '0000000000000001' }, write: { lastWriteTime: '0000000000000099' }, change: { changeTime: '0000000000000099' }, creation: { creationTime: '0000000000000099' }, allocation: { allocationSize: '0000000000000099' }, attributes: { attributes: 0 }, delete: { deletePending: true } };
      return { ...value, after: { ...value.after, ...overrides[kind] } };
    };
    const before = f.snapshot();
    await expect(readWindowsPhysicalFileSnapshot(f.backend, path, 10)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_PROVISIONING_REFUSED' });
    expect(f.snapshot()).toBe(before);
  });

  it('does not create missing home or selection, even with pending onboarding transactions', async () => {
    const f = windowsProvisioningFixture();
    const services = createWindowsProfileSelectionReadServicesForInternalTesting(f.backend);
    const before = f.snapshot();
    await expect(currentProfile(HOME, services)).rejects.toMatchObject({ code: 'NO_ACTIVE_PROFILE' });
    expect(f.snapshot()).toBe(before);
    const provisioningServices = createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { lockIo: f.io, publicationIo: f.io, hooks: { afterPhase() { throw new Error('stop'); } } });
    await expect(addProfile(HOME, 'alpha', { provisioningServices })).rejects.toThrow('stop');
    const pending = f.snapshot();
    await expect(currentProfile(HOME, services)).rejects.toMatchObject({ code: 'NO_ACTIVE_PROFILE' });
    expect(f.snapshot()).toBe(pending);
  });
  it.each(['missing', 'missing\n', 'missing\r\n'])('returns only ID while preserving exact %j bytes and identity', async (contents) => {
    const f = windowsProvisioningFixture();
    ensureWindowsPrivateDirectoryPath(f.backend, HOME);
    f.file(`${HOME}\\active-profile`, contents);
    const before = f.snapshot();
    const snapshot = await readWindowsSelectionSnapshot(f.backend, HOME);
    expect(snapshot.bytes).toEqual(Buffer.from(contents));
    expect(snapshot.inspection?.object.fileId).toBe(f.backend.inspectPath(`${HOME}\\active-profile`).object.fileId);
    expect(await currentProfile(HOME, createWindowsProfileSelectionReadServicesForInternalTesting(f.backend))).toBe('missing');
    expect(f.snapshot()).toBe(before);
  });
  it.each(['alpha\n\n', 'alpha\0', '../alpha', 'x'.repeat(1025), ''])('refuses malformed state %j without effects', async (contents) => {
    const f = windowsProvisioningFixture();
    ensureWindowsPrivateDirectoryPath(f.backend, HOME);
    f.file(`${HOME}\\active-profile`, contents);
    const before = f.snapshot();
    await expect(readWindowsSelectionSnapshot(f.backend, HOME)).rejects.toThrow();
    expect(f.snapshot()).toBe(before);
  });
  it.each(['utf8', 'alias', 'hardlink', 'reparse', 'privacy', 'drift'] as const)('applies physical and stable selection admission to %s without changes', async (kind) => {
    const f = windowsProvisioningFixture();
    ensureWindowsPrivateDirectoryPath(f.backend, HOME);
    const path = `${HOME}\\${kind === 'alias' ? 'Active-Profile' : 'active-profile'}`;
    f.file(path, 'alpha\r\n');
    if (kind === 'utf8') f.nodes.get(path)!.bytes = Buffer.from([0xff]);
    if (kind === 'hardlink') f.nodes.get(path)!.numberOfLinks = 2;
    if (kind === 'privacy') f.nodes.get(path)!.security = { ...f.security(path), ownerSid: 'S-1-5-21-2' };
    if (kind === 'reparse') f.nodes.get(path)!.reparseTag = 0xa0000003;
    const read = f.backend.readStableFile;
    if (kind === 'drift') f.backend.readStableFile = async (...args) => { const value = await read(...args); return { ...value, after: { ...value.after, fileId: 'f'.repeat(32) } }; };
    const before = f.snapshot();
    if (kind === 'hardlink' || kind === 'privacy') await expect(readWindowsSelectionSnapshot(f.backend, HOME)).resolves.toMatchObject({ profileId: 'alpha' });
    else await expect(readWindowsSelectionSnapshot(f.backend, HOME)).rejects.toThrow();
    expect(f.snapshot()).toBe(before);
  });
});
