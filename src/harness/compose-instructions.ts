import { Buffer } from 'node:buffer';
import { MAX_EFFECTIVE_INSTRUCTION_BYTES } from '../core/content.js';
import { BazframeError } from '../core/errors.js';

export interface InstructionSource {
  path: string;
  text: string;
}

export interface ComposeInstructionsInput {
  profileId: string;
  profile: InstructionSource;
  repository?: InstructionSource;
}

export function composeInstructions(
  input: ComposeInstructionsInput,
  maxBytes = MAX_EFFECTIVE_INSTRUCTION_BYTES
): string {
  const sections = [
    section(
      `# Bazframe profile instructions: ${input.profileId}`,
      input.profile
    )
  ];
  if (input.repository !== undefined) {
    sections.push(section('# Bazframe repository instructions', input.repository));
  }

  const effective = sections.join('\n\n');
  const byteLength = Buffer.byteLength(effective, 'utf8');
  if (byteLength > maxBytes) {
    throw new BazframeError(
      'EFFECTIVE_INSTRUCTIONS_TOO_LARGE',
      `Composed instructions are ${byteLength} bytes, exceeding the prototype ${maxBytes}-byte limit.`
    );
  }
  return effective;
}

function section(heading: string, source: InstructionSource): string {
  return `${heading}\nSource: ${source.path}\n\n${source.text}`;
}
