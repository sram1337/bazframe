import { join } from 'node:path';
import { readUtf8InstructionFile } from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import type { InstructionSource } from '../harness/compose-instructions.js';

export async function loadRootRepositoryInstructions(
  repositoryRoot: string
): Promise<InstructionSource | undefined> {
  const path = join(repositoryRoot, 'AGENTS.md');
  try {
    return {
      path,
      text: await readUtf8InstructionFile(path, 'Repository instructions')
    };
  } catch (error) {
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
