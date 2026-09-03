import { BazframeError } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';

export interface CapturedProfileLimitPolicy {
  maxManifestBytes: number;
  maxProfileEntries: number;
  maxResources: number;
  maxEntries: number;
  maxDepth: number;
  maxPathBytes: number;
  maxBlobBytes: number;
  maxAggregateBytes: number;
}

export const PRODUCTION_CAPTURED_PROFILE_LIMIT_POLICY: Readonly<CapturedProfileLimitPolicy> = Object.freeze({
  maxManifestBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.artifactManifestBytes,
  maxProfileEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileEntries,
  maxResources: PROFILE_PORTABILITY_PRODUCTION_LIMITS.resources,
  maxEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries,
  maxDepth: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingDepth,
  maxPathBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingPathBytes,
  maxBlobBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutFileBytes,
  maxAggregateBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingBytes
});

export function capturedProfileLimitPolicy(
  lowerLimits: Partial<CapturedProfileLimitPolicy> = {}
): Readonly<CapturedProfileLimitPolicy> {
  if (!isPlainDataRecord(lowerLimits)) throw invalid('policy must be a plain data object');
  const policy = { ...PRODUCTION_CAPTURED_PROFILE_LIMIT_POLICY, ...lowerLimits };
  for (const key of Object.keys(lowerLimits)) {
    if (!(key in PRODUCTION_CAPTURED_PROFILE_LIMIT_POLICY)) throw invalid(`${key} is unknown`);
  }
  for (const key of Object.keys(PRODUCTION_CAPTURED_PROFILE_LIMIT_POLICY) as Array<keyof CapturedProfileLimitPolicy>) {
    const value = policy[key];
    const maximum = PRODUCTION_CAPTURED_PROFILE_LIMIT_POLICY[key];
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw invalid(`${key} must be a finite nonnegative integer`);
    if (value > maximum) throw invalid(`${key} may lower but must not raise the production limit`);
  }
  return Object.freeze(policy);
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) return false; const keys = Reflect.ownKeys(value); return keys.every((key) => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value') && Object.getOwnPropertyDescriptor(value, key)!.enumerable === true); }

function invalid(detail: string): BazframeError {
  return new BazframeError('PROFILE_PUBLISHING_POLICY_INVALID', `Invalid profile publishing limit policy: ${detail}.`);
}
