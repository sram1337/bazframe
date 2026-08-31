import { describe, expect, it, vi } from 'vitest';
import {
  ProfileImportBlockedError,
  ProfileImportExecutionError,
  executeProfileImport,
  type ProfileImportExecutionDependencies
} from '../../../src/profile-portability/profile-import.js';
import type { ProfileImportPlanningResult } from '../../../src/profile-portability/profile-import-plan.js';
import {
  ProfileImportPublicationError,
  type ProfileImportPublicationOptions
} from '../../../src/profile-portability/profile-import-publication.js';
import type {
  ManagedGitImportOutcomeClassification,
  ManagedGitLifecycleResult,
  ManagedGitOptions
} from '../../../src/providers/managed-git.js';
import type { PathFreeManagedGitIdentity } from '../../../src/providers/managed-git-record.js';

const home = '/tmp/bazframe-import-home';
const artifactPath = '/tmp/profile-artifact';
const revision = 'a'.repeat(40);
const source = (id: string) => ({
  type: 'remoteGit' as const,
  remote: `example.test/team/${id}`,
  fetchUrl: `https://example.test/team/${id}.git`,
  branch: 'main',
  revision
});

function health(kind: 'skill' | 'library', id: string, inode = 30n) {
  const root = `${home}/providers/git/checkouts/${kind}/${id}`;
  const record = {
    schemaVersion: 1 as const,
    kind,
    id,
    root,
    remote: `example.test/team/${id}`,
    fetchUrl: `https://example.test/team/${id}.git`,
    transport: 'git' as const,
    branch: 'main',
    revision
  };
  return {
    recordSnapshot: {
      record,
      path: `${home}/providers/git/records/${kind}/${id}.json`,
      device: 1n,
      inode,
      contentSha256: 'b'.repeat(64)
    },
    root: { path: root, device: 1n, inode: inode + 1n },
    resourceIdentity: `${kind}:${id}:identity`,
    ...(kind === 'library' ? {
      collectionSnapshot: {
        record: { schemaVersion: 1 as const, library: id, root, digest: 'c'.repeat(64) },
        path: `${home}/libraries/${id}.json`,
        device: 1n,
        inode: inode + 2n,
        contentSha256: 'd'.repeat(64)
      }
    } : {})
  };
}

interface PlanningOptions {
  resourceAction?: 'create' | 'reuse';
  profileAction?: 'publish' | 'reuse' | 'blocked';
  composition?: 'deferred' | 'ready' | 'blocked';
  blockers?: Array<{ code: string; key: string; message: string }>;
  activeProfile?: string;
  artifactInode?: bigint;
  healthInode?: bigint;
}

