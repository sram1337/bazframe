import { describe, expect, it } from 'vitest';
import { assertSafeSkillId, isSafeSkillId } from '../../../src/skills/skill-id.js';

describe('skill IDs', () => {
  it('accepts Agent Skills-compatible IDs and length boundaries', () => {
    expect(isSafeSkillId('a')).toBe(true);
    expect(isSafeSkillId('review-skill-2')).toBe(true);
    expect(isSafeSkillId('a'.repeat(64))).toBe(true);
    expect(() => assertSafeSkillId('review-skill')).not.toThrow();
  });

  it.each([
    '', '.', '..', 'Review', 'review_skill', 'review skill', '-review', 'review-',
    'review--skill', 'review/skill', 'review\\skill', 'a'.repeat(65), 'review\0skill'
  ])('rejects unsafe ID %j', (value) => {
    expect(isSafeSkillId(value)).toBe(false);
    expect(() => assertSafeSkillId(value)).toThrow(/skill ID/u);
  });
});
