import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotFilesystem } from '../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const temporaryDirectories: TempDirectory[] = [];

interface Fixture {
  directory: TempDirectory;
  home: string;
  repository: string;
  cwd: string;
  capturePath: string;
  environment: NodeJS.ProcessEnv;
  skillA: string;
  skillZ: string;
}

interface CliResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface PiCapture {
  argv: string[];
  cwd: string;
  effectivePath: string;
  effectiveContents: string;
  effectiveExistedDuringLaunch: boolean;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('experimental CLI vertical slice', () => {
  it('selects a profile and launches fake Pi with exact cwd, deliberate additive skills, and uncontaminated stdout', async () => {
    const fixture = await createFixture(true);
    const selected = await runCli(['use', 'focused'], fixture.directory.root, fixture.environment);
    expect(selected).toMatchObject({ status: 0, stderr: '' });
    expect(selected.stdout).toContain(`Profile directory: ${fixture.home}/profiles/focused`);

    const before = await snapshotFilesystem(fixture.repository);
    const launched = await runCli(
      ['pi', '--', '-p', 'hello world', '--model', 'fake/model'],
      fixture.cwd,
      {
        ...fixture.environment,
        FAKE_PI_STDOUT: 'PRINT-LIKE-OUTPUT\n'
      }
    );
    const after = await snapshotFilesystem(fixture.repository);

    const physicalCwd = await realpath(fixture.cwd);
    expect(launched).toMatchObject({
      status: 0,
      signal: null,
      stdout: 'PRINT-LIKE-OUTPUT\n'
    });
    expect(launched.stderr).toContain('Bazframe legacy launcher');
    expect(launched.stderr).toContain(`Working directory: ${physicalCwd}`);
    expect(after).toEqual(before);

    const capture = JSON.parse(await readFile(fixture.capturePath, 'utf8')) as PiCapture;
    expect(capture.cwd).toBe(physicalCwd);
    expect(capture.effectiveExistedDuringLaunch).toBe(true);
    const effectiveRelativeToRepository = relative(await realpath(fixture.repository), capture.effectivePath);
    expect(
      effectiveRelativeToRepository === ''
      || (effectiveRelativeToRepository !== '..'
        && !effectiveRelativeToRepository.startsWith(`..${sep}`)
        && !isAbsolute(effectiveRelativeToRepository))
    ).toBe(false);
    expect(capture.argv).toEqual([
      '--no-context-files',
      '--append-system-prompt',
      capture.effectivePath,
      '--skill',
      fixture.skillA,
      '--skill',
      fixture.skillZ,
      '-p',
      'hello world',
      '--model',
      'fake/model'
    ]);
    expect(capture.argv).not.toContain('--no-skills');
    expect(capture.argv).not.toContain('--');
    expect(capture.effectiveContents).toContain('# Bazframe profile instructions: focused');
    expect(capture.effectiveContents).toContain('PROFILE-INSTRUCTIONS-Ω');
    expect(capture.effectiveContents).toContain('# Bazframe repository instructions');
    expect(capture.effectiveContents).toContain('REPOSITORY-INSTRUCTIONS');
    expect(capture.effectiveContents.indexOf('PROFILE-INSTRUCTIONS-Ω'))
      .toBeLessThan(capture.effectiveContents.indexOf('REPOSITORY-INSTRUCTIONS'));
    await expect(stat(capture.effectivePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses file-free policy defaults and manages an explicit disabled override', async () => {
    const fixture = await createFixture(true);
    const before = await snapshotFilesystem(fixture.repository);

    expect((await runCli(['use', 'focused'], fixture.cwd, fixture.environment)).status).toBe(0);
    const installed = await runCli(
      ['adapter', 'install', 'pi'],
      fixture.cwd,
      fixture.environment
    );
    expect(installed).toMatchObject({ status: 0, stderr: '' });
    expect(installed.stdout).toContain('Pi adapter: installed');
    const adapters = await runCli(['adapters'], fixture.cwd, fixture.environment);
    expect(adapters).toMatchObject({ status: 0, stderr: '' });
    expect(adapters.stdout).toContain('  - pi (current)');
    expect(adapters.stdout).toContain('bazframe adapter uninstall pi');

    const healthyDefault = await runCli(['status'], fixture.cwd, fixture.environment);
    expect(healthyDefault.status).toBe(0);
    expect(healthyDefault.stdout).toContain('Global policy: enabled');
    expect(healthyDefault.stdout).toContain('Project state: none (inherits global policy)');
    expect(healthyDefault.stdout).toContain('Effective behavior: enabled (global-enabled)');
    expect(healthyDefault.stdout).toContain('Corrective actions:\n  (none)');
    await expect(stat(`${fixture.home}/projects`)).rejects.toMatchObject({ code: 'ENOENT' });

    const outsideGit = await fixture.directory.mkdir('outside-git');
    const nonGitStatus = await runCli(['status'], outsideGit, fixture.environment);
    expect(nonGitStatus.status).toBe(0);
    expect(nonGitStatus.stdout).toContain('Repository: (outside a Git worktree)');
    expect(nonGitStatus.stdout).toContain('Project state: not applicable');
    expect(nonGitStatus.stdout).toContain('Effective behavior: enabled (global-enabled)');
    expect(nonGitStatus.stdout).toContain('Active profile: focused');
    const nonGitProjectOverride = await runCli(
      ['project', 'disable'],
      outsideGit,
      fixture.environment
    );
    expect(nonGitProjectOverride.status).toBe(1);
    expect(nonGitProjectOverride.stderr).toContain('not inside a Git worktree');

    const projectsDefault = await runCli(['projects'], fixture.cwd, fixture.environment);
    expect(projectsDefault).toMatchObject({ status: 0, stderr: '' });
    expect(projectsDefault.stdout).toContain('Project overrides\nGlobal policy: enabled\n  (none)');
    expect(projectsDefault.stdout).toContain('(enabled; global-enabled)');

    const disabled = await runCli(['project', 'disable'], fixture.cwd, fixture.environment);
    expect(disabled).toMatchObject({ status: 0, stderr: '' });
    expect(disabled.stdout).toContain('Project policy: disabled');
    expect(disabled.stdout).toContain('Project state: override-added');
    const oldUninit = await runCli(['uninit'], fixture.cwd, fixture.environment);
    expect(oldUninit.status).toBe(2);
    expect(oldUninit.stderr).toContain('bazframe project disable');
    const disabledStatus = await runCli(['status'], fixture.cwd, fixture.environment);
    expect(disabledStatus.status).toBe(0);
    expect(disabledStatus.stdout).toContain('Project state: disabled override');
    expect(disabledStatus.stdout).toContain('native Pi behavior');

    const enabled = await runCli(['project', 'enable'], fixture.cwd, fixture.environment);
    expect(enabled).toMatchObject({ status: 0, stderr: '' });
    expect(enabled.stdout).toContain('Project policy: enabled');
    expect(enabled.stdout).toContain('Project state: override-removed');
    expect(enabled.stdout).toContain('Run `pi -nc`');
    await expect(stat(`${fixture.home}/projects/${projectStateFilename(await realpath(fixture.repository))}`))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const uninstalled = await runCli(
      ['adapter', 'uninstall', 'pi'],
      fixture.cwd,
      fixture.environment
    );
    expect(uninstalled.status).toBe(0);
    expect(uninstalled.stdout).toContain('Pi adapter: uninstalled');
    expect(await snapshotFilesystem(fixture.repository)).toEqual(before);
  });

  it('allows project opt-out without an adapter or active profile', async () => {
    const fixture = await createFixture(true);
    const before = await snapshotFilesystem(fixture.repository);

    const disabled = await runCli(['project', 'disable'], fixture.cwd, fixture.environment);
    expect(disabled).toMatchObject({ status: 0, stderr: '' });
    expect(disabled.stdout).toContain('Project policy: disabled');

    const enableWithoutSetup = await runCli(['project', 'enable'], fixture.cwd, fixture.environment);
    expect(enableWithoutSetup.status).toBe(1);
    expect(enableWithoutSetup.stderr).toContain('adapter install pi');
    const projects = await runCli(['projects'], fixture.cwd, fixture.environment);
    expect(projects.stdout).toContain('(disabled override)');
    expect(await snapshotFilesystem(fixture.repository)).toEqual(before);
  });

  it('lets an enabled project override global disable and minimizes matching state', async () => {
    const fixture = await createFixture(true);
    expect((await runCli(['use', 'focused'], fixture.cwd, fixture.environment)).status).toBe(0);
    expect((await runCli(['adapter', 'install', 'pi'], fixture.cwd, fixture.environment)).status)
      .toBe(0);

    const globallyDisabled = await runCli(['global', 'disable'], fixture.cwd, fixture.environment);
    expect(globallyDisabled).toMatchObject({ status: 0, stderr: '' });
    expect(globallyDisabled.stdout).toContain('Global policy: disabled');
    const inheritedDisabled = await runCli(['status'], fixture.cwd, fixture.environment);
    expect(inheritedDisabled.status).toBe(0);
    expect(inheritedDisabled.stdout).toContain('Effective behavior: disabled (global-disabled');

    const projectEnabled = await runCli(['project', 'enable'], fixture.cwd, fixture.environment);
    expect(projectEnabled).toMatchObject({ status: 0, stderr: '' });
    expect(projectEnabled.stdout).toContain('Precedence: enabled project override');
    const overrideStatus = await runCli(['status'], fixture.cwd, fixture.environment);
    expect(overrideStatus.stdout).toContain('Project state: enabled override');
    expect(overrideStatus.stdout).toContain('Effective behavior: enabled (project-enabled-override)');

    const inheritedAgain = await runCli(['project', 'disable'], fixture.cwd, fixture.environment);
    expect(inheritedAgain.stdout).toContain('Project state: override-removed');
    const globallyEnabled = await runCli(['global', 'enable'], fixture.cwd, fixture.environment);
    expect(globallyEnabled.stdout).toContain('Global policy: enabled');
    await expect(stat(`${fixture.home}/global.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${fixture.home}/projects/${projectStateFilename(await realpath(fixture.repository))}`))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('makes global disable a recovery path and validates global enable before mutation', async () => {
    const fixture = await createFixture(true);
    const disabled = await runCli(['global', 'disable'], fixture.cwd, fixture.environment);
    expect(disabled).toMatchObject({ status: 0, stderr: '' });
    const enable = await runCli(['global', 'enable'], fixture.cwd, fixture.environment);
    expect(enable.status).toBe(1);
    expect(enable.stderr).toContain('adapter install pi');
    expect(JSON.parse(await readFile(`${fixture.home}/global.json`, 'utf8')))
      .toEqual({ schemaVersion: 1, disabled: true });
  });

  it('refuses the deprecated launcher when effective policy is disabled', async () => {
    const fixture = await createFixture(true);
    await runCli(['global', 'disable'], fixture.cwd, fixture.environment);
    const result = await runCli(['pi', '--dry-run'], fixture.cwd, fixture.environment);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invoke `pi` directly');
    expect(result.stderr).toContain('bazframe project enable');
  });

  it('propagates the child exit code and still cleans the effective file', async () => {
    const fixture = await createFixture(true);
    await runCli(['use', 'focused'], fixture.directory.root, fixture.environment);
    const result = await runCli(['pi'], fixture.cwd, {
      ...fixture.environment,
      FAKE_PI_EXIT: '27'
    });

    expect(result.status).toBe(27);
    const capture = JSON.parse(await readFile(fixture.capturePath, 'utf8')) as PiCapture;
    await expect(stat(capture.effectivePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('dry-runs without spawning or writing into a repository and allows missing root AGENTS.md', async () => {
    const fixture = await createFixture(false);
    await runCli(['use', 'focused'], fixture.directory.root, fixture.environment);
    const before = await snapshotFilesystem(fixture.repository);
    const result = await runCli(
      ['pi', '--dry-run', '--', '-p', 'do not run'],
      fixture.cwd,
      fixture.environment
    );
    const after = await snapshotFilesystem(fixture.repository);

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('legacy launcher dry run');
    expect(result.stdout).toContain('Repository instructions: (none)');
    expect(result.stdout).toContain('--- effective instructions ---');
    expect(result.stdout).toContain('PROFILE-INSTRUCTIONS-Ω');
    expect(result.stdout).not.toContain('# Bazframe repository instructions');
    expect(result.stdout).toContain('Would launch executable: pi');
    expect(result.stdout).toContain('"-p"');
    await expect(stat(fixture.capturePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(after).toEqual(before);
  });

  it('changes the next dry-run when a second profile is selected without changing repository instructions', async () => {
    const fixture = await createFixture(true);
    const before = await snapshotFilesystem(fixture.repository);

    await runCli(['use', 'focused'], fixture.directory.root, fixture.environment);
    const focused = await runCli(['pi', '--dry-run'], fixture.cwd, fixture.environment);
    await runCli(['use', 'reviewer'], fixture.directory.root, fixture.environment);
    const reviewer = await runCli(['pi', '--dry-run'], fixture.cwd, fixture.environment);

    const focusedEffective = extractEffectiveInstructions(focused.stdout);
    const reviewerEffective = extractEffectiveInstructions(reviewer.stdout);
    expect(focusedEffective).toContain('PROFILE-INSTRUCTIONS-Ω');
    expect(focusedEffective).not.toContain('REVIEWER-INSTRUCTIONS');
    expect(reviewerEffective).toContain('REVIEWER-INSTRUCTIONS');
    expect(reviewerEffective).not.toContain('PROFILE-INSTRUCTIONS-Ω');

    const repositoryHeading = '# Bazframe repository instructions';
    expect(focusedEffective).toContain(`${repositoryHeading}\n`);
    expect(reviewerEffective).toContain(`${repositoryHeading}\n`);
    expect(focusedEffective.slice(focusedEffective.indexOf(repositoryHeading)))
      .toBe(reviewerEffective.slice(reviewerEffective.indexOf(repositoryHeading)));
    expect(await snapshotFilesystem(fixture.repository)).toEqual(before);
  });

  it('rejects cross-repository session arguments before spawning', async () => {
    const fixture = await createFixture(true);
    await runCli(['use', 'focused'], fixture.directory.root, fixture.environment);
    const result = await runCli(
      ['pi', '--', '--session-id=elsewhere'],
      fixture.cwd,
      fixture.environment
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('session-switching');
    await expect(stat(fixture.capturePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replace a valid active selection when a new profile is invalid', async () => {
    const fixture = await createFixture(true);
    await fixture.directory.mkdir('home with spaces/profiles/broken');
    expect((await runCli(['use', 'focused'], fixture.directory.root, fixture.environment)).status)
      .toBe(0);
    const invalid = await runCli(['use', 'broken'], fixture.directory.root, fixture.environment);
    expect(invalid.status).toBe(1);
    expect(await fixture.directory.readText('home with spaces/active-profile')).toBe('focused\n');
  });

  it('fails outside a Git worktree without spawning Pi', async () => {
    const fixture = await createFixture(true);
    await runCli(['use', 'focused'], fixture.directory.root, fixture.environment);
    const outside = await fixture.directory.mkdir('outside repository');
    const result = await runCli(['pi'], outside, fixture.environment);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not inside a Git worktree');
    await expect(stat(fixture.capturePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createFixture(withRepositoryInstructions: boolean): Promise<Fixture> {
  const directory = await createTempDirectory('bazframe integration ');
  temporaryDirectories.push(directory);
  const home = directory.path('home with spaces');
  const profileRoot = 'home with spaces/profiles/focused';
  await directory.write(`${profileRoot}/AGENTS.md`, 'PROFILE-INSTRUCTIONS-Ω\n');
  const skillA = directory.path(`${profileRoot}/skills/a-skill`);
  const skillZ = directory.path(`${profileRoot}/skills/z-skill`);
  await directory.write(`${profileRoot}/skills/z-skill/SKILL.md`, skill('z-skill'));
  await directory.write(`${profileRoot}/skills/a-skill/SKILL.md`, skill('a-skill'));
  const reviewerRoot = 'home with spaces/profiles/reviewer';
  await directory.write(`${reviewerRoot}/AGENTS.md`, 'REVIEWER-INSTRUCTIONS\n');
  await directory.write(
    `${reviewerRoot}/skills/review-skill/SKILL.md`,
    skill('review-skill')
  );

  const repository = await directory.initGit('repository with spaces');
  if (withRepositoryInstructions) {
    await directory.write('repository with spaces/AGENTS.md', 'REPOSITORY-INSTRUCTIONS\n');
  }
  const cwd = await directory.mkdir('repository with spaces/packages/api');

  const bin = await directory.mkdir('fake pi bin with spaces');
  const capturePath = directory.path('captures/pi.json');
  await directory.mkdir('captures');
  const fakePi = await directory.write('fake pi bin with spaces/pi', fakePiSource());
  await chmod(fakePi, 0o755);

  return {
    directory,
    home,
    repository,
    cwd,
    capturePath,
    environment: {
      ...process.env,
      BAZFRAME_HOME: home,
      PI_CODING_AGENT_DIR: directory.path('pi-agent'),
      PI_CAPTURE: capturePath,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`
    },
    skillA,
    skillZ
  };
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: Integration fixture.\n---\n\n# ${name}\n`;
}

function fakePiSource(): string {
  return `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const promptIndex = argv.indexOf('--append-system-prompt');
const effectivePath = argv[promptIndex + 1];
writeFileSync(process.env.PI_CAPTURE, JSON.stringify({
  argv,
  cwd: process.cwd(),
  effectivePath,
  effectiveContents: readFileSync(effectivePath, 'utf8'),
  effectiveExistedDuringLaunch: existsSync(effectivePath)
}));
if (process.env.FAKE_PI_STDOUT) process.stdout.write(process.env.FAKE_PI_STDOUT);
process.exit(Number(process.env.FAKE_PI_EXIT || '0'));
`;
}

function projectStateFilename(repository: string): string {
  return `${createHash('sha256').update(repository).digest('hex')}.json`;
}

function extractEffectiveInstructions(stdout: string): string {
  const startMarker = '--- effective instructions ---\n';
  const endMarker = '\n--- end effective instructions ---';
  const start = stdout.indexOf(startMarker);
  const end = stdout.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) throw new Error('Dry-run instruction markers are missing.');
  return stdout.slice(start + startMarker.length, end);
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
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