function planning(options: PlanningOptions = {}): ProfileImportPlanningResult {
  const resourceAction = options.resourceAction ?? 'reuse';
  const profileAction = options.profileAction ?? 'publish';
  const composition = options.composition ?? 'ready';
  const resources = [
    { kind: 'skill' as const, id: 'alpha', source: source('alpha') },
    { kind: 'skill' as const, id: 'zeta', source: source('zeta') },
    { kind: 'library' as const, id: 'toolkit', source: source('toolkit') }
  ];
  const bytes = Uint8Array.from(Buffer.from('exact instructions\r\n', 'utf8'));
  const artifact = {
    schemaVersion: 1 as const,
    kind: 'bazframe-profile-export' as const,
    profile: {
      id: 'focused',
      instructions: { path: 'profile/AGENTS.md' as const, sha256: 'e'.repeat(64) },
      skills: ['alpha', 'zeta'],
      omittedLocalSkills: ['local-only'],
      libraries: ['toolkit'],
      packages: []
    },
    resources
  };
  const snapshots = resourceAction === 'reuse'
    ? resources.map((resource, index) => ({
        kind: resource.kind,
        id: resource.id,
        health: health(resource.kind, resource.id, (options.healthInode ?? 30n) + BigInt(index * 10))
      }))
    : [];
  return {
    homePath: home,
    artifactSnapshot: {
      root: { path: artifactPath, device: 1n, inode: options.artifactInode ?? 10n },
      profileDirectory: { path: `${artifactPath}/profile`, device: 1n, inode: 11n },
      manifestBytes: Uint8Array.from(Buffer.from('{}\n')),
      artifact,
      instructions: {
        path: `${artifactPath}/profile/AGENTS.md`,
        bytes,
        device: 1n,
        inode: 12n,
        byteCount: bytes.byteLength,
        contentSha256: 'e'.repeat(64)
      }
    },
    resourceSnapshots: snapshots,
    plan: {
      artifactPath,
      schemaVersion: 1,
      exportedProfileId: 'focused',
      destinationProfileId: 'focused',
      instructions: { path: 'profile/AGENTS.md', sha256: 'e'.repeat(64) },
      skills: ['alpha', 'zeta'],
      omittedLocalSkills: ['local-only'],
      libraries: ['toolkit'],
      packages: [],
      resources: resources.map((resource) => ({
        ...resource,
        action: resourceAction,
        networkRequired: resourceAction === 'create',
        buildRequired: false as const
      })),
      activeSelection: options.activeProfile === undefined
        ? { state: 'absent' as const, willChange: false as const }
        : { state: 'selected' as const, profileId: options.activeProfile, willChange: false as const },
      composition: {
        status: composition,
        deferredLibraries: composition === 'deferred' ? ['toolkit'] : [],
        knownCollectionSkillCount: composition === 'ready' ? 1 : 0,
        knownCollectionSkillPreview: composition === 'ready' ? ['child'] : []
      },
      exclusions: {
        activeSelectionWillChange: false,
        policyWillChange: false,
        collectionChildrenEnterDefault: false
      },
      profileAction,
      blockers: options.blockers ?? []
    }
  };
}

function baseDependencies(plans: ProfileImportPlanningResult[], events: string[] = []): ProfileImportExecutionDependencies {
  let index = 0;
  return {
    planImport: vi.fn(async () => {
      events.push(`plan:${index}`);
      const value = plans[Math.min(index, plans.length - 1)]!;
      index += 1;
      return value;
    }),
    addSkillAtRevision: vi.fn(async (
      _options: ManagedGitOptions,
      id: string,
      identity: PathFreeManagedGitIdentity
    ): Promise<ManagedGitLifecycleResult> => {
      events.push(`skill:${id}:${identity.revision}`);
      return { action: plans[0]!.plan.resources.find((item) => item.id === id)!.action === 'reuse' ? 'current' : 'added', kind: 'skill', id, root: '', remote: '', branch: 'main', revision };
    }),
    addLibraryAtRevision: vi.fn(async (
      _options: ManagedGitOptions,
      id: string,
      identity: PathFreeManagedGitIdentity
    ): Promise<ManagedGitLifecycleResult> => {
      events.push(`library:${id}:${identity.revision}`);
      return { action: plans[0]!.plan.resources.find((item) => item.id === id)!.action === 'reuse' ? 'current' : 'added', kind: 'library', id, root: '', remote: '', branch: 'main', revision };
    }),
    classifyResourceOutcome: vi.fn(async (
      _home: string,
      kind: 'skill' | 'library',
      id: string
    ): Promise<ManagedGitImportOutcomeClassification> => ({ state: 'exact', health: health(kind, id) })),
    stateLock: vi.fn(async (_path, _details, operation) => {
      events.push('lock');
      return operation();
    }),
    ensureDirectory: vi.fn(async () => { events.push('ensure'); }),
    publishProfile: vi.fn(async (options: ProfileImportPublicationOptions) => {
      events.push(`publish-input:${options.skills.map((item) => item.id).join(',')}:${options.libraryIds.join(',')}`);
      let published = false;
      const action = await options.commit(async () => { published = true; events.push('rename'); });
      return { action, destinationPath: `${home}/profiles/focused`, ...(published ? { identity: { path: `${home}/profiles/focused`, device: 1n, inode: 99n } } : {}) };
    })
  };
}

const runOptions = (reportPlan: (plan: ProfileImportPlanningResult['plan']) => void | Promise<void> = () => undefined) => ({
  bazframeHome: home,
  artifactDirectory: artifactPath,
  environment: { TEST: 'stable' },
  reportPlan
});

