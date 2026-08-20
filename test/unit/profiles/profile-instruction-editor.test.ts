import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  editProfileInstructions,
  resolveProfileInstructionEditorTarget,
  type InheritedChildRunner
} from '../../../src/profiles/profile-instruction-editor.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile instruction editor', () => {
  it('uses the first nonblank VISUAL as one literal executable with the actual file as sole argument', async () => {
    const { home, profile, instructions } = await fixture('profile with-space');
    const environment = {
      VISUAL: '/Applications/Editor Name --wait;literal',
      EDITOR: 'ignored',
      SENTINEL: 'kept'
    };
    const childRunner = vi.fn<InheritedChildRunner>(async () => ({ exitCode: 0, signal: null }));

    await expect(editProfileInstructions({
      bazframeHome: home,
      profileId: 'focused',
      environment,
      childRunner
    })).resolves.toEqual({ exitCode: 0, signal: null });

    expect(childRunner).toHaveBeenCalledWith(
      environment.VISUAL,
      [instructions],
      { cwd: profile, environment, ignoreParentSignals: ['SIGINT'] }
    );
  });

  it('falls back only from blank VISUAL to EDITOR and has no default', async () => {
    const { home, instructions } = await fixture();
    const childRunner = vi.fn<InheritedChildRunner>(async () => ({ exitCode: 4, signal: null }));
    await expect(editProfileInstructions({
      bazframeHome: home,
      profileId: 'focused',
      environment: { VISUAL: '  ', EDITOR: '/editor path' },
      childRunner
    })).resolves.toEqual({ exitCode: 4, signal: null });
    expect(childRunner.mock.calls[0]?.[0]).toBe('/editor path');

    await expect(editProfileInstructions({
      bazframeHome: home,
      profileId: 'focused',
      environment: { VISUAL: '', EDITOR: '\t' },
      childRunner
    })).rejects.toThrow(new RegExp(
      `No external editor is configured for ${escapeRegex(instructions)}`,
      'u'
    ));
  });

  it('validates the selected profile target before requiring an editor', async () => {
    const { home } = await fixture();
    await expect(editProfileInstructions({
      bazframeHome: home,
      profileId: 'missing',
      environment: {}
    })).rejects.toThrow(/Profile "missing" must be a physical directory/u);
  });

  it('does not read instruction bytes before opening them', async () => {
    const { home, instructions } = await fixture();
    await writeFile(instructions, Uint8Array.from([0xff, 0x00, 0xfe]));
    const childRunner = vi.fn<InheritedChildRunner>(async () => ({ exitCode: 0, signal: null }));
    await expect(editProfileInstructions({
      bazframeHome: home,
      profileId: 'focused',
      environment: { EDITOR: 'editor' },
      childRunner
    })).resolves.toEqual({ exitCode: 0, signal: null });
  });

  it('allows the final AGENTS.md entry to be a symlink resolving to a regular file', async () => {
    const { home, profile, instructions } = await fixture();
    const target = join(home, 'provider instructions.md');
    await writeFile(target, 'provider\n');
    await rm(instructions);
    await symlink(target, instructions);
    await expect(resolveProfileInstructionEditorTarget(home, 'focused')).resolves.toEqual({
      profileDirectory: profile,
      instructionsPath: instructions
    });
  });

  it('rejects symlinked roots, missing profiles, and non-file instructions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-editor-roots-'));
    roots.push(root);
    const physical = join(root, 'physical-profiles');
    await mkdir(join(physical, 'focused'), { recursive: true });
    await writeFile(join(physical, 'focused', 'AGENTS.md'), 'ok\n');
    const homeWithLinkedProfiles = join(root, 'linked-home');
    await mkdir(homeWithLinkedProfiles);
    await symlink(physical, join(homeWithLinkedProfiles, 'profiles'));
    await expect(resolveProfileInstructionEditorTarget(homeWithLinkedProfiles, 'focused'))
      .rejects.toThrow(/Profiles root must be a physical directory/u);

    const home = join(root, 'home');
    await mkdir(join(home, 'profiles'), { recursive: true });
    await symlink(join(physical, 'focused'), join(home, 'profiles', 'focused'));
    await expect(resolveProfileInstructionEditorTarget(home, 'focused'))
      .rejects.toThrow(/must be a physical directory/u);
    await expect(resolveProfileInstructionEditorTarget(home, 'missing'))
      .rejects.toThrow(/must be a physical directory/u);

    await rm(join(home, 'profiles', 'focused'));
    await mkdir(join(home, 'profiles', 'focused', 'AGENTS.md'), { recursive: true });
    await expect(resolveProfileInstructionEditorTarget(home, 'focused'))
      .rejects.toThrow(/must resolve to a regular file/u);
  });

  it('wraps spawn failures with editor-specific diagnostics', async () => {
    const { home, instructions } = await fixture();
    const failure = Object.assign(new Error('missing'), { code: 'ENOENT' });
    await expect(editProfileInstructions({
      bazframeHome: home,
      profileId: 'focused',
      environment: { EDITOR: 'missing-editor' },
      childRunner: async () => { throw failure; }
    })).rejects.toThrow(new RegExp(`Could not find editor executable.*${escapeRegex(instructions)}`, 'u'));
  });
});

async function fixture(profileDirectoryName = 'focused') {
  const root = await mkdtemp(join(tmpdir(), 'bazframe-editor-'));
  roots.push(root);
  const home = join(root, 'home with spaces');
  const profile = join(home, 'profiles', 'focused');
  await mkdir(profile, { recursive: true });
  const instructions = join(profile, 'AGENTS.md');
  await writeFile(instructions, `fixture ${profileDirectoryName}\n`);
  return { root, home, profile, instructions };
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
