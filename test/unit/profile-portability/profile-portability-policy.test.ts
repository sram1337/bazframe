import { describe, expect, it } from 'vitest';
import {
  boundedStateJsonBytes,
  managedGitAcquisitionLimitPolicy,
  packageLimitPolicy,
  profileArtifactLimitPolicy,
  PROFILE_PORTABILITY_PRODUCTION_LIMITS,
  PRODUCTION_MANAGED_GIT_ACQUISITION_LIMIT_POLICY,
  PRODUCTION_PACKAGE_LIMIT_POLICY,
  PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY
} from '../../../src/profile-portability/profile-portability-policy.js';

describe('profile portability production policy', () => {
  it('exposes the exact immutable approved ceilings', () => {
    expect(PROFILE_PORTABILITY_PRODUCTION_LIMITS).toEqual({
      artifactManifestBytes: 1_048_576,
      profileEntries: 1024,
      resources: 256,
      profileNamespaceEntries: 1024,
      packageManifestBytes: 65_536,
      packageArgvEntries: 64,
      packageArgumentBytes: 4096,
      packageArgvAggregateBytes: 16_384,
      packagePathBytes: 4096,
      gitMetadataMilliseconds: 30_000,
      gitCloneFetchMilliseconds: 600_000,
      packageBuildMilliseconds: 1_800_000,
      processTerminationGraceMilliseconds: 5000,
      gitObjectBytes: 1_073_741_824,
      checkoutEntries: 8192,
      checkoutDepth: 32,
      checkoutPathBytes: 4096,
      checkoutFileBytes: 67_108_864,
      checkoutAggregateBytes: 536_870_912,
      stagingEntries: 32_768,
      stagingDepth: 64,
      stagingPathBytes: 8192,
      stagingBytes: 1_610_612_736,
      gitStreamBytes: 1_048_576,
      diagnosticBytes: 1024,
      diagnosticReportBytes: 1_048_576,
      provenanceBytes: 16_384
    });
    expect(Object.isFrozen(PROFILE_PORTABILITY_PRODUCTION_LIMITS)).toBe(true);
    expect(PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY).toEqual({
      maxManifestBytes: 1_048_576,
      maxProfileEntries: 1024,
      maxResources: 256
    });
    expect(Object.isFrozen(PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY)).toBe(true);
    expect(PRODUCTION_PACKAGE_LIMIT_POLICY).toEqual({
      maxManifestBytes: 65_536,
      maxArgvEntries: 64,
      maxArgumentBytes: 4096,
      maxArgvAggregateBytes: 16_384,
      maxPathBytes: 4096,
      maxBuildMilliseconds: 1_800_000,
      terminationGraceMilliseconds: 5000
    });
    expect(Object.isFrozen(PRODUCTION_PACKAGE_LIMIT_POLICY)).toBe(true);
    expect(PRODUCTION_MANAGED_GIT_ACQUISITION_LIMIT_POLICY).toEqual({
      maxGitObjectBytes: 1_073_741_824,
      maxCheckoutEntries: 8192,
      maxCheckoutDepth: 32,
      maxCheckoutPathBytes: 4096,
      maxCheckoutFileBytes: 67_108_864,
      maxCheckoutAggregateBytes: 536_870_912,
      maxStagingEntries: 32_768,
      maxStagingDepth: 64,
      maxStagingPathBytes: 8192,
      maxStagingBytes: 1_610_612_736
    });
    expect(Object.isFrozen(PRODUCTION_MANAGED_GIT_ACQUISITION_LIMIT_POLICY)).toBe(true);
  });

  it('allows immutable lower test policies but never raised or invalid values', () => {
    const lowered = profileArtifactLimitPolicy({ maxManifestBytes: 100, maxResources: 2 });
    expect(lowered).toEqual({ maxManifestBytes: 100, maxProfileEntries: 1024, maxResources: 2 });
    expect(Object.isFrozen(lowered)).toBe(true);
    expect(() => profileArtifactLimitPolicy({ maxResources: 257 })).toThrow(/must not raise/u);
    expect(() => profileArtifactLimitPolicy({ maxManifestBytes: -1 })).toThrow(/nonnegative/u);
    expect(boundedStateJsonBytes(128)).toBe(128);
    expect(() => boundedStateJsonBytes(1_048_577)).toThrow(/must not raise/u);

    const acquisition = managedGitAcquisitionLimitPolicy({ maxCheckoutEntries: 2, maxStagingEntries: 4, maxStagingBytes: 10 });
    expect(acquisition).toMatchObject({ maxCheckoutEntries: 2, maxStagingEntries: 4, maxStagingBytes: 10 });
    expect(Object.isFrozen(acquisition)).toBe(true);
    expect(() => managedGitAcquisitionLimitPolicy({ maxCheckoutEntries: 8193 })).toThrow(/must not raise/u);
    expect(() => managedGitAcquisitionLimitPolicy({ maxStagingEntries: 32_769 })).toThrow(/must not raise/u);
    expect(() => managedGitAcquisitionLimitPolicy({ maxCheckoutDepth: -1 })).toThrow(/nonnegative/u);
    expect(() => managedGitAcquisitionLimitPolicy({ maxCheckoutDepth: 1.5 })).toThrow(/nonnegative/u);
    expect(() => managedGitAcquisitionLimitPolicy({ unknown: 1 } as never)).toThrow(/unknown/u);

    const packagePolicy = packageLimitPolicy({
      maxManifestBytes: 100,
      maxArgvEntries: 2,
      maxArgumentBytes: 10,
      maxArgvAggregateBytes: 12,
      maxPathBytes: 20,
      maxBuildMilliseconds: 30,
      terminationGraceMilliseconds: 4
    });
    expect(packagePolicy).toEqual({
      maxManifestBytes: 100,
      maxArgvEntries: 2,
      maxArgumentBytes: 10,
      maxArgvAggregateBytes: 12,
      maxPathBytes: 20,
      maxBuildMilliseconds: 30,
      terminationGraceMilliseconds: 4
    });
    expect(Object.isFrozen(packagePolicy)).toBe(true);
    for (const raised of [
      { maxManifestBytes: 65_537 }, { maxArgvEntries: 65 }, { maxArgumentBytes: 4097 },
      { maxArgvAggregateBytes: 16_385 }, { maxPathBytes: 4097 },
      { maxBuildMilliseconds: 1_800_001 }, { terminationGraceMilliseconds: 5001 }
    ]) expect(() => packageLimitPolicy(raised)).toThrow(/must not raise/u);
    expect(() => packageLimitPolicy({ maxArgvEntries: -1 })).toThrow(/nonnegative/u);
    expect(() => packageLimitPolicy({ maxBuildMilliseconds: 1.5 })).toThrow(/nonnegative/u);
    expect(() => packageLimitPolicy({ unknown: 1 } as never)).toThrow(/unknown/u);
  });
});
