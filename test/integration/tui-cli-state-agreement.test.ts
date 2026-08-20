import { realpath } from 'node:fs/promises';
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
        { id: 'focused', active: false },
        { id: 'reviewer', active: true }
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

    const added = await service.addLibrary({ root: provider });
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

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: State agreement fixture.\n---\n\n# ${name}\n`;
}