describe('unexposed profile-import execution', () => {
  it('reports a defensive plan before blockers and performs no side effect', async () => {
    const events: string[] = [];
    const blocked = planning({ profileAction: 'blocked', composition: 'blocked', blockers: [{ code: 'BLOCKED', key: 'x', message: 'blocked' }] });
    const deps = baseDependencies([blocked], events);
    await expect(executeProfileImport(runOptions((plan) => {
      events.push('report');
      plan.resources[0]!.source.branch = 'changed';
      plan.skills.length = 0;
      plan.blockers.length = 0;
    }), deps)).rejects.toBeInstanceOf(ProfileImportBlockedError);
    expect(events).toEqual(['plan:0', 'report']);
    expect(deps.addSkillAtRevision).not.toHaveBeenCalled();
    expect(deps.stateLock).not.toHaveBeenCalled();
    expect(deps.ensureDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ['new blocker', planning(), planning({ profileAction: 'blocked', composition: 'blocked', blockers: [{ code: 'LATE', key: 'state', message: 'late blocker' }] })],
    ['displayed reuse became create', planning(), planning({ resourceAction: 'create', composition: 'deferred' })],
    ['exact destination disappeared', planning({ profileAction: 'reuse' }), planning({ profileAction: 'publish' })]
  ] as const)('replans after display and rejects %s before lifecycle or writes', async (_label, initial, refreshed) => {
    const events: string[] = [];
    const deps = baseDependencies([initial, refreshed], events);
    await expect(executeProfileImport(runOptions(() => { events.push('report'); }), deps))
      .rejects.toBeInstanceOf(ProfileImportExecutionError);
    expect(events).toEqual(['plan:0', 'report', 'plan:1']);
    expect(deps.addSkillAtRevision).not.toHaveBeenCalled();
    expect(deps.addLibraryAtRevision).not.toHaveBeenCalled();
    expect(deps.stateLock).not.toHaveBeenCalled();
    expect(deps.ensureDirectory).not.toHaveBeenCalled();
  });

  it('uses offline exact-state outcomes when the post-display replan fails', async () => {
    const initial = planning({ resourceAction: 'create', composition: 'deferred' });
    const blocked = planning({ profileAction: 'blocked', composition: 'blocked', blockers: [{ code: 'LATE', key: 'state', message: 'late blocker' }] });
    const deps = baseDependencies([initial, blocked]);
    const error = await executionError(executeProfileImport(runOptions(), deps));
    expect(error.result.resources).toEqual([
      { kind: 'skill', id: 'alpha', outcome: 'commit-ambiguous' },
      { kind: 'skill', id: 'zeta', outcome: 'commit-ambiguous' },
      { kind: 'library', id: 'toolkit', outcome: 'commit-ambiguous' }
    ]);
    expect(deps.addSkillAtRevision).not.toHaveBeenCalled();
    expect(deps.addLibraryAtRevision).not.toHaveBeenCalled();
  });

  it('processes exact Skills lexically before libraries and publishes only direct memberships', async () => {
    const events: string[] = [];
    const initial = planning({ resourceAction: 'create', composition: 'deferred' });
    const ready = planning();
    const deps = baseDependencies([initial, initial, ready, ready], events);
    let entered!: ReturnType<typeof runOptions> & { acquisitionLimits: { maxCheckoutEntries: number } };
    entered = {
      ...runOptions((plan) => {
        events.push('report');
        plan.resources[0]!.source.branch = 'mutated';
        plan.skills.splice(0);
        entered.environment.TEST = 'mutated';
        entered.acquisitionLimits.maxCheckoutEntries = 1;
      }),
      acquisitionLimits: { maxCheckoutEntries: 100 }
    };
    const result = await executeProfileImport(entered, deps);
    expect(events).toEqual([
      'plan:0', 'report', 'plan:1',
      `skill:alpha:${revision}`, `skill:zeta:${revision}`, `library:toolkit:${revision}`,
      'plan:2', 'lock', 'ensure', 'publish-input:alpha,zeta:toolkit', 'lock', 'plan:3', 'rename'
    ]);
    expect(result).toMatchObject({
      profileOutcome: 'published',
      activeSelectionChanged: false,
      resources: [
        { kind: 'skill', id: 'alpha', outcome: 'created' },
        { kind: 'skill', id: 'zeta', outcome: 'created' },
        { kind: 'library', id: 'toolkit', outcome: 'created' }
      ]
    });
    expect(deps.addSkillAtRevision).toHaveBeenCalledWith(
      expect.any(Object), 'alpha',
      { remote: 'example.test/team/alpha', fetchUrl: 'https://example.test/team/alpha.git', branch: 'main', revision },
      undefined
    );
    expect((deps.publishProfile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty('omittedLocalSkills');
    expect((deps.addSkillAtRevision as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      environment: { TEST: 'stable' },
      acquisitionLimits: { maxCheckoutEntries: 100 }
    });
  });

  it('rejects artifact or retained exact-dependency drift in the post-acquisition inspection', async () => {
    const creating = planning({ resourceAction: 'create', composition: 'deferred' });
    const artifactChanged = planning({ artifactInode: 999n });
    const artifactDeps = baseDependencies([creating, artifactChanged]);
    const artifactError = await executionError(executeProfileImport(runOptions(), artifactDeps));
    expect(artifactError.result.profileOutcome).toBe('not-published');
    expect(artifactDeps.publishProfile).not.toHaveBeenCalled();

    const reusable = planning({ profileAction: 'publish' });
    const dependencyChanged = planning({ profileAction: 'publish', healthInode: 999n });
    const dependencyDeps = baseDependencies([reusable, dependencyChanged]);
    const dependencyError = await executionError(executeProfileImport(runOptions(), dependencyDeps));
    expect(dependencyError.result.profileOutcome).toBe('not-published');
    expect(dependencyDeps.publishProfile).not.toHaveBeenCalled();
  });

  it('reuses exact resources and destination without staging or rewriting', async () => {
    const exact = planning({ profileAction: 'reuse' });
    const deps = baseDependencies([exact, exact, exact]);
    const result = await executeProfileImport(runOptions(), deps);
    expect(result.profileOutcome).toBe('reused');
    expect(result.resources.every((item) => item.outcome === 'reused')).toBe(true);
    expect(deps.publishProfile).not.toHaveBeenCalled();
    expect(deps.ensureDirectory).not.toHaveBeenCalled();
    expect(deps.addSkillAtRevision).toHaveBeenCalledWith(
      expect.any(Object),
      'alpha',
      expect.objectContaining({ revision }),
      expect.objectContaining({ mode: 'must-reuse', expectedHealth: expect.any(Object) })
    );
  });

  it('refuses to switch an initially reusable destination to publication', async () => {
    const initial = planning({ profileAction: 'reuse' });
    const disappeared = planning({ profileAction: 'publish' });
    const deps = baseDependencies([initial, disappeared]);
    const error = await executionError(executeProfileImport(runOptions(), deps));
    expect(error.result.profileOutcome).toBe('not-published');
    expect(deps.publishProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['artifact identity', planning({ artifactInode: 999n })],
    ['dependency identity', planning({ healthInode: 999n })]
  ])('blocks final %s drift while retaining global resources', async (_label, final) => {
    const initial = planning({ resourceAction: 'create', composition: 'deferred' });
    const authoritative = planning();
    const deps = baseDependencies([initial, initial, authoritative, final]);
    const error = await executionError(executeProfileImport(runOptions(), deps));
    expect(error.result.profileOutcome).toBe('not-published');
    expect(error.result.resources.every((item) => item.outcome === 'created')).toBe(true);
  });

  it('accepts a valid current-active change and discards staging for locked concurrent exact reuse', async () => {
    const initial = planning({ resourceAction: 'create', composition: 'deferred', activeProfile: 'one' });
    const authoritative = planning({ activeProfile: 'two' });
    const finalReuse = planning({ profileAction: 'reuse', activeProfile: 'three' });
    const deps = baseDependencies([initial, initial, authoritative, finalReuse]);
    const result = await executeProfileImport(runOptions(), deps);
    expect(result.profileOutcome).toBe('reused');
    expect(deps.publishProfile).toHaveBeenCalledOnce();
    expect((deps.publishProfile as ReturnType<typeof vi.fn>).mock.results[0]).toBeDefined();
  });

  it('reports deterministic partial exact, recovery, absent, and ambiguous resource outcomes', async () => {
    const initial = planning({ resourceAction: 'create', composition: 'deferred' });
    const deps = baseDependencies([initial]);
    (deps.addLibraryAtRevision as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('library failed'));
    (deps.classifyResourceOutcome as ReturnType<typeof vi.fn>).mockImplementation(async (_home, kind: string, id: string) => {
      if (id === 'alpha') return { state: 'exact', health: health('skill', id) };
      if (id === 'zeta') return { state: 'absent' };
      if (kind === 'library') return { state: 'recovery-required' };
      return { state: 'ambiguous', reason: 'changed' };
    });
    const error = await executionError(executeProfileImport(runOptions(), deps));
    expect(error.result.resources).toEqual([
      { kind: 'skill', id: 'alpha', outcome: 'created' },
      { kind: 'skill', id: 'zeta', outcome: 'not-created' },
      { kind: 'library', id: 'toolkit', outcome: 'recovery-required' }
    ]);
    expect(error.result.profileOutcome).toBe('not-published');
  });

  it('does not claim creation when a create lifecycle throws but exact state is later observed', async () => {
    const initial = planning({ resourceAction: 'create', composition: 'deferred' });
    const deps = baseDependencies([initial, initial]);
    (deps.addSkillAtRevision as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('commit reporting failed'));
    (deps.classifyResourceOutcome as ReturnType<typeof vi.fn>).mockImplementation(async (_home, kind: 'skill' | 'library', id: string) => ({
      state: 'exact',
      health: health(kind, id)
    }));
    const error = await executionError(executeProfileImport(runOptions(), deps));
    expect(error.result.resources[0]).toEqual({ kind: 'skill', id: 'alpha', outcome: 'commit-ambiguous' });
  });

  it('preserves proven reuse across lock-release failure', async () => {
    const exact = planning({ profileAction: 'reuse' });
    const deps = baseDependencies([exact, exact, exact]);
    (deps.stateLock as ReturnType<typeof vi.fn>).mockImplementation(async (_path, _details, operation) => {
      await operation();
      throw new Error('release failed');
    });
    const error = await executionError(executeProfileImport(runOptions(), deps));
    expect(error.result.profileOutcome).toBe('reused');
  });

  it('preserves proven publication and publisher ambiguity in structured errors', async () => {
    const initial = planning({ resourceAction: 'create', composition: 'deferred' });
    const ready = planning();
    const publishedDeps = baseDependencies([initial, initial, ready, ready]);
    (publishedDeps.publishProfile as ReturnType<typeof vi.fn>).mockImplementation(async (options) => {
      await options.commit(async () => undefined).catch(() => undefined);
      throw new ProfileImportPublicationError('published', `${home}/profiles/focused`, `${home}/profiles/.tmp`, new Error('release'));
    });
    const published = await executionError(executeProfileImport(runOptions(), publishedDeps));
    expect(published.result.profileOutcome).toBe('published');

    const ambiguousDeps = baseDependencies([initial, initial, ready, ready]);
    (ambiguousDeps.publishProfile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ProfileImportPublicationError('commit-ambiguous', `${home}/profiles/focused`, `${home}/profiles/.tmp`, new Error('ambiguous'))
    );
    const ambiguous = await executionError(executeProfileImport(runOptions(), ambiguousDeps));
    expect(ambiguous.result.profileOutcome).toBe('commit-ambiguous');
  });
});

async function executionError(promise: Promise<unknown>): Promise<ProfileImportExecutionError> {
  try { await promise; }
  catch (error) {
    expect(error).toBeInstanceOf(ProfileImportExecutionError);
    return error as ProfileImportExecutionError;
  }
  throw new Error('Expected execution error');
}
