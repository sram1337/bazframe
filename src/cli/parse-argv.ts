import { assertSafeForwardedPiArgs } from '../agents/pi-args.js';
import { BazframeError } from '../core/errors.js';
import { isSafeProfileId } from '../profiles/profile-id.js';

export type HelpTopic = 'root' | 'use' | 'pi' | 'adapter' | 'init' | 'status';
export type Command =
  | { name: 'use'; profileId: string }
  | { name: 'pi'; dryRun: boolean; forwardedArgs: string[] }
  | { name: 'adapter-install-pi'; force: boolean }
  | { name: 'adapter-uninstall-pi' }
  | { name: 'init' }
  | { name: 'uninit' }
  | { name: 'status' };
export type ParseResult =
  | { kind: 'help'; topic: HelpTopic }
  | { kind: 'version' }
  | { kind: 'command'; command: Command }
  | { kind: 'usage-error'; message: string };

const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '--version']);

export function parseArgv(argv: readonly string[]): ParseResult {
  if (argv.length === 0) return { kind: 'help', topic: 'root' };

  const [first, ...rest] = argv;
  if (HELP_FLAGS.has(first)) {
    return rest.length === 0
      ? { kind: 'help', topic: 'root' }
      : usageError('Help flags do not accept additional arguments.');
  }
  if (VERSION_FLAGS.has(first)) {
    return rest.length === 0
      ? { kind: 'version' }
      : usageError('Version flags do not accept additional arguments.');
  }
  if (first === 'use') return parseUse(rest);
  if (first === 'pi') return parsePi(rest);
  if (first === 'adapter') return parseAdapter(rest);
  if (first === 'init') return parseNoArgumentCommand('init', rest);
  if (first === 'uninit') return parseNoArgumentCommand('uninit', rest);
  if (first === 'status') return parseNoArgumentCommand('status', rest);
  return usageError(`Unknown command: ${first}`);
}

function parseUse(args: readonly string[]): ParseResult {
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'use' };
  }
  if (args.length !== 1) {
    return usageError('use requires exactly one <profile> argument.');
  }
  const profileId = args[0];
  if (!isSafeProfileId(profileId)) {
    return usageError(
      'Profile IDs must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.'
    );
  }
  return { kind: 'command', command: { name: 'use', profileId } };
}

function parsePi(args: readonly string[]): ParseResult {
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'pi' };
  }

  let index = 0;
  let dryRun = false;
  if (args[index] === '--dry-run') {
    dryRun = true;
    index += 1;
  }

  let forwardedArgs: string[] = [];
  if (index < args.length) {
    if (args[index] !== '--') {
      return usageError('pi accepts only --dry-run before the optional -- Pi-argument delimiter.');
    }
    forwardedArgs = args.slice(index + 1);
  }

  try {
    assertSafeForwardedPiArgs(forwardedArgs);
  } catch (error) {
    if (error instanceof BazframeError) return usageError(error.message);
    throw error;
  }
  return {
    kind: 'command',
    command: { name: 'pi', dryRun, forwardedArgs }
  };
}

function parseNoArgumentCommand(
  name: 'init' | 'uninit' | 'status',
  args: readonly string[]
): ParseResult {
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: name === 'status' ? 'status' : 'init' };
  }
  return args.length === 0
    ? { kind: 'command', command: { name } }
    : usageError(`${name} accepts no arguments.`);
}

function parseAdapter(args: readonly string[]): ParseResult {
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'adapter' };
  }
  if (args[0] === 'install' && args[1] === 'pi') {
    if (args.length === 2) {
      return { kind: 'command', command: { name: 'adapter-install-pi', force: false } };
    }
    if (args.length === 3 && args[2] === '--force') {
      return { kind: 'command', command: { name: 'adapter-install-pi', force: true } };
    }
    return usageError('adapter install pi accepts only the optional --force flag.');
  }
  if (args[0] === 'uninstall' && args[1] === 'pi') {
    return args.length === 2
      ? { kind: 'command', command: { name: 'adapter-uninstall-pi' } }
      : usageError('adapter uninstall pi accepts no additional arguments.');
  }
  return usageError('adapter requires `install pi [--force]` or `uninstall pi`.');
}

function usageError(message: string): ParseResult {
  return { kind: 'usage-error', message };
}
