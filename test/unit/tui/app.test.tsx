import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import type {
  BazframeTuiService,
  DashboardSnapshot,
  LibraryCandidateSummary,
  LibraryInputInspection
} from '../../../src/application/tui-service.js';
import { BazframeError } from '../../../src/core/errors.js';
import type { ProfileRemovalIdentity } from '../../../src/profiles/profile-removal-identity.js';
import { collectionAccessibilityLabel, TuiApp } from '../../../src/tui/app.js';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('TuiApp', () => {
  it('starts on Skills and navigates the management shell tabs', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);

    await waitForDashboard(view);
    expect(view.lastFrame()).toContain('* 1 Skills');
    expect(view.lastFrame()).toContain('demo-skill');
    expect(view.lastFrame()).toContain('Provider-owned');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('demo-skill'));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('demo-skill'));

    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
    expect(view.lastFrame()).toContain('* 2 Profiles');
    expect(view.lastFrame()).toMatch(/focused\s+0/u);
    expect(view.lastFrame()).not.toContain('0 skills');
    expect(view.lastFrame()).toContain('c create');

    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
    expect(view.lastFrame()).toContain('demo-skill');
    expect(view.lastFrame()).toContain('Provider-owned');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('demo-skill'));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('demo-skill'));

    view.stdin.write('3');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Pi (read-only)'));
    expect(view.lastFrame()).toContain('State: current');
    view.stdin.write('4');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Policy and current directory'));
    expect(view.lastFrame()).toContain('Effective behavior: enabled (global-enabled)');
    expect(view.lastFrame()).toContain('Attention needed');
    expect(view.lastFrame()).toContain('(none)');
    expect(view.lastFrame()).toContain('Settings are read-only');

    view.stdin.write('?');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Tab/Shift+Tab cycle focus'));
    expect(view.lastFrame()).toContain('1/2/3/4');
    expect(view.lastFrame()).toContain('Left/Right or h/l moves focus');
  });

  it('shows adapter state independently when setup status is unavailable', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const diagnostic = {
      id: 'setup-status',
      severity: 'error' as const,
      message: 'Could not find Git on PATH.'
    };
    dashboard.status = { state: 'unavailable', diagnostic };
    dashboard.adapterStatus = {
      state: 'available',
      value: {
        adapter: dashboard.adapterStatus.state === 'available'
          ? dashboard.adapterStatus.value.adapter
          : { state: 'current', targetPath: '/pi-agent/extensions/bazframe.ts' },
        correctiveActions: [],
        setupDiagnostic: diagnostic
      }
    };
    dashboard.diagnostics = [diagnostic];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('demo-skill'));
    view.stdin.write('3');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Pi (read-only)'));
    expect(view.lastFrame()).toContain('State: current');
    expect(view.lastFrame()).toContain('Setup status unavailable; adapter state shown independently.');
    expect(view.lastFrame()).not.toContain('Adapter status unavailable');

    view.stdin.write('4');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Setup status unavailable: Could not find Git on PATH.'));
  });

  it('keeps profile counts bare visually and descriptive for screen readers', async () => {
    const service = fakeService();
    const visual = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(visual.lastFrame()).toContain('Skills'));
    visual.stdin.write('2');
    await vi.waitFor(() => expect(visual.lastFrame()).toContain('focused'));
    expect(visual.lastFrame()).toMatch(/focused\s+0/u);
    expect(visual.lastFrame()).not.toContain('0 skills');
    visual.unmount();

    vi.stubEnv('INK_SCREEN_READER', 'true');
    const accessible = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(accessible.lastFrame()).toContain('Skills'));
    accessible.stdin.write('2');
    await vi.waitFor(() => expect(accessible.lastFrame()).toContain(
      'Profile focused, current, active selection, 0 skills'
    ));
  });

  it('renders create first with responsive alignment and honest current/favorite markers', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.profiles[0]!.favorite = true;
    dashboard.profiles.push({
      ...dashboard.profiles[0]!,
      id: 'reviewer',
      directory: '/home/profiles/reviewer',
      instructionsPath: '/home/profiles/reviewer/AGENTS.md',
      removalIdentity: removalIdentity('reviewer'),
      active: false,
      favorite: true
    });
    vi.mocked(service.loadDashboard).mockClear();

    const compact = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await openProfiles(compact);
    const compactLines = compact.lastFrame()!.split('\n');
    const compactHeading = compactLines.findIndex((line) => line.includes('┃ Profiles'));
    expect(compactLines[compactHeading + 1]).toContain('┃ + Create New Profile');
    expect(compact.lastFrame()).toContain('▶ focused');
    expect(compact.lastFrame()).toContain('★ reviewer');
    expect(compact.lastFrame()).not.toContain('★ focused');
    compact.unmount();

    const preferred = render(<TuiApp service={service} dimensions={{ columns: 100, rows: 24 }} />);
    await openProfiles(preferred);
    const preferredLines = preferred.lastFrame()!.split('\n');
    const preferredHeading = preferredLines.findIndex((line) => line.includes('┃ Profiles'));
    const createLine = preferredLines[preferredHeading + 1]!;
    expect(createLine).toContain('+ Create New Profile');
    expect(createLine.indexOf('+')).toBeGreaterThan(10);
    preferred.unmount();

    vi.stubEnv('INK_SCREEN_READER', 'true');
    const accessible = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(accessible.lastFrame()).toContain('Skills tab'));
    accessible.stdin.write('2');
    await vi.waitFor(() => expect(accessible.lastFrame()).toContain(
      'Profile focused, current, favorite, active selection'
    ));
    expect(accessible.lastFrame()).toContain('Profile reviewer, favorite');
  });

  it('toggles favorites with lowercase f while lowercase d cannot delete', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await openProfiles(view);

    view.stdin.write('d');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.removeProfile).not.toHaveBeenCalled();
    expect(view.lastFrame()).not.toContain('confirm generated-empty removal');

    view.stdin.write('f');
    await vi.waitFor(() => expect(service.toggleProfileFavorite).toHaveBeenCalledWith('focused'));
    expect(service.removeProfile).not.toHaveBeenCalled();
  });

  it('uses uppercase H/L as modal-safe lateral route aliases', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ Create New Profile'));

    view.stdin.write('L');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('<- Profiles /'));
    view.stdin.write('H');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ Create New Profile'));

    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Added Skills'));
    view.stdin.write('L');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Added Skills'));
    view.stdin.write('L');
    view.stdin.write('\u001B[B');
    view.stdin.write('L');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('<- Skills / demo-skill'));
    view.stdin.write('H');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));

    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Absolute path, ~/ path, or managed Git'));
    view.stdin.write('H');
    view.stdin.write('L');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Source: HL'));
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 16 }
  ])('uses natural horizontal Skills preview navigation at $columns x $rows', async (dimensions) => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={dimensions} />);
    await waitForDashboard(view);

    // The expanded source keeps its tree meaning: l/Right selects its first child.
    view.stdin.write('l');
    await vi.waitFor(() => expect(service.loadSkillPreview).toHaveBeenCalledWith({
      originId: 'default', skillId: 'demo-skill'
    }));
    expect(view.lastFrame()).toContain('Enter/L object details');
    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Left/h back'));
    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Enter/L object details'));

    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Left/h back'));
    view.stdin.write('\u001B[D');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Enter/L object details'));
  });

  it('preserves object-node Left/h and Right/l expansion and parent semantics', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);

    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Added Skills'));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Added Skills'));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(service.loadSkillPreview).toHaveBeenCalledWith({
      originId: 'default', skillId: 'demo-skill'
    }));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Left/h back'));
    view.stdin.write('\u001B[D');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Enter/L object details'));
    view.stdin.write('h');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Added Skills'));
    expect(view.lastFrame()).not.toContain('Left/h back');
  });

  it('shows and suppresses the preferred Skills parent hierarchy as focus moves', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    view.stdin.write('\u001B[B');
    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Left/h back'));

    const parentLine = view.lastFrame()!.split('\n').find((line) => line.includes('┃ Skills'));
    expect(parentLine).toBeDefined();
    expect(parentLine).toMatch(/^┃/u);
    expect(parentLine!.split('┃').length - 1).toBeGreaterThanOrEqual(3);

    view.stdin.write('\t');
    await vi.waitFor(() => {
      const inactiveLine = view.lastFrame()!.split('\n').find((line) => line.includes('| Skills'));
      expect(inactiveLine).toMatch(/^\|/u);
    });
    view.stdin.write('\u001B[Z');
    await vi.waitFor(() => {
      const restoredLine = view.lastFrame()!.split('\n').find((line) => line.includes('┃ Skills'));
      expect(restoredLine).toMatch(/^┃/u);
    });
    expect(view.lastFrame()).toContain('Left/h back');
  });

  it('announces active, parent, inactive, and restored Skills hierarchy consistently', async () => {
    vi.stubEnv('INK_SCREEN_READER', 'true');
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain(
      'Skill demo-skill, Added Skills, active selection'
    ));

    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills browser, parent context'));
    expect(view.lastFrame()).toContain('Skill demo-skill, Added Skills, parent selection');
    expect(view.lastFrame()).toContain('Skills / demo-skill, active and focused');

    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('Skills browser, parent context'));
    expect(view.lastFrame()).not.toContain('Skill demo-skill, Added Skills, parent selection');
    expect(view.lastFrame()).not.toContain('Skill demo-skill, Added Skills, active selection');
    expect(view.lastFrame()).not.toContain('Skills / demo-skill, active and focused');

    view.stdin.write('\u001B[Z');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills browser, parent context'));
    expect(view.lastFrame()).toContain('Skill demo-skill, Added Skills, parent selection');
    expect(view.lastFrame()).toContain('Skills / demo-skill, active and focused');
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 16 }
  ])('uses natural horizontal Profile detail navigation at $columns x $rows', async (dimensions) => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={dimensions} />);
    await waitForDashboard(view);
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Right/l/Enter/L edit'));

    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Left/h/H/Esc/Backspace'));
    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Right/l/Enter/L edit'));

    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Left/h/H/Esc/Backspace'));
    view.stdin.write('\u001B[D');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Right/l/Enter/L edit'));

    view.stdin.write('\u001B[A');
    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Create profile'));
    view.stdin.write('\u001B');
    view.unmount();
  });

  it('unwinds Available child and group hierarchy before backing out of Profile detail', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Right/l/Enter/L edit'));
    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Left/h/H/Esc/Backspace'));
    view.stdin.write('J');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Available skills'));

    // Expanded source -> first child, then child -> source, source -> collapsed, collapsed -> list.
    view.stdin.write('l');
    view.stdin.write('h');
    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] (default)'));
    expect(view.lastFrame()).toContain('Left/h/H/Esc/Backspace');
    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Right/l/Enter/L edit'));

    // From Included there is no deeper lateral action.
    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Left/h/H/Esc/Backspace'));
    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Right/l/Enter/L edit'));
  });

  it('shows, suppresses, and restores the preferred Profiles parent hierarchy', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Right/l/Enter/L edit'));
    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Left/h/H/Esc/Backspace'));

    const parentLine = view.lastFrame()!.split('\n').find((line) => line.includes('┃ Profiles'));
    expect(parentLine).toBeDefined();
    expect(view.lastFrame()).toContain('▶ focused');
    expect(view.lastFrame()).toContain('┃Included skills');

    view.stdin.write('\u001B[Z');
    await vi.waitFor(() => {
      const inactiveLine = view.lastFrame()!.split('\n').find((line) => line.includes('| Profiles'));
      expect(inactiveLine).toBeDefined();
      expect(view.lastFrame()).toContain('▶ focused');
    });
    expect(view.lastFrame()).not.toContain('┃Included skills');
    expect(view.lastFrame()).not.toContain('┃Available skills');

    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃ Profiles'));
    expect(view.lastFrame()).toContain('▶ focused');
    expect(view.lastFrame()).toContain('┃Included skills');
  });

  it('announces only focused Profile selections and suppresses parent/detail suffixes at top tabs', async () => {
    vi.stubEnv('INK_SCREEN_READER', 'true');
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.profiles[0]!.memberships = [{
      id: 'default:included-skill',
      membershipId: 'focused:included-skill',
      originId: 'default',
      skillId: 'included-skill',
      path: '/home/profiles/focused/skills/included-skill',
      target: '/provider/included-skill',
      kind: 'managed',
      manageable: true
    }];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain(
      'Profile focused, current, active selection, 1 skills'
    ));
    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Profiles list, parent context'));
    expect(view.lastFrame()).toContain('Profile focused, current, parent selection, 1 skills');
    expect(view.lastFrame()).toContain('included-skill, managed, active selection');
    expect(view.lastFrame()).not.toContain('Available group (default), expanded, active selection');

    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain(
      'Available skill demo-skill, origin default, active selection'
    ));
    expect(view.lastFrame()).not.toContain('included-skill, managed, active selection');

    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('Profiles list, parent context'));
    expect(view.lastFrame()).not.toContain('Profile focused, current, parent selection');
    expect(view.lastFrame()).not.toContain('included-skill, managed, active selection');
    expect(view.lastFrame()).not.toContain('Available skill demo-skill, origin default, active selection');
    expect(view.lastFrame()).toContain('Profile focused, current, editor');

    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Profiles list, parent context'));
    expect(view.lastFrame()).toContain('Profile focused, current, parent selection, 1 skills');
    expect(view.lastFrame()).toContain('included-skill, managed, active selection');
  });

  it('opens the selected inactive profile editor once, refreshes, and preserves the route', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.profiles.push({
      id: 'reviewer',
      directory: '/home/profiles/reviewer',
      instructionsPath: '/home/profiles/reviewer/AGENTS.md',
      removalIdentity: removalIdentity('reviewer'),
      active: false,
      favorite: false,
      membershipWritable: true,
      memberships: []
    });
    vi.mocked(service.loadDashboard).mockClear();
    let release!: (value: { exitCode: number; signal: null }) => void;
    vi.mocked(service.editProfileInstructions).mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('reviewer'));
    view.stdin.write('\u001B[B');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Profiles / reviewer'));

    view.stdin.write('e');
    view.stdin.write('e');
    await vi.waitFor(() => expect(service.editProfileInstructions).toHaveBeenCalledTimes(1));
    expect(service.editProfileInstructions).toHaveBeenCalledWith('reviewer');
    release({ exitCode: 0, signal: null });
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Editor exited successfully'));
    expect(view.lastFrame()).toContain('Profiles / reviewer');
    expect(view.lastFrame()).toContain('Run `/bazframe reloa');
    expect(service.loadDashboard).toHaveBeenCalledTimes(2);
  });

  it('opens a live default SKILL.md editor from preferred and compact previews, single-flight, then refreshes', async () => {
    for (const dimensions of [
      { columns: 80, rows: 24 },
      { columns: 60, rows: 16 }
    ]) {
      const service = fakeService();
      let release!: (value: { exitCode: number; signal: null }) => void;
      vi.mocked(service.editSkillDefinition).mockImplementation(() => new Promise((resolve) => {
        release = resolve;
      }));
      const view = render(<TuiApp service={service} dimensions={dimensions} />);
      await waitForDashboard(view);
      view.stdin.write('\u001B[B');
      await vi.waitFor(() => expect(service.loadSkillPreview).toHaveBeenCalledWith({
        originId: 'default', skillId: 'demo-skill'
      }));
      if (dimensions.columns === 60) {
        await vi.waitFor(() => expect(view.lastFrame()).toContain('Enter/L object details'));
        expect(view.lastFrame()).not.toContain('e edit live skill');
        view.stdin.write('e');
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        expect(service.editSkillDefinition).not.toHaveBeenCalled();
        view.stdin.write('\r');
      }
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills / demo-skill'));

      view.stdin.write('e');
      view.stdin.write('e');
      await vi.waitFor(() => expect(service.editSkillDefinition).toHaveBeenCalledTimes(1));
      expect(service.editSkillDefinition).toHaveBeenCalledWith({
        originId: 'default', skillId: 'demo-skill'
      });
      release({ exitCode: 0, signal: null });
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Editor exited successfully'));
      expect(view.lastFrame()).toContain('Skills / demo-skill');
      expect(service.loadDashboard).toHaveBeenCalledTimes(2);
      view.unmount();
    }
  });

  it('reconciles away from a skill preview when an edit makes the skill unavailable', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);
    view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(service.loadSkillPreview).toHaveBeenCalledWith({
      originId: 'default', skillId: 'demo-skill'
    }));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('<- Skills / demo-skill'));
    vi.mocked(service.editSkillDefinition).mockImplementation(async () => {
      dashboard.skillGroups![0]!.skills = [];
      return { exitCode: 0, signal: null };
    });
    view.stdin.write('e');
    await vi.waitFor(() => expect(service.loadDashboard).toHaveBeenCalledTimes(2));
    expect(view.lastFrame()).toContain('Skills');
    expect(view.lastFrame()).not.toContain('<- Skills / demo-skill');
  });

  it('refuses managed snapshot editing with rebuild guidance in preferred and compact previews', async () => {
    for (const dimensions of [
      { columns: 80, rows: 24 },
      { columns: 60, rows: 16 }
    ]) {
      const service = fakeService();
      const dashboard = await service.loadDashboard();
      dashboard.skillGroups = [{
        id: 'library:bundle',
        label: 'bundle',
        root: '/snapshots/bundle',
        artifactWritesSupported: false,
        skills: [{
          id: 'managed-skill',
          originId: 'library:bundle',
          directory: '/snapshots/bundle/managed-skill'
        }]
      }];
      dashboard.collections = [{
        key: 'library:bundle', kind: 'library', id: 'bundle', root: '/provider/bundle',
        digest: 'a'.repeat(64), skillsRoot: '.', refreshAvailability: 'available',
        skillCount: 1, referenceCount: 0, health: 'ready', diagnostics: []
      }];
      vi.mocked(service.loadDashboard).mockClear();
      const view = render(<TuiApp service={service} dimensions={dimensions} />);
      await waitForDashboard(view);
      view.stdin.write('\u001B[C');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Library bundle'));
      view.stdin.write('\u001B[B');
      await vi.waitFor(() => expect(service.loadSkillPreview).toHaveBeenCalledWith({
        originId: 'library:bundle', skillId: 'managed-skill'
      }));
      if (dimensions.columns === 60) view.stdin.write('\r');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills / managed-skill'));
      view.stdin.write('e');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('bazframe libraries'));
      expect(service.editSkillDefinition).not.toHaveBeenCalled();
      expect(service.loadDashboard).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('keeps the TUI open and refreshes after editor exit and launch failures', async () => {
    for (const outcome of [
      { kind: 'result' as const, value: { exitCode: 7, signal: null } },
      { kind: 'result' as const, value: { exitCode: null, signal: 'SIGTERM' as const } },
      { kind: 'error' as const, value: new BazframeError('EDITOR_LAUNCH_FAILED', 'editor missing') }
    ]) {
      const service = fakeService();
      if (outcome.kind === 'error') vi.mocked(service.editProfileInstructions).mockRejectedValue(outcome.value);
      else vi.mocked(service.editProfileInstructions).mockResolvedValue(outcome.value);
      const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
      await waitForDashboard(view);
      view.stdin.write('2');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
      view.stdin.write('\r');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Profiles / ▶ focused'));
      view.stdin.write('e');
      await vi.waitFor(() => expect(service.loadDashboard).toHaveBeenCalledTimes(2));
      const expected = outcome.kind === 'error'
        ? 'editor missing'
        : outcome.value.signal === 'SIGTERM'
          ? 'Editor terminated by SIGTERM'
          : 'Editor exited with status 7';
      expect(view.lastFrame()).toContain(expected);
      expect(view.lastFrame()).toContain('Profiles / ▶ focused');
      view.unmount();
    }
  });

  it('makes uppercase L mirror Enter while top tabs own focus without entering a detail route', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ Create New Profile'));

    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    view.stdin.write('L');
    expect(view.lastFrame()).toContain('+ Create New Profile');
    expect(view.lastFrame()).not.toContain('<- Profiles /');
    const afterUppercaseL = view.lastFrame();
    view.stdin.write('\r');
    expect(view.lastFrame()).toBe(afterUppercaseL);

    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Skills'));
    view.stdin.write('L');
    expect(view.lastFrame()).toContain('[-] Added Skills');
    expect(view.lastFrame()).not.toContain('<- Skills /');
  });

  it('fills the preferred 46% Skills master column at 80x24', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    const titleLine = view.lastFrame()!.split('\n').find((line) => line.includes('┃ Skills'));
    expect(titleLine).toBeDefined();
    expect([...titleLine!.matchAll(/┃/gu)].map((match) => match.index)).toEqual([0, 36]);
    const detailLine = view.lastFrame()!.split('\n').find((line) => line.includes('Provider-owned'));
    expect(detailLine).toBeDefined();
    expect(detailLine!.indexOf('Provider-owned')).toBeGreaterThanOrEqual(37);
    assertFrameBounds(view.lastFrame(), 80, 24);
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 160, rows: 40 }
  ])('fills the preferred Profiles master column at $columns x $rows', async ({ columns, rows }) => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns, rows }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Profiles /'));
    const titleLine = view.lastFrame()!.split('\n')
      .find((line) => line.startsWith('┃') && line.includes('Profiles'));
    expect(titleLine).toBeDefined();
    const borders = [...titleLine!.matchAll(/┃/gu)].map((match) => match.index!);
    expect(borders[0]).toBe(0);
    expect(borders[1]).toBeGreaterThanOrEqual(Math.floor(columns * 0.36) - 2);
    expect(borders[1]).toBeLessThanOrEqual(Math.ceil(columns * 0.36));
    assertFrameBounds(view.lastFrame(), columns, rows);
  });

  it.each(['ready', 'failed'] as const)('keeps a %s managed mtg-deckbuilding source reachable', async (health) => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const defaultSource = dashboard.skillGroups![0]!;
    dashboard.availableSkillGroups = [defaultSource];
    dashboard.skillGroups = health === 'ready'
      ? [defaultSource, {
          id: 'library:mtg-deckbuilding',
          label: 'mtg-deckbuilding',
          root: '/snapshots/mtg/collection',
          artifactWritesSupported: false,
          skills: [{
            id: 'deck-building',
            originId: 'library:mtg-deckbuilding',
            directory: '/snapshots/mtg/collection/deck-building'
          }]
        }]
      : [defaultSource];
    dashboard.collections = [{
      key: 'library:mtg-deckbuilding', kind: 'library', id: 'mtg-deckbuilding',
      root: '/fixtures/mtg-deckbuilding',
      digest: 'a'.repeat(64),
      skillsRoot: 'collection',
      refreshAvailability: 'available', skillCount: 1,
      referenceCount: 0,
      health,
      diagnostics: health === 'ready' ? [] : ['snapshot unavailable']
    }];
    vi.mocked(service.loadDashboard).mockClear();

    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('mtg-deckbuilding'));
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Profile references: 0'));
    expect(view.lastFrame()).toContain(health === 'ready' ? 'Health: ready' : 'Health: failed');
    assertFrameBounds(view.lastFrame(), 80, 24);
  });

  it('keeps Available expansion independent from the top-level Skills browser', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Added Skills'));
    view.stdin.write('2');
    view.stdin.write('L');
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] (default)'));
    expect(view.lastFrame()).toContain('demo-skill');
  });

  it('shows an honest profile loading state before the first dashboard resolves', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    let resolveDashboard!: (value: DashboardSnapshot) => void;
    service.loadDashboard = vi.fn(() => new Promise<DashboardSnapshot>((resolve) => {
      resolveDashboard = resolve;
    }));
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Loading skills...'));
    expect(view.lastFrame()).not.toContain('(default)');
    resolveDashboard(dashboard);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
  });

  it('shows a failed dashboard state and retries the initial load with r', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    vi.mocked(service.loadDashboard)
      .mockReset()
      .mockRejectedValueOnce(new Error('dashboard exploded'))
      .mockResolvedValue(dashboard);
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Dashboard unavailable'));
    expect(view.lastFrame()).toContain('Failed to load: dashboard exploded');
    expect(view.lastFrame()).toContain('Press r to retry.');
    expect(view.lastFrame()).not.toContain('Loading skills...');
    view.stdin.write('r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
    expect(service.loadDashboard).toHaveBeenCalledTimes(2);
  });

  it('preserves the prior dashboard snapshot when refresh fails', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    vi.mocked(service.loadDashboard)
      .mockReset()
      .mockResolvedValueOnce(dashboard)
      .mockRejectedValueOnce(new Error('refresh failed'));
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
    view.stdin.write('r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Error: refresh failed'));
    expect(view.lastFrame()).toContain('Skills');
    expect(view.lastFrame()).not.toContain('Dashboard unavailable');
  });

  it('previews SKILL.md in compact mode, neutralizes controls, and supports parent-aware o/c', async () => {
    const service = fakeService();
    service.loadSkillPreview = vi.fn(async ({ originId, skillId }) => ({
      originId,
      skillId,
      path: `/library/skills/${skillId}/SKILL.md`,
      contents: `Preview body \u001B[2J\nsecond line\n`
    }));
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('demo-skill'));

    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('  demo-skill'));
    view.stdin.write('o');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('  demo-skill'));
    view.stdin.write('\u001B[B');
    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('  demo-skill'));
    view.stdin.write('o');
    view.stdin.write('\u001B[B');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Preview body \\x1b[2J'));
    expect(view.lastFrame()).toContain('<- Skills / demo-skill');
    view.stdin.write('\x7f');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
  });

  it('focuses the preferred preview, reaches its final line, clamps on resize, and reloads on dashboard revision', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    let revision = 0;
    vi.mocked(service.loadDashboard).mockImplementation(async () => ({
      ...dashboard,
      revision: ++revision
    }));
    const longPreview = Array.from({ length: 40 }, (_, index) =>
      `line-${String(index + 1).padStart(2, '0')}`).join('\n');
    vi.mocked(service.loadSkillPreview)
      .mockResolvedValueOnce({
        originId: 'default', skillId: 'demo-skill', path: '/library/skills/demo-skill/SKILL.md', contents: longPreview
      })
      .mockResolvedValue({
        originId: 'default', skillId: 'demo-skill', path: '/library/skills/demo-skill/SKILL.md', contents: `refreshed-preview\n${longPreview}`
      });
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('  demo-skill'));
    expect(view.lastFrame()!.split('\n').some((line) => /^┏.*\+/u.test(line))).toBe(true);
    view.stdin.write('\u001B[B');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills / demo-skill'));
    expect(view.lastFrame()!.split('\n').some((line) => /^┏.*┏/u.test(line))).toBe(true);

    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('line-40'));
    view.rerender(<TuiApp service={service} dimensions={{ columns: 80, rows: 30 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('line-25'));
    expect(view.lastFrame()).toContain('line-40');
    view.stdin.write('\u001B[H');
    view.stdin.write('\u001B[6~');
    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('line-40'));

    view.stdin.write('r');
    await vi.waitFor(() => expect(service.loadSkillPreview).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('refreshed-preview'));
    view.stdin.write('\x1b');
    await vi.waitFor(() => expect(view.lastFrame()!.split('\n').some((line) => /^┏.*\+/u.test(line))).toBe(true));
  });

  it('adds only the reviewed manifest-free candidate after explicit literal-y consent', async () => {
    const service = fakeService();
    vi.mocked(service.inspectLibraryCandidate).mockResolvedValue({
      kind: 'directory', libraryId: 'tmp', enteredRoot: '/tmp', canonicalRoot: '/physical/tmp', packageManifest: { state: 'absent' }
    });
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Absolute path, ~/ path, or managed Git'));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Current: /tmp'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Add library tmp'));
    expect(view.lastFrame()).toContain('Entered library root: /tmp');
    expect(view.lastFrame()).toContain('Canonical library root: /physical/tmp');
    expect(service.addLibrary).not.toHaveBeenCalled();
    view.stdin.write('\r');
    expect(service.addLibrary).not.toHaveBeenCalled();
    view.stdin.write('y');
    await vi.waitFor(() => expect(service.addLibrary).toHaveBeenCalledWith({ source: '/physical/tmp' }));
  });

  it('reviews and adds a managed Git library source after literal-y consent', async () => {
    const service = fakeService();
    const source = 'git:sram1337/personal-agent-network';
    vi.mocked(service.inspectLibraryInput).mockImplementation(async (input) => input === source
      ? {
          kind: 'managed-git', input, libraryId: 'personal-agent-network',
          remote: 'github.com/sram1337/personal-agent-network'
        }
      : {
          kind: 'directory', input,
          browser: { input, resolvedPath: '/tmp', selectablePath: '/tmp', entries: [] }
        });
    vi.mocked(service.inspectLibraryCandidate).mockResolvedValue({
      kind: 'managed-git', libraryId: 'personal-agent-network', enteredSource: source,
      remote: 'github.com/sram1337/personal-agent-network'
    });
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);

    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Absolute path'));
    view.stdin.write(source);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Managed Git library: personal-agent-network'));
    expect(view.lastFrame()).toContain('Remote: github.com/sram1337/personal-agent-network');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`Managed Git source: ${source}`));
    expect(view.lastFrame()).toContain('Network access may use configured Git or GitHub authentication.');
    expect(service.addLibrary).not.toHaveBeenCalled();
    view.stdin.write('y');

    await vi.waitFor(() => expect(service.addLibrary).toHaveBeenCalledWith({ source }));
  });

  it('renders a durable source error instead of an indefinite loading state', async () => {
    const service = fakeService();
    vi.mocked(service.inspectLibraryInput).mockRejectedValue(
      new BazframeError('MANAGED_GIT_SOURCE_INVALID', 'Managed Git source is invalid.')
    );
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);

    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain(
      'Source unavailable: Managed Git source is invalid.'
    ));
    expect(view.lastFrame()).not.toContain('Inspecting source...');
  });

  it('shows actionable library validation failures after library-add confirmation', async () => {
    const service = fakeService();
    const diagnostic = 'skilllib:myskill/SKILL.md pi-loader[0]: description is required';
    vi.mocked(service.inspectLibraryCandidate).mockResolvedValue({
      kind: 'directory', libraryId: 'skilllib', enteredRoot: '/skilllib',
      canonicalRoot: '/physical/skilllib',
      packageManifest: { state: 'absent' }
    });
    vi.mocked(service.addLibrary).mockRejectedValue(
      new BazframeError('SOURCE_CANDIDATE_INVALID', diagnostic)
    );
    const view = render(<TuiApp service={service} dimensions={{ columns: 120, rows: 24 }} />);
    await waitForDashboard(view);

    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Absolute path, ~/ path, or managed Git'));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Current: /tmp'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Add library skilllib'));
    view.stdin.write('y');

    await vi.waitFor(() => expect(view.lastFrame()).toContain(diagnostic));
    expect(view.lastFrame()).not.toContain('collection resolution failed');
    expect(service.addLibrary).toHaveBeenCalledWith({ source: '/physical/skilllib' });
  });

  it('drops stale directory and candidate completions after library input or navigation changes', async () => {
    const service = fakeService();
    let resolveInitialBrowse!: (value: LibraryInputInspection) => void;
    vi.mocked(service.inspectLibraryInput).mockImplementation((input) => input.length === 0
      ? new Promise<LibraryInputInspection>((resolve) => { resolveInitialBrowse = resolve; })
      : Promise.resolve({
          kind: 'directory', input,
          browser: { input, resolvedPath: `/new/${input}`, selectablePath: `/new/${input}`, entries: [] }
        }));
    let resolveCandidate!: (value: LibraryCandidateSummary) => void;
    vi.mocked(service.inspectLibraryCandidate).mockImplementation(() =>
      new Promise<LibraryCandidateSummary>((resolve) => { resolveCandidate = resolve; }));
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Inspecting source...'));
    view.stdin.write('x');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Current: /new/x'));
    resolveInitialBrowse({
      kind: 'directory', input: '',
      browser: { input: '', resolvedPath: '/stale', selectablePath: '/stale', entries: [] }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.lastFrame()).not.toContain('/stale');

    view.stdin.write('\r');
    await vi.waitFor(() => expect(service.inspectLibraryCandidate).toHaveBeenCalledTimes(1));
    view.stdin.write('\x1b');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
    resolveCandidate({ kind: 'directory', libraryId: 'x', enteredRoot: '/new/x', canonicalRoot: '/physical/new/x', packageManifest: { state: 'absent' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.lastFrame()).not.toContain('Canonical library root: /stale');
  });

  it('drops a stale directory error after the library path changes', async () => {
    const service = fakeService();
    let rejectInitialBrowse!: (error: Error) => void;
    vi.mocked(service.inspectLibraryInput).mockImplementation((input) => input.length === 0
      ? new Promise<LibraryInputInspection>((_resolve, reject) => { rejectInitialBrowse = reject; })
      : Promise.resolve({
          kind: 'directory', input,
          browser: { input, resolvedPath: `/new/${input}`, selectablePath: `/new/${input}`, entries: [] }
        }));
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Inspecting source...'));
    view.stdin.write('x');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Current: /new/x'));
    rejectInitialBrowse(new Error('obsolete browse failure'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.lastFrame()).not.toContain('obsolete browse failure');
  });

  it('generation-guards candidate inspection after edits and newer requests', async () => {
    const service = fakeService();
    const resolvers: Array<(value: LibraryCandidateSummary) => void> = [];
    vi.mocked(service.inspectLibraryCandidate).mockImplementation(() =>
      new Promise<LibraryCandidateSummary>((resolve) => { resolvers.push(resolve); }));
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Current: /tmp'));

    view.stdin.write('\r');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    view.stdin.write('z');
    resolvers[0]!({ kind: 'directory', libraryId: 'tmp', enteredRoot: '/tmp', canonicalRoot: '/stale-edit', packageManifest: { state: 'absent' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.lastFrame()).not.toContain('Add library tmp');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Current: /tmp'));
    view.stdin.write('\r');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[1]!({ kind: 'directory', libraryId: 'tmp', enteredRoot: '/tmp', canonicalRoot: '/stale-request', packageManifest: { state: 'absent' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.lastFrame()).not.toContain('Add library tmp');
    resolvers[2]!({ kind: 'directory', libraryId: 'tmp', enteredRoot: '/tmp', canonicalRoot: '/current', packageManifest: { state: 'absent' } });
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Canonical library root: /current'));
  });

  it('keeps every directory choice reachable in the four-row chooser viewport', async () => {
    const service = fakeService();
    const entries = Array.from({ length: 7 }, (_, index) => ({
      name: `choice-${index}`,
      path: `/tmp/choice-${index}`
    }));
    vi.mocked(service.inspectLibraryInput).mockImplementation(async (input) => ({
      kind: 'directory', input,
      browser: { input, resolvedPath: '/tmp', selectablePath: '/tmp', entries }
    }));
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('/tmp/choice-0'));
    for (let index = 0; index < 6; index += 1) view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('/tmp/choice-5'));
    expect(view.lastFrame()).not.toContain('/tmp/choice-0');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Source: /tmp/choice-5'));
  });

  it('keeps package-manifest library confirmation bounded and blocked below minimum', async () => {
    const service = fakeService();
    vi.mocked(service.inspectLibraryCandidate).mockResolvedValue({
      kind: 'directory', libraryId: 'tmp', enteredRoot: '/tmp', canonicalRoot: '/physical/tmp', packageManifest: { state: 'present' }
    });
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Current: /tmp'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Blocked:'));
    expect(view.lastFrame()).toContain('n/Esc/Backspace back');

    view.rerender(<TuiApp service={service} dimensions={{ columns: 59, rows: 15 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Add library'));
    expect(view.lastFrame()).toContain('Entered: /tmp');
    expect(view.lastFrame()).toContain('Canonical: /physical/tmp');
    expect(view.lastFrame()).toContain('Package manifest present; use `bazframe packages add`.');
    expect(view.lastFrame()).toContain('Final library authorization is disabled');
    view.stdin.write('y');
    expect(service.addLibrary).not.toHaveBeenCalled();
  });

  it('shows library-root input and back controls instead of profile fallback below minimum', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Absolute path'));
    view.rerender(<TuiApp service={service} dimensions={{ columns: 59, rows: 15 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Physical library root'));
    expect(view.lastFrame()).toContain('Enter next  Esc back/cancel');
    expect(view.lastFrame()).not.toContain('New profile ID');
  });

  it('renders read-only library objects and a multi-root expandable Skill hierarchy', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.collections = [{
      key: 'library:one', kind: 'library', id: 'one', root: '/provider', digest: 'a'.repeat(64),
      skillsRoot: '.', refreshAvailability: 'available', skillCount: 1, referenceCount: 1, health: 'ready', diagnostics: []
    }];
    const managedRoot = {
      id: 'library:one', label: 'one', root: '/snapshots/one', artifactWritesSupported: false as const,
      skills: [{ id: 'managed-skill', originId: 'library:one', directory: '/snapshots/one/managed-skill' }]
    };
    dashboard.skillGroups = [...(dashboard.skillGroups ?? []), managedRoot];
    dashboard.availableSkillGroups = dashboard.skillGroups ?? [];
    dashboard.profiles[0]!.libraryReferences = [{
      kind: 'library', id: 'one',
      path: '/profiles/focused/libraries/one.json',
      availability: 'unavailable',
      diagnostic: 'target missing'
    }];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} />);
    await waitForDashboard(view);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Library one'));
    expect(collectionAccessibilityLabel(dashboard.collections![0]!, true))
      .toBe('Library one, ready, 1 Skills, 1 profile references, digest sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, root /provider, selected');
    expect(collectionAccessibilityLabel({
      ...dashboard.collections![0]!,
      health: 'failed',
      referenceCount: 'unknown'
    }, false)).toBe('Library one, failed, 1 Skills, profile reference count unknown, digest sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, root /provider');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Added Skills'));
    expect(view.lastFrame()).toContain('[+] Library one');
    expect(view.lastFrame()).not.toContain('  managed-skill');
    view.stdin.write('\u001B[B');
    view.stdin.write('\u001B[B');
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Library one'));
    expect(view.lastFrame()).toContain('  managed-skill');
    view.stdin.write('2');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain(
      'Referenced Libraries: one [unavailable: target missing]'
    ));
    expect(view.lastFrame()).toContain('Referenced Packages: (none)');
  });

  it('keeps compact Skills selection visible without category rows during navigation, paging, End, and resize', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.skillGroups = [{
      id: 'default', label: '(default)', root: '/library/skills', artifactWritesSupported: false,
      skills: Array.from({ length: 5 }, (_, index) => ({
        id: `skill-${index + 1}`, originId: 'default', directory: `/library/skills/skill-${index + 1}`
      }))
    },
    { id: 'library:compact', label: 'Library: compact', root: '/snapshot/library', artifactWritesSupported: false, skills: [] },
    { id: 'package:compact', label: 'Package: compact', root: '/snapshot/package', artifactWritesSupported: false, skills: [] }];
    dashboard.collections = [
      { key: 'library:compact', kind: 'library', id: 'compact', root: '/provider/library', digest: 'a'.repeat(64), skillsRoot: '.', refreshAvailability: 'available', skillCount: 0, referenceCount: 0, health: 'ready', diagnostics: [] },
      { key: 'package:compact', kind: 'package', id: 'compact', root: '/provider/package', digest: 'b'.repeat(64), artifactRoot: 'dist', skillsRoot: 'skills', refreshAvailability: 'available', skillCount: 0, referenceCount: 0, health: 'ready', diagnostics: [] }
    ];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);
    for (let index = 0; index < 5; index += 1) view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('  skill-5'));
    view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Library compact'));
    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Package compact'));
    view.stdin.write('\u001B[5~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('  skill-1'));
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Package compact'));
    view.rerender(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    view.stdin.write('\u001B[H');
    for (let index = 0; index < 6; index += 1) view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Library: compact'));
    view.rerender(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Library compact'));
  });

  it('renders Added Skills and same-ID zero-Skill library/package peers without category headings', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.collections = [
      { key: 'library:toolkit', kind: 'library', id: 'toolkit', root: '/providers/library/toolkit', digest: 'a'.repeat(64), skillsRoot: '.', refreshAvailability: 'available', skillCount: 0, referenceCount: 2, health: 'ready', diagnostics: [] },
      { key: 'package:toolkit', kind: 'package', id: 'toolkit', root: '/providers/package/toolkit', digest: 'b'.repeat(64), artifactRoot: 'dist', skillsRoot: 'skills', refreshAvailability: 'available', skillCount: 0, referenceCount: 0, health: 'ready', diagnostics: [] }
    ];
    dashboard.skillGroups = [...(dashboard.skillGroups ?? []),
      { id: 'library:toolkit', label: 'Library: toolkit', root: '/snapshots/library', artifactWritesSupported: false, skills: [] },
      { id: 'package:toolkit', label: 'Package: toolkit', root: '/snapshots/package', artifactWritesSupported: false, skills: [] }
    ];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);
    const frame = view.lastFrame()!;
    expect(frame).toContain('[-] Added Skills — 1 Skills;');
    expect(frame).not.toContain('Libraries');
    expect(frame).not.toContain('Packages');
    expect(frame).toContain('[+] Library toolkit — ready; 0 Skills; 2 references;');
    view.stdin.write('\u001B[B');
    view.stdin.write('\u001B[B');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('<- Skills / Library: toolkit'));
    expect(view.lastFrame()).toContain('Health: ready; 0 Skills; references: 2');
    expect(view.lastFrame()).toContain('Provider input: /providers/library/toolkit');
    expect(view.lastFrame()).toContain('Activated digest: sha256:aaaaaaaa');
    expect(view.lastFrame()).toContain('Artifact root: .; Skills root: .');
    expect(view.lastFrame()).toContain('Update: available (CLI only)');
    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Library toolkit'));
    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Library toolkit'));
    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Library toolkit'));
    view.stdin.write('\u001B[B');
    view.stdin.write('L');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('<- Skills / Package: toolkit'));
    expect(view.lastFrame()).toContain('Health: ready; 0 Skills; references: 0');
    expect(view.lastFrame()).toContain('Provider input: /providers/package/toolkit');
    expect(view.lastFrame()).toContain('Activated digest: sha256:bbbbbbbb');
    expect(view.lastFrame()).toContain('Artifact root: dist; Skills root: skills');
    expect(view.lastFrame()).toContain('Build: available (CLI only)');
    for (const back of ['\u001B[D', 'h', 'H', '\u007f', '\u001B']) {
      view.stdin.write(back);
      await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Package toolkit'));
      view.stdin.write('L');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('<- Skills / Package: toolkit'));
    }
    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Package toolkit'));
    expect(collectionAccessibilityLabel(dashboard.collections[0]!, false)).toContain('Library toolkit, ready, 0 Skills, 2 profile references');
    expect(collectionAccessibilityLabel(dashboard.collections[1]!, false)).toContain('Package toolkit, ready, 0 Skills, 0 profile references');
  });

  it('treats a package with children as the same collapsible peer shape as a library', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.collections = [{
      key: 'package:suite', kind: 'package', id: 'suite', root: '/provider/suite',
      digest: 'c'.repeat(64), artifactRoot: 'dist', skillsRoot: 'skills',
      refreshAvailability: 'available', skillCount: 2, referenceCount: 0,
      health: 'ready', diagnostics: []
    }];
    dashboard.skillGroups = [...(dashboard.skillGroups ?? []), {
      id: 'package:suite', label: 'suite', root: '/snapshots/suite', artifactWritesSupported: false,
      skills: [
        { id: 'packaged-one', originId: 'package:suite', directory: '/snapshots/suite/packaged-one' },
        { id: 'packaged-two', originId: 'package:suite', directory: '/snapshots/suite/packaged-two' }
      ]
    }];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await waitForDashboard(view);

    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Package suite'));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Package suite'));
    expect(view.lastFrame()).toContain('packaged-one');
    expect(view.lastFrame()).toContain('packaged-two');

    view.stdin.write('\u001B[C');
    view.stdin.write('\u001B[D');
    expect(view.lastFrame()).toContain('packaged-one');
    view.stdin.write('\u001B[D');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('packaged-one'));

    view.stdin.write('o');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('packaged-one'));
    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('packaged-one'));
    view.stdin.write('L');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('<- Skills / Package: suite'));
    expect(view.lastFrame()).toContain('Artifact root: dist; Skills root: skills');
    view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('<- Skills / Package: suite'));
    view.stdin.write('h');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Package suite'));
  });

  it('shows added-Skill and library roots in Available while preserving mutation authority', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const directSource = dashboard.skillGroups![0]!;
    const managedRoot = {
      id: 'library:mtg-deckbuilding',
      label: 'mtg-deckbuilding',
      root: '/snapshots/mtg-deckbuilding',
      artifactWritesSupported: false as const,
      skills: [{
        id: 'deck-building',
        originId: 'library:mtg-deckbuilding',
        directory: '/snapshots/mtg-deckbuilding/deck-building'
      }]
    };
    dashboard.skillGroups = [directSource, managedRoot];
    dashboard.availableSkillGroups = [directSource];
    dashboard.collections = [{
      key: 'library:mtg-deckbuilding', kind: 'library', id: 'mtg-deckbuilding',
      root: '/provider/mtg-deckbuilding', digest: 'a'.repeat(64), skillsRoot: '.',
      refreshAvailability: 'available', skillCount: 1, referenceCount: 0, health: 'ready', diagnostics: []
    }];
    vi.mocked(service.loadDashboard).mockClear();

    const view = render(<TuiApp service={service} dimensions={{ columns: 160, rows: 30 }} />);
    await openProfiles(view);
    view.stdin.write('L');
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] (default)'));
    expect(view.lastFrame()).toContain('[+] mtg-deckbuilding');

    view.stdin.write('\u001B[B');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] mtg-deckbuilding'));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('deck-building'));
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain(
      'Attach the whole library with `bazframe profile libraries add mtg-deckbuilding --profile focused`.'
    ));
    expect(service.addMembership).not.toHaveBeenCalled();

    view.stdin.write('\u001B[H');
    view.stdin.write('\u001B[C');
    view.stdin.write('a');
    await vi.waitFor(() => expect(service.addMembership).toHaveBeenCalledWith('focused', {
      originId: 'default', skillId: 'demo-skill'
    }));
  });

  it('omits an already referenced library root from Available', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const directSource = dashboard.skillGroups![0]!;
    dashboard.skillGroups = [directSource, {
      id: 'library:mtg-deckbuilding', label: 'mtg-deckbuilding', root: '/snapshots/mtg',
      artifactWritesSupported: false,
      skills: [{
        id: 'deck-building', originId: 'library:mtg-deckbuilding',
        directory: '/snapshots/mtg/deck-building'
      }]
    }];
    dashboard.availableSkillGroups = [directSource];
    dashboard.collections = [{
      key: 'library:mtg-deckbuilding', kind: 'library', id: 'mtg-deckbuilding',
      root: '/provider/mtg-deckbuilding', digest: 'a'.repeat(64), skillsRoot: '.',
      refreshAvailability: 'available', skillCount: 1, referenceCount: 1, health: 'ready', diagnostics: []
    }];
    dashboard.profiles[0]!.libraryReferences = [{
      kind: 'library', id: 'mtg-deckbuilding',
      path: '/profiles/focused/libraries/mtg-deckbuilding.json', availability: 'available'
    }];
    vi.mocked(service.loadDashboard).mockClear();

    const view = render(<TuiApp service={service} dimensions={{ columns: 120, rows: 30 }} />);
    await openProfiles(view);
    view.stdin.write('L');
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] (default)'));
    expect(view.lastFrame()).toContain('Referenced Libraries: mtg-deckbuilding (read-only)');
    expect(view.lastFrame()).toContain('Referenced Packages: (none) (read-only)');
    expect(view.lastFrame()).not.toContain('[+] mtg-deckbuilding');
    expect(view.lastFrame()).not.toContain('deck-building');
  });

  it('keeps library objects visible in the combined Skills browser', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.collections = Array.from({ length: 13 }, (_, index) => {
      const source = `s${String(index).padStart(2, '0')}`;
      return {
        key: `library:${source}`, kind: 'library' as const, id: source, root: `/provider/${source}`,
        digest: String(index).padStart(64, '0'), skillsRoot: '.',
        refreshAvailability: 'available' as const, skillCount: 1, referenceCount: 0, health: 'ready' as const, diagnostics: []
      };
    });
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);

    view.stdin.write('1');
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('s12'));
    expect(view.lastFrame()).toContain('Health: ready');
    expect(view.lastFrame()).toContain('Activated digest: sha256:');
  });

  it('renders setup corrective actions without exposing settings writes', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    if (dashboard.status.state !== 'available' || dashboard.adapterStatus.state !== 'available') {
      throw new Error('Expected setup status fixture.');
    }
    dashboard.status.value.adapter.state = 'missing';
    dashboard.adapterStatus.value.adapter.state = 'missing';
    const correctiveActions = [{
      id: 'adapter' as const,
      message: 'Install or update the adapter with `bazframe adapter install pi`.'
    }];
    dashboard.status.value.correctiveActions = correctiveActions;
    dashboard.adapterStatus.value.correctiveActions = correctiveActions;
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} />);
    await waitForDashboard(view);

    view.stdin.write('3');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('State: missing'));
    expect(view.lastFrame()).toContain('bazframe adapter install pi');
    expect(view.lastFrame()).toContain('remain CLI-only');
  });

  it('creates a profile through a text modal and authoritative service refresh', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await openProfiles(view);

    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Create profile'));
    view.stdin.write('reviewer');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('reviewer'));
    view.stdin.write('\r');

    await vi.waitFor(() => expect(service.createProfile).toHaveBeenCalledWith('reviewer'));
    expect(service.loadDashboard).toHaveBeenCalledTimes(2);
  });

  it('is inert below the minimum terminal size except for exit and help', async () => {
    const service = fakeService();
    const onExitCode = vi.fn();
    const view = render(
      <TuiApp
        service={service}
        dimensions={{ columns: 59, rows: 15 }}
        onExitCode={onExitCode}
      />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Terminal too small'));

    view.stdin.write('c');
    view.stdin.write('3');
    expect(service.createProfile).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Terminal too small');

    view.stdin.write('q');
    await vi.waitFor(() => expect(onExitCode).toHaveBeenCalledWith(0));
  });

  it('shows bounded small-terminal help and returns to the inert fallback', async () => {
    const service = fakeService();
    const onExitCode = vi.fn();
    const view = render(
      <TuiApp
        service={service}
        dimensions={{ columns: 59, rows: 15 }}
        onExitCode={onExitCode}
      />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Press ? for help'));

    view.stdin.write('?');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('small-terminal help'));
    expect(view.lastFrame()).toContain('q exits when no dialog is open');
    expect(view.lastFrame()).toContain('Press Esc or Enter to close help');
    assertFrameBounds(view.lastFrame(), 59, 15);

    view.stdin.write('q');
    expect(onExitCode).not.toHaveBeenCalled();
    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Press ? for help'));
    expect(view.lastFrame()).not.toContain('small-terminal help');

    view.stdin.write('c');
    expect(service.createProfile).not.toHaveBeenCalled();
  });

  it('keeps an open text modal in control after resizing below minimum', async () => {
    const service = fakeService();
    const onExitCode = vi.fn();
    const view = render(
      <TuiApp
        service={service}
        dimensions={{ columns: 80, rows: 24 }}
        onExitCode={onExitCode}
      />
    );
    await openProfiles(view);
    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Create profile'));

    view.rerender(
      <TuiApp
        service={service}
        dimensions={{ columns: 59, rows: 15 }}
        onExitCode={onExitCode}
      />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Dialog remains active'));
    expect(view.lastFrame()).toContain('Create profile');
    expect(view.lastFrame()).toContain('Enter submit  Esc cancel');
    assertFrameBounds(view.lastFrame(), 59, 15);

    view.stdin.write('q');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Input: q'));
    expect(onExitCode).not.toHaveBeenCalled();
    expect(service.createProfile).not.toHaveBeenCalled();

    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Press ? for help'));
    expect(view.lastFrame()).not.toContain('Create profile');
  });

  it('keeps destructive y/n modal controls active after resizing below minimum', async () => {
    const service = fakeService();
    const onExitCode = vi.fn();
    const view = render(
      <TuiApp
        service={service}
        dimensions={{ columns: 80, rows: 24 }}
        onExitCode={onExitCode}
      />
    );
    await openProfiles(view);
    view.stdin.write('x');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('confirm generated-empty removal'));

    view.rerender(
      <TuiApp
        service={service}
        dimensions={{ columns: 59, rows: 15 }}
        onExitCode={onExitCode}
      />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('y confirm  n/Esc cancel'));
    expect(view.lastFrame()).toContain('generated-empty profile content only');
    expect(view.lastFrame()).toContain('not followed or deleted');
    assertFrameBounds(view.lastFrame(), 59, 15);

    view.stdin.write('q');
    expect(onExitCode).not.toHaveBeenCalled();
    view.stdin.write('n');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Press ? for help'));
    expect(service.removeProfile).not.toHaveBeenCalled();

    view.rerender(
      <TuiApp
        service={service}
        dimensions={{ columns: 80, rows: 24 }}
        onExitCode={onExitCode}
      />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Profiles /'));
    view.stdin.write('x');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('confirm generated-empty removal'));
    view.rerender(
      <TuiApp
        service={service}
        dimensions={{ columns: 59, rows: 15 }}
        onExitCode={onExitCode}
      />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('y confirm  n/Esc cancel'));
    view.stdin.write('y');

    await vi.waitFor(() => expect(service.removeProfile).toHaveBeenCalledWith(
      'focused',
      { kind: 'generated-empty' }
    ));
    expect(onExitCode).not.toHaveBeenCalled();
  });

  it('requires exact-ID authorization before translating recursive profile removal', async () => {
    const service = fakeService();
    vi.mocked(service.removeProfile).mockRejectedValueOnce(new BazframeError(
      'PROFILE_NOT_EMPTY',
      'Profile is not empty.'
    ));
    const view = render(<TuiApp service={service} />);
    await openProfiles(view);

    view.stdin.write('x');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('confirm generated-empty removal'));
    expect(view.lastFrame()).toContain('Physical profile path: /home/profiles/focused');
    expect(view.lastFrame()).toContain('Scope: Bazframe generated-empty profile content only.');
    expect(view.lastFrame()).toContain(
      'Preserved membership targets (not followed): (none detected)'
    );
    expect(service.removeProfile).not.toHaveBeenCalled();
    view.stdin.write('\r');
    expect(service.removeProfile).not.toHaveBeenCalled();
    view.stdin.write('y');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Type exact profile ID: focused'));
    expect(view.lastFrame()).toContain(
      'Scope: recursively deletes all Bazframe profile content.'
    );
    expect(view.lastFrame()).toContain(
      'Preserved membership targets (not followed): (none detected)'
    );
    view.stdin.write('focused');
    await vi.waitFor(() => {
      expect((view.lastFrame()?.match(/focused/gu) ?? []).length).toBeGreaterThanOrEqual(3);
    });
    view.stdin.write('\r');

    await vi.waitFor(() => expect(service.removeProfile).toHaveBeenCalledTimes(2));
    expect(service.removeProfile).toHaveBeenLastCalledWith('focused', {
      kind: 'recursive',
      confirmedProfileId: 'focused',
      removalIdentity: removalIdentity('focused')
    });
  });

  it('closes stale recursive confirmation and refreshes before another authorization', async () => {
    const service = fakeService();
    vi.mocked(service.removeProfile)
      .mockRejectedValueOnce(new BazframeError('PROFILE_NOT_EMPTY', 'Profile is not empty.'))
      .mockRejectedValueOnce(new BazframeError(
        'PROFILE_REMOVE_AUTHORIZATION_STALE',
        'Profile changed. Refresh and confirm again.'
      ));
    const view = render(<TuiApp service={service} />);
    await openProfiles(view);

    view.stdin.write('x');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('confirm generated-empty removal'));
    view.stdin.write('y');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Type exact profile ID: focused'));
    view.stdin.write('focused');
    await vi.waitFor(() => {
      expect((view.lastFrame()?.match(/focused/gu) ?? []).length).toBeGreaterThanOrEqual(3);
    });
    view.stdin.write('\r');

    await vi.waitFor(() => expect(service.removeProfile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.loadDashboard).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Profile changed. Refreshing'));
    expect(view.lastFrame()).not.toContain('Type exact profile ID: focused');
  });

  it.each([
    ['leading', ' focused'],
    ['trailing', 'focused ']
  ])('refuses %s whitespace in recursive-removal authorization', async (_position, authorization) => {
    const service = fakeService();
    vi.mocked(service.removeProfile).mockRejectedValueOnce(new BazframeError(
      'PROFILE_NOT_EMPTY',
      'Profile is not empty.'
    ));
    const view = render(<TuiApp service={service} />);
    await openProfiles(view);

    view.stdin.write('x');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('confirm generated-empty removal'));
    view.stdin.write('y');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Type exact profile ID: focused'));
    view.stdin.write(authorization);
    await vi.waitFor(() => {
      expect((view.lastFrame()?.match(/focused/gu) ?? []).length).toBeGreaterThanOrEqual(4);
    });
    view.stdin.write('\r');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('exactly to authorize'));
    expect(service.removeProfile).toHaveBeenCalledTimes(1);
  });

  it('keeps compact destructive-dialog controls visible with long unbroken details', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const longSegment = unicodeWidthPath();
    dashboard.profiles[0]!.directory = `/home/${longSegment}/focused`;
    dashboard.profiles[0]!.memberships = [
      {
        id: 'default:first',
        membershipId: 'focused:first',
        originId: 'default',
        skillId: 'first',
        path: `/home/${longSegment}/first`,
        target: `/external/${longSegment}/first`,
        kind: 'managed',
        manageable: true
      },
      {
        id: 'default:second',
        membershipId: 'focused:second',
        originId: 'default',
        skillId: 'second',
        path: `/home/${longSegment}/second`,
        target: `/external/${longSegment}/second`,
        kind: 'managed',
        manageable: true
      }
    ];
    vi.mocked(service.loadDashboard).mockClear();
    vi.mocked(service.removeProfile).mockRejectedValueOnce(new BazframeError(
      'PROFILE_NOT_EMPTY',
      'Profile is not empty.'
    ));
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />
    );
    await openProfiles(view);

    view.stdin.write('x');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('confirm generated-empty removal'));
    expect(view.lastFrame()).toContain('! Destructive action: Remove profile focused');
    expect(view.lastFrame()).toContain('Physical profile path:');
    expect(view.lastFrame()).toContain('Scope: Bazframe generated-empty profile content only.');
    expect(view.lastFrame()).toContain('Preserved membership targets (not followed): 2 known;');
    expect(view.lastFrame()).toContain('n/Esc cancel');
    assertFrameBounds(view.lastFrame(), 60, 16);

    view.stdin.write('y');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Type exact profile ID: focused'));
    expect(view.lastFrame()).toContain('! Destructive action: Remove profile focused');
    expect(view.lastFrame()).toContain('Scope: recursively deletes all Bazframe profile content.');
    expect(view.lastFrame()).toContain('Input:');
    expect(view.lastFrame()).toContain('Enter submit  Esc cancel');
    assertFrameBounds(view.lastFrame(), 60, 16);
  });

  it('bounds full-size destructive target summaries with many long targets', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const longSegment = unicodeWidthPath();
    dashboard.profiles[0]!.directory = `/home/${longSegment}/focused`;
    dashboard.profiles[0]!.memberships = Array.from({ length: 24 }, (_, index) => {
      const skillId = `target-${String(index).padStart(2, '0')}`;
      return {
        id: `default:${skillId}`,
        membershipId: `focused:${skillId}`,
        originId: 'default',
        skillId,
        path: `/home/profiles/focused/skills/${skillId}`,
        target: `/external/${skillId}-${longSegment}`,
        kind: 'managed' as const,
        manageable: true
      };
    });
    vi.mocked(service.loadDashboard).mockClear();
    vi.mocked(service.removeProfile).mockRejectedValueOnce(new BazframeError(
      'PROFILE_NOT_EMPTY',
      'Profile is not empty.'
    ));
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />
    );
    await openProfiles(view);

    view.stdin.write('x');
    await vi.waitFor(() => expect(view.lastFrame()).toContain(
      'Preserved membership targets (not followed): 24 known; examples:'
    ));
    expect(view.lastFrame()).toContain('Physical profile path:');
    expect(view.lastFrame()).toContain('Scope: Bazframe generated-empty profile content only.');
    expect(view.lastFrame()).toContain('confirm generated-empty removal');
    expect(view.lastFrame()).not.toContain('target-02');
    assertFrameBounds(view.lastFrame(), 80, 24);

    view.stdin.write('y');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Type exact profile ID: focused'));
    expect(view.lastFrame()).toContain('Scope: recursively deletes all Bazframe profile content.');
    expect(view.lastFrame()).toContain('Input:');
    expect(view.lastFrame()).toContain('Enter submit  Esc cancel');
    expect(view.lastFrame()).not.toContain('target-02');
    assertFrameBounds(view.lastFrame(), 80, 24);
  });

  it('treats Ctrl+C as global even while a modal owns text input', async () => {
    const service = fakeService();
    const onExitCode = vi.fn();
    const view = render(<TuiApp service={service} onExitCode={onExitCode} />);
    await openProfiles(view);
    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Create profile'));

    view.stdin.write('\x03');
    await vi.waitFor(() => expect(onExitCode).toHaveBeenCalledWith(130));
    expect(service.createProfile).not.toHaveBeenCalled();
  });

  it('keeps the Ctrl+C exit status after an in-flight mutation completes', async () => {
    const service = fakeService();
    let resolveMutation!: () => void;
    vi.mocked(service.addMembership).mockImplementation(() => new Promise<void>((resolve) => {
      resolveMutation = resolve;
    }));
    const onExitCode = vi.fn();
    const onForceExit = vi.fn();
    const view = render(
      <TuiApp service={service} onExitCode={onExitCode} onForceExit={onForceExit} />
    );
    await openProfiles(view);
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Available skills'));
    view.stdin.write('\t');
    view.stdin.write('a');
    await vi.waitFor(() => expect(service.addMembership).toHaveBeenCalledOnce());

    view.stdin.write('\x03');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('waiting for the operation'));
    resolveMutation();

    await vi.waitFor(() => expect(onExitCode).toHaveBeenCalledWith(130));
    expect(service.loadDashboard).toHaveBeenCalledTimes(1);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it('does not treat a stalled post-operation refresh as an active mutation', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    vi.mocked(service.loadDashboard).mockReset();
    vi.mocked(service.loadDashboard)
      .mockResolvedValueOnce(dashboard)
      .mockImplementationOnce(() => new Promise<DashboardSnapshot>(() => undefined));
    const onExitCode = vi.fn();
    const onForceExit = vi.fn();
    const view = render(
      <TuiApp service={service} onExitCode={onExitCode} onForceExit={onForceExit} />
    );
    await openProfiles(view);
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Available skills'));
    view.stdin.write('\t');
    view.stdin.write('a');
    await vi.waitFor(() => expect(service.loadDashboard).toHaveBeenCalledTimes(2));

    view.stdin.write('\x03');

    await vi.waitFor(() => expect(onExitCode).toHaveBeenCalledWith(130));
    expect(service.addMembership).toHaveBeenCalledOnce();
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it('waits on the first Ctrl+C during mutation and force-exits only on the second', async () => {
    const service = fakeService();
    vi.mocked(service.addMembership).mockImplementation(() => new Promise<void>(() => undefined));
    const onExitCode = vi.fn();
    const onForceExit = vi.fn();
    const view = render(
      <TuiApp service={service} onExitCode={onExitCode} onForceExit={onForceExit} />
    );
    await openProfiles(view);
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Available skills'));
    view.stdin.write('\t');
    view.stdin.write('a');
    view.stdin.write('a');
    await vi.waitFor(() => expect(service.addMembership).toHaveBeenCalledOnce());
    view.stdin.write('r');
    expect(service.addMembership).toHaveBeenCalledOnce();
    expect(service.loadDashboard).toHaveBeenCalledTimes(1);

    view.stdin.write('\x03');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('waiting for the operation'));
    expect(onExitCode).not.toHaveBeenCalled();
    expect(onForceExit).not.toHaveBeenCalled();
    view.stdin.write('z');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain('waiting for the operation');
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Skills'));
    expect(view.lastFrame()).toContain('waiting for the operation');

    view.stdin.write('\x03');
    await vi.waitFor(() => expect(onExitCode).toHaveBeenCalledWith(130));
    expect(onForceExit).toHaveBeenCalledOnce();
  });

  it('ignores Kitty key-release events', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await waitForDashboard(view);
    const beforeRelease = view.lastFrame();

    view.stdin.write('\u001B[50;1:3u');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.lastFrame()).toBe(beforeRelease);
  });

  it('separates direct tab activation from predictable top-tab focus traversal', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Skills'));

    view.stdin.write(']');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 2 Profiles'));
    view.stdin.write('[');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Skills'));

    view.stdin.write('\u001B[Z');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    view.stdin.write('h');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 4 Settings'));
    expect(view.lastFrame()).toContain('Policy and current directory');
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃ Settings'));

    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 2 Profiles'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Available skills'));
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    expect(view.lastFrame()).not.toContain('┃Included skills');
    view.stdin.write('h');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Skills'));

    view.stdin.write('2');
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    view.stdin.write('\u001B[Z');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    view.stdin.write('\u001B[Z');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Available skills'));
  });

  it('navigates list pages and keeps Create New Profile selectable', async () => {
    const service = fakeService();
    const base = await service.loadDashboard();
    base.profiles = Array.from({ length: 20 }, (_, index) => ({
      ...base.profiles[0]!,
      id: `profile-${String(index).padStart(2, '0')}`,
      active: index === 0
    }));
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />
    );
    await openProfiles(view);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('profile-00'));

    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('profile-06'));
    view.stdin.write('\u001B[H');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ Create New Profile'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Create profile'));
    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('New profile ID'));
    view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('▶ profile-00'));
  });

  it('shows a proportional Skills scrollbar at distinct top, middle, and bottom positions', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.skillGroups![0]!.skills = Array.from({ length: 30 }, (_, index) => {
      const id = `skill-${String(index).padStart(2, '0')}`;
      return { id, originId: 'default', directory: `/library/skills/${id}` };
    });
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('skill-00'));
    expect(view.lastFrame()).toContain('░');
    const top = scrollbarThumbRows(view.lastFrame());
    view.stdin.write('\u001B[6~');
    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('skill-23'));
    const middle = scrollbarThumbRows(view.lastFrame());
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('skill-29'));
    const bottom = scrollbarThumbRows(view.lastFrame());

    expect(Math.min(...top)).toBeLessThan(Math.min(...middle));
    expect(Math.min(...middle)).toBeLessThan(Math.min(...bottom));
    expect(Math.max(...top)).toBeLessThan(Math.max(...bottom));
    assertFrameBounds(view.lastFrame(), 80, 24);
  });

  it('shows scrollbars for Profiles, Included, and grouped Available rows only on overflow', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const memberships = Array.from({ length: 10 }, (_, index) => {
      const id = `included-${String(index).padStart(2, '0')}`;
      return {
        id,
        membershipId: `focused:default:${id}`,
        originId: 'default',
        skillId: id,
        path: `/home/profiles/focused/skills/${id}`,
        kind: 'managed' as const,
        manageable: true
      };
    });
    dashboard.profiles = Array.from({ length: 20 }, (_, index) => ({
      ...dashboard.profiles[0]!,
      id: `profile-${String(index).padStart(2, '0')}`,
      active: index === 0,
      memberships
    }));
    const defaultSource = {
      ...dashboard.skillGroups![0]!,
      skills: Array.from({ length: 12 }, (_, index) => {
        const id = `available-${String(index).padStart(2, '0')}`;
        return { id, originId: 'default', directory: `/library/skills/${id}` };
      })
    };
    const managed = {
      id: 'library:deck',
      label: 'deck',
      root: '/snapshots/deck',
      artifactWritesSupported: false as const,
      skills: Array.from({ length: 4 }, (_, index) => ({
        id: `managed-${String(index).padStart(2, '0')}`,
        originId: 'library:deck',
        directory: `/snapshots/deck/managed-${String(index).padStart(2, '0')}`
      }))
    };
    dashboard.skillGroups = [defaultSource, managed];
    dashboard.availableSkillGroups = [defaultSource];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);

    await openProfiles(view);
    expect(view.lastFrame()).toContain('░');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    expect(view.lastFrame()).toContain('░');
    view.stdin.write('J');
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] deck'));
    view.stdin.write('\r');
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('managed-00'));
    expect(view.lastFrame()).toContain('░');
    expect(view.lastFrame()).toContain('█');
    assertFrameBounds(view.lastFrame(), 80, 24);
  });

  it('shows preview and directory-browser scrollbars while keeping fitting lists rail-free', async () => {
    const service = fakeService();
    vi.mocked(service.loadSkillPreview).mockImplementation(async ({ originId, skillId }) => ({
      originId,
      skillId,
      path: `/library/skills/${skillId}/SKILL.md`,
      contents: Array.from({ length: 30 }, (_, index) => `preview-${String(index).padStart(2, '0')}`).join('\n')
    }));
    vi.mocked(service.inspectLibraryInput).mockImplementation(async (input) => ({
      kind: 'directory',
      input,
      browser: {
        input,
        resolvedPath: '/tmp',
        selectablePath: '/tmp',
        entries: Array.from({ length: 10 }, (_, index) => ({
          name: `directory-${index}`,
          path: `/tmp/directory-${index}`
        }))
      }
    }));
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);

    await waitForDashboard(view);
    expect(view.lastFrame()).not.toContain('░');
    expect(view.lastFrame()).not.toContain('█');
    view.stdin.write('\u001B[B');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('preview-00'));
    expect(view.lastFrame()).toContain('░');
    const previewTop = scrollbarThumbRows(view.lastFrame());
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('preview-29'));
    expect(Math.min(...scrollbarThumbRows(view.lastFrame()))).toBeGreaterThan(Math.min(...previewTop));

    view.stdin.write('H');
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('/tmp/directory-0'));
    expect(view.lastFrame()).toContain('░');
    const directoryTop = scrollbarThumbRows(view.lastFrame());
    for (let index = 0; index < 10; index += 1) view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('/tmp/directory-9'));
    expect(Math.min(...scrollbarThumbRows(view.lastFrame()))).toBeGreaterThan(Math.min(...directoryTop));
    assertFrameBounds(view.lastFrame(), 80, 24);
  });

  it('hides visual scrollbar rails from screen-reader output', async () => {
    vi.stubEnv('INK_SCREEN_READER', 'true');
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.skillGroups![0]!.skills = Array.from({ length: 30 }, (_, index) => {
      const id = `skill-${String(index).padStart(2, '0')}`;
      return { id, originId: 'default', directory: `/library/skills/${id}` };
    });
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('skill-00'));
    expect(view.lastFrame()).not.toContain('░');
    expect(view.lastFrame()).not.toContain('█');
  });

  it('keeps long-list viewports independent across tabs, routes, and compact resize', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const memberships = Array.from({ length: 20 }, (_, index) => {
      const id = `included-${String(index).padStart(2, '0')}`;
      return {
        id,
        membershipId: `focused:default:${id}`,
        originId: 'default',
        skillId: id,
        path: `/home/profiles/focused/skills/${id}`,
        kind: 'managed' as const,
        manageable: true
      };
    });
    dashboard.profiles = Array.from({ length: 20 }, (_, index) => ({
      ...dashboard.profiles[0]!,
      id: `profile-${String(index).padStart(2, '0')}`,
      active: index === 0,
      memberships
    }));
    dashboard.skillGroups![0]!.skills = Array.from({ length: 20 }, (_, index) => {
      const id = `available-${String(index).padStart(2, '0')}`;
      return { id, originId: 'default', directory: `/library/skills/${id}` };
    });
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />
    );
    await openProfiles(view);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('profile-00'));

    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('profile-06'));
    expect(view.lastFrame()).toContain('profile-01');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));

    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ included-19'));
    expect(view.lastFrame()).not.toContain('included-00');
    view.stdin.write('\t');
    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('available-01'));

    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skills'));
    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('available-05'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ included-19'));
    expect(view.lastFrame()).toContain('available-01');

    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃ Profiles'));
    expect(view.lastFrame()).toContain('profile-01');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ included-19'));

    view.rerender(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('included-17'));
    expect(view.lastFrame()).toContain('+ included-19');
    expect(view.lastFrame()).toContain('available-01');
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('available-06'));
  });

  it('reconciles scrolled pane selections before opening a different profile', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const skills = Array.from({ length: 16 }, (_, index) => {
      const id = `skill-${String(index).padStart(2, '0')}`;
      return { id, originId: 'default', directory: `/library/skills/${id}` };
    });
    const memberships = (profileId: string, skillIds: readonly string[]) => skillIds.map((skillId) => ({
      id: `${profileId}:default:${skillId}`,
      membershipId: `${profileId}:default:${skillId}`,
      originId: 'default',
      skillId,
      path: `/home/profiles/${profileId}/skills/${skillId}`,
      kind: 'managed' as const,
      manageable: true
    }));
    dashboard.skillGroups![0]!.skills = skills;
    dashboard.profiles = [
      {
        ...dashboard.profiles[0]!,
        memberships: memberships('focused', skills.slice(0, 6).map((skill) => skill.id))
      },
      {
        ...dashboard.profiles[0]!,
        id: 'reviewer',
        directory: '/home/profiles/reviewer',
        instructionsPath: '/home/profiles/reviewer/AGENTS.md',
        removalIdentity: removalIdentity('reviewer'),
        active: false,
        memberships: memberships('reviewer', skills.slice(10).map((skill) => skill.id))
      }
    ];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />
    );
    await waitForDashboard(view);

    view.stdin.write('1');
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('skill-15'));
    expect(view.lastFrame()).not.toContain('skill-00');

    view.stdin.write('2');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ skill-05'));
    view.stdin.write('\t');
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('skill-15'));

    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃ Profiles'));
    expect(view.lastFrame()).not.toContain('Included skills');
    view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('reviewer'));
    view.stdin.write('\r');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ skill-10'));
    expect(view.lastFrame()).toContain('[-] (default)');
    expect(view.lastFrame()).not.toContain('+ skill-05');
    expect(view.lastFrame()).not.toContain('skill-15');

    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('skill-15'));
    expect(view.lastFrame()).not.toContain('skill-00');
  });

  it('moves between an empty pane and the adjacent pane at content boundaries', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await openProfiles(view);
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));

    view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Available skills'));
    view.stdin.write('\u001B[A');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Available skills'));
    view.stdin.write('\u001B[A');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
  });

  it('selects a tree first child and returns to its parent before collapsing', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await waitForDashboard(view);
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('demo-skill'));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('demo-skill'));
    view.stdin.write('\u001B[D');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Added Skills'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('demo-skill'));
  });

  it('routes a newly created profile directly to its editor after refresh', async () => {
    const service = fakeService();
    const base = await service.loadDashboard();
    vi.mocked(service.loadDashboard).mockClear();
    vi.mocked(service.createProfile).mockImplementation(async (id: string) => {
      base.profiles.push({
        id,
        directory: `/home/profiles/${id}`,
        instructionsPath: `/home/profiles/${id}/AGENTS.md`,
        removalIdentity: removalIdentity(id),
        active: false,
        favorite: false,
        membershipWritable: true,
        memberships: []
      });
    });
    const view = render(<TuiApp service={service} />);
    await openProfiles(view);
    view.stdin.write('\u001B[H');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ Create New Profile'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('New profile ID'));
    view.stdin.write('reviewer');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('reviewer'));
    view.stdin.write('\r');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    expect(view.lastFrame()).toContain('┃Included skills');
    expect(service.createProfile).toHaveBeenCalledWith('reviewer');
  });

  it('renders focus and selection without literal focus labels or cursor arrows', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);

    expect(view.lastFrame()).not.toContain('[focused]');
    expect(view.lastFrame()!.split('\n').filter((line) => line.includes('>'))).toEqual([]);

    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Added Skills'));
    expect(view.lastFrame()).not.toContain('[focused]');
    expect(view.lastFrame()!.split('\n').filter((line) => line.includes('>'))).toEqual([]);

    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Added Skills'));
    expect(view.lastFrame()!.split('\n').filter((line) => line.includes('[+]'))).toEqual([
      expect.stringContaining('[+] Added Skills')
    ]);
  });

  it('uses a bold border fallback for focus and moves it without text markers', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await waitForDashboard(view);

    expect(view.lastFrame()).toMatch(/^\+[-]+\+/u);
    expect(view.lastFrame()).toContain('┏');
    expect(view.lastFrame()).not.toContain('[focused]');

    view.stdin.write('\u001B[Z');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    expect(view.lastFrame()).toContain('┃* 1 Skills');
    expect(view.lastFrame()).not.toContain('[focused]');
  });

  it('supports Vim row movement and portable J/K pane jumps while modals own text', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.profiles.push({
      ...dashboard.profiles[0]!,
      id: 'reviewer',
      directory: '/home/profiles/reviewer',
      instructionsPath: '/home/profiles/reviewer/AGENTS.md',
      removalIdentity: removalIdentity('reviewer'),
      active: false
    });
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await openProfiles(view);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('reviewer'));

    view.stdin.write('j');
    view.stdin.write('u');
    await vi.waitFor(() => expect(service.useProfile).toHaveBeenCalledWith('reviewer'));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('complete'));
    view.stdin.write('k');
    view.stdin.write('u');
    await vi.waitFor(() => expect(service.useProfile).toHaveBeenCalledWith('focused'));

    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    view.stdin.write('J');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Available skills'));
    view.stdin.write('K');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    view.stdin.write('\u001B[1;2B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Available skills'));
    view.stdin.write('\u001B[1;2A');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));

    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Right/l/Enter/L edit'));
    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Create profile'));
    view.stdin.write('hjklJK');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('hjklJK'));
    expect(service.createProfile).not.toHaveBeenCalled();
  });

  it.each([
    [80, 24],
    [60, 16]
  ])('keeps Unicode, ANSI, and long source paths within %sx%s terminal cells', async (columns, rows) => {
    expect(stringWidth('界')).toBe(2);
    expect(stringWidth('e\u0301')).toBe(1);
    expect(stringWidth('👩‍💻')).toBe(2);
    expect(stringWidth('\u001B[31mANSI\u001B[0m')).toBe(4);

    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.skillGroups![0]!.label = 'U';
    dashboard.skillGroups![0]!.root = unicodeWidthPath();
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns, rows }} />);
    await waitForDashboard(view);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('路径'));
    const frame = view.lastFrame()!;
    const sourceLines = frame.split('\n').filter((line) => line.includes('路径'));
    expect(sourceLines.length).toBeGreaterThanOrEqual(1);
    expect(sourceLines[0]).toContain('Cafe\u0301');
    expect(sourceLines[0]).toContain('👩‍💻');
    expect(sourceLines[0]).toContain('ANSI');
    expect(sourceLines[0]).toContain('\u001B[31m');
    expect(sourceLines[0]).toContain('…');
    expect(sourceLines[0]!.length).toBeGreaterThan(columns);
    expect(frame).not.toContain(UNICODE_TAIL_SENTINEL);
    assertFrameBounds(frame, columns, rows);
  });

  it('keeps compact Settings labels and read-only status visible at 60x16', async () => {
    const service = fakeService();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />
    );
    await waitForDashboard(view);
    view.stdin.write('4');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Policy/effective:'));
    expect(view.lastFrame()).toContain('Current directory:');
    expect(view.lastFrame()).toContain('Active profile:');
    expect(view.lastFrame()).toContain('Cache/aliases:');
    expect(view.lastFrame()).toContain('Attention: (none)');
    expect(view.lastFrame()).toContain('Settings: read-only');
    assertFrameBounds(view.lastFrame(), 60, 16);
  });

  it.each(['1', '2', '3'])('keeps bordered tab %s within compact bounds', async (tab) => {
    const service = fakeService();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />
    );
    await waitForDashboard(view);
    view.stdin.write(tab);
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`* ${tab}`));
    expect(view.lastFrame()).toContain('┏');
    assertFrameBounds(view.lastFrame(), 60, 16);
  });

  it('renders readable diagnostics and non-color state markers in compact mode', async () => {
    const service = fakeService();
    const base = await service.loadDashboard();
    base.diagnostics = [{
      id: 'broken-source',
      severity: 'warning',
      message: 'Skill source metadata is malformed; inspect /library/skills.'
    }];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Skill source metadata'));
    view.stdin.write('2');
    view.stdin.write('\r');
    view.stdin.write('e');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Editor exited successfully'));
    view.stdin.write('z');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain('Editor exited successfully');
    view.stdin.write('J');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Skill source metadata'));
    view.stdin.write('K');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Status: Ready'));
    expect(view.lastFrame()).not.toContain('Warning: Skill source metadata');
    expect(view.lastFrame()).toContain('* 2 Profiles');
    expect(view.lastFrame()).toContain('▶ focused');
    expect(Math.max(...view.lastFrame()!.split('\n').map((line) => stringWidth(line)))).toBeLessThanOrEqual(60);
  });

  it('dismisses warnings on handled input while preserving errors, inert keys, and releases', async () => {
    const service = fakeService();
    const base = await service.loadDashboard();
    base.diagnostics = [
      { id: 'warning', severity: 'warning', message: 'Dismissible warning.' },
      { id: 'error', severity: 'error', message: 'Persistent error.' }
    ];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Dismissible warning. [1/2]'));
    view.stdin.write('z');
    view.stdin.write('\u001B[50;1:3u');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain('Warning: Dismissible warning. [1/2]');

    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Error: Persistent error.'));
    expect(view.lastFrame()).not.toContain('[1/2]');
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Skills'));
    expect(view.lastFrame()).toContain('Error: Persistent error.');
  });

  it('dismisses warnings ordered after a persistent error', async () => {
    const service = fakeService();
    const base = await service.loadDashboard();
    base.diagnostics = [
      { id: 'error', severity: 'error', message: 'Persistent error first.' },
      { id: 'warning', severity: 'warning', message: 'Dismissible warning second.' }
    ];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Error: Persistent error first. [1/2]'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Error: Persistent error first.'));
    expect(view.lastFrame()).not.toContain('[1/2]');
  });

  it('does not dismiss warnings while a dashboard load masks status', async () => {
    const service = fakeService();
    const base = await service.loadDashboard();
    base.diagnostics = [{ id: 'warning', severity: 'warning', message: 'Pending-load warning.' }];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Pending-load warning.'));

    let rejectLoad!: (error: Error) => void;
    const pendingService: BazframeTuiService = {
      ...service,
      loadDashboard: vi.fn(() => new Promise<DashboardSnapshot>((_resolve, reject) => {
        rejectLoad = reject;
      }))
    };
    view.rerender(<TuiApp service={pendingService} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Status: Loading...'));
    view.stdin.write('2');
    rejectLoad(new Error('pending refresh failed'));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Error: pending refresh failed'));
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Pending-load warning.'));
  });

  it('does not dismiss warnings while an operation masks status', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await openProfiles(view);
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Available skills'));
    view.stdin.write('e');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Editor exited successfully'));

    const warningSnapshot = await service.loadDashboard();
    warningSnapshot.diagnostics = [{ id: 'warning', severity: 'warning', message: 'Pending-operation warning.' }];
    let rejectOperation!: (error: Error) => void;
    const operationService: BazframeTuiService = {
      ...service,
      loadDashboard: vi.fn(async () => warningSnapshot),
      useProfile: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectOperation = reject;
      }))
    };
    view.rerender(<TuiApp service={operationService} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(operationService.loadDashboard).toHaveBeenCalledOnce());
    expect(view.lastFrame()).toContain('Editor exited successfully');

    view.stdin.write('u');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Working: Activate profile...'));
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Skills'));
    view.stdin.write('2');
    rejectOperation(new Error('operation failed'));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Error: operation failed'));
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Pending-operation warning.'));
  });

  it('clears a masking transient before dismissing rearmed warnings', async () => {
    const service = fakeService();
    const base = await service.loadDashboard();
    base.diagnostics = [{ id: 'warning', severity: 'warning', message: 'Dashboard warning.' }];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Dashboard warning.'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Status: Ready'));
    view.stdin.write('u');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Success: Activate profile complete.'));

    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Dashboard warning.'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Status: Ready'));
  });

  it('rearms warnings only after a successful dashboard reload', async () => {
    const service = fakeService();
    const base = await service.loadDashboard();
    base.diagnostics = [{ id: 'warning', severity: 'warning', message: 'Reload warning.' }];
    vi.mocked(service.loadDashboard).mockReset();
    vi.mocked(service.loadDashboard)
      .mockResolvedValueOnce(base)
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce({ ...base, revision: 2 });
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Reload warning.'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Status: Ready'));
    view.rerender(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    expect(view.lastFrame()).toContain('Status: Ready');
    expect(view.lastFrame()).not.toContain('Reload warning.');
    view.stdin.write('r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Error: refresh failed'));
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Status: Ready'));
    expect(view.lastFrame()).not.toContain('Reload warning.');

    view.stdin.write('r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Reload warning.'));
  });

  it('does not rearm dismissed warnings from stale successful loads', async () => {
    const service = fakeService();
    const base = await service.loadDashboard();
    base.diagnostics = [{ id: 'warning', severity: 'warning', message: 'Stale warning.' }];
    let resolveStale!: (snapshot: DashboardSnapshot) => void;
    let rejectCurrent!: (error: Error) => void;
    vi.mocked(service.loadDashboard).mockReset();
    vi.mocked(service.loadDashboard)
      .mockResolvedValueOnce(base)
      .mockImplementationOnce(() => new Promise<DashboardSnapshot>((resolve) => { resolveStale = resolve; }))
      .mockImplementationOnce(() => new Promise<DashboardSnapshot>((_resolve, reject) => { rejectCurrent = reject; }));
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Warning: Stale warning.'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Status: Ready'));
    view.stdin.write('r');
    view.stdin.write('r');
    await vi.waitFor(() => expect(service.loadDashboard).toHaveBeenCalledTimes(3));
    rejectCurrent(new Error('current refresh failed'));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Error: current refresh failed'));
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Status: Ready'));
    resolveStale({ ...base, revision: 99 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain('Status: Ready');
    expect(view.lastFrame()).not.toContain('Stale warning.');
  });

  it('preserves the immediately activated focused tab across inert resize', async () => {
    const service = fakeService();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />
    );
    await openProfiles(view);
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    view.stdin.write('\t');
    view.stdin.write('\t');
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    expect(view.lastFrame()).toContain('* 3 Adapters');
    expect(view.lastFrame()).toContain('Adapters');

    view.rerender(<TuiApp service={service} dimensions={{ columns: 59, rows: 15 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Terminal too small'));
    view.stdin.write('c');
    expect(service.createProfile).not.toHaveBeenCalled();

    view.rerender(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    expect(view.lastFrame()).toContain('* 3 Adapters');
    expect(view.lastFrame()).toContain('Adapters');
    expect(view.lastFrame()).not.toContain('┃Included skills');
  });

  it.each([
    [80, 24],
    [60, 16]
  ])('keeps both profile panes and hints visible at %sx%s', async (columns, rows) => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns, rows }} />);
    await openProfiles(view);
    view.stdin.write('\r');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Included skills'));
    expect(view.lastFrame()).toContain('Available skills');
    expect(view.lastFrame()).toContain('Esc/Backspace');
    expect(view.lastFrame()).toContain('Status: Ready');
    assertFrameBounds(view.lastFrame(), columns, rows);
  });

  it('collapses, expands, and pages Available groups by selectable visual rows', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.skillGroups = [
      {
        id: 'alpha', label: 'Alpha', root: '/skills/alpha', artifactWritesSupported: false,
        skills: [
          { id: 'a1', originId: 'alpha', directory: '/skills/alpha/a1' },
          { id: 'a2', originId: 'alpha', directory: '/skills/alpha/a2' }
        ]
      },
      {
        id: 'beta', label: 'Beta', root: '/skills/beta', artifactWritesSupported: false,
        skills: [
          { id: 'b1', originId: 'beta', directory: '/skills/beta/b1' },
          { id: 'b2', originId: 'beta', directory: '/skills/beta/b2' }
        ]
      }
    ];
    dashboard.availableSkillGroups = dashboard.skillGroups;
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 20 }} />);
    await openProfiles(view);
    view.stdin.write('\r');
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Alpha'));
    expect(view.lastFrame()).toContain('[+] Beta');

    view.stdin.write('a');
    expect(service.addMembership).not.toHaveBeenCalled();
    view.stdin.write('L');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Alpha'));
    expect(view.lastFrame()).toContain('a1');
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('a1'));

    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Beta'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Beta'));
    view.stdin.write('l');
    view.stdin.write('a');
    await vi.waitFor(() => expect(service.addMembership).toHaveBeenCalledWith('focused', {
      originId: 'beta', skillId: 'b1'
    }));

    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Beta'));
    expect(view.lastFrame()).not.toContain('b1');
    view.stdin.write('\u001B[5~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[-] Alpha'));
    assertFrameBounds(view.lastFrame(), 60, 20);
  });

  it('keeps a one-row Available selection usable with explicit group context', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    dashboard.skillGroups = [
      {
        id: 'alpha', label: 'Alpha', root: '/skills/alpha', artifactWritesSupported: false,
        skills: [{ id: 'a1', originId: 'alpha', directory: '/skills/alpha/a1' }]
      },
      {
        id: 'beta', label: 'Beta', root: '/skills/beta', artifactWritesSupported: false,
        skills: [{ id: 'b1', originId: 'beta', directory: '/skills/beta/b1' }]
      }
    ];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />);
    await openProfiles(view);
    view.stdin.write('\r');
    view.stdin.write('\t');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('[+] Alpha'));
    view.stdin.write('\r');
    view.stdin.write('l');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[Alpha] a1'));
    expect(view.lastFrame()).not.toMatch(/\n[^\n]*Alpha[^\n]*\n[^\n]*a1/u);
    assertFrameBounds(view.lastFrame(), 60, 16);
  });

  it('edits membership for the open profile without activating it', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await openProfiles(view);

    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Included skills'));
    expect(view.lastFrame()).toContain('Available skills');

    view.stdin.write('\t');
    view.stdin.write('a');
    await vi.waitFor(() => {
      expect(service.addMembership).toHaveBeenCalledWith('focused', {
        originId: 'default',
        skillId: 'demo-skill'
      });
    });
    expect(service.useProfile).not.toHaveBeenCalled();
  });
});

