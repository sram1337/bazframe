import { BazframeError } from '../core/errors.js';

export const PROFILE_PORTABILITY_PRODUCTION_LIMITS = Object.freeze({
  artifactManifestBytes: 1024 * 1024,
  profileEntries: 1024,
  resources: 256,
  profileNamespaceEntries: 1024,
  packageManifestBytes: 64 * 1024,
  packageArgvEntries: 64,
  packageArgumentBytes: 4 * 1024,
  packageArgvAggregateBytes: 16 * 1024,
  packagePathBytes: 4096,
  gitMetadataMilliseconds: 30 * 1000,
  gitCloneFetchMilliseconds: 10 * 60 * 1000,
  packageBuildMilliseconds: 30 * 60 * 1000,
  processTerminationGraceMilliseconds: 5 * 1000,
  gitObjectBytes: 1024 * 1024 * 1024,
  checkoutEntries: 8192,
  checkoutDepth: 32,
  checkoutPathBytes: 4096,
  checkoutFileBytes: 64 * 1024 * 1024,
  checkoutAggregateBytes: 512 * 1024 * 1024,
  stagingEntries: 32_768,
  stagingDepth: 64,
  stagingPathBytes: 8192,
  stagingBytes: 1536 * 1024 * 1024,
  gitStreamBytes: 1024 * 1024,
  diagnosticBytes: 1024,
  diagnosticReportBytes: 1024 * 1024,
  provenanceBytes: 16 * 1024
});

export interface ProfileArtifactLimitPolicy {
  maxManifestBytes: number;
  maxProfileEntries: number;
  maxResources: number;
}

export interface PackageLimitPolicy {
  maxManifestBytes: number;
  maxArgvEntries: number;
  maxArgumentBytes: number;
  maxArgvAggregateBytes: number;
  maxPathBytes: number;
  maxBuildMilliseconds: number;
  terminationGraceMilliseconds: number;
}

export interface ManagedGitAcquisitionLimitPolicy {
  maxGitObjectBytes: number;
  maxCheckoutEntries: number;
  maxCheckoutDepth: number;
  maxCheckoutPathBytes: number;
  maxCheckoutFileBytes: number;
  maxCheckoutAggregateBytes: number;
  maxStagingEntries: number;
  maxStagingDepth: number;
  maxStagingPathBytes: number;
  maxStagingBytes: number;
}

export const PRODUCTION_PACKAGE_LIMIT_POLICY: Readonly<PackageLimitPolicy> = Object.freeze({
  maxManifestBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.packageManifestBytes,
  maxArgvEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.packageArgvEntries,
  maxArgumentBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.packageArgumentBytes,
  maxArgvAggregateBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.packageArgvAggregateBytes,
  maxPathBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.packagePathBytes,
  maxBuildMilliseconds: PROFILE_PORTABILITY_PRODUCTION_LIMITS.packageBuildMilliseconds,
  terminationGraceMilliseconds: PROFILE_PORTABILITY_PRODUCTION_LIMITS.processTerminationGraceMilliseconds
});

export function packageLimitPolicy(
  lowerLimits: Partial<PackageLimitPolicy> = {}
): Readonly<PackageLimitPolicy> {
  return lowerOnlyPolicy(PRODUCTION_PACKAGE_LIMIT_POLICY, lowerLimits);
}

export const PRODUCTION_MANAGED_GIT_ACQUISITION_LIMIT_POLICY: Readonly<ManagedGitAcquisitionLimitPolicy> = Object.freeze({
  maxGitObjectBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitObjectBytes,
  maxCheckoutEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutEntries,
  maxCheckoutDepth: PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutDepth,
  maxCheckoutPathBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutPathBytes,
  maxCheckoutFileBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutFileBytes,
  maxCheckoutAggregateBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutAggregateBytes,
  maxStagingEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries,
  maxStagingDepth: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingDepth,
  maxStagingPathBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingPathBytes,
  maxStagingBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingBytes
});

export function managedGitAcquisitionLimitPolicy(
  lowerLimits: Partial<ManagedGitAcquisitionLimitPolicy> = {}
): Readonly<ManagedGitAcquisitionLimitPolicy> {
  return lowerOnlyPolicy(PRODUCTION_MANAGED_GIT_ACQUISITION_LIMIT_POLICY, lowerLimits);
}

export const PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY: Readonly<ProfileArtifactLimitPolicy> = Object.freeze({
  maxManifestBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.artifactManifestBytes,
  maxProfileEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileEntries,
  maxResources: PROFILE_PORTABILITY_PRODUCTION_LIMITS.resources
});

export function profileArtifactLimitPolicy(
  lowerLimits: Partial<ProfileArtifactLimitPolicy> = {}
): Readonly<ProfileArtifactLimitPolicy> {
  return lowerOnlyPolicy(PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY, lowerLimits);
}

export function boundedStateJsonBytes(maximum = PROFILE_PORTABILITY_PRODUCTION_LIMITS.artifactManifestBytes): number {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw invalidPolicy('state JSON byte limit must be a finite nonnegative integer');
  }
  if (maximum > PROFILE_PORTABILITY_PRODUCTION_LIMITS.artifactManifestBytes) {
    throw invalidPolicy('state JSON byte limit may lower but must not raise the production limit');
  }
  return maximum;
}

function lowerOnlyPolicy<T extends object>(
  production: Readonly<T>,
  lowerLimits: Partial<T>
): Readonly<T> {
  const policy = { ...production, ...lowerLimits };
  for (const key of Object.keys(lowerLimits)) {
    if (!(key in production)) throw invalidPolicy(`${key} is unknown`);
  }
  for (const key of Object.keys(production) as Array<keyof T>) {
    const value = policy[key];
    const productionValue = production[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw invalidPolicy(`${String(key)} must be a finite nonnegative integer`);
    }
    if (Number(value) > Number(productionValue)) {
      throw invalidPolicy(`${String(key)} may lower but must not raise the production limit`);
    }
  }
  return Object.freeze(policy);
}

function invalidPolicy(detail: string): BazframeError {
  return new BazframeError(
    'PROFILE_PORTABILITY_POLICY_INVALID',
    `Invalid profile portability limit policy: ${detail}.`
  );
}
