import { describe, expect, it } from 'vitest';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../../../src/profile-portability/profile-portability-policy.js';
import {
  capturedProfileLimitPolicy,
  PRODUCTION_CAPTURED_PROFILE_LIMIT_POLICY
} from '../../../src/profile-publishing/profile-publishing-policy.js';

describe('captured profile limit policy', () => {
  it('maps only existing production authorities', () => {
    expect(PRODUCTION_CAPTURED_PROFILE_LIMIT_POLICY).toEqual({
      maxManifestBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.artifactManifestBytes,
      maxProfileEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileEntries,
      maxResources: PROFILE_PORTABILITY_PRODUCTION_LIMITS.resources,
      maxEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries,
      maxDepth: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingDepth,
      maxPathBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingPathBytes,
      maxBlobBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutFileBytes,
      maxAggregateBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingBytes
    });
  });

  it('permits lower-only overrides and rejects unknown, raised, and invalid values', () => {
    expect(capturedProfileLimitPolicy({ maxResources: 2 }).maxResources).toBe(2);
    expect(() => capturedProfileLimitPolicy({ maxResources: PRODUCTION_CAPTURED_PROFILE_LIMIT_POLICY.maxResources + 1 })).toThrow(/may lower/u);
    expect(() => capturedProfileLimitPolicy({ maxResources: -0 })).toThrow(/nonnegative/u);
    expect(() => capturedProfileLimitPolicy({ maxResources: Number.MAX_SAFE_INTEGER })).toThrow(/may lower/u);
    expect(() => capturedProfileLimitPolicy({ unknown: 1 } as never)).toThrow(/unknown/u);
    expect(() => capturedProfileLimitPolicy(Object.assign(Object.create({}), { maxResources: 1 }))).toThrow(/plain data object/u);
    const accessor = {} as Partial<typeof PRODUCTION_CAPTURED_PROFILE_LIMIT_POLICY>;
    Object.defineProperty(accessor, 'maxResources', { enumerable: true, get: () => 1 });
    expect(() => capturedProfileLimitPolicy(accessor)).toThrow(/plain data object/u);
  });
});
