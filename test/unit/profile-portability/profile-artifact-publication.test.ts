import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_EFFECTIVE_INSTRUCTION_BYTES } from '../../../src/core/content.js';
import {
  readProfileArtifactDirectory
} from '../../../src/profile-portability/profile-artifact-io.js';
import {
  ProfileArtifactPublicationError,
  publishProfileArtifactDirectory,
  type ProfileArtifactPublicationOptions
} from '../../../src/profile-portability/profile-artifact-publication.js';
import type {
  ProfileArtifact
} from '../../../src/profile-portability/profile-artifact.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

async function temporaryDirectory(): Promise<TempDirectory> {
  const directory = await createTempDirectory('bazframe-profile-publication-');
  temporaryDirectories.push(directory);
  return directory;
}

function fixture(
  home: string,
  output: string,
  instructionBytes: Uint8Array = Buffer.from('first\r\nmultibyte: é and 世界\n', 'utf8')
): ProfileArtifactPublicationOptions {
  const artifact: ProfileArtifact = {
    schemaVersion: 1,
    kind: 'bazframe-profile-export',
    profile: {
      id: 'portable',
      instructions: {
        path: 'profile/AGENTS.md',
        sha256: createHash('sha256').update(instructionBytes).digest('hex')
      },
      skills: [],
      omittedLocalSkills: [],
      libraries: [],
      packages: []
    },
    resources: []
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return {
    bazframeHome: home,
    outputDirectory: output,
    artifact,
    instructionBytes,
    limitPolicy: {
      maxManifestBytes: manifestBytes.byteLength,
      maxProfileEntries: 0,
      maxResources: 0
    }
  };
}

async function sortedDirectoryEntries(path: string): Promise<string[]> {
  return (await readdir(path)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function stagingPath(parent: string): Promise<string> {
  const names = (await sortedDirectoryEntries(parent))
    .filter((name) => name.startsWith('.bazframe-profile-staging-'));
  expect(names).toHaveLength(1);
  return join(parent, names[0]!);
}

async function expectPublicationError(
  promise: Promise<unknown>,
  state: ProfileArtifactPublicationError['commitState']
): Promise<ProfileArtifactPublicationError> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProfileArtifactPublicationError);
  expect((failure as ProfileArtifactPublicationError).commitState).toBe(state);
  return failure as ProfileArtifactPublicationError;
}

describe('fixed-tree profile artifact publication', () => {
  it('publishes only the canonical fixed tree and preserves exact instruction bytes', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const options = fixture(home, join(parent, 'portable-output'));
    const expectedManifest = Buffer.from(`${JSON.stringify(options.artifact, null, 2)}\n`, 'utf8');

    const result = await publishProfileArtifactDirectory(options);
    const snapshot = await readProfileArtifactDirectory(result.outputPath, options.limitPolicy);

    expect(await sortedDirectoryEntries(result.outputPath)).toEqual(['bazframe-profile.json', 'profile']);
    expect(await sortedDirectoryEntries(join(result.outputPath, 'profile'))).toEqual(['AGENTS.md']);
    expect(await readFile(join(result.outputPath, 'bazframe-profile.json'))).toEqual(expectedManifest);
    expect(await readFile(join(result.outputPath, 'profile', 'AGENTS.md')))
      .toEqual(Buffer.from(options.instructionBytes));
    expect(result.identity).toEqual(snapshot.root);
    expect(result.outputPath).toBe(join(await realpath(parent), 'portable-output'));
  });

  it('copies policy, artifact encoding, and instruction bytes before its first await', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const options = fixture(home, join(parent, 'copied'));
    const originalInstructions = Uint8Array.from(options.instructionBytes);
    const originalManifest = Buffer.from(`${JSON.stringify(options.artifact, null, 2)}\n`, 'utf8');

    const publication = publishProfileArtifactDirectory(options);
    options.limitPolicy.maxManifestBytes = 0;
    options.limitPolicy.maxProfileEntries = Number.NaN;
    options.artifact.profile.id = 'mutated';
    options.artifact.profile.instructions.sha256 = '0'.repeat(64);
    options.instructionBytes.fill(0x78);

    const result = await publication;
    expect(await readFile(join(result.outputPath, 'bazframe-profile.json'))).toEqual(originalManifest);
    expect(await readFile(join(result.outputPath, 'profile', 'AGENTS.md')))
      .toEqual(Buffer.from(originalInstructions));
  });

  it('copies intrinsic Uint8Array bytes without consulting subclass getters or iterators', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const expected = Uint8Array.from([0x73, 0x61, 0x66, 0x65, 0x0a]);
    const hostile = new (class extends Uint8Array {})(expected.length);
    Uint8Array.prototype.set.call(hostile, expected);
    Object.defineProperties(hostile, {
      byteLength: {
        get: () => { throw new Error('overridden byteLength consumed'); }
      },
      [Symbol.iterator]: {
        value: () => { throw new Error('custom iterator consumed'); }
      }
    });
    const options = fixture(home, join(parent, 'intrinsic-copy'), expected);
    options.instructionBytes = hostile;

    const result = await publishProfileArtifactDirectory(options);

    expect(await readFile(join(result.outputPath, 'profile', 'AGENTS.md')))
      .toEqual(Buffer.from(expected));
  });

  it('enforces explicit fixture-derived limits without creating filesystem entries', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const base = fixture(home, join(parent, 'bounded'));

    for (const policy of [
      { ...base.limitPolicy, maxManifestBytes: base.limitPolicy.maxManifestBytes - 1 },
      { ...base.limitPolicy, maxProfileEntries: -1 },
      { ...base.limitPolicy, maxResources: Number.POSITIVE_INFINITY }
    ]) {
      const failure = await expectPublicationError(
        publishProfileArtifactDirectory({ ...base, limitPolicy: policy }),
        'not-published'
      );
      expect(failure.outputPath).toBe(join(parent, 'bounded'));
      expect(dirname(failure.stagingPath)).toBe(parent);
    }
    expect(await sortedDirectoryEntries(parent)).toEqual([]);

    await expect(publishProfileArtifactDirectory({
      ...base,
      outputDirectory: join(parent, 'at-limit'),
      limitPolicy: { ...base.limitPolicy }
    })).resolves.toMatchObject({ outputPath: join(await realpath(parent), 'at-limit') });
  });

  it('rejects invalid instructions and digest mismatch before filesystem work', async () => {
    const cases = [
      Uint8Array.from([0xff]),
      Buffer.from('before\0after'),
      Buffer.alloc(MAX_EFFECTIVE_INSTRUCTION_BYTES + 1, 0x61)
    ];
    for (const bytes of cases) {
      const directory = await temporaryDirectory();
      const home = await directory.mkdir('home');
      const parent = await directory.mkdir('exports');
      const options = fixture(home, join(parent, 'invalid'), bytes);
      await expectPublicationError(publishProfileArtifactDirectory(options), 'not-published');
      expect(await sortedDirectoryEntries(parent)).toEqual([]);
    }

    const nonTypedDirectory = await temporaryDirectory();
    const nonTypedHome = await nonTypedDirectory.mkdir('home');
    const nonTypedParent = await nonTypedDirectory.mkdir('exports');
    const nonTyped = fixture(nonTypedHome, join(nonTypedParent, 'not-typed'));
    nonTyped.instructionBytes = [0x61] as unknown as Uint8Array;
    await expectPublicationError(publishProfileArtifactDirectory(nonTyped), 'not-published');
    expect(await sortedDirectoryEntries(nonTypedParent)).toEqual([]);

    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const mismatch = fixture(home, join(parent, 'mismatch'));
    mismatch.artifact.profile.instructions.sha256 = '0'.repeat(64);
    await expectPublicationError(publishProfileArtifactDirectory(mismatch), 'not-published');
    expect(await sortedDirectoryEntries(parent)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects home overlap, canonical aliases, and linked ancestors', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const exportsDirectory = await directory.mkdir('exports');
    const homeAlias = directory.path('home-alias');
    await symlink(home, homeAlias);

    for (const output of [
      home,
      join(home, 'inside'),
      directory.root,
      join(homeAlias, 'through-alias')
    ]) {
      const failure = await expectPublicationError(
        publishProfileArtifactDirectory(fixture(home, output)),
        'not-published'
      );
      await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await sortedDirectoryEntries(exportsDirectory)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects missing, linked, file, and initially occupied output entries', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const physicalParent = await directory.mkdir('physical-parent');
    const linkedParent = directory.path('linked-parent');
    await symlink(physicalParent, linkedParent);
    const fileParent = await directory.write('file-parent', 'file');

    for (const output of [
      join(directory.path('missing-parent'), 'output'),
      join(linkedParent, 'output'),
      join(fileParent, 'output')
    ]) {
      await expectPublicationError(publishProfileArtifactDirectory(fixture(home, output)), 'not-published');
    }

    const parent = await directory.mkdir('occupied');
    const targets = [
      await directory.write('occupied/file', 'occupied'),
      await directory.mkdir('occupied/empty-directory'),
      await directory.mkdir('occupied/nonempty-directory'),
      directory.path('occupied/link')
    ];
    await directory.write('occupied/nonempty-directory/entry', 'occupied');
    await symlink(targets[0]!, targets[3]!);
    for (const output of targets) {
      await expectPublicationError(publishProfileArtifactDirectory(fixture(home, output)), 'not-published');
    }
    expect(await sortedDirectoryEntries(parent)).toEqual([
      'empty-directory', 'file', 'link', 'nonempty-directory'
    ]);
  });

  it.skipIf(process.platform === 'win32')('uses one private direct sibling staging tree', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const output = join(parent, 'private');
    let observedStaging = '';

    await publishProfileArtifactDirectory(fixture(home, output), {
      atPhase: async (phase) => {
        if (phase !== 'after-tree-written') return;
        observedStaging = await stagingPath(parent);
        expect(dirname(observedStaging)).toBe(parent);
        expect((await lstat(observedStaging)).mode & 0o077).toBe(0);
        expect((await lstat(join(observedStaging, 'profile'))).mode & 0o077).toBe(0);
        expect((await lstat(join(observedStaging, 'bazframe-profile.json'))).mode & 0o077).toBe(0);
        expect((await lstat(join(observedStaging, 'profile', 'AGENTS.md'))).mode & 0o077).toBe(0);
      }
    });
    expect(observedStaging).not.toBe('');
    expect(await sortedDirectoryEntries(parent)).toEqual(['private']);
  });

  it('detects staging-root, manifest, and profile-directory substitution', async () => {
    for (const target of ['staging', 'manifest', 'profile'] as const) {
      const directory = await temporaryDirectory();
      const home = await directory.mkdir('home');
      const parent = await directory.mkdir('exports');
      const saved = directory.path(`saved-${target}`);
      const failure = await expectPublicationError(
        publishProfileArtifactDirectory(fixture(home, join(parent, target)), {
          atPhase: async (phase) => {
            if (target === 'staging' && phase === 'after-staging-created') {
              const staging = await stagingPath(parent);
              await rename(staging, saved);
              await mkdir(staging);
            }
            if (target !== 'staging' && phase === 'after-tree-written') {
              const staging = await stagingPath(parent);
              const path = target === 'manifest'
                ? join(staging, 'bazframe-profile.json')
                : join(staging, 'profile');
              await rename(path, saved);
              if (target === 'manifest') {
                await writeFile(path, await readFile(saved));
              } else {
                await mkdir(path);
                await writeFile(join(path, 'AGENTS.md'), await readFile(join(saved, 'AGENTS.md')));
              }
            }
          }
        }),
        'not-published'
      );
      expect((await lstat(failure.stagingPath)).isDirectory()).toBe(true);
      expect((await lstat(saved)).isDirectory()).toBe(target !== 'manifest');
    }
  });

  it('detects same-inode mutation and foreign child substitution before commit', async () => {
    const mutationDirectory = await temporaryDirectory();
    const mutationHome = await mutationDirectory.mkdir('home');
    const mutationParent = await mutationDirectory.mkdir('exports');
    const mutationFailure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(mutationHome, join(mutationParent, 'mutated')), {
        atPhase: async (phase) => {
          if (phase === 'before-commit-checks') {
            const staging = await stagingPath(mutationParent);
            await writeFile(join(staging, 'profile', 'AGENTS.md'), 'same inode, changed bytes');
          }
        }
      }),
      'not-published'
    );
    await expect(lstat(mutationFailure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const replacementDirectory = await temporaryDirectory();
    const replacementHome = await replacementDirectory.mkdir('home');
    const replacementParent = await replacementDirectory.mkdir('exports');
    const saved = replacementDirectory.path('saved-instructions');
    const replacementFailure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(replacementHome, join(replacementParent, 'replaced')), {
        atPhase: async (phase) => {
          if (phase === 'before-commit-checks') {
            const staging = await stagingPath(replacementParent);
            const instructions = join(staging, 'profile', 'AGENTS.md');
            await rename(instructions, saved);
            await writeFile(instructions, 'foreign replacement');
          }
        }
      }),
      'not-published'
    );
    expect(await readFile(join(replacementFailure.stagingPath, 'profile', 'AGENTS.md'), 'utf8'))
      .toBe('foreign replacement');
  });

  it('detects home and output-parent substitution and refuses unsafe cleanup', async () => {
    const homeDirectory = await temporaryDirectory();
    const home = await homeDirectory.mkdir('home');
    const parent = await homeDirectory.mkdir('exports');
    const movedHome = homeDirectory.path('moved-home');
    await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, join(parent, 'home-change')), {
        atPhase: async (phase) => {
          if (phase === 'before-commit-checks') {
            await rename(home, movedHome);
            await mkdir(home);
          }
        }
      }),
      'not-published'
    );

    const parentDirectory = await temporaryDirectory();
    const secondHome = await parentDirectory.mkdir('home');
    const secondParent = await parentDirectory.mkdir('exports');
    const movedParent = parentDirectory.path('moved-exports');
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(secondHome, join(secondParent, 'parent-change')), {
        atPhase: async (phase) => {
          if (phase === 'before-commit-checks') {
            await rename(secondParent, movedParent);
            await mkdir(secondParent);
          }
        }
      }),
      'not-published'
    );
    expect(failure.cause).toBeInstanceOf(Error);
    expect((await sortedDirectoryEntries(movedParent))
      .some((name) => name.startsWith('.bazframe-profile-staging-')))
      .toBe(true);
  });

  it('detects destination creation during immediate commit checks and cleans staging', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const output = join(parent, 'occupied-late');
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, output), {
        atPhase: async (phase) => {
          if (phase === 'before-commit-checks') await writeFile(output, 'late occupant');
        }
      }),
      'not-published'
    );
    expect(await readFile(output, 'utf8')).toBe('late occupant');
    await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves sync/close failures and aggregates finite-cleanup failure', async () => {
    for (const failureHook of ['sync', 'close'] as const) {
      const directory = await temporaryDirectory();
      const home = await directory.mkdir('home');
      const parent = await directory.mkdir('exports');
      const injected = new Error(`injected ${failureHook} failure`);
      const failure = await expectPublicationError(
        publishProfileArtifactDirectory(fixture(home, join(parent, failureHook)), {
          afterFileSync: failureHook === 'sync'
            ? (entry) => { if (entry === 'manifest') throw injected; }
            : undefined,
          afterClose: failureHook === 'close'
            ? (target) => { if (target === 'manifest') throw injected; }
            : undefined
        }),
        'not-published'
      );
      expect(failure.cause).toBe(injected);
      await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }

    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const primary = new Error('primary sync failure');
    const cleanup = new Error('cleanup refusal');
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, join(parent, 'aggregate')), {
        afterFileSync: () => { throw primary; },
        beforeCleanupEntry: () => { throw cleanup; }
      }),
      'not-published'
    );
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors[0]).toBe(primary);
    expect((failure.cause as AggregateError).errors[1]).toBe(cleanup);
    expect(await lstat(failure.stagingPath)).toMatchObject({ isDirectory: expect.any(Function) });
  });

  it('classifies rename failure, return-without-movement, and move-then-throw by identity', async () => {
    for (const [name, renameHook] of [
      ['throw', async () => { throw new Error('rename failed'); }],
      ['no-move', async () => undefined]
    ] as const) {
      const directory = await temporaryDirectory();
      const home = await directory.mkdir('home');
      const parent = await directory.mkdir('exports');
      const failure = await expectPublicationError(
        publishProfileArtifactDirectory(fixture(home, join(parent, name)), { rename: renameHook }),
        'not-published'
      );
      await expect(lstat(failure.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }

    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, join(parent, 'moved')), {
        rename: async (staging, output) => {
          await rename(staging, output);
          throw new Error('move then throw');
        }
      }),
      'published'
    );
    expect((await lstat(failure.outputPath)).isDirectory()).toBe(true);
    await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a foreign output and cleans an owned staging tree as not published', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const output = join(parent, 'foreign-output');
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, output), {
        rename: async (_staging, destination) => { await mkdir(destination); }
      }),
      'not-published'
    );
    expect(await sortedDirectoryEntries(output)).toEqual([]);
    await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports ambiguity for a foreign output when the created identity moved elsewhere', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const output = join(parent, 'foreign-output');
    const movedAside = directory.path('created-identity-elsewhere');
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, output), {
        rename: async (staging, destination) => {
          await rename(staging, movedAside);
          await mkdir(destination);
        }
      }),
      'commit-ambiguous'
    );
    expect(await sortedDirectoryEntries(output)).toEqual([]);
    expect(await sortedDirectoryEntries(movedAside)).toEqual(['bazframe-profile.json', 'profile']);
    await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclassifies cleanup interference that moves owned staging to output as published', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const output = join(parent, 'moved-during-cleanup');
    let moved = false;
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, output), {
        rename: async () => { throw new Error('injected rename failure'); },
        beforeCleanupEntry: async (entry) => {
          if (entry !== 'instructions' || moved) return;
          moved = true;
          await rename(await stagingPath(parent), output);
        }
      }),
      'published'
    );
    expect(moved).toBe(true);
    expect(await sortedDirectoryEntries(output)).toEqual(['bazframe-profile.json', 'profile']);
    await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports ambiguity when destructive cleanup is moved to output after removing instructions', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const output = join(parent, 'partial-during-cleanup');
    let moved = false;
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, output), {
        rename: async () => { throw new Error('injected rename failure'); },
        beforeCleanupEntry: async (entry) => {
          if (entry !== 'profile-directory' || moved) return;
          moved = true;
          await rename(await stagingPath(parent), output);
        }
      }),
      'commit-ambiguous'
    );

    expect(moved).toBe(true);
    expect(await sortedDirectoryEntries(output)).toEqual(['bazframe-profile.json', 'profile']);
    expect(await sortedDirectoryEntries(join(output, 'profile'))).toEqual([]);
    await expect(lstat(join(output, 'profile', 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports commit ambiguity when neither pathname proves the created identity', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const movedAside = directory.path('moved-aside');
    let cleanupCalled = false;
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, join(parent, 'ambiguous')), {
        rename: async (staging) => { await rename(staging, movedAside); },
        beforeCleanupEntry: () => { cleanupCalled = true; }
      }),
      'commit-ambiguous'
    );
    expect(cleanupCalled).toBe(false);
    expect((await lstat(movedAside)).isDirectory()).toBe(true);
    await expect(lstat(failure.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports post-publication reporting and close failures as published', async () => {
    for (const failureKind of ['reporting', 'close'] as const) {
      const directory = await temporaryDirectory();
      const home = await directory.mkdir('home');
      const parent = await directory.mkdir('exports');
      const output = join(parent, failureKind);
      const failure = await expectPublicationError(
        publishProfileArtifactDirectory(fixture(home, output), {
          atPhase: failureKind === 'reporting'
            ? (phase) => { if (phase === 'after-rename-attempt') throw new Error('reporting failed'); }
            : undefined,
          afterClose: failureKind === 'close'
            ? (target) => { if (target === 'staging-directory') throw new Error('close failed'); }
            : undefined
        }),
        'published'
      );
      expect((await lstat(failure.outputPath)).isDirectory()).toBe(true);
    }
  });

  it.each([
    ['nonthrowing', false],
    ['failing', true]
  ] as const)('reclassifies a published identity moved aside by a %s directory close hook', async (_name, throws) => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const output = join(parent, 'moved-after-publication');
    const movedAside = directory.path('moved-published-identity');
    const options = fixture(home, output);
    let publishedIdentity: { device: number; inode: number } | undefined;
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(options, {
        rename: async (staging, destination) => { await rename(staging, destination); },
        afterClose: async (target) => {
          if (target !== 'staging-directory') return;
          const metadata = await lstat(output);
          publishedIdentity = { device: metadata.dev, inode: metadata.ino };
          await rename(output, movedAside);
          if (throws) throw new Error('close failed after moving published identity');
        }
      }),
      'commit-ambiguous'
    );

    await expect(lstat(failure.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(failure.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const movedMetadata = await lstat(movedAside);
    expect({ device: movedMetadata.dev, inode: movedMetadata.ino }).toEqual(publishedIdentity);
    expect(await sortedDirectoryEntries(movedAside)).toEqual(['bazframe-profile.json', 'profile']);
    expect(await readFile(join(movedAside, 'profile', 'AGENTS.md')))
      .toEqual(Buffer.from(options.instructionBytes));
  });

  it.skipIf(process.platform === 'win32')('reports final parent substitution as published when destination identity remains provable', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const movedParent = directory.path('moved-published-parent');
    const output = join(parent, 'parent-verification');
    const failure = await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, output), {
        atPhase: async (phase) => {
          if (phase !== 'after-rename-attempt') return;
          await rename(parent, movedParent);
          await symlink(movedParent, parent);
        }
      }),
      'published'
    );
    expect((await lstat(failure.outputPath)).isDirectory()).toBe(true);
  });

  it('characterizes the platform empty-directory destination race without deleting output', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const output = join(parent, 'race');
    let result: Awaited<ReturnType<typeof publishProfileArtifactDirectory>> | undefined;
    let failure: ProfileArtifactPublicationError | undefined;
    try {
      result = await publishProfileArtifactDirectory(fixture(home, output), {
        atPhase: async (phase) => {
          if (phase === 'before-rename') await mkdir(output);
        }
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileArtifactPublicationError);
      failure = error as ProfileArtifactPublicationError;
    }
    if (result !== undefined) {
      expect(result.outputPath).toBe(join(await realpath(parent), 'race'));
      expect(await sortedDirectoryEntries(output)).toEqual(['bazframe-profile.json', 'profile']);
    } else {
      expect(failure?.commitState).toBe('not-published');
      expect(await sortedDirectoryEntries(output)).toEqual([]);
    }
  });

  it('escapes diagnostic paths, omits instruction bodies, and has no internal lock or recursive cleanup', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    const secret = 'DO-NOT-PRINT-INSTRUCTION-BODY';
    const output = join(parent, 'bad-\u001b[31m-path');
    const options = fixture(home, output, Buffer.from(secret));
    options.artifact.profile.instructions.sha256 = '0'.repeat(64);
    const failure = await expectPublicationError(publishProfileArtifactDirectory(options), 'not-published');
    expect(failure.message).toContain('bad-\\u001b[31m-path');
    expect(failure.message).not.toContain('\u001b');
    expect(failure.message).not.toContain(secret);

    const source = await readFile(
      join(process.cwd(), 'src/profile-portability/profile-artifact-publication.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/with(?:Global)?StateLock|recursive:\s*true|removeManagedDirectoryTree/u);
    const productionFiles = (await sortedDirectoryEntries(join(process.cwd(), 'src/profile-portability')))
      .filter((name) => name !== 'profile-artifact-publication.ts' && name !== 'profile-export.ts');
    for (const name of productionFiles) {
      expect(await readFile(join(process.cwd(), 'src/profile-portability', name), 'utf8'))
        .not.toContain('publishProfileArtifactDirectory');
    }
  });

  it.skipIf(process.platform !== 'win32')('fails closed where no-follow/private behavior is not established', async () => {
    const directory = await temporaryDirectory();
    const home = await directory.mkdir('home');
    const parent = await directory.mkdir('exports');
    await expectPublicationError(
      publishProfileArtifactDirectory(fixture(home, join(parent, 'windows'))),
      'not-published'
    );
    expect(await sortedDirectoryEntries(parent)).toEqual([]);
  });
});
