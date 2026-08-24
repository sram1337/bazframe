import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeManagedGitPackageBuild, managedGitCloneInvocation, normalizeManagedGitOrigin, parseManagedGitSource, safeDiagnostic } from '../../../src/providers/managed-git.js';
import {
  decodeManagedGitJournal,
  decodeManagedGitRecord,
  encodeManagedGitJournal,
  encodeManagedGitRecord,
  managedGitCheckoutRoot,
  readManagedGitRecord,
  scanManagedGitRecords
} from '../../../src/providers/managed-git-record.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('managed Git source and provenance', () => {
  it('normalizes GitHub shorthand and credential-free explicit URLs', () => {
    expect(parseManagedGitSource('git:Sram1337/Personal-Agent-Network')).toEqual({
      entered: 'git:Sram1337/Personal-Agent-Network',
      remote: 'github.com/sram1337/personal-agent-network',
      fetchUrl: 'https://github.com/sram1337/personal-agent-network.git',
      id: 'personal-agent-network',
      githubRepository: 'sram1337/personal-agent-network'
    });
    expect(parseManagedGitSource('ssh://git@github.com/SRAM1337/Personal-Agent-Network.git')).toMatchObject({
      remote: 'github.com/sram1337/personal-agent-network',
      fetchUrl: 'ssh://git@github.com/sram1337/personal-agent-network.git',
      id: 'personal-agent-network'
    });
    expect(parseManagedGitSource('https://example.com/team/toolkit')).toMatchObject({
      remote: 'example.com/team/toolkit', fetchUrl: 'https://example.com/team/toolkit.git', id: 'toolkit'
    });
    expect(normalizeManagedGitOrigin('git@github.com:sram1337/personal-agent-network.git')).toMatchObject({
      remote: 'github.com/sram1337/personal-agent-network', id: 'personal-agent-network'
    });
  });

  it('selects authenticated GitHub CLI cloning and shell-free Git fallback argv', () => {
    const source = parseManagedGitSource('git:sram1337/personal-agent-network');
    expect(managedGitCloneInvocation(source, '/managed/personal-agent-network', true)).toEqual({
      transport: 'gh',
      args: ['repo', 'clone', 'sram1337/personal-agent-network', '/managed/personal-agent-network', '--', '--no-checkout', '--template=']
    });
    expect(managedGitCloneInvocation(source, '/managed/personal-agent-network', false)).toEqual({
      transport: 'git',
      args: ['-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', 'clone', '--no-checkout', '--template=', '--origin', 'origin', 'https://github.com/sram1337/personal-agent-network.git', '/managed/personal-agent-network']
    });
  });

  it.each([
    'https://user:secret@example.com/team/toolkit.git',
    'https://example.com/team/toolkit.git?token=secret',
    'https://example.com/team/toolkit.git#revision',
    'file:///tmp/toolkit',
    '/tmp/toolkit',
    'git@example.com:team/toolkit.git',
    '--upload-pack=evil',
    'git:owner/Bad_Name'
  ])('rejects unsafe or ambiguous source %s', (source) => {
    expect(() => parseManagedGitSource(source)).toThrow();
  });

  it('uses the package-build confirmation seam, binds exact manifest bytes, and defaults to decline', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-confirm-')); roots.push(home);
    const candidate = join(home, 'candidate', 'toolkit');
    await mkdir(candidate, { recursive: true });
    await writeFile(join(candidate, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: ['npm', 'run', 'build'], artifactRoot: 'dist', skillsRoot: 'skills' }));
    const seen: unknown[] = [];
    await authorizeManagedGitPackageBuild({ bazframeHome: home, confirmPackageBuild: (details) => { seen.push(details); return true; } }, candidate, 'github.com/example/toolkit', 'b'.repeat(40));
    expect(seen).toEqual([{ remote: 'github.com/example/toolkit', revision: 'b'.repeat(40), root: managedGitCheckoutRoot(home, 'package', 'toolkit'), build: ['npm', 'run', 'build'] }]);
    await expect(authorizeManagedGitPackageBuild({ bazframeHome: home }, candidate, 'github.com/example/toolkit', 'b'.repeat(40))).rejects.toMatchObject({ code: 'MANAGED_GIT_BUILD_DECLINED' });
    await expect(authorizeManagedGitPackageBuild({
      bazframeHome: home,
      confirmPackageBuild: async () => {
        await writeFile(join(candidate, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: ['node', 'changed.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
        return true;
      }
    }, candidate, 'github.com/example/toolkit', 'b'.repeat(40))).rejects.toMatchObject({ code: 'PACKAGE_MANIFEST_CHANGED' });
  });

  it('round-trips exact provenance and recovery records and rejects malformed refs and extra fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-record-')); roots.push(home);
    const root = managedGitCheckoutRoot(await realpath(home), 'package', 'toolkit');
    const record = {
      schemaVersion: 1 as const,
      kind: 'package' as const,
      id: 'toolkit',
      root,
      remote: 'github.com/example/toolkit',
      fetchUrl: 'https://github.com/example/toolkit.git',
      transport: 'git' as const,
      branch: 'main',
      revision: 'a'.repeat(40)
    };
    const path = join(home, 'providers/git/records/package/toolkit.json');
    await mkdir(join(home, 'providers/git/records/package'), { recursive: true });
    await writeFile(path, encodeManagedGitRecord(record));
    expect((await readManagedGitRecord(home, 'package', 'toolkit')).record).toEqual(record);
    expect(decodeManagedGitRecord(JSON.parse(await readFile(path, 'utf8')))).toEqual(record);
    expect(() => decodeManagedGitRecord({ ...record, token: 'secret' })).toThrow(/exactly/);
    for (const branch of ['feature..x', 'feature@{1}', '.hidden', 'topic.lock', 'a//b', 'a\\b', 'main~1', `main${String.fromCharCode(0x9b)}x`, 'main\u202ex']) {
      expect(() => decodeManagedGitRecord({ ...record, branch })).toThrow(/branch/);
    }
    expect(() => decodeManagedGitRecord({ ...record, fetchUrl: `https://example.test/team/toolkit${String.fromCharCode(0x9b)}.git` })).toThrow(/fetchUrl/);
    expect(() => decodeManagedGitRecord({ ...record, fetchUrl: 'https://example.test/team/toolkit\u202e.git' })).toThrow(/fetchUrl/);
    expect(() => decodeManagedGitRecord({ ...record, revision: 'a'.repeat(41) })).toThrow(/revision/);
    expect(() => decodeManagedGitRecord({ ...record, root: `${root}\u0000x` })).toThrow(/root/);
    const journal = {
      schemaVersion: 1 as const, operation: 'update' as const, phase: 'provider-published', kind: 'package' as const,
      id: 'toolkit', remote: record.remote, fetchUrl: record.fetchUrl, transport: 'git' as const, branch: 'main',
      previousRevision: 'b'.repeat(40), nextRevision: record.revision, root,
      staging: join(home, 'providers/git/staging/acquire-safe'), backup: join(home, 'providers/git/recovery/package-toolkit-backup'), resourceStateSha256: null
    };
    expect(decodeManagedGitJournal(JSON.parse(encodeManagedGitJournal(journal)))).toEqual(journal);
    expect(() => decodeManagedGitJournal({ ...journal, kind: 'skill', operation: 'build' })).toThrow(/build operation requires package kind/);
    await mkdir(join(home, 'providers/git/recovery'), { recursive: true });
    const recoveries = [
      { ...journal, operation: 'add' as const, kind: 'skill' as const, id: 'root-skill', previousRevision: null, remote: 'example.test/team/root-skill', fetchUrl: 'https://example.test/team/root-skill.git', root: managedGitCheckoutRoot(await realpath(home), 'skill', 'root-skill') },
      { ...journal, operation: 'update' as const, kind: 'library' as const, id: 'toolkit', root: managedGitCheckoutRoot(await realpath(home), 'library', 'toolkit') },
      { ...journal, operation: 'remove' as const, kind: 'package' as const, id: 'old-package', remote: 'example.test/team/old-package', fetchUrl: 'https://example.test/team/old-package.git', root: managedGitCheckoutRoot(await realpath(home), 'package', 'old-package'), resourceStateSha256: 'c'.repeat(64) },
      { ...journal, operation: 'build' as const, kind: 'package' as const, id: 'built-package', remote: 'example.test/team/built-package', fetchUrl: 'https://example.test/team/built-package.git', root: managedGitCheckoutRoot(await realpath(home), 'package', 'built-package') }
    ];
    for (const recovery of recoveries) await writeFile(join(home, `providers/git/recovery/${recovery.kind}-${recovery.id}.json`), encodeManagedGitJournal(recovery));
    const recoveryDiagnostics = (await scanManagedGitRecords(home)).diagnostics;
    expect(recoveryDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'root-skill', message: expect.stringContaining('remove this recovery record before retrying bazframe add skill https://example.test/team/root-skill.git') }),
      expect.objectContaining({ id: 'toolkit', message: expect.stringContaining('remove this recovery record before retrying bazframe libraries update toolkit') }),
      expect.objectContaining({ id: 'old-package', message: expect.stringContaining('retry bazframe packages remove old-package with this recovery record retained') }),
      expect.objectContaining({ id: 'built-package', message: expect.stringContaining('remove this recovery record before retrying bazframe packages build built-package') })
    ]));
    const linkedHome = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-linked-record-')); roots.push(linkedHome);
    await mkdir(join(linkedHome, 'providers/git/records/package'), { recursive: true });
    await symlink(path, join(linkedHome, 'providers/git/records/package/toolkit.json'));
    await expect(readManagedGitRecord(linkedHome, 'package', 'toolkit')).rejects.toMatchObject({ code: 'MANAGED_GIT_RECORD_READ_FAILED' });
    const recoveryTarget = join(linkedHome, 'journal.json');
    await writeFile(recoveryTarget, encodeManagedGitJournal(journal));
    await mkdir(join(linkedHome, 'providers/git/recovery'), { recursive: true });
    await symlink(recoveryTarget, join(linkedHome, 'providers/git/recovery/package-toolkit.json'));
    expect((await scanManagedGitRecords(linkedHome)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'package', id: 'toolkit', message: expect.stringContaining('recovery record is invalid') })
    ]));
  });

  it('bounds terminal-safe process diagnostics and redacts credentials', () => {
    const escape = String.fromCharCode(27);
    const c1Csi = String.fromCharCode(0x9b);
    const bidiOverride = '\u202e';
    const diagnostic = safeDiagnostic(`https://user:secret@example.test/repo token=abc authorization:bearer${escape}[31m${c1Csi}32m${bidiOverride}\n${'x'.repeat(2000)}`);
    expect(diagnostic).not.toContain('secret');
    expect(diagnostic).not.toContain('abc');
    expect(diagnostic).not.toContain(escape);
    expect(diagnostic).not.toContain(c1Csi);
    expect(diagnostic).not.toContain(bidiOverride);
    expect(diagnostic.length).toBeLessThanOrEqual(1000);
  });
});
