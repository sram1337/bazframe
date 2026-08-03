import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { readUtf8InstructionFile } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { assertSafeProfileId } from './profile-id.js';

const ACTIVE_PROFILE_FILE = 'active-profile';
const MAX_STATE_BYTES = 1024;

export interface Profile {
  id: string;
  directory: string;
  instructionsPath: string;
  instructions: string;
  skillDirectories: string[];
}

export function resolveBazframeHome(
  environment: NodeJS.ProcessEnv,
  userHome = homedir()
): string {
  const configured = environment.BAZFRAME_HOME;
  if (configured === undefined) {
    return join(userHome, '.bazframe');
  }
  if (configured.length === 0 || configured.includes('\0')) {
    throw new BazframeError(
      'INVALID_BAZFRAME_HOME',
      'BAZFRAME_HOME must be a non-empty absolute path without NUL bytes.'
    );
  }
  if (!isAbsolute(configured)) {
    throw new BazframeError(
      'INVALID_BAZFRAME_HOME',
      `BAZFRAME_HOME must be an absolute path: ${configured}`
    );
  }
  return resolve(configured);
}

export function profileDirectory(bazframeHome: string, profileId: string): string {
  assertSafeProfileId(profileId);
  return join(bazframeHome, 'profiles', profileId);
}

export async function loadProfile(
  bazframeHome: string,
  profileId: string
): Promise<Profile> {
  const directory = profileDirectory(bazframeHome, profileId);
  let metadata;
  try {
    metadata = await stat(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new BazframeError(
        'PROFILE_NOT_FOUND',
        `Profile ${JSON.stringify(profileId)} does not exist at ${directory}.`
      );
    }
    throw new BazframeError(
      'PROFILE_READ_FAILED',
      `Could not inspect profile ${JSON.stringify(profileId)} at ${directory}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (!metadata.isDirectory()) {
    throw new BazframeError(
      'PROFILE_NOT_DIRECTORY',
      `Profile ${JSON.stringify(profileId)} is not a directory: ${directory}`
    );
  }

  const instructionsPath = join(directory, 'instructions.md');
  const instructions = await readUtf8InstructionFile(
    instructionsPath,
    `Profile ${JSON.stringify(profileId)} instructions`
  );
  const skillDirectories = await discoverSkillDirectories(join(directory, 'skills'));

  return {
    id: profileId,
    directory,
    instructionsPath,
    instructions,
    skillDirectories
  };
}

export async function discoverSkillDirectories(skillsRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new BazframeError(
      'SKILLS_READ_FAILED',
      `Could not inspect profile skills directory: ${skillsRoot}${formatErrorCode(error)}`,
      { cause: error }
    );
  }

  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const candidate = join(skillsRoot, entry.name);
    let candidateMetadata;
    try {
      candidateMetadata = await stat(candidate);
    } catch (error) {
      throw new BazframeError(
        'SKILL_READ_FAILED',
        `Could not inspect profile skill candidate: ${candidate}${formatErrorCode(error)}`,
        { cause: error }
      );
    }
    if (!candidateMetadata.isDirectory()) continue;

    const skillFile = join(candidate, 'SKILL.md');
    try {
      const skillMetadata = await stat(skillFile);
      if (skillMetadata.isFile()) result.push(candidate);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new BazframeError(
          'SKILL_READ_FAILED',
          `Could not inspect profile skill definition: ${skillFile}${formatErrorCode(error)}`,
          { cause: error }
        );
      }
    }
  }
  return result;
}

export async function readActiveProfile(bazframeHome: string): Promise<string> {
  const statePath = join(bazframeHome, ACTIVE_PROFILE_FILE);
  let metadata;
  try {
    metadata = await stat(statePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new BazframeError(
        'NO_ACTIVE_PROFILE',
        'No active profile. Run `bazframe use <profile>` first.'
      );
    }
    throw stateReadError(statePath, error);
  }
  if (!metadata.isFile() || metadata.size > MAX_STATE_BYTES) {
    throw new BazframeError(
      'INVALID_ACTIVE_PROFILE_STATE',
      `Active-profile state must be a regular UTF-8 file no larger than ${MAX_STATE_BYTES} bytes: ${statePath}`
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(statePath);
  } catch (error) {
    throw stateReadError(statePath, error);
  }
  if (bytes.byteLength > MAX_STATE_BYTES) {
    throw new BazframeError(
      'INVALID_ACTIVE_PROFILE_STATE',
      `Active-profile state exceeds ${MAX_STATE_BYTES} bytes: ${statePath}`
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BazframeError(
      'INVALID_ACTIVE_PROFILE_STATE',
      `Active-profile state is not valid UTF-8: ${statePath}`,
      { cause: error }
    );
  }
  if (text.includes('\0')) {
    throw new BazframeError(
      'INVALID_ACTIVE_PROFILE_STATE',
      `Active-profile state contains a NUL byte: ${statePath}`
    );
  }

  const profileId = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
  assertSafeProfileId(profileId);
  return profileId;
}

export async function writeActiveProfile(
  bazframeHome: string,
  profileId: string
): Promise<void> {
  assertSafeProfileId(profileId);
  await mkdir(bazframeHome, { recursive: true });

  const statePath = join(bazframeHome, ACTIVE_PROFILE_FILE);
  const temporaryPath = join(
    bazframeHome,
    `.${ACTIVE_PROFILE_FILE}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, `${profileId}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, statePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new BazframeError(
      'STATE_WRITE_FAILED',
      `Could not atomically record active profile at ${statePath}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
}

function stateReadError(statePath: string, error: unknown): BazframeError {
  return new BazframeError(
    'ACTIVE_PROFILE_READ_FAILED',
    `Could not read active-profile state: ${statePath}${formatErrorCode(error)}`,
    { cause: error }
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
