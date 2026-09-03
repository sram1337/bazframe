import { describe, expect, it } from 'vitest';
import { mergeProfileLifecycleMutationEffects, noProfileLifecycleMutationEffects } from '../../../src/profile-publishing/profile-lifecycle-effects.js';

describe('profile lifecycle mutation effects', () => {
  it('starts fully false and merges only observed effects', () => {
    const none = noProfileLifecycleMutationEffects();
    expect(Object.values(none).every((value) => value === false)).toBe(true);
    expect(mergeProfileLifecycleMutationEffects(
      none,
      { ...none, loginStarted: true },
      { ...none, localStateWritten: true, profilePublished: true, cacheWritten: true, lockAcquired: true, buildExecuted: true },
      { ...none, repositoryCreated: true, refUpdated: true, commitCreated: true, visibilityChanged: true }
    )).toEqual({
      localStateWritten: true,
      profilePublished: true,
      cacheWritten: true,
      lockAcquired: true,
      buildExecuted: true,
      loginStarted: true,
      repositoryCreated: true,
      refUpdated: true,
      commitCreated: true,
      visibilityChanged: true
    });
  });
});
