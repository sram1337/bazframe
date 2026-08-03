import { spawn } from 'node:child_process';
import { BazframeError, errorCode } from '../core/errors.js';

export interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export async function spawnPi(
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  executable = 'pi'
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env: environment,
        stdio: 'inherit',
        shell: false
      });
    } catch (error) {
      reject(spawnError(executable, error));
      return;
    }

    const forwardSigint = () => forwardSignal(child, 'SIGINT');
    const forwardSigterm = () => forwardSignal(child, 'SIGTERM');
    const removeSignalHandlers = () => {
      process.off('SIGINT', forwardSigint);
      process.off('SIGTERM', forwardSigterm);
    };
    process.on('SIGINT', forwardSigint);
    process.on('SIGTERM', forwardSigterm);

    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        removeSignalHandlers();
        reject(spawnError(executable, error));
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

function forwardSignal(
  child: ReturnType<typeof spawn>,
  signal: Extract<NodeJS.Signals, 'SIGINT' | 'SIGTERM'>
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // A concurrently exiting child remains authoritative through its close event.
  }
}

export function childExitStatus(result: ChildResult): number {
  if (result.exitCode !== null) return result.exitCode;
  if (result.signal === 'SIGINT') return 130;
  if (result.signal === 'SIGTERM') return 143;
  return signalExitStatus(result.signal);
}

function spawnError(executable: string, error: unknown): BazframeError {
  const notFound = errorCode(error) === 'ENOENT';
  return new BazframeError(
    'PI_LAUNCH_FAILED',
    notFound
      ? `Could not find Pi executable ${JSON.stringify(executable)} on PATH.`
      : `Could not launch Pi executable ${JSON.stringify(executable)}.`,
    { cause: error }
  );
}

function signalExitStatus(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const knownSignals: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14
  };
  const signalNumber = knownSignals[signal];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}
