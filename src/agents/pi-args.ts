import { BazframeError } from '../core/errors.js';

const FORBIDDEN_EXACT = new Set([
  '-c',
  '-r',
  '--continue',
  '--resume',
  '--session',
  '--session-id',
  '--fork'
]);
const FORBIDDEN_LONG = [
  '--continue',
  '--resume',
  '--session',
  '--session-id',
  '--fork'
] as const;

export function assertSafeForwardedPiArgs(args: readonly string[]): void {
  for (const [index, argument] of args.entries()) {
    if (
      FORBIDDEN_EXACT.has(argument)
      || FORBIDDEN_LONG.some((option) => argument.startsWith(`${option}=`))
    ) {
      throw new BazframeError(
        'UNSAFE_PI_SESSION_OPTION',
        `Forwarded Pi option ${JSON.stringify(argument)} is not supported. Bazframe composed this harness for the caller's current repository, so session-switching options (--continue/-c, --resume/-r, --session, --session-id, and --fork) are rejected.`
      );
    }
    if (
      argument === '--mode=rpc'
      || (argument === '--mode' && args[index + 1] === 'rpc')
    ) {
      throw new BazframeError(
        'UNSAFE_PI_RPC_MODE',
        'Forwarded Pi RPC mode is not supported. RPC can switch sessions without recomposing Bazframe instructions for the new repository.'
      );
    }
  }
}

export function buildPiArgs(
  effectiveInstructionsPath: string,
  skillDirectories: readonly string[],
  forwardedArgs: readonly string[]
): string[] {
  const args = [
    '--no-context-files',
    '--append-system-prompt',
    effectiveInstructionsPath
  ];
  for (const skillDirectory of skillDirectories) {
    args.push('--skill', skillDirectory);
  }
  args.push(...forwardedArgs);
  return args;
}
