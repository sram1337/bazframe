import { spawnSync } from 'node:child_process';
import { chmod, realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createBazframeTuiService } from '../../src/application/tui-service.js';
import { runCli } from '../../src/cli/run-cli.js';
import { snapshotFilesystem } from '../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('CLI and TUI service state agreement', () => {
  it('shares authoritative profile and membership state without changing provider artifacts', async () => {
    const directory = await createTempDirectory('bazframe state agreement ');
    temporaryDirectories.push(directory);
    const home = directory.path('home');
    const provider = directory.path('provider');
    const cwd = await directory.mkdir('outside git');
    await directory.write('provider/demo-skill/SKILL.md', skill('demo-skill'));
    await directory.write('provider/demo-skill/support.txt', 'provider content\n');
    await directory.write(
      'provider/demo-skill/provider.json',
      '{"provider":"git","revision":"abc123"}\n'
    );
    await directory.write(
      'provider/provider.json',
      '{"schemaVersion":1,"skills":{"demo-skill":{"provider":"git","revision":"abc123"}}}\n'
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      BAZFRAME_HOME: home,
      PI_CODING_AGENT_DIR: directory.path('pi-agent'),
      NO_COLOR: '1'
    };
    const cli = (args: readonly string[]) => runCapturedCli(
      args,
      cwd,
      directory.root,
      environment
    );
    const service = createBazframeTuiService({
      bazframeHome: home,
      bazframeVersion: '0.0.0-integration-test',
      cwd,
      environment,
      userHome: directory.root
    });
    const providerBefore = await snapshotFilesystem(provider);

    await service.createProfile('focused');
    expect(await cli(['profile', 'list'])).toMatchObject({
      status: 0,
      stdout: 'focused\n',
      stderr: ''
    });

    expect(await cli(['profile', 'duplicate', 'focused', 'focused-copy']))
      .toMatchObject({ status: 0, stderr: '' });
    expect((await service.loadDashboard()).profiles.map((profile) => profile.id))
      .toEqual(['focused', 'focused-copy']);

    await service.useProfile('focused-copy');
    expect(await cli(['profile', 'current'])).toMatchObject({
      status: 0,
      stdout: 'focused-copy\n',
      stderr: ''
    });

    expect(await cli(['profile', 'rename', 'focused-copy', 'reviewer']))
      .toMatchObject({ status: 0, stderr: '' });
    expect(await service.loadDashboard()).toMatchObject({
      activeProfileId: 'reviewer',
      profiles: [
        { id: 'reviewer', active: true },
        { id: 'focused', active: false }
      ]
    });

    await service.createProfile('spare');
    expect(await cli(['profile', 'use', 'spare']))
      .toMatchObject({ status: 0, stderr: '' });
    await service.removeProfile('reviewer', { kind: 'generated-empty' });
    expect(await cli(['profile', 'list'])).toMatchObject({
      status: 0,
      stdout: 'focused\nspare\n',
      stderr: ''
    });

    const providerSkill = await realpath(directory.path('provider/demo-skill'));
    expect(await cli(['add', 'skill', providerSkill])).toMatchObject({ status: 0, stderr: '' });
    expect(await cli([
      'profile', 'skills', 'add', 'demo-skill', '--profile', 'focused'
    ])).toMatchObject({ status: 0, stderr: '' });
    let dashboard = await service.loadDashboard();
    expect(dashboard.activeProfileId).toBe('spare');
    const cliMembership = dashboard.profiles
      .find((profile) => profile.id === 'focused')
      ?.memberships.find((membership) => membership.skillId === 'demo-skill');
    expect(cliMembership).toMatchObject({
      originId: 'default',
      kind: 'managed',
      manageable: true
    });

    await service.removeMembership('focused', {
      membershipId: cliMembership!.membershipId,
      originId: cliMembership!.originId!,
      skillId: cliMembership!.skillId
    });
    expect(await cli([
      'profile', 'skills', 'remove', 'demo-skill', '--profile', 'focused'
    ])).toMatchObject({ status: 0, stdout: expect.stringContaining('absent'), stderr: '' });

    await service.addMembership('focused', {
      originId: 'default',
      skillId: 'demo-skill'
    });
    expect(await cli([
      'profile', 'skills', 'add', 'demo-skill', '--profile', 'focused'
    ])).toMatchObject({ status: 0, stdout: expect.stringContaining('current'), stderr: '' });
    expect(await cli(['profile', 'current'])).toMatchObject({
      status: 0,
      stdout: 'spare\n',
      stderr: ''
    });

    expect(await cli([
      'profile', 'skills', 'remove', 'demo-skill', '--profile', 'focused'
    ])).toMatchObject({ status: 0, stdout: expect.stringContaining('removed'), stderr: '' });
    dashboard = await service.loadDashboard();
    expect(dashboard.activeProfileId).toBe('spare');
    expect(dashboard.profiles.find((profile) => profile.id === 'focused')?.memberships)
      .toEqual([]);
    expect(await snapshotFilesystem(provider)).toEqual(providerBefore);
  });

  it('acquires a managed Git library without implicit profile composition', async () => {
    const directory = await createTempDirectory('bazframe remote library state agreement ');
    temporaryDirectories.push(directory);
    const home = directory.path('home');
    const cwd = await directory.mkdir('outside git');
    const remote = await directory.mkdir('remote/remote-library');
    await directory.write('remote/remote-library/demo/SKILL.md', skill('remote-demo'));
    git(['init', '-b', 'main'], remote);
    git(['config', 'user.name', 'Test'], remote);
    git(['config', 'user.email', 'test@example.com'], remote);
    git(['add', '.'], remote);
    git(['commit', '-m', 'initial'], remote);
    const gitWrapper = await managedGitWrapper(directory);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      BAZFRAME_HOME: home,
      PI_CODING_AGENT_DIR: directory.path('pi-agent'),
      NO_COLOR: '1',
      BAZFRAME_GIT_COMMAND: gitWrapper,
      BAZFRAME_GH_COMMAND: directory.path('missing-gh'),
      REAL_GIT: gitExecutable(),
      TEST_REMOTE: remote
    };
    const service = createBazframeTuiService({
      bazframeHome: home,
      bazframeVersion: '0.0.0-integration-test',
      cwd,
      environment,
      userHome: directory.root
    });
    await service.createProfile('focused');
    await service.useProfile('focused');
    const source = 'git:test-owner/remote-library';

    await expect(service.inspectLibraryInput(source)).resolves.toMatchObject({
      kind: 'managed-git', libraryId: 'remote-library',
      remote: 'github.com/test-owner/remote-library'
    });
    await expect(service.inspectLibraryCandidate({ source })).resolves.toMatchObject({
      kind: 'managed-git', libraryId: 'remote-library', enteredSource: source
    });
    const added = await service.addLibrary({ source });

    expect(added).toMatchObject({
      action: 'added', kind: 'library', id: 'remote-library',
      remote: 'github.com/test-owner/remote-library'
    });
    const dashboard = await service.loadDashboard();
    const managedRoot = await realpath(directory.path(
      'home/providers/git/checkouts/library/remote-library'
    ));
    expect(dashboard.collections).toContainEqual(expect.objectContaining({
      kind: 'library', id: 'remote-library', referenceCount: 0, root: managedRoot
    }));
    expect(dashboard.profiles[0]?.libraryReferences).toEqual([]);
  });

  it('shares prepared-library addition without implicit profile composition or provider mutation', async () => {
    const directory = await createTempDirectory('bazframe source state agreement ');
    temporaryDirectories.push(directory);
    const home = directory.path('home');
    const cwd = await directory.mkdir('outside git');
    const provider = await directory.mkdir('downloaded');
    await directory.write('downloaded/demo/SKILL.md', skill('source-demo'));
    await directory.write('downloaded/provider-state.json', '{"owner":"provider"}\n');
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      BAZFRAME_HOME: home,
      PI_CODING_AGENT_DIR: directory.path('pi-agent'),
      NO_COLOR: '1'
    };
    const cli = (args: readonly string[]) => runCapturedCli(args, cwd, directory.root, environment);
    const service = createBazframeTuiService({
      bazframeHome: home,
      bazframeVersion: '0.0.0-integration-test',
      cwd,
      environment,
      userHome: directory.root
    });
    await service.createProfile('focused');
    await service.createProfile('spare');
    await service.useProfile('spare');
    const providerBefore = await snapshotFilesystem(provider);

    const added = await service.addLibrary({ source: provider });
    expect(added).toMatchObject({ action: 'added', library: 'downloaded' });

    const overview = await cli(['libraries']);
    expect(overview).toMatchObject({ status: 0, stderr: '' });
    expect(overview.stdout).toContain('downloaded');
    const dashboard = await service.loadDashboard();
    expect(dashboard.activeProfileId).toBe('spare');
    expect(dashboard.collections).toContainEqual(expect.objectContaining({
      kind: 'library', id: 'downloaded', root: added.root, referenceCount: 0
    }));
    expect(dashboard.profiles.every((profile) => profile.libraryReferences?.length === 0)).toBe(true);
    expect(await snapshotFilesystem(provider)).toEqual(providerBefore);
  });
});

