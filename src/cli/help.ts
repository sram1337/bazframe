export const VERSION = '0.0.0-prototype.0';

export const ROOT_HELP = [
  'Bazframe 2',
  '',
  'Usage: bazframe <resource> [command]',
  '',
  'Resources:',
  '  profiles   Manage profiles and the active selection',
  '  libraries  Manage prepared Skill libraries',
  '  packages   Manage buildable Skill packages',
  '  skills     Browse added Skills in the default catalog',
  '  projects   Manage per-project Bazframe policy overrides',
  '  global     Manage the global Bazframe policy',
  '  adapters   Manage coding-agent adapters',
  '  status     Check setup health and corrective actions',
  '  tui        Open the interactive management interface',
  '',
  'Suggestions:',
  '  bazframe add skill <absolute-root>',
  '  bazframe profiles',
  '  bazframe libraries',
  '  bazframe packages',
  '  bazframe skills',
  '  bazframe skill edit <skill>',
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
  'Read adapter, current project behavior, active-profile, library/package reference health, effective Skills, and alias-cache state.',
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
  '  bazframe profile skills add <skill> [--profile <profile>]',
  '  bazframe profile skills remove <skill> [--profile <profile>]',
  '  bazframe profile libraries',
  '  bazframe profile libraries add <library> [--profile <profile>]',
  '  bazframe profile libraries remove <library> [--profile <profile>]',
  '  bazframe profile packages',
  '  bazframe profile packages add <package> [--profile <profile>]',
  '  bazframe profile packages remove <package> [--profile <profile>]',
  '  bazframe profile add <profile>',
  '  bazframe profile duplicate <source> <new>',
  '  bazframe profile remove <profile> [--force]',
  '  bazframe profile rename <old> <new>',
  '  bazframe profile use <profile>',
  '  bazframe profile edit <profile>',
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

export const PROFILE_EDIT_HELP = [
  'Usage: bazframe profile edit <profile>',
  '',
  'Open the named profile\'s actual AGENTS.md with the first nonblank VISUAL, then EDITOR.',
  'The configured value is one executable name or path: Bazframe does not parse flags, use a shell, or choose a fallback.',
  'Use a wrapper executable when the editor needs fixed flags such as a wait option.',
  'The editor inherits the environment and terminal, runs in the profile directory, and receives AGENTS.md as its sole argument.',
  'Bazframe waits and returns the editor process exit or signal status. Run `/bazframe reload` in an existing Pi session after editing.',
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
  '  bazframe skill edit <skill>',
  '',
  'List valid added Skills in Bazframe\'s `(default)` catalog.',
  '`skill edit` opens only an added Skill\'s live provider definition; library and package snapshots remain immutable.',
  'This does not list Pi-native Skills or Skills from libraries and packages.',
  'Use `bazframe profile skills` to inspect the active profile\'s Skills.',
  ''
].join('\n');

export const SKILL_EDIT_HELP = [
  'Usage: bazframe skill edit <skill>',
  '',
  'Open the named added Skill provider\'s actual SKILL.md with the first nonblank VISUAL, then EDITOR.',
  'The configured value is one executable name or path: Bazframe does not parse flags, use a shell, or choose a fallback.',
  'Use a wrapper executable when the editor needs fixed flags such as a wait option.',
  'The editor inherits the environment and terminal, runs in the provider directory, and receives resolved SKILL.md as its sole argument.',
  'Bazframe waits and returns the editor process exit or signal status; success does not claim that content was saved.',
  'Existing Pi sessions observe provider changes after `/bazframe reload`; for a Skill from a library or package, edit provider input and then run `bazframe libraries update <library>` or `bazframe packages build <package>`.',
  ''
].join('\n');

export const PROFILE_SKILLS_HELP = [
  'Usage:',
  '  bazframe profile skills',
  '  bazframe profile skills add <skill> [--profile <profile>]',
  '  bazframe profile skills remove <skill> [--profile <profile>]',
  '',
  'With no command, list the active profile\'s immediate Skills.',
  'Add and remove manage only verified memberships backed by added Skills in `(default)`.',
  'Use --profile to target a profile without changing the active selection.',
  ''
].join('\n');

export const PROFILE_SKILLS_ADD_HELP = [
  'Usage: bazframe profile skills add <skill> [--profile <profile>]',
  '',
  'Include an added Skill from `(default)` in the active or explicitly targeted profile as a parallel absolute link to its external target.',
  'Bazframe checks skill identity; Pi validates the full Agent Skills schema at runtime.',
  'Provider content is preserved.',
  ''
].join('\n');

export const PROFILE_SKILLS_REMOVE_HELP = [
  'Usage: bazframe profile skills remove <skill> [--profile <profile>]',
  '',
  'Remove only a profile Skill matching the current added Skill in `(default)`.',
  'Physical and foreign profile entries and provider content are preserved.',
  ''
].join('\n');

export const LIBRARIES_HELP = ['Usage:', '  bazframe libraries', '  bazframe libraries add <absolute-root>', '  bazframe libraries update <library>', '  bazframe libraries remove <library>', '', 'Manage prepared Skill libraries through immutable snapshots. Library operations never execute a build.', 'Remove is refused while any profile references the library.', ''].join('\n');
export const LIBRARIES_ADD_HELP = ['Usage: bazframe libraries add <absolute-root>', '', 'Snapshot, validate, and activate an already-prepared Skill library. A package manifest is rejected.', ''].join('\n');
export const LIBRARIES_UPDATE_HELP = ['Usage: bazframe libraries update <library>', '', 'Activate a new immutable snapshot without executing provider code.', ''].join('\n');
export const LIBRARIES_REMOVE_HELP = ['Usage: bazframe libraries remove <library>', '', 'Remove only an unreferenced library record. Provider input and snapshots are preserved.', ''].join('\n');
export const PACKAGES_HELP = ['Usage:', '  bazframe packages', '  bazframe packages add <absolute-root>', '  bazframe packages build <package>', '  bazframe packages remove <package>', '', 'Manage buildable Skill packages. Add and build explicitly execute bazframe-package.json without a shell or sandbox.', 'Inspection and profile-reference changes never build.', ''].join('\n');
export const PACKAGES_ADD_HELP = ['Usage: bazframe packages add <absolute-root>', '', 'Explicitly build, validate, snapshot, and activate a package.', ''].join('\n');
export const PACKAGES_BUILD_HELP = ['Usage: bazframe packages build <package>', '', 'Explicitly rebuild a package. Activation is rejected if any referencing profile would become invalid.', ''].join('\n');
export const PACKAGES_REMOVE_HELP = ['Usage: bazframe packages remove <package>', '', 'Remove only an unreferenced package record. Provider input and snapshots are preserved.', ''].join('\n');
export const PROFILE_LIBRARIES_HELP = ['Usage:', '  bazframe profile libraries', '  bazframe profile libraries add <library> [--profile <profile>]', '  bazframe profile libraries remove <library> [--profile <profile>]', '', 'Inspect or change whole-library profile references. Reference changes never update a library.', ''].join('\n');
export const PROFILE_LIBRARIES_ADD_HELP = ['Usage: bazframe profile libraries add <library> [--profile <profile>]', '', 'Add a validated reference to an existing library.', ''].join('\n');
export const PROFILE_LIBRARIES_REMOVE_HELP = ['Usage: bazframe profile libraries remove <library> [--profile <profile>]', '', 'Remove only the profile-owned reference.', ''].join('\n');
export const PROFILE_PACKAGES_HELP = ['Usage:', '  bazframe profile packages', '  bazframe profile packages add <package> [--profile <profile>]', '  bazframe profile packages remove <package> [--profile <profile>]', '', 'Inspect or change whole-package profile references. Reference changes never build a package.', ''].join('\n');
export const PROFILE_PACKAGES_ADD_HELP = ['Usage: bazframe profile packages add <package> [--profile <profile>]', '', 'Add a validated reference to an existing package.', ''].join('\n');
export const PROFILE_PACKAGES_REMOVE_HELP = ['Usage: bazframe profile packages remove <package> [--profile <profile>]', '', 'Remove only the profile-owned reference.', ''].join('\n');

export const ADD_HELP = [
  'Usage: bazframe add skill <absolute-root>',
  '',
  'Add one canonical external Skill root to Bazframe\'s `(default)` catalog.',
  'Bazframe stores an absolute link and never copies or updates provider content.',
  ''
].join('\n');

export const REMOVE_HELP = [
  'Usage: bazframe remove skill <skill>',
  '',
  'Remove only an added Skill that no profile includes.',
  'Profile memberships and provider content are preserved.',
  ''
].join('\n');

export const PI_HELP = [
  'Usage: bazframe pi [--dry-run] [-- <pi args>]',
  '',
  'Deprecated: install the Pi adapter, select a profile, then invoke `pi` or `pi -nc` directly.',
  'Launch Pi in the exact caller cwd with an effective harness composed for its Git worktree.',
  '--dry-run prints effective instruction inputs, Skills, and conceptual argv.',
  'For a real launch Bazframe diagnostics use stderr so Pi owns stdout.',
  ''
].join('\n');
