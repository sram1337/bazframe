import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { resolveControlledExecutable, executableEnvironmentValue, type ExecutableResolutionEffects } from '../core/executable-resolution.js';
import type { BazframeWin32NativeBackend } from '../core/win32-native.js';
import { runManagedGitProcess } from '../providers/managed-git-process.js';
import type { GitRootServices } from './git-root.js';

export function createWindowsGitRootServices(backend: BazframeWin32NativeBackend, options: { executableEffects?: ExecutableResolutionEffects; process?: typeof runManagedGitProcess } = {}): GitRootServices {
  return {
    paths: win32, windows: true,
    async canonical(directory) {
      // Git emits C:/... on Windows. Admit only local drive-absolute input before
      // normalization so relative, UNC and device paths cannot gain authority.
      if (!/^[a-z]:[\\/]/iu.test(directory)) throw new BazframeError('GIT_ROOT_INVALID', 'Git discovery requires an independently admitted local physical worktree.');
      directory = win32.normalize(directory);
      const inspection = backend.inspectPath(directory);
      if (inspection.kind !== 'directory' || !inspection.ancestryReparseFree || inspection.object.reparseTag !== null) throw new BazframeError('GIT_ROOT_INVALID', 'Git discovery requires an independently admitted local physical worktree.');
      return win32.parse(directory).root.toUpperCase() + inspection.canonicalPath.slice(inspection.volume.canonicalVolumeGuidPath.length);
    },
    async run(cwd, environment) {
      const executable = await resolveControlledExecutable(executableEnvironmentValue(environment, 'BAZFRAME_GIT_EXECUTABLE', true) ?? 'git', { cwd, environment, platform: 'win32', effects: options.executableEffects });
      // Read-only discovery needs no input and must not inherit a Pi/RPC input handle.
      const result = await (options.process ?? runManagedGitProcess)(executable, ['-c', 'core.quotePath=false', 'rev-parse', '--path-format=absolute', '--show-toplevel'], cwd, environment, { timeoutMilliseconds: 5000, terminationGraceMilliseconds: 2000, maxStreamBytes: 64 * 1024 }, { stdin: 'ignore' });
      const failed = result.status !== 0 || result.failure !== undefined || result.error !== undefined || result.monitorError !== undefined || result.signal != null || result.uncertainTermination === true;
      return { stdout: result.stdoutBytes ?? Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), ...(failed ? { error: Object.assign(new Error('Git discovery failed'), { code: result.status ?? errorCode(result.error), killed: result.failure !== undefined || result.uncertainTermination === true, signal: result.signal }) } : {}) };
    }
  };
}
