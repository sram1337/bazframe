import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { readlink } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { windowsApplicationFixture, HOME, PI, REPOSITORY } from '../../helpers/windows-application-fixture.js';
import { runCli, runCliForInternalTesting } from '../../../src/cli/run-cli.js';
import { createWindowsApplicationServices } from '../../../src/application/win32-application-services.js';
import { createBazframeTuiService } from '../../../src/application/tui-service.js';
import { VERSION } from '../../../src/cli/help.js';

vi.mock('node:fs/promises', async (original) => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, readlink: vi.fn(actual.readlink) }; });

async function cli(f: ReturnType<typeof windowsApplicationFixture>, args: string[]) {
  vi.mocked(readlink).mockImplementation(async (path) => f.options.readLinkPath(String(path)));
  let stdout = '', stderr = '';
  const status = await runCliForInternalTesting(args, { application: f.application, environment: f.environment, userHome: 'C:\\boundary', cwd: () => REPOSITORY, writeStdout: (text) => { stdout += text; }, writeStderr: (text) => { stderr += text; } });
  return { status, stdout, stderr };
}
describe('shared Windows application composition (host receipts, not native acceptance)', () => {
  it('constructs lazily and keeps public CLI gates before backend access in human and JSON modes', async () => {
    let accesses = 0;
    const application = createWindowsApplicationServices({ backend: () => { accesses++; throw new Error('native touched'); } });
    expect(accesses).toBe(0);
    for (const args of [['status'], ['status', '--json'], ['profile', 'list'], ['adapter', 'install', 'pi']]) {
      expect(await runCli(args, { platform: 'win32', application, writeStdout() {}, writeStderr() {} })).toBe(1);
    }
    expect(accesses).toBe(0);
  });
  it('connects CLI profile/adapter/policy/status, TUI read/rename/favorite and retained uninstall', async () => {
    const f = windowsApplicationFixture();
    expect(await cli(f, ['profile', 'add', 'work'])).toMatchObject({ status: 0 });
    expect(await cli(f, ['profile', 'use', 'work'])).toMatchObject({ status: 0 });
    expect(await cli(f, ['adapter', 'install', 'pi'])).toMatchObject({ status: 0 });
    expect(await cli(f, ['project', 'enable'])).toMatchObject({ status: 0 });
    const ready = await cli(f, ['status', '--json']);
    expect(ready, ready.stderr || ready.stdout).toMatchObject({ status: 0 });
    expect(ready.stdout).toContain('work');
    const tui = createBazframeTuiService({ bazframeHome: HOME, bazframeVersion: VERSION, cwd: REPOSITORY, environment: f.environment, application: f.application });
    const before = f.snapshot();
    const dashboard = await tui.loadDashboard();
    expect(f.snapshot()).toBe(before);
    expect(dashboard.profiles.map((profile) => profile.id), JSON.stringify(dashboard.diagnostics)).toEqual(['work']);
    await tui.toggleProfileFavorite('work');
    await tui.renameProfile('work', 'renamed');
    expect((await tui.loadDashboard()).profiles).toEqual([expect.objectContaining({ id: 'renamed', active: true, favorite: true })]);
    expect(await cli(f, ['global', 'disable'])).toMatchObject({ status: 0 });
    const disabled = await cli(f, ['status', '--json']);
    expect(disabled.status).toBe(0);
    expect(await cli(f, ['global', 'enable'])).toMatchObject({ status: 0 });
    f.file(PI + '\\extensions\\unrelated.ts', 'unrelated');
    const alias = HOME + '\\adapter-cache\\pi\\skill-aliases\\renamed\\demo-bazframe\\SKILL.md';
    await f.runtime().writeAlias(alias, '---\nname: demo-bazframe\ndescription: wrapper\n---\n', HOME);
    expect(await f.application.countAliasCache!(HOME)).toBe(1);
    expect(await cli(f, ['adapter', 'uninstall', 'pi'])).toMatchObject({ status: 0 });
    const discovered = [...f.nodes.keys()].filter((path) => path.startsWith(PI + '\\extensions\\') && /\.(?:ts|js)$/u.test(path));
    expect(discovered).toEqual([PI + '\\extensions\\unrelated.ts']);
    expect([...f.nodes.keys()].some((path) => path.endsWith('.retained'))).toBe(true);
    expect(await f.application.countAliasCache!(HOME)).toBe(0);
    expect(f.nodes.get(HOME + '\\active-profile')?.bytes?.toString()).toBe('renamed\n');
  });
  it('connects ordinary CLI/list/view/Pi, resource reads and mutations without existing owner/ACL admission', async () => {
    const f = windowsApplicationFixture();
    await cli(f, ['profile', 'add', 'work']);
    await cli(f, ['profile', 'use', 'work']);
    const instructions = HOME + '\\profiles\\work\\AGENTS.md';
    f.file(instructions, 'Readable hardlinked instructions');
    f.nodes.get(instructions)!.numberOfLinks = 2;
    f.file('C:\\boundary\\source\\local\\SKILL.md', '---\nname: local\ndescription: Readable local Skill\n---\n');
    await cli(f, ['skill', 'add', 'C:\\boundary\\source\\local']);
    await cli(f, ['profile', 'skill', 'add', 'local']);
    f.nodes.get('C:\\boundary\\source\\local\\SKILL.md')!.numberOfLinks = 2;
    for (const [path, node] of f.nodes) node.security = { ...f.security(path), ownerSid: 'S-1-5-21-999', descriptorControl: 4, daclBytes: Buffer.alloc(0) };
    const before = f.snapshot(), homeNode = f.nodes.get(HOME)!;
    const listed = await cli(f, ['profile', 'list', '--json']);
    expect(listed.status, listed.stdout || listed.stderr).toBe(0);
    expect(listed.stdout).toContain('work');
    const profile = await f.runtime().loadProfile(HOME);
    expect(profile.skills.map((skill) => skill.name)).toContain('local');
    expect(f.snapshot()).toBe(before);
    // Atomic policy publication creates a new private object, not a permission repair of home.
    expect((await cli(f, ['global', 'disable'])).status).toBe(0);
    expect(f.nodes.get(HOME)).toBe(homeNode);
    expect(f.security(HOME).ownerSid).toBe('S-1-5-21-999');
    expect(f.security(HOME + '\\global.json').descriptorControl & 0x1000).toBe(0x1000);
    const original = f.nodes.get(HOME + '\\profiles\\work')!;
    expect((await cli(f, ['profile', 'rename', 'work', 'renamed'])).status).toBe(0);
    expect(f.nodes.get(HOME + '\\profiles\\renamed')).toBe(original);
    expect(f.security(HOME + '\\profiles\\renamed').ownerSid).toBe('S-1-5-21-999');
  });

  it('never bootstraps state during disabled status, dashboard, discovery and missing-home listing', async () => {
    const f = windowsApplicationFixture(), before = f.snapshot();
    expect((await cli(f, ['profile', 'list', '--json'])).status).toBe(0);
    expect((await cli(f, ['project', 'list', '--json'])).status).toBe(0);
    await cli(f, ['status', '--json']);
    expect(f.snapshot()).toBe(before);
    expect(f.nodes.has(HOME)).toBe(false);
  });
  it('connects Windows ZIP export/dry-run/import and immutable imported runtime/status/TUI resources', async () => {
    const f = windowsApplicationFixture();
    expect((await cli(f, ['profile', 'add', 'work'])).status).toBe(0);
    expect((await cli(f, ['profile', 'use', 'work'])).status).toBe(0);
    f.file('C:\\boundary\\source\\local\\SKILL.md', '---\nname: local\ndescription: Captured local Skill\n---\nOriginal bytes\n');
    expect((await cli(f, ['skill', 'add', 'C:\\boundary\\source\\local'])).status).toBe(0);
    expect((await cli(f, ['profile', 'skill', 'add', 'local'])).status).toBe(0);
    const exported = await cli(f, ['profile', 'export', '--output', 'C:\\boundary\\work.zip', '--json']);
    expect(exported.status, exported.stdout).toBe(0);
    const before = [...f.nodes].filter(([path]) => path.startsWith(HOME)).map(([path, node]) => [path, JSON.stringify(node)]);
    const dry = await cli(f, ['profile', 'import', 'C:\\boundary\\work.zip', '--dry-run', '--json']);
    expect(dry.status, dry.stdout).toBe(0);
    expect([...f.nodes].filter(([path]) => path.startsWith(HOME)).map(([path, node]) => [path, JSON.stringify(node)])).toEqual(before);
    expect((await cli(f, ['profile', 'import', 'C:\\boundary\\work.zip', '--yes', '--json'])).status).toBe(0);
    expect((await cli(f, ['profile', 'use', 'work-1'])).status).toBe(0);
    const projected = await f.runtime().loadProfile(HOME);
    expect(projected.skills).toEqual([expect.objectContaining({ name: 'local', description: 'Captured local Skill' })]);
    expect(projected.skills[0]!.filePath).toContain('profile-publishing\\trees');
    expect(projected.skills[0]!.filePath).not.toContain('profiles\\work\\skills');
    const tui = createBazframeTuiService({ bazframeHome: HOME, bazframeVersion: VERSION, cwd: REPOSITORY, environment: f.environment, application: f.application });
    const dashboard = await tui.loadDashboard();
    const imported = dashboard.profiles.find((profile) => profile.id === 'work-1')!;
    expect(imported.completeness).toBe('complete');
    const membership = imported.memberships.find((item) => item.originId?.startsWith('imported:'))!;
    expect((await tui.loadSkillPreview({ originId: membership.originId!, skillId: membership.skillId })).contents).toContain('Original bytes');
    const status = await cli(f, ['status', '--json']);
    expect(status.stdout).toContain('work-1');
    expect(status.stdout).toContain('complete');
    expect(f.nodes.has(HOME + '\\profiles\\work-1\\skills')).toBe(false);
    f.file('C:\\boundary\\more\\derived\\SKILL.md', '---\nname: derived\ndescription: Noncolliding derived\n---\n');
    expect((await cli(f, ['library', 'add', 'C:\\boundary\\more'])).status).toBe(0);
    const missingSkills = HOME + '\\profiles\\work-1\\skills';
    for (const occupancy of ['file', 'reparse', 'alias']) {
      const occupied = occupancy === 'alias' ? HOME + '\\profiles\\work-1\\SKILLS' : missingSkills;
      if (occupancy === 'file') f.file(occupied, 'foreign'); else if (occupancy === 'reparse') f.reparse(occupied); else f.directory(occupied);
      expect((await cli(f, ['profile', 'library', 'add', 'more'])).status).not.toBe(0);
      expect(f.nodes.has(occupied)).toBe(true); expect(f.nodes.has(HOME + '\\profiles\\work-1\\libraries\\more.json')).toBe(false);
      f.nodes.delete(occupied);
    }
    const reference = await cli(f, ['profile', 'library', 'add', 'more']); expect(reference.status, reference.stderr).toBe(0);
    expect(f.nodes.has(HOME + '\\profiles\\work-1\\skills')).toBe(false);
    f.file('C:\\boundary\\source\\extra\\SKILL.md', '---\nname: extra\ndescription: Noncolliding direct\n---\n');
    expect((await cli(f, ['skill', 'add', 'C:\\boundary\\source\\extra'])).status).toBe(0);
    await tui.addMembership('work-1', { originId: 'default', skillId: 'extra' });
    expect(f.nodes.get(HOME + '\\profiles\\work-1\\skills\\extra')?.kind).toBe('reparse');
    expect((await f.runtime().loadProfile(HOME)).skills.map((skill) => skill.name).sort()).toEqual(['derived', 'extra', 'local']);
  });

  it('shares one lazy native backend identity without retaining operation authority', async () => {
    const f = windowsApplicationFixture(); let loads = 0;
    const application = createWindowsApplicationServices({ ...f.options, backend: () => { loads++; return { ...f.backend }; } });
    expect(loads).toBe(0);
    await application.policy!.withLock(HOME, 'first', async (writer) => { await writer.publish(HOME + '\\global.json', Buffer.from('{"schemaVersion":1,"policy":"disabled"}'), await application.policy!.snapshot(HOME + '\\global.json', 65536), 65536); });
    void application.provisioning; void application.copyProfileEffects; void application.selection;
    expect(loads).toBe(1);
    let stale: (() => void) | undefined;
    await application.policy!.withLock(HOME, 'second', async (writer) => { stale = writer.assertHeld; });
    expect(() => stale!()).toThrow(/expired|live|active/);
  });
  it('connects physical browsing/candidates, local library snapshots, TUI editors and stale removal proofs', async () => {
    const f = windowsApplicationFixture();
    await cli(f, ['profile', 'add', 'work']); await cli(f, ['profile', 'use', 'work']);
    f.file('C:\\boundary\\library\\demo\\SKILL.md', '---\nname: demo\ndescription: Preview demo\n---\nPreview body\n');
    const opened: string[][] = [];
    const tui = createBazframeTuiService({ bazframeHome: HOME, bazframeVersion: VERSION, cwd: REPOSITORY, environment: f.environment, userHome: 'C:\\boundary', application: f.application, editorChildRunner: async (exe, args) => { opened.push([exe, ...args]); return { exitCode: 0, signal: null }; } });
    await expect(tui.inspectLibraryInput('~\\')).rejects.toThrow(/exact ~ or ~\//);
    const browser = await tui.inspectLibraryInput('C:\\boundary\\lib');
    expect(browser).toMatchObject({ kind: 'directory', browser: { entries: [{ name: 'library', path: 'C:\\boundary\\library' }] } });
    expect(await tui.inspectLibraryCandidate({ source: 'C:\\boundary\\library' })).toMatchObject({ kind: 'directory', libraryId: 'library', packageManifest: { state: 'absent' } });
    await tui.addLibrary({ source: 'C:\\boundary\\library' });
    expect((await tui.loadSkillPreview({ originId: 'library:library', skillId: 'demo' })).contents).toContain('Preview body');
    await cli(f, ['skill', 'add', 'C:\\boundary\\library\\demo']);
    await tui.addMembership('work', { originId: 'default', skillId: 'demo' });
    await tui.editSkillDefinition({ originId: 'default', skillId: 'demo' });
    await tui.editProfileInstructions('work');
    expect(opened.map((entry) => entry[1])).toEqual(['C:\\boundary\\library\\demo\\SKILL.md', HOME + '\\profiles\\work\\AGENTS.md']);
    const before = (await tui.loadDashboard()).profiles[0]!;
    f.file(HOME + '\\profiles\\work\\AGENTS.md', 'changed after disclosure');
    await expect(tui.removeProfile('work', { kind: 'recursive', confirmedProfileId: 'work', removalIdentity: before.removalIdentity })).rejects.toThrow(/changed|stale|identity/i);
    expect(f.nodes.has(HOME + '\\profiles\\work')).toBe(true);
  });

  it.each(['success', 'nonzero', 'signal', 'spawn-error', 'cleanup-proof'])('connects launcher temporary publication, child %s and guarded retention', async (outcome) => {
    const f = windowsApplicationFixture(); await cli(f, ['profile', 'add', 'work']); await cli(f, ['profile', 'use', 'work']);
    f.file(REPOSITORY + '\\AGENTS.md', 'Repository body\n');
    let temporary = '', stderr = '';
    const application = Object.create(f.application, { launcher: { value: { ...f.application.launcher, spawnProcess: ((executable: string, args: string[], options: object) => {
      expect(executable).toBe('C:\\tools\\pi.exe'); expect(options).toMatchObject({ cwd: REPOSITORY, shell: false, stdio: 'inherit', env: f.environment });
      temporary = args[args.indexOf('--append-system-prompt') + 1]!;
      const bytes = f.nodes.get(temporary)!.bytes!.toString(); expect(bytes).toContain('Repository body\n'); expect(bytes).toContain('work');
      expect(args.slice(-2)).toEqual(['--model', 'literal & model']);
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} });
      queueMicrotask(() => { if (outcome === 'cleanup-proof') f.directory(win32.dirname(temporary)); if (outcome === 'spawn-error') child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); else child.emit('close', outcome === 'nonzero' ? 7 : outcome === 'signal' ? null : 0, outcome === 'signal' ? 'SIGTERM' : null); });
      return child;
    }) as typeof spawn } } });
    const status = await runCliForInternalTesting(['pi', '--', '--model', 'literal & model'], { application, environment: f.environment, cwd: () => REPOSITORY, temporaryRoot: 'C:\\boundary', writeStdout() {}, writeStderr: (text) => { stderr += text; } });
    expect(status, stderr).toBe(outcome === 'success' ? 0 : outcome === 'nonzero' ? 7 : outcome === 'signal' ? 143 : 1);
    expect(f.nodes.has(temporary)).toBe(true); expect(temporary.startsWith(REPOSITORY + '\\')).toBe(false);
  });
  it('keeps launcher dry-run, disabled and unsafe-forwarded branches free of temporary publication/spawn', async () => {
    const f = windowsApplicationFixture(); await cli(f, ['profile', 'add', 'work']); await cli(f, ['profile', 'use', 'work']);
    const before = f.snapshot(); expect((await cli(f, ['pi', '--dry-run'])).status).toBe(0); expect(f.snapshot()).toBe(before);
    expect((await cli(f, ['pi', '--', '--resume'])).status).not.toBe(0); expect(f.snapshot()).toBe(before);
    await cli(f, ['global', 'disable']); const disabled = f.snapshot(); expect((await cli(f, ['pi'])).status).not.toBe(0); expect(f.snapshot()).toBe(disabled);
  });

});
