import { BazframeError } from '../core/errors.js';

const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const MAX_PROFILE_ID_LENGTH = 64;

export function isSafeProfileId(value: string): boolean {
  return value.length >= 1
    && value.length <= MAX_PROFILE_ID_LENGTH
    && PROFILE_ID.test(value);
}

export function assertSafeProfileId(value: string): void {
  if (!isSafeProfileId(value)) {
    throw new BazframeError(
      'INVALID_PROFILE_ID',
      `Invalid profile ID ${JSON.stringify(value)}. Prototype profile IDs must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`
    );
  }
}
