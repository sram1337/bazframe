import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { readGlobalPolicy, type GlobalPolicy } from '../policy/global-policy.js';
import { writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import {
  createDisabledRepositoryOverride,
  createEnabledRepositoryOverride,
  decodeRepositoryRegistration,
  encodeRepositoryRegistration,
  repositoryRegistrationPath,
  type RepositoryProjectState
} from './registration.js';

const MAX_REGISTRATION_BYTES = 64 * 1024;

export type RepositoryPolicyAction =
  | 'current'
  | 'inherited'
  | 'override-added'
  | 'override-removed';

export interface RepositoryPolicyResult {
  action: RepositoryPolicyAction;
  globalPolicy: GlobalPolicy;
}

export interface RepositoryProjectStateList {
  projectStates: RepositoryProjectState[];
  diagnostics: string[];
}

export async function readRepositoryProjectState(
  bazframeHome: string,
  canonicalRepository: string
): Promise<RepositoryProjectState | undefined> {
  const path = repositoryRegistrationPath(bazframeHome, canonicalRepository);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw projectStateReadError(path, error);
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size > MAX_REGISTRATION_BYTES
  ) {
    throw new BazframeError(
      'REGISTRATION_INVALID',
      `Repository project state must be a physical file no larger than ${MAX_REGISTRATION_BYTES} bytes: ${path}`
    );
  }
  try {
    return decodeRepositoryRegistration(
      await readFile(path, 'utf8'),
      path,
      canonicalRepository
    );
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    throw projectStateReadError(path, error);
  }
}

export async function listRepositoryProjectStates(
  bazframeHome: string
): Promise<RepositoryProjectStateList> {
  const projectsRoot = join(bazframeHome, 'projects');
  let rootMetadata;
  try {
    rootMetadata = await lstat(projectsRoot);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { projectStates: [], diagnostics: [] };
    throw projectStateReadError(projectsRoot, error);
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new BazframeError(
      'REGISTRATION_DIRECTORY_INVALID',
      `Repository project-state path must be a physical directory: ${projectsRoot}`
    );
  }

  const projectStates: RepositoryProjectState[] = [];
  const diagnostics: string[] = [];
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(projectsRoot, entry.name);
    try {
      const metadata = await lstat(path);
      if (
        metadata.isSymbolicLink()
        || !metadata.isFile()
        || metadata.size > MAX_REGISTRATION_BYTES
      ) {
        throw new BazframeError(
          'REGISTRATION_INVALID',
          `Repository project state must be a physical file no larger than ${MAX_REGISTRATION_BYTES} bytes: ${path}`
        );
      }
      const projectState = decodeRepositoryRegistration(await readFile(path, 'utf8'), path);
      if (repositoryRegistrationPath(bazframeHome, projectState.repository) !== path) {
        throw new BazframeError(
          'REGISTRATION_INVALID',
          `Repository project-state filename does not match its canonical repository: ${path}`
        );
      }
      projectStates.push(projectState);
    } catch (error) {
      diagnostics.push(
        `Skipping invalid repository project state ${JSON.stringify(entry.name)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  projectStates.sort((left, right) => left.repository < right.repository
    ? -1
    : left.repository > right.repository ? 1 : 0);
  return { projectStates, diagnostics };
}

export async function enableRepository(
  bazframeHome: string,
  canonicalRepository: string
): Promise<RepositoryPolicyResult> {
  return setRepositoryPolicy(bazframeHome, canonicalRepository, true);
}

export async function disableRepository(
  bazframeHome: string,
  canonicalRepository: string
): Promise<RepositoryPolicyResult> {
  return setRepositoryPolicy(bazframeHome, canonicalRepository, false);
}

async function setRepositoryPolicy(
  bazframeHome: string,
  canonicalRepository: string,
  enabled: boolean
): Promise<RepositoryPolicyResult> {
  const path = repositoryRegistrationPath(bazframeHome, canonicalRepository);
  const command = `bazframe project ${enabled ? 'enable' : 'disable'}`;
  return withStateLock(
    join(bazframeHome, 'locks', 'state.lock'),
    { command, target: path },
    async () => {
      const globalPolicy = await readGlobalPolicy(bazframeHome);
      const existing = await readRepositoryProjectState(bazframeHome, canonicalRepository);
      const inheritsRequestedPolicy = (globalPolicy === 'enabled') === enabled;
      if (inheritsRequestedPolicy) {
        if (existing === undefined) return { action: 'inherited', globalPolicy };
        await removeProjectState(path);
        return { action: 'override-removed', globalPolicy };
      }

      const requestedSchema = enabled ? 3 : 2;
      if (existing?.schemaVersion === requestedSchema) {
        return { action: 'current', globalPolicy };
      }
      const override = enabled
        ? createEnabledRepositoryOverride(canonicalRepository)
        : createDisabledRepositoryOverride(canonicalRepository);
      await writeFileAtomic(path, encodeRepositoryRegistration(override), {
        managedRoot: bazframeHome
      });
      return { action: 'override-added', globalPolicy };
    },
    { managedRoot: bazframeHome }
  );
}

async function removeProjectState(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    throw new BazframeError(
      'REGISTRATION_REMOVE_FAILED',
      `Could not remove repository project state ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
}

function projectStateReadError(path: string, error: unknown): BazframeError {
  return new BazframeError(
    'REGISTRATION_READ_FAILED',
    `Could not read repository project state ${path}${formatErrorCode(error)}`,
    { cause: error }
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
