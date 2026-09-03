import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, symlink } from 'node:fs/promises';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { assertPhysicalAncestry, openStablePhysicalDirectory, stableChildPath, stableReadChildPath } from '../../../src/profile-publishing/profile-filesystem.js';

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
