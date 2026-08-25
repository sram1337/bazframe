import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';

const GIT_REPOSITORY_SELECTION_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM'
] as const;

export async function findGitRoot(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
  } catch (error) {
    throw new BazframeError(
      'NOT_GIT_WORKTREE',
      `Current directory is not inside a Git worktree: ${cwd}`,
      { cause: error }
    );
  }

  const result = await runGit(canonicalCwd, environment);
  if (result.error !== undefined) {
    if (errorCode(result.error) === 'ENOENT') {
      throw new BazframeError(
        'GIT_NOT_FOUND',
        'Could not find Git on PATH; install Git to inspect worktree-specific Bazframe state.',
        { cause: result.error }
      );
    }
    throw new BazframeError(
      'NOT_GIT_WORKTREE',
      `Current directory is not inside a Git worktree: ${cwd}`,
      { cause: result.error }
    );
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  } catch (error) {
    throw new BazframeError(
      'GIT_ROOT_INVALID_UTF8',
      'Git returned a worktree root that is not valid UTF-8.',
      { cause: error }
    );
  }
  const root = decoded.endsWith('\r\n')
    ? decoded.slice(0, -2)
    : decoded.endsWith('\n')
      ? decoded.slice(0, -1)
      : decoded;
  if (root.length === 0 || root.includes('\0') || !isAbsolute(root)) {
    throw new BazframeError(
      'GIT_ROOT_INVALID',
      `Git returned an invalid worktree root: ${JSON.stringify(root)}`
    );
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    throw new BazframeError(
      'GIT_ROOT_INVALID',
      `Git returned a worktree root that could not be canonicalized: ${root}`,
      { cause: error }
    );
  }

  if (!containsPath(canonicalRoot, canonicalCwd)) {
    throw new BazframeError(
      'GIT_ROOT_MISMATCH',
      `Git returned a worktree root that does not contain the current directory: ${canonicalRoot}`
    );
  }
  return canonicalRoot;
}

interface GitResult {
  stdout: Uint8Array;
  error?: Error;
}

function runGit(cwd: string, environment: NodeJS.ProcessEnv): Promise<GitResult> {
  const gitEnvironment = { ...environment };
  for (const variable of GIT_REPOSITORY_SELECTION_VARIABLES) {
    delete gitEnvironment[variable];
  }

  return new Promise((resolveResult) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', 'rev-parse', '--path-format=absolute', '--show-toplevel'],
      {
        cwd,
        env: gitEnvironment,
        encoding: 'buffer',
        maxBuffer: 64 * 1024,
        timeout: 5000
      },
      (error, stdout) => {
        resolveResult({
          stdout: Uint8Array.from(stdout),
          ...(error === null ? {} : { error })
        });
      }
    );
  });
}

function containsPath(parent: string, candidate: string): boolean {
  const childPath = relative(parent, candidate);
  return childPath === ''
    || (childPath !== '..' && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath));
}
