import { chmod, lstat, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { addProfile } from '../../../src/profiles/profile-management.js';
import { addProfileSourceReference, removeProfileSourceReference } from '../../../src/profiles/profile-source-reference-lifecycle.js';
import { encodeProfileSourceReference } from '../../../src/profiles/profile-source-reference.js';
import { writeActiveProfile } from '../../../src/profiles/profile-store.js';
import { addSource, buildSource, removeSource } from '../../../src/sources/source-lifecycle.js';
import { globalSourcePath } from '../../../src/sources/source-store.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));
const skill = (name: string, detail = name) => `---\nname: ${name}\ndescription: ${detail}\n---\n\n${detail}\n`;

describe('global source lifecycle', () => {
  it('shares one activation, validates every dependent, and refuses referenced deletion', async () => {
    const directory = await createTempDirectory('bazframe-global-source-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused'); await addProfile(home, 'reviewer'); await writeActiveProfile(home, 'focused');
    const provider = await directory.mkdir('provider');
    await directory.write('provider/alpha/SKILL.md', skill('alpha', 'first'));
    const added = await addSource({ bazframeHome: home }, 'provider', 'shared', provider);
    expect(added.action).toBe('added');
    await addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared');
    await addProfileSourceReference({ bazframeHome: home }, 'reviewer', 'provider', 'shared');

    await directory.write('provider/alpha/SKILL.md', skill('alpha', 'second'));
    const unrelatedRoot = await directory.mkdir('unrelated-provider');
    await directory.write('unrelated-provider/unrelated/SKILL.md', skill('unrelated'));
    await addSource({ bazframeHome: home }, 'provider', 'unrelated', unrelatedRoot);
    await addProfileSourceReference({ bazframeHome: home }, 'reviewer', 'provider', 'unrelated');
    await unlink(globalSourcePath(home, 'provider', 'unrelated'));
    await directory.write('home/profiles/reviewer/AGENTS.md', new Uint8Array([0xff]));

    const built = await buildSource({ bazframeHome: home }, 'provider', 'shared');
    expect(built.digest).not.toBe(added.digest);

    await directory.write('home/profiles/reviewer/skills/beta/SKILL.md', skill('beta'));
    await directory.write('provider/beta/SKILL.md', skill('beta'));
    const recordPath = globalSourcePath(home, 'provider', 'shared');
    const beforeRejected = await readFile(recordPath, 'utf8');
    await expect(buildSource({ bazframeHome: home }, 'provider', 'shared')).rejects.toMatchObject({ code: 'SOURCE_DEPENDENT_INVALID' });
    expect(await readFile(recordPath, 'utf8')).toBe(beforeRejected);
    await expect(removeSource({ bazframeHome: home }, 'provider', 'shared')).rejects.toMatchObject({ code: 'SOURCE_REFERENCED' });

    await directory.write('home/profiles/reviewer/AGENTS.md', 'reviewer\n');
    await removeProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared');
    await removeProfileSourceReference({ bazframeHome: home }, 'reviewer', 'provider', 'shared');
    expect((await removeSource({ bazframeHome: home }, 'provider', 'shared')).action).toBe('removed');
    expect(await readFile(directory.path('provider/alpha/SKILL.md'), 'utf8')).toContain('second');
    await expect(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(directory.path('home/source-snapshots/sha256', built.digest))).isDirectory()).toBe(true);
  });

  it('revalidates an existing exact reference before returning current', async () => {
    const directory = await createTempDirectory('bazframe-profile-source-current-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    const provider = await directory.mkdir('provider');
    await directory.write('provider/alpha/SKILL.md', skill('alpha'));
    const source = await addSource({ bazframeHome: home }, 'provider', 'shared', provider);
    const initial = await addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared');
    expect(initial.action).toBe('added');
    await expect(addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared'))
      .resolves.toMatchObject({ action: 'current' });

    const recordPath = globalSourcePath(home, 'provider', 'shared');
    await unlink(recordPath);
    await expect(addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared'))
      .rejects.toMatchObject({ code: 'SOURCE_RECORD_READ_FAILED' });
    await directory.write('home/sources/provider/shared.json', '{}\n');
    await expect(addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared'))
      .rejects.toMatchObject({ code: 'SOURCE_RECORD_INVALID' });

    await unlink(recordPath);
    await directory.write('home/sources/provider/shared.json', JSON.stringify({
      schemaVersion: 1,
      provider: 'provider',
      source: 'shared',
      root: provider,
      digest: source.digest,
      sourceUnitRoot: '.'
    }, null, 2) + '\n');
    const manifestPath = directory.path('home/source-snapshots/sha256', source.digest, 'manifest.json');
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, '{}\n');
    await expect(addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared'))
      .rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_CORRUPT' });
  });

  it('revalidates prospective composition for an existing exact reference', async () => {
    const directory = await createTempDirectory('bazframe-profile-source-current-composition-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    const provider = await directory.mkdir('provider');
    await directory.write('provider/alpha/SKILL.md', skill('alpha'));
    await addSource({ bazframeHome: home }, 'provider', 'shared', provider);
    await addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared');

    await directory.write('home/profiles/focused/skills/alpha/SKILL.md', skill('alpha'));
    await expect(addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared'))
      .rejects.toMatchObject({ code: 'SOURCE_CANDIDATE_DUPLICATE' });
  });

  it('rejects a rebuild that collides with another referenced source and preserves the prior digest', async () => {
    const directory = await createTempDirectory('bazframe-source-collision-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    const firstRoot = await directory.mkdir('provider-first');
    const secondRoot = await directory.mkdir('provider-second');
    await directory.write('provider-first/alpha/SKILL.md', skill('alpha'));
    await directory.write('provider-second/beta/SKILL.md', skill('beta'));
    const first = await addSource({ bazframeHome: home }, 'provider', 'first', firstRoot);
    await addSource({ bazframeHome: home }, 'provider', 'second', secondRoot);
    await addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'first');
    await addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'second');

    await directory.write('provider-first/alpha/SKILL.md', skill('beta'));
    await expect(buildSource({ bazframeHome: home }, 'provider', 'first'))
      .rejects.toMatchObject({ code: 'SOURCE_DEPENDENT_INVALID' });
    const active = JSON.parse(await readFile(globalSourcePath(home, 'provider', 'first'), 'utf8')) as { digest: string };
    expect(active.digest).toBe(first.digest);
  });

  it('revalidates the complete reference index before add, build, and remove commit points', async () => {
    const directory = await createTempDirectory('bazframe-global-source-reference-race-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    const provider = await directory.mkdir('provider');
    await directory.write('provider/alpha/SKILL.md', skill('alpha', 'first'));
    const referencePath = directory.path('home/profiles/focused/sources/provider/shared.json');
    const referenceBytes = encodeProfileSourceReference({ schemaVersion: 1, provider: 'provider', source: 'shared' });

    await expect(addSource({ bazframeHome: home }, 'provider', 'shared', provider, {
      beforeReferenceIndexRevalidation: async () => {
        await directory.write('home/profiles/focused/sources/provider/shared.json', referenceBytes);
      }
    })).rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INDEX_CHANGED' });
    await expect(readFile(globalSourcePath(home, 'provider', 'shared'))).rejects.toMatchObject({ code: 'ENOENT' });

    await unlink(referencePath);
    const added = await addSource({ bazframeHome: home }, 'provider', 'shared', provider);
    await directory.write('home/profiles/focused/sources/provider/shared.json', referenceBytes);
    await directory.write('provider/alpha/SKILL.md', skill('alpha', 'second'));
    await expect(buildSource({ bazframeHome: home }, 'provider', 'shared', {
      beforeReferenceIndexRevalidation: async () => {
        await directory.write('home/profiles/focused/sources/provider/shared.json', '{}\n');
      }
    })).rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INDEX_CHANGED' });
    expect(JSON.parse(await readFile(globalSourcePath(home, 'provider', 'shared'), 'utf8')).digest).toBe(added.digest);

    await unlink(referencePath);
    await expect(removeSource({ bazframeHome: home }, 'provider', 'shared', {
      beforeReferenceIndexRevalidation: async () => {
        await directory.write('home/profiles/focused/sources/provider/shared.json', referenceBytes);
      }
    })).rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INDEX_CHANGED' });
    await expect(readFile(globalSourcePath(home, 'provider', 'shared'), 'utf8')).resolves.toContain(added.digest);
  });

  it('rejects symlinked global namespace ancestors without deleting outside records', async () => {
    const directory = await createTempDirectory('bazframe-global-source-symlink-'); directories.push(directory);
    for (const ancestor of ['sources', 'provider'] as const) {
      const home = directory.path(`home-${ancestor}`);
      const providerRoot = await directory.mkdir(`provider-${ancestor}`);
      await directory.write(`provider-${ancestor}/alpha/SKILL.md`, skill('alpha'));
      await addSource({ bazframeHome: home }, 'provider', 'shared', providerRoot);
      const sourcesPath = directory.path(`home-${ancestor}/sources`);
      const providerPath = directory.path(`home-${ancestor}/sources/provider`);
      await directory.mkdir(`outside-global-${ancestor}`);
      const outsidePath = directory.path(`outside-global-${ancestor}`, ancestor);
      const movedPath = ancestor === 'sources' ? sourcesPath : providerPath;
      await rename(movedPath, outsidePath);
      await symlink(outsidePath, movedPath);

      await expect(removeSource({ bazframeHome: home }, 'provider', 'shared'))
        .rejects.toMatchObject({ code: 'SOURCE_DESTINATION_OCCUPIED' });
      const outsideRecord = ancestor === 'sources'
        ? directory.path(`outside-global-${ancestor}/sources/provider/shared.json`)
        : directory.path(`outside-global-${ancestor}/provider/shared.json`);
      await expect(readFile(outsideRecord, 'utf8')).resolves.toContain('"source": "shared"');
    }
  });

  it('rejects symlinked profile-reference ancestors without deleting outside references', async () => {
    const directory = await createTempDirectory('bazframe-profile-reference-symlink-'); directories.push(directory);
    for (const ancestor of ['profiles', 'sources', 'provider'] as const) {
      const home = directory.path(`home-${ancestor}`);
      await addProfile(home, 'focused');
      const providerRoot = await directory.mkdir(`provider-reference-${ancestor}`);
      await directory.write(`provider-reference-${ancestor}/alpha/SKILL.md`, skill('alpha'));
      await addSource({ bazframeHome: home }, 'provider', 'shared', providerRoot);
      await addProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared');
      const profilesPath = directory.path(`home-${ancestor}/profiles`);
      const sourcesPath = directory.path(`home-${ancestor}/profiles/focused/sources`);
      const providerPath = directory.path(`home-${ancestor}/profiles/focused/sources/provider`);
      await directory.mkdir(`outside-reference-${ancestor}`);
      const outsidePath = directory.path(`outside-reference-${ancestor}`, ancestor);
      const movedPath = ancestor === 'profiles' ? profilesPath : ancestor === 'sources' ? sourcesPath : providerPath;
      await rename(movedPath, outsidePath);
      await symlink(outsidePath, movedPath);

      await expect(removeProfileSourceReference({ bazframeHome: home }, 'focused', 'provider', 'shared'))
        .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });
      const outsideReference = ancestor === 'profiles'
        ? directory.path(`outside-reference-${ancestor}/profiles/focused/sources/provider/shared.json`)
        : ancestor === 'sources'
          ? directory.path(`outside-reference-${ancestor}/sources/provider/shared.json`)
          : directory.path(`outside-reference-${ancestor}/provider/shared.json`);
      await expect(readFile(outsideReference, 'utf8')).resolves.toContain('"source": "shared"');
    }
  });

  it('validates pre-existing references before initial publication and fails closed on malformed reference state', async () => {
    const directory = await createTempDirectory('bazframe-global-source-add-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    await directory.write('home/profiles/focused/skills/alpha/SKILL.md', skill('alpha'));
    await directory.write(
      'home/profiles/focused/sources/provider/shared.json',
      encodeProfileSourceReference({ schemaVersion: 1, provider: 'provider', source: 'shared' })
    );
    const provider = await directory.mkdir('provider');
    await directory.write('provider/alpha/SKILL.md', skill('alpha'));

    await expect(addSource({ bazframeHome: home }, 'provider', 'shared', provider))
      .rejects.toMatchObject({ code: 'SOURCE_DEPENDENT_INVALID' });
    await expect(readFile(globalSourcePath(home, 'provider', 'shared')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await unlink(directory.path('home/profiles/focused/sources/provider/shared.json'));
    await directory.write('home/profiles/focused/sources/broken-entry', 'not a provider directory');
    await expect(addSource({ bazframeHome: home }, 'provider', 'shared', provider))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INDEX_INVALID' });
    await expect(readFile(globalSourcePath(home, 'provider', 'shared')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
