import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotFilesystem } from '../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('profile management CLI', () => {
  it('runs the lifecycle outside Git while preserving skill providers', async () => {
    if (process.platform === 'win32') return;
    const directory = await createTempDirectory('bazframe profile integration ');
    temporaryDirectories.push(directory);
    const home = directory.path('home');
    const provider = directory.path('provider');
    const cwd = await directory.mkdir('outside git');
    await directory.write(
      'provider/demo-skill/SKILL.md',
      '---\nname: demo-skill\ndescription: Demo.\n---\n'
    );
    await directory.write('provider/demo-skill/support.txt', 'keep');
    const environment = {
      ...process.env,
      BAZFRAME_HOME: home
    };
    const run = (args: string[]) => runCli(args, cwd, environment);

    const added = await run(['profile', 'add', 'focused']);
    expect(added).toMatchObject({ status: 0, stderr: '' });
    expect(added.stdout).toContain('Profile lifecycle: added');
    expect((await lstat(directory.path('home/profiles/focused'))).isDirectory()).toBe(true);
    expect((await run(['profile', 'add', 'focused'])).stdout)
      .toContain('Profile lifecycle: current');
    expect((await run(['profile', 'list'])).stdout).toContain('  - focused');

    expect((await run(['profile', 'use', 'focused'])).stdout)
      .toContain('Active profile: focused');
    const profileOverview = await run(['profile', 'list']);
    expect(profileOverview.stdout).toContain('  * focused (active)');
    expect(profileOverview.stdout).toContain('bazframe profile skill list');
    expect(profileOverview.stdout).toContain('bazframe profile current');
    expect((await run(['profile', 'list'])).stdout).toBe(profileOverview.stdout);
    expect((await run(['profile', 'current'])).stdout).toBe('focused\n');
    const providerSkill = await realpath(directory.path('provider/demo-skill'));
    expect((await run(['skill', 'add', providerSkill])).stdout)
      .toContain('Default skill registration: added');
    expect((await run(['profile', 'skill', 'add', 'demo-skill'])).stdout)
      .toContain('Profile skill membership: added');
    await directory.write('home/profiles/focused/AGENTS.md', 'focused instructions');
    await directory.write('home/profiles/focused/notes/detail.txt', 'detail');
    const providerBefore = await snapshotFilesystem(provider);
    const sourceBefore = await snapshotFilesystem(directory.path('home/profiles/focused'));

    const duplicated = await run(['profile', 'duplicate', 'focused', 'focused-copy']);
    expect(duplicated).toMatchObject({ status: 0, stderr: '' });
    expect(duplicated.stdout).toContain('Profile lifecycle: duplicated');
    expect(duplicated.stdout).toContain('Source profile: focused');
    expect(duplicated.stdout).toContain('Active selection updated: no');
    expect(await snapshotFilesystem(directory.path('home/profiles/focused-copy')))
      .toEqual(sourceBefore);
    expect((await run(['profile', 'current'])).stdout).toBe('focused\n');
    expect((await run(['profile', 'list'])).stdout).toContain('  - focused-copy');
    const duplicateAgain = await run(['profile', 'duplicate', 'focused', 'focused-copy']);
    expect(duplicateAgain.status).toBe(1);
    expect(duplicateAgain.stderr).toContain('occupied');

    const renamed = await run(['profile', 'rename', 'focused', 'reviewer']);
    expect(renamed).toMatchObject({ status: 0, stderr: '' });
    expect(renamed.stdout).toContain('Active selection updated: yes');
    expect((await run(['profile', 'list'])).stdout).toContain('  * reviewer (active)');
    expect((await run(['profile', 'list'])).stdout).toContain('  - focused-copy');

    const activeRemoval = await run(['profile', 'remove', 'reviewer', '--force']);
    expect(activeRemoval.status).toBe(1);
    expect(activeRemoval.stderr).toContain('active profile');

    await run(['profile', 'add', 'spare']);
    await run(['profile', 'use', 'spare']);
    const guarded = await run(['profile', 'remove', 'reviewer']);
    expect(guarded.status).toBe(1);
    expect(guarded.stderr).toContain('--force');

    const forced = await run(['profile', 'remove', 'reviewer', '--force']);
    expect(forced).toMatchObject({ status: 0, stderr: '' });
    expect(forced.stdout).toContain('Profile lifecycle: removed');
    await expect(lstat(directory.path('home/profiles/reviewer')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshotFilesystem(provider)).toEqual(providerBefore);
    expect((await run(['profile', 'remove', 'reviewer'])).stdout)
      .toContain('Profile lifecycle: absent');
  });

  it('edits the named profile through the built CLI with a shell-free inherited process', async () => {
    if (process.platform === 'win32') return;
    const directory = await createTempDirectory('bazframe profile editor integration ');
    temporaryDirectories.push(directory);
    const home = directory.path('home with spaces');
    const cwd = await directory.mkdir('caller cwd');
    const wrapper = directory.path('editor wrapper');
    const record = directory.path('editor record.json');
    await directory.write('editor wrapper', [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.EDITOR_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), sentinel: process.env.EDITOR_SENTINEL }));",
      "fs.appendFileSync(process.argv[2], '\\nedited by wrapper\\n');",
      "process.exit(Number(process.env.EDITOR_EXIT || '0'));",
      ''
    ].join('\n'));
    await chmod(wrapper, 0o755);
    const environment = {
      ...process.env,
      BAZFRAME_HOME: home,
      VISUAL: wrapper,
      EDITOR: '/definitely/ignored-editor',
      EDITOR_RECORD: record,
      EDITOR_SENTINEL: 'inherited'
    };
    await runCli(['profile', 'add', 'focused'], cwd, environment);
    await runCli(['profile', 'add', 'reviewer'], cwd, environment);
    await runCli(['profile', 'use', 'focused'], cwd, environment);

    const edited = await runCli(['profile', 'edit', 'reviewer'], cwd, environment);
    expect(edited).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
      argv: [directory.path('home with spaces/profiles/reviewer/AGENTS.md')],
      cwd: await realpath(directory.path('home with spaces/profiles/reviewer')),
      sentinel: 'inherited'
    });
    expect(await readFile(directory.path('home with spaces/profiles/reviewer/AGENTS.md'), 'utf8'))
      .toContain('edited by wrapper');
    expect((await runCli(['profile', 'current'], cwd, environment)).stdout).toBe('focused\n');

    const nonzero = await runCli(['profile', 'edit', 'reviewer'], cwd, {
      ...environment,
      EDITOR_EXIT: '7'
    });
    expect(nonzero.status).toBe(7);
    const literalFlags = await runCli(['profile', 'edit', 'reviewer'], cwd, {
      ...environment,
      VISUAL: `${wrapper} --wait`
    });
    expect(literalFlags.status).toBe(1);
    expect(literalFlags.stderr).toContain('Could not find editor executable');
  });

  it('keeps list stdout machine-readable while warning about invalid entries', async () => {
    if (process.platform === 'win32') return;
    const directory = await createTempDirectory('bazframe profile list ');
    temporaryDirectories.push(directory);
    const home = directory.path('home');
    const cwd = await directory.mkdir('outside');
    const environment = { ...process.env, BAZFRAME_HOME: home };
    await runCli(['profile', 'add', 'valid'], cwd, environment);
    await directory.mkdir('home/profiles/broken');
    await mkdir(directory.path('outside-profile'));
    await symlink(directory.path('outside-profile'), directory.path('home/profiles/linked'));

    const listed = await runCli(['profile', 'list'], cwd, environment);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('  - valid');
    expect(listed.stderr).toContain('warning:');
    expect(listed.stderr).toContain('broken');
    expect(listed.stderr).toContain('linked');
  });

  it('shows an empty overview without requiring an active profile', async () => {
    const directory = await createTempDirectory('bazframe profile empty overview ');
    temporaryDirectories.push(directory);
    const cwd = await directory.mkdir('outside');
    const environment = { ...process.env, BAZFRAME_HOME: directory.path('home') };

    const overview = await runCli(['profile', 'list'], cwd, environment);
    expect(overview).toMatchObject({ status: 0, stderr: '' });
    expect(overview.stdout).toContain('Profiles\n  (none)');
    expect(overview.stdout).toContain('Active profile: (none)');
  });

  it('provides namespace help and strict remove force placement', async () => {
    const directory = await createTempDirectory('bazframe profile help ');
    temporaryDirectories.push(directory);
    const cwd = await directory.mkdir('outside');
    const environment = { ...process.env, BAZFRAME_HOME: directory.path('home') };
    const rootHelp = await runCli(['--help'], cwd, environment);
    expect(rootHelp).toMatchObject({ status: 0, stderr: '' });
    expect(rootHelp.stdout).toContain('Resources:');
    expect(rootHelp.stdout).toContain('Queries:');
    expect(rootHelp.stdout).toContain('bazframe profile list');
    expect(rootHelp.stdout).not.toContain('bazframe profile add [--json] <profile>');

    const help = await runCli(['profile', '--help'], cwd, environment);
    expect(help).toMatchObject({ status: 0, stderr: '' });
    expect(help.stdout).toContain('bazframe profile add [--json] <profile>');
    expect(help.stdout).toContain('bazframe profile duplicate [--json] <source> <new>');
    expect(help.stdout).toContain('bazframe profile edit <profile>');
    expect((await runCli(['help', 'profiles'], cwd, environment)).status).toBe(2);
    const duplicateHelp = await runCli(
      ['profile', 'duplicate', '--help'],
      cwd,
      environment
    );
    expect(duplicateHelp).toMatchObject({ status: 0, stderr: '' });
    expect(duplicateHelp.stdout).toContain('bazframe profile duplicate [--json] <source> <new>');
    expect(duplicateHelp.stdout).toContain('without following symlinks');
    const usage = await runCli(
      ['profile', 'remove', '--force', '--force', 'focused'],
      cwd,
      environment
    );
    expect(usage.status).toBe(2);
    expect(usage.stdout).toBe('');
  });
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}
