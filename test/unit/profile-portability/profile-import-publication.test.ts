import { mkdtemp, mkdir, lstat, readFile, readlink, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProfileImportPublicationError,
  publishImportedProfile,
  type ProfileImportPublicationOptions,
  type ProfileImportPublicationSkillTarget
} from '../../../src/profile-portability/profile-import-publication.js';
import { encodeProfileCollectionReference } from '../../../src/profiles/profile-skill-collection-reference.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  home: string;
  profiles: string;
  targets: Record<'alpha' | 'beta', string>;
  skills: ProfileImportPublicationSkillTarget[];
  instructions: Uint8Array;
}

async function fixture(): Promise<Fixture> {
  const enteredRoot = await mkdtemp(join(tmpdir(), 'bazframe-profile-import-publication-'));
  roots.push(enteredRoot);
  const root = await realpath(enteredRoot);
  const home = join(root, 'home');
  const profiles = join(home, 'profiles');
  const targets = {
    alpha: join(home, 'providers/git/checkouts/skill/alpha'),
    beta: join(home, 'providers/git/checkouts/skill/beta')
  };
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  await mkdir(targets.alpha, { recursive: true, mode: 0o700 });
  await mkdir(targets.beta, { recursive: true, mode: 0o700 });
  const skills: ProfileImportPublicationSkillTarget[] = [];
  for (const id of ['alpha', 'beta'] as const) {
    const metadata = await lstat(targets[id], { bigint: true });
    skills.push({ id, target: targets[id], device: metadata.dev, inode: metadata.ino });
  }
  return {
    root,
    home,
    profiles,
    targets,
    skills,
    instructions: Uint8Array.from(Buffer.from('exact imported instructions\r\nmultibyte: é\n', 'utf8'))
  };
}

function options(
  entered: Fixture,
  overrides: Partial<ProfileImportPublicationOptions> = {}
): ProfileImportPublicationOptions {
  return {
    bazframeHome: entered.home,
    destinationProfileId: 'focused',
    instructionBytes: entered.instructions,
    skills: entered.skills,
    libraryIds: ['toolkit'],
    commit: async (publish) => {
      await publish();
      return 'published';
    },
    ...overrides
  };
}

async function publicationError(promise: Promise<unknown>): Promise<ProfileImportPublicationError> {
  try { await promise; }
  catch (error) {
    expect(error).toBeInstanceOf(ProfileImportPublicationError);
    return error as ProfileImportPublicationError;
  }
  throw new Error('Expected profile import publication to fail');
}

async function stagingNames(profiles: string): Promise<string[]> {
  return (await readdir(profiles)).filter((name) => name.endsWith('.import.tmp')).sort();
}

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

