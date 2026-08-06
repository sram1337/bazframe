import type { GlobalPolicy } from './global-policy.js';
import type { RepositoryProjectState } from '../project/registration.js';

export type EffectivePolicyReason =
  | 'project-enabled-override'
  | 'project-disabled-override'
  | 'global-enabled'
  | 'global-disabled';

export interface EffectivePolicy {
  enabled: boolean;
  reason: EffectivePolicyReason;
}

export function resolveEffectivePolicy(
  globalPolicy: GlobalPolicy,
  projectState: RepositoryProjectState | undefined
): EffectivePolicy {
  if (projectState?.schemaVersion === 3) {
    return { enabled: true, reason: 'project-enabled-override' };
  }
  if (projectState?.schemaVersion === 2) {
    return { enabled: false, reason: 'project-disabled-override' };
  }
  return globalPolicy === 'enabled'
    ? { enabled: true, reason: 'global-enabled' }
    : { enabled: false, reason: 'global-disabled' };
}
