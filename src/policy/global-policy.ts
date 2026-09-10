import { BazframeError, errorCode } from '../core/errors.js';
import { posixPolicyServices, policyText, type PolicyServices } from './policy-services.js';

const MAX_GLOBAL_POLICY_BYTES = 1024;

export interface DisabledGlobalPolicy {
  schemaVersion: 1;
  disabled: true;
}

export type GlobalPolicy = 'enabled' | 'disabled';
export type GlobalPolicyAction = 'current' | 'enabled' | 'disabled';

export function globalPolicyPath(bazframeHome: string, paths = posixPolicyServices.paths): string {
  return paths.join(bazframeHome, 'global.json');
}

export function decodeDisabledGlobalPolicy(
  text: string,
  source = 'global policy'
): DisabledGlobalPolicy {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new BazframeError('GLOBAL_POLICY_INVALID', `Invalid JSON in ${source}.`, {
      cause: error
    });
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 2
  ) {
    throw invalidGlobalPolicy(source);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || candidate.disabled !== true) {
    throw invalidGlobalPolicy(source);
  }
  return { schemaVersion: 1, disabled: true };
}

export function encodeDisabledGlobalPolicy(): string {
  return `${JSON.stringify({ schemaVersion: 1, disabled: true }, null, 2)}\n`;
}

export async function readGlobalPolicy(bazframeHome: string, services: PolicyServices = posixPolicyServices): Promise<GlobalPolicy> {
  const path = globalPolicyPath(bazframeHome, services.paths);
  try {
    const text = policyText(await services.snapshot(path, MAX_GLOBAL_POLICY_BYTES));
    if (text === undefined) return 'enabled';
    decodeDisabledGlobalPolicy(text, path);
    return 'disabled';
  } catch (error) {
    if (errorCode(error) === 'POLICY_FILE_INVALID') throw new BazframeError('GLOBAL_POLICY_INVALID', `Global policy must be a physical file no larger than ${MAX_GLOBAL_POLICY_BYTES} bytes: ${path}`, { cause: error });
    if (error instanceof BazframeError) throw error;
    throw globalPolicyReadError(path, error);
  }
}

export async function disableGlobally(bazframeHome: string, services: PolicyServices = posixPolicyServices): Promise<GlobalPolicyAction> {
  const path = globalPolicyPath(bazframeHome, services.paths);
  return services.withLock(bazframeHome, 'bazframe global disable', async (writer) => {
    const expected = await services.snapshot(path, MAX_GLOBAL_POLICY_BYTES);
    if (await readGlobalPolicy(bazframeHome, services) === 'disabled') return 'current';
    await writer.publish(path, Buffer.from(encodeDisabledGlobalPolicy()), expected, MAX_GLOBAL_POLICY_BYTES);
    return 'disabled';
  });
}

export async function enableGlobally(bazframeHome: string, services: PolicyServices = posixPolicyServices): Promise<GlobalPolicyAction> {
  const path = globalPolicyPath(bazframeHome, services.paths);
  return services.withLock(bazframeHome, 'bazframe global enable', async (writer) => {
    const expected = await services.snapshot(path, MAX_GLOBAL_POLICY_BYTES);
    if (await readGlobalPolicy(bazframeHome, services) === 'enabled') return 'current';
    try { await writer.detach(path, expected, MAX_GLOBAL_POLICY_BYTES); }
    catch (error) { throw new BazframeError('GLOBAL_POLICY_REMOVE_FAILED', `Could not remove global policy ${path}${formatErrorCode(error)}`, { cause: error }); }
    return 'enabled';
  });
}

function invalidGlobalPolicy(source: string): BazframeError {
  return new BazframeError(
    'GLOBAL_POLICY_INVALID',
    `${source} must be an exact schema-v1 disabled global policy.`
  );
}

function globalPolicyReadError(path: string, error: unknown): BazframeError {
  return new BazframeError(
    'GLOBAL_POLICY_READ_FAILED',
    `Could not read global policy ${path}${formatErrorCode(error)}`,
    { cause: error }
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
