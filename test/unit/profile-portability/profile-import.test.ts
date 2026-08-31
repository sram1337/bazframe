import { describe, expect, it, vi } from 'vitest';
import {
  ProfileImportBlockedError,
  ProfileImportExecutionError,
  executeProfileImport,
  type ProfileImportExecutionDependencies
} from '../../../src/profile-portability/profile-import.js';
import type {
  ProfileImportPlanningResult,
  ProfileImportResourceSnapshot
} from '../../../src/profile-portability/profile-import-plan.js';
import type {
  LocalLibraryHealthSnapshot,
  LocalLibraryImportOutcomeClassification
} from '../../../src/profile-portability/profile-import-local-library.js';
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
        sourceType: 'remoteGit' as const,
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
    mappingSnapshots: [],
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

function localPlanning(action: 'create' | 'reuse', root = '/tmp/sources/toolkit'): ProfileImportPlanningResult {
  const base = planning({
    resourceAction: action,
    composition: action === 'create' ? 'deferred' : 'ready'
  });
  const mapping = { kind: 'library' as const, id: 'toolkit', root, device: 9n, inode: 90n };
  const localHealth: LocalLibraryHealthSnapshot = {
    mapping,
    collectionSnapshot: {
      record: { schemaVersion: 1, library: 'toolkit', root, digest: 'd'.repeat(64) },
      path: `${home}/libraries/toolkit.json`,
      device: 8n,
      inode: 80n,
      contentSha256: 'c'.repeat(64)
    }
  };
  base.artifactSnapshot.artifact.profile.skills = [];
  base.artifactSnapshot.artifact.resources = [{ kind: 'library', id: 'toolkit', source: { type: 'localMapping' } }];
  base.plan.skills = [];
  base.plan.resources = [{
    kind: 'library', id: 'toolkit', source: { type: 'localMapping', root }, action,
    networkRequired: false, buildRequired: false
  }];
  base.plan.composition = {
    status: action === 'create' ? 'deferred' : 'ready',
    deferredLibraries: action === 'create' ? ['toolkit'] : [],
    knownCollectionSkillCount: action === 'reuse' ? 1 : 0,
    knownCollectionSkillPreview: action === 'reuse' ? ['child'] : []
  };
  base.mappingSnapshots = [mapping];
  base.resourceSnapshots = action === 'reuse' ? [{ kind: 'library', id: 'toolkit', sourceType: 'localMapping', health: localHealth }] : [];
  return base;
}

function mixedPlanning(action: 'create' | 'reuse'): ProfileImportPlanningResult {
  const base = planning({ resourceAction: action, composition: action === 'create' ? 'deferred' : 'ready' });
  const mapping = { kind: 'library' as const, id: 'middle', root: '/tmp/sources/middle', device: 9n, inode: 90n };
  const localHealth: LocalLibraryHealthSnapshot = {
    mapping,
    collectionSnapshot: {
      record: { schemaVersion: 1, library: 'middle', root: mapping.root, digest: 'd'.repeat(64) },
      path: `${home}/libraries/middle.json`, device: 8n, inode: 80n, contentSha256: 'c'.repeat(64)
    }
  };
  const resources: Array<
    | { kind: 'skill'; id: string; source: ReturnType<typeof source> }
    | { kind: 'library'; id: string; source: ReturnType<typeof source> }
    | { kind: 'library'; id: string; source: { type: 'localMapping' } }
  > = [
    { kind: 'skill', id: 'alpha', source: source('alpha') },
    { kind: 'skill', id: 'zeta', source: source('zeta') },
    { kind: 'library', id: 'alpha-lib', source: source('alpha-lib') },
    { kind: 'library', id: 'middle', source: { type: 'localMapping' } },
    { kind: 'library', id: 'zeta-lib', source: source('zeta-lib') }
  ];
  base.artifactSnapshot.artifact.profile.libraries = ['alpha-lib', 'middle', 'zeta-lib'];
  base.artifactSnapshot.artifact.resources = resources;
  base.plan.libraries = ['alpha-lib', 'middle', 'zeta-lib'];
  base.plan.resources = resources.map((resource): ProfileImportPlanningResult['plan']['resources'][number] => {
    if (resource.source.type === 'localMapping') {
      return {
        kind: 'library', id: resource.id, source: { type: 'localMapping', root: mapping.root }, action,
        networkRequired: false, buildRequired: false
      };
    }
    if (resource.kind === 'skill') {
      return {
        kind: 'skill', id: resource.id, source: { ...resource.source }, action,
        networkRequired: action === 'create', buildRequired: false
      };
    }
    return {
      kind: 'library', id: resource.id, source: { ...resource.source }, action,
      networkRequired: action === 'create', buildRequired: false
    };
  });
  base.plan.composition = {
    status: action === 'create' ? 'deferred' : 'ready',
    deferredLibraries: action === 'create' ? ['alpha-lib', 'middle', 'zeta-lib'] : [],
    knownCollectionSkillCount: action === 'reuse' ? 3 : 0,
    knownCollectionSkillPreview: action === 'reuse' ? ['alpha-child', 'middle-child', 'zeta-child'] : []
  };
  base.mappingSnapshots = [mapping];
  base.resourceSnapshots = action === 'reuse' ? [
    { kind: 'skill', id: 'alpha', sourceType: 'remoteGit' as const, health: health('skill', 'alpha', 30n) },
    { kind: 'skill', id: 'zeta', sourceType: 'remoteGit' as const, health: health('skill', 'zeta', 40n) },
    { kind: 'library', id: 'alpha-lib', sourceType: 'remoteGit' as const, health: health('library', 'alpha-lib', 50n) },
    { kind: 'library', id: 'middle', sourceType: 'localMapping' as const, health: localHealth },
    { kind: 'library', id: 'zeta-lib', sourceType: 'remoteGit' as const, health: health('library', 'zeta-lib', 60n) }
  ] : [];
  return base;
}

