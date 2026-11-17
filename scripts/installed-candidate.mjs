// Exact-input support for retained installed acceptance, not release certification.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MessageChannel } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class CandidateUncertainty extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = 'CandidateUncertainty'; }
}
export function uncertainty(error, label) {
  return error instanceof CandidateUncertainty ? error : new CandidateUncertainty(`${label}: ${error}`, error);
}
export const retainedCandidateHolds = [];
export function holdCandidateUncertainty(error, owners, root) {
  const hold = { error, owners, root, disposition: 'Shared-root effects stopped; owners retained; no descendant settlement claimed' };
  retainedCandidateHolds.push(hold);
  try { saveJson(join(root, 'uncertainty.json'), { error: String(error), stack: error.stack, disposition: hold.disposition, ownerCount: owners.length }); } catch (receiptError) { hold.receiptError = receiptError; }
  try { process.stderr.write(`Candidate uncertainty; retained no-action hold at ${root}: ${error}\n`); } catch (outputError) { hold.outputError = outputError; }
  // An explicit no-action retention anchor, not a timer, watchdog or escape.
  // The outer native owner must also retain its own obligations independently.
  const { port1, port2 } = new MessageChannel(); hold.ports = [port1, port2];
  port1.on('message', () => {}); port1.ref();
  return new Promise(() => {});
}

export function expectedCmdShim(target) {
  assert(target && !target.includes('"') && !target.includes('\n'));
  return '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\' + target + '" %*';
}
export function verifyCmdShim(path, target) {
  assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'CMD shim must be physical');
  assert.equal(readFileSync(path, 'utf8').replaceAll('\r\n', '\n').trimEnd(), expectedCmdShim(win32.relative(win32.dirname(path), target)), 'Unreviewed npm CMD shape');
}

