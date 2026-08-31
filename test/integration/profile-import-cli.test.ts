import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readlink, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeProfileArtifact, type ProfileArtifact } from '../../src/profile-portability/profile-artifact.js';
import { profileArtifactLimitPolicy } from '../../src/profile-portability/profile-portability-policy.js';
import { readManagedGitRecord } from '../../src/providers/managed-git-record.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));

interface CliResult { status: number | null; stdout: string; stderr: string }
const skillDefinition = (name: string) => `---\nname: ${name}\ndescription: Import CLI fixture.\n---\n# ${name}\n`;

// Profile publication intentionally remains fail-closed on Windows until its filesystem contract is validated.
describe.skipIf(process.platform === 'win32')('profile import CLI', () => {
  it('dry-runs without creating the home and returns blocked inspection as successful structured output', async () => {
    const directory = await createTempDirectory('bazframe-profile-import-cli-dry-');
    directories.push(directory);
    const root = await realpath(directory.root);
    const cwd = await directory.mkdir('cwd');
    const artifact = await planningArtifact(directory, 'artifact', 'portable');
    const home = join(root, 'missing-home');
    const gitLog = join(root, 'git.log');
    const gitWrapper = directory.path('network-forbidden.mjs');
    await directory.write('network-forbidden.mjs', `#!/usr/bin/env node\nimport{appendFileSync}from'node:fs';appendFileSync(process.env.TEST_GIT_LOG,'invoked\\n');process.exit(91);\n`);
    await chmod(gitWrapper, 0o755);
    const environment = {
      ...process.env,
      BAZFRAME_HOME: home,
      NO_COLOR: '1',
      BAZFRAME_GIT_COMMAND: gitWrapper,
      BAZFRAME_GH_COMMAND: gitWrapper,
      TEST_GIT_LOG: gitLog
    };
    const manifestBefore = await readFile(join(artifact, 'bazframe-profile.json'));
    const instructionsBefore = await readFile(join(artifact, 'profile/AGENTS.md'));

    const inspected = run(['profile', 'import', artifact, '--dry-run', '--json'], cwd, environment);
    expect(inspected.status, JSON.stringify(inspected)).toBe(0);
    expect(inspected.stderr).toBe('');
    expect(inspected.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'profile.import',
      result: {
        mode: 'dry-run',
        plan: {
          destinationProfileId: 'portable',
          profileAction: 'publish',
          blockers: [],
          resources: [{ kind: 'skill', id: 'alpha', action: 'create', networkRequired: true }]
        }
      }
    });
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(gitLog)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(artifact, 'bazframe-profile.json'))).toEqual(manifestBefore);
    expect(await readFile(join(artifact, 'profile/AGENTS.md'))).toEqual(instructionsBefore);

    await mkdir(home);
    await writeFile(join(home, 'active-profile'), 'portable\n');
    const activeBefore = await readFile(join(home, 'active-profile'));
    const blockedDryRun = run(['--json', 'profile', 'import', '--dry-run', artifact], cwd, environment);
    expect(blockedDryRun.status, JSON.stringify(blockedDryRun)).toBe(0);
    const dryDocument = JSON.parse(blockedDryRun.stdout);
    expect(dryDocument).toMatchObject({
      ok: true,
      command: 'profile.import',
      result: { mode: 'dry-run', plan: { profileAction: 'blocked', blockers: [{ code: 'PROFILE_IMPORT_DANGLING_ACTIVE_SELECTION' }] } }
    });

    const blockedProse = run(['profile', 'import', artifact], cwd, environment);
    expect(blockedProse.status).toBe(1);
    expect(blockedProse.stdout).toContain('Profile import plan (execution inspection):');
    expect(blockedProse.stdout).toContain('Profile action: blocked');
    expect(blockedProse.stderr).toContain('blocked by the already reported plan');
    expect(blockedProse.stderr).not.toContain('Profile import plan');

    const blockedJson = run(['profile', 'import', artifact, '--json'], cwd, environment);
    expect(blockedJson.status).toBe(1);
    expect(blockedJson.stderr).toBe('');
    expect(blockedJson.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(blockedJson.stdout)).toMatchObject({
      ok: false,
      command: 'profile.import',
      error: { code: 'PROFILE_IMPORT_BLOCKED', plan: { profileAction: 'blocked' } }
    });
    expect(await readFile(join(home, 'active-profile'))).toEqual(activeBefore);
    await expect(lstat(join(home, 'profiles/portable'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(gitLog)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('reports retained partial success, then imports exact historical resources and reuses them offline under --as', async () => {
    const fixture = await portableFixture();
    expect(run(['profile', 'add', 'existing'], fixture.cwd, fixture.environment).status).toBe(0);
    expect(run(['profile', 'use', 'existing'], fixture.cwd, fixture.environment).status).toBe(0);
    const activeBefore = await readFile(join(fixture.home, 'active-profile'));

    const partial = run(
      ['profile', 'import', fixture.artifact, '--json'],
      fixture.cwd,
      { ...fixture.environment, TEST_FAIL_LIBRARY: '1' }
    );
    expect(partial.status).toBe(1);
    expect(partial.stdout.trim().split('\n')).toHaveLength(1);
    const partialDocument = JSON.parse(partial.stdout);
    expect(partialDocument).toMatchObject({
      ok: false,
      command: 'profile.import',
      error: {
        code: 'PROFILE_IMPORT_FAILED',
        partialResult: {
          mode: 'partial',
          profileOutcome: 'not-published',
          activeSelectionChanged: false,
          resources: [
            { kind: 'skill', id: 'alpha', outcome: 'created' },
            { kind: 'library', id: 'toolkit', outcome: 'not-created' }
          ]
        }
      },
      diagnostics: [
        { code: 'PROFILE_IMPORT_PARTIAL_RESOURCES_RETAINED' },
        { code: 'PROFILE_IMPORT_FAILURE_DETAIL', message: expect.stringContaining('MANAGED_GIT_PROCESS_FAILED') }
      ]
    });
    await expect(readManagedGitRecord(fixture.home, 'skill', 'alpha')).resolves.toBeDefined();
    await expect(readManagedGitRecord(fixture.home, 'library', 'toolkit')).rejects.toBeDefined();
    await expect(lstat(join(fixture.home, 'profiles/imported'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(fixture.home, 'active-profile'))).toEqual(activeBefore);

    const imported = run(
      ['profile', 'import', fixture.artifact, '--as', 'imported'],
      fixture.cwd,
      fixture.environment
    );
    expect(imported.status, JSON.stringify(imported)).toBe(0);
    expect(imported.stdout.indexOf('Profile import plan (execution inspection):')).toBeGreaterThanOrEqual(0);
    expect(imported.stdout.indexOf('Profile import: completed')).toBeGreaterThan(imported.stdout.indexOf('Profile import plan'));
    expect(imported.stdout).toContain('Destination profile: imported');
    expect(imported.stdout).toContain('skill:alpha — reuse');
    expect(imported.stdout).toContain('library:toolkit — create');
    expect(imported.stdout).toContain('Collection children added to (default): no');

    const skillRecord = (await readManagedGitRecord(fixture.home, 'skill', 'alpha')).record;
    const libraryRecord = (await readManagedGitRecord(fixture.home, 'library', 'toolkit')).record;
    expect(skillRecord.revision).toBe(fixture.revisions.skill);
    expect(libraryRecord.revision).toBe(fixture.revisions.library);
    expect(await readlink(join(fixture.home, 'profiles/imported/skills/alpha'))).toBe(skillRecord.root);
    expect(JSON.parse(await readFile(join(fixture.home, 'profiles/imported/libraries/toolkit.json'), 'utf8'))).toEqual({ schemaVersion: 1, library: 'toolkit' });
    expect(await readdir(join(fixture.home, 'profiles/imported/skills'))).toEqual(['alpha']);
    await expect(lstat(join(fixture.home, 'skills/child'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(fixture.home, 'skills/local-only'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(fixture.home, 'active-profile'))).toEqual(activeBefore);

    const reused = run(
      ['profile', 'import', '--json', '--as=imported', fixture.artifact],
      fixture.cwd,
      { ...fixture.environment, TEST_FAIL_CLONE: '1' }
    );
    expect(reused.status, JSON.stringify(reused)).toBe(0);
    expect(reused.stderr).toBe('');
    expect(reused.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(reused.stdout)).toMatchObject({
      ok: true,
      command: 'profile.import',
      result: {
        mode: 'executed',
        profileOutcome: 'reused',
        activeSelectionChanged: false,
        resources: [
          { kind: 'skill', id: 'alpha', outcome: 'reused' },
          { kind: 'library', id: 'toolkit', outcome: 'reused' }
        ]
      }
    });
    expect(await readFile(join(fixture.home, 'active-profile'))).toEqual(activeBefore);
    for (const line of [...imported.stdout.split('\n'), ...imported.stderr.split('\n')]) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(1024);
    }
  }, 120_000);
});

async function planningArtifact(directory: TempDirectory, relative: string, profileId: string): Promise<string> {
  const artifact = directory.path(relative);
  const instructions = Buffer.from('portable instructions\n', 'utf8');
  await mkdir(join(artifact, 'profile'), { recursive: true });
  await writeFile(join(artifact, 'profile/AGENTS.md'), instructions);
  const manifest: ProfileArtifact = {
    schemaVersion: 1,
    kind: 'bazframe-profile-export',
    profile: {
      id: profileId,
      instructions: { path: 'profile/AGENTS.md', sha256: createHash('sha256').update(instructions).digest('hex') },
      skills: ['alpha'],
      omittedLocalSkills: [],
      libraries: [],
      packages: []
    },
    resources: [{ kind: 'skill', id: 'alpha', source: identity('alpha', 'a'.repeat(40)) }]
  };
  await writeFile(join(artifact, 'bazframe-profile.json'), encodeProfileArtifact(manifest, profileArtifactLimitPolicy()));
  return artifact;
}

async function portableFixture(): Promise<{
  directory: TempDirectory;
  home: string;
  artifact: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  revisions: { skill: string; library: string };
}> {
  const directory = await createTempDirectory('bazframe-profile-import-cli-execute-');
  directories.push(directory);
  const root = await realpath(directory.root);
  const cwd = await directory.mkdir('cwd');
  const home = join(root, 'home');
  const skillRemote = await directory.mkdir('remote/alpha');
  await directory.write('remote/alpha/SKILL.md', skillDefinition('alpha'));
  initialize(skillRemote);
  const skillRevision = git(['rev-parse', 'HEAD'], skillRemote).trim();
  await directory.write('remote/alpha/README.md', 'new branch head\n');
  git(['add', '.'], skillRemote); git(['commit', '-m', 'advance'], skillRemote);

  const libraryRemote = await directory.mkdir('remote/toolkit');
  await directory.write('remote/toolkit/child/SKILL.md', skillDefinition('child'));
  initialize(libraryRemote);
  const libraryRevision = git(['rev-parse', 'HEAD'], libraryRemote).trim();
  await directory.write('remote/toolkit/README.md', 'new branch head\n');
  git(['add', '.'], libraryRemote); git(['commit', '-m', 'advance'], libraryRemote);

  const artifact = directory.path('artifact');
  const instructions = Buffer.from('portable instructions\r\nexact bytes: é\n', 'utf8');
  await mkdir(join(artifact, 'profile'), { recursive: true });
  await writeFile(join(artifact, 'profile/AGENTS.md'), instructions);
  const manifest: ProfileArtifact = {
    schemaVersion: 1,
    kind: 'bazframe-profile-export',
    profile: {
      id: 'focused',
      instructions: { path: 'profile/AGENTS.md', sha256: createHash('sha256').update(instructions).digest('hex') },
      skills: ['alpha'],
      omittedLocalSkills: ['local-only'],
      libraries: ['toolkit'],
      packages: []
    },
    resources: [
      { kind: 'skill', id: 'alpha', source: identity('alpha', skillRevision) },
      { kind: 'library', id: 'toolkit', source: identity('toolkit', libraryRevision) }
    ]
  };
  await writeFile(join(artifact, 'bazframe-profile.json'), encodeProfileArtifact(manifest, profileArtifactLimitPolicy()));

  const wrapper = directory.path('git-wrapper.mjs');
  await directory.write('git-wrapper.mjs', `#!/usr/bin/env node
import{spawnSync}from'node:child_process';
const args=process.argv.slice(2);const real=process.env.REAL_GIT;let original;
if(args.includes('clone')){
  if(process.env.TEST_FAIL_CLONE==='1')process.exit(87);
  const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));if(index<0)process.exit(88);
  original=args[index];
  if(process.env.TEST_FAIL_LIBRARY==='1'&&original.endsWith('/toolkit.git'))process.exit(89);
  args[index]=original.endsWith('/alpha.git')?process.env.TEST_SKILL_REMOTE:process.env.TEST_LIBRARY_REMOTE;
  const protocol=args.indexOf('protocol.file.allow=never');if(protocol>=0)args[protocol]='protocol.file.allow=always';
}
const result=spawnSync(real,args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);
if(original){const destination=args.at(-1);const changed=spawnSync(real,['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}
`);
  await chmod(wrapper, 0o755);
  return {
    directory,
    home,
    artifact,
    cwd,
    environment: {
      ...process.env,
      BAZFRAME_HOME: home,
      NO_COLOR: '1',
      BAZFRAME_GIT_COMMAND: wrapper,
      BAZFRAME_GH_COMMAND: directory.path('missing-gh'),
      REAL_GIT: gitExecutable(),
      TEST_SKILL_REMOTE: skillRemote,
      TEST_LIBRARY_REMOTE: libraryRemote
    },
    revisions: { skill: skillRevision, library: libraryRevision }
  };
}

function identity(id: string, revision: string) {
  return {
    type: 'remoteGit' as const,
    remote: `example.test/team/${id}`,
    fetchUrl: `https://example.test/team/${id}.git`,
    branch: 'main',
    revision
  };
}

function initialize(remote: string): void {
  git(['init', '-b', 'main'], remote);
  git(['config', 'user.name', 'Test'], remote);
  git(['config', 'user.email', 'test@example.com'], remote);
  git(['add', '.'], remote);
  git(['commit', '-m', 'initial'], remote);
}

function run(args: string[], cwd: string, environment: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, env: environment, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args: string[], cwd: string): string {
  const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git failed: ${args.join(' ')}`);
  return result.stdout;
}

function gitExecutable(): string {
  const result = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git is required');
  return result.stdout.trim();
}