async function waitForDashboard(view: {
  lastFrame(): string | undefined;
}): Promise<void> {
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Status: Ready'));
}

async function openProfiles(view: {
  lastFrame(): string | undefined;
  stdin: { write(value: string): void };
}): Promise<void> {
  await waitForDashboard(view);
  view.stdin.write('2');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('* 2 Profiles'));
}

function scrollbarThumbRows(frame: string | undefined): number[] {
  expect(frame).toBeDefined();
  return frame!.split('\n').flatMap((line, index) => line.includes('█') ? [index] : []);
}

function assertFrameBounds(
  frame: string | undefined,
  maximumColumns: number,
  maximumRows: number
): void {
  expect(frame).toBeDefined();
  const lines = frame!.split('\n');
  expect(lines.length).toBeLessThanOrEqual(maximumRows);
  expect(Math.max(...lines.map((line) => stringWidth(line)))).toBeLessThanOrEqual(maximumColumns);
}

const UNICODE_TAIL_SENTINEL = 'TAIL-SENTINEL-9F4C';

function unicodeWidthPath(): string {
  return `/路径/Cafe\u0301/👩‍💻/\u001B[31mANSI\u001B[0m/${'x'.repeat(180)}-${UNICODE_TAIL_SENTINEL}`;
}

function removalIdentity(id: string): ProfileRemovalIdentity {
  return {
    schemaVersion: 1,
    directory: { device: '1', inode: id },
    fingerprint: `fingerprint-${id}`
  };
}