// npm query '*' uses Arborist loadActual and emits one path-bound physical node,
// not npm ls's repeated logical edges (which omit resolved). Scan node_modules
// independently so query omissions cannot silently remove installed packages.
export function installedPackages(modules) {
  const packages = new Map();
  function scan(directory) {
    for (const name of readdirSync(directory)) {
      if (name.startsWith('.')) continue;
      const paths = name.startsWith('@') ? readdirSync(join(directory, name)).map(child => join(directory, name, child)) : [join(directory, name)];
      for (const path of paths) {
        assert(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), `Nonphysical package: ${path}`);
        assert.equal(realpathSync(path), path, `Package path alias: ${path}`);
        const manifest = jsonFile(join(path, 'package.json'));
        packages.set(path, manifest);
        try { lstatSync(join(path, 'node_modules')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        scan(join(path, 'node_modules'));
      }
    }
  }
  scan(modules); return packages;
}

export function installedPi(paths) {
  const name = '@earendil-works/pi-coding-agent';
  // These are the only legitimate installed dependency positions for this
  // package. Do not ask require.resolve to interpret import-only exports, or
  // walk upwards into a checkout/personal installation.
  for (const root of [join(paths.packageRoot, 'node_modules', name), join(paths.modules, name)]) {
    try { lstatSync(root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
    const manifest = join(root, 'package.json'), pi = jsonFile(manifest);
    assert.equal(pi.name, name); assert.equal(typeof pi.bin?.pi, 'string');
    const entry = join(root, pi.bin.pi);
    containedLink(entry, paths.modules); assert.equal(realpathSync(entry), entry);
    assert(lstatSync(entry).isFile());
    return { entry, manifest, version: pi.version, bin: pi.bin, binPaths: { pi: entry }, manifestSha256: sha256(readFileSync(manifest)), runtime: 'not-executed' };
  }
  assert.fail('Pi package missing from selected installation');
}

export function verifyRegistryOrigins(nodes, candidatePath, lock, originRoot, { modules = join(originRoot, 'node_modules'), allowUnreported = false } = {}) {
  assert(Array.isArray(nodes), 'Expected physical npm query array');
  const physical = installedPackages(modules), observed = new Map(), origins = [];
  const check = (resolved, path) => {
    assert(typeof resolved === 'string', `Missing resolved origin for ${path}`);
    if (path === join(modules, 'bazframe')) {
      assert(resolved.startsWith('file:'), 'Candidate must resolve to the nominated file');
      // npm query locations and lock package keys share the actual tree root.
      // Even a hidden node_modules/.package-lock.json resolves file origins
      // from that root, not from the directory containing the hidden lock.
      const target = realpathSync(fileURLToPath(new URL(resolved, pathToFileURL(join(originRoot, 'package.json')))));
      assert.equal(target, realpathSync(candidatePath), 'Candidate origin differs');
      return target;
    } else {
      const url = new URL(resolved);
      assert.equal(url.protocol, 'https:', `Non-registry acquisition: ${resolved}`);
      assert.equal(url.hostname, 'registry.npmjs.org', `Non-public-registry acquisition: ${resolved}`);
      assert(!url.username && !url.password && !url.port && url.pathname.includes('/-/') && url.pathname.endsWith('.tgz'), 'Expected public registry tarball origin');
    }
  };
  for (const node of nodes) {
    if (node.location === '' && node.path === originRoot) continue; // npm's synthetic/project root, not installed package
    assert.equal(node.path, resolve(originRoot, node.location), 'npm physical location mismatch');
    assert.equal(node.realpath, node.path, 'npm acquisition link');
    assert(!observed.has(node.path), 'Duplicate physical npm node');
    const manifest = physical.get(node.path); assert(manifest, `npm node outside physical closure: ${node.path}`);
    assert.equal(node.name, manifest.name); assert.equal(node.version, manifest.version);
    observed.set(node.path, node);
  }
  assert.deepEqual([...observed.keys()].sort(), [...physical.keys()].sort(), 'npm query omitted physical packages');
  assert(physical.has(join(modules, 'bazframe')), 'Missing installed candidate');
  const locked = new Map(), absentOptional = [];
  if (lock) {
    assert(lock.packages && [2, 3].includes(lock.lockfileVersion), 'Expected path-bound npm lock');
    for (const [location, item] of Object.entries(lock.packages)) {
      if (!location) continue;
      const path = resolve(originRoot, location);
      assert(!item.link, 'Acquisition links outside fixed tarball scope');
      check(item.resolved, path); // even absent optional origins are checked
      if (!physical.has(path)) { assert(item.optional === true, `Missing nonoptional locked package: ${location}`); absentOptional.push(location); continue; }
      assert.equal(item.version, physical.get(path).version, 'Lock/physical version mismatch'); locked.set(path, item);
    }
  }
  for (const [path, node] of observed) {
    for (const location of node.to ?? []) assert(observed.has(resolve(originRoot, location)), `Missing physical dependency edge: ${location}`);
    const item = locked.get(path);
    const queryOrigin = node.resolved != null ? check(node.resolved, path) : undefined;
    if (node.resolved != null && item) {
      // Only the nominated candidate's file spellings are compared semantically.
      // Both must independently name the admitted archive; all other origins
      // retain exact raw-string equality as well as registry admission.
      if (path === join(modules, 'bazframe')) assert.equal(queryOrigin, check(item.resolved, path), 'npm query/lock origin mismatch');
      else assert.equal(node.resolved, item.resolved, 'npm query/lock origin mismatch');
    }
    const resolved = node.resolved ?? item?.resolved;
    if (!resolved) assert(allowUnreported, `Missing resolved origin for ${path}`);
    origins.push({ path, name: node.name, version: node.version, resolved: resolved ?? null, queryResolved: node.resolved ?? null, lockResolved: item?.resolved ?? null, originEvidence: resolved ? 'npm metadata; not network containment' : 'not reported by npm' });
  }
  return { packages: origins, absentOptional, scope: 'Complete physical versions/bytes required; global unreported origins are not registry attestations' };
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonFile = path => JSON.parse(readFileSync(path, 'utf8'));
const hasControl = value => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export function saveJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

export function parseCandidateOptions(argv) {
  const required = ['candidate', 'sha256', 'native-sha256', 'source', 'root', 'install', 'alias', 'batch', 'npm-cli', 'ownership-record'];
  const allowed = [...required, 'zip', 'zip-sha256'];
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    assert(argv[i].startsWith('--') && allowed.includes(key) && argv[i + 1] && !options[key], `Unknown, duplicate or incomplete option: ${argv[i]}`);
    options[key] = argv[i + 1];
  }
  for (const key of required) assert(options[key], `Required: --${key}`);
  if (options.zip || options['zip-sha256']) {
    assert(options.zip && isAbsolute(options.zip) && /^[a-f0-9]{64}$/u.test(options['zip-sha256'] ?? ''), 'External ZIP requires absolute --zip and --zip-sha256');
    assert(['zip', 'all'].includes(options.batch), '--zip requires the ZIP batch');
  }
  for (const key of ['candidate', 'root', 'npm-cli', 'ownership-record']) assert(isAbsolute(options[key]), `--${key} must be absolute`);
  for (const key of ['sha256', 'native-sha256']) assert(/^[a-f0-9]{64}$/u.test(options[key]), `Invalid --${key}`);
  assert(/^[a-f0-9]{40}$/u.test(options.source), 'Expected full candidate source commit');
  assert(['local', 'global'].includes(options.install), 'Expected --install local|global');
  assert(['bazframe', 'bzf', 'both'].includes(options.alias), 'Expected --alias bazframe|bzf|both');
  assert(['dispatch', 'resources', 'zip', 'all'].includes(options.batch), 'Expected --batch dispatch|resources|zip|all');
  return options;
}

// The nominated npm archive contains only regular ustar members. Deliberately
// refuse links, extension records and ambiguous names instead of extracting them.
export function admitCandidate(path, expectedDigest, nativeDigest) {
  assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Candidate must be a physical file');
  const archive = readFileSync(path);
  assert.equal(sha256(archive), expectedDigest, 'Candidate digest mismatch');
  const tar = gunzipSync(archive);
  const members = new Map();
  let offset = 0;
  const text = bytes => bytes.toString('utf8').replace(/\0.*$/su, '');
  const octal = bytes => { const s = text(bytes).trim(); assert(/^[0-7]+$/u.test(s), 'Unsupported tar number'); return parseInt(s, 8); };
  for (; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const checksum = [...header].reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    assert.equal(checksum, octal(header.subarray(148, 156)), 'Tar checksum mismatch');
    assert(['0', '\0'].includes(String.fromCharCode(header[156])), 'Only regular tar members admitted');
    const prefix = text(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`;
    assert(name.startsWith('package/') && !name.includes('\\'), 'Invalid package member');
    const key = name.slice(8);
    assert(key && key.split('/').every(part => part && part !== '.' && part !== '..') && !hasControl(key) && !key.includes(':'), 'Unsafe package member');
    assert(!members.has(key) && ![...members.keys()].some(x => x.toLowerCase() === key.toLowerCase()), 'Duplicate package member');
    const size = octal(header.subarray(124, 136));
    assert(offset + 512 + size <= tar.length, 'Truncated tar member');
    const bytes = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    members.set(key, { sha256: sha256(bytes), bytes: size, mode: octal(header.subarray(100, 108)), content: bytes });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(tar.length - offset >= 1024 && tar.subarray(offset).every(byte => byte === 0), 'Missing tar terminator or trailing data');
  const manifest = JSON.parse(members.get('package.json')?.content.toString() ?? 'null');
  assert.equal(manifest?.name, 'bazframe');
  assert.equal(manifest.bin?.bazframe, 'dist/cli.js');
  assert.equal(manifest.bin?.bzf, 'dist/cli.js');
  const nativePath = 'artifacts/native/win32-x64-msvc/bazframe-win32.node';
  assert.equal(members.get(nativePath)?.sha256, nativeDigest, 'Native candidate digest mismatch');
  assert.equal([...members.keys()].filter(key => key.endsWith('.node')).length, 1, 'Unexpected native members');
  assert(!members.has('win32-native-release-admission.json'), 'Assembly release record is not candidate evidence');
  return { manifest, members, sha256: expectedDigest, nativeSha256: nativeDigest };
}

export function inventory(root, skip = () => false) {
  try { lstatSync(root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const result = {};
  function visit(path, key) {
    if (skip(key)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) result[key] = { kind: 'link', target: readlinkSync(path) };
    else if (stat.isDirectory()) {
      result[key] = { kind: 'directory' };
      for (const name of readdirSync(path).sort()) visit(join(path, name), key ? `${key}/${name}` : name);
    } else {
      assert(stat.isFile(), `Unsupported inventory entry: ${path}`);
      result[key] = { kind: 'file', bytes: stat.size, sha256: sha256(readFileSync(path)), executable: Boolean(stat.mode & 0o111) };
    }
  }
  visit(root, '');
  return result;
}

export function verifyInstalled(packageRoot, candidate) {
  const tree = inventory(packageRoot, key => key === 'node_modules');
  assert(tree, 'Missing installed package');
  const files = Object.entries(tree).filter(([, value]) => value.kind !== 'directory');
  assert.deepEqual(files.map(([key]) => key).sort(), [...candidate.members.keys()].sort(), 'Installed member set differs');
  for (const [key, item] of files) {
    assert.equal(item.kind, 'file', `Nonphysical installed member: ${key}`);
    assert.equal(item.sha256, candidate.members.get(key).sha256, `Installed bytes differ: ${key}`);
  }
  return tree;
}

export function installationPaths(prefix, mode, platform = process.platform) {
  const path = platform === 'win32' ? win32 : { join };
  const modules = mode === 'local' || platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  return { modules, packageRoot: path.join(modules, 'bazframe'), bin: mode === 'local' ? path.join(modules, '.bin') : platform === 'win32' ? prefix : path.join(prefix, 'bin') };
}

export function aliasInvocation(executable, args, platform = process.platform, cmd = process.env.ComSpec) {
  if (platform !== 'win32') return { file: executable, args, options: { shell: false } };
  assert(win32.isAbsolute(executable) && executable.endsWith('.cmd'), 'Expected absolute genuine CMD alias');
  assert(cmd && win32.isAbsolute(cmd) && /\\cmd\.exe$/iu.test(cmd), 'Expected absolute native cmd.exe');
  // No expansion, metacharacters, quote escaping, control bytes, or terminal
  // backslashes. Spaces are supported via quoted literal tokens. /v:off is explicit.
  for (const value of [executable, ...args]) assert(value && !/["%!^&|<>]/u.test(value) && !hasControl(value) && !value.endsWith('\\'), `Unsupported CMD argument: ${JSON.stringify(value)}`);
  return { file: cmd, args: ['/d', '/s', '/v:off', '/c', `"${[executable, ...args].map(value => `"${value}"`).join(' ')}"`], options: { shell: false, windowsVerbatimArguments: true } };
}

export function isolatedEnvironment(root, prefix, node = process.execPath, inherited = process.env) {
  const env = {};
  // No inherited NODE_OPTIONS, npm config/auth, Git overrides, editor, Pi or
  // Bazframe settings; never append a personal PATH.
  if (process.platform === 'win32') {
    env.SystemRoot = inherited.SystemRoot ?? inherited.SYSTEMROOT;
    assert(env.SystemRoot, 'Missing Windows system root');
    env.WINDIR = env.SystemRoot;
    env.ComSpec = join(env.SystemRoot, 'System32', 'cmd.exe');
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  }
  const path = process.platform === 'win32' ? `${dirname(node)};${join(env.SystemRoot, 'System32')};${env.SystemRoot}` : `${dirname(node)}:/usr/bin:/bin`;
  Object.assign(env, { PATH: path, HOME: join(root, 'user'), USERPROFILE: join(root, 'user'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), npm_config_cache: join(root, 'npm-cache'), npm_config_prefix: prefix, npm_config_userconfig: join(root, 'npm-user.conf'), npm_config_globalconfig: join(root, 'npm-global.conf'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'git.conf'), BAZFRAME_HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'pi'), NO_COLOR: '1', CI: '1' });
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'npm_config_cache']) mkdirSync(env[key], { recursive: true });
  for (const key of ['npm_config_userconfig', 'npm_config_globalconfig', 'GIT_CONFIG_GLOBAL']) writeFileSync(env[key], '');
  return env;
}

export function createFreshRoot(root) {
  assert(isAbsolute(root), 'Execution root must be absolute');
  assert.equal(realpathSync(dirname(root)), dirname(root), 'Execution root parent must be canonical');
  mkdirSync(root, { mode: 0o700 }); // EEXIST includes occupied/empty roots: never reuse.
}

// Owners stay reachable through stream closure AND receipt I/O, then through the
// final report. This does not establish descendant settlement or PID absence.
export function retainedRunner(evidence, owners = []) {
  mkdirSync(evidence, { recursive: true });
  let sequence = 0;
  return async function run(label, invocation, cwd, env) {
    const base = join(evidence, `${String(++sequence).padStart(3, '0')}-${label}`);
    const options = { ...invocation.options, shell: false, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] };
    const receipt = { label, file: invocation.file, args: invocation.args, options, cwd, env, started: new Date().toISOString(), events: [], descendantSettlement: 'not-established' };
    try {
    saveJson(`${base}.command.json`, receipt);
    const out = openSync(`${base}.stdout`, 'wx'), err = openSync(`${base}.stderr`, 'wx');
    let child;
    const ioErrors = [];
    try {
      child = spawn(invocation.file, invocation.args, options);
      owners.push(child);
      receipt.pid = child.pid;
      const capture = fd => bytes => {
        try { for (let offset = 0; offset < bytes.length;) { const count = writeSync(fd, bytes, offset); assert(count > 0, 'Short evidence write'); offset += count; } }
        catch (error) { ioErrors.push(String(error)); }
      };
      child.stdout.on('data', capture(out)); child.stderr.on('data', capture(err));
      child.stdout.on('error', error => ioErrors.push(`stdout: ${error}`));
      child.stderr.on('error', error => ioErrors.push(`stderr: ${error}`));
      child.on('error', error => receipt.events.push({ event: 'error', message: String(error) }));
      child.on('exit', (code, signal) => receipt.events.push({ event: 'exit', code, signal }));
      await new Promise(done => child.once('close', (code, signal) => { receipt.code = code; receipt.signal = signal; receipt.events.push({ event: 'close', code, signal }); done(); }));
    } catch (error) { receipt.events.push({ event: 'spawn-throw', message: String(error) }); }
    finally { for (const fd of [out, err]) try { closeSync(fd); } catch (error) { ioErrors.push(`close evidence: ${error}`); } }
    receipt.ioErrors = ioErrors;
    receipt.finished = new Date().toISOString();
    saveJson(`${base}.result.json`, receipt);
    return { ...receipt, evidence: base, stdout: readFileSync(`${base}.stdout`), stderr: readFileSync(`${base}.stderr`) };
    } catch (error) { throw uncertainty(error, `Required process/evidence capture ${label}`); }
  };
}

export async function runSteps(steps, results, persist) {
  let firstFailure;
  for (const [index, step] of steps.entries()) {
    if (firstFailure) results.push({ operation: step.name, ...step.metadata, status: 'not-run', reason: `Dependent on ${firstFailure}` });
    else {
      try { const detail = await step.run(); results.push({ operation: step.name, ...step.metadata, status: 'passed', ...detail }); }
      catch (error) { firstFailure = step.name; results.push({ operation: step.name, ...step.metadata, status: error instanceof CandidateUncertainty ? 'uncertain' : 'failed', error: String(error), stack: error.stack }); if (error instanceof CandidateUncertainty) { for (const remaining of steps.slice(index + 1)) results.push({ operation: remaining.name, ...remaining.metadata, status: 'not-run', reason: `Shared-scope uncertainty at ${step.name}` }); try { persist(); } catch (persistError) { error.persistenceError = String(persistError); } throw error; } }
    }
    try { persist(); } catch (error) { throw uncertainty(error, 'Required step result persistence'); }
  }
  return !firstFailure;
}

export function assertNaturalResult(result, code = 0) {
  if (result.ioErrors.length) throw new CandidateUncertainty(`Output I/O uncertainty: ${result.ioErrors.join('; ')}`);
  if (result.events.some(event => ['error', 'spawn-throw'].includes(event.event))) throw new CandidateUncertainty('Child process error');
  if (result.signal !== null || !result.events.some(event => event.event === 'exit') || !result.events.some(event => event.event === 'close')) throw new CandidateUncertainty('Missing natural direct-child exit/close or observed signal');
  assert(result.events.some(event => event.event === 'exit' && event.code === code && event.signal === null), 'Expected natural exit not observed');
  assert.equal(result.code, code, `Unexpected exit; retain ${result.evidence}`);
  assert.equal(result.signal, null);
}

export function containedLink(path, root) {
  const target = realpathSync(path);
  const rel = relative(realpathSync(root), target);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), `Link escapes installation: ${path}`);
  return target;
}
