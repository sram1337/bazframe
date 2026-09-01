import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';

export interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type ChildOutputPolicy = 'inherit' | 'stdout-and-stderr-to-parent-stderr';

export interface InheritedChildOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  outputPolicy?: ChildOutputPolicy;
  forwardSignals?: readonly Extract<NodeJS.Signals, 'SIGINT' | 'SIGTERM'>[];
  ignoreParentSignals?: readonly NodeJS.Signals[];
  spawnProcess?: typeof spawn;
}

export type PackageProcessFailure =
  | 'timeout'
  | 'spawn-error'
  | 'parent-signal'
  | 'process-tree-survived'
  | 'termination-uncertain';

export interface BoundedPackageProcessResult extends ChildResult {
  failure?: PackageProcessFailure;
  error?: Error;
  uncertainTermination?: boolean;
}

export interface BoundedPackageProcessOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  outputPolicy?: ChildOutputPolicy;
  timeoutMilliseconds: number;
  terminationGraceMilliseconds: number;
  spawnProcess?: typeof spawn;
  /** Internal deterministic process-tree signaling seam. */
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Internal portability seam; production uses POSIX process groups off Windows. */
  posixProcessGroups?: boolean;
}

export async function spawnInheritedChild(
  executable: string,
  args: readonly string[],
  options: InheritedChildOptions
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = (options.spawnProcess ?? spawn)(executable, [...args], {
        cwd: options.cwd,
        env: options.environment,
        stdio: options.outputPolicy === 'stdout-and-stderr-to-parent-stderr'
          ? ['inherit', process.stderr, process.stderr]
          : 'inherit',
        shell: false
      });
    } catch (error) {
      reject(error);
      return;
    }

    const forwarded = options.forwardSignals ?? [];
    const handlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = forwarded.map((signal) => {
      const handler = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.kill(signal);
        } catch {
          // A concurrently exiting child remains authoritative through its close event.
        }
      };
      process.on(signal, handler);
      return { signal, handler };
    });
    for (const signal of options.ignoreParentSignals ?? []) {
      const handler = () => {
        // The foreground child receives the terminal signal directly; keep the parent alive.
      };
      process.on(signal, handler);
      handlers.push({ signal, handler });
    }
    const removeSignalHandlers = () => {
      for (const { signal, handler } of handlers) process.off(signal, handler);
    };

    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        removeSignalHandlers();
        reject(error);
      }
    });
    child.once('close', (exitCode, signal) => {
      if (!settled) {
        settled = true;
        removeSignalHandlers();
        resolve({ exitCode, signal });
      }
    });
  });
}

/** Runs one package build with inherited output and a bounded, fail-closed process-tree lifetime. */
export function spawnBoundedPackageProcess(
  executable: string,
  args: readonly string[],
  options: BoundedPackageProcessOptions
): Promise<BoundedPackageProcessResult> {
  assertBoundedProcessLimit(options.timeoutMilliseconds, 'timeoutMilliseconds');
  assertBoundedProcessLimit(options.terminationGraceMilliseconds, 'terminationGraceMilliseconds');
  const processGroups = options.posixProcessGroups ?? process.platform !== 'win32';
  const signalProcess = options.signalProcess ?? process.kill.bind(process);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (options.spawnProcess ?? spawn)(executable, [...args], {
        cwd: options.cwd,
        env: options.environment,
        stdio: options.outputPolicy === 'stdout-and-stderr-to-parent-stderr'
          ? ['inherit', process.stderr, process.stderr]
          : 'inherit',
        shell: false,
        detached: processGroups
      });
    } catch (error) {
      resolve({ exitCode: null, signal: null, failure: 'spawn-error', error: asError(error) });
      return;
    }

    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let parentSignal: Extract<NodeJS.Signals, 'SIGHUP' | 'SIGINT' | 'SIGTERM'> | undefined;
    let failure: PackageProcessFailure | undefined;
    let processError: Error | undefined;
    let uncertainTermination = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let confirmationTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => stop('timeout'), options.timeoutMilliseconds);
    const parentSignalHandlers = (['SIGHUP', 'SIGINT', 'SIGTERM'] as const).map((signal) => {
      const handler = () => {
        parentSignal ??= signal;
        stop('parent-signal');
      };
      process.on(signal, handler);
      return { signal, handler };
    });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (confirmationTimer !== undefined) clearTimeout(confirmationTimer);
      for (const { signal, handler } of parentSignalHandlers) process.off(signal, handler);
      resolve({
        exitCode,
        signal: parentSignal ?? exitSignal,
        ...(failure === undefined ? {} : { failure }),
        ...(processError === undefined ? {} : { error: processError }),
        ...(uncertainTermination ? { uncertainTermination: true } : {})
      });
    };
    const groupExists = (): boolean | undefined => {
      if (!processGroups || child.pid === undefined) return undefined;
      try {
        signalProcess(-child.pid, 0);
        return true;
      } catch (error) {
        const code = processErrorCode(error);
        if (code === 'ESRCH') return false;
        if (code === 'EPERM') return true;
        return undefined;
      }
    };
    const signalTree = (signal: NodeJS.Signals): boolean => {
      if (processGroups && child.pid !== undefined) {
        try {
          signalProcess(-child.pid, signal);
          return true;
        } catch (error) {
          return processErrorCode(error) === 'ESRCH';
        }
      }
      try { child.kill(signal); } catch { /* immediate-child fallback only */ }
      return false;
    };
    const confirmOrFail = (): void => {
      if (settled) return;
      if (groupExists() !== false) {
        uncertainTermination = true;
        failure ??= 'termination-uncertain';
      }
      finish();
    };
    const force = (): void => {
      if (settled) return;
      if (groupExists() === false) {
        finish();
        return;
      }
      if (!signalTree('SIGKILL')) uncertainTermination = true;
      confirmationTimer = setTimeout(confirmOrFail, options.terminationGraceMilliseconds);
    };
    function stop(reason: PackageProcessFailure, uncertain = false): void {
      if (settled || failure !== undefined) return;
      failure = reason;
      uncertainTermination ||= uncertain;
      clearTimeout(timeoutTimer);
      if (!signalTree('SIGTERM')) uncertainTermination = true;
      graceTimer = setTimeout(force, options.terminationGraceMilliseconds);
    }

    child.once('error', (error) => {
      processError = asError(error);
      if (child.pid === undefined) {
        failure = 'spawn-error';
        finish();
      } else {
        stop('spawn-error');
      }
    });
    child.once('close', (status, signal) => {
      exitCode = status;
      exitSignal = signal;
      if (!processGroups) {
        if (failure !== undefined) uncertainTermination = true;
        finish();
        return;
      }
      const descendants = groupExists();
      if (descendants === false) {
        finish();
        return;
      }
      if (failure !== undefined) return;
      if (descendants === true) stop('process-tree-survived');
      else stop('termination-uncertain', true);
    });
  });
}

export function childExitStatus(result: ChildResult): number {
  if (result.exitCode !== null) return result.exitCode;
  if (result.signal === 'SIGINT') return 130;
  if (result.signal === 'SIGTERM') return 143;
  return signalExitStatus(result.signal);
}

function assertBoundedProcessLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a finite nonnegative safe integer`);
}

function processErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

function signalExitStatus(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const signalNumber = constants.signals[signal as keyof typeof constants.signals];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}
