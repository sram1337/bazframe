import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createRepositoryRegistration,
  decodeRepositoryRegistration,
  encodeRepositoryRegistration,
  repositoryRegistrationId,
  repositoryRegistrationPath
} from '../../../src/project/registration.js';

describe('repository registrations', () => {
  it('round-trips the schema and derives a deterministic path key', () => {
    const repository = '/users/alice/projects/example';
    const registration = createRepositoryRegistration(repository);
    const encoded = encodeRepositoryRegistration(registration);
    const expectedId = createHash('sha256').update(repository).digest('hex');

    expect(decodeRepositoryRegistration(encoded, 'test registration', repository))
      .toEqual(registration);
    expect(repositoryRegistrationId(repository)).toBe(expectedId);
    expect(repositoryRegistrationPath('/users/alice/.bazframe', repository))
      .toBe(`/users/alice/.bazframe/projects/${expectedId}.json`);
  });

  it('rejects malformed, unsupported, mismatched, and non-canonical records', () => {
    const valid = createRepositoryRegistration('/users/alice/projects/example');
    for (const value of [
      { ...valid, schemaVersion: 2 },
      { ...valid, mode: 'other' },
      { ...valid, profile: 'focused' },
      { ...valid, repository: 'relative/repository' },
      { ...valid, repository: '/users/alice/projects/../other' }
    ]) {
      expect(() => decodeRepositoryRegistration(JSON.stringify(value)))
        .toThrow(/canonical repository/u);
    }
    expect(() => decodeRepositoryRegistration(
      JSON.stringify(valid),
      'test registration',
      '/users/alice/projects/other'
    )).toThrow(/canonical repository/u);
    expect(() => decodeRepositoryRegistration('{')).toThrow(/Invalid JSON/u);
  });
});
