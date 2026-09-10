import { homedir } from 'node:os';
import path, { join } from 'node:path';
import { BazframeError } from '../core/errors.js';

export function resolveBazframeHome(
  environment: NodeJS.ProcessEnv,
  userHome = homedir(),
  paths = path
): string {
  return resolveConfiguredDirectory(
    environment.BAZFRAME_HOME,
    paths.join(userHome, '.bazframe'),
    'BAZFRAME_HOME', paths
  );
}

export function profilePublishingRoot(bazframeHome: string): string {
  return join(bazframeHome, 'profile-publishing');
}

export function profilePublishingBlobRoot(bazframeHome: string): string {
  return join(profilePublishingRoot(bazframeHome), 'blobs');
}

export function profilePublishingTreeRoot(bazframeHome: string): string {
  return join(profilePublishingRoot(bazframeHome), 'trees');
}

export function profilePublishingTransactionRoot(bazframeHome: string): string {
  return join(profilePublishingRoot(bazframeHome), 'transactions');
}

export function profilePublishingStagingRoot(bazframeHome: string): string {
  return join(profilePublishingRoot(bazframeHome), 'staging');
}

export function profilePublishingOperationLockRoot(bazframeHome: string): string {
  return join(profilePublishingRoot(bazframeHome), 'operation-locks');
}

export function resolvePiAgentDirectory(
  environment: NodeJS.ProcessEnv,
  userHome = homedir(),
  paths = path
): string {
  return resolveConfiguredDirectory(
    environment.PI_CODING_AGENT_DIR,
    paths.join(userHome, '.pi', 'agent'),
    'PI_CODING_AGENT_DIR', paths
  );
}

function resolveConfiguredDirectory(
  configured: string | undefined,
  defaultPath: string,
  variableName: string,
  paths: typeof path
): string {
  if (configured === undefined) return paths.resolve(defaultPath);
  if (configured.length === 0 || configured.includes('\0')) {
    throw new BazframeError(
      `INVALID_${variableName}`,
      `${variableName} must be a non-empty absolute path without NUL bytes.`
    );
  }
  if (!paths.isAbsolute(configured)) {
    throw new BazframeError(
      `INVALID_${variableName}`,
      `${variableName} must be an absolute path: ${configured}`
    );
  }
  return paths.resolve(configured);
}
