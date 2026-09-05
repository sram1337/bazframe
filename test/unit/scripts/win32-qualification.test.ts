import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const { qualificationArguments, runWindowsQualification } = await import(pathToFileURL(
  resolve('scripts/run-win32-qualification.mjs')
).href);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(mode = 'overlap') {
  const root = await mkdtemp(join(tmpdir(), 'bazframe-qualification-'));
  roots.push(root);
  const source = join(root, 'source'), installed = join(root, 'installed');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(installed);
  // Real child processes rendezvous through separate files, without polling or timers.
  const script = `
import { existsSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
const root = ${JSON.stringify(root)}, source = ${JSON.stringify(source)}, mode = ${JSON.stringify(mode)};
const installed = process.argv[process.argv.indexOf('--package-root') + 1] !== source;
const lane = (basename(process.argv[1]).includes('added-skill') ? 'product-' : 'foundation-') + (installed ? 'installed' : 'source');
await writeFile(join(root, lane + '.start'), 'started');
if (mode === 'overlap') await new Promise((done) => {
  const required = ['product-source', 'product-installed', 'foundation-source'];
  const watcher = watch(root, () => check());
  function check() { if (required.every((name) => existsSync(join(root, name + '.start')))) { watcher.close(); done(); } }
  check();
});
if (lane === 'foundation-installed' && !existsSync(join(root, 'foundation-source.done')) && mode !== 'source-spawn-failed') process.exit(9);
await writeFile(process.argv[process.argv.indexOf('--output') + 1], JSON.stringify({ lane, offline: process.env.npm_config_offline }));
await writeFile(join(root, lane + '.done'), 'settled');
console.error('PRIVATE-CHILD-ERROR ' + root);
if (mode === lane + '-fail') process.exit(7);
`;
  for (const name of ['test-win32-native-foundation.mjs', 'test-win32-added-skill-lifecycle.mjs']) await writeFile(join(source, 'scripts', name), script);
  const args = ['--source-root', source, '--installed-root', installed,
    '--foundation-source-output', join(root, 'foundation-source.json'), '--foundation-installed-output', join(root, 'foundation-installed.json'),
    '--product-source-output', join(root, 'product-source.json'), '--product-installed-output', join(root, 'product-installed.json')];
  return { root, source, installed, args };
}

