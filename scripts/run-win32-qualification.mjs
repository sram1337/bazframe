import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARGUMENTS = [
  '--source-root', '--installed-root',
  '--foundation-source-output', '--foundation-installed-output',
  '--product-source-output', '--product-installed-output'
];

/** Fixed harness inputs only: no commands, environment overrides, or timeouts. */
export function qualificationArguments(args) {
  if (args.length !== ARGUMENTS.length * 2) throw new Error('Invalid qualification arguments.');
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!ARGUMENTS.includes(key) || values.has(key) || typeof value !== 'string'
      || value.includes('\0') || !isAbsolute(value)) throw new Error('Invalid qualification arguments.');
    values.set(key, resolve(value));
  }
  const paths = ARGUMENTS.map((key) => values.get(key));
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
    || paths.slice(2).some((path) => !path.endsWith('.json'))) throw new Error('Invalid qualification arguments.');
  return Object.freeze(Object.fromEntries(ARGUMENTS.map((key) => [key.slice(2), values.get(key)])));
}

/** Products own independent random private homes and read immutable source/installed modules.
 * Foundations share machine-global SUBST allocation, so only that lane is sequential.
 * All child outcomes settle before returning; a failed lane never authorizes qualification.
 */
export async function runWindowsQualification(args, { spawnProcess = spawn, log = console.log } = {}) {
  const options = qualificationArguments(args);
  // Refuse stale/overlapping receipt destinations before starting any process.
  for (const key of ARGUMENTS.slice(2)) {
    try { await lstat(options[key.slice(2)]); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw new Error('Qualification output unavailable.', { cause: error }); }
    throw new Error('Qualification output occupied.');
  }
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
        cwd: options['source-root'], env: process.env, shell: false, windowsHide: true,
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
  const foundation = async () => [
    await run('foundation-source', 'test-win32-native-foundation.mjs', options['source-root'], options['foundation-source-output']),
    await run('foundation-installed', 'test-win32-native-foundation.mjs', options['installed-root'], options['foundation-installed-output'])
  ];
  const lanes = await Promise.all([
    run('product-source', 'test-win32-added-skill-lifecycle.mjs', options['source-root'], options['product-source-output']),
    run('product-installed', 'test-win32-added-skill-lifecycle.mjs', options['installed-root'], options['product-installed-output']),
    foundation()
  ]);
  const outcomes = lanes.flat();
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
