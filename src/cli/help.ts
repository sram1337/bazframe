export const VERSION = '0.0.0-prototype.0';

export const ROOT_HELP = [
  'Bazframe 2',
  '',
  'Usage: bazframe <resource> [command]',
  '',
  'Resources:',
  '  profiles   Manage profiles and the active selection',
  '  sources    Manage global built skill collections',
  '  skills     Browse skills registered in the default catalog',
  '  projects   Manage per-project Bazframe policy overrides',
  '  global     Manage the global Bazframe policy',
  '  adapters   Manage coding-agent adapters',
  '  status     Check setup health and corrective actions',
  '  tui        Open the interactive management interface',
  '',
  'Suggestions:',
  '  bazframe add skill <absolute-root>',
  '  bazframe profiles',
  '  bazframe sources',
  '  bazframe skills',
  '  bazframe status',
  '  bazframe tui',
  '',
  'Learn more:',
  '  bazframe help <resource>',
  '  bazframe <resource> --help',
  '',
  'Options:',
  '  -h, --help       Show this help',
  '  -v, --version    Show the version',
  ''
].join('\n');

export const ADAPTER_HELP = [
  'Usage:',
  '  bazframe adapter',
  '  bazframe adapters',
  '  bazframe adapter install pi [--force]',
  '  bazframe adapter uninstall pi',
  '',
  'With no command, show supported adapters, current state, and available commands.',
  'Install copies Bazframe\'s extension into Pi\'s configured global agent directory.',
  '--force repairs a changed artifact covered by a valid Bazframe ownership manifest.',
  'Uninstall preserves changed or independently owned destination files.',
  ''
].join('\n');

export const GLOBAL_HELP = [
  'Usage:',
  '  bazframe global',
  '  bazframe global enable',
  '  bazframe global disable',
  '',
  'With no command, show the global policy and available commands.',
  'Enabled is the file-free default. Disable writes external global policy state.',
  'An explicit project override takes precedence over the global policy.',
  ''
].join('\n');

export const PROJECT_HELP = [
  'Usage:',
  '  bazframe project',
  '  bazframe projects',
  '  bazframe project enable',
  '  bazframe project disable',
  '',
  'With no command, list stored overrides and show the current worktree behavior.',
  'Project overrides take precedence over the global policy and live outside the repository.',
  'When the requested behavior matches the global policy, no project file is needed.',
  ''
].join('\n');

export const STATUS_HELP = [
  'Usage: bazframe status',
  '',
  'Read adapter, current project behavior, active-profile, source-reference health, derived skills, and alias-cache state.',
  'Exit status 3 means the setup needs an action listed in the report.',
  ''
].join('\n');

export const TUI_HELP = [
  'Usage: bazframe tui',
  '',
  'Open the keyboard-first profile and skill management interface.',
  'Use arrows or h/j/k/l to move; in the profile editor, J/K jumps panes.',
  'Press ? in the TUI for complete contextual keyboard help.',
  'Both standard input and standard output must be interactive terminals.',
  ''
].join('\n');

export const USE_HELP = [
  'Usage: bazframe use <profile>',
  '',
  'Compatibility alias for `bazframe profile use <profile>`.',
  ''
].join('\n');

export const PROFILE_HELP = [
  'Usage:',
  '  bazframe profile',
  '  bazframe profiles',
  '  bazframe profile skills',
  '  bazframe profile sources',
  '  bazframe profile sources add <source> [--profile <profile>]',
  '  bazframe profile sources remove <source> [--profile <profile>]',
  '  bazframe profile add <profile>',
  '  bazframe profile duplicate <source> <new>',
  '  bazframe profile remove <profile> [--force]',
  '  bazframe profile rename <old> <new>',
  '  bazframe profile use <profile>',
  '  bazframe profile list',
  '  bazframe profile current',
  '',
  'With no command, list profiles, mark the active profile, and show profile commands.',
  '`profile list` and `profile current` keep concise output for scripts.',
  ''
].join('\n');

export const PROFILE_ADD_HELP = [
  'Usage: bazframe profile add <profile>',
  '',
  'Create a physical profile with an empty AGENTS.md and empty skills directory.',
  'Creation does not change the active profile.',
  ''
].join('\n');

export const PROFILE_DUPLICATE_HELP = [
  'Usage: bazframe profile duplicate <source> <new>',
  '',
  'Copy all content from a physical source profile without following symlinks.',
  'Duplication refuses an occupied destination and does not change the active profile.',
  ''
].join('\n');

export const PROFILE_REMOVE_HELP = [
  'Usage: bazframe profile remove <profile> [--force]',
  '',
  'Remove a non-active profile. Without --force, only a generated-empty profile is removed.',
  '--force permanently removes all physical profile content but never follows skill symlink targets.',
  'The active profile cannot be removed, even with --force.',
  ''
].join('\n');

export const PROFILE_RENAME_HELP = [
  'Usage: bazframe profile rename <old> <new>',
  '',
  'Rename a physical profile without replacing an existing destination.',
  'Renaming the active profile updates the global selection.',
  ''
].join('\n');

