import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildResult } from '../core/child-process.js';
import {
  launchExternalEditor,
  type InheritedChildRunner
} from '../core/external-editor.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { assertSafeProfileId } from './profile-id.js';

export type { InheritedChildRunner } from '../core/external-editor.js';

export interface ProfileInstructionEditorOptions {
  bazframeHome: string;
  profileId: string;
  environment: NodeJS.ProcessEnv;
  childRunner?: InheritedChildRunner;
}

export interface ProfileInstructionEditorTarget {
  profileDirectory: string;
  instructionsPath: string;
}

export async function editProfileInstructions(
  options: ProfileInstructionEditorOptions
): Promise<ChildResult> {
  const target = await resolveProfileInstructionEditorTarget(
    options.bazframeHome,
    options.profileId
  );
  return launchExternalEditor({
    target: { path: target.instructionsPath, cwd: target.profileDirectory },
    environment: options.environment,
    ...(options.childRunner === undefined ? {} : { childRunner: options.childRunner })
  });
}

export async function resolveProfileInstructionEditorTarget(
  bazframeHome: string,
  profileId: string
): Promise<ProfileInstructionEditorTarget> {
  assertSafeProfileId(profileId);
  const profilesRoot = join(bazframeHome, 'profiles');
  const profileDirectory = join(profilesRoot, profileId);
  const instructionsPath = join(profileDirectory, 'AGENTS.md');

  await assertPhysicalDirectory(
    profilesRoot,
    'PROFILE_ROOT_INVALID',
    `Profiles root must be a physical directory: ${profilesRoot}`
  );
  await assertPhysicalDirectory(
    profileDirectory,
    'PROFILE_NOT_DIRECTORY',
    `Profile ${JSON.stringify(profileId)} must be a physical directory: ${profileDirectory}`
  );

  let instructionsMetadata;
  try {
    instructionsMetadata = await stat(instructionsPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new BazframeError(
        'PROFILE_INSTRUCTIONS_NOT_FOUND',
        `Profile ${JSON.stringify(profileId)} instructions do not exist: ${instructionsPath}`
      );
    }
    throw new BazframeError(
      'PROFILE_INSTRUCTIONS_READ_FAILED',
      `Could not inspect profile ${JSON.stringify(profileId)} instructions: ${instructionsPath}`,
      { cause: error }
    );
  }
  if (!instructionsMetadata.isFile()) {
    throw new BazframeError(
      'PROFILE_INSTRUCTIONS_NOT_FILE',
      `Profile ${JSON.stringify(profileId)} instructions must resolve to a regular file: ${instructionsPath}`
    );
  }

  return { profileDirectory, instructionsPath };
}

async function assertPhysicalDirectory(
  path: string,
  code: string,
  message: string
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new BazframeError(code, message, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError(code, message);
  }
}
