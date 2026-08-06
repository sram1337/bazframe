import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { BazframeError } from '../core/errors.js';

export interface LegacyRepositoryRegistration {
  schemaVersion: 1;
  repository: string;
  mode: 'adaptive-context';
  profile: 'active';
}

export interface DisabledRepositoryOverride {
  schemaVersion: 2;
  repository: string;
  disabled: true;
}

export interface EnabledRepositoryOverride {
  schemaVersion: 3;
  repository: string;
  enabled: true;
}

export type RepositoryProjectState =
  | LegacyRepositoryRegistration
  | DisabledRepositoryOverride
  | EnabledRepositoryOverride;

export function createRepositoryRegistration(
  canonicalRepository: string
): LegacyRepositoryRegistration {
  assertCanonicalRepository(canonicalRepository, 'Repository registration');
  return {
    schemaVersion: 1,
    repository: canonicalRepository,
    mode: 'adaptive-context',
    profile: 'active'
  };
}

export function createDisabledRepositoryOverride(
  canonicalRepository: string
): DisabledRepositoryOverride {
  assertCanonicalRepository(canonicalRepository, 'Repository override');
  return {
    schemaVersion: 2,
    repository: canonicalRepository,
    disabled: true
  };
}

export function createEnabledRepositoryOverride(
  canonicalRepository: string
): EnabledRepositoryOverride {
  assertCanonicalRepository(canonicalRepository, 'Repository override');
  return {
    schemaVersion: 3,
    repository: canonicalRepository,
    enabled: true
  };
}

export function decodeRepositoryRegistration(
  text: string,
  source = 'repository project state',
  expectedRepository?: string
): RepositoryProjectState {
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
  const candidate = value as Partial<RepositoryProjectState> & Record<string, unknown>;
  if (
    typeof candidate.repository !== 'string'
    || !isNormalizedAbsolutePath(candidate.repository)
    || (expectedRepository !== undefined && candidate.repository !== expectedRepository)
  ) {
    throw invalidRegistration(source);
  }
  if (
    candidate.schemaVersion === 1
    && candidate.mode === 'adaptive-context'
    && candidate.profile === 'active'
    && hasExactKeys(candidate, ['schemaVersion', 'repository', 'mode', 'profile'])
  ) {
    return {
      schemaVersion: 1,
      repository: candidate.repository,
      mode: 'adaptive-context',
      profile: 'active'
    };
  }
  if (
    candidate.schemaVersion === 2
    && candidate.disabled === true
    && hasExactKeys(candidate, ['schemaVersion', 'repository', 'disabled'])
  ) {
    return {
      schemaVersion: 2,
      repository: candidate.repository,
      disabled: true
    };
  }
  if (
    candidate.schemaVersion === 3
    && candidate.enabled === true
    && hasExactKeys(candidate, ['schemaVersion', 'repository', 'enabled'])
  ) {
    return {
      schemaVersion: 3,
      repository: candidate.repository,
      enabled: true
    };
  }
  throw invalidRegistration(source);
}

export function encodeRepositoryRegistration(
  registration: RepositoryProjectState
): string {
  const validated = decodeRepositoryRegistration(
    JSON.stringify(registration),
    'repository project state'
  );
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function repositoryRegistrationId(canonicalRepository: string): string {
  assertCanonicalRepository(canonicalRepository, 'Repository project state');
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function assertCanonicalRepository(repository: string, source: string): void {
  if (!isNormalizedAbsolutePath(repository)) throw invalidRegistration(source);
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
    `${source} must be an exact legacy inherit record, disabled override, or enabled override for a canonical repository.`
  );
}
