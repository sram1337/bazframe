import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../../src/profiles/profile-skill-collection-reference.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/profiles/profile-skill-collection-reference.js')>();
  mocks.capture.mockImplementation(actual.captureProfileCollectionReferenceBulkIndex);
  return { ...actual, captureProfileCollectionReferenceBulkIndex: mocks.capture };
});

import { createBazframeTuiService } from '../../../src/application/tui-service.js';
import { runCli } from '../../../src/cli/run-cli.js';
import { addProfile } from '../../../src/profiles/profile-management.js';
import { writeActiveProfile } from '../../../src/profiles/profile-store.js';
import { addLibrary } from '../../../src/skill-collections/skill-collection-lifecycle.js';

const directories: TempDirectory[] = [];
afterEach(async () => { mocks.capture.mockReset(); await Promise.all(directories.splice(0).map((directory) => directory.cleanup())); });

describe('typed bulk reference-index overview consumers', () => {
  it('CLI captures once and derives unknown count, failed health, and kind-qualified diagnostics from that capture', async () => {
    const fixture = await setup(); mocks.capture.mockReset();
    mocks.capture.mockResolvedValue(capturedIndex(true)); let stdout = '';
    const status = await runCli(['library', 'list'], {
      cwd: () => fixture.directory.root, environment: fixture.environment,
      writeStdout: (text) => { stdout += text; }, writeStderr: () => undefined
    });
    expect(status).toBe(0); expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('library [failed]'); expect(stdout).toContain('references:unknown');
    expect(stdout.match(/raced-profile:library:\. invalid-reference/gu)).toHaveLength(1);
  });

  it('TUI captures once and derives reference count and health from that capture', async () => {
    const fixture = await setup(); mocks.capture.mockReset(); mocks.capture.mockResolvedValue(capturedIndex(false));
    const service = createBazframeTuiService({ bazframeHome: fixture.home, bazframeVersion: 'test', cwd: fixture.directory.root, environment: fixture.environment, userHome: fixture.directory.root });
    const dashboard = await service.loadDashboard();
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(dashboard.collections).toEqual([expect.objectContaining({ key: 'library:library', referenceCount: 3, health: 'ready', skillCount: 1 })]);
  });
});

function capturedIndex(withDiagnostic: boolean) {
  return {
    profileIdsByCollection: new Map([['library:library', ['one', 'two', 'three']]]),
    diagnostics: withDiagnostic ? [{ profileId: 'raced-profile', diagnostic: { key: { kind: 'library' as const, id: '<unknown>' }, path: '.' } }] : [],
    identity: 'captured-once'
  };
}

async function setup() {
  const directory = await createTempDirectory('bazframe-reference-consumer-'); directories.push(directory);
  const home = directory.path('home'); await addProfile(home, 'focused'); await writeActiveProfile(home, 'focused');
  const library = await realpath(await directory.mkdir('library'));
  await directory.write('library/demo/SKILL.md', '---\nname: demo\ndescription: demo\n---\n');
  await addLibrary({ bazframeHome: home }, library);
  return { directory, home, environment: { ...process.env, BAZFRAME_HOME: home, PI_CODING_AGENT_DIR: directory.path('pi-agent'), NO_COLOR: '1' } };
}
