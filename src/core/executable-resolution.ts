import { runManagedGitProcess, type ManagedGitProcessResult } from '../providers/managed-git-process.js';
import { constants } from 'node:fs';
import { access, realpath, stat, open } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { BazframeError, errorCode } from './errors.js';

export interface ExecutableResolutionEffects {
  executable(path: string): Promise<boolean>;
  canonical(path: string): Promise<string>;
  readShim(path: string): Promise<string>;
  runHelper?(node: string, args: readonly string[], cwd: string, environment: Readonly<NodeJS.ProcessEnv>): Promise<ManagedGitProcessResult>;
}
export interface ExecutableResolutionOptions {
  /** The caller's original directory, never a subsequently fetched checkout. */
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
  excludedRoots?: readonly string[];
  effects?: ExecutableResolutionEffects;
}
export interface ResolvedExecutable { executable: string; args: readonly string[]; afterAuthorization?(): Promise<ResolvedExecutable> }
export class ExecutableHelperUncertainError extends BazframeError {}

/** Windows environment names are case insensitive. Conflicting spellings refuse. */
export function executableEnvironmentValue(environment: Readonly<NodeJS.ProcessEnv>, key: string, windows = process.platform === 'win32'): string | undefined {
  if (!windows) return environment[key];
  const values = Object.entries(environment).filter(([name, value]) => name.toUpperCase() === key.toUpperCase() && value !== undefined).map(([, value]) => value!);
  if (new Set(values).size > 1) throw invalid(`Conflicting Windows environment spellings for ${key}`);
  return values[0];
}

/** Resolve once at an operation boundary; callers retain the absolute result. No implicit cwd search. */
export async function resolveControlledExecutable(command: string, options: ExecutableResolutionOptions): Promise<string> {
  const result = await resolve(command, options, false);
  if ((options.platform ?? process.platform) === 'win32' && /\.(?:cmd|bat)$/iu.test(result)) throw shimUnsupported();
  return result;
}

/** Pi's exact npm-generated launcher, never a general batch interpreter or package search. */
export async function resolvePiExecutable(command: string, options: ExecutableResolutionOptions): Promise<ResolvedExecutable> {
  const executable = await resolve(command, options, true);
  if ((options.platform ?? process.platform) !== 'win32' || !/\.(?:cmd|bat)$/iu.test(executable)) return { executable, args: [] };
  const effects = options.effects ?? nativeEffects(true);
  if (win32.basename(executable).toLowerCase() !== 'pi.cmd') throw shimUnsupported();
  const expected = NPM_SHIMS[0]!.replace('node_modules\\npm\\bin\\npm-cli.js', 'node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js');
  if ((await effects.readShim(executable)).replace(/\r\n/gu, '\n').trimEnd() !== expected) throw shimUnsupported();
  const directory = win32.dirname(executable), adjacentNode = win32.join(directory, 'node.exe');
  const node = await resolveControlledExecutable(await effects.executable(adjacentNode) ? adjacentNode : 'node', options);
  const cli = win32.join(directory, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
  if (!await effects.executable(cli)) throw invalid('The selected pi.cmd has no supported adjacent Pi CLI entry. Reinstall that Pi installation or select an explicit native wrapper');
  const selectedCli = await effects.canonical(cli);
  if (!win32.isAbsolute(selectedCli)) throw invalid('The selected Pi CLI entry is not absolute');
  return { executable: node, args: [selectedCli] };
}

/** Source-owned package execution is separate from controlled Git/gh and requires adjacent consent. */
export async function resolvePackageExecutable(argv: readonly string[], options: ExecutableResolutionOptions): Promise<ResolvedExecutable> {
  const command = argv[0];
  if (command === undefined) throw invalid('Package build command is empty');
  const executable = await resolve(command, options, true);
  if ((options.platform ?? process.platform) !== 'win32' || !/\.(?:cmd|bat)$/iu.test(executable)) return { executable, args: argv.slice(1) };
  const effects = options.effects ?? nativeEffects(true);
  if (win32.basename(executable).toLowerCase() !== 'npm.cmd') throw shimUnsupported();
  // Only the official npm launcher is translated. Never interpret a general batch program.
  const shim = (await effects.readShim(executable)).replace(/\r\n/gu, '\n');
  const prefixDispatch = shim.trimEnd() === NPM_PREFIX_SHIM;
  if (!prefixDispatch && !NPM_SHIMS.includes(shim.trimEnd())) throw shimUnsupported();
  const directory = win32.dirname(executable);
  const adjacentNode = win32.join(directory, 'node.exe');
  const node = prefixDispatch && !await effects.executable(adjacentNode) ? await resolveControlledExecutable('node', options) : adjacentNode;
  const cli = win32.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!await effects.executable(node) || !await effects.executable(cli)) throw invalid('The selected npm.cmd has no supported adjacent Node/npm installation. Use an explicit node.exe and npm-cli.js command');
  const selectedNode = await effects.canonical(node), selectedCli = await effects.canonical(cli);
  if (!prefixDispatch) return { executable: selectedNode, args: [selectedCli, ...argv.slice(1)] };
  const prefixHelper = win32.join(directory, 'node_modules', 'npm', 'bin', 'npm-prefix.js');
  if (!await effects.executable(prefixHelper)) throw invalid('The selected npm installation has no npm-prefix.js helper');
  const helper = await effects.canonical(prefixHelper);
  // npm-prefix.js loads installation JS and cwd configuration. It is execution,
  // not discovery: defer it until the adjacent source-code consent has succeeded.
  return { executable: selectedNode, args: [selectedCli, ...argv.slice(1)], async afterAuthorization() {
    const result = await (effects.runHelper ?? runNpmPrefixHelper)(selectedNode, [helper], options.cwd, options.environment);
    if (result.uncertainTermination === true) throw new ExecutableHelperUncertainError('EXECUTABLE_HELPER_UNCERTAIN', 'npm prefix helper termination is uncertain; retain private package state.');
    if (result.status !== 0 || result.failure !== undefined || result.error !== undefined || result.monitorError !== undefined || result.signal !== undefined) throw invalid('The selected npm prefix helper failed');
    if (result.stdoutBytes !== undefined && Buffer.from(result.stdoutBytes).toString('utf8') !== result.stdout) throw invalid('npm prefix helper returned contradictory output');
    if (Buffer.byteLength(result.stdout) > 8192 || Buffer.byteLength(result.stderr) > 8192) throw invalid('npm prefix output exceeded its bound');
    const prefix = result.stdout.replace(/\r?\n$/u, '');
    if (!win32.isAbsolute(prefix) || /[\r\n\0]/u.test(prefix) || win32.normalize(prefix) !== prefix) throw invalid('npm prefix helper returned a noncanonical absolute prefix');
    const preferred = win32.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const chosen = await effects.executable(preferred) ? await effects.canonical(preferred) : selectedCli;
    return { executable: selectedNode, args: [chosen, ...argv.slice(1)] };
  } };
}

