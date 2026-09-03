import { BazframeError } from '../core/errors.js';
import { projectProfileStateV1Extension, type JsonProfileStateV1OptionalExtension } from './profile-command-presentation.js';
import type { ProfileDomainView, ProfileSystemView } from './profile-view.js';

export interface SharedProfileApplicationProjection {
  name: string;
  active: boolean;
  publicationVersionState: ProfileDomainView['publicationVersionState'];
  extension: JsonProfileStateV1OptionalExtension;
  activationWarning: string | null;
}

/** One pure projection source for profile-list, status, TUI, and activation. */
export function projectProfileApplications(
  view: ProfileSystemView,
  activeProfileName: string | null
): SharedProfileApplicationProjection[] {
  if (activeProfileName !== null && !view.profiles.some((profile) => profile.name === activeProfileName)) {
    throw new BazframeError('PROFILE_VIEW_INVALID', 'Invalid managed profile view: active profile is absent from the profile system view.');
  }
  return view.profiles.map((profile) => ({
    name: profile.name,
    active: profile.name === activeProfileName,
    publicationVersionState: profile.publicationVersionState,
    extension: projectProfileStateV1Extension(profile),
    activationWarning: activationWarning(profile)
  }));
}

export function projectProfileListApplications(
  view: ProfileSystemView,
  activeProfileName: string | null
): SharedProfileApplicationProjection[] {
  return clone(projectProfileApplications(view, activeProfileName));
}

export function projectStatusProfileApplication(
  view: ProfileSystemView,
  activeProfileName: string
): SharedProfileApplicationProjection {
  return required(projectProfileApplications(view, activeProfileName), activeProfileName);
}

export function projectTuiProfileApplications(
  view: ProfileSystemView,
  activeProfileName: string | null
): SharedProfileApplicationProjection[] {
  return clone(projectProfileApplications(view, activeProfileName));
}

export function projectActivationProfileApplication(
  view: ProfileSystemView,
  profileName: string,
  activeProfileName: string | null
): SharedProfileApplicationProjection {
  return structuredClone(required(projectProfileApplications(view, activeProfileName), profileName));
}

function activationWarning(profile: ProfileDomainView): string | null {
  if (!profile.incomplete) return null;
  const missing = profile.missingResources
    .map((resource) => `${resource.key.kind} ${resource.key.name} (${resource.diagnosticCode})`)
    .join(', ');
  return `Profile ${JSON.stringify(profile.name)} is incomplete; missing resources: ${missing}. Activation is allowed; run \`bazframe profile update --profile ${profile.name}\` to retry.`;
}

function required(
  profiles: readonly SharedProfileApplicationProjection[],
  name: string
): SharedProfileApplicationProjection {
  const result = profiles.find((profile) => profile.name === name);
  if (result === undefined) throw new BazframeError('PROFILE_NOT_FOUND', `Profile not found: ${name}`);
  return result;
}

function clone(values: readonly SharedProfileApplicationProjection[]): SharedProfileApplicationProjection[] {
  return values.map((value) => structuredClone(value));
}
