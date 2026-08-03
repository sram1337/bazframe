export const VERSION = '0.0.0-prototype.0';

export const ROOT_HELP = [
  'Bazframe 2 (experimental prototype)',
  '',
  'Usage:',
  '  bazframe use <profile>',
  '  bazframe pi [--dry-run] [-- <pi args>]',
  '  bazframe --help',
  '  bazframe --version',
  '',
  'Commands:',
  '  use <profile>  Atomically select a pre-existing profile',
  '  pi             Compose the active profile with root AGENTS.md and launch Pi',
  '',
  'Pi forwarding:',
  '  Put Pi arguments after --. The delimiter itself is not forwarded.',
  '  Session-switching options and RPC mode are rejected because the harness is repository-specific.',
  ''
].join('\n');

export const USE_HELP = [
  'Usage: bazframe use <profile>',
  '',
  'Select BAZFRAME_HOME/profiles/<profile> as the active experimental profile.',
  'The profile must contain instructions.md.',
  ''
].join('\n');

export const PI_HELP = [
  'Usage: bazframe pi [--dry-run] [-- <pi args>]',
  '',
  'Launch Pi in the exact caller cwd with an effective harness composed for its Git worktree.',
  '--dry-run prints all sources, skills, effective instructions, and conceptual argv.',
  'For a real launch Bazframe diagnostics use stderr so Pi owns stdout.',
  ''
].join('\n');
