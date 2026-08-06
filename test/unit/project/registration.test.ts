import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDisabledRepositoryOverride,
  createEnabledRepositoryOverride,
  createRepositoryRegistration,
  decodeRepositoryRegistration,
  encodeRepositoryRegistration,
  repositoryRegistrationId,
  repositoryRegistrationPath
} from '../../../src/project/registration.js';

describe('repository project state', () => {
  it('round-trips legacy, disabled, and enabled state with a deterministic path key', () => {
    const repository = '/users/alice/projects/example';
    const legacy = createRepositoryRegistration(repository);
    const disabled = createDisabledRepositoryOverride(repository);
    const enabled = createEnabledRepositoryOverride(repository);
    const expectedId = createHash('sha256').update(repository).digest('hex');

    expect(decodeRepositoryRegistration(
      encodeRepositoryRegistration(legacy),
      'test project state',
      repository
    )).toEqual(legacy);
    expect(decodeRepositoryRegistration(
      encodeRepositoryRegistration(disabled),
      'test project state',
      repository
    )).toEqual(disabled);
    expect(decodeRepositoryRegistration(
      encodeRepositoryRegistration(enabled),
      'test project state',
      repository
    )).toEqual(enabled);
    expect(repositoryRegistrationId(repository)).toBe(expectedId);
    expect(repositoryRegistrationPath('/users/alice/.bazframe', repository))
      .toBe(`/users/alice/.bazframe/projects/${expectedId}.json`);
  });

  it('rejects malformed, unsupported, non-canonical, mismatched, and non-exact records', () => {
    const legacy = createRepositoryRegistration('/users/alice/projects/example');
    const disabled = createDisabledRepositoryOverride('/users/alice/projects/example');
    const enabled = createEnabledRepositoryOverride('/users/alice/projects/example');
    for (const value of [
      { ...legacy, schemaVersion: 3 },
      { ...legacy, mode: 'other' },
      { ...legacy, profile: 'focused' },
      { ...legacy, extra: true },
      { ...disabled, disabled: false },
      { ...disabled, extra: true },
      { schemaVersion: 2, repository: disabled.repository },
      { ...enabled, enabled: false },
      { ...enabled, extra: true },
      { schemaVersion: 3, repository: enabled.repository },
      { ...disabled, repository: 'relative/repository' },
      { ...disabled, repository: '/users/alice/projects/../other' }
    ]) {
      expect(() => decodeRepositoryRegistration(JSON.stringify(value)))
        .toThrow(/exact legacy|disabled override|enabled override/u);
    }
    expect(() => decodeRepositoryRegistration(
      JSON.stringify(disabled),
      'test project state',
      '/users/alice/projects/other'
    )).toThrow(/exact legacy|disabled override|enabled override/u);
    expect(() => decodeRepositoryRegistration('{')).toThrow(/Invalid JSON/u);
  });
});
