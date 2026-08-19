import { lstat, readFile, rename, symlink, unlink } from 'node:fs/promises';
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
  it('derives the exact canonical basename and refuses declared builds for restricted callers', async () => {
    const directory = await createTempDirectory('bazframe-global-source-no-build-'); directories.push(directory);
    const home = directory.path('home');
    const sourceRoot = await directory.mkdir('restricted');
    await directory.write('restricted/demo/SKILL.md', skill('demo'));
    await directory.write('restricted/bazframe-source.json', `${JSON.stringify({
      schemaVersion: 1,
      build: [process.execPath, '-e', "require('node:fs').writeFileSync('ran', 'yes')"],
      artifactRoot: '.',
      sourceUnitRoot: '.'
    })}\n`);

    await expect(addSource({ bazframeHome: home }, sourceRoot, { declaredBuild: 'reject' }))
      .rejects.toMatchObject({ code: 'SOURCE_BUILD_REQUIRES_CLI' });
    await expect(lstat(directory.path('restricted/ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(globalSourcePath(home, 'restricted'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['Upper', 'has_underscore', 'bad--name'])('rejects invalid directory name %s without normalization', async (name) => {
    const directory = await createTempDirectory('bazframe-global-source-invalid-name-'); directories.push(directory);
    const root = await directory.mkdir(name);
    await directory.write(`${name}/demo/SKILL.md`, skill('demo'));
    await expect(addSource({ bazframeHome: directory.path('home') }, root))
      .rejects.toMatchObject({ code: 'SOURCE_NAME_INVALID' });
  });

  it('derives the name from the canonical target rather than a symlink spelling', async () => {
    const directory = await createTempDirectory('bazframe-global-source-canonical-name-'); directories.push(directory);
    const target = await directory.mkdir('canonical-name');
    await directory.write('canonical-name/demo/SKILL.md', skill('demo'));
    await symlink(target, directory.path('alias-name'));
    const added = await addSource({ bazframeHome: directory.path('home') }, directory.path('alias-name'));
    expect(added.source).toBe('canonical-name');
    await expect(readFile(globalSourcePath(directory.path('home'), 'canonical-name'), 'utf8'))
      .resolves.toContain('"source": "canonical-name"');
  });

  it('rejects every occupied basename, including same-root re-add', async () => {
    const directory = await createTempDirectory('bazframe-global-source-occupied-'); directories.push(directory);
    const home = directory.path('home');
    const root = await directory.mkdir('shared');
    await directory.write('shared/alpha/SKILL.md', skill('alpha'));
    await addSource({ bazframeHome: home }, root);
    await expect(addSource({ bazframeHome: home }, root))
      .rejects.toMatchObject({ code: 'SOURCE_DESTINATION_OCCUPIED' });
  });

  it('rejects a different root with the same canonical basename', async () => {
    const directory = await createTempDirectory('bazframe-global-source-basename-collision-'); directories.push(directory);
    const home = directory.path('home');
    const first = await directory.mkdir('first/shared');
    const second = await directory.mkdir('second/shared');
    await directory.write('first/shared/alpha/SKILL.md', skill('alpha'));
    await directory.write('second/shared/beta/SKILL.md', skill('beta'));
    await addSource({ bazframeHome: home }, first);
    await expect(addSource({ bazframeHome: home }, second))
      .rejects.toMatchObject({ code: 'SOURCE_DESTINATION_OCCUPIED' });
    await expect(readFile(globalSourcePath(home, 'shared'), 'utf8')).resolves.toContain(first);
  });

  it('shares one activation, validates every dependent, and refuses referenced deletion', async () => {
    const directory = await createTempDirectory('bazframe-global-source-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused'); await addProfile(home, 'reviewer'); await writeActiveProfile(home, 'focused');
    const root = await directory.mkdir('shared');
    await directory.write('shared/alpha/SKILL.md', skill('alpha', 'first'));
    const added = await addSource({ bazframeHome: home }, root);
    await addProfileSourceReference({ bazframeHome: home }, 'focused', 'shared');
    await addProfileSourceReference({ bazframeHome: home }, 'reviewer', 'shared');

    await directory.write('shared/alpha/SKILL.md', skill('alpha', 'second'));
    const built = await buildSource({ bazframeHome: home }, 'shared');
    expect(built.digest).not.toBe(added.digest);

    await directory.write('home/profiles/reviewer/skills/beta/SKILL.md', skill('beta'));
    await directory.write('shared/beta/SKILL.md', skill('beta'));
    const recordPath = globalSourcePath(home, 'shared');
    const beforeRejected = await readFile(recordPath, 'utf8');
    await expect(buildSource({ bazframeHome: home }, 'shared')).rejects.toMatchObject({ code: 'SOURCE_DEPENDENT_INVALID' });
    expect(await readFile(recordPath, 'utf8')).toBe(beforeRejected);
    await expect(removeSource({ bazframeHome: home }, 'shared')).rejects.toMatchObject({ code: 'SOURCE_REFERENCED' });

    await removeProfileSourceReference({ bazframeHome: home }, 'focused', 'shared');
    await removeProfileSourceReference({ bazframeHome: home }, 'reviewer', 'shared');
    expect((await removeSource({ bazframeHome: home }, 'shared')).action).toBe('removed');
    expect(await readFile(directory.path('shared/alpha/SKILL.md'), 'utf8')).toContain('second');
    expect((await lstat(directory.path('home/source-snapshots/sha256', built.digest))).isDirectory()).toBe(true);
  });

  it('keeps profile reference add idempotent while revalidating composition', async () => {
    const directory = await createTempDirectory('bazframe-profile-source-current-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    const root = await directory.mkdir('shared');
    await directory.write('shared/alpha/SKILL.md', skill('alpha'));
    await addSource({ bazframeHome: home }, root);
    await expect(addProfileSourceReference({ bazframeHome: home }, 'focused', 'shared'))
      .resolves.toMatchObject({ action: 'added' });
    await expect(addProfileSourceReference({ bazframeHome: home }, 'focused', 'shared'))
      .resolves.toMatchObject({ action: 'current' });
    await directory.write('home/profiles/focused/skills/alpha/SKILL.md', skill('alpha'));
    await expect(addProfileSourceReference({ bazframeHome: home }, 'focused', 'shared'))
      .rejects.toMatchObject({ code: 'SOURCE_CANDIDATE_DUPLICATE' });
  });

  it('rejects a rebuild that collides with another referenced source and preserves the prior digest', async () => {
    const directory = await createTempDirectory('bazframe-source-collision-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    const firstRoot = await directory.mkdir('first');
    const secondRoot = await directory.mkdir('second');
    await directory.write('first/alpha/SKILL.md', skill('alpha'));
    await directory.write('second/beta/SKILL.md', skill('beta'));
    const first = await addSource({ bazframeHome: home }, firstRoot);
    await addSource({ bazframeHome: home }, secondRoot);
    await addProfileSourceReference({ bazframeHome: home }, 'focused', 'first');
    await addProfileSourceReference({ bazframeHome: home }, 'focused', 'second');

    await directory.write('first/alpha/SKILL.md', skill('beta'));
    await expect(buildSource({ bazframeHome: home }, 'first'))
      .rejects.toMatchObject({ code: 'SOURCE_DEPENDENT_INVALID' });
    const active = JSON.parse(await readFile(globalSourcePath(home, 'first'), 'utf8')) as { digest: string };
    expect(active.digest).toBe(first.digest);
  });

  it('revalidates the complete reference index before add, build, and remove commit points', async () => {
    const directory = await createTempDirectory('bazframe-global-source-reference-race-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    const root = await directory.mkdir('shared');
    await directory.write('shared/alpha/SKILL.md', skill('alpha', 'first'));
    const referencePath = directory.path('home/profiles/focused/sources/shared.json');
    const referenceBytes = encodeProfileSourceReference({ schemaVersion: 1, source: 'shared' });

    await expect(addSource({ bazframeHome: home }, root, {
      beforeReferenceIndexRevalidation: async () => {
        await directory.write('home/profiles/focused/sources/shared.json', referenceBytes);
      }
    })).rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INDEX_CHANGED' });
    await expect(readFile(globalSourcePath(home, 'shared'))).rejects.toMatchObject({ code: 'ENOENT' });

    await unlink(referencePath);
    const added = await addSource({ bazframeHome: home }, root);
    await directory.write('home/profiles/focused/sources/shared.json', referenceBytes);
    await directory.write('shared/alpha/SKILL.md', skill('alpha', 'second'));
    await expect(buildSource({ bazframeHome: home }, 'shared', {
      beforeReferenceIndexRevalidation: async () => {
        await directory.write('home/profiles/focused/sources/shared.json', '{}\n');
      }
    })).rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INDEX_CHANGED' });
    expect(JSON.parse(await readFile(globalSourcePath(home, 'shared'), 'utf8')).digest).toBe(added.digest);

    await unlink(referencePath);
    await expect(removeSource({ bazframeHome: home }, 'shared', {
      beforeReferenceIndexRevalidation: async () => {
        await directory.write('home/profiles/focused/sources/shared.json', referenceBytes);
      }
    })).rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INDEX_CHANGED' });
    await expect(readFile(globalSourcePath(home, 'shared'), 'utf8')).resolves.toContain(added.digest);
  });

  it('rejects symlinked global and reference namespace ancestors without deleting outside state', async () => {
    const directory = await createTempDirectory('bazframe-global-source-symlink-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    const root = await directory.mkdir('shared');
    await directory.write('shared/alpha/SKILL.md', skill('alpha'));
    await addSource({ bazframeHome: home }, root);
    await addProfileSourceReference({ bazframeHome: home }, 'focused', 'shared');

    const sourcesPath = directory.path('home/sources');
    const outsideSources = directory.path('outside-sources');
    await rename(sourcesPath, outsideSources);
    await symlink(outsideSources, sourcesPath);
    await expect(removeSource({ bazframeHome: home }, 'shared'))
      .rejects.toMatchObject({ code: 'SOURCE_DESTINATION_OCCUPIED' });
    await expect(readFile(directory.path('outside-sources/shared.json'), 'utf8')).resolves.toContain('"source": "shared"');

    await unlink(sourcesPath);
    await rename(outsideSources, sourcesPath);
    const referencesPath = directory.path('home/profiles/focused/sources');
    const outsideReferences = directory.path('outside-references');
    await rename(referencesPath, outsideReferences);
    await symlink(outsideReferences, referencesPath);
    await expect(removeProfileSourceReference({ bazframeHome: home }, 'focused', 'shared'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });
    await expect(readFile(directory.path('outside-references/shared.json'), 'utf8')).resolves.toContain('"source": "shared"');
  });

  it('fails closed on old nested provider reference state', async () => {
    const directory = await createTempDirectory('bazframe-global-source-old-state-'); directories.push(directory);
    const home = directory.path('home');
    await addProfile(home, 'focused');
    await directory.write('home/profiles/focused/sources/provider/shared.json', JSON.stringify({ schemaVersion: 1, provider: 'provider', source: 'shared' }));
    const root = await directory.mkdir('shared');
    await directory.write('shared/alpha/SKILL.md', skill('alpha'));

    await expect(addSource({ bazframeHome: home }, root))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INDEX_INVALID' });
    await expect(readFile(globalSourcePath(home, 'shared'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