interface CapturedCliResult {
  status: number;
  stdout: string;
  stderr: string;
}

async function runCapturedCli(
  args: readonly string[],
  cwd: string,
  userHome: string,
  environment: NodeJS.ProcessEnv
): Promise<CapturedCliResult> {
  let stdout = '';
  let stderr = '';
  const status = await runCli(args, {
    cwd: () => cwd,
    environment,
    userHome,
    stdoutIsTty: false,
    stderrIsTty: false,
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => { stderr += text; }
  });
  return { status, stdout, stderr };
}

async function managedGitWrapper(directory: TempDirectory): Promise<string> {
  const wrapper = directory.path('git-wrapper.mjs');
  await directory.write('git-wrapper.mjs', `#!/usr/bin/env node
import{spawnSync}from'node:child_process';
const args=process.argv.slice(2);const real=process.env.REAL_GIT;let original;
if(args.includes('clone')){const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));if(index<0)process.exit(88);original=args[index];args[index]=process.env.TEST_REMOTE;const protocol=args.indexOf('protocol.file.allow=never');if(protocol>=0)args[protocol]='protocol.file.allow=always';}
const result=spawnSync(real,args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);
if(original){const destination=args.at(-1);const changed=spawnSync(real,['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}
`);
  await chmod(wrapper, 0o755);
  return wrapper;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git failed: ${args.join(' ')}`);
  return result.stdout;
}

function gitExecutable(): string {
  const result = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git is required for managed Git integration tests');
  return result.stdout.trim();
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: State agreement fixture.\n---\n\n# ${name}\n`;
}
