import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsGitHostFixture } from '../../helpers/windows-git-host-fixture.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readlinkSync: vi.fn(actual.readlinkSync) };
});
const fixtures: ReturnType<typeof windowsGitHostFixture>[] = [];
afterEach(() => {
  vi.mocked(readlinkSync).mockReset();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe('Windows Git host fixture symlink diagnostics (not native admission)', () => {
  it.each(['absent', 'directory', 'file'] as const)('refuses an unknown dangling host symlink with its literal target and %s virtual node', (kind) => {
    const f = windowsGitHostFixture(); fixtures.push(f);
    const name = 'C:\\boundary\\unknown', path = f.hostPath(name), literalTarget = './missing-target';
    if (kind === 'directory') f.directory(name);
    if (kind === 'file') f.file(name, 'virtual file');
    const prior = f.nodes.get(name);
    symlinkSync(literalTarget, path);
    expect(() => f.refresh()).toThrow(`Host translator does not invent Windows junctions for Git symlinks: ${JSON.stringify({ path, name, literalTarget, node: prior === undefined ? null : { kind: prior.kind, id: prior.id } })}`);
    expect(vi.mocked(readlinkSync)).toHaveBeenCalledWith(path);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(f.nodes.get(name)).toBe(prior);
  });

  it('preserves a configured synthetic junction without invoking the unknown-link diagnostic', () => {
    const f = windowsGitHostFixture(); fixtures.push(f);
    f.backend.createPrivateDirectory('C:\\boundary', 'target');
    const before = f.backend.createPrivateJunction('C:\\boundary', 'known', 'C:\\boundary\\target');
    f.refresh();
    expect(f.backend.inspectMembershipLink('C:\\boundary\\known')).toEqual(before.created);
    expect(readlinkSync).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'EACCES'] as const)('retains the original unknown-symlink refusal when diagnostic readlink fails with %s', (code) => {
    const f = windowsGitHostFixture(); fixtures.push(f);
    const name = 'C:\\boundary\\unknown', path = f.hostPath(name);
    symlinkSync('./missing-target', path);
    vi.mocked(readlinkSync).mockImplementation(() => { throw Object.assign(new Error('diagnostic readlink failed'), { code }); });
    expect(() => f.refresh()).toThrow('Host translator does not invent Windows junctions for Git symlinks');
    expect(f.nodes.has(name)).toBe(false);
  });

  it.each(['ENOENT', 'EACCES'] as const)('retains refusal diagnostics when literal readlink reports %s', (code) => {
    const f = windowsGitHostFixture(); fixtures.push(f);
    const name = 'C:\\boundary\\unknown', path = f.hostPath(name);
    symlinkSync('./missing-target', path);
    vi.mocked(readlinkSync).mockImplementation(() => {
      if (code === 'ENOENT') unlinkSync(path); // The link disappears only after refresh observed it.
      throw Object.assign(new Error('diagnostic readlink failed'), { code });
    });
    expect(() => f.refresh()).toThrow(`Host translator does not invent Windows junctions for Git symlinks: ${JSON.stringify({ path, name, literalTarget: null, node: null, readlinkError: { code, message: 'diagnostic readlink failed' } })}`);
    expect(readlinkSync).toHaveBeenCalledWith(path);
    expect(f.nodes.has(name)).toBe(false);
    if (code === 'ENOENT') expect(() => lstatSync(path)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});