async function resolve(command: string, options: ExecutableResolutionOptions, packageCommand: boolean): Promise<string> {
  const windows = (options.platform ?? process.platform) === 'win32';
  const paths = windows ? win32 : posix;
  const effects = options.effects ?? nativeEffects(windows);
  if (!command || command.includes('\0') || !paths.isAbsolute(options.cwd) || (windows && (/^[a-z]:[^\\/]/iu.test(command) || /^\\(?!\\)/u.test(command)))) throw invalid('Executable or original working directory is invalid');
  const explicit = paths.isAbsolute(command) || command.includes('/') || (windows && command.includes('\\'));
  const extensions = windows && paths.extname(command) === '' ? (packageCommand ? ['.exe', '.com', '.cmd', '.bat'] : ['.exe', '.com']) : [''];
  const bases = explicit ? [paths.resolve(options.cwd, command)] : (executableEnvironmentValue(options.environment, 'PATH', windows) ?? '').split(windows ? ';' : ':')
    .filter((directory) => paths.isAbsolute(directory) && (!windows || !/^\\(?!\\)/u.test(directory)))
    .map((directory) => paths.join(directory, command));
  const excluded = (path: string): boolean => (options.excludedRoots ?? []).some((root) => {
    const relative = paths.relative(root, path);
    return relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`));
  });
  for (const base of bases) for (const extension of extensions) {
    const candidate = base + extension;
    if (excluded(candidate) || !await effects.executable(candidate)) continue;
    const canonical = await effects.canonical(candidate);
    if (!paths.isAbsolute(canonical) || excluded(canonical)) continue;
    return canonical;
  }
  throw new BazframeError('EXECUTABLE_NOT_FOUND', `Executable ${JSON.stringify(command)} was not found in explicit absolute installation/PATH directories.`);
}

function nativeEffects(windows: boolean): ExecutableResolutionEffects {
  return {
    executable: async (path) => {
      try { const info = await stat(path); if (!info.isFile()) return false; await access(path, windows ? constants.F_OK : constants.X_OK); return true; }
      catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(errorCode(error) ?? '')) return false; throw error; }
    },
    canonical: realpath,
    readShim: async (path) => {
      const file = await open(path, 'r');
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > 8192) throw shimUnsupported();
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const after = await file.stat();
        if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw shimUnsupported();
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } finally { await file.close(); }
    }
  };
}

// Exact npm-distributed launchers only; never a batch-language interpreter.
async function runNpmPrefixHelper(node: string, args: readonly string[], cwd: string, environment: Readonly<NodeJS.ProcessEnv>) {
  return runManagedGitProcess(node, args, cwd, { ...environment }, { timeoutMilliseconds: 30000, terminationGraceMilliseconds: 2000, maxStreamBytes: 8192 });
}
const NPM_SHIMS = [
  '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*',
];
function invalid(detail: string): BazframeError { return new BazframeError('EXECUTABLE_RESOLUTION_FAILED', `${detail}.`); }
function shimUnsupported(): BazframeError { return new BazframeError('EXECUTABLE_SHIM_UNSUPPORTED', 'Unsupported command shim. Use a native executable or an explicit node.exe plus JavaScript entry point; arbitrary .cmd/.bat files are not executed through a shell.'); }

const NPM_PREFIX_SHIM = ":: Created by npm, please don't edit manually.\n@ECHO OFF\n\nSETLOCAL\n\nSET \"NODE_EXE=%~dp0\\node.exe\"\nIF NOT EXIST \"%NODE_EXE%\" (\n  SET \"NODE_EXE=node\"\n)\n\nSET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"\nSET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"\nFOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (\n  SET \"NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js\"\n)\nIF EXIST \"%NPM_PREFIX_NPM_CLI_JS%\" (\n  SET \"NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%\"\n)\n\n\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*";
