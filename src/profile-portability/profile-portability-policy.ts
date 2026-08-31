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
  const policy = { ...PRODUCTION_MANAGED_GIT_ACQUISITION_LIMIT_POLICY, ...lowerLimits };
  for (const key of Object.keys(lowerLimits)) {
    if (!(key in PRODUCTION_MANAGED_GIT_ACQUISITION_LIMIT_POLICY)) throw invalidPolicy(`${key} is unknown`);
  }
  for (const key of Object.keys(PRODUCTION_MANAGED_GIT_ACQUISITION_LIMIT_POLICY) as Array<keyof ManagedGitAcquisitionLimitPolicy>) {
    const value = policy[key];
    if (!Number.isSafeInteger(value) || value < 0) throw invalidPolicy(`${key} must be a finite nonnegative integer`);
    if (value > PRODUCTION_MANAGED_GIT_ACQUISITION_LIMIT_POLICY[key]) throw invalidPolicy(`${key} may lower but must not raise the production limit`);
  }
  return Object.freeze(policy);
}

export const PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY: Readonly<ProfileArtifactLimitPolicy> = Object.freeze({
  maxManifestBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.artifactManifestBytes,
  maxProfileEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileEntries,
  maxResources: PROFILE_PORTABILITY_PRODUCTION_LIMITS.resources
});

export function profileArtifactLimitPolicy(
  lowerLimits: Partial<ProfileArtifactLimitPolicy> = {}
): Readonly<ProfileArtifactLimitPolicy> {
  const policy = {
    ...PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY,
    ...lowerLimits
  };
  for (const key of Object.keys(lowerLimits)) {
    if (!(key in PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY)) throw invalidPolicy(`${key} is unknown`);
  }
  for (const key of Object.keys(PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY) as Array<keyof ProfileArtifactLimitPolicy>) {
    const value = policy[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidPolicy(`${key} must be a finite nonnegative integer`);
    }
    if (value > PRODUCTION_PROFILE_ARTIFACT_LIMIT_POLICY[key]) {
      throw invalidPolicy(`${key} may lower but must not raise the production limit`);
    }
  }
  return Object.freeze(policy);
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

function invalidPolicy(detail: string): BazframeError {
  return new BazframeError(
    'PROFILE_PORTABILITY_POLICY_INVALID',
    `Invalid profile portability limit policy: ${detail}.`
  );
}
