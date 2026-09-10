import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, symlink } from 'node:fs/promises';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { windowsPhysicalIdentityText, isWindowsPhysicalIdentityText, isPosixPhysicalIdentityText, identityText, assertPhysicalAncestry, openStablePhysicalDirectory, stableChildPath, stableReadChildPath } from '../../../src/profile-publishing/profile-filesystem.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

describe('profile publishing filesystem proofs', () => {
  it('rejects a symlink in complete ancestry', async () => {
    temporary = await createTempDirectory(); await mkdir(temporary.path('outside/child'), { recursive: true }); await symlink(temporary.path('outside'), temporary.path('linked'));
    await expect(assertPhysicalAncestry(temporary.root, temporary.path('linked/child'))).rejects.toMatchObject({ code: 'PROFILE_PUBLISHING_DIRECTORY_INVALID' });
  });

  it('names pathname fallback as read-only and fails closed for handle-relative mutation', async () => {
    temporary = await createTempDirectory(); await mkdir(temporary.path('owned')); const directory = await openStablePhysicalDirectory(temporary.path('owned'), temporary.root);
    try {
      expect(stableReadChildPath(directory, 'file')).toBe(temporary.path('owned/file'));
      if (process.platform === 'darwin') expect(() => stableChildPath(directory, 'file')).toThrow(/handle-relative/u);
      else expect(stableChildPath(directory, 'file')).toMatch(/file$/u);
    } finally { await directory.handle.close(); }
  });
});

describe('disjoint physical identity text', () => {
  it.each([
    ['ffffffffffffffff', '80000000000000000000000000000001'],
    ['0000000000000001', '00000000000000000000000000000002'],
    ['1234567890123456', '12345678901234567890123456789012']
  ])('preserves native strings %s/%s without numeric conversion', (volume, file) => {
    const identity = windowsPhysicalIdentityText(volume, file);
    expect(identity).toBe(`win32-ntfs:${volume}:${file}`);
    expect(isWindowsPhysicalIdentityText(identity)).toBe(true);
    expect(isPosixPhysicalIdentityText(identity)).toBe(false);
  });
  it.each(['WIN32-NTFS:', 'win32:', '', ' win32-ntfs:', 'win32-ntfs: '])('rejects incorrect prefix %s', (prefix) => {
    expect(isWindowsPhysicalIdentityText(`${prefix}${'a'.repeat(16)}:${'b'.repeat(32)}`)).toBe(false);
  });
  it('rejects uppercase, widths, whitespace and numeric coercion', () => {
    for (const volume of ['A'.repeat(16), 'a'.repeat(15), 'a'.repeat(17), ' '.repeat(16), 1234567890123456]) {
      expect(() => windowsPhysicalIdentityText(volume as string, 'b'.repeat(32))).toThrow();
    }
    for (const file of ['B'.repeat(32), 'b'.repeat(31), 'b'.repeat(33), `${'b'.repeat(31)}\n`, 123]) {
      expect(() => windowsPhysicalIdentityText('a'.repeat(16), file as string)).toThrow();
    }
  });
  it('leaves all-digit and large decimal POSIX identities in V1, with original spelling', () => {
    const decimal = '1234567890123456:12345678901234567890123456789012';
    expect(isPosixPhysicalIdentityText(decimal)).toBe(true);
    expect(isWindowsPhysicalIdentityText(decimal)).toBe(false);
    expect(isPosixPhysicalIdentityText('0001:0002')).toBe(true);
    expect(identityText({ device: 1234567890123456n, inode: 12345678901234567890123456789012n })).toBe(decimal);
  });
});
