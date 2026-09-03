import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, symlink } from 'node:fs/promises';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import { managedProfileStatePath, readOptionalManagedProfileState, writeCandidateManagedProfileState } from '../../../src/profile-publishing/managed-profile-state.js';
import type { ManagedProfileStateV1 } from '../../../src/profile-publishing/publication-state.js';

const policy = capturedProfileLimitPolicy({ maxManifestBytes: 8192, maxResources: 8, maxProfileEntries: 16 });
const state: ManagedProfileStateV1 = { schemaVersion: 1, profileInstanceId: '123e4567-e89b-42d3-a456-426614174000', publication: null, capturedResourceIds: [], importedResources: [] };
let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

describe('managed profile state I/O', () => {
  it('keeps a sidecar-free physical profile valid and writes only to an unpublished candidate', async () => {
    temporary = await createTempDirectory(); await temporary.mkdir('profiles/work'); await temporary.write('profiles/work/AGENTS.md', 'hello\n');
    expect(await readOptionalManagedProfileState(temporary.root, 'work', policy)).toBeUndefined();
    const candidate = temporary.path('profiles/.bazframe-candidate-0123456789abcdef0123456789abcdef'); await mkdir(candidate);
    const written = await writeCandidateManagedProfileState(temporary.root, candidate, state, policy); expect(written.state).toEqual(state);
    await expect(temporary.readText('profiles/work/.bazframe-profile-state.json')).rejects.toBeDefined();
    expect((await temporary.readText('profiles/.bazframe-candidate-0123456789abcdef0123456789abcdef/.bazframe-profile-state.json')).endsWith('\n')).toBe(true);
  });

  it('refuses state writes outside a reserved unpublished candidate', async () => {
    temporary = await createTempDirectory();
    await temporary.mkdir('profiles/work');
    await temporary.mkdir('profiles/not-a-candidate');
    await temporary.mkdir('outside/.bazframe-candidate-0123456789abcdef0123456789abcdef');
    for (const path of [
      temporary.path('profiles/work'),
      temporary.path('profiles/not-a-candidate'),
      temporary.path('outside/.bazframe-candidate-0123456789abcdef0123456789abcdef')
    ]) {
      await expect(writeCandidateManagedProfileState(temporary.root, path, state, policy)).rejects.toMatchObject({ code: 'PROFILE_PUBLICATION_CANDIDATE_INVALID' });
    }
  });

  it('refuses a sidecar symlink', async () => {
    temporary = await createTempDirectory(); await temporary.mkdir('profiles/work'); const outside = await temporary.write('outside.json', '{}\n'); await symlink(outside, managedProfileStatePath(temporary.root, 'work'));
    await expect(readOptionalManagedProfileState(temporary.root, 'work', policy)).rejects.toMatchObject({ code: 'PROFILE_PUBLISHING_FILE_INVALID' });
  });

  it('rejects a symlink in complete physical ancestry', async () => {
    temporary = await createTempDirectory(); await mkdir(temporary.path('outside')); await symlink(temporary.path('outside'), temporary.path('profiles')); await mkdir(temporary.path('outside/work'));
    await expect(readOptionalManagedProfileState(temporary.root, 'work', policy)).rejects.toMatchObject({ code: 'PROFILE_PUBLISHING_DIRECTORY_INVALID' });
  });
});
