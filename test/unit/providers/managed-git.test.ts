import { execFile } from 'node:child_process';
import { appendFile, chmod, link, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeManagedGitPackageBuild, captureManagedGitExportHealth, classifyManagedGitImportOutcome, classifyManagedGitImportResource, classifyManagedGitProviderOccupancy, isManagedGitSource, managedGitCloneInvocation, normalizeManagedGitOrigin, parseManagedGitSource, safeDiagnostic, sameManagedGitExportHealth } from '../../../src/providers/managed-git.js';
import { addLibrary } from '../../../src/skill-collections/skill-collection-lifecycle.js';
import { snapshotFilesystem } from '../../helpers/filesystem-snapshot.js';
import {
  decodeManagedGitJournal,
  decodeManagedGitRecord,
  decodePathFreeManagedGitIdentity,
  encodeManagedGitJournal,
  encodeManagedGitRecord,
  managedGitCheckoutRoot,
  managedGitJournalPath,
  managedGitRecordPath,
  MAX_MANAGED_GIT_RECORD_BYTES,
  pathFreeManagedGitIdentityFromRecord,
  readManagedGitJournal,
  readManagedGitRecord,
  scanManagedGitRecords,
  type ManagedGitRecord
} from '../../../src/providers/managed-git-record.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => {
  if (process.platform !== 'win32') {
    await execFileAsync('chmod', ['-R', 'u+w', root]).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
})));

