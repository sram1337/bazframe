import { BazframeError } from '../core/errors.js';

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const MAX_SKILL_ID_LENGTH = 64;

export function isSafeSkillId(value: string): boolean {
  return value.length >= 1
    && value.length <= MAX_SKILL_ID_LENGTH
    && SKILL_ID.test(value);
}

export function assertSafeSkillId(value: string): void {
  if (!isSafeSkillId(value)) {
    throw new BazframeError(
      'INVALID_SKILL_ID',
      `Invalid skill ID ${JSON.stringify(value)}. Skill IDs must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`
    );
  }
}
