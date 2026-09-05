import { describe, expect, it } from 'vitest';
import { currentProfile, addProfile } from '../../../src/profiles/profile-management.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { createWindowsProfileSelectionReadServicesForInternalTesting, readWindowsSelectionSnapshot } from '../../../src/profiles/win32-profile-selection.js';
import { ensureWindowsPrivateDirectoryPath } from '../../../src/state/win32-private-directory.js';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
const HOME = 'C:\\boundary\\home';

describe('native selected-ID read-only composition', () => {
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
  it.each(['utf8', 'alias', 'hardlink', 'reparse', 'privacy', 'drift'] as const)('refuses %s without changing selection', async (kind) => {
    const f = windowsProvisioningFixture();
    ensureWindowsPrivateDirectoryPath(f.backend, HOME);
    const path = `${HOME}\\${kind === 'alias' ? 'Active-Profile' : 'active-profile'}`;
    f.file(path, 'alpha\r\n');
    if (kind === 'utf8') f.nodes.get(path)!.bytes = Buffer.from([0xff]);
    if (kind === 'hardlink') f.nodes.get(path)!.numberOfLinks = 2;
    if (kind === 'privacy') f.nodes.get(path)!.security = { ...f.backend.inspectPath(path).security, ownerSid: 'S-1-5-21-2' };
    if (kind === 'reparse') f.nodes.get(path)!.reparseTag = 0xa0000003;
    const read = f.backend.readStableFile;
    if (kind === 'drift') f.backend.readStableFile = async (...args) => { const value = await read(...args); return { ...value, after: { ...value.after, fileId: 'f'.repeat(32) } }; };
    const before = f.snapshot();
    await expect(readWindowsSelectionSnapshot(f.backend, HOME)).rejects.toThrow();
    expect(f.snapshot()).toBe(before);
  });
});
