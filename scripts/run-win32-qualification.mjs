import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Only disposable outer fixture boundaries are created here, never managed product state.
 * All namespace creation and bounded private admission finish before concurrency starts.
 * Parents are retained after qualification; this harness adds no reclamation operation.
 * The optional dependency is for host tests only; CLI construction always loads source dist.
 */
export async function prepareWindowsQualificationParents(sourceRoot, temporaryParent, dependencies) {
  if (typeof temporaryParent !== 'string' || temporaryParent.includes('\0') || !win32.isAbsolute(temporaryParent)) {
    throw new Error('Qualification temporary parent unavailable.');
  }
  if (dependencies === undefined) {
    const load = (path) => import(pathToFileURL(join(sourceRoot, 'dist', path)).href);
    const native = await load('core/win32-native.js');
    dependencies = {
      backend: native.loadBazframeWin32Native(),
      privateDirectory: await load('state/win32-private-directory.js'),
      enumerate: (await load('skills/added-skill-platform-services.js')).enumerateWindowsPrivateDirectory
    };
  }
  const { backend, privateDirectory, enumerate } = dependencies;
  const component = `bazframe-qualification-${randomUUID()}`;
  const boundary = win32.join(temporaryParent, component);
  // Like the accepted foundation bootstrap, native exclusive creation supplies first-visible privacy;
  // composition then proves private ownership and namespace-safe ancestry without repairing the parent.
  const created = backend.createPrivateDirectory(temporaryParent, component).created;
  const sameOwnedDirectory = (left, right) => {
    if (left.kind !== 'directory' || right.kind !== 'directory'
      || left.canonicalPath !== right.canonicalPath || left.object.volumeIdentity !== right.object.volumeIdentity
      || left.object.fileId !== right.object.fileId || left.object.creationTime !== right.object.creationTime
      || (right.security.descriptorControl & 0x1000) === 0
      || JSON.stringify(left.security) !== JSON.stringify(right.security)) throw new Error('Qualification parent proof changed.');
  };
  sameOwnedDirectory(created, privateDirectory.admitWindowsPrivateDirectory(backend, boundary));
  await enumerate(backend, boundary, 0);
  const names = ['product-source', 'product-installed', 'foundation'];
  const parents = {}, proofs = new Map();
  for (const name of names) {
    proofs.set(name, privateDirectory.createWindowsPrivateDirectory(backend, boundary, name));
    parents[name] = win32.join(boundary, name);
  }
  const namespace = await enumerate(backend, boundary, names.length);
  if (JSON.stringify([...namespace.names].sort()) !== JSON.stringify([...names].sort())
    || new Set([...proofs.values()].map((proof) => proof.object.fileId)).size !== names.length) {
    throw new Error('Qualification parent namespace invalid.');
  }
  for (const name of names) {
    const current = privateDirectory.admitWindowsPrivateDirectory(backend, parents[name]);
    sameOwnedDirectory(proofs.get(name), current);
    const entry = namespace.nativeEntries.find((entry) => entry.name === name);
    if (entry === undefined || !entry.directory || entry.reparseTag !== null || entry.fileId !== current.object.fileId) {
      throw new Error('Qualification parent namespace changed.');
    }
    await enumerate(backend, parents[name], 0);
  }
  sameOwnedDirectory(created, privateDirectory.admitWindowsPrivateDirectory(backend, boundary));
  return Object.freeze(parents);
}

/** Products own independent random private homes and read immutable source/installed modules.
 * Foundations share machine-global SUBST allocation, so only that lane is sequential.
 * All child outcomes settle before returning; a failed lane never authorizes qualification.
 */
export async function runWindowsQualification(args, { spawnProcess = spawn, log = console.log, prepareLaneParents = prepareWindowsQualificationParents } = {}) {
  const options = qualificationArguments(args);
  // Refuse stale/overlapping receipt destinations before starting any process.
  for (const key of ARGUMENTS.slice(2)) {
    try { await lstat(options[key.slice(2)]); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw new Error('Qualification output unavailable.', { cause: error }); }
    throw new Error('Qualification output occupied.');
  }
  const environment = { ...process.env };
  log('qualification:parents:preparing');
  const parents = await prepareLaneParents(options['source-root'], environment.BAZFRAME_WIN32_NATIVE_TEST_PARENT);
  log('qualification:parents:prepared');
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
        cwd: options['source-root'], env: { ...environment,
          BAZFRAME_WIN32_NATIVE_TEST_PARENT: parents[lane.startsWith('foundation-') ? 'foundation' : lane] },
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
