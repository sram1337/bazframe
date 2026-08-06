import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { resolveSkillbookLibrary } from '../state/paths.js';
import { isSafeSkillId } from './skill-id.js';
import { readSkillDeclaredName } from './skill-metadata.js';

export interface SkillLibraryOptions {
  environment: NodeJS.ProcessEnv;
  userHome?: string;
}

export interface SkillLibraryList {
  library: string;
  skillsRoot: string;
  skillIds: string[];
  diagnostics: string[];
}

export async function listAvailableSkills(
  options: SkillLibraryOptions
): Promise<SkillLibraryList> {
  const library = resolveSkillbookLibrary(options.environment, options.userHome);
  const skillsRoot = join(library, 'skills');
  let rootMetadata;
  try {
    rootMetadata = await stat(skillsRoot);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { library, skillsRoot, skillIds: [], diagnostics: [] };
    }
    throw new BazframeError(
      'SKILL_LIBRARY_READ_FAILED',
      `Could not inspect the resolved Skillbook skills directory: ${skillsRoot}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (!rootMetadata.isDirectory()) {
    throw new BazframeError(
      'SKILL_LIBRARY_INVALID',
      `Resolved Skillbook skills path must be a directory: ${skillsRoot}`
    );
  }

  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    throw new BazframeError(
      'SKILL_LIBRARY_READ_FAILED',
      `Could not read the resolved Skillbook skills directory: ${skillsRoot}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const skillIds: string[] = [];
  const diagnostics: string[] = [];
  for (const entry of entries) {
    const candidate = join(skillsRoot, entry.name);
    if (!isSafeSkillId(entry.name)) {
      diagnostics.push(`Skipping unsafe Skillbook entry ${JSON.stringify(entry.name)}.`);
      continue;
    }
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        diagnostics.push(`Skipping nonphysical Skillbook skill ${JSON.stringify(entry.name)}.`);
        continue;
      }
      const declaredName = await readSkillDeclaredName(candidate);
      if (declaredName !== entry.name) {
        diagnostics.push(
          `Skipping Skillbook skill ${JSON.stringify(entry.name)} because it declares name ${JSON.stringify(declaredName)}.`
        );
        continue;
      }
      skillIds.push(entry.name);
    } catch (error) {
      diagnostics.push(
        `Skipping invalid Skillbook skill ${JSON.stringify(entry.name)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { library, skillsRoot, skillIds, diagnostics };
}

export function suggestSkillIds(
  requested: string,
  candidates: readonly string[],
  limit = 3
): string[] {
  const maximumDistance = requested.length <= 4 ? 1 : requested.length <= 8 ? 2 : 3;
  return candidates
    .map((candidate) => ({ candidate, distance: editDistance(requested, candidate) }))
    .filter(({ distance }) => distance <= maximumDistance)
    .sort((left, right) => left.distance - right.distance
      || (left.candidate < right.candidate ? -1 : left.candidate > right.candidate ? 1 : 0))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious: number[] | undefined;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      let distance = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        substitution
      );
      if (
        beforePrevious !== undefined
        && leftIndex > 1
        && rightIndex > 1
        && left[leftIndex - 1] === right[rightIndex - 2]
        && left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        distance = Math.min(distance, (beforePrevious[rightIndex - 2] ?? 0) + 1);
      }
      current.push(distance);
    }
    beforePrevious = previous.slice();
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? left.length;
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