describe('remote Git source and provenance', () => {
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

  it('classifies the exact lowercase source forms accepted by command routing', () => {
    for (const source of [
      'git:owner/toolkit',
      'https://example.com/owner/toolkit',
      'ssh://git@example.com/owner/toolkit',
      'file:///tmp/toolkit',
      'git@example.com:owner/toolkit'
    ]) expect(isManagedGitSource(source)).toBe(true);
    for (const source of ['HTTPS://example.com/owner/toolkit', 'relative/toolkit', '/tmp/toolkit']) {
      expect(isManagedGitSource(source)).toBe(false);
    }
  });

  it('selects authenticated GitHub CLI cloning and shell-free Git fallback argv', () => {
    const source = parseManagedGitSource('git:sram1337/personal-agent-network');
    expect(managedGitCloneInvocation(source, '/managed/personal-agent-network', true)).toEqual({
      transport: 'gh',
      args: ['repo', 'clone', 'sram1337/personal-agent-network', '/managed/personal-agent-network', '--', '--no-checkout', '--no-local', '--no-hardlinks', '--template=']
    });
    expect(managedGitCloneInvocation(source, '/managed/personal-agent-network', false)).toEqual({
      transport: 'git',
      args: ['-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', 'clone', '--no-checkout', '--no-local', '--no-hardlinks', '--template=', '--origin', 'origin', 'https://github.com/sram1337/personal-agent-network.git', '/managed/personal-agent-network']
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
    const recordBytes = encodeManagedGitRecord(record);
    await writeFile(path, recordBytes);
    expect((await readManagedGitRecord(home, 'package', 'toolkit')).record).toEqual(record);
    await expect(readManagedGitRecord(home, 'package', 'toolkit', { maxBytes: Buffer.byteLength(recordBytes) - 1 }))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_RECORD_INVALID' });
    await expect(readManagedGitRecord(home, 'package', 'toolkit', { maxBytes: Buffer.byteLength(recordBytes) }))
      .resolves.toMatchObject({ record });
    await expect(readManagedGitRecord(home, 'package', 'toolkit', { maxBytes: Buffer.byteLength(recordBytes) + 1 }))
      .resolves.toMatchObject({ record });
    await expect(readManagedGitRecord(home, 'package', 'toolkit', {
      maxBytes: Buffer.byteLength(recordBytes) + 1,
      testHooks: { afterInitialStat: async () => { await appendFile(path, 'x'); } }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_RECORD_INVALID' });
    await writeFile(path, recordBytes);
    await expect(readManagedGitRecord(home, 'package', 'toolkit', {
      maxBytes: Buffer.byteLength(recordBytes),
      testHooks: { afterPathStat: async () => {
        await rename(path, `${path}.replaced-during-read`);
        await writeFile(path, recordBytes);
      } }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_RECORD_INVALID' });
    await unlink(`${path}.replaced-during-read`);
    await expect(readManagedGitRecord(home, 'package', 'toolkit', {
      maxBytes: Buffer.byteLength(recordBytes),
      testHooks: {
        afterInitialStat: async () => { await appendFile(path, 'x'); },
        afterClose: () => { throw new Error('close failed'); }
      }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_RECORD_INVALID', message: expect.stringContaining('changed') });
    await writeFile(path, recordBytes);
    await expect(readManagedGitRecord(home, 'package', 'toolkit', {
      maxBytes: Buffer.byteLength(recordBytes),
      testHooks: { afterClose: () => { throw new Error('close failed'); } }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_RECORD_READ_FAILED', message: expect.stringContaining('close') });
    expect(decodeManagedGitRecord(JSON.parse(await readFile(path, 'utf8')))).toEqual(record);
    expect(() => decodeManagedGitRecord({ ...record, token: 'secret' })).toThrow(/exactly/);
    for (const branch of ['HEAD', 'head', 'Head', 'feature..x', 'feature@{1}', '.hidden', 'topic.lock', 'a//b', 'a\\b', 'main~1', `main${String.fromCharCode(0x9b)}x`, 'main\u202ex']) {
      expect(() => decodeManagedGitRecord({ ...record, branch })).toThrow(/branch/);
    }
    expect(() => decodeManagedGitRecord({ ...record, fetchUrl: `https://example.test/team/toolkit${String.fromCharCode(0x9b)}.git` })).toThrow(/fetchUrl/);
    expect(() => decodeManagedGitRecord({ ...record, fetchUrl: 'https://example.test/team/toolkit\u202e.git' })).toThrow(/fetchUrl/);
    expect(decodeManagedGitRecord({ ...record, revision: 'b'.repeat(64) })).toMatchObject({ revision: 'b'.repeat(64) });
    for (const length of [39, 41, 63, 65]) expect(() => decodeManagedGitRecord({ ...record, revision: 'a'.repeat(length) })).toThrow(/revision/);
    expect(() => decodeManagedGitRecord({ ...record, root: `${root}\u0000x` })).toThrow(/root/);
    const journal = {
      schemaVersion: 1 as const, operation: 'update' as const, phase: 'provider-published', kind: 'package' as const,
      id: 'toolkit', remote: record.remote, fetchUrl: record.fetchUrl, transport: 'git' as const, branch: 'main',
      previousRevision: 'b'.repeat(40), nextRevision: record.revision, root,
      staging: join(home, 'providers/git/staging/acquire-safe'), backup: join(home, 'providers/git/recovery/package-toolkit-backup'), resourceStateSha256: null
    };
    expect(decodeManagedGitJournal(JSON.parse(encodeManagedGitJournal(journal)))).toEqual(journal);
    expect(() => decodeManagedGitJournal({ ...journal, kind: 'skill', operation: 'build' })).toThrow(/build operation requires package kind/);
    expect(decodeManagedGitJournal({ ...journal, operation: 'add-exact' })).toMatchObject({ kind: 'package', operation: 'add-exact' });
    await mkdir(join(home, 'providers/git/recovery'), { recursive: true });
    const recoveries = [
      { ...journal, operation: 'add' as const, kind: 'skill' as const, id: 'root-skill', previousRevision: null, remote: 'example.test/team/root-skill', fetchUrl: 'https://example.test/team/root-skill.git', root: managedGitCheckoutRoot(await realpath(home), 'skill', 'root-skill') },
      { ...journal, operation: 'add-exact' as const, kind: 'library' as const, id: 'portable', previousRevision: null, remote: 'example.test/team/portable', fetchUrl: 'https://example.test/team/portable.git', root: managedGitCheckoutRoot(await realpath(home), 'library', 'portable') },
      { ...journal, operation: 'update' as const, kind: 'library' as const, id: 'toolkit', root: managedGitCheckoutRoot(await realpath(home), 'library', 'toolkit') },
      { ...journal, operation: 'remove' as const, kind: 'package' as const, id: 'old-package', remote: 'example.test/team/old-package', fetchUrl: 'https://example.test/team/old-package.git', root: managedGitCheckoutRoot(await realpath(home), 'package', 'old-package'), resourceStateSha256: 'c'.repeat(64) },
      { ...journal, operation: 'build' as const, kind: 'package' as const, id: 'built-package', remote: 'example.test/team/built-package', fetchUrl: 'https://example.test/team/built-package.git', root: managedGitCheckoutRoot(await realpath(home), 'package', 'built-package') }
    ];
    for (const recovery of recoveries) await writeFile(join(home, `providers/git/recovery/${recovery.kind}-${recovery.id}.json`), encodeManagedGitJournal(recovery));
    const journalPath = join(home, 'providers/git/recovery/library-toolkit.json');
    const journalBytes = encodeManagedGitJournal(recoveries[2]!);
    await expect(readManagedGitJournal(home, 'library', 'toolkit', { maxBytes: Buffer.byteLength(journalBytes) - 1 }))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_JOURNAL_INVALID' });
    await expect(readManagedGitJournal(home, 'library', 'toolkit', { maxBytes: Buffer.byteLength(journalBytes) }))
      .resolves.toMatchObject({ journal: recoveries[2] });
    await expect(readManagedGitJournal(home, 'library', 'toolkit', { maxBytes: Buffer.byteLength(journalBytes) + 1 }))
      .resolves.toMatchObject({ journal: recoveries[2] });
    await expect(readManagedGitJournal(home, 'library', 'toolkit', {
      maxBytes: Buffer.byteLength(journalBytes) + 1,
      testHooks: { afterInitialStat: async () => { await appendFile(journalPath, 'x'); } }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_JOURNAL_INVALID' });
    await writeFile(journalPath, journalBytes);
    await expect(readManagedGitJournal(home, 'library', 'toolkit', {
      maxBytes: Buffer.byteLength(journalBytes),
      testHooks: { afterPathStat: async () => {
        await rename(journalPath, `${journalPath}.replaced-during-read`);
        await writeFile(journalPath, journalBytes);
      } }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_JOURNAL_INVALID' });
    await unlink(`${journalPath}.replaced-during-read`);
    await expect(readManagedGitJournal(home, 'library', 'toolkit', {
      maxBytes: Buffer.byteLength(journalBytes),
      testHooks: {
        afterInitialStat: async () => { await appendFile(journalPath, 'x'); },
        afterClose: () => { throw new Error('close failed'); }
      }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_JOURNAL_INVALID', message: expect.stringContaining('changed') });
    await writeFile(journalPath, journalBytes);
    await expect(readManagedGitJournal(home, 'library', 'toolkit', {
      maxBytes: Buffer.byteLength(journalBytes),
      testHooks: { afterClose: () => { throw new Error('close failed'); } }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_JOURNAL_INVALID', message: expect.stringContaining('close') });
    const recoveryDiagnostics = (await scanManagedGitRecords(home)).diagnostics;
    expect(recoveryDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'root-skill', message: expect.stringContaining('remove this recovery record before retrying bazframe skill add https://example.test/team/root-skill.git') }),
      expect.objectContaining({ id: 'portable', message: expect.stringContaining(`retrying the originating exact profile import for https://example.test/team/portable.git at branch main and revision ${record.revision}`) }),
      expect.objectContaining({ id: 'toolkit', message: expect.stringContaining('remove this recovery record before retrying bazframe library update toolkit') }),
      expect.objectContaining({ id: 'old-package', message: expect.stringContaining('retry bazframe package remove old-package with this recovery record retained') }),
      expect.objectContaining({ id: 'built-package', message: expect.stringContaining('remove this recovery record before retrying bazframe package build built-package') })
    ]));
    expect(recoveryDiagnostics.find((diagnostic) => diagnostic.id === 'portable')?.message)
      .not.toContain('bazframe library add');
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

  it('captures recovery-free offline export health without acquisition commands', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-health-')); roots.push(home);
    const canonicalHome = await realpath(home);
    const root = managedGitCheckoutRoot(canonicalHome, 'skill', 'toolkit');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'SKILL.md'), '---\nname: toolkit\ndescription: Test.\n---\n');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['add', 'SKILL.md'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'initial'], { cwd: root });
    const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://example.test/team/toolkit.git'], { cwd: root });
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', revision], { cwd: root });
    await execFileAsync('git', ['checkout', '--detach', revision], { cwd: root });
    await mkdir(join(home, 'providers/git/records/skill'), { recursive: true });
    await mkdir(join(home, 'skills'), { recursive: true });
    await symlink(root, join(home, 'skills/toolkit'));
    const record: ManagedGitRecord = {
      schemaVersion: 1,
      kind: 'skill',
      id: 'toolkit',
      root,
      remote: 'example.test/team/toolkit',
      fetchUrl: 'https://example.test/team/toolkit.git',
      transport: 'git',
      branch: 'main',
      revision
    };
    await writeFile(join(home, 'providers/git/records/skill/toolkit.json'), encodeManagedGitRecord(record));
    const log = join(home, 'git-commands.log');
    const wrapper = join(home, 'git-wrapper.sh');
    await writeFile(wrapper, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GIT_LOG"\ncase " $* " in *" clone "*|*" fetch "*) exit 97;; esac\nexec git "$@"\n');
    await writeFile(log, '');
    await chmod(wrapper, 0o700);
    const environment = { ...process.env, BAZFRAME_GIT_COMMAND: wrapper, GIT_LOG: log };

    const expectedIdentity = pathFreeManagedGitIdentityFromRecord(record);
    const beforeReadOnlyInspection = await snapshotFilesystem(home);
    await expect(classifyManagedGitImportOutcome(
      home,
      'skill',
      'toolkit',
      expectedIdentity,
      { ...process.env, BAZFRAME_GIT_COMMAND: 'git' }
    )).resolves.toMatchObject({ state: 'exact', health: { root: { path: root } } });
    await expect(classifyManagedGitImportResource(
      home,
      'skill',
      'toolkit',
      expectedIdentity,
      { ...process.env, BAZFRAME_GIT_COMMAND: 'git' }
    )).resolves.toMatchObject({ action: 'reuse', health: { root: { path: root } } });
    expect(await snapshotFilesystem(home)).toEqual(beforeReadOnlyInspection);
    await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', expectedIdentity, environment))
      .resolves.toMatchObject({ action: 'reuse', health: { root: { path: root } } });
    for (const changed of [
      {
        ...expectedIdentity,
        remote: 'example.test/other/toolkit',
        fetchUrl: 'https://example.test/other/toolkit.git'
      },
      { ...expectedIdentity, branch: 'release' },
      { ...expectedIdentity, revision: 'f'.repeat(40) }
    ]) {
      await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', changed, environment))
        .resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('does not match') });
    }
    await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', {
      ...expectedIdentity,
      fetchUrl: 'https://example.test/other/toolkit.git'
    }, environment)).resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('canonical') });
    await expect(classifyManagedGitImportResource(home, 'library', 'toolkit', expectedIdentity, environment))
      .resolves.toEqual({ action: 'create' });
    const recordPath = join(home, 'providers/git/records/skill/toolkit.json');
    await writeFile(recordPath, encodeManagedGitRecord({ ...record, root: join(home, 'other', 'toolkit') }));
    await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', expectedIdentity, environment))
      .resolves.toMatchObject({ action: 'blocked' });
    await writeFile(recordPath, encodeManagedGitRecord(record));

    const first = await captureManagedGitExportHealth(home, 'skill', 'toolkit', environment);
    const second = await captureManagedGitExportHealth(home, 'skill', 'toolkit', environment);
    expect(first.recordSnapshot.record).toEqual(record);
    expect(first.root).toMatchObject({ path: root });
    expect(sameManagedGitExportHealth(first, second)).toBe(true);
    expect(await readFile(log, 'utf8')).not.toMatch(/\b(?:clone|fetch)\b/u);

    await execFileAsync('git', ['checkout', 'main'], { cwd: root });
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_REVISION_MISMATCH' });
    await execFileAsync('git', ['checkout', '--detach', revision], { cwd: root });
    await execFileAsync('git', ['remote', 'set-url', 'origin', 'ssh://git@example.test/team/toolkit.git'], { cwd: root });
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_IDENTITY_MISMATCH' });
    await execFileAsync('git', ['remote', 'set-url', 'origin', 'https://example.test/team/toolkit.git'], { cwd: root });
    const malformedWrapper = join(home, 'malformed-git-wrapper.sh');
    await writeFile(malformedWrapper, `#!/bin/sh\ncase " $* " in *" rev-parse "*) printf '${revision}\\n${revision}\\n'; exit 0;; esac\nexec git "$@"\n`);
    await chmod(malformedWrapper, 0o700);
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', { ...process.env, BAZFRAME_GIT_COMMAND: malformedWrapper }))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_PROCESS_FAILED' });

    const registration = join(home, 'skills/toolkit');
    const replacementRegistration = join(home, 'skills/.toolkit-replacement');
    await symlink(root, replacementRegistration);
    await rename(replacementRegistration, registration);
    const replacedRegistration = await captureManagedGitExportHealth(home, 'skill', 'toolkit', environment);
    expect(sameManagedGitExportHealth(second, replacedRegistration)).toBe(false);

    const displacedSkill = join(home, 'hardlinked-SKILL.md');
    await rename(join(root, 'SKILL.md'), displacedSkill);
    await link(displacedSkill, join(root, 'SKILL.md'));
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });
    await unlink(join(root, 'SKILL.md'));
    await rename(displacedSkill, join(root, 'SKILL.md'));

    await execFileAsync('git', ['update-index', '--assume-unchanged', 'SKILL.md'], { cwd: root });
    await writeFile(join(root, 'SKILL.md'), 'hidden by assume-unchanged\n');
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_DIRTY' });
    await execFileAsync('git', ['update-index', '--no-assume-unchanged', 'SKILL.md'], { cwd: root });
    await execFileAsync('git', ['checkout', '--', 'SKILL.md'], { cwd: root });
    await execFileAsync('git', ['update-index', '--skip-worktree', 'SKILL.md'], { cwd: root });
    await writeFile(join(root, 'SKILL.md'), 'hidden by skip-worktree\n');
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_DIRTY' });
    await execFileAsync('git', ['update-index', '--no-skip-worktree', 'SKILL.md'], { cwd: root });
    await execFileAsync('git', ['checkout', '--', 'SKILL.md'], { cwd: root });

    const recoveryRoot = join(home, 'providers/git/recovery');
    await mkdir(recoveryRoot, { recursive: true });
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment)).resolves.toBeDefined();
    await writeFile(join(recoveryRoot, 'library-toolkit.json'), '{}\n');
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment)).resolves.toBeDefined();
    await rm(recoveryRoot, { recursive: true });
    const substitutedRecovery = join(home, 'substituted-recovery');
    await mkdir(substitutedRecovery);
    await symlink(substitutedRecovery, recoveryRoot);
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_RECOVERY_REQUIRED' });
    await unlink(recoveryRoot);
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment, {
      beforeFinalRecoveryCheck: async () => { await symlink(substitutedRecovery, recoveryRoot); }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_RECOVERY_REQUIRED' });
    await unlink(recoveryRoot);
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment, {
      beforeFinalRecoveryCheck: async () => {
        await mkdir(recoveryRoot, { recursive: true });
        await writeFile(join(recoveryRoot, 'library-toolkit.json'), '{}\n');
      }
    })).resolves.toBeDefined();
    await rm(recoveryRoot, { recursive: true });

    await mkdir(recoveryRoot, { recursive: true });
    await writeFile(join(recoveryRoot, 'skill-toolkit.json'), '{}\n');
    await expect(captureManagedGitExportHealth(home, 'skill', 'toolkit', environment))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_RECOVERY_REQUIRED' });
    await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', expectedIdentity, environment))
      .resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('recovery') });
  }, 15_000);

  it('classifies a missing home as create without creating it and partial occupancy as blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-import-empty-')); roots.push(root);
    const home = join(root, 'missing-home');
    const identity = {
      remote: 'example.test/team/toolkit',
      fetchUrl: 'https://example.test/team/toolkit.git',
      branch: 'main',
      revision: 'a'.repeat(40)
    };
    await expect(classifyManagedGitImportOutcome(home, 'skill', 'toolkit', identity))
      .resolves.toEqual({ state: 'absent' });
    await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', identity))
      .resolves.toEqual({ action: 'create' });
    await expect(classifyManagedGitImportOutcome(home, 'package', 'toolkit', identity))
      .resolves.toEqual({ state: 'absent' });
    await expect(classifyManagedGitImportResource(home, 'package', 'toolkit', identity))
      .resolves.toEqual({ action: 'create' });
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(join(home, 'skills'), { recursive: true });
    await writeFile(join(home, 'skills/toolkit'), 'occupied');
    await expect(classifyManagedGitImportOutcome(home, 'skill', 'toolkit', identity))
      .resolves.toMatchObject({ state: 'ambiguous', reason: expect.stringContaining('partial') });
    await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', identity))
      .resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('partial') });

    const recoveryHome = join(root, 'recovery-home');
    await mkdir(join(recoveryHome, 'providers/git/recovery'), { recursive: true });
    await writeFile(join(recoveryHome, 'providers/git/recovery/skill-toolkit.json'), '{ malformed recovery remains physical }\n');
    await expect(classifyManagedGitImportOutcome(recoveryHome, 'skill', 'toolkit', identity))
      .resolves.toEqual({ state: 'recovery-required' });
    await expect(classifyManagedGitImportResource(recoveryHome, 'skill', 'toolkit', identity))
      .resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('recovery') });
  });

  it('classifies typed provider occupancy without writes, preserves same-ID independence, and fails closed on drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-provider-occupancy-')); roots.push(root);
    const missingHome = join(root, 'missing-home');
    const before = await snapshotFilesystem(root);
    await expect(classifyManagedGitProviderOccupancy(missingHome, 'library', 'toolkit'))
      .resolves.toBe('absent');
    expect(await snapshotFilesystem(root)).toEqual(before);
    await expect(lstat(missingHome)).rejects.toMatchObject({ code: 'ENOENT' });

    const cases = [
      ['record', (home: string) => managedGitRecordPath(home, 'library', 'toolkit')],
      ['journal', (home: string) => managedGitJournalPath(home, 'library', 'toolkit')],
      ['checkout', (home: string) => managedGitCheckoutRoot(home, 'library', 'toolkit')]
    ] as const;
    for (const [label, occupiedPath] of cases) {
      const home = join(root, `${label}-home`);
      const path = occupiedPath(home);
      await mkdir(label === 'checkout' ? path : join(path, '..'), { recursive: true });
      if (label !== 'checkout') await writeFile(path, 'physical occupancy only\n');
      await expect(classifyManagedGitProviderOccupancy(home, 'library', 'toolkit'))
        .resolves.toBe('occupied');
    }

    const packageHome = join(root, 'package-home');
    for (const path of [
      managedGitRecordPath(packageHome, 'package', 'toolkit'),
      managedGitJournalPath(packageHome, 'package', 'toolkit')
    ]) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'wrong-kind occupancy\n');
    }
    await mkdir(managedGitCheckoutRoot(packageHome, 'package', 'toolkit'), { recursive: true });
    await expect(classifyManagedGitProviderOccupancy(packageHome, 'library', 'toolkit'))
      .resolves.toBe('absent');
    await expect(classifyManagedGitProviderOccupancy(packageHome, 'package', 'toolkit'))
      .resolves.toBe('occupied');

    const libraryHome = join(root, 'library-home');
    await mkdir(managedGitCheckoutRoot(libraryHome, 'library', 'toolkit'), { recursive: true });
    await expect(classifyManagedGitProviderOccupancy(libraryHome, 'package', 'toolkit'))
      .resolves.toBe('absent');
    await expect(classifyManagedGitProviderOccupancy(libraryHome, 'library', 'toolkit'))
      .resolves.toBe('occupied');

    const changingHome = join(root, 'changing-home');
    await expect(classifyManagedGitProviderOccupancy(changingHome, 'library', 'toolkit', {
      afterInitialOccupancy: async () => {
        const path = managedGitRecordPath(changingHome, 'library', 'toolkit');
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, 'appeared between captures\n');
      }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_CHANGED' });
  });

  it('blocks create when a missing home parent is substituted', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-import-parent-')); roots.push(root);
    const parent = join(root, 'parent');
    const moved = join(root, 'moved-parent');
    const home = join(parent, 'nested', 'home');
    await mkdir(parent);
    const before = await snapshotFilesystem(root);
    const identity = {
      remote: 'example.test/team/toolkit',
      fetchUrl: 'https://example.test/team/toolkit.git',
      branch: 'main',
      revision: 'a'.repeat(40)
    };
    const result = await classifyManagedGitImportResource(home, 'skill', 'toolkit', identity, process.env, {
      afterInitialOccupancy: async () => {
        await rename(parent, moved);
        await mkdir(parent);
      }
    });
    expect(result).toMatchObject({ action: 'blocked', reason: expect.stringContaining('ancestry changed') });
    await rm(parent, { recursive: true });
    await rename(moved, parent);
    expect(await snapshotFilesystem(root)).toEqual(before);
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('blocks create after restored %s-home anchor substitution', async (existingHome) => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-import-restored-anchor-')); roots.push(root);
    const parent = join(root, 'parent');
    const home = existingHome ? join(parent, 'home') : join(parent, 'nested', 'home');
    const anchoredPath = existingHome ? home : parent;
    const moved = `${anchoredPath}.moved`;
    await mkdir(existingHome ? home : parent, { recursive: true });
    const before = await snapshotFilesystem(root);
    const identity = {
      remote: 'example.test/team/toolkit',
      fetchUrl: 'https://example.test/team/toolkit.git',
      branch: 'main',
      revision: 'a'.repeat(40)
    };
    const result = await classifyManagedGitImportResource(home, 'skill', 'toolkit', identity, process.env, {
      afterInitialOccupancy: async () => {
        await rename(anchoredPath, moved);
        await mkdir(anchoredPath);
        await rm(anchoredPath, { recursive: true });
        await rename(moved, anchoredPath);
      }
    });
    expect(result).toMatchObject({ action: 'blocked', reason: expect.stringContaining('ancestry changed') });
    expect(await snapshotFilesystem(root)).toEqual(before);
    if (!existingHome) await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['providers', 'skill'],
    ['skills', 'skill'],
    ['libraries', 'library'],
    ['recovery', 'skill'],
    ['checkouts', 'skill']
  ] as const)('blocks absent resources through linked %s namespace ancestry', async (variant, kind) => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), `bazframe-managed-git-import-linked-${variant}-`)); roots.push(root);
    const home = join(root, 'home');
    const external = join(root, 'external');
    await mkdir(home);
    await mkdir(external);
    if (variant === 'providers') {
      await symlink(external, join(home, 'providers'));
    } else if (variant === 'skills' || variant === 'libraries') {
      await symlink(external, join(home, variant));
    } else {
      const parent = variant === 'recovery'
        ? join(home, 'providers/git')
        : join(home, 'providers/git/checkouts');
      await mkdir(parent, { recursive: true });
      await symlink(external, join(parent, variant === 'recovery' ? 'recovery' : 'skill'));
    }
    const identity = {
      remote: 'example.test/team/toolkit',
      fetchUrl: 'https://example.test/team/toolkit.git',
      branch: 'main',
      revision: 'a'.repeat(40)
    };
    await expect(classifyManagedGitImportResource(home, kind, 'toolkit', identity))
      .resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('physical directory') });
  });

  it('blocks namespace substitution between absence captures', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-import-substitution-')); roots.push(root);
    const home = join(root, 'home');
    const external = join(root, 'external');
    await mkdir(home);
    await mkdir(external);
    const identity = {
      remote: 'example.test/team/toolkit',
      fetchUrl: 'https://example.test/team/toolkit.git',
      branch: 'main',
      revision: 'a'.repeat(40)
    };
    await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', identity, process.env, {
      afterInitialOccupancy: async () => { await symlink(external, join(home, 'providers')); }
    })).resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('physical directory') });
  });

  it('blocks corrupt provenance and malformed checkout state', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-import-corrupt-')); roots.push(home);
    const canonicalHome = await realpath(home);
    const root = managedGitCheckoutRoot(canonicalHome, 'skill', 'toolkit');
    const recordPath = join(home, 'providers/git/records/skill/toolkit.json');
    await mkdir(root, { recursive: true });
    await mkdir(join(home, 'providers/git/records/skill'), { recursive: true });
    await mkdir(join(home, 'skills'), { recursive: true });
    await symlink(root, join(home, 'skills/toolkit'));
    const identity = {
      remote: 'example.test/team/toolkit',
      fetchUrl: 'https://example.test/team/toolkit.git',
      branch: 'main',
      revision: 'a'.repeat(40)
    };
    await writeFile(recordPath, '{}\n');
    await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', identity))
      .resolves.toMatchObject({ action: 'blocked' });
    await writeFile(recordPath, encodeManagedGitRecord({
      schemaVersion: 1,
      kind: 'skill',
      id: 'toolkit',
      root,
      ...identity,
      transport: 'git'
    }));
    await expect(classifyManagedGitImportResource(home, 'skill', 'toolkit', identity))
      .resolves.toMatchObject({ action: 'blocked' });
  });

  it('classifies an exact healthy remote Git library as reuse without network commands', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-import-library-')); roots.push(home);
    const canonicalHome = await realpath(home);
    const root = managedGitCheckoutRoot(canonicalHome, 'library', 'toolkit');
    await mkdir(join(root, 'child'), { recursive: true });
    await writeFile(join(root, 'child', 'SKILL.md'), '---\nname: child\ndescription: Test.\n---\n');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'initial'], { cwd: root });
    const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const fetchUrl = 'https://example.test/team/toolkit.git';
    await execFileAsync('git', ['remote', 'add', 'origin', fetchUrl], { cwd: root });
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', revision], { cwd: root });
    await execFileAsync('git', ['checkout', '--detach', revision], { cwd: root });
    await addLibrary({ bazframeHome: canonicalHome }, root);
    const record: ManagedGitRecord = {
      schemaVersion: 1,
      kind: 'library',
      id: 'toolkit',
      root,
      remote: 'example.test/team/toolkit',
      fetchUrl,
      transport: 'git',
      branch: 'main',
      revision
    };
    await mkdir(join(home, 'providers/git/records/library'), { recursive: true });
    await writeFile(join(home, 'providers/git/records/library/toolkit.json'), encodeManagedGitRecord(record));
    const log = join(home, 'library-git-commands.log');
    const wrapper = join(home, 'library-git-wrapper.sh');
    await writeFile(wrapper, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GIT_LOG"\ncase " $* " in *" clone "*|*" fetch "*|*" pull "*|*" ls-remote "*) exit 97;; esac\nexec git "$@"\n');
    await writeFile(log, '');
    await chmod(wrapper, 0o700);
    const environment = { ...process.env, BAZFRAME_GIT_COMMAND: wrapper, GIT_LOG: log };

    const classification = await classifyManagedGitImportResource(
      canonicalHome,
      'library',
      'toolkit',
      pathFreeManagedGitIdentityFromRecord(record),
      environment
    );
    expect(classification).toMatchObject({
      action: 'reuse',
      health: {
        root: { path: root },
        collectionSnapshot: { record: { library: 'toolkit', root } }
      }
    });
    const health = classification.health!;
    expect(sameManagedGitExportHealth(health, health)).toBe(true);
    expect(sameManagedGitExportHealth(health, { ...health, recordSnapshot: {
      ...health.recordSnapshot,
      path: `${health.recordSnapshot.path}.other`
    } })).toBe(false);
    expect(sameManagedGitExportHealth(health, { ...health, collectionSnapshot: undefined })).toBe(false);
    expect(sameManagedGitExportHealth(health, { ...health, collectionSnapshot: {
      ...health.collectionSnapshot!,
      path: `${health.collectionSnapshot!.path}.other`
    } })).toBe(false);
    expect(sameManagedGitExportHealth(health, { ...health, collectionSnapshot: {
      ...health.collectionSnapshot!,
      contentSha256: '0'.repeat(64)
    } })).toBe(false);
    expect(await readFile(log, 'utf8')).not.toMatch(/\b(?:clone|fetch|pull|ls-remote)\b/u);
  });

  it.each(['skill', 'library'] as const)('projects exact path-free identity from a managed %s record', (kind) => {
    const record: ManagedGitRecord = {
      schemaVersion: 1,
      kind,
      id: 'toolkit',
      root: `/managed/${kind}/toolkit`,
      remote: 'github.com/example/toolkit',
      fetchUrl: 'https://github.com/example/toolkit.git',
      transport: 'gh',
      branch: 'feature/portable',
      revision: 'd'.repeat(40)
    };

    const identity = pathFreeManagedGitIdentityFromRecord(record);
    expect(identity).toEqual({
      remote: record.remote,
      fetchUrl: record.fetchUrl,
      branch: record.branch,
      revision: record.revision
    });
    expect(identity).not.toHaveProperty('root');
    expect(identity).not.toHaveProperty('transport');
    expect(decodePathFreeManagedGitIdentity(identity)).toEqual(identity);
  });

  it('strictly validates bounded path-free identity with the shared source validators', () => {
    const identity = {
      remote: 'example.test/team/toolkit',
      fetchUrl: 'https://example.test/team/toolkit.git',
      branch: 'main',
      revision: 'a'.repeat(40)
    };
    expect(() => decodePathFreeManagedGitIdentity({ ...identity, root: '/tmp/toolkit' })).toThrow(/exactly/u);
    expect(() => decodePathFreeManagedGitIdentity({ ...identity, transport: 'git' })).toThrow(/exactly/u);
    expect(() => decodePathFreeManagedGitIdentity({ ...identity, remote: 'elsewhere.test/team/toolkit' })).toThrow(/does not match/u);
    expect(() => decodePathFreeManagedGitIdentity({ ...identity, fetchUrl: 'https://user:secret@example.test/team/toolkit.git' })).toThrow(/fetchUrl/u);
    expect(() => decodePathFreeManagedGitIdentity({ ...identity, branch: 'main~1' })).toThrow(/branch/u);
    for (const branch of ['HEAD', 'head', 'Head']) {
      expect(() => decodePathFreeManagedGitIdentity({ ...identity, branch })).toThrow(/branch/u);
    }
    expect(decodePathFreeManagedGitIdentity(identity, 'toolkit')).toEqual(identity);
    expect(decodePathFreeManagedGitIdentity({ ...identity, revision: 'b'.repeat(64) }, 'toolkit')).toMatchObject({ revision: 'b'.repeat(64) });
    for (const length of [39, 41, 63, 65]) {
      expect(() => decodePathFreeManagedGitIdentity({ ...identity, revision: 'a'.repeat(length) }, 'toolkit')).toThrow(/revision/u);
    }
    expect(() => decodePathFreeManagedGitIdentity(identity, 'other')).toThrow(/canonical/u);
    expect(() => decodePathFreeManagedGitIdentity({ ...identity, fetchUrl: 'https://example.test/team/other.git' }, 'toolkit')).toThrow(/canonical/u);
    expect(() => decodePathFreeManagedGitIdentity({ ...identity, fetchUrl: `https://example.test/${'a'.repeat(2 * 1024 * 1024)}.git` }))
      .toThrow(new RegExp(`${MAX_MANAGED_GIT_RECORD_BYTES}-byte`, 'u'));

    const canonicalBytes = (value: object): number => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    let exact: typeof identity | undefined;
    for (let segmentCount = 1; segmentCount < 256 && exact === undefined; segmentCount += 1) {
      const path = `${Array.from({ length: segmentCount }, () => 'a'.repeat(63)).join('/')}/toolkit`;
      const base = {
        ...identity,
        branch: 'b',
        remote: `example.test/${path}`,
        fetchUrl: `https://example.test/${path}.git`
      };
      const remaining = MAX_MANAGED_GIT_RECORD_BYTES - canonicalBytes(base);
      if (remaining >= 0 && remaining <= 254) exact = { ...base, branch: 'b'.repeat(1 + remaining) };
    }
    if (exact === undefined) throw new Error('test could not construct exact provenance boundary');
    const above = { ...exact, branch: `${exact.branch}b` };
    expect(canonicalBytes(exact)).toBe(MAX_MANAGED_GIT_RECORD_BYTES);
    expect(canonicalBytes(above)).toBe(MAX_MANAGED_GIT_RECORD_BYTES + 1);
    expect(decodePathFreeManagedGitIdentity(exact)).toEqual(exact);
    expect(() => decodePathFreeManagedGitIdentity(above)).toThrow(new RegExp(`${MAX_MANAGED_GIT_RECORD_BYTES}-byte`, 'u'));
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
