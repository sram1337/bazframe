import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
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

export interface GitRootServices {
  paths: typeof path;
  canonical(directory: string): Promise<string>;
  run(cwd: string, environment: NodeJS.ProcessEnv): Promise<GitResult>;
  windows?: boolean;
}
const defaults: GitRootServices = { paths: path, canonical: realpath, run: runGit };

export async function findGitRoot(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  services: GitRootServices = defaults
): Promise<string> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await services.canonical(cwd);
  } catch (error) {
    throw new BazframeError(
      'GIT_ROOT_INVALID',
      `Could not admit current directory: ${cwd}`,
      { cause: error }
    );
  }

  const result = await services.run(canonicalCwd, gitDiscoveryEnvironment(environment, services.windows));
  if (result.error !== undefined) {
    if (errorCode(result.error) === 'ENOENT') {
      throw new BazframeError(
        'GIT_NOT_FOUND',
        'Could not find Git on PATH; install Git to inspect worktree-specific Bazframe state.',
        { cause: result.error }
      );
    }
    let diagnostic = '';
    try { diagnostic = new TextDecoder('utf-8', { fatal: true }).decode(result.stderr).trim(); } catch { /* not confirmed outside Git */ }
    const confirmed = result.error.code === 128 && result.error.killed !== true && result.error.signal == null
      && diagnostic === 'fatal: not a git repository (or any of the parent directories): .git';
    throw new BazframeError(confirmed ? 'NOT_GIT_WORKTREE' : 'GIT_DISCOVERY_FAILED',
      confirmed ? `Current directory is not inside a Git worktree: ${cwd}` : `Git worktree discovery failed: ${cwd}`, { cause: result.error });
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
  if (root.length === 0 || root.includes('\0') || !services.paths.isAbsolute(root)) {
    throw new BazframeError(
      'GIT_ROOT_INVALID',
      `Git returned an invalid worktree root: ${JSON.stringify(root)}`
    );
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await services.canonical(root);
  } catch (error) {
    throw new BazframeError(
      'GIT_ROOT_INVALID',
      `Git returned a worktree root that could not be canonicalized: ${root}`,
      { cause: error }
    );
  }

  if (!containsPath(canonicalRoot, canonicalCwd, services.paths)) {
    throw new BazframeError(
      'GIT_ROOT_MISMATCH',
      `Git returned a worktree root that does not contain the current directory: ${canonicalRoot}`
    );
  }
  return canonicalRoot;
}

export interface GitResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  error?: Error & { code?: string | number | null; killed?: boolean; signal?: string | null };
}

function runGit(cwd: string, environment: NodeJS.ProcessEnv): Promise<GitResult> {

  return new Promise((resolveResult) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', 'rev-parse', '--path-format=absolute', '--show-toplevel'],
      {
        cwd,
        env: environment,
        encoding: 'buffer',
        maxBuffer: 64 * 1024,
        timeout: 5000
      },
      (error, stdout, stderr) => {
        resolveResult({
          stdout: Uint8Array.from(stdout),
          stderr: Uint8Array.from(stderr),
          ...(error === null ? {} : { error })
        });
      }
    );
  });
}

function containsPath(parent: string, candidate: string, paths: typeof path): boolean {
  const childPath = paths.relative(parent, candidate);
  return childPath === ''
    || (childPath !== '..' && !childPath.startsWith(`..${paths.sep}`) && !paths.isAbsolute(childPath));
}

export function gitDiscoveryEnvironment(environment: NodeJS.ProcessEnv, windows = process.platform === 'win32'): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of Object.keys(result)) if (GIT_REPOSITORY_SELECTION_VARIABLES.some((variable) => variable === (windows ? name.toUpperCase() : name)) || (windows && ['LANG', 'LC_ALL'].includes(name.toUpperCase()))) delete result[name];
  return { ...result, LANG: 'C', LC_ALL: 'C' };
}