function fakeService(): BazframeTuiService & Record<string, ReturnType<typeof vi.fn>> {
  const value: DashboardSnapshot = {
    revision: 1,
    activeProfileId: 'focused',
    profiles: [{
      id: 'focused',
      directory: '/home/profiles/focused',
      instructionsPath: '/home/profiles/focused/AGENTS.md',
      removalIdentity: removalIdentity('focused'),
      active: true,
      favorite: false,
      membershipWritable: true,
      memberships: []
    }],
    skillGroups: [{
      id: 'default',
      label: '(default)',
      root: '/library/skills',
      artifactWritesSupported: false,
      skills: [{
        id: 'demo-skill',
        originId: 'default',
        directory: '/library/skills/demo-skill'
      }]
    }],
    adapterStatus: {
      state: 'available',
      value: {
        adapter: {
          state: 'current',
          targetPath: '/pi-agent/extensions/bazframe.ts',
          installedBazframeVersion: '0.1.0-test'
        },
        correctiveActions: []
      }
    },
    status: {
      state: 'available',
      value: {
        bazframeHome: '/home',
        piAgentDirectory: '/pi-agent',
        adapter: {
          state: 'current',
          targetPath: '/pi-agent/extensions/bazframe.ts',
          installedBazframeVersion: '0.1.0-test'
        },
        globalPolicy: { policy: 'enabled' },
        repository: {
          kind: 'git-worktree',
          root: '/repository',
          projectState: 'inherit'
        },
        effectiveBehavior: {
          kind: 'git-worktree',
          enabled: true,
          reason: 'global-enabled'
        },
        profile: {
          state: 'ready',
          id: 'focused',
          instructionsPath: '/home/profiles/focused/AGENTS.md',
          skillCount: 0
        },
        cachedCollisionAliasCount: 0,
        correctiveActions: []
      }
    },
    diagnostics: []
  };
  return {
    loadDashboard: vi.fn(async () => value),
    createProfile: vi.fn(async () => undefined),
    duplicateProfile: vi.fn(async () => undefined),
    useProfile: vi.fn(async () => undefined),
    toggleProfileFavorite: vi.fn(async () => undefined),
    renameProfile: vi.fn(async () => undefined),
    removeProfile: vi.fn(async () => undefined),
    editProfileInstructions: vi.fn(async () => ({ exitCode: 0, signal: null })),
    editSkillDefinition: vi.fn(async () => ({ exitCode: 0, signal: null })),
    addMembership: vi.fn(async () => undefined),
    removeMembership: vi.fn(async () => undefined),
    loadSkillPreview: vi.fn(async ({ originId, skillId }) => ({
      originId,
      skillId,
      path: `/library/skills/${skillId}/SKILL.md`,
      contents: `---\nname: ${skillId}\ndescription: preview\n---\nPreview body\n`
    })),
    inspectLibraryInput: vi.fn(async (input) => ({
      kind: 'directory' as const,
      input,
      browser: {
        input,
        resolvedPath: '/tmp',
        selectablePath: '/tmp',
        entries: [{ name: 'skills', path: '/tmp/skills' }]
      }
    })),
    inspectLibraryCandidate: vi.fn(async ({ source }) => ({
      kind: 'directory' as const,
      libraryId: source.split('/').filter(Boolean).at(-1) ?? 'library',
      enteredRoot: source,
      canonicalRoot: source,
      packageManifest: { state: 'absent' as const }
    })),
    addLibrary: vi.fn(async ({ source }) => ({
      schemaVersion: 1 as const,
      library: source.split('/').filter(Boolean).at(-1) ?? 'library',
      root: source,
      digest: 'a'.repeat(64),
      action: 'added' as const,
      path: `/home/libraries/${source.split('/').filter(Boolean).at(-1) ?? 'library'}.json`
    }))
  };
}
