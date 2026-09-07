import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { qualificationArguments, runWindowsQualification } = await import(pathToFileURL(
  resolve('scripts/run-win32-qualification.mjs')
).href);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); vi.unstubAllEnvs(); });
const all = ['foundation-source', 'foundation-installed', 'product-source', 'product-installed'];
async function fixture(selection = 'all', fail = '') {
  const root = await mkdtemp(join(tmpdir(), 'bazframe-qualification-'));
  roots.push(root);
  const source = join(root, 'source'), installed = join(root, 'installed');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(installed);
  const script = `
import { writeFile, unlink, appendFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
const root = ${JSON.stringify(root)}, source = ${JSON.stringify(source)};
const installed = process.argv[process.argv.indexOf('--package-root') + 1] !== source;
const lane = (basename(process.argv[1]).includes('added-skill') ? 'product-' : 'foundation-') + (installed ? 'installed' : 'source');
// A real exclusive shared sentinel refuses any top-level overlap.
await writeFile(join(root, 'active'), lane, { flag: 'wx' });
await appendFile(join(root, 'order'), lane + '\\n');
await writeFile(process.argv[process.argv.indexOf('--output') + 1], JSON.stringify({ lane, offline: process.env.npm_config_offline, testParent: process.env.BAZFRAME_WIN32_NATIVE_TEST_PARENT }));
console.error('PRIVATE-CHILD-ERROR ' + root);
await unlink(join(root, 'active'));
if (lane === ${JSON.stringify(fail)}) process.exit(7);
`;
  for (const name of ['test-win32-native-foundation.mjs', 'test-win32-added-skill-lifecycle.mjs']) await writeFile(join(source, 'scripts', name), script);
  const schedule = selection === 'all' ? all : selection === 'foundation' ? all.slice(0, 2) : [selection];
  const args = [...(selection === 'all' ? [] : ['--selection', selection]), '--source-root', source,
    ...(schedule.some((lane) => lane.endsWith('installed')) ? ['--installed-root', installed] : []),
    ...schedule.flatMap((lane) => [`--${lane}-output`, join(root, `${lane}.json`)])];
  return { root, source, installed, args, schedule };
}

describe('native qualification fixed schedules', () => {
  it.each(['all', 'foundation', 'product-source', 'product-installed'])('runs exactly %s serial real children with unchanged environment and roots', async (selection) => {
    const f = await fixture(selection);
    vi.stubEnv('npm_config_offline', 'true');
    vi.stubEnv('BAZFRAME_WIN32_NATIVE_TEST_PARENT', join(f.root, 'caller-parent'));
    const environment = { ...process.env }, labels: string[] = [];
    let active = 0;
    const result = await runWindowsQualification(f.args, { log: (label: string) => labels.push(label),
      spawnProcess(executable: string, args: string[], options: SpawnOptions) {
        expect(active++).toBe(0);
        expect(executable).toBe(process.execPath);
        expect(options).toMatchObject({ cwd: f.source, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], env: environment });
        const lane = f.schedule[labels.filter((label) => label.endsWith(':start')).length - 1]!;
        expect(args).toEqual([join(f.source, 'scripts', lane.startsWith('foundation') ? 'test-win32-native-foundation.mjs' : 'test-win32-added-skill-lifecycle.mjs'),
          '--package-root', lane.endsWith('installed') ? f.installed : f.source, '--output', join(f.root, `${lane}.json`)]);
        const child = spawn(executable, args, options);
        child.once('close', () => { active--; });
        return child;
      }
    });
    expect(result.passed).toBe(true);
    expect((await readFile(join(f.root, 'order'), 'utf8')).trim().split('\n')).toEqual(f.schedule);
    expect(labels).toEqual(f.schedule.flatMap((lane) => [`qualification:${lane}:start`, `qualification:${lane}:end:passed`]));
    for (const lane of f.schedule) expect(JSON.parse(await readFile(join(f.root, `${lane}.json`), 'utf8'))).toEqual({ lane, offline: 'true', testParent: environment.BAZFRAME_WIN32_NATIVE_TEST_PARENT });
    expect(process.env).toEqual(environment);
  });

  it.each(all)('never advances after failed %s', async (lane) => {
    const f = await fixture('all', lane);
    const result = await runWindowsQualification(f.args, { log() {} });
    expect(result.passed).toBe(false);
    expect(result.outcomes).toHaveLength(all.indexOf(lane) + 1);
    expect(result.outcomes.at(-1)).toEqual({ lane, outcome: 'nonzero' });
  });

  it.each(['throw', 'error-event', 'signal'])('fails closed on real %s without raw output', async (mode) => {
    const f = await fixture(), labels: string[] = [];
    const result = await runWindowsQualification(f.args, { log: (label: string) => labels.push(label),
      spawnProcess(executable: string, args: string[], options: SpawnOptions) {
        if (mode === 'throw') throw new Error(`PRIVATE ${f.root}`);
        const child = spawn(mode === 'error-event' ? join(f.root, 'missing-executable') : executable, args, options);
        if (mode === 'signal') child.once('spawn', () => child.kill('SIGTERM'));
        return child;
      }
    });
    expect(result.outcomes).toEqual([{ lane: 'foundation-source', outcome: mode === 'signal' ? 'signaled' : 'spawn-failed' }]);
    expect(labels.join('\n')).not.toMatch(/PRIVATE|bazframe-qualification-/u);
  });

  it('waits for close after error/exit, never advancing a failed process', async () => {
    const f = await fixture(), labels: string[] = [];
    const result = await runWindowsQualification(f.args, { log: (label: string) => labels.push(label), spawnProcess() {
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit('spawn'); child.emit('error', new Error('PRIVATE')); child.emit('exit', 0, null);
        expect(labels).toEqual(['qualification:foundation-source:start']);
        queueMicrotask(() => child.emit('close', 0, null));
      });
      return child;
    } });
    expect(result.outcomes).toEqual([{ lane: 'foundation-source', outcome: 'process-error' }]);
  });

  it('refuses occupied selected receipts before any child', async () => {
    const f = await fixture();
    await writeFile(f.args[5]!, 'retained');
    const spawnProcess = vi.fn();
    await expect(runWindowsQualification(f.args, { spawnProcess })).rejects.toThrow('Qualification output occupied.');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown', 'duplicate-key', 'duplicate-output', 'case-alias', 'relative', 'nul', 'non-json', 'same-root', 'selection', 'all-alias', 'timeout'])('rejects %s arguments before effects', async (mode) => {
    const { args } = await fixture();
    if (mode === 'missing') args.pop();
    if (mode === 'unknown') args[0] = '--command';
    if (mode === 'duplicate-key') args[0] = args[2]!;
    if (mode === 'duplicate-output') args[7] = args[5]!;
    if (mode === 'case-alias') args[7] = args[5]!.toUpperCase();
    if (mode === 'relative') args[1] = 'relative';
    if (mode === 'nul') args[1] += '\0';
    if (mode === 'non-json') args[5] += '.node';
    if (mode === 'same-root') args[3] = args[1]!;
    if (mode === 'selection') args.unshift('--selection', 'custom');
    if (mode === 'all-alias') args.unshift('--selection', 'all');
    if (mode === 'timeout') args.push('--timeout', '30');
    expect(() => qualificationArguments(args)).toThrow('Invalid qualification arguments.');
  });

  it('sanitizes CLI failures', () => {
    const result = spawnSync(process.execPath, ['scripts/run-win32-qualification.mjs', '--private-path'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('qualification:refused');
  });
});

