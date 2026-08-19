import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const referenceMocks = vi.hoisted(() => ({
  captureBulk: vi.fn()
}));

vi.mock('../../../src/profiles/profile-source-reference.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/profiles/profile-source-reference.js')>();
  referenceMocks.captureBulk.mockImplementation(actual.captureProfileSourceReferenceBulkIndex);
  return {
    ...actual,
    captureProfileSourceReferenceBulkIndex: referenceMocks.captureBulk
  };
});

import { createBazframeTuiService } from '../../../src/application/tui-service.js';
import { runCli } from '../../../src/cli/run-cli.js';
import { addProfile } from '../../../src/profiles/profile-management.js';
import { profileSourceReferenceKey } from '../../../src/profiles/profile-source-reference.js';
import { writeActiveProfile } from '../../../src/profiles/profile-store.js';
import { addSource } from '../../../src/sources/source-lifecycle.js';

const directories: TempDirectory[] = [];
afterEach(async () => {
  referenceMocks.captureBulk.mockReset();
  await Promise.all(directories.splice(0).map((directory) => directory.cleanup()));
});

describe('bulk profile-reference index overview consumers', () => {
  it('CLI captures once and derives count, diagnostics, and health from that capture', async () => {
    const fixture = await setup();
    referenceMocks.captureBulk.mockReset();
    referenceMocks.captureBulk.mockResolvedValue(capturedIndex(true));
    let stdout = '';

    const status = await runCli(['sources'], {
      cwd: () => fixture.directory.root,
      environment: fixture.environment,
      writeStdout: (text) => { stdout += text; },
      writeStderr: () => undefined
    });

    expect(status).toBe(0);
    expect(referenceMocks.captureBulk).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('source [failed]');
    expect(stdout).toContain('references:unknown');
    expect(stdout.match(/raced-profile:\. invalid-reference/gu)).toHaveLength(1);
  });

  it('TUI captures once and derives count, diagnostics, and health from that capture', async () => {
    const fixture = await setup();
    referenceMocks.captureBulk.mockReset();
    referenceMocks.captureBulk.mockResolvedValue(capturedIndex(false));
    const service = createBazframeTuiService({
      bazframeHome: fixture.home,
      bazframeVersion: '0.1.0-test',
      cwd: fixture.directory.root,
      environment: {
        ...fixture.environment,
        SKILLBOOK_LIBRARY: fixture.directory.path('skillbook')
      },
      userHome: fixture.directory.root
    });

    const dashboard = await service.loadDashboard();

    expect(referenceMocks.captureBulk).toHaveBeenCalledTimes(1);
    expect(dashboard.managedSources).toEqual([expect.objectContaining({
      id: 'managed:source',
      referenceCount: 3,
      health: 'ready',
      diagnostics: []
    })]);
    expect(dashboard.diagnostics.some((item) => item.id.startsWith('managed-source-reference-index-'))).toBe(false);
  });
});

function capturedIndex(withDiagnostic: boolean) {
  return {
    profileIdsBySource: new Map([
      [profileSourceReferenceKey('source'), ['one', 'two', 'three']]
    ]),
    diagnostics: withDiagnostic
      ? [{
          profileId: 'raced-profile',
          diagnostic: { source: '<unknown-source>', path: '.' }
        }]
      : [],
    identity: 'captured-once'
  };
}

async function setup(): Promise<{
  directory: TempDirectory;
  home: string;
  environment: NodeJS.ProcessEnv;
}> {
  const directory = await createTempDirectory('bazframe-reference-consumer-');
  directories.push(directory);
  const home = directory.path('home');
  await addProfile(home, 'focused');
  await writeActiveProfile(home, 'focused');
  const source = await realpath(await directory.mkdir('source'));
  await directory.write('source/demo/SKILL.md', '---\nname: demo\ndescription: demo\n---\n');
  await addSource({ bazframeHome: home }, source);
  return {
    directory,
    home,
    environment: {
      ...process.env,
      BAZFRAME_HOME: home,
      PI_CODING_AGENT_DIR: directory.path('pi-agent'),
      NO_COLOR: '1'
    }
  };
}
