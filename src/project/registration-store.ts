import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import {
  createRepositoryRegistration,
  decodeRepositoryRegistration,
  encodeRepositoryRegistration,
  repositoryRegistrationPath,
  type RepositoryRegistration
} from './registration.js';

const MAX_REGISTRATION_BYTES = 64 * 1024;

export type RegistrationWriteAction = 'registered' | 'current';
export type RegistrationRemoveAction = 'unregistered' | 'absent';

export async function readRepositoryRegistration(
  bazframeHome: string,
  canonicalRepository: string
): Promise<RepositoryRegistration | undefined> {
  const path = repositoryRegistrationPath(bazframeHome, canonicalRepository);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw registrationReadError(path, error);
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size > MAX_REGISTRATION_BYTES
  ) {
    throw new BazframeError(
      'REGISTRATION_INVALID',
      `Repository registration must be a physical file no larger than ${MAX_REGISTRATION_BYTES} bytes: ${path}`
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
    throw registrationReadError(path, error);
  }
}

export async function registerRepository(
  bazframeHome: string,
  canonicalRepository: string
): Promise<RegistrationWriteAction> {
  const path = repositoryRegistrationPath(bazframeHome, canonicalRepository);
  return withStateLock(
    join(bazframeHome, 'locks', 'state.lock'),
    { command: 'bazframe init', target: path },
    async () => {
      const existing = await readRepositoryRegistration(bazframeHome, canonicalRepository);
      if (existing !== undefined) return 'current';
      const registration = createRepositoryRegistration(canonicalRepository);
      await writeFileAtomic(path, encodeRepositoryRegistration(registration), {
        managedRoot: bazframeHome
      });
      return 'registered';
    },
    { managedRoot: bazframeHome }
  );
}

export async function unregisterRepository(
  bazframeHome: string,
  canonicalRepository: string
): Promise<RegistrationRemoveAction> {
  const path = repositoryRegistrationPath(bazframeHome, canonicalRepository);
  return withStateLock(
    join(bazframeHome, 'locks', 'state.lock'),
    { command: 'bazframe uninit', target: path },
    async () => {
      const existing = await readRepositoryRegistration(bazframeHome, canonicalRepository);
      if (existing === undefined) return 'absent';
      try {
        await rm(path);
      } catch (error) {
        throw new BazframeError(
          'REGISTRATION_REMOVE_FAILED',
          `Could not remove repository registration ${path}${formatErrorCode(error)}`,
          { cause: error }
        );
      }
      return 'unregistered';
    },
    { managedRoot: bazframeHome }
  );
}

function registrationReadError(path: string, error: unknown): BazframeError {
  return new BazframeError(
    'REGISTRATION_READ_FAILED',
    `Could not read repository registration ${path}${formatErrorCode(error)}`,
    { cause: error }
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