function driftLocalPlanning(field: 'root' | 'device' | 'inode'): ProfileImportPlanningResult {
  const result = localPlanning('reuse');
  const mapping = result.mappingSnapshots[0]!;
  if (field === 'root') mapping.root = '/tmp/changed/toolkit';
  else if (field === 'device') mapping.device += 1n;
  else mapping.inode += 1n;
  const resource = result.plan.resources[0]!;
  if (resource.source.type === 'localMapping') resource.source.root = mapping.root;
  const snapshot = result.resourceSnapshots[0]!;
  if (snapshot.sourceType !== 'localMapping') throw new Error('Expected local drift fixture health.');
  snapshot.health.mapping = { ...mapping };
  snapshot.health.collectionSnapshot.record.root = mapping.root;
  return result;
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
      const source = plan.resources[0]!.source;
      if (source.type === 'remoteGit') source.branch = 'changed';
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
        const source = plan.resources[0]!.source;
        if (source.type === 'remoteGit') source.branch = 'mutated';
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

  it('orders interleaved remote and mapped libraries lexically after all direct Skills', async () => {
    const events: string[] = [];
    const create = mixedPlanning('create');
    const exact = mixedPlanning('reuse');
    const deps = baseDependencies([create, create, exact, exact], events);
    deps.assertLocalMapping = vi.fn(async (mapping) => mapping);
    deps.classifyLocalLibraryOutcome = vi.fn(async () => ({ state: 'absent' as const }));
    deps.addLocalLibrary = vi.fn(async (_options, root) => {
      events.push(`local-add:${root}`);
      return {
        schemaVersion: 1 as const, library: 'middle', root, digest: 'd'.repeat(64),
        action: 'added' as const, path: `${home}/libraries/middle.json`
      };
    });
    const result = await executeProfileImport({
      ...runOptions(() => { events.push('report'); }),
      mappings: [{ kind: 'library', id: 'middle', root: '/tmp/sources/middle' }]
    }, deps);
    const lifecycleEvents = events.filter((event) => event.startsWith('skill:')
      || event.startsWith('library:') || event.startsWith('local-add:'));
    expect(lifecycleEvents).toEqual([
      `skill:alpha:${revision}`,
      `skill:zeta:${revision}`,
      `library:alpha-lib:${revision}`,
      'local-add:/tmp/sources/middle',
      `library:zeta-lib:${revision}`
    ]);
    expect(events.indexOf(`library:zeta-lib:${revision}`)).toBeLessThan(events.indexOf('publish-input:alpha,zeta:alpha-lib,middle,zeta-lib'));
    expect(events.indexOf('publish-input:alpha,zeta:alpha-lib,middle,zeta-lib')).toBeLessThan(events.indexOf('rename'));
    expect(result.resources).toEqual([
      { kind: 'skill', id: 'alpha', outcome: 'created' },
      { kind: 'skill', id: 'zeta', outcome: 'created' },
      { kind: 'library', id: 'alpha-lib', outcome: 'created' },
      { kind: 'library', id: 'middle', outcome: 'created' },
      { kind: 'library', id: 'zeta-lib', outcome: 'created' }
    ]);
    expect(deps.addLocalLibrary).toHaveBeenCalledWith(
      expect.any(Object), '/tmp/sources/middle',
      { stateLockHeld: true, expectedRootIdentity: { root: '/tmp/sources/middle', device: 9n, inode: 90n } }
    );
    expect((deps.publishProfile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      skills: [{ id: 'alpha' }, { id: 'zeta' }],
      libraryIds: ['alpha-lib', 'middle', 'zeta-lib']
    });
  });

  it('creates a mapped local library through the ordinary lifecycle and revalidates it before publication', async () => {
    const events: string[] = [];
    const create = localPlanning('create');
    const exact = localPlanning('reuse');
    const deps = baseDependencies([create, create, exact, exact], events);
    deps.assertLocalMapping = vi.fn(async (mapping) => { events.push(`mapping:${mapping.id}`); return mapping; });
    deps.addLocalLibrary = vi.fn(async (_options, root) => {
      events.push(`local-add:${root}`);
      return { schemaVersion: 1 as const, library: 'toolkit', root, digest: 'd'.repeat(64), action: 'added' as const, path: `${home}/libraries/toolkit.json` };
    });
    const exactSnapshot = exact.resourceSnapshots[0]!;
    if (exactSnapshot.sourceType !== 'localMapping') throw new Error('Expected local fixture health.');
    deps.classifyLocalLibraryOutcome = vi.fn()
      .mockResolvedValueOnce({ state: 'absent' })
      .mockResolvedValue({ state: 'exact', health: exactSnapshot.health });
    const result = await executeProfileImport({
      ...runOptions(() => { events.push('report'); }),
      mappings: [{ kind: 'library', id: 'toolkit', root: '/tmp/sources/toolkit' }]
    }, deps);
    expect(result.resources).toEqual([{ kind: 'library', id: 'toolkit', outcome: 'created' }]);
    expect(deps.addLocalLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ bazframeHome: home }),
      '/tmp/sources/toolkit',
      {
        stateLockHeld: true,
        expectedRootIdentity: { root: '/tmp/sources/toolkit', device: 9n, inode: 90n }
      }
    );
    expect(deps.addSkillAtRevision).not.toHaveBeenCalled();
    expect(deps.addLibraryAtRevision).not.toHaveBeenCalled();
    expect(events.indexOf('report')).toBeLessThan(events.indexOf('local-add:/tmp/sources/toolkit'));
    expect(events.filter((event) => event.startsWith('plan:')).length).toBe(4);
  });

  it.each(['root', 'device', 'inode'] as const)('blocks mapped %s drift at the post-acquisition authoritative replan', async (field) => {
    const events: string[] = [];
    const create = localPlanning('create');
    const changed = driftLocalPlanning(field);
    const exact = localPlanning('reuse');
    const deps = baseDependencies([create, create, changed], events);
    deps.assertLocalMapping = vi.fn(async (mapping) => mapping);
    deps.addLocalLibrary = vi.fn(async (_options, root) => ({
      schemaVersion: 1 as const, library: 'toolkit', root, digest: 'd'.repeat(64),
      action: 'added' as const, path: `${home}/libraries/toolkit.json`
    }));
    const exactSnapshot = exact.resourceSnapshots[0]!;
    if (exactSnapshot.sourceType !== 'localMapping') throw new Error('Expected exact local fixture health.');
    deps.classifyLocalLibraryOutcome = vi.fn()
      .mockResolvedValueOnce({ state: 'absent' })
      .mockResolvedValue({ state: 'exact', health: exactSnapshot.health });
    const error = await executionError(executeProfileImport({
      ...runOptions(), mappings: [{ kind: 'library', id: 'toolkit', root: '/tmp/sources/toolkit' }]
    }, deps));
    expect(error.result).toMatchObject({
      resources: [{ kind: 'library', id: 'toolkit', outcome: 'created' }],
      profileOutcome: 'not-published'
    });
    expect(deps.publishProfile).not.toHaveBeenCalled();
    expect(events).not.toContain('rename');
  });

  it.each(['root', 'device', 'inode'] as const)('blocks mapped %s drift at the final lock-held replan', async (field) => {
    const events: string[] = [];
    const create = localPlanning('create');
    const exact = localPlanning('reuse');
    const changed = driftLocalPlanning(field);
    const deps = baseDependencies([create, create, exact, changed], events);
    deps.assertLocalMapping = vi.fn(async (mapping) => mapping);
    deps.addLocalLibrary = vi.fn(async (_options, root) => ({
      schemaVersion: 1 as const, library: 'toolkit', root, digest: 'd'.repeat(64),
      action: 'added' as const, path: `${home}/libraries/toolkit.json`
    }));
    const exactSnapshot = exact.resourceSnapshots[0]!;
    if (exactSnapshot.sourceType !== 'localMapping') throw new Error('Expected exact local fixture health.');
    deps.classifyLocalLibraryOutcome = vi.fn()
      .mockResolvedValueOnce({ state: 'absent' })
      .mockResolvedValue({ state: 'exact', health: exactSnapshot.health });
    const error = await executionError(executeProfileImport({
      ...runOptions(), mappings: [{ kind: 'library', id: 'toolkit', root: '/tmp/sources/toolkit' }]
    }, deps));
    expect(error.result).toMatchObject({
      resources: [{ kind: 'library', id: 'toolkit', outcome: 'created' }],
      profileOutcome: 'not-published'
    });
    expect(deps.publishProfile).toHaveBeenCalledOnce();
    expect(events).not.toContain('rename');
    const finalPlanIndex = events.lastIndexOf('plan:3');
    expect(events.lastIndexOf('lock')).toBeLessThan(finalPlanIndex);
  });

  it('refuses provider occupancy introduced at the locked local-create boundary', async () => {
    const events: string[] = [];
    const create = localPlanning('create');
    const deps = baseDependencies([create, create], events);
    deps.assertLocalMapping = vi.fn(async (mapping) => mapping);
    deps.addLocalLibrary = vi.fn();
    deps.classifyLocalLibraryOutcome = vi.fn(async () => {
      events.push('provider-occupancy');
      return { state: 'ambiguous' as const, reason: 'provider occupancy appeared' };
    });
    const error = await executionError(executeProfileImport({
      ...runOptions(), mappings: [{ kind: 'library', id: 'toolkit', root: '/tmp/sources/toolkit' }]
    }, deps));
    expect(error.result.resources).toEqual([{ kind: 'library', id: 'toolkit', outcome: 'commit-ambiguous' }]);
    expect(deps.addLocalLibrary).not.toHaveBeenCalled();
    expect(events.indexOf('lock')).toBeLessThan(events.indexOf('provider-occupancy'));
    expect(deps.stateLock).toHaveBeenCalledWith(
      expect.stringContaining('state.lock'),
      expect.objectContaining({ command: 'bazframe profile import local library' }),
      expect.any(Function),
      expect.objectContaining({ managedRoot: home })
    );
  });

  it('refuses mapped-root identity substitution at the importer-to-lifecycle boundary', async () => {
    const create = localPlanning('create');
    const deps = baseDependencies([create, create]);
    deps.assertLocalMapping = vi.fn(async (mapping) => ({ ...mapping, inode: mapping.inode + 1n }));
    deps.addLocalLibrary = vi.fn();
    deps.classifyLocalLibraryOutcome = vi.fn(async () => ({ state: 'absent' as const }));
    const error = await executionError(executeProfileImport({
      ...runOptions(), mappings: [{ kind: 'library', id: 'toolkit', root: '/tmp/sources/toolkit' }]
    }, deps));
    expect(error.result.resources).toEqual([{ kind: 'library', id: 'toolkit', outcome: 'not-created' }]);
    expect(deps.addLocalLibrary).not.toHaveBeenCalled();
  });

  it('reuses an exact mapped local library without invoking its lifecycle', async () => {
    const exact = localPlanning('reuse');
    const deps = baseDependencies([exact, exact, exact, exact]);
    deps.assertLocalMapping = vi.fn(async (mapping) => mapping);
    deps.addLocalLibrary = vi.fn();
    const exactSnapshot = exact.resourceSnapshots[0]!;
    if (exactSnapshot.sourceType !== 'localMapping') throw new Error('Expected local fixture health.');
    // @ts-expect-error Internal planning evidence cannot pair local health with a remote Git source.
    const impossible: ProfileImportResourceSnapshot = { kind: 'library', id: 'toolkit', sourceType: 'remoteGit', health: exactSnapshot.health };
    expect(impossible.sourceType).toBe('remoteGit');
    deps.classifyLocalLibraryOutcome = vi.fn(async (): Promise<LocalLibraryImportOutcomeClassification> => ({
      state: 'exact', health: exactSnapshot.health
    }));
    const result = await executeProfileImport({
      ...runOptions(), mappings: [{ kind: 'library', id: 'toolkit', root: '/tmp/sources/toolkit' }]
    }, deps);
    expect(result.resources).toEqual([{ kind: 'library', id: 'toolkit', outcome: 'reused' }]);
    expect(deps.addLocalLibrary).not.toHaveBeenCalled();
    expect(deps.classifyLocalLibraryOutcome).toHaveBeenCalled();
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

  it('classifies exact local state after a thrown create as commit-ambiguous', async () => {
    const create = localPlanning('create');
    const exact = localPlanning('reuse');
    const deps = baseDependencies([create, create]);
    deps.assertLocalMapping = vi.fn(async (mapping) => mapping);
    deps.addLocalLibrary = vi.fn(async () => { throw new Error('local add reporting failed at /private/source/toolkit and /private/home'); });
    const exactSnapshot = exact.resourceSnapshots[0]!;
    if (exactSnapshot.sourceType !== 'localMapping') throw new Error('Expected local fixture health.');
    deps.classifyLocalLibraryOutcome = vi.fn()
      .mockResolvedValueOnce({ state: 'absent' })
      .mockResolvedValue({ state: 'exact', health: exactSnapshot.health });
    const error = await executionError(executeProfileImport({
      ...runOptions(), mappings: [{ kind: 'library', id: 'toolkit', root: '/tmp/sources/toolkit' }]
    }, deps));
    expect(error.result.resources).toEqual([{ kind: 'library', id: 'toolkit', outcome: 'commit-ambiguous' }]);
    expect(error.cause).toMatchObject({
      code: 'PROFILE_IMPORT_LOCAL_LIBRARY_FAILED',
      message: 'Mapped local library toolkit creation did not complete safely.'
    });
    expect((error.cause as Error).message).not.toContain('/private');
  });

  it('keeps a committed local create ambiguous when global-lock release fails', async () => {
    const create = localPlanning('create');
    const exact = localPlanning('reuse');
    const deps = baseDependencies([create, create]);
    deps.assertLocalMapping = vi.fn(async (mapping) => mapping);
    deps.addLocalLibrary = vi.fn(async (_options, root) => ({
      schemaVersion: 1 as const,
      library: 'toolkit',
      root,
      digest: 'd'.repeat(64),
      action: 'added' as const,
      path: `${home}/libraries/toolkit.json`
    }));
    const exactSnapshot = exact.resourceSnapshots[0]!;
    if (exactSnapshot.sourceType !== 'localMapping') throw new Error('Expected local fixture health.');
    deps.classifyLocalLibraryOutcome = vi.fn()
      .mockResolvedValueOnce({ state: 'absent' })
      .mockResolvedValue({ state: 'exact', health: exactSnapshot.health });
    (deps.stateLock as ReturnType<typeof vi.fn>).mockImplementation(async (_path, _details, operation) => {
      await operation();
      throw new Error('release failed after local commit');
    });
    const error = await executionError(executeProfileImport({
      ...runOptions(), mappings: [{ kind: 'library', id: 'toolkit', root: '/tmp/sources/toolkit' }]
    }, deps));
    expect(error.result.resources).toEqual([{ kind: 'library', id: 'toolkit', outcome: 'commit-ambiguous' }]);
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
