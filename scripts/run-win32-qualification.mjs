import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARGUMENTS = [
  '--source-root', '--installed-root',
  '--foundation-source-output', '--foundation-installed-output',
  '--product-source-output', '--product-installed-output'
];

const SCHEDULES = Object.freeze({
  all: ['foundation-source', 'foundation-installed', 'product-source', 'product-installed'],
  foundation: ['foundation-source', 'foundation-installed'],
  'product-source': ['product-source'],
  'product-installed': ['product-installed']
});

/** Fixed harness inputs only: no commands, environment overrides, or timeouts. */
export function qualificationArguments(args) {
  let selection = 'all';
  if (args[0] === '--selection') {
    selection = args[1]; args = args.slice(2);
    if (selection === 'all') throw new Error('Invalid qualification arguments.');
  }
  if (!Object.hasOwn(SCHEDULES, selection)) throw new Error('Invalid qualification arguments.');
  const required = ['--source-root', ...(SCHEDULES[selection].some((lane) => lane.endsWith('installed')) ? ['--installed-root'] : []),
    ...SCHEDULES[selection].map((lane) => `--${lane}-output`)];
  if (args.length !== required.length * 2) throw new Error('Invalid qualification arguments.');
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!required.includes(key) || values.has(key) || typeof value !== 'string'
      || value.includes('\0') || !isAbsolute(value)) throw new Error('Invalid qualification arguments.');
    values.set(key, resolve(value));
  }
  const paths = required.map((key) => values.get(key));
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
    || required.some((key) => key.endsWith('-output') && !values.get(key).endsWith('.json'))) throw new Error('Invalid qualification arguments.');
  return Object.freeze({ selection, ...Object.fromEntries(required.map((key) => [key.slice(2), values.get(key)])) });
}

/** No top-level overlap or coordinator-owned fixture hierarchy; stop on the first failed close. */
export async function runWindowsQualification(args, { spawnProcess = spawn, log = console.log } = {}) {
  const options = qualificationArguments(args);
  for (const key of ARGUMENTS.slice(2).filter((key) => options[key.slice(2)] !== undefined)) {
    try { await lstat(options[key.slice(2)]); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw new Error('Qualification output unavailable.', { cause: error }); }
    throw new Error('Qualification output occupied.');
  }
  const environment = { ...process.env };
  const run = (lane, harness, root, output) => new Promise((settle) => {
    log(`qualification:${lane}:start`);
    let child, started = false, failed = false;
    const finish = (outcome) => {
      log(`qualification:${lane}:end:${outcome}`);
      settle({ lane, outcome });
    };
    try {
      child = spawnProcess(process.execPath, [join(options['source-root'], 'scripts', harness),
        '--package-root', root, '--output', output], {
        cwd: options['source-root'], env: { ...environment },
        shell: false, windowsHide: true,
        // Receipts carry the existing sanitized diagnostics. Never interleave raw child errors/paths.
        stdio: ['ignore', 'ignore', 'ignore']
      });
    } catch { finish('spawn-failed'); return; }
    child.once('spawn', () => { started = true; });
    child.on('error', () => { failed = true; });
    child.once('close', (code, signal) => {
      finish(!started ? 'spawn-failed' : failed ? 'process-error'
        : signal !== null ? 'signaled' : code === 0 ? 'passed' : 'nonzero');
    });
  });
  const outcomes = [];
  for (const lane of SCHEDULES[options.selection]) {
    const outcome = await run(lane, lane.startsWith('foundation-') ? 'test-win32-native-foundation.mjs' : 'test-win32-added-skill-lifecycle.mjs',
      options[lane.endsWith('installed') ? 'installed-root' : 'source-root'], options[`${lane}-output`]);
    outcomes.push(outcome);
    if (outcome.outcome !== 'passed') break;
  }
  return { passed: outcomes.every((result) => result.outcome === 'passed'), outcomes };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runWindowsQualification(process.argv.slice(2));
    if (!result.passed) process.exitCode = 1;
  } catch {
    console.error('qualification:refused');
    process.exitCode = 1;
  }
}
