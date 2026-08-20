import {
  spawnInheritedChild,
  type ChildResult,
  type InheritedChildOptions
} from './child-process.js';
import { BazframeError, errorCode } from './errors.js';

export type InheritedChildRunner = (
  executable: string,
  args: readonly string[],
  options: InheritedChildOptions
) => Promise<ChildResult>;

export interface ExternalEditorTarget {
  path: string;
  cwd: string;
}

export interface ExternalEditorOptions {
  target: ExternalEditorTarget;
  environment: NodeJS.ProcessEnv;
  childRunner?: InheritedChildRunner;
}

export async function launchExternalEditor(
  options: ExternalEditorOptions
): Promise<ChildResult> {
  const executable = configuredEditor(options.environment, options.target.path);
  try {
    return await (options.childRunner ?? spawnInheritedChild)(
      executable,
      [options.target.path],
      {
        cwd: options.target.cwd,
        environment: options.environment,
        ignoreParentSignals: ['SIGINT']
      }
    );
  } catch (error) {
    const notFound = errorCode(error) === 'ENOENT';
    throw new BazframeError(
      'EDITOR_LAUNCH_FAILED',
      notFound
        ? `Could not find editor executable ${JSON.stringify(executable)} while opening ${options.target.path}. Configure VISUAL or EDITOR with one executable name or path; use a wrapper executable when flags are required.`
        : `Could not launch editor executable ${JSON.stringify(executable)} for ${options.target.path}.`,
      { cause: error }
    );
  }
}

function configuredEditor(environment: NodeJS.ProcessEnv, targetPath: string): string {
  if (environment.VISUAL?.trim()) return environment.VISUAL;
  if (environment.EDITOR?.trim()) return environment.EDITOR;
  throw new BazframeError(
    'EDITOR_NOT_CONFIGURED',
    `No external editor is configured for ${targetPath}. Set VISUAL or EDITOR to one executable name or path; use a wrapper executable when flags are required.`
  );
}
