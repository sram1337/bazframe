import { spawn } from 'node:child_process';
import { lstat, readlink, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotFilesystem } from '../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const temporaryDirectories: TempDirectory[] = [];

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('profile skill membership CLI', () => {
  it('adds and removes active-profile membership idempotently outside Git and preserves providers', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    const currentBefore = await snapshotFilesystem(fixture.library);
    const legacyBefore = await snapshotFilesystem(fixture.legacyLibrary);

    const selected = await runCli(['use', 'focused'], fixture.cwd, fixture.environment);
    expect(selected).toMatchObject({ status: 0, stderr: '' });

    const available = await runCli(['skills'], fixture.cwd, fixture.environment);
    expect(available).toMatchObject({ status: 0, stderr: '' });
    expect(available.stdout).toContain(`Source: ${fixture.library}/skills`);
    expect(available.stdout).toContain('  - demo-skill');
    expect(available.stdout).toContain('bazframe profile skills add <skill>');
    expect((await runCli(['skill'], fixture.cwd, fixture.environment)).stdout)
      .toBe(available.stdout);

    const added = await runCli(
      ['profile', 'skills', 'add', 'demo-skill'],
      fixture.cwd,
      fixture.environment
    );
    expect(added).toMatchObject({ status: 0, stderr: '' });
    expect(added.stdout).toContain('Profile skill membership: added');
    expect(added.stdout).toContain('Active profile: focused');
    expect(added.stdout).toContain('Skill: demo-skill');
    expect(added.stdout).toContain(`Source: ${fixture.source}`);
    expect(added.stdout).toContain(`Membership: ${fixture.membership}`);
    expect((await lstat(fixture.membership)).isSymbolicLink()).toBe(true);
    expect(await readlink(fixture.membership)).toBe(fixture.source);
    await expect(lstat(fixture.reviewerMembership)).rejects.toMatchObject({ code: 'ENOENT' });

    const profileSkills = await runCli(
      ['profile', 'skills'],
      fixture.cwd,
      fixture.environment
    );
    expect(profileSkills).toMatchObject({ status: 0, stderr: '' });
    expect(profileSkills.stdout).toContain('Active profile: focused');
    expect(profileSkills.stdout).toContain('  - demo-skill');

    const current = await runCli(['add', 'demo-skill'], fixture.cwd, fixture.environment);
    expect(current).toMatchObject({ status: 0, stderr: '' });
    expect(current.stdout).toContain('Profile skill membership: current');

    const removed = await runCli(
      ['profile', 'skills', 'remove', 'demo-skill'],
      fixture.cwd,
      fixture.environment
    );
    expect(removed).toMatchObject({ status: 0, stderr: '' });
    expect(removed.stdout).toContain('Profile skill membership: removed');
    const absent = await runCli(['remove', 'demo-skill'], fixture.cwd, fixture.environment);
    expect(absent).toMatchObject({ status: 0, stderr: '' });
    expect(absent.stdout).toContain('Profile skill membership: absent');

    expect(await snapshotFilesystem(fixture.library)).toEqual(currentBefore);
    expect(await snapshotFilesystem(fixture.legacyLibrary)).toEqual(legacyBefore);
  });

  it('targets an inactive profile explicitly without changing active selection', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await runCli(['profile', 'use', 'focused'], fixture.cwd, fixture.environment);

    const added = await runCli(
      ['profile', 'skills', 'add', 'demo-skill', '--profile', 'reviewer'],
      fixture.cwd,
      fixture.environment
    );
    expect(added).toMatchObject({ status: 0, stderr: '' });
    expect(added.stdout).toContain('Profile: reviewer');
    expect(added.stdout).not.toContain('Active profile:');
    expect(await readlink(fixture.reviewerMembership)).toBe(fixture.source);
    await expect(lstat(fixture.membership)).rejects.toMatchObject({ code: 'ENOENT' });

    const current = await runCli(['profile', 'current'], fixture.cwd, fixture.environment);
    expect(current).toMatchObject({ status: 0, stdout: 'focused\n', stderr: '' });

    const removed = await runCli(
      ['profile', 'skills', 'remove', 'demo-skill', '--profile', 'reviewer'],
      fixture.cwd,
      fixture.environment
    );
    expect(removed).toMatchObject({ status: 0, stderr: '' });
    await expect(lstat(fixture.reviewerMembership)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses physical, foreign, and mismatched entries without changing their owners', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await runCli(['use', 'focused'], fixture.cwd, fixture.environment);
    const providerBefore = await snapshotFilesystem(fixture.library);

    await fixture.directory.write(
      'home/profiles/focused/skills/demo-skill/keep.txt',
      'keep\n'
    );
    const physicalAdd = await runCli(['add', 'demo-skill'], fixture.cwd, fixture.environment);
    const physicalRemove = await runCli(['remove', 'demo-skill'], fixture.cwd, fixture.environment);
    expect(physicalAdd.status).toBe(1);
    expect(physicalRemove.status).toBe(1);
    expect(physicalAdd.stderr).toContain('physical entry');
    expect(await fixture.directory.readText(
      'home/profiles/focused/skills/demo-skill/keep.txt'
    )).toBe('keep\n');

    await rm(fixture.membership, { recursive: true });
    const foreign = fixture.directory.path('foreign/skill');
    await fixture.directory.mkdir('foreign/skill');
    await symlink(foreign, fixture.membership);
    const foreignRemove = await runCli(['remove', 'demo-skill'], fixture.cwd, fixture.environment);
    expect(foreignRemove.status).toBe(1);
    expect(foreignRemove.stderr).toContain('targets');
    expect(await readlink(fixture.membership)).toBe(foreign);
    expect(await snapshotFilesystem(fixture.library)).toEqual(providerBefore);

    await fixture.directory.write(
      'skillbook current/skills/wrong-skill/SKILL.md',
      skill('other-skill')
    );
    const mismatchedBefore = await snapshotFilesystem(fixture.library);
    const mismatched = await runCli(['add', 'wrong-skill'], fixture.cwd, fixture.environment);
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain('declares frontmatter name');
    await expect(lstat(fixture.directory.path(
      'home/profiles/focused/skills/wrong-skill'
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshotFilesystem(fixture.library)).toEqual(mismatchedBefore);
    expect(await fixture.directory.readText(
      'skillbook current/skills/wrong-skill/SKILL.md'
    )).toBe(skill('other-skill'));
  });

  it('suggests close available skills when add cannot find the requested skill', async () => {
    const fixture = await createFixture();
    await runCli(['use', 'focused'], fixture.cwd, fixture.environment);
    const before = await snapshotFilesystem(fixture.library);

    const typo = await runCli(
      ['profile', 'skills', 'add', 'demo-skil'],
      fixture.cwd,
      fixture.environment
    );
    expect(typo.status).toBe(1);
    expect(typo.stdout).toBe('');
    expect(typo.stderr).toContain('does not exist');
    expect(typo.stderr).toContain('Did you mean "demo-skill"?');

    const unrelated = await runCli(['add', 'unrelated'], fixture.cwd, fixture.environment);
    expect(unrelated.status).toBe(1);
    expect(unrelated.stderr).toContain('Run `bazframe skills` to list available skills.');
    expect(await snapshotFilesystem(fixture.library)).toEqual(before);
  });

  it('reports missing active selection, command help, and usage errors with stable exit codes', async () => {
    const fixture = await createFixture();
    const missing = await runCli(['add', 'demo-skill'], fixture.cwd, fixture.environment);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('No active profile');

    const help = await runCli(
      ['profile', 'skills', 'add', '--help'],
      fixture.cwd,
      fixture.environment
    );
    expect(help).toMatchObject({ status: 0, stderr: '' });
    expect(help.stdout).toContain('Usage: bazframe profile skills add <skill>');

    const usage = await runCli(['remove', '../escape'], fixture.cwd, fixture.environment);
    expect(usage.status).toBe(2);
    expect(usage.stdout).toBe('');
    expect(usage.stderr).toContain('Skill IDs must be');
  });
});

async function createFixture() {
  const directory = await createTempDirectory('bazframe membership integration ');
  temporaryDirectories.push(directory);
  const home = directory.path('home');
  const library = directory.path('skillbook current');
  const legacyLibrary = directory.path('skillbook legacy');
  const source = directory.path('skillbook current/skills/demo-skill');
  const membership = directory.path('home/profiles/focused/skills/demo-skill');
  const reviewerMembership = directory.path('home/profiles/reviewer/skills/demo-skill');
  const cwd = await directory.mkdir('outside git');

  await directory.write('home/profiles/focused/AGENTS.md', 'focused\n');
  await directory.mkdir('home/profiles/focused/skills');
  await directory.write('home/profiles/reviewer/AGENTS.md', 'reviewer\n');
  await directory.mkdir('home/profiles/reviewer/skills');
  await directory.write('skillbook current/skills/demo-skill/SKILL.md', skill('demo-skill'));
  await directory.write('skillbook current/skills/demo-skill/support.txt', 'current\n');
  await directory.write('skillbook current/skillbook.lock.json', '{"schema":1,"current":true}\n');
  await directory.write('skillbook legacy/skills/demo-skill/SKILL.md', skill('demo-skill'));
  await directory.write('skillbook legacy/skills/demo-skill/support.txt', 'legacy\n');
  await directory.write('skillbook legacy/skillbook.lock.json', '{"schema":1,"legacy":true}\n');

  return {
    directory,
    home,
    library,
    legacyLibrary,
    source,
    membership,
    reviewerMembership,
    cwd,
    environment: {
      ...process.env,
      BAZFRAME_HOME: home,
      SKILLBOOK_LIBRARY: library,
      SKILLBOOK_LOCK_LIBRARY: legacyLibrary
    }
  };
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: Integration fixture.\n---\n\n# ${name}\n`;
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
