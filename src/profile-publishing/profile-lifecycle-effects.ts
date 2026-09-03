export interface ProfileLifecycleMutationEffects {
  localStateWritten: boolean;
  profilePublished: boolean;
  cacheWritten: boolean;
  lockAcquired: boolean;
  buildExecuted: boolean;
  loginStarted: boolean;
  repositoryCreated: boolean;
  refUpdated: boolean;
  commitCreated: boolean;
  visibilityChanged: boolean;
}

export function noProfileLifecycleMutationEffects(): ProfileLifecycleMutationEffects {
  return {
    localStateWritten: false,
    profilePublished: false,
    cacheWritten: false,
    lockAcquired: false,
    buildExecuted: false,
    loginStarted: false,
    repositoryCreated: false,
    refUpdated: false,
    commitCreated: false,
    visibilityChanged: false
  };
}

export function mergeProfileLifecycleMutationEffects(
  ...values: readonly Readonly<ProfileLifecycleMutationEffects>[]
): ProfileLifecycleMutationEffects {
  const result = noProfileLifecycleMutationEffects();
  for (const value of values) {
    result.localStateWritten ||= value.localStateWritten;
    result.profilePublished ||= value.profilePublished;
    result.cacheWritten ||= value.cacheWritten;
    result.lockAcquired ||= value.lockAcquired;
    result.buildExecuted ||= value.buildExecuted;
    result.loginStarted ||= value.loginStarted;
    result.repositoryCreated ||= value.repositoryCreated;
    result.refUpdated ||= value.refUpdated;
    result.commitCreated ||= value.commitCreated;
    result.visibilityChanged ||= value.visibilityChanged;
  }
  return result;
}
