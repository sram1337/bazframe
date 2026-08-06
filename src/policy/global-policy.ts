import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';

const MAX_GLOBAL_POLICY_BYTES = 1024;

export interface DisabledGlobalPolicy {
  schemaVersion: 1;
  disabled: true;
}

export type GlobalPolicy = 'enabled' | 'disabled';
export type GlobalPolicyAction = 'current' | 'enabled' | 'disabled';

export function globalPolicyPath(bazframeHome: string): string {
  return join(bazframeHome, 'global.json');
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

export async function readGlobalPolicy(bazframeHome: string): Promise<GlobalPolicy> {
  const path = globalPolicyPath(bazframeHome);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'enabled';
    throw globalPolicyReadError(path, error);
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size > MAX_GLOBAL_POLICY_BYTES
  ) {
    throw new BazframeError(
      'GLOBAL_POLICY_INVALID',
      `Global policy must be a physical file no larger than ${MAX_GLOBAL_POLICY_BYTES} bytes: ${path}`
    );
  }
  try {
    decodeDisabledGlobalPolicy(await readFile(path, 'utf8'), path);
    return 'disabled';
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    throw globalPolicyReadError(path, error);
  }
}

export async function disableGlobally(bazframeHome: string): Promise<GlobalPolicyAction> {
  const path = globalPolicyPath(bazframeHome);
  return withStateLock(
    join(bazframeHome, 'locks', 'state.lock'),
    { command: 'bazframe global disable', target: path },
    async () => {
      if (await readGlobalPolicy(bazframeHome) === 'disabled') return 'current';
      await writeFileAtomic(path, encodeDisabledGlobalPolicy(), { managedRoot: bazframeHome });
      return 'disabled';
    },
    { managedRoot: bazframeHome }
  );
}

export async function enableGlobally(bazframeHome: string): Promise<GlobalPolicyAction> {
  const path = globalPolicyPath(bazframeHome);
  return withStateLock(
    join(bazframeHome, 'locks', 'state.lock'),
    { command: 'bazframe global enable', target: path },
    async () => {
      if (await readGlobalPolicy(bazframeHome) === 'enabled') return 'current';
      try {
        await rm(path);
      } catch (error) {
        throw new BazframeError(
          'GLOBAL_POLICY_REMOVE_FAILED',
          `Could not remove global policy ${path}${formatErrorCode(error)}`,
          { cause: error }
        );
      }
      return 'enabled';
    },
    { managedRoot: bazframeHome }
  );
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
