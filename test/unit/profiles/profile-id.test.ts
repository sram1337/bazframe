import { describe, expect, it } from 'vitest';
import { isSafeProfileId } from '../../../src/profiles/profile-id.js';

describe('profile IDs', () => {
  it.each(['focused', 'reviewer-2', '0', 'a'.repeat(64)])('accepts %s', (value) => {
    expect(isSafeProfileId(value)).toBe(true);
  });

  it.each([
    '', '.', '..', '../focused', 'a/b', 'a\\b', '/absolute', 'Focused',
    '-focused', 'focused-', 'two--hyphens', 'with space', 'a'.repeat(65), 'nul\0id'
  ])('rejects unsafe or noncanonical ID %j', (value) => {
    expect(isSafeProfileId(value)).toBe(false);
  });
});
