import { resolvePiExecutable, type ExecutableResolutionOptions } from '../core/executable-resolution.js';
import type { InheritedChildOptions } from '../core/child-process.js';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  spawnInheritedChild,
  type ChildResult
} from '../core/child-process.js';

export type { ChildResult } from '../core/child-process.js';
export { childExitStatus } from '../core/child-process.js';

export async function spawnPi(
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  executable = 'pi',
  options: { platform?: NodeJS.Platform; executableEffects?: ExecutableResolutionOptions['effects']; spawnProcess?: InheritedChildOptions['spawnProcess'] } = {}
): Promise<ChildResult> {
  try {
    const selected = (options.platform ?? process.platform) === 'win32' ? await resolvePiExecutable(executable, { cwd, environment, platform: 'win32', effects: options.executableEffects }) : { executable, args: [] };
    return await spawnInheritedChild(selected.executable, [...selected.args, ...args], {
      spawnProcess: options.spawnProcess,
      cwd,
      environment,
      forwardSignals: ['SIGINT', 'SIGTERM']
    });
  } catch (error) {
    throw spawnError(executable, error);
  }
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
