import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { BazframeError } from '../core/errors.js';

export interface RepositoryRegistration {
  schemaVersion: 1;
  repository: string;
  mode: 'adaptive-context';
  profile: 'active';
}

export function createRepositoryRegistration(
  canonicalRepository: string
): RepositoryRegistration {
  if (!isNormalizedAbsolutePath(canonicalRepository)) {
    throw invalidRegistration('Repository registration');
  }
  return {
    schemaVersion: 1,
    repository: canonicalRepository,
    mode: 'adaptive-context',
    profile: 'active'
  };
}

export function decodeRepositoryRegistration(
  text: string,
  source = 'repository registration',
  expectedRepository?: string
): RepositoryRegistration {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new BazframeError('REGISTRATION_INVALID', `Invalid JSON in ${source}.`, {
      cause: error
    });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRegistration(source);
  }
  const candidate = value as Partial<RepositoryRegistration>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.repository !== 'string'
    || !isNormalizedAbsolutePath(candidate.repository)
    || candidate.mode !== 'adaptive-context'
    || candidate.profile !== 'active'
    || (expectedRepository !== undefined && candidate.repository !== expectedRepository)
  ) {
    throw invalidRegistration(source);
  }
  return {
    schemaVersion: 1,
    repository: candidate.repository,
    mode: 'adaptive-context',
    profile: 'active'
  };
}

export function encodeRepositoryRegistration(
  registration: RepositoryRegistration
): string {
  const validated = decodeRepositoryRegistration(
    JSON.stringify(registration),
    'repository registration'
  );
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function repositoryRegistrationId(canonicalRepository: string): string {
  if (!isNormalizedAbsolutePath(canonicalRepository)) {
    throw invalidRegistration('Repository registration');
  }
  return createHash('sha256').update(canonicalRepository).digest('hex');
}

export function repositoryRegistrationPath(
  bazframeHome: string,
  canonicalRepository: string
): string {
  return join(
    bazframeHome,
    'projects',
    `${repositoryRegistrationId(canonicalRepository)}.json`
  );
}

function isNormalizedAbsolutePath(path: string): boolean {
  return path.length > 0
    && !path.includes('\0')
    && isAbsolute(path)
    && resolve(path) === path;
}

function invalidRegistration(source: string): BazframeError {
  return new BazframeError(
    'REGISTRATION_INVALID',
    `${source} must identify a canonical repository in adaptive-context mode with the active profile.`
  );
}
