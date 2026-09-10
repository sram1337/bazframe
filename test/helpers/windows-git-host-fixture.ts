import { spawnBoundedPackageProcess } from '../../src/core/child-process.js';
import { symlinkSync, unlinkSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, lstatSync, readFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { execFileSync } from 'node:child_process';
import { windowsProvisioningFixture, type TestNode } from './windows-provisioning-fixture.js';
import { runManagedGitProcess } from '../../src/providers/managed-git-process.js';
import type { ProfileGithubProcess } from '../../src/profile-publishing/profile-github-process.js';
import type { WindowsManagedGitOptions } from '../../src/providers/win32-managed-git-services.js';

/** Real disposable host Git; only Windows native/I/O receipts and pathname translation are synthetic. */
export function windowsGitHostFixture() {
  const fixture = windowsProvisioningFixture();
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'bazframe-win-git-host-')));
  const disk = join(temporary, 'drive'); mkdirSync(disk); mkdirSync(join(disk, 'boundary'));
  const inodeIds = new Map<string, number>(); let nextId = 10000;
  const hostPath = (path: string) => /^[Cc]:[\\/]/u.test(path) ? join(disk, ...win32.normalize(path).slice(3).split('\\')) : path;
  const windowsPath = (path: string) => path.startsWith(disk) ? `C:\\${path.slice(disk.length + 1).split('/').join('\\')}` : path;
  const translate = (value: string) => value.replace(/[Cc]:[\\/].*$/u, (path) => hostPath(path) + (/[\\/]$/u.test(path) ? '/' : ''));
  function remember(path: string) {
    const node = fixture.nodes.get(win32.normalize(path)); if (node === undefined) return;
    const stat = lstatSync(hostPath(path), { bigint: true }); inodeIds.set(`${stat.dev}:${stat.ino}`, node.id);
  }
  remember('C:\\'); remember('C:\\boundary');
  function refresh() {
    const observed = new Set<string>();
    function visit(path: string) {
      try {
      const stat = lstatSync(path, { bigint: true }), name = windowsPath(path);
      if (stat.isSymbolicLink()) { if (fixture.nodes.get(name)?.kind !== 'reparse') throw new Error('Host translator does not invent Windows junctions for Git symlinks'); observed.add(name); return; }
      const inode = `${stat.dev}:${stat.ino}`;
      let id = inodeIds.get(inode); if (id === undefined) { id = nextId++; inodeIds.set(inode, id); }
      const prior = fixture.nodes.get(name);
      const node: TestNode = { kind: stat.isDirectory() ? 'directory' : 'file', id, ...(prior?.security === undefined ? {} : { security: prior.security }), ...(stat.isFile() ? { bytes: readFileSync(path), numberOfLinks: Number(stat.nlink), attributes: 0x20 } : { attributes: 0x10 }) };
      fixture.nodes.set(name, node); observed.add(name);
      if (stat.isDirectory()) for (const child of readdirSync(path)) visit(join(path, child));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    visit(disk);
    for (const [path, node] of fixture.nodes) if (!observed.has(path) && node.kind !== 'reparse') fixture.nodes.delete(path);
  }
  const junction = fixture.backend.createPrivateJunction;
  fixture.backend.createPrivateJunction = (parent, component, target) => { const result = junction(parent, component, target), path = win32.join(parent, component); symlinkSync(hostPath(target), hostPath(path), 'dir'); remember(path); return result; };
  for (const method of ['createPrivateDirectory', 'createPrivateFile'] as const) {
    const original = fixture.backend[method];
    fixture.backend[method] = (parent, component) => {
      const result = original(parent, component), path = win32.join(parent, component);
      if (method === 'createPrivateDirectory') mkdirSync(hostPath(path)); else writeFileSync(hostPath(path), '', { flag: 'wx' });
      remember(path); return result;
    };
  }
  for (const method of ['renameDirectoryNoReplace', 'renameFileNoReplace'] as const) {
    const original = fixture.backend[method];
    fixture.backend[method] = async (parent, source, target) => { const from = hostPath(win32.join(parent, source)), to = hostPath(win32.join(parent, target)); if (existsSync(to)) throw Object.assign(new Error('occupied'), { code: 'EEXIST' }); await original(parent, source, target); renameSync(from, to); };
  }
  const move = fixture.backend.moveDirectoryNoReplace;
  fixture.backend.moveDirectoryNoReplace = async (parent, source, destination, name) => { const from = hostPath(win32.join(parent, source)), to = hostPath(win32.join(destination, name)); if (existsSync(to)) throw Object.assign(new Error('occupied'), { code: 'EEXIST' }); await move(parent, source, destination, name); renameSync(from, to); };
  const write = fixture.io.writeExistingFile;
  fixture.io.writeExistingFile = async (path, bytes) => { await write(path, bytes); writeFileSync(hostPath(path), bytes); };
  const rename = fixture.io.rename;
  fixture.io.rename = async (source, target) => { await rename(source, target); renameSync(hostPath(source), hostPath(target)); };
  const remotes = new Map<string, string>();
  const requests: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
  const options: WindowsManagedGitOptions = {
    storageIo: fixture.io, stateIo: fixture.io, lockIo: fixture.io,
    membershipIo: { async unlink(path) { unlinkSync(hostPath(path)); fixture.nodes.delete(win32.normalize(path)); } },
    resolvePackageExecutable: async (argv) => ({ executable: process.execPath, args: argv.slice(1) }),
    async packageProcessRunner(executable, args, processOptions) { const result = await spawnBoundedPackageProcess(executable, args, { ...processOptions, cwd: hostPath(processOptions.cwd) }); refresh(); return result; },
    resolveExecutable: async (command) => command === 'gh' ? Promise.reject(Object.assign(new Error('not installed'), { code: 'EXECUTABLE_NOT_FOUND' })) : '/usr/bin/git',
    async process(executable, args, cwd, environment, limits, hooks) {
      requests.push({ executable, args: [...args], cwd });
      const extra = [...remotes].flatMap(([url, path]) => ['-c', `url.file://${path}.insteadOf=${url}`]);
      const translated = args.map(translate).map((arg) => arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg);
      const env = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value === undefined ? value : translate(value)]));
      // Preserve real Git semantics. The explicit file transport exception exists only in this fixture.
      const result = await runManagedGitProcess(executable, [...extra, '-c', 'protocol.file.allow=always', ...translated], hostPath(cwd), env, limits, { ...hooks, monitor: hooks?.monitor === undefined ? undefined : async () => { refresh(); await hooks.monitor?.(); } });
      refresh();
      if (args.includes('--absolute-git-dir')) {
        const stdout = result.stdout.split('\n').map(windowsPath).join('\n'); return { ...result, stdout, stdoutBytes: Buffer.from(stdout) };
      }
      return result;
    }
  };
  function source(id: string, files: Record<string, Buffer | string>, executable: string[] = []) {
    const path = join(temporary, `source-${id}`); mkdirSync(path);
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', path, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-b', 'main');
    for (const [name, bytes] of Object.entries(files)) { mkdirSync(join(path, dirname(name)), { recursive: true }); writeFileSync(join(path, name), bytes); }
    git('add', '.'); for (const name of executable) git('update-index', '--chmod=+x', name);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    const url = `https://example.test/owner/${id}.git`; remotes.set(url, path);
    return { path, url, git, revision: git('rev-parse', 'HEAD') };
  }
  const profileProcess: ProfileGithubProcess = async (request) => {
    if (request.executable !== 'git') throw new Error('This local fixture has no gh network effects');
    const result = await options.process!('/usr/bin/git', request.args, request.cwd, { ...request.environment }, { timeoutMilliseconds: request.timeoutMilliseconds, terminationGraceMilliseconds: request.terminationGraceMilliseconds, maxStreamBytes: Math.max(request.maxStdoutBytes, request.maxStderrBytes) }, { monitor: request.monitor });
    return { ...result, ...(result.failure === undefined ? {} : { failure: result.failure === 'termination-uncertain' ? 'termination-uncertain' as const : result.failure }) };
  };
  function github(repository: string) {
    const remote = bare(repository.replace('/', '-')); let exists = false, visibility: 'private' | 'public' = 'private';
    remotes.set(`https://github.com/${repository}.git`, remote);
    const processBoundary: ProfileGithubProcess = async (request) => {
      if (request.executable === 'git') return profileProcess(request);
      requests.push({ executable: 'gh', args: [...request.args], cwd: request.cwd });
      const args = request.args;
      if (args[0] === '--version' || args[0] === 'auth' && args[1] === 'status') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: repository.split('/')[0]! + '\n', stderr: '' };
      if (args[0] === 'repo' && args[1] === 'create') { exists = true; return { status: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'repo' && args[1] === 'edit') { visibility = args[args.indexOf('--visibility') + 1] as 'private' | 'public'; return { status: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'api' && args[1] === `repos/${repository}`) return exists ? { status: 0, stdout: JSON.stringify({ id: 42, full_name: repository, private: visibility === 'private', default_branch: 'main' }), stderr: '' } : { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' };
      throw new Error(`Unexpected gh fixture command ${JSON.stringify(args)}`);
    };
    return { remote, process: processBoundary, markExisting() { exists = true; } };
  }
  function bare(id: string) { const path = join(temporary, `bare-${id}`); execFileSync('/usr/bin/git', ['init', '--bare', '--initial-branch=main', path], { stdio: 'ignore' }); return path; }
  const zipIo: import('../../src/profile-publishing/win32-profile-zip.js').WindowsProfileZipIo = {
    async *readInput(path, maximum) { const bytes = readFileSync(hostPath(path)); if (bytes.length > maximum) throw new Error('fixture ZIP limit'); yield bytes; },
    async writeExistingFile(path, chunks, maximum) { const buffers: Buffer[] = []; let total = 0; for await (const chunk of chunks) { total += chunk.length; if (total > maximum) throw new Error('fixture ZIP limit'); buffers.push(Buffer.from(chunk)); } writeFileSync(hostPath(path), Buffer.concat(buffers)); await refresh(); },
    rename: fixture.io.rename
  };
  return { ...fixture, options, source, bare, github, profileProcess, mapRemote(url: string, path: string) { remotes.set(url, path); }, requests, zipIo, hostPath, windowsPath, refresh, temporary, cleanup() { rmSync(temporary, { recursive: true, force: true }); } };
}
