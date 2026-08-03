import { spawn } from 'node:child_process';
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
    expect(launched.stderr).toContain('Bazframe 2 experimental prototype');
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
    expect(result.stdout).toContain('experimental prototype dry run');
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
  await directory.write(`${profileRoot}/instructions.md`, 'PROFILE-INSTRUCTIONS-Ω\n');
  const skillA = directory.path(`${profileRoot}/skills/a-skill`);
  const skillZ = directory.path(`${profileRoot}/skills/z-skill`);
  await directory.write(`${profileRoot}/skills/z-skill/SKILL.md`, skill('z-skill'));
  await directory.write(`${profileRoot}/skills/a-skill/SKILL.md`, skill('a-skill'));
  const reviewerRoot = 'home with spaces/profiles/reviewer';
  await directory.write(`${reviewerRoot}/instructions.md`, 'REVIEWER-INSTRUCTIONS\n');
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