posixDescribe('imported profile publication', () => {
  it('publishes the exact fixed tree with private modes, direct links, and typed references only', async () => {
    const entered = await fixture();
    const result = await publishImportedProfile(options(entered));
    const destination = join(entered.profiles, 'focused');

    expect(result).toMatchObject({ action: 'published', destinationPath: destination, identity: { path: destination } });
    expect(await readdir(destination)).toEqual(['AGENTS.md', 'libraries', 'skills']);
    expect(Buffer.from(await readFile(join(destination, 'AGENTS.md')))).toEqual(Buffer.from(entered.instructions));
    expect(Number((await lstat(destination, { bigint: true })).mode & 0o777n)).toBe(0o700);
    expect(Number((await lstat(join(destination, 'skills'), { bigint: true })).mode & 0o777n)).toBe(0o700);
    expect(Number((await lstat(join(destination, 'libraries'), { bigint: true })).mode & 0o777n)).toBe(0o700);
    expect(Number((await lstat(join(destination, 'AGENTS.md'), { bigint: true })).mode & 0o777n)).toBe(0o600);
    expect(await readdir(join(destination, 'skills'))).toEqual(['alpha', 'beta']);
    expect(await readlink(join(destination, 'skills/alpha'))).toBe(entered.targets.alpha);
    expect(await readlink(join(destination, 'skills/beta'))).toBe(entered.targets.beta);
    expect(await readdir(join(destination, 'libraries'))).toEqual(['toolkit.json']);
    expect(await readFile(join(destination, 'libraries/toolkit.json'), 'utf8'))
      .toBe(encodeProfileCollectionReference({ schemaVersion: 1, library: 'toolkit' }));
    await expect(lstat(join(destination, 'packages'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(destination, 'skills', 'child'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stagingNames(entered.profiles)).toEqual([]);
  });

  it('omits collection directories when the artifact has no libraries', async () => {
    const entered = await fixture();
    await publishImportedProfile(options(entered, { libraryIds: [] }));
    const destination = join(entered.profiles, 'focused');
    expect(await readdir(destination)).toEqual(['AGENTS.md', 'skills']);
    await expect(lstat(join(destination, 'libraries'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(destination, 'packages'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('defensively copies all mutable inputs before its first await', async () => {
    const entered = await fixture();
    const instructionBytes = Uint8Array.from(entered.instructions);
    const skills = entered.skills.map((skill) => ({ ...skill }));
    const libraryIds = ['toolkit'];
    const enteredOptions = options(entered, { instructionBytes, skills, libraryIds });

    await publishImportedProfile(enteredOptions, {
      atPhase: (phase) => {
        if (phase !== 'after-staging-created') return;
        instructionBytes.fill(0x78);
        skills[0]!.id = 'changed';
        skills[0]!.target = entered.targets.beta;
        skills.splice(1);
        libraryIds[0] = 'changed';
        libraryIds.push('other');
        enteredOptions.destinationProfileId = 'changed';
      }
    });

    const destination = join(entered.profiles, 'focused');
    expect(Buffer.from(await readFile(join(destination, 'AGENTS.md')))).toEqual(Buffer.from(entered.instructions));
    expect(await readdir(join(destination, 'skills'))).toEqual(['alpha', 'beta']);
    expect(await readdir(join(destination, 'libraries'))).toEqual(['toolkit.json']);
    await expect(lstat(join(entered.profiles, 'changed'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails before staging through a linked profiles parent', async () => {
    const entered = await fixture();
    const physicalProfiles = `${entered.profiles}.physical`;
    await rename(entered.profiles, physicalProfiles);
    await symlink(physicalProfiles, entered.profiles);
    const error = await publicationError(publishImportedProfile(options(entered)));
    expect(error.commitState).toBe('not-published');
    expect(await readdir(physicalProfiles)).toEqual([]);
  });

  it('never stages when the destination is already occupied', async () => {
    const entered = await fixture();
    const destination = join(entered.profiles, 'focused');
    await mkdir(destination);
    const error = await publicationError(publishImportedProfile(options(entered)));
    expect(error.commitState).toBe('not-published');
    expect(await lstat(destination)).toMatchObject({});
    expect(await stagingNames(entered.profiles)).toEqual([]);
  });

  it('rejects callback action misuse and rejects publication after the callback returns', async () => {
    const noCall = await fixture();
    const noCallError = await publicationError(publishImportedProfile(options(noCall, {
      commit: async () => 'published'
    })));
    expect(noCallError.commitState).toBe('not-published');
    expect(await stagingNames(noCall.profiles)).toEqual([]);

    const twice = await fixture();
    const twiceError = await publicationError(publishImportedProfile(options(twice, {
      commit: async (publish) => {
        await publish();
        await publish();
        return 'published';
      }
    })));
    expect(twiceError.commitState).toBe('published');
    expect(await lstat(join(twice.profiles, 'focused'))).toMatchObject({});

    const late = await fixture();
    let captured: (() => Promise<void>) | undefined;
    const discarded = await publishImportedProfile(options(late, {
      commit: async (publish) => {
        captured = publish;
        return 'discarded';
      }
    }));
    expect(discarded.action).toBe('discarded');
    expect(await stagingNames(late.profiles)).toEqual([]);
    await expect(lstat(join(late.profiles, 'focused'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(captured!()).rejects.toThrow(/after returning/u);
  });

  it('awaits an unawaited publication before interpreting either callback action', async () => {
    const published = await fixture();
    const publishedResult = await publishImportedProfile(options(published, {
      commit: async (publish) => {
        void publish();
        return 'published';
      }
    }));
    expect(publishedResult.action).toBe('published');
    expect(await readFile(join(published.profiles, 'focused/AGENTS.md'))).toEqual(Buffer.from(published.instructions));
    expect(await stagingNames(published.profiles)).toEqual([]);

    const mismatched = await fixture();
    const mismatchedError = await publicationError(publishImportedProfile(options(mismatched, {
      commit: async (publish) => {
        void publish();
        return 'discarded';
      }
    })));
    expect(mismatchedError.commitState).toBe('published');
    expect(await readFile(join(mismatched.profiles, 'focused/AGENTS.md'))).toEqual(Buffer.from(mismatched.instructions));
    expect(await stagingNames(mismatched.profiles)).toEqual([]);
  });

  it('blocks late destination occupancy without deleting it', async () => {
    const entered = await fixture();
    const destination = join(entered.profiles, 'focused');
    const error = await publicationError(publishImportedProfile(options(entered), {
      atPhase: async (phase) => {
        if (phase === 'before-final-validation') await mkdir(destination);
      }
    }));
    expect(error.commitState).toBe('not-published');
    expect(await lstat(destination)).toMatchObject({});
    expect(await stagingNames(entered.profiles)).toEqual([]);
  });

  it('fails closed on target substitution', async () => {
    const entered = await fixture();
    const moved = `${entered.targets.alpha}.moved`;
    const error = await publicationError(publishImportedProfile(options(entered), {
      atPhase: async (phase) => {
        if (phase !== 'after-tree-written') return;
        await rename(entered.targets.alpha, moved);
        await mkdir(entered.targets.alpha);
      }
    }));
    expect(error.commitState).toBe('not-published');
    expect(await stagingNames(entered.profiles)).toEqual([]);
  });

  it('leaves owned staging rather than cleaning through unexpected or substituted entries', async () => {
    const unexpected = await fixture();
    let unexpectedStaging = '';
    const unexpectedError = await publicationError(publishImportedProfile(options(unexpected), {
      atPhase: async (phase) => {
        if (phase !== 'after-tree-written') return;
        [unexpectedStaging] = (await readdir(unexpected.profiles)).filter((name) => name.endsWith('.import.tmp'))
          .map((name) => join(unexpected.profiles, name));
        await writeFile(join(unexpectedStaging, 'FOREIGN'), 'do not delete');
      }
    }));
    expect(unexpectedError.commitState).toBe('not-published');
    expect(await readFile(join(unexpectedStaging, 'FOREIGN'), 'utf8')).toBe('do not delete');
    expect(await lstat(join(unexpectedStaging, 'AGENTS.md'))).toMatchObject({});

    const substituted = await fixture();
    let substitutedStaging = '';
    const substitutedError = await publicationError(publishImportedProfile(options(substituted), {
      atPhase: async (phase) => {
        if (phase !== 'after-tree-written') return;
        [substitutedStaging] = (await readdir(substituted.profiles)).filter((name) => name.endsWith('.import.tmp'))
          .map((name) => join(substituted.profiles, name));
        await rename(join(substitutedStaging, 'AGENTS.md'), join(substitutedStaging, 'AGENTS.owned'));
        await writeFile(join(substitutedStaging, 'AGENTS.md'), 'foreign');
      }
    }));
    expect(substitutedError.commitState).toBe('not-published');
    expect(await readFile(join(substitutedStaging, 'AGENTS.md'), 'utf8')).toBe('foreign');
    expect(await lstat(join(substitutedStaging, 'skills/alpha'))).toMatchObject({});
  });

  it('classifies profiles-parent substitution as ambiguous and preserves moved staging', async () => {
    const entered = await fixture();
    const movedProfiles = `${entered.profiles}.moved`;
    const error = await publicationError(publishImportedProfile(options(entered), {
      atPhase: async (phase) => {
        if (phase !== 'after-tree-written') return;
        await rename(entered.profiles, movedProfiles);
        await mkdir(entered.profiles);
      }
    }));
    expect(error.commitState).toBe('commit-ambiguous');
    expect((await readdir(movedProfiles)).some((name) => name.endsWith('.import.tmp'))).toBe(true);
    expect(await readdir(entered.profiles)).toEqual([]);
  });

  it('classifies a no-move rename failure as not published and cleans proven staging', async () => {
    const entered = await fixture();
    const error = await publicationError(publishImportedProfile(options(entered), {
      rename: async () => { throw new Error('rename failed'); }
    }));
    expect(error.commitState).toBe('not-published');
    expect(await stagingNames(entered.profiles)).toEqual([]);
    await expect(lstat(join(entered.profiles, 'focused'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('classifies move-then-throw and post-publication failures as published', async () => {
    const moved = await fixture();
    const moveError = await publicationError(publishImportedProfile(options(moved), {
      rename: async (staging, destination) => {
        await rename(staging, destination);
        throw new Error('reporting failed after move');
      }
    }));
    expect(moveError.commitState).toBe('published');
    expect(await readFile(join(moved.profiles, 'focused/AGENTS.md'))).toEqual(Buffer.from(moved.instructions));

    const changed = await fixture();
    const changedError = await publicationError(publishImportedProfile(options(changed), {
      atPhase: async (phase) => {
        if (phase === 'after-rename-attempt') {
          await writeFile(join(changed.profiles, 'focused/AGENTS.md'), 'changed after publication');
        }
      }
    }));
    expect(changedError.commitState).toBe('published');
    expect(await readFile(join(changed.profiles, 'focused/AGENTS.md'), 'utf8')).toBe('changed after publication');
  });

  it('classifies foreign final output as ambiguous and does not delete it or moved owned staging', async () => {
    const entered = await fixture();
    const movedStaging = join(entered.profiles, 'owned-staging-moved');
    const destination = join(entered.profiles, 'focused');
    const error = await publicationError(publishImportedProfile(options(entered), {
      rename: async (staging) => {
        await rename(staging, movedStaging);
        await mkdir(destination);
        await writeFile(join(destination, 'FOREIGN'), 'retain');
      }
    }));
    expect(error.commitState).toBe('commit-ambiguous');
    expect(await readFile(join(destination, 'FOREIGN'), 'utf8')).toBe('retain');
    expect(await lstat(join(movedStaging, 'AGENTS.md'))).toMatchObject({});
  });

  it('re-probes publication identity when cleanup fails after the owned tree moves', async () => {
    const entered = await fixture();
    let moved = false;
    const error = await publicationError(publishImportedProfile(options(entered, {
      commit: async () => 'discarded'
    }), {
      beforeCleanupEntry: async (path) => {
        if (moved) return;
        moved = true;
        const staging = path.slice(0, path.indexOf('/libraries/'));
        await rename(staging, join(entered.profiles, 'focused'));
      }
    }));
    expect(error.commitState).toBe('published');
    expect(await readFile(join(entered.profiles, 'focused/AGENTS.md'))).toEqual(Buffer.from(entered.instructions));
    expect(await stagingNames(entered.profiles)).toEqual([]);
  });

  it('stops cleanup at substituted foreign content without recursively deleting it', async () => {
    const entered = await fixture();
    let staging = '';
    let interfered = false;
    const error = await publicationError(publishImportedProfile(options(entered, {
      commit: async () => 'discarded'
    }), {
      beforeCleanupEntry: async (path) => {
        if (interfered || !path.endsWith('/skills/beta')) return;
        interfered = true;
        staging = path.slice(0, -'/skills/beta'.length);
        await unlink(path);
        await writeFile(path, 'foreign');
      }
    }));
    expect(error.commitState).toBe('not-published');
    expect(await readFile(join(staging, 'skills/beta'), 'utf8')).toBe('foreign');
    expect(await lstat(join(staging, 'skills/alpha'))).toMatchObject({});
    expect(await lstat(join(staging, 'AGENTS.md'))).toMatchObject({});
  });
});
