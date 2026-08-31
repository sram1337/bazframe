import { spawn, type ChildProcess } from 'node:child_process';

export interface ManagedGitProcessLimits {
  timeoutMilliseconds: number;
  terminationGraceMilliseconds: number;
  maxStreamBytes: number;
}

export type ManagedGitProcessFailure =
  | 'timeout'
  | 'stdout-overflow'
  | 'stderr-overflow'
  | 'monitor-failure'
  | 'termination-uncertain';

export interface ManagedGitProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  monitorError?: Error;
  failure?: ManagedGitProcessFailure;
  uncertainTermination?: boolean;
}

export interface ManagedGitProcessOptions {
  /** Serial, interval-free storage sampling. A thrown error stops the process tree. */
  monitor?: () => void | Promise<void>;
}

const POSIX_PROCESS_GROUPS = process.platform !== 'win32';

/** Runs one literal managed-provider command without a shell and bounds both captured streams independently. */
export function runManagedGitProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  limits: ManagedGitProcessLimits,
  options: ManagedGitProcessOptions = {}
): Promise<ManagedGitProcessResult> {
  assertLimits(limits);
  const monitor = options.monitor;
  if (monitor !== undefined && typeof monitor !== 'function') throw new TypeError('Managed Git process monitor must be a function');
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd,
        env: environment,
        shell: false,
        detached: POSIX_PROCESS_GROUPS,
        stdio: ['inherit', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error: asError(error) });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let processError: Error | undefined;
    let monitorError: Error | undefined;
    let failure: ManagedGitProcessFailure | undefined;
    let uncertainTermination = false;
    let settled = false;
    let treeDone = false;
    let monitorRunning = false;
    let monitorScheduled = false;
    let finalMonitorStarted = false;
    let childStatus: number | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    let confirmationTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => stop('timeout'), limits.timeoutMilliseconds);
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (confirmationTimer !== undefined) clearTimeout(confirmationTimer);
      resolve({
        status: childStatus,
        stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8'),
        stderr: Buffer.concat(stderr, stderrBytes).toString('utf8'),
        ...(processError === undefined ? {} : { error: processError }),
        ...(monitorError === undefined ? {} : { monitorError }),
        ...(failure === undefined ? {} : { failure }),
        ...(uncertainTermination ? { uncertainTermination: true } : {})
      });
    };
    const runMonitor = async (final: boolean): Promise<void> => {
      if (monitor === undefined || monitorError !== undefined) return;
      monitorRunning = true;
      try {
        await monitor();
      } catch (error) {
        monitorError = asError(error);
        failure ??= 'monitor-failure';
        stop('monitor-failure');
      } finally {
        monitorRunning = false;
      }
      if (final) settle();
      else if (treeDone) beginFinalMonitor();
      else scheduleMonitor();
    };
    const scheduleMonitor = (): void => {
      if (monitor === undefined || monitorError !== undefined || treeDone || monitorScheduled || monitorRunning) return;
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
      if (monitor === undefined || monitorError !== undefined) settle();
      else void runMonitor(true);
    }
    const processGroupExists = (): boolean | undefined => {
      if (!POSIX_PROCESS_GROUPS || child.pid === undefined) return undefined;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ESRCH') return false;
        if (code === 'EPERM') return true;
        return undefined;
      }
    };
    const signalTree = (signal: NodeJS.Signals): boolean => {
      if (POSIX_PROCESS_GROUPS && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch (error) {
          return errorCode(error) === 'ESRCH';
        }
      }
      try { child.kill(signal); } catch { /* immediate-child fallback only */ }
      return false;
    };
    const completeTree = (): void => {
      if (treeDone) return;
      treeDone = true;
      clearTimeout(timeoutTimer);
      if (!monitorRunning) beginFinalMonitor();
    };
    const confirmOrFail = (): void => {
      if (settled || treeDone) return;
      const exists = processGroupExists();
      if (exists === false) {
        completeTree();
        return;
      }
      uncertainTermination = true;
      failure ??= 'termination-uncertain';
      completeTree();
    };
    const force = (): void => {
      if (settled || treeDone) return;
      const exists = processGroupExists();
      if (exists === false) {
        completeTree();
        return;
      }
      if (!signalTree('SIGKILL')) uncertainTermination = true;
      confirmationTimer = setTimeout(confirmOrFail, limits.terminationGraceMilliseconds);
    };
    function stop(reason: ManagedGitProcessFailure): void {
      if (settled || treeDone) return;
      failure ??= reason;
      clearTimeout(timeoutTimer);
      if (!signalTree('SIGTERM')) uncertainTermination = true;
      if (graceTimer === undefined) graceTimer = setTimeout(force, limits.terminationGraceMilliseconds);
    }
    const capture = (target: Buffer[], stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      if (failure !== undefined) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const current = stream === 'stdout' ? stdoutBytes : stderrBytes;
      if (current + bytes.byteLength > limits.maxStreamBytes) {
        stop(stream === 'stdout' ? 'stdout-overflow' : 'stderr-overflow');
        return;
      }
      target.push(bytes);
      if (stream === 'stdout') stdoutBytes += bytes.byteLength;
      else stderrBytes += bytes.byteLength;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => capture(stdout, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => capture(stderr, 'stderr', chunk));
    child.once('error', (error) => { processError = error; });
    child.once('close', (status) => {
      childStatus = status;
      const descendants = processGroupExists();
      if (failure !== undefined) {
        if (descendants === false) completeTree();
        return;
      }
      if (descendants === true) {
        stop('termination-uncertain');
        return;
      }
      if (descendants === undefined && POSIX_PROCESS_GROUPS && child.pid !== undefined) {
        failure = 'termination-uncertain';
        uncertainTermination = true;
      }
      completeTree();
    });

    // The first sample is queued immediately and all later samples are serial setImmediate continuations.
    if (monitor === undefined) scheduleMonitor();
    else void runMonitor(false);
  });
}

function assertLimits(limits: ManagedGitProcessLimits): void {
  for (const [label, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a finite nonnegative safe integer`);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
