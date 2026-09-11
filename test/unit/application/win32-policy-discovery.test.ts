import { describe, expect, it, vi } from 'vitest';
import { windowsApplicationFixture, HOME, REPOSITORY } from '../../helpers/windows-application-fixture.js';
import { disableGlobally, enableGlobally, readGlobalPolicy } from '../../../src/policy/global-policy.js';
import { disableRepository, enableRepository, listRepositoryProjectStates, readRepositoryProjectState } from '../../../src/project/registration-store.js';
import { repositoryRegistrationPath } from '../../../src/project/registration.js';
import { findGitRoot } from '../../../src/project/git-root.js';
import { createWindowsGitRootServices } from '../../../src/project/win32-git-root.js';

describe('shared Windows policy/discovery adverse paths', () => {
  it('roundtrips precedence and retained project/global removals without following retained payloads', async () => {
    const f = windowsApplicationFixture(), services = f.application.policy!;
    const before = f.snapshot(); expect(await readGlobalPolicy(HOME, services)).toBe('enabled'); expect(f.snapshot()).toBe(before);
    await disableRepository(HOME, REPOSITORY, services);
    expect((await readRepositoryProjectState(HOME, REPOSITORY, services))?.schemaVersion).toBe(2);
    await disableGlobally(HOME, services);
    await enableRepository(HOME, REPOSITORY, services);
    expect((await readRepositoryProjectState(HOME, REPOSITORY, services))?.schemaVersion).toBe(3);
    await enableGlobally(HOME, services);
    await enableRepository(HOME, REPOSITORY, services);
    expect(await readRepositoryProjectState(HOME, REPOSITORY, services)).toBeUndefined();
    f.reparse(HOME + '\\projects\\.bazframe-policy-' + 'a'.repeat(32) + '.retained');
    expect(await listRepositoryProjectStates(HOME, services)).toEqual({ projectStates: [], diagnostics: [] });
    expect([...f.nodes.keys()].some((path) => /\.retained$/u.test(path))).toBe(true);
  });
  it.each(['malformed', 'oversized', 'hardlink', 'reparse', 'alias'])('refuses %s policy state without mutation', async (kind) => {
    const f = windowsApplicationFixture(); f.file(HOME + '\\global.json', '{"schemaVersion":1,"policy":"disabled"}');
    if (kind === 'malformed') f.file(HOME + '\\global.json', '{');
    if (kind === 'oversized') f.file(HOME + '\\global.json', ' '.repeat(64 * 1024 + 1));
    if (kind === 'hardlink') f.nodes.get(HOME + '\\global.json')!.numberOfLinks = 2;
    if (kind === 'reparse') f.reparse(HOME + '\\global.json');
    if (kind === 'alias') f.file(HOME + '\\GLOBAL.JSON', '{}');
    const before = f.snapshot(); await expect(readGlobalPolicy(HOME, f.application.policy)).rejects.toThrow(); expect(f.snapshot()).toBe(before);
  });
  it('rejects project filename/repository mismatches and stale expected-old writes', async () => {
    const f = windowsApplicationFixture(), services = f.application.policy!;
    await disableRepository(HOME, REPOSITORY, services);
    const file = repositoryRegistrationPath(HOME, REPOSITORY, services.paths), expected = await services.snapshot(file, 65536);
    const value = JSON.parse(f.nodes.get(file)!.bytes!.toString()); value.repository = 'C:\\boundary\\other'; f.file(file, JSON.stringify(value));
    expect((await listRepositoryProjectStates(HOME, services)).diagnostics).toHaveLength(1);
    await expect(services.withLock(HOME, 'stale test', (writer) => writer.publish(file, Buffer.from('{}'), expected, 65536))).rejects.toThrow(/changed/);
  });
  it.each(['C:/boundary/repo', 'C:\\boundary\\repo'])('accepts Git absolute output %s and physically inspects normalized local spelling', async (root) => {
    const f = windowsApplicationFixture(); f.directories(REPOSITORY + '\\nested');
    const inspect = vi.spyOn(f.backend, 'inspectPath');
    const services = createWindowsGitRootServices(f.backend, { executableEffects: f.options.executableEffects, process: async () => ({ status: 0, stdout: root + '\r\n', stderr: '' }) });
    const before = f.snapshot();
    expect(await findGitRoot(REPOSITORY + '\\nested', f.environment, services)).toBe(REPOSITORY);
    expect(inspect).toHaveBeenCalledWith(REPOSITORY);
    expect(inspect.mock.calls.some(([path]) => path.includes('/'))).toBe(false);
    expect(f.snapshot()).toBe(before);
  });
  it.each(['relative', 'C:repo', '/boundary/repo', '\\boundary\\repo', '//server/share/repo', '\\\\server\\share\\repo', '\\\\?\\C:\\boundary\\repo'])('refuses non-local-absolute discovery input %s before native admission', async (root) => {
    const f = windowsApplicationFixture(), inspect = vi.spyOn(f.backend, 'inspectPath');
    const services = createWindowsGitRootServices(f.backend);
    await expect(services.canonical(root)).rejects.toMatchObject({ code: 'GIT_ROOT_INVALID' });
    expect(inspect).not.toHaveBeenCalled();
  });
  it.each(['reparse', 'file', 'ancestry'] as const)('does not let slash normalization bypass %s physical admission', async (kind) => {
    const f = windowsApplicationFixture();
    if (kind === 'reparse') f.reparse(REPOSITORY);
    if (kind === 'file') f.file(REPOSITORY, 'not a directory');
    if (kind === 'ancestry') { const inspect = f.backend.inspectPath; f.backend.inspectPath = (path) => ({ ...inspect(path), ancestryReparseFree: false }) as unknown as ReturnType<typeof inspect>; }
    await expect(createWindowsGitRootServices(f.backend).canonical('C:/boundary/repo')).rejects.toThrow();
  });
  it.each(['outside', 'permission', 'missing-git', 'timeout', 'malformed', 'mismatch', 'mixed-diagnostic'])('distinguishes discovery outcome %s without policy/state creation', async (outcome) => {
    const f = windowsApplicationFixture(); f.directories('C:\\boundary\\other');
    const before = f.snapshot(); let observedEnvironment: NodeJS.ProcessEnv = {};
    const services = createWindowsGitRootServices(f.backend, { executableEffects: f.options.executableEffects, process: async (_exe, _args, _cwd, environment) => {
      observedEnvironment = environment;
      if (outcome === 'missing-git') return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('missing'), { code: 'ENOENT' }) };
      if (outcome === 'timeout') return { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git', failure: 'timeout' };
      if (outcome === 'permission') return { status: 128, stdout: '', stderr: 'fatal: permission denied' };
      if (outcome === 'outside' || outcome === 'mixed-diagnostic') return { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' + (outcome === 'mixed-diagnostic' ? '\nother failure' : '\n') };
      return { status: 0, stdout: outcome === 'malformed' ? 'relative\n' : 'C:\\boundary\\other\n', stderr: '' };
    } });
    const error = await findGitRoot(REPOSITORY, { ...f.environment, Git_Dir: 'C:\\foreign', lc_all: 'fr_FR' }, services).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: outcome === 'outside' ? 'NOT_GIT_WORKTREE' : outcome === 'missing-git' ? 'GIT_NOT_FOUND' : outcome === 'malformed' ? 'GIT_ROOT_INVALID' : outcome === 'mismatch' ? 'GIT_ROOT_MISMATCH' : 'GIT_DISCOVERY_FAILED' });
    expect(observedEnvironment.Git_Dir).toBeUndefined(); expect(observedEnvironment.LC_ALL).toBe('C'); expect(observedEnvironment.lc_all).toBeUndefined();
    expect(f.snapshot()).toBe(before);
  });
});
