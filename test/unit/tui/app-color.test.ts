import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BazframeTuiService,
  DashboardSnapshot
} from '../../../src/application/tui-service.js';

const originalForceColor = process.env.FORCE_COLOR;
const originalNoColor = process.env.NO_COLOR;

afterEach(() => {
  restoreEnvironment('FORCE_COLOR', originalForceColor);
  restoreEnvironment('NO_COLOR', originalNoColor);
  vi.resetModules();
});

describe('TuiApp focus border color', () => {
  it('uses cyan for the focused section and keeps a bold NO_COLOR fallback', async () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    const colored = await renderIsolatedApp();
    await vi.waitFor(() => expect(colored.lastFrame()).toContain('Status: Ready'));
    expect(colored.lastFrame()).toContain('\u001B[36m');
    expect(colored.lastFrame()).toContain('┏');
    colored.cleanup();

    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    vi.resetModules();
    const noColor = await renderIsolatedApp();
    await vi.waitFor(() => expect(noColor.lastFrame()).toContain('Status: Ready'));
    expect(noColor.lastFrame()).not.toContain('\u001B[36m');
    expect(noColor.lastFrame()).toContain('┏');
    noColor.stdin.write('?');
    await vi.waitFor(() => expect(noColor.lastFrame()).toContain('Keyboard help'));
    expect(noColor.lastFrame()).not.toContain('\u001B[36m');
    expect(noColor.lastFrame()).toContain('┏');
    noColor.cleanup();
  });

  it('uses the focused cyan bold border for every input-owning overlay', async () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    const app = await renderIsolatedApp();
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Status: Ready'));
    app.stdin.write('2');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('* 2 Profiles'));

    const expectFocusedOverlay = (label: string) => {
      expect(app.lastFrame()).toContain(label);
      expect(app.lastFrame()).toContain('\u001B[36m');
      expect(app.lastFrame()).toContain('┏');
    };

    app.stdin.write('?');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Keyboard help'));
    expectFocusedOverlay('Keyboard help');
    app.stdin.write('\u001B');
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('Keyboard help'));

    for (const [key, label] of [
      ['c', 'Create profile'],
      ['D', 'Duplicate profile'],
      ['R', 'Rename profile']
    ] as const) {
      app.stdin.write(key);
      await vi.waitFor(() => expect(app.lastFrame()).toContain(label));
      expectFocusedOverlay(label);
      app.stdin.write('\u001B');
      await vi.waitFor(() => expect(app.lastFrame()).not.toContain(label));
    }

    vi.mocked(app.service.removeProfile).mockRejectedValueOnce(new app.BazframeError(
      'PROFILE_NOT_EMPTY',
      'Profile is not empty.'
    ));
    app.stdin.write('d');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('confirm generated-empty removal'));
    expectFocusedOverlay('confirm generated-empty removal');
    app.stdin.write('y');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Type exact profile ID'));
    expectFocusedOverlay('Type exact profile ID');
    app.cleanup();
  });
});

async function renderIsolatedApp() {
  const [{ createElement }, testing, { TuiApp }, { BazframeError }] = await Promise.all([
    import('react'),
    import('ink-testing-library'),
    import('../../../src/tui/app.js'),
    import('../../../src/core/errors.js')
  ]);
  const service = {
    loadDashboard: vi.fn(async () => dashboard()),
    createProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    useProfile: vi.fn(),
    renameProfile: vi.fn(),
    removeProfile: vi.fn(),
    addMembership: vi.fn(),
    removeMembership: vi.fn(),
    loadSkillPreview: vi.fn(async ({ sourceId, skillId }) => ({
      sourceId, skillId, path: `/skills/${skillId}/SKILL.md`, contents: `# ${skillId}\n`
    })),
    browseDirectories: vi.fn(async (input) => ({ input, resolvedPath: '/tmp', selectablePath: '/tmp', entries: [] })),
    inspectSourceCandidate: vi.fn(async ({ root }) => ({
      sourceId: root.split('/').filter(Boolean).at(-1) ?? 'source', enteredRoot: root, canonicalRoot: root, manifest: { state: 'absent' as const }
    })),
    addSource: vi.fn(async ({ root }) => ({
      schemaVersion: 1 as const, source: root.split('/').filter(Boolean).at(-1) ?? 'source', root,
      digest: 'a'.repeat(64), sourceUnitRoot: '.', action: 'added' as const, path: '/sources/source.json'
    }))
  } satisfies BazframeTuiService;
  const view = testing.render(createElement(TuiApp, {
    service,
    dimensions: { columns: 60, rows: 16 }
  }));
  return { ...view, service, BazframeError, cleanup: testing.cleanup };
}

function dashboard(): DashboardSnapshot {
  return {
    revision: 1,
    activeProfileId: 'focused',
    profiles: [{
      id: 'focused',
      directory: '/profiles/focused',
      instructionsPath: '/profiles/focused/AGENTS.md',
      removalIdentity: {
        schemaVersion: 1,
        directory: { device: '1', inode: '1' },
        fingerprint: 'focused'
      },
      active: true,
      membershipWritable: true,
      memberships: []
    }],
    sources: [],
    status: {
      state: 'unavailable',
      diagnostic: { id: 'status', severity: 'error', message: 'Unavailable.' }
    },
    diagnostics: []
  };
}

function restoreEnvironment(key: 'FORCE_COLOR' | 'NO_COLOR', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
