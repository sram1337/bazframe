import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BazframeError } from '../core/errors.js';

export interface TemporaryInstructionFile {
  path: string;
  cleanup: () => Promise<void>;
}

export async function createTemporaryInstructionFile(
  contents: string,
  repositoryRoot: string,
  temporaryRoot = tmpdir()
): Promise<TemporaryInstructionFile> {
  const [resolvedRepositoryRoot, resolvedTemporaryRoot] = await Promise.all([
    realpath(repositoryRoot),
    realpath(temporaryRoot)
  ]);
  if (isContainedBy(resolvedRepositoryRoot, resolvedTemporaryRoot)) {
    throw new BazframeError(
      'TEMPORARY_ROOT_INSIDE_REPOSITORY',
      `Refusing to create effective instructions because the system temporary directory is inside the repository: ${resolvedTemporaryRoot}`
    );
  }

  const directory = await mkdtemp(join(resolvedTemporaryRoot, 'bazframe-'));
  const path = join(directory, '.baz.agents.md');
  try {
    await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new BazframeError(
      'TEMPORARY_INSTRUCTIONS_WRITE_FAILED',
      `Could not create temporary effective instructions outside the repository: ${path}`,
      { cause: error }
    );
  }

  return {
    path,
    async cleanup() {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        throw new BazframeError(
          'TEMPORARY_INSTRUCTIONS_CLEANUP_FAILED',
          `Could not remove temporary effective instructions directory: ${directory}`,
          { cause: error }
        );
      }
    }
  };
}

function isContainedBy(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return difference === ''
    || (difference !== '..'
      && !difference.startsWith(`..${sep}`)
      && !isAbsolute(difference));
}
