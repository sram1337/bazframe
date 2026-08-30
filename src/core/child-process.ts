import { spawn } from 'node:child_process';
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

export function childExitStatus(result: ChildResult): number {
  if (result.exitCode !== null) return result.exitCode;
  if (result.signal === 'SIGINT') return 130;
  if (result.signal === 'SIGTERM') return 143;
  return signalExitStatus(result.signal);
}

function signalExitStatus(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const signalNumber = constants.signals[signal as keyof typeof constants.signals];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}
