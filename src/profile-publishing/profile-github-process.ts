import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import {
  assertPhysicalDirectoryIdentity,
  openStablePhysicalDirectory,
  type StableDirectory
} from './profile-filesystem.js';

export type ProfileGithubInteractionMode = 'human' | 'json' | 'dry-run';

export interface ProfileGithubProcessRequest {
  executable: 'git' | 'gh';
  args: readonly string[];
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  stdin: 'ignore' | 'inherit';
  timeoutMilliseconds: number;
  terminationGraceMilliseconds: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /** Serial, interval-free storage sampling used only for owned Git transfer quarantines. */
  monitor?: () => void | Promise<void>;
}

export interface ProfileGithubProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Exact stdout bytes for Git object reads; injected fakes may omit this for UTF-8 output. */
  stdoutBytes?: Uint8Array;
  failure?: 'timeout' | 'stdout-overflow' | 'stderr-overflow' | 'spawn' | 'monitor-failure' | 'process-tree-survived' | 'termination-uncertain';
  uncertainTermination?: boolean;
  error?: Error;
  monitorError?: Error;
}

export type ProfileGithubProcess = (request: ProfileGithubProcessRequest) => Promise<ProfileGithubProcessResult>;

export interface ProfileGithubDisposalResult {
  disposition: 'retained';
  identityProved: true;
}

export interface OwnedProfileGithubDirectory {
  path: string;
  directory: StableDirectory;
  parent: StableDirectory;
  dispose(): Promise<ProfileGithubDisposalResult>;
}

/** Internal deterministic seams used only by cleanup fault tests. */
export interface ProfileGithubCleanupTestHooks {
  afterCleanupReady?(): void | Promise<void>;
  afterCleanupQuarantined?(retainedPath: string): void | Promise<void>;
  injectCleanupFailure?: boolean;
}

export interface ProfileGithubIsolation {
  root: string;
  home: string;
  xdgConfigHome: string;
  hooksDirectory: string;
  globalConfigFile: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  directory: StableDirectory;
  dispose(): Promise<ProfileGithubDisposalResult>;
}

const ALLOWED_INHERITED_ENVIRONMENT = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']);
const POSIX_PROCESS_GROUPS = process.platform !== 'win32';

/**
 * Creates and identity-tracks a private physical child.
 *
 * Workspaces exposed to Git or gh are retained rather than recursively removed:
 * portable Node APIs cannot prove that an escaped descendant has stopped using
 * the tree or perform race-free handle-relative recursive deletion on both
 * supported operating systems. Disposal closes our handles only after proving
 * that the retained pathname still names the exact private directory.
 */
export async function createOwnedProfileGithubDirectory(
  parentDirectory: string,
  prefix: string,
  testHooks: ProfileGithubCleanupTestHooks = {}
): Promise<OwnedProfileGithubDirectory> {
  if (!/^[a-z0-9-]+$/u.test(prefix)) throw invalid('owned-directory prefix is invalid');
  const parent = await openStablePhysicalDirectory(parentDirectory);
  let root: StableDirectory | undefined;
  try {
    const path = await mkdtemp(join(parent.path, prefix));
    await assertPhysicalDirectoryIdentity(parent);
    const created = await lstat(path, { bigint: true });
    if (created.isSymbolicLink() || !created.isDirectory()) throw invalid('owned directory was substituted during creation');
    root = await openStablePhysicalDirectory(path, parent.path);
    if (root.identity.device !== created.dev || root.identity.inode !== created.ino) throw invalid('owned directory identity changed during creation');
    let disposalPromise: Promise<ProfileGithubDisposalResult> | undefined;
    const dispose = (): Promise<ProfileGithubDisposalResult> => {
      disposalPromise ??= (async () => {
        let failure: unknown;
        let proved = false;
        try {
          await assertPhysicalDirectoryIdentity(parent);
          await assertPhysicalDirectoryIdentity(root!);
          await testHooks.afterCleanupReady?.();
          await testHooks.afterCleanupQuarantined?.(path);
          if (testHooks.injectCleanupFailure === true) throw new Error('injected disposal proof failure');
          await assertPhysicalDirectoryIdentity(parent);
          await assertPhysicalDirectoryIdentity(root!);
          proved = true;
        } catch (error) {
          failure = error;
        } finally {
          await root!.handle.close().catch((error) => { failure ??= error; });
          await parent.handle.close().catch((error) => { failure ??= error; });
        }
        if (failure !== undefined || !proved) throw cleanupInvalid('retained workspace identity was not proved');
        return { disposition: 'retained', identityProved: true };
      })();
      return disposalPromise;
    };
    return { path, directory: root, parent, dispose };
  } catch (error) {
    await root?.handle.close().catch(() => undefined);
    await parent.handle.close().catch(() => undefined);
    throw error;
  }
}

