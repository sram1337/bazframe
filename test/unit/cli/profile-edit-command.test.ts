import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../../src/cli/run-cli.js';
import type { InheritedChildRunner } from '../../../src/profiles/profile-instruction-editor.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile edit command', () => {
  it('is discoverable from both help forms', async () => {
    for (const argv of [['profile', 'edit', '--help'], ['help', 'profile', 'edit']]) {
      let stdout = '';
      expect(await runCli(argv, { writeStdout: (text) => { stdout += text; } })).toBe(0);
      expect(stdout).toContain('bazframe profile edit <profile>');
      expect(stdout).toContain('VISUAL');
      expect(stdout).toContain('wrapper executable');
    }
  });

  it('passes through exact editor exit and signal statuses without success output', async () => {
    const home = await fixture();
    for (const [result, expected] of [
      [{ exitCode: 0, signal: null }, 0],
      [{ exitCode: 9, signal: null }, 9],
      [{ exitCode: null, signal: 'SIGINT' as const }, 130]
    ] as const) {
      let stdout = '';
      let stderr = '';
      const editorChildRunner = vi.fn<InheritedChildRunner>(async () => result);
      expect(await runCli(['profile', 'edit', 'focused'], {
        environment: { BAZFRAME_HOME: home, EDITOR: 'editor' },
        editorChildRunner,
        writeStdout: (text) => { stdout += text; },
        writeStderr: (text) => { stderr += text; }
      })).toBe(expected);
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    }
  });

  it('separates usage, configuration, and spawn failures', async () => {
    const home = await fixture();
    let stderr = '';
    expect(await runCli(['profile', 'edit'], {
      environment: { BAZFRAME_HOME: home, EDITOR: 'editor' },
      writeStderr: (text) => { stderr += text; }
    })).toBe(2);
    expect(stderr).toContain('requires exactly one <profile> argument');

    stderr = '';
    expect(await runCli(['profile', 'edit', 'focused'], {
      environment: { BAZFRAME_HOME: home },
      writeStderr: (text) => { stderr += text; }
    })).toBe(1);
    expect(stderr).toContain('No external editor is configured');

    stderr = '';
    expect(await runCli(['profile', 'edit', 'focused'], {
      environment: { BAZFRAME_HOME: home, EDITOR: 'missing' },
      editorChildRunner: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      writeStderr: (text) => { stderr += text; }
    })).toBe(1);
    expect(stderr).toContain('Could not find editor executable');
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bazframe-cli-editor-'));
  roots.push(root);
  const home = join(root, 'home');
  const profile = join(home, 'profiles', 'focused');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'AGENTS.md'), 'instructions\n');
  return home;
}
