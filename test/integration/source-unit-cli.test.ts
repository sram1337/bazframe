import { spawn } from 'node:child_process';
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));
interface CliResult { status: number | null; stdout: string; stderr: string; }
const skill = (name: string, description = name) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`;

describe('global source CLI', () => {
  it('adds one global source, references it, rebuilds explicitly, and removes only after detach', async () => {
    const fixture = await setup();
    const provider = await realpath(await fixture.directory.mkdir('source'));
    await fixture.directory.write('source/alpha/SKILL.md', skill('zeta', 'first'));
    const added = await runCli(['sources', 'add', provider], fixture.cwd, fixture.environment);
    expect(added).toMatchObject({ status: 0, stderr: '' });
    expect(added.stdout).toContain('Global source: added');
    const initialGlobalOverview = await runCli(['sources'], fixture.cwd, fixture.environment);
    expect(initialGlobalOverview.stdout).toContain('      - zeta (alpha/SKILL.md)');
    expect((await runCli(['profile', 'sources', 'add', 'source'], fixture.cwd, fixture.environment)).stdout).toContain('Profile source reference: added');
    const overview = await runCli(['profile', 'sources'], fixture.cwd, fixture.environment);
    expect(overview.stdout).toContain('Profile source references');
    expect(overview.stdout).toContain('zeta (source:alpha/SKILL.md)');

    const recordPath = fixture.directory.path('home/sources/source.json');
    const beforeProviderChange = await readFile(recordPath, 'utf8');
    await fixture.directory.write('source/beta/SKILL.md', skill('aardvark'));
    expect((await runCli(['profile', 'sources'], fixture.cwd, fixture.environment)).stdout).not.toContain('aardvark (source');
    expect(await readFile(recordPath, 'utf8')).toBe(beforeProviderChange);
    expect((await runCli(['sources', 'build', 'source'], fixture.cwd, fixture.environment)).stdout).toContain('Global source: built');
    expect((await runCli(['profile', 'sources'], fixture.cwd, fixture.environment)).stdout).toContain('aardvark (source:beta/SKILL.md)');
    const rebuiltGlobalOverview = await runCli(['sources'], fixture.cwd, fixture.environment);
    expect(rebuiltGlobalOverview.stdout).toContain('      - zeta (alpha/SKILL.md)');
    expect(rebuiltGlobalOverview.stdout).toContain('      - aardvark (beta/SKILL.md)');
    expect(rebuiltGlobalOverview.stdout.indexOf('zeta (alpha/SKILL.md)'))
      .toBeLessThan(rebuiltGlobalOverview.stdout.indexOf('aardvark (beta/SKILL.md)'));

    const refused = await runCli(['sources', 'remove', 'source'], fixture.cwd, fixture.environment);
    expect(refused.status).toBe(1); expect(refused.stderr).toContain('referenced by profiles: focused');
    await runCli(['profile', 'sources', 'remove', 'source'], fixture.cwd, fixture.environment);
    expect((await runCli(['sources', 'remove', 'source'], fixture.cwd, fixture.environment)).stdout).toContain('Global source: removed');
    expect(await readFile(fixture.directory.path('source/alpha/SKILL.md'), 'utf8')).toContain('first');
  });

  it('rejects a rebuild that would conflict in one of two referencing profiles', async () => {
    const fixture = await setup();
    await runCli(['profile', 'add', 'reviewer'], fixture.cwd, fixture.environment);
    const provider = await realpath(await fixture.directory.mkdir('shared'));
    await fixture.directory.write('shared/alpha/SKILL.md', skill('alpha'));
    await runCli(['sources', 'add', provider], fixture.cwd, fixture.environment);
    await runCli(['profile', 'sources', 'add', 'shared'], fixture.cwd, fixture.environment);
    await runCli(['profile', 'sources', 'add', 'shared', '--profile', 'reviewer'], fixture.cwd, fixture.environment);
    await fixture.directory.write('home/profiles/reviewer/skills/beta/SKILL.md', skill('beta'));
    await fixture.directory.write('shared/beta/SKILL.md', skill('beta'));
    const recordPath = fixture.directory.path('home/sources/shared.json');
    const before = await readFile(recordPath, 'utf8');
    const result = await runCli(['sources', 'build', 'shared'], fixture.cwd, fixture.environment);
    expect(result.status).toBe(1); expect(result.stderr).toContain('reviewer');
    expect(await readFile(recordPath, 'utf8')).toBe(before);
  });

  it('reports global source health and reference-index failures', async () => {
    const fixture = await setup();
    const provider = await realpath(await fixture.directory.mkdir('source'));
    await fixture.directory.write('source/alpha/SKILL.md', skill('alpha'));
    await runCli(['sources', 'add', provider], fixture.cwd, fixture.environment);
    const record = JSON.parse(await readFile(
      fixture.directory.path('home/sources/source.json'), 'utf8'
    )) as { digest: string };
    await fixture.directory.write('home/profiles/broken-profile', 'not a profile directory');

    const indexFailure = await runCli(['sources'], fixture.cwd, fixture.environment);
    expect(indexFailure.status).toBe(0);
    expect(indexFailure.stdout).toContain('source [failed]');
    expect(indexFailure.stdout).toContain('references:unknown');
    expect(indexFailure.stdout).toContain('Reference index failures:');

    const artifact = fixture.directory.path(
      'home/source-snapshots/sha256', record.digest, 'artifact', 'alpha', 'SKILL.md'
    );
    await chmod(artifact, 0o600);
    await writeFile(artifact, 'corrupt');
    const overview = await runCli(['sources'], fixture.cwd, fixture.environment);

    expect(overview.status).toBe(0);
    expect(overview.stdout).toContain('source [failed]');
    expect(overview.stdout).toContain('references:unknown');
    expect(overview.stdout).toContain('broken-snapshot');
    expect(overview.stdout).toContain('Reference index failures:');
    expect(overview.stdout).toContain('broken-profile:. invalid-reference');
  });

  it('keeps valid profile references visible when their global target is missing', async () => {
    const fixture = await setup();
    await fixture.directory.write(
      'home/profiles/focused/sources/missing.json',
      '{\n  "schemaVersion": 1,\n  "source": "missing"\n}\n'
    );

    const overview = await runCli(['profile', 'sources'], fixture.cwd, fixture.environment);
    const status = await runCli(['status'], fixture.cwd, fixture.environment);

    expect(overview.stdout).toContain('missing (target unavailable)');
    expect(overview.stdout).toContain('missing:missing.json invalid-source');
    expect(status.stdout).toContain('Profile source references: 1');
    expect(status.stdout).toContain('missing: failed; target unavailable');
    expect(status.stdout).toContain('missing:missing.json invalid-source');
  });

  it('keeps old profile-local source-units inert', async () => {
    const fixture = await setup();
    await fixture.directory.write('home/profiles/focused/source-units/legacy/source.json', '{"anything":true}\n');
    const overview = await runCli(['profile', 'sources'], fixture.cwd, fixture.environment);
    expect(overview.status).toBe(0);
    expect(overview.stdout).toContain('Referenced sources:\n  (none)');
    expect(await readFile(fixture.directory.path('home/profiles/focused/source-units/legacy/source.json'), 'utf8')).toBe('{"anything":true}\n');
  });

  it('accepts only the approved plural global and profile reference grammar', async () => {
    const fixture = await setup();
    expect((await runCli(['sources'], fixture.cwd, fixture.environment)).status).toBe(0);
    for (const argv of [
      ['source'], ['profile', 'sources', 'build', 'source'],
      ['sources', 'add', 'provider', 'source'],
      ['sources', 'add', 'provider', 'source', '/root'],
      ['sources', 'build', 'provider', 'source'],
      ['sources', 'remove', 'provider', 'source'],
      ['profile', 'sources', 'add', 'provider', 'source'],
      ['profile', 'sources', 'add', 'provider', 'source', '--profile', 'reviewer'],
      ['profile', 'sources', 'remove', 'provider', 'source'],
      ['profile', 'sources', 'remove', 'provider', 'source', '--profile', 'reviewer'],
      ['sources', 'add', 'relative']
    ]) {
      const result = await runCli(argv, fixture.cwd, fixture.environment);
      expect(result.status).toBe(2); expect(result.stderr).toContain('error:');
    }
  });
});

async function setup() {
  const directory = await createTempDirectory('bazframe-source-cli-'); directories.push(directory);
  const cwd = await directory.mkdir('cwd');
  const environment = { ...process.env, BAZFRAME_HOME: directory.path('home'), PI_CODING_AGENT_DIR: directory.path('pi-agent'), NO_COLOR: '1' };
  await runCli(['profile', 'add', 'focused'], cwd, environment);
  await runCli(['profile', 'use', 'focused'], cwd, environment);
  return { directory, cwd, environment };
}
function runCli(args: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; }); child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (status) => resolveResult({ status, stdout, stderr }));
  });
}