describe('isolated workflow and local PowerShell contract', () => {
  it('gates final promotion on all three jobs, retains local build/pack/install once, and never admits release', async () => {
    const workflow = await readFile('.github/workflows/win32-native-foundation.yml', 'utf8');
    const local = await readFile('scripts/run-win32-native-foundation.ps1', 'utf8');
    const jobs = Object.fromEntries(workflow.split(/^ {2}(foundation|product-source|product-installed|promote):\n/mu).slice(1).reduce<Array<[string, string]>>((pairs, text, index, parts) => {
      if (index % 2 === 0) pairs.push([text, parts[index + 1]!]); return pairs;
    }, []));
    expect(Object.keys(jobs)).toEqual(['foundation', 'product-source', 'product-installed', 'promote']);
    for (const [name, text] of Object.entries(jobs)) {
      expect(text).toContain('runs-on: windows-2022'); expect(text).toContain('timeout-minutes: 30');
      expect(text).toContain('ref: ${{ github.sha }}'); expect(text).toContain('persist-credentials: false');
      expect(text.match(/git status --porcelain=v1 --untracked-files=all/g)).toHaveLength(2);
      const diagnostic = text.slice(text.indexOf('      - name: Upload sanitized'));
      expect(diagnostic).toContain('if: failure() || cancelled()');
      expect(diagnostic).not.toMatch(/\.node|\.tgz|\.zip|native-binary/u);
      if (name !== 'promote') {
        expect(text.match(/npm run build/g)).toHaveLength(1);
        expect(text.match(/npm pack --ignore-scripts --json --silent/g)).toHaveLength(1);
        expect(text).toContain(`--selection ${name}`);
        expect(text).not.toContain('id: upload-success');
        expect(text).toContain(`name: bazframe-win32-qualification-input-${name}-`);
      }
      if (name.startsWith('product-')) {
        expect(text).toContain('needs: foundation'); expect(text).not.toContain('cargo +');
        expect(text.indexOf('win32-qualification-input.mjs repack')).toBeLessThan(text.indexOf('run-win32-qualification.mjs'));
        expect(text.indexOf("$env:npm_config_offline = 'true'")).toBeLessThan(text.indexOf('run-win32-qualification.mjs'));
      }
    }
    expect(jobs.promote).toContain('needs: [foundation, product-source, product-installed]');
    expect(jobs.promote!.match(/if: success\(\)/g)).toHaveLength(2);
    expect(jobs.promote!.indexOf('win32-qualification-input.mjs promote')).toBeLessThan(jobs.promote!.indexOf('name: bazframe-win32-added-skill-product-'));
    expect(jobs.promote!.indexOf('name: bazframe-win32-added-skill-product-')).toBeLessThan(jobs.promote!.indexOf('id: upload-success'));
    expect(workflow).toContain('value: ${{ jobs.promote.outputs.artifact_id }}');
    expect(workflow).toContain('github.event.pull_request.head.sha || github.sha');
    expect(workflow).toContain('github.event.pull_request.head.repo.id || github.repository_id');
    expect(workflow).not.toContain('admitWin32NativeRelease');
    expect(workflow).not.toContain('win32-native-release-admission.json');
    expect(local.match(/\$npmCommand run build/g)).toHaveLength(1);
    expect(local.match(/\$npmCommand pack --ignore-scripts --json --silent/g)).toHaveLength(1);
    expect(local.indexOf('install --prefix')).toBeLessThan(local.indexOf("$env:npm_config_offline = 'true'"));
    expect(local).not.toContain('--selection');
    expect(local.indexOf('[System.IO.File]::ReadAllBytes($artifactPath)')).toBeGreaterThan(local.indexOf('$finalCommit ='));
  });
});