export const PROFILE_USE_HELP = [
  'Usage: bazframe profile use <profile>',
  '',
  'Validate and atomically select an existing profile.',
  ''
].join('\n');

export const PROFILE_LIST_HELP = [
  'Usage: bazframe profile list',
  '',
  'Print valid physical profile IDs in lexical order, one per line.',
  'Use `bazframe profiles` for the human-readable overview.',
  ''
].join('\n');

export const PROFILE_CURRENT_HELP = [
  'Usage: bazframe profile current',
  '',
  'Print only the selected profile ID without performing a profile health check.',
  ''
].join('\n');

export const SKILLS_HELP = [
  'Usage:',
  '  bazframe skill',
  '  bazframe skills',
  '',
  'List valid live external skill registrations in Bazframe\'s `(default)` catalog.',
  'This does not list Pi-native skills or managed-source-derived skills.',
  'Use `bazframe profile skills` to inspect the active profile.',
  ''
].join('\n');

export const PROFILE_SKILLS_HELP = [
  'Usage:',
  '  bazframe profile skills',
  '  bazframe profile skills add <skill> [--profile <profile>]',
  '  bazframe profile skills remove <skill> [--profile <profile>]',
  '',
  'With no command, list immediate skill entries discovered in the active profile.',
  'Add and remove manage only verified memberships backed by `(default)` registrations.',
  'Use --profile to target a profile without changing the active selection.',
  ''
].join('\n');

export const PROFILE_SKILLS_ADD_HELP = [
  'Usage: bazframe profile skills add <skill> [--profile <profile>]',
  '',
  'Add a registered `(default)` skill to the active or explicitly targeted profile as a parallel absolute link to its external target.',
  'Bazframe checks skill identity; Pi validates the full Agent Skills schema at runtime.',
  'Provider content is preserved.',
  ''
].join('\n');

export const PROFILE_SKILLS_REMOVE_HELP = [
  'Usage: bazframe profile skills remove <skill> [--profile <profile>]',
  '',
  'Remove only a membership matching the current `(default)` registration.',
  'Physical and foreign profile entries and provider content are preserved.',
  ''
].join('\n');

export const SOURCES_HELP = [
  'Usage:',
  '  bazframe sources',
  '  bazframe sources add <absolute-root>',
  '  bazframe sources build <source>',
  '  bazframe sources remove <source>',
  '',
  'Manage global source objects and their activated immutable snapshots.',
  'Add and build explicitly run a declared provider build; inspection never runs builds.',
  'Remove is refused while any profile references the source.',
  ''
].join('\n');
export const SOURCES_ADD_HELP = ['Usage: bazframe sources add <absolute-root>', '', 'Derive the source name from the canonical root directory, then explicitly build, validate, snapshot, and activate it.', 'Invalid or already-registered directory names are rejected without normalization.', ''].join('\n');
export const SOURCES_BUILD_HELP = ['Usage: bazframe sources build <source>', '', 'Explicitly rebuild a global source. Activation is rejected if any referencing profile would become invalid.', ''].join('\n');
export const SOURCES_REMOVE_HELP = ['Usage: bazframe sources remove <source>', '', 'Remove only an unreferenced global source record. Source inputs and immutable snapshots are preserved.', ''].join('\n');

export const PROFILE_SOURCES_HELP = [
  'Usage:',
  '  bazframe profile sources',
  '  bazframe profile sources add <source> [--profile <profile>]',
  '  bazframe profile sources remove <source> [--profile <profile>]',
  '',
  'Inspect or change references from a profile to global sources.',
  'Reference changes never build a source or change active selection.',
  ''
].join('\n');
export const PROFILE_SOURCES_ADD_HELP = ['Usage: bazframe profile sources add <source> [--profile <profile>]', '', 'Add a validated reference to an existing global source.', ''].join('\n');
export const PROFILE_SOURCES_REMOVE_HELP = ['Usage: bazframe profile sources remove <source> [--profile <profile>]', '', 'Remove only the profile-owned reference. The global source, source input, and snapshots are preserved.', ''].join('\n');

export const ADD_HELP = [
  'Usage: bazframe add skill <absolute-root>',
  '',
  'Register one canonical external Agent Skill root in Bazframe\'s `(default)` catalog.',
  'Bazframe stores an absolute link and never copies or updates provider content.',
  ''
].join('\n');

export const REMOVE_HELP = [
  'Usage: bazframe remove skill <skill>',
  '',
  'Remove only an unreferenced `(default)` catalog registration.',
  'Profile memberships and provider content are preserved.',
  ''
].join('\n');

export const PI_HELP = [
  'Usage: bazframe pi [--dry-run] [-- <pi args>]',
  '',
  'Deprecated: install the Pi adapter, select a profile, then invoke `pi` or `pi -nc` directly.',
  'Launch Pi in the exact caller cwd with an effective harness composed for its Git worktree.',
  '--dry-run prints all sources, skills, effective instructions, and conceptual argv.',
  'For a real launch Bazframe diagnostics use stderr so Pi owns stdout.',
  ''
].join('\n');
