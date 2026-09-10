import type { ApplicationServices } from '../application/application-services.js';
import { join } from 'node:path';
import { readUtf8InstructionFile } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import type { InstructionSource } from '../harness/compose-instructions.js';

export async function loadRootRepositoryInstructions(
  repositoryRoot: string,
  application?: ApplicationServices
): Promise<InstructionSource | undefined> {
  const path = (application?.paths.join ?? join)(repositoryRoot, 'AGENTS.md');
  try {
    return {
      path,
      text: await (application?.reads?.instructions ?? readUtf8InstructionFile)(path, 'Repository instructions')
    };
  } catch (error) {
    if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return undefined;
    if (
      error instanceof BazframeError
      && error.code === 'INSTRUCTION_READ_FAILED'
      && errorCode(error.cause) === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
}
