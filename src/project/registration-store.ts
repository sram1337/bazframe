import { BazframeError, errorCode } from '../core/errors.js';
import { readGlobalPolicy, type GlobalPolicy } from '../policy/global-policy.js';
import { posixPolicyServices, policyText, type PolicyServices } from '../policy/policy-services.js';
import {
  createDisabledRepositoryOverride,
  createEnabledRepositoryOverride,
  decodeRepositoryRegistration,
  encodeRepositoryRegistration,
  repositoryRegistrationPath,
  type RepositoryProjectState
} from './registration.js';

const MAX_REGISTRATION_BYTES = 64 * 1024;

export type RepositoryPolicyAction =
  | 'current'
  | 'inherited'
  | 'override-added'
  | 'override-removed';

export interface RepositoryPolicyResult {
  action: RepositoryPolicyAction;
  globalPolicy: GlobalPolicy;
}

export interface RepositoryProjectStateList {
  projectStates: RepositoryProjectState[];
  diagnostics: string[];
}

export async function readRepositoryProjectState(
  bazframeHome: string,
  canonicalRepository: string,
  services: PolicyServices = posixPolicyServices
): Promise<RepositoryProjectState | undefined> {
  const path = repositoryRegistrationPath(bazframeHome, canonicalRepository, services.paths);
  try {
    const text = policyText(await services.snapshot(path, MAX_REGISTRATION_BYTES));
    return text === undefined ? undefined : decodeRepositoryRegistration(text, path, canonicalRepository, services.paths);
  } catch (error) {
    if (errorCode(error) === 'POLICY_FILE_INVALID') throw new BazframeError('REGISTRATION_INVALID', `Repository state must be a bounded physical file: ${path}`, { cause: error });
    if (error instanceof BazframeError) throw error;
    throw projectStateReadError(path, error);
  }
}

export async function listRepositoryProjectStates(bazframeHome: string, services: PolicyServices = posixPolicyServices): Promise<RepositoryProjectStateList> {
  const projectsRoot = services.paths.join(bazframeHome, 'projects');
  const projectStates: RepositoryProjectState[] = [], diagnostics: string[] = [];
  for (const name of await services.entries(projectsRoot)) {
    if (services.retained(name)) continue;
    const path = services.paths.join(projectsRoot, name);
    try {
      const text = policyText(await services.snapshot(path, MAX_REGISTRATION_BYTES));
      if (text === undefined) throw new BazframeError('REGISTRATION_INVALID', `Project state disappeared: ${path}`);
      const state = decodeRepositoryRegistration(text, path, undefined, services.paths);
      if (repositoryRegistrationPath(bazframeHome, state.repository, services.paths) !== path) throw new BazframeError('REGISTRATION_INVALID', `Repository project-state filename does not match its canonical repository: ${path}`);
      projectStates.push(state);
    } catch (error) { diagnostics.push(`Skipping invalid repository project state ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  projectStates.sort((a, b) => a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0);
  return { projectStates, diagnostics };
}

export async function enableRepository(
  bazframeHome: string,
  canonicalRepository: string,
  services: PolicyServices = posixPolicyServices
): Promise<RepositoryPolicyResult> {
  return setRepositoryPolicy(bazframeHome, canonicalRepository, true, services);
}

export async function disableRepository(
  bazframeHome: string,
  canonicalRepository: string,
  services: PolicyServices = posixPolicyServices
): Promise<RepositoryPolicyResult> {
  return setRepositoryPolicy(bazframeHome, canonicalRepository, false, services);
}

async function setRepositoryPolicy(
  bazframeHome: string,
  canonicalRepository: string,
  enabled: boolean,
  services: PolicyServices
): Promise<RepositoryPolicyResult> {
  const path = repositoryRegistrationPath(bazframeHome, canonicalRepository, services.paths);
  const command = `bazframe project ${enabled ? 'enable' : 'disable'}`;
  return services.withLock(bazframeHome, command, async (writer) => {
      const expected = await services.snapshot(path, MAX_REGISTRATION_BYTES);
      const globalPolicy = await readGlobalPolicy(bazframeHome, services);
      const existing = await readRepositoryProjectState(bazframeHome, canonicalRepository, services);
      const inheritsRequestedPolicy = (globalPolicy === 'enabled') === enabled;
      if (inheritsRequestedPolicy) {
        if (existing === undefined) return { action: 'inherited', globalPolicy };
        await writer.detach(path, expected, MAX_REGISTRATION_BYTES);
        return { action: 'override-removed', globalPolicy };
      }

      const requestedSchema = enabled ? 3 : 2;
      if (existing?.schemaVersion === requestedSchema) {
        return { action: 'current', globalPolicy };
      }
      const override = enabled
        ? createEnabledRepositoryOverride(canonicalRepository, services.paths)
        : createDisabledRepositoryOverride(canonicalRepository, services.paths);
      await writer.publish(path, Buffer.from(encodeRepositoryRegistration(override, services.paths)), expected, MAX_REGISTRATION_BYTES);
      return { action: 'override-added', globalPolicy };
    });
}

function projectStateReadError(path: string, error: unknown): BazframeError {
  return new BazframeError(
    'REGISTRATION_READ_FAILED',
    `Could not read repository project state ${path}${formatErrorCode(error)}`,
    { cause: error }
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
