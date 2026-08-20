import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../../src/cli/run-cli.js';
import type { InheritedChildRunner } from '../../../src/core/external-editor.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('skill edit command', () => {
  it('is discoverable from singular help while plural commands are rejected', async () => {
    for (const argv of [['skill', 'edit', '--help'], ['help', 'skill', 'edit']]) {
      let stdout = '';
      expect(await runCli(argv, { writeStdout: (text) => { stdout += text; } })).toBe(0);
      expect(stdout).toContain('bazframe skill edit <skill>');
      expect(stdout).toContain('VISUAL');
      expect(stdout).toContain('edit provider input through its provider workflow');
      expect(stdout).toContain('bazframe sources build <source>');
    }
    let stderr = '';
    expect(await runCli(['skills', 'edit', 'demo-skill'], {
      writeStderr: (text) => { stderr += text; }
    })).toBe(2);
    expect(stderr).toContain('singular "skill" resource');
  });

  it('opens malformed content and passes through exact exit and signal statuses', async () => {
    if (process.platform === 'win32') return;
    const value = await fixture(Uint8Array.from([0xff, 0x00, 0xfe]));
    for (const [result, expected] of [
      [{ exitCode: 0, signal: null }, 0],
      [{ exitCode: 12, signal: null }, 12],
      [{ exitCode: null, signal: 'SIGQUIT' as const }, 131]
    ] as const) {
      const editorChildRunner = vi.fn<InheritedChildRunner>(async () => result);
      expect(await runCli(['skill', 'edit', 'demo-skill'], {
        environment: { BAZFRAME_HOME: value.home, EDITOR: 'editor' },
        editorChildRunner
      })).toBe(expected);
      expect(editorChildRunner).toHaveBeenCalledWith(
        'editor',
        [value.definition],
        expect.objectContaining({ cwd: value.provider, ignoreParentSignals: ['SIGINT'] })
      );
    }
  });

  it('separates invalid grammar, missing configuration, and missing registration failures', async () => {
    const value = await fixture('valid\n');
    for (const argv of [
      ['skill', 'edit'],
      ['skill', 'edit', 'demo-skill', 'extra'],
      ['skill', 'edit', '../demo-skill']
    ]) {
      expect(await runCli(argv, {
        environment: { BAZFRAME_HOME: value.home, EDITOR: 'editor' },
        writeStderr: () => undefined
      })).toBe(2);
    }

    let stderr = '';
    expect(await runCli(['skill', 'edit', 'demo-skill'], {
      environment: { BAZFRAME_HOME: value.home },
      writeStderr: (text) => { stderr += text; }
    })).toBe(1);
    expect(stderr).toContain('No external editor is configured');

    stderr = '';
    expect(await runCli(['skill', 'edit', 'missing'], {
      environment: { BAZFRAME_HOME: value.home, EDITOR: 'editor' },
      writeStderr: (text) => { stderr += text; }
    })).toBe(1);
    expect(stderr).toContain('not registered');
  });
});

async function fixture(contents: string | Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), 'bazframe-cli-skill-editor-'));
  roots.push(root);
  const home = join(root, 'home');
  const provider = join(root, 'provider', 'demo-skill');
  const definition = join(provider, 'SKILL.md');
  await mkdir(join(home, 'skills'), { recursive: true });
  await mkdir(provider, { recursive: true });
  await writeFile(definition, contents);
  const canonical = await realpath(provider);
  const canonicalDefinition = await realpath(definition);
  await symlink(canonical, join(home, 'skills', 'demo-skill'), 'dir');
  return { home, provider: canonical, definition: canonicalDefinition };
}