/** Creates a private, empty Git/gh process namespace from an allowlist rather than process.env. */
export async function createProfileGithubIsolation(
  parentDirectory: string,
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
  ghConfigDirectory?: string
): Promise<ProfileGithubIsolation> {
  const owned = await createOwnedProfileGithubDirectory(parentDirectory, 'bazframe-profile-github-');
  const root = owned.path;
  const home = join(root, 'home');
  const xdgConfigHome = join(root, 'xdg');
  const hooksDirectory = join(root, 'hooks');
  const globalConfigFile = join(root, 'gitconfig');
  try {
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      mkdir(xdgConfigHome, { mode: 0o700 }),
      mkdir(hooksDirectory, { mode: 0o700 })
    ]);
    const config = await open(globalConfigFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await config.close();
    await assertPhysicalDirectoryIdentity(owned.directory);
  } catch (error) {
    try { await owned.dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'GitHub isolation setup and cleanup both failed.', { cause: cleanupError }); }
    throw error;
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_INHERITED_ENVIRONMENT) {
    const value = inherited[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.LANG = 'C';
  environment.LC_ALL = 'C';
  environment.HOME = home;
  environment.XDG_CONFIG_HOME = xdgConfigHome;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = globalConfigFile;
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_ATTR_NOSYSTEM = '1';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  if (ghConfigDirectory !== undefined) environment.GH_CONFIG_DIR = ghConfigDirectory;
  return {
    root,
    home,
    xdgConfigHome,
    hooksDirectory,
    globalConfigFile,
    environment: Object.freeze(environment),
    directory: owned.directory,
    dispose: owned.dispose
  };
}

export function profileGithubGitArguments(
  isolation: ProfileGithubIsolation,
  args: readonly string[],
  options: { authenticated?: boolean; allowFileProtocol?: boolean } = {}
): readonly string[] {
  const fixed = [
    '-c', 'credential.helper=',
    '-c', `core.hooksPath=${isolation.hooksDirectory}`,
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always'
  ];
  if (options.allowFileProtocol === true) fixed.push('-c', 'protocol.file.allow=always');
  if (options.authenticated === true) {
    if (isolation.environment.GH_CONFIG_DIR === undefined) throw invalid('authenticated Git requires an explicit GH_CONFIG_DIR');
    fixed.push('-c', 'credential.helper=!gh auth git-credential');
  }
  return [...fixed, ...args];
}

export async function runProfileGithubCommand(
  processRunner: ProfileGithubProcess,
  isolation: ProfileGithubIsolation,
  executable: 'git' | 'gh',
  args: readonly string[],
  cwd: string,
  options: {
    stdin?: 'ignore' | 'inherit';
    transfer?: boolean;
    authenticated?: boolean;
    allowFileProtocol?: boolean;
    maxStdoutBytes?: number;
    monitor?: () => void | Promise<void>;
  } = {}
): Promise<ProfileGithubProcessResult> {
  const finalArgs = executable === 'git'
    ? profileGithubGitArguments(isolation, args, options)
    : [...args];
  return processRunner({
    executable,
    args: finalArgs,
    cwd,
    environment: isolation.environment,
    stdin: options.stdin ?? 'ignore',
    timeoutMilliseconds: options.transfer === true
      ? PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitCloneFetchMilliseconds
      : PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitMetadataMilliseconds,
    terminationGraceMilliseconds: PROFILE_PORTABILITY_PRODUCTION_LIMITS.processTerminationGraceMilliseconds,
    maxStdoutBytes: options.maxStdoutBytes ?? PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes,
    maxStderrBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes,
    ...(options.monitor === undefined ? {} : { monitor: options.monitor })
  });
}

/** Default literal-argv runner with bounded independent streams and fail-closed process-tree lifetime. */
export const defaultProfileGithubProcess: ProfileGithubProcess = async (request) => new Promise((resolve) => {
  assertRequest(request);
  let child: ChildProcess;
  try {
    child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: { ...request.environment },
      shell: false,
      detached: POSIX_PROCESS_GROUPS,
      stdio: [request.stdin, 'pipe', 'pipe']
    });
  } catch (error) {
    resolve({ status: null, stdout: '', stderr: '', failure: 'spawn', error: asError(error) });
    return;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure: ProfileGithubProcessResult['failure'];
  let error: Error | undefined;
  let monitorError: Error | undefined;
  let uncertainTermination = false;
  let status: number | null = null;
  let settled = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let confirmationTimer: NodeJS.Timeout | undefined;
  let treeDone = false;
  let monitorRunning = false;
  let monitorScheduled = false;
  let finalMonitorStarted = false;
  const timeoutTimer = setTimeout(() => stop('timeout'), request.timeoutMilliseconds);

  const groupExists = (): boolean | undefined => {
    if (!POSIX_PROCESS_GROUPS || child.pid === undefined) return undefined;
    try { process.kill(-child.pid, 0); return true; }
    catch (cause) {
      const code = processErrorCode(cause);
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      return undefined;
    }
  };
  const signalTree = (signal: NodeJS.Signals): boolean => {
    if (POSIX_PROCESS_GROUPS && child.pid !== undefined) {
      try { process.kill(-child.pid, signal); return true; }
      catch (cause) { return processErrorCode(cause) === 'ESRCH'; }
    }
    try { child.kill(signal); } catch { return false; }
    return true;
  };
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (confirmationTimer !== undefined) clearTimeout(confirmationTimer);
    const exactStdout = Buffer.concat(stdout, stdoutBytes);
    resolve({
      status,
      stdout: exactStdout.toString('utf8'),
      stderr: Buffer.concat(stderr, stderrBytes).toString('utf8'),
      stdoutBytes: exactStdout,
      ...(failure === undefined ? {} : { failure }),
      ...(uncertainTermination ? { uncertainTermination: true } : {}),
      ...(error === undefined ? {} : { error }),
      ...(monitorError === undefined ? {} : { monitorError })
    });
  };
  const runMonitor = async (final: boolean): Promise<void> => {
    if (request.monitor === undefined || monitorError !== undefined) return;
    monitorRunning = true;
    try { await request.monitor(); }
    catch (cause) {
      monitorError = asError(cause);
      stop('monitor-failure');
    } finally { monitorRunning = false; }
    if (final) finish();
    else if (treeDone) beginFinalMonitor();
    else scheduleMonitor();
  };
  const scheduleMonitor = (): void => {
    if (request.monitor === undefined || monitorError !== undefined || treeDone || monitorRunning || monitorScheduled) return;
    monitorScheduled = true;
    setImmediate(() => {
      monitorScheduled = false;
      if (treeDone) beginFinalMonitor();
      else void runMonitor(false);
    });
  };
  function beginFinalMonitor(): void {
    if (!treeDone || finalMonitorStarted || settled || monitorRunning) return;
    finalMonitorStarted = true;
    if (request.monitor === undefined || monitorError !== undefined) finish();
    else void runMonitor(true);
  }
  const completeTree = (): void => {
    if (treeDone) return;
    treeDone = true;
    clearTimeout(timeoutTimer);
    if (!monitorRunning) beginFinalMonitor();
  };
  const confirm = (): void => {
    if (settled) return;
    if (groupExists() !== false) {
      uncertainTermination = true;
      failure ??= 'termination-uncertain';
    }
    completeTree();
  };
  const force = (): void => {
    if (settled) return;
    if (groupExists() === false) { completeTree(); return; }
    if (!signalTree('SIGKILL')) uncertainTermination = true;
    confirmationTimer = setTimeout(confirm, request.terminationGraceMilliseconds);
  };
  function stop(reason: NonNullable<ProfileGithubProcessResult['failure']>): void {
    if (settled || failure !== undefined) return;
    failure = reason;
    clearTimeout(timeoutTimer);
    if (!signalTree('SIGTERM')) uncertainTermination = true;
    graceTimer = setTimeout(force, request.terminationGraceMilliseconds);
  }
  const capture = (target: Buffer[], stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
    if (failure !== undefined) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const current = stream === 'stdout' ? stdoutBytes : stderrBytes;
    const maximum = stream === 'stdout' ? request.maxStdoutBytes : request.maxStderrBytes;
    if (current + bytes.byteLength > maximum) {
      stop(stream === 'stdout' ? 'stdout-overflow' : 'stderr-overflow');
      return;
    }
    target.push(bytes);
    if (stream === 'stdout') stdoutBytes += bytes.byteLength;
    else stderrBytes += bytes.byteLength;
  };
  child.stdout?.on('data', (chunk: Buffer | string) => capture(stdout, 'stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer | string) => capture(stderr, 'stderr', chunk));
  child.once('error', (cause) => {
    error = asError(cause);
    if (child.pid === undefined) {
      failure ??= 'spawn';
      completeTree();
    } else stop('spawn');
  });
  child.once('close', (code) => {
    status = code;
    const descendants = groupExists();
    if (descendants === false || !POSIX_PROCESS_GROUPS) { completeTree(); return; }
    if (failure === undefined) stop(descendants === true ? 'process-tree-survived' : 'termination-uncertain');
    if (descendants === undefined) uncertainTermination = true;
  });
  if (request.monitor === undefined) scheduleMonitor();
  else void runMonitor(false);
});

export function assertProfileGithubOutputConsistency(result: ProfileGithubProcessResult): void {
  if (result.stdoutBytes !== undefined && Buffer.from(result.stdoutBytes).toString('utf8') !== result.stdout) {
    throw new BazframeError('PROFILE_GITHUB_OUTPUT_INVALID', 'GitHub process returned contradictory stdout representations.');
  }
}

export function assertProfileGithubCommand(result: ProfileGithubProcessResult, code: string, message: string): string {
  assertProfileGithubOutputConsistency(result);
  if (result.status !== 0 || result.failure !== undefined || result.error !== undefined || result.uncertainTermination === true) {
    throw new BazframeError(code, message, result.error === undefined ? {} : { cause: result.error });
  }
  return result.stdout;
}

function assertRequest(request: ProfileGithubProcessRequest): void {
  for (const [label, value] of Object.entries({
    timeoutMilliseconds: request.timeoutMilliseconds,
    terminationGraceMilliseconds: request.terminationGraceMilliseconds,
    maxStdoutBytes: request.maxStdoutBytes,
    maxStderrBytes: request.maxStderrBytes
  })) if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a finite nonnegative safe integer`);
}
function invalid(detail: string): BazframeError {
  return new BazframeError('PROFILE_GITHUB_PROCESS_INVALID', `Invalid GitHub process configuration: ${detail}.`);
}
function cleanupInvalid(detail: string): BazframeError {
  return new BazframeError('PROFILE_GITHUB_CLEANUP_UNPROVEN', `GitHub workspace disposal was not proved: ${detail}.`);
}
function processErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
