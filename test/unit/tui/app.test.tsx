import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type {
  BazframeTuiService,
  DashboardSnapshot
} from '../../../src/application/tui-service.js';
import { BazframeError } from '../../../src/core/errors.js';
import type { ProfileRemovalIdentity } from '../../../src/profiles/profile-removal-identity.js';
import { TuiApp } from '../../../src/tui/app.js';

afterEach(() => {
  cleanup();
});

describe('TuiApp', () => {
  it('renders the profile management shell and navigates tabs', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
    expect(view.lastFrame()).toContain('1 Profiles');
    expect(view.lastFrame()).toContain('c create');

    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skill sources'));
    expect(view.lastFrame()).toContain('demo-skill');
    expect(view.lastFrame()).toContain('provider-owned');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('demo-skill'));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('demo-skill'));

    view.stdin.write('3');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Setup (read-only)'));
    expect(view.lastFrame()).toContain('Pi adapter: current (0.1.0-test)');
    expect(view.lastFrame()).toContain('Current behavior: enabled (global-enabled)');
    expect(view.lastFrame()).toContain('Corrective actions:');
    expect(view.lastFrame()).toContain('(none)');
    expect(view.lastFrame()).toContain('No writable settings');

    view.stdin.write('?');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Tab/Shift+Tab cycle focus'));
    expect(view.lastFrame()).toContain('Left/Right or h/l moves focus');
  });

  it('renders setup corrective actions without exposing settings writes', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    if (dashboard.status.state !== 'available') throw new Error('Expected setup status fixture.');
    dashboard.status.value.adapter.state = 'missing';
    dashboard.status.value.correctiveActions = [{
      id: 'adapter',
      message: 'Install or update the adapter with `bazframe adapter install pi`.'
    }];
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(<TuiApp service={service} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    view.stdin.write('3');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Pi adapter: missing'));
    expect(view.lastFrame()).toContain('bazframe adapter install pi');
    expect(view.lastFrame()).toContain('No writable settings');
  });

  it('creates a profile through a text modal and authoritative service refresh', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

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
    view.stdin.write('2');
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
    view.stdin.write('d');
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
    view.stdin.write('d');
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    view.stdin.write('d');
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    view.stdin.write('d');
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    view.stdin.write('d');
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
    const longSegment = 'x'.repeat(180);
    dashboard.profiles[0]!.directory = `/home/${longSegment}/focused`;
    dashboard.profiles[0]!.memberships = [
      {
        id: 'skillbook:first',
        membershipId: 'focused:first',
        sourceId: 'skillbook',
        skillId: 'first',
        path: `/home/${longSegment}/first`,
        target: `/external/${longSegment}/first`,
        kind: 'managed',
        manageable: true
      },
      {
        id: 'skillbook:second',
        membershipId: 'focused:second',
        sourceId: 'skillbook',
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    view.stdin.write('d');
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
    const longSegment = 'x'.repeat(240);
    dashboard.profiles[0]!.directory = `/home/${longSegment}/focused`;
    dashboard.profiles[0]!.memberships = Array.from({ length: 24 }, (_, index) => {
      const skillId = `target-${String(index).padStart(2, '0')}`;
      return {
        id: `skillbook:${skillId}`,
        membershipId: `focused:${skillId}`,
        sourceId: 'skillbook',
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    view.stdin.write('d');
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
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

    view.stdin.write('\x03');
    await vi.waitFor(() => expect(onExitCode).toHaveBeenCalledWith(130));
    expect(onForceExit).toHaveBeenCalledOnce();
  });

  it('ignores Kitty key-release events', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    view.stdin.write('\u001B[50;1:3u');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.lastFrame()).not.toContain('Skill sources');
  });

  it('separates direct tab activation from predictable top-tab focus traversal', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Profiles'));

    view.stdin.write(']');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 2 Skills'));
    view.stdin.write('[');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Profiles'));

    view.stdin.write('\u001B[Z');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    view.stdin.write('h');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 3 Settings'));
    expect(view.lastFrame()).toContain('Setup (read-only)');
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃ Settings'));

    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 1 Profiles'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Available skills'));
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    expect(view.lastFrame()).not.toContain('┃Included skills');
    view.stdin.write('l');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* 2 Skills'));

    view.stdin.write('1');
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('profile-00'));

    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('profile-07'));
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ Create New Profile'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Create profile'));
    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('New profile ID'));
    view.stdin.write('\u001B[H');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('* profile-00'));
  });

  it('keeps long-list viewports independent across tabs, routes, and compact resize', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const memberships = Array.from({ length: 20 }, (_, index) => {
      const id = `included-${String(index).padStart(2, '0')}`;
      return {
        id,
        membershipId: `focused:skillbook:${id}`,
        sourceId: 'skillbook',
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
    dashboard.sources[0]!.skills = Array.from({ length: 20 }, (_, index) => {
      const id = `available-${String(index).padStart(2, '0')}`;
      return { id, sourceId: 'skillbook', directory: `/library/skills/${id}` };
    });
    vi.mocked(service.loadDashboard).mockClear();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('profile-00'));

    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('profile-07'));
    expect(view.lastFrame()).toContain('profile-01');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));

    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ included-19'));
    expect(view.lastFrame()).not.toContain('included-00');
    view.stdin.write('\t');
    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('skillbook/available-01'));

    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Skill sources'));
    view.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('available-06'));
    view.stdin.write('1');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ included-19'));
    expect(view.lastFrame()).toContain('skillbook/available-01');

    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃ Profiles'));
    expect(view.lastFrame()).toContain('profile-01');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ included-19'));

    view.rerender(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('included-16'));
    expect(view.lastFrame()).toContain('+ included-19');
    expect(view.lastFrame()).toContain('skillbook/available-01');
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('available-06'));
  });

  it('reconciles scrolled pane selections before opening a different profile', async () => {
    const service = fakeService();
    const dashboard = await service.loadDashboard();
    const skills = Array.from({ length: 16 }, (_, index) => {
      const id = `skill-${String(index).padStart(2, '0')}`;
      return { id, sourceId: 'skillbook', directory: `/library/skills/${id}` };
    });
    const memberships = (profileId: string, skillIds: readonly string[]) => skillIds.map((skillId) => ({
      id: `${profileId}:skillbook:${skillId}`,
      membershipId: `${profileId}:skillbook:${skillId}`,
      sourceId: 'skillbook',
      skillId,
      path: `/home/profiles/${profileId}/skills/${skillId}`,
      kind: 'managed' as const,
      manageable: true
    }));
    dashboard.sources[0]!.skills = skills;
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    view.stdin.write('2');
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('skill-15'));
    expect(view.lastFrame()).not.toContain('skill-00');

    view.stdin.write('1');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ skill-05'));
    view.stdin.write('\t');
    view.stdin.write('\u001B[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('skillbook/skill-15'));

    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃ Profiles'));
    expect(view.lastFrame()).not.toContain('Included skills');
    view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('reviewer'));
    view.stdin.write('\r');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('+ skill-10'));
    expect(view.lastFrame()).toContain('skillbook/skill-09');
    expect(view.lastFrame()).not.toContain('+ skill-05');
    expect(view.lastFrame()).not.toContain('skillbook/skill-15');

    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('skill-15'));
    expect(view.lastFrame()).not.toContain('skill-00');
  });

  it('moves between an empty pane and the adjacent pane at content boundaries', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));

    view.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Available skills'));
    view.stdin.write('\u001B[A');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
  });

  it('selects a tree first child and returns to its parent before collapsing', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('demo-skill'));
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('demo-skill'));
    view.stdin.write('\u001B[D');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('v Skillbook'));
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
        membershipWritable: true,
        memberships: []
      });
    });
    const view = render(<TuiApp service={service} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
    view.stdin.write('\u001B[F');
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    expect(view.lastFrame()).not.toContain('[focused]');
    expect(view.lastFrame()!.split('\n').filter((line) => line.includes('>'))).toEqual([]);

    view.stdin.write('2');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('v Skillbook'));
    expect(view.lastFrame()).not.toContain('[focused]');
    expect(view.lastFrame()!.split('\n').filter((line) => line.includes('>'))).toEqual([]);

    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('> Skillbook'));
    expect(view.lastFrame()!.split('\n').filter((line) => line.includes('>'))).toEqual([
      expect.stringContaining('> Skillbook')
    ]);
  });

  it('uses a bold border fallback for focus and moves it without text markers', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    expect(view.lastFrame()).toMatch(/^\+[-]+\+/u);
    expect(view.lastFrame()).toContain('┏');
    expect(view.lastFrame()).not.toContain('[focused]');

    view.stdin.write('\u001B[Z');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    expect(view.lastFrame()).toContain('| Profiles');
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

    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃ Profiles'));
    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Create profile'));
    view.stdin.write('hjklJK');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('hjklJK'));
    expect(service.createProfile).not.toHaveBeenCalled();
  });

  it.each(['1', '2', '3'])('keeps bordered tab %s within compact bounds', async (tab) => {
    const service = fakeService();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 60, rows: 16 }} />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
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
    expect(view.lastFrame()).toContain('* 1 Profiles');
    expect(view.lastFrame()).toContain('* focused');
    expect(Math.max(...view.lastFrame()!.split('\n').map((line) => line.length))).toBeLessThanOrEqual(60);
  });

  it('preserves route, active tab, and focused-tab cursor across inert resize', async () => {
    const service = fakeService();
    const view = render(
      <TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('┃Included skills'));
    view.stdin.write('\t');
    view.stdin.write('\t');
    view.stdin.write('\u001B[C');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    expect(view.lastFrame()).toContain('* 1 Profiles');
    expect(view.lastFrame()).toContain('Included skills');

    view.rerender(<TuiApp service={service} dimensions={{ columns: 59, rows: 15 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Terminal too small'));
    view.stdin.write('c');
    expect(service.createProfile).not.toHaveBeenCalled();

    view.rerender(<TuiApp service={service} dimensions={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/^┏/u));
    expect(view.lastFrame()).toContain('* 1 Profiles');
    expect(view.lastFrame()).toContain('Included skills');
    expect(view.lastFrame()).not.toContain('┃Included skills');
  });

  it.each([
    [80, 24],
    [60, 16]
  ])('keeps both profile panes and hints visible at %sx%s', async (columns, rows) => {
    const service = fakeService();
    const view = render(<TuiApp service={service} dimensions={{ columns, rows }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));
    view.stdin.write('\r');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Included skills'));
    expect(view.lastFrame()).toContain('Available skills');
    expect(view.lastFrame()).toContain('Esc back');
    expect(view.lastFrame()).toContain('Status: Ready');
    assertFrameBounds(view.lastFrame(), columns, rows);
  });

  it('edits membership for the open profile without activating it', async () => {
    const service = fakeService();
    const view = render(<TuiApp service={service} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('focused'));

    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Included skills'));
    expect(view.lastFrame()).toContain('Available skills');

    view.stdin.write('\t');
    view.stdin.write('a');
    await vi.waitFor(() => {
      expect(service.addMembership).toHaveBeenCalledWith('focused', {
        sourceId: 'skillbook',
        skillId: 'demo-skill'
      });
    });
    expect(service.useProfile).not.toHaveBeenCalled();
  });
});

function assertFrameBounds(
  frame: string | undefined,
  maximumColumns: number,
  maximumRows: number
): void {
  expect(frame).toBeDefined();
  const lines = frame!.split('\n');
  expect(lines.length).toBeLessThanOrEqual(maximumRows);
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(maximumColumns);
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
      membershipWritable: true,
      memberships: []
    }],
    sources: [{
      id: 'skillbook',
      provider: 'skillbook',
      label: 'Skillbook',
      root: '/library/skills',
      artifactWritesSupported: false,
      skills: [{
        id: 'demo-skill',
        sourceId: 'skillbook',
        directory: '/library/skills/demo-skill'
      }]
    }],
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
    renameProfile: vi.fn(async () => undefined),
    removeProfile: vi.fn(async () => undefined),
    addMembership: vi.fn(async () => undefined),
    removeMembership: vi.fn(async () => undefined)
  };
}