describe('native qualification coordinator', () => {
  it('overlaps independent products with one sequential source-to-installed foundation lane', async () => {
    const f = await fixture();
    const labels: string[] = [];
    const calls: Array<{ executable: string; args: string[]; options: SpawnOptions }> = [];
    const result = await runWindowsQualification(f.args, { log: (label: string) => labels.push(label),
      spawnProcess(executable: string, args: string[], options: SpawnOptions) {
        calls.push({ executable, args, options });
        return spawn(executable, args, options);
      }
    });
    expect(result.passed).toBe(true);
    expect(result.outcomes).toHaveLength(4);
    expect(labels.slice(0, 3)).toEqual(['qualification:product-source:start', 'qualification:product-installed:start', 'qualification:foundation-source:start']);
    expect(labels.indexOf('qualification:foundation-source:end:passed')).toBeLessThan(labels.indexOf('qualification:foundation-installed:start'));
    expect(labels).toHaveLength(8);
    for (const call of calls) {
      expect(call.executable).toBe(process.execPath);
      expect(call.options).toMatchObject({ cwd: f.source, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      expect(call.options.env).toBe(process.env);
      const receipt = JSON.parse(await readFile(call.args.at(-1)!, 'utf8'));
      expect(receipt.lane).toMatch(/^(foundation|product)-(source|installed)$/u);
      expect(call.args).toEqual([join(f.source, 'scripts', receipt.lane.startsWith('product') ? 'test-win32-added-skill-lifecycle.mjs' : 'test-win32-native-foundation.mjs'),
        '--package-root', receipt.lane.endsWith('installed') ? f.installed : f.source, '--output', join(f.root, `${receipt.lane}.json`)]);
    }
    expect(labels.join('\n')).not.toContain('PRIVATE');
    expect(labels.join('\n')).not.toContain(f.root);
  });

  it.each(['product-source-fail', 'foundation-source-fail'])('settles every lane after %s, and refuses qualification', async (mode) => {
    const f = await fixture(mode);
    const labels: string[] = [];
    const result = await runWindowsQualification(f.args, { log: (label: string) => labels.push(label) });
    expect(result.passed).toBe(false);
    expect(result.outcomes.filter((value: { outcome: string }) => value.outcome === 'nonzero')).toHaveLength(1);
    expect(labels.filter((label) => label.includes(':end:'))).toHaveLength(4);
    for (const lane of ['product-source', 'product-installed', 'foundation-source', 'foundation-installed']) expect(await readFile(join(f.root, `${lane}.done`), 'utf8')).toBe('settled');
    expect(labels.indexOf(`qualification:foundation-source:end:${mode.startsWith('foundation') ? 'nonzero' : 'passed'}`)).toBeLessThan(labels.indexOf('qualification:foundation-installed:start'));
  });

  it.each(['throw', 'error-event'])('settles other real children after a sanitized %s spawn failure', async (mode) => {
    const f = await fixture('basic');
    const labels: string[] = [];
    let first = true;
    const result = await runWindowsQualification(f.args, { log: (label: string) => labels.push(label),
      spawnProcess(executable: string, args: string[], options: SpawnOptions) {
        if (first) {
          first = false;
          if (mode === 'throw') throw new Error(`PRIVATE ${f.root}`);
          return spawn(join(f.root, 'missing-executable'), args, options);
        }
        return spawn(executable, args, options);
      }
    });
    expect(result.passed).toBe(false);
    expect(result.outcomes[0]).toEqual({ lane: 'product-source', outcome: 'spawn-failed' });
    expect(result.outcomes.slice(1).every((value: { outcome: string }) => value.outcome === 'passed')).toBe(true);
    expect(labels.join('\n')).not.toContain(f.root);
    expect(labels.filter((label) => label.includes(':end:'))).toHaveLength(4);
  });

  it('settles a genuinely signaled child and the remaining real processes', async () => {
    const f = await fixture('basic');
    let first = true;
    const result = await runWindowsQualification(f.args, { log() {},
      spawnProcess(executable: string, args: string[], options: SpawnOptions) {
        const child = spawn(executable, args, options);
        if (first) { first = false; child.once('spawn', () => child.kill('SIGTERM')); }
        return child;
      }
    });
    expect(result.passed).toBe(false);
    expect(result.outcomes[0]).toEqual({ lane: 'product-source', outcome: 'signaled' });
    expect(result.outcomes.slice(1).every((value: { outcome: string }) => value.outcome === 'passed')).toBe(true);
  });

  it.each(['process-error', 'signaled'])('waits for close and distinguishes %s without leaking event details', async (outcome) => {
    const f = await fixture();
    const processes: EventEmitter[] = [], labels: string[] = [];
    const result = runWindowsQualification(f.args, {
      log: (label: string) => labels.push(label),
      spawnProcess() {
        const child = new EventEmitter(); processes.push(child);
        queueMicrotask(() => {
          child.emit('spawn');
          if (processes.indexOf(child) === 0 && outcome === 'process-error') child.emit('error', new Error('PRIVATE exception'));
          // Neither error nor exit settles a lane before close.
          child.emit('exit', 0, null);
          expect(labels.filter((label) => label.includes(':end:'))).toHaveLength(processes.length === 4 ? 3 : 0);
          queueMicrotask(() => child.emit('close', outcome === 'signaled' && processes.indexOf(child) === 0 ? null : 0,
            outcome === 'signaled' && processes.indexOf(child) === 0 ? 'PRIVATE-SIGNAL' : null));
        });
        return child;
      }
    });
    expect((await result).outcomes[0]).toEqual({ lane: 'product-source', outcome });
    expect(labels.filter((label) => label.includes(':end:'))).toHaveLength(4);
    expect(labels.join('\n')).not.toContain('PRIVATE');
  });

  it('refuses occupied receipt paths before spawning any lane', async () => {
    const f = await fixture();
    await writeFile(f.args[5]!, 'retained');
    let spawned = false;
    await expect(runWindowsQualification(f.args, { spawnProcess() { spawned = true; } })).rejects.toThrow('Qualification output occupied.');
    expect(spawned).toBe(false);
    expect(await readFile(f.args[5]!, 'utf8')).toBe('retained');
  });

  it.each(['missing', 'unknown', 'duplicate-key', 'duplicate-output', 'case-alias', 'relative', 'nul', 'non-json', 'same-root'])('rejects %s arguments before effects', async (mode) => {
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
    expect(() => qualificationArguments(args)).toThrow('Invalid qualification arguments.');
  });

  it('uses a non-identifying nonzero CLI failure for malformed input', () => {
    const result = spawnSync(process.execPath, ['scripts/run-win32-qualification.mjs', '--private-path'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('qualification:refused');
  });
});

describe('native workflow and local PowerShell scheduling contract', () => {
  it('builds/packs/installs once before the shared offline coordinator, without changing receipts or admission', async () => {
    const workflow = await readFile('.github/workflows/win32-native-foundation.yml', 'utf8');
    const local = await readFile('scripts/run-win32-native-foundation.ps1', 'utf8');
    for (const text of [workflow, local]) {
      expect(text.match(/(?:npm|\$npmCommand) run build/g)).toHaveLength(1);
      expect(text.match(/(?:npm|\$npmCommand) pack --ignore-scripts --json --silent/g)).toHaveLength(1);
      expect(text.indexOf('pack --ignore-scripts')).toBeLessThan(text.indexOf('install --prefix'));
      expect(text.indexOf('install --prefix')).toBeLessThan(text.indexOf("$env:npm_config_offline = 'true'"));
      const coordinator = text.indexOf('run-win32-qualification.mjs `');
      expect(text.indexOf("$env:npm_config_offline = 'true'")).toBeLessThan(coordinator);
      expect(text.indexOf('$installedHash -ne')).toBeLessThan(coordinator);
      expect(text.indexOf('verify-win32-added-skill-evidence.mjs --source')).toBeGreaterThan(coordinator);
      expect(text.indexOf('$finalCommit =')).toBeGreaterThan(coordinator);
      for (const argument of ['--source-root', '--installed-root', '--foundation-source-output', '--foundation-installed-output', '--product-source-output', '--product-installed-output']) expect(text).toContain(argument);
      expect(text).not.toMatch(/(?:node|\$nodeCommand) .*(?:test-win32-native-foundation|test-win32-added-skill-lifecycle)\.mjs --/u);
      expect(text).toContain('test/unit/scripts/win32-qualification.test.ts');
    }
    expect(workflow).toContain('timeout-minutes: 30');
    expect(workflow).toContain("$productEvidenceRoot = Join-Path $env:RUNNER_TEMP 'win32-native-evidence-product'");
    expect(local).toContain("$productSourceEvidencePath = Join-Path $evidenceRoot 'win32-product-source-evidence.json'");
    expect(workflow).toContain('$productSource.schemaVersion -ne 3');
    expect(local).toContain('$productSourceEvidence.schemaVersion -ne 3');
    expect(workflow).toContain('$sourceConformance.schemaVersion -eq 6');
    expect(local).toContain('$sourceEvidence.schemaVersion -ne 6');
    const uploads = workflow.slice(workflow.indexOf('      - name: Upload successful internal product-slice evidence'));
    expect(uploads.match(/if: success\(\)/g)).toHaveLength(2);
    const productInventory = uploads.slice(uploads.indexOf('          path: |') + '          path: |'.length,
      uploads.indexOf('      - name: Upload successful binary'));
    expect(productInventory.trim().split('\n').map((line) => line.trim())).toEqual([
      '${{ runner.temp }}/win32-native-evidence-product/source.json', '${{ runner.temp }}/win32-native-evidence-product/installed.json'
    ]);
    const inventory = uploads.slice(uploads.indexOf('            artifacts/native/'), uploads.indexOf('      - name: Upload failed'));
    expect(inventory.trim().split('\n').map((line) => line.trim())).toEqual([
      'artifacts/native/win32-x64-msvc/bazframe-win32.node', 'native-binary.sha256', 'native-foundation-evidence.json',
      'native-source-evidence.json', 'native-installed-evidence.json', 'native-rust-version.txt', 'native-msvc-version.txt'
    ]);
    const diagnostic = uploads.slice(uploads.indexOf('      - name: Upload failed'));
    expect(diagnostic).toContain('if: failure() || cancelled()');
    expect(diagnostic).not.toMatch(/\.node|\.tgz|native-binary\.sha256/u);
    expect(workflow.match(/uses: actions\/upload-artifact@/g)).toHaveLength(3);
    expect(local.indexOf('[System.IO.File]::ReadAllBytes($artifactPath)')).toBeGreaterThan(local.indexOf('$finalCommit ='));
  });
});
