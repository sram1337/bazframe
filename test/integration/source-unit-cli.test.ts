import { execFile, spawn } from 'node:child_process';
import { lstat, realpath, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureProviderManifest } from '../helpers/provider-manifest.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const execFileAsync = promisify(execFile);
const directories: TempDirectory[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

describe('source-unit CLI', () => {
  it('adds, reports, resolves, and removes a broken provider without mutating provider bytes', async () => {
    const directory = await createTempDirectory('bazframe-source-cli-');
    directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const provider = await realpath(await directory.mkdir('provider'));
    await directory.write(
      'provider/nested/derived/SKILL.md',
      '---\nname: derived\ndescription: derived\n---\n\nderived\n'
    );
    const environment = {
      ...process.env,
      BAZFRAME_HOME: directory.path('home'),
      PI_CODING_AGENT_DIR: directory.path('pi-agent'),
      NO_COLOR: '1'
    };
    expect(await runCli(['profile', 'add', 'focused'], cwd, environment))
      .toMatchObject({ status: 0, stderr: '' });
    expect(await runCli(['profile', 'use', 'focused'], cwd, environment))
      .toMatchObject({ status: 0, stderr: '' });

    const descriptorPath = directory.path(
      'home/profiles/focused/source-units/provider/source.json'
    );
    const ownedBeforeAdd = await captureProviderManifest([descriptorPath]);
    const beforeAdd = await captureProviderManifest([provider]);
    const added = await runCli(
      ['profile', 'sources', 'add', 'provider', 'source', provider],
      cwd,
      environment
    );
    const afterAdd = await captureProviderManifest([provider]);
    const ownedAfterAdd = await captureProviderManifest([descriptorPath]);
    expect(afterAdd).toEqual(beforeAdd);
    expect(ownedAfterAdd).not.toEqual(ownedBeforeAdd);
    expect(added).toMatchObject({ status: 0, stderr: '' });
    expect(added.stdout).toContain('Profile source membership: added');
    expect(added.stdout).toContain('Active profile: focused');

    const ownedBeforeOverview = await captureProviderManifest([descriptorPath]);
    const beforeOverview = await captureProviderManifest([provider]);
    const overview = await runCli(['profile', 'sources'], cwd, environment);
    const afterOverview = await captureProviderManifest([provider]);
    const ownedAfterOverview = await captureProviderManifest([descriptorPath]);
    expect(afterOverview).toEqual(beforeOverview);
    expect(ownedAfterOverview).toEqual(ownedBeforeOverview);
    expect(overview).toMatchObject({ status: 0, stderr: '' });
    expect(overview.stdout).toContain('Direct source units:');
    expect(overview.stdout).toContain(`provider/source -> ${provider}`);
    expect(overview.stdout).toContain('derived (provider/source:nested/derived/SKILL.md)');
    expect(overview.stdout).toContain('Source failures:\n  (none)');

    const ownedBeforeStatus = await captureProviderManifest([descriptorPath]);
    const beforeStatus = await captureProviderManifest([provider]);
    const status = await runCli(['status'], cwd, environment);
    const afterStatus = await captureProviderManifest([provider]);
    const ownedAfterStatus = await captureProviderManifest([descriptorPath]);
    expect(afterStatus).toEqual(beforeStatus);
    expect(ownedAfterStatus).toEqual(ownedBeforeStatus);
    expect(status.status).toBe(3);
    expect(status.stderr).toBe('');
    expect(status.stdout).toContain('Flat direct skills: 0');
    expect(status.stdout).toContain('Direct source units: 1');
    expect(status.stdout).toContain('Derived effective skills: 1');
    expect(status.stdout).toContain('derived (provider/source:nested/derived/SKILL.md)');

    await rm(provider, { recursive: true });
    const ownedBeforeRemove = await captureProviderManifest([descriptorPath]);
    const beforeRemove = await captureProviderManifest([provider]);
    const removed = await runCli(
      ['profile', 'sources', 'remove', 'provider', 'source'],
      cwd,
      environment
    );
    const afterRemove = await captureProviderManifest([provider]);
    const ownedAfterRemove = await captureProviderManifest([descriptorPath]);
    expect(afterRemove).toEqual(beforeRemove);
    expect(ownedAfterRemove).not.toEqual(ownedBeforeRemove);
    expect(removed).toMatchObject({ status: 0, stderr: '' });
    expect(removed.stdout).toContain('Profile source membership: removed');
    await expect(lstat(directory.path('home/profiles/focused/source-units')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses Pi 0.82 diagnostics in the production overview and status paths', async () => {
    const directory = await createTempDirectory('bazframe-source-cli-pi-');
    directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const first = await realpath(await directory.mkdir('missing-description'));
    const second = await realpath(await directory.mkdir('also-missing-description'));
    await directory.write(
      'missing-description/SKILL.md',
      '---\nname: missing-description\n---\n'
    );
    await directory.write(
      'also-missing-description/SKILL.md',
      '---\nname: also-missing-description\n---\n'
    );
    const environment = {
      ...process.env,
      BAZFRAME_HOME: directory.path('home'),
      PI_CODING_AGENT_DIR: directory.path('pi-agent'),
      NO_COLOR: '1'
    };
    await runCli(['profile', 'add', 'focused'], cwd, environment);
    await runCli(['profile', 'use', 'focused'], cwd, environment);

    const firstDescriptor = directory.path(
      'home/profiles/focused/source-units/provider/first.json'
    );
    const secondDescriptor = directory.path(
      'home/profiles/focused/source-units/provider/second.json'
    );
    const ownedBeforeFirstAdd = await captureProviderManifest([firstDescriptor]);
    const beforeFirstAdd = await captureProviderManifest([first, second]);
    const firstAdd = await runCli(
      ['profile', 'sources', 'add', 'provider', 'first', first], cwd, environment
    );
    const afterFirstAdd = await captureProviderManifest([first, second]);
    const ownedAfterFirstAdd = await captureProviderManifest([firstDescriptor]);
    expect(afterFirstAdd).toEqual(beforeFirstAdd);
    expect(ownedAfterFirstAdd).toEqual(ownedBeforeFirstAdd);
    expect(firstAdd).toMatchObject({ status: 1, stdout: '' });
    expect(firstAdd.stderr).toContain('description is required');

    const ownedBeforeSecondAdd = await captureProviderManifest([secondDescriptor]);
    const beforeSecondAdd = await captureProviderManifest([first, second]);
    const secondAdd = await runCli(
      ['profile', 'sources', 'add', 'provider', 'second', second], cwd, environment
    );
    const afterSecondAdd = await captureProviderManifest([first, second]);
    const ownedAfterSecondAdd = await captureProviderManifest([secondDescriptor]);
    expect(afterSecondAdd).toEqual(beforeSecondAdd);
    expect(ownedAfterSecondAdd).toEqual(ownedBeforeSecondAdd);
    expect(secondAdd).toMatchObject({ status: 1, stdout: '' });
    expect(secondAdd.stderr).toContain('description is required');

    const ownedBeforeOverview = await captureProviderManifest([firstDescriptor, secondDescriptor]);
    const beforeOverview = await captureProviderManifest([first, second]);
    const overview = await runCli(['profile', 'sources'], cwd, environment);
    const afterOverview = await captureProviderManifest([first, second]);
    const ownedAfterOverview = await captureProviderManifest([firstDescriptor, secondDescriptor]);
    expect(afterOverview).toEqual(beforeOverview);
    expect(ownedAfterOverview).toEqual(ownedBeforeOverview);
    expect(overview).toMatchObject({ status: 0, stderr: '' });
    expect(overview.stdout).toContain('Derived effective skills:\n  (none)');
    expect(overview.stdout).toContain('Direct source units:\n  (none)');

    const ownedBeforeStatus = await captureProviderManifest([firstDescriptor, secondDescriptor]);
    const beforeStatus = await captureProviderManifest([first, second]);
    const status = await runCli(['status'], cwd, environment);
    const afterStatus = await captureProviderManifest([first, second]);
    const ownedAfterStatus = await captureProviderManifest([firstDescriptor, secondDescriptor]);
    expect(afterStatus).toEqual(beforeStatus);
    expect(ownedAfterStatus).toEqual(ownedBeforeStatus);
    expect(status).toMatchObject({ status: 3, stderr: '' });
    expect(status.stdout).toContain('Direct source units: 0');
    expect(status.stdout).toContain('Derived effective skills: 0');
  });

  it('withholds a derived source that conflicts with Pi-resolved folded and fallback flat names', async () => {
    const directory = await createTempDirectory('bazframe-source-cli-flat-names-');
    directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const provider = await realpath(await directory.mkdir('provider'));
    await directory.write(
      'provider/folded/SKILL.md',
      '---\nname: folded-flat\ndescription: derived folded\n---\n'
    );
    await directory.write(
      'provider/fallback/SKILL.md',
      '---\nname: fallback-flat\ndescription: derived fallback\n---\n'
    );
    const environment = {
      ...process.env,
      BAZFRAME_HOME: directory.path('home'),
      PI_CODING_AGENT_DIR: directory.path('pi-agent'),
      NO_COLOR: '1'
    };
    await runCli(['profile', 'add', 'focused'], cwd, environment);
    await runCli(['profile', 'use', 'focused'], cwd, environment);
    await directory.write(
      'home/profiles/focused/skills/folded-directory/SKILL.md',
      '---\nname: >-\n  folded-flat\ndescription: flat folded\n---\n'
    );
    await directory.write(
      'home/profiles/focused/skills/fallback-flat/SKILL.md',
      '---\ndescription: flat fallback\n---\n'
    );
    const descriptorPath = directory.path(
      'home/profiles/focused/source-units/provider/source.json'
    );
    const beforeAdd = await captureProviderManifest([provider]);
    const added = await runCli(
      ['profile', 'sources', 'add', 'provider', 'source', provider], cwd, environment
    );
    const afterAdd = await captureProviderManifest([provider]);
    expect(afterAdd).toEqual(beforeAdd);
    expect(added).toMatchObject({ status: 1, stdout: '' });
    expect(added.stderr).toContain('conflicts with the prospective profile');

    const ownedBeforeOverview = await captureProviderManifest([descriptorPath]);
    const beforeOverview = await captureProviderManifest([provider]);
    const overview = await runCli(['profile', 'sources'], cwd, environment);
    const afterOverview = await captureProviderManifest([provider]);
    const ownedAfterOverview = await captureProviderManifest([descriptorPath]);
    expect(afterOverview).toEqual(beforeOverview);
    expect(ownedAfterOverview).toEqual(ownedBeforeOverview);
    expect(overview).toMatchObject({ status: 0, stderr: '' });
    expect(overview.stdout).toContain('Derived effective skills:\n  (none)');
    expect(overview.stdout).toContain('Direct source units:\n  (none)');

    const ownedBeforeStatus = await captureProviderManifest([descriptorPath]);
    const beforeStatus = await captureProviderManifest([provider]);
    const status = await runCli(['status'], cwd, environment);
    const afterStatus = await captureProviderManifest([provider]);
    const ownedAfterStatus = await captureProviderManifest([descriptorPath]);
    expect(afterStatus).toEqual(beforeStatus);
    expect(ownedAfterStatus).toEqual(ownedBeforeStatus);
    expect(status).toMatchObject({ status: 3, stderr: '' });
    expect(status.stdout).toContain('Flat direct skills: 2');
    expect(status.stdout).toContain('Direct source units: 0');
    expect(status.stdout).toContain('Derived effective skills: 0');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses an occupied FIFO descriptor within a bounded time and preserves it',
    async () => {
      const directory = await createTempDirectory('bazframe-source-cli-fifo-');
      directories.push(directory);
      const cwd = await directory.mkdir('cwd');
      const provider = await realpath(await directory.mkdir('provider'));
      const environment = {
        ...process.env,
        BAZFRAME_HOME: directory.path('home'),
        PI_CODING_AGENT_DIR: directory.path('pi-agent'),
        NO_COLOR: '1'
      };
      await runCli(['profile', 'add', 'focused'], cwd, environment);
      await runCli(['profile', 'use', 'focused'], cwd, environment);
      const descriptorPath = directory.path(
        'home/profiles/focused/source-units/provider/source.json'
      );
      await directory.mkdir('home/profiles/focused/source-units/provider');
      await execFileAsync('mkfifo', [descriptorPath]);
      expect((await lstat(descriptorPath)).isFIFO()).toBe(true);

      const ownedBefore = await captureProviderManifest([descriptorPath]);
      const providerBefore = await captureProviderManifest([provider]);
      const result = await runCli(
        ['profile', 'sources', 'add', 'provider', 'source', provider],
        cwd,
        environment,
        1_000
      );
      const providerAfter = await captureProviderManifest([provider]);
      const ownedAfter = await captureProviderManifest([descriptorPath]);

      expect(providerAfter).toEqual(providerBefore);
      expect(ownedAfter).toEqual(ownedBefore);
      expect(result.timedOut).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Refusing to change unmanaged source-unit descriptor');
      expect((await lstat(descriptorPath)).isFIFO()).toBe(true);
    },
    5_000
  );

  it('exposes no top-level source aliases and enforces trailing --profile placement', async () => {
    const directory = await createTempDirectory('bazframe-source-cli-grammar-');
    directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const environment = { ...process.env, BAZFRAME_HOME: directory.path('home'), NO_COLOR: '1' };
    for (const argv of [
      ['sources'],
      ['source'],
      ['profile', 'sources', 'add', 'provider', 'source', 'relative'],
      ['profile', 'sources', 'remove', 'provider', 'source', '--profile'],
      ['profile', 'sources', 'remove', 'provider', 'source', 'extra']
    ]) {
      const result = await runCli(argv, cwd, environment);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('error:');
    }
  });
});

function runCli(
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs?: number
): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      if (timeout !== undefined) clearTimeout(timeout);
      resolveResult({ status, stdout, stderr, timedOut });
    });
  });
}
