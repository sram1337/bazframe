export const VERSION = '0.0.0-prototype.0';

export const ROOT_HELP = [
  'Bazframe 2 (experimental prototype)',
  '',
  'Usage:',
  '  bazframe adapter install pi [--force]',
  '  bazframe adapter uninstall pi',
  '  bazframe init',
  '  bazframe uninit',
  '  bazframe status',
  '  bazframe use <profile>',
  '  bazframe pi [--dry-run] [-- <pi args>]',
  '  bazframe --help',
  '  bazframe --version',
  '',
  'Commands:',
  '  adapter        Install, update, repair, or uninstall a Bazframe-owned Pi extension',
  '  init           Register the current Git worktree externally',
  '  uninit         Remove the current Git worktree registration',
  '  status         Inspect adapter, registration, and active-profile state',
  '  use <profile>  Atomically select a pre-existing profile',
  '  pi             Run the deprecated launcher prototype',
  '',
  'Pi forwarding:',
  '  Put Pi arguments after --. The delimiter itself is not forwarded.',
  '  Session-switching options and RPC mode are rejected because the harness is repository-specific.',
  ''
].join('\n');

export const ADAPTER_HELP = [
  'Usage:',
  '  bazframe adapter install pi [--force]',
  '  bazframe adapter uninstall pi',
  '',
  'Install the Bazframe extension in Pi\'s configured global agent directory.',
  '--force repairs a changed artifact covered by a valid Bazframe ownership manifest.',
  'Uninstall preserves changed or independently owned destination files.',
  ''
].join('\n');

export const INIT_HELP = [
  'Usage:',
  '  bazframe init',
  '  bazframe uninit',
  '',
  'Register or unregister the canonical current Git worktree in BAZFRAME_HOME.',
  'Registration follows the global active profile and preserves the worktree.',
  ''
].join('\n');

export const STATUS_HELP = [
  'Usage: bazframe status',
  '',
  'Read adapter, repository-registration, active-profile, and alias-cache state.',
  'Exit status 3 means the setup needs an action listed in the report.',
  ''
].join('\n');

export const USE_HELP = [
  'Usage: bazframe use <profile>',
  '',
  'Select BAZFRAME_HOME/profiles/<profile> as the active experimental profile.',
  'The profile must contain AGENTS.md.',
  ''
].join('\n');

export const PI_HELP = [
  'Usage: bazframe pi [--dry-run] [-- <pi args>]',
  '',
  'Deprecated: use `bazframe init`, then invoke `pi` or `pi -nc` directly.',
  'Launch Pi in the exact caller cwd with an effective harness composed for its Git worktree.',
  '--dry-run prints all sources, skills, effective instructions, and conceptual argv.',
  'For a real launch Bazframe diagnostics use stderr so Pi owns stdout.',
  ''
].join('\n');
