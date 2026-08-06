# Bazframe 2 Product Design

> Status: current product source of truth

Bazframe composes Agent Skills-compatible capabilities into profiles, then applies profiles to coding agents. A profile carries personal instructions and direct skill memberships across working directories. Runtime adapters resolve an available Git-worktree project override, then global policy, then the file-free enabled default.

## Product direction

The first production slice integrates Bazframe with Pi through a global Pi extension. Profile selection and exceptional per-project overrides live under the user's Bazframe home, while each repository keeps its own instructions and agent resources.

The resulting flow is:

```bash
npm install --global bazframe
bazframe adapter install pi
bazframe profile use focused
cd my-project
pi
```

`bazframe adapter install pi` is a one-time, explicit setup step. It copies Bazframe's packaged extension into Pi's global extension directory and records ownership metadata so Bazframe can update, repair, or safely uninstall only that artifact. Pi then discovers the extension automatically.

The user continues to invoke Pi directly. Absent global state means enabled in both Git and non-Git directories. In canonical Git worktrees, explicit project policy overrides global policy; non-Git directories have no per-directory override in this slice and inherit global policy.

## TUI direction

Bazframe's first interactive management UI is a keyboard-first terminal UI with no sidebar, launched explicitly as `bazframe tui`. Its top navigation contains `Profiles`, `Skills`, and `Settings`. The implemented management slice provides guarded profile lifecycle actions, a two-pane selected-profile direct-membership editor, a read-only Skillbook source browser, and structured read-only setup status with corrective actions. It calls typed application services rather than spawning CLI subprocesses, and explicit profile targeting never silently changes the active selection.

[`tui-design.md`](tui-design.md) records the implemented boundary, interaction model, safety requirements, tests, and remaining review gates. Runtime `ink@7.1.1` and `react@19.2.8` are exact pins and load lazily only after CLI dispatch to `bazframe tui`. Deterministic tests cover compact/resize/exit/accessibility behavior; a real macOS pseudo-terminal smoke covers alternate-screen entry/restoration; and the packed-package gate includes an interactive smoke when `script` is available. This does not make the TUI production-ready. The implemented shell keeps active top-tab state separate from a keyboard-focused top-tab cursor and body/pane focus, and reducer-owned per-view viewport offsets preserve stable-row visibility across navigation, refresh, routing, tab changes, and resize. Canonical source identity and broken-root behavior for symlinked roots, editor launch, settings writes, additional real sources, provider move/rename, and Linux/Windows Terminal/SSH/tmux/manual assistive-technology validation remain open.

## Core objects

### Skill

A skill is an Agent Skills-compatible directory supplied through a configured skill root. Bazframe consumes this standard filesystem interface without depending on Skillbook, Git, npm, or any other particular acquisition and versioning provider.

### Skill packs

Skill packs are deferred. Bazframe will not introduce pack behavior unless a later product decision expands its responsibility beyond direct profile composition.

### Profile

A profile combines personal instructions and direct skill memberships. Bazframe manages profile definitions, membership, selection, and application to supported coding agents.

The implemented first slice stores a profile as a user-owned directory:

```text
profiles/<id>/
├── AGENTS.md
└── skills/
    └── <skill>/SKILL.md
```

The profile-local `AGENTS.md` contains personal coding-agent instructions. Each materialized skill is an Agent Skills-compatible directory, including any supporting files used by its `SKILL.md`.

The first slice has one global active profile selected by `bazframe profile use <profile>`; `bazframe use <profile>` remains a compatibility alias. `profile add` creates a physical profile directory containing a zero-byte physical `AGENTS.md` and an empty physical `skills/` directory without activating it. `profile list` prints valid physical profile IDs and `profile current` prints only the selected ID for scripts. Bare `bazframe profile` and `bazframe profiles` instead render the human profile overview: valid profiles in lexical order, an explicit active marker, current-selection state, and the available profile commands.

`profile duplicate <source> <new>` copies all content from a physical source profile without resolving children or provider targets, preserves symlinks verbatim, refuses profile-root symlinks and occupied destinations, leaves the active selection unchanged, and publishes the new profile only after a complete staged copy. `profile rename <old> <new>` preserves profile content without resolving its children or provider targets, refuses symlink roots and replacement, and updates the active selection when renaming the active profile. `profile remove <id>` always refuses the active profile, even when its directory is missing. Without `--force`, removal accepts only the exact generated-empty shape; `--force` is explicit authorization to recursively delete a non-active physical profile. Recursive deletion unlinks membership symlinks without following or mutating Skillbook targets. Actual profile creation, duplication, removal, and identity-changing rename clear disposable alias cache for affected new or existing IDs; idempotent add and same-ID rename preserve live cache. Lifecycle mutations use the global state lock before any profile-specific lock and apply to Pi on the next startup or `/reload`.

Direct membership is managed canonically with `bazframe profile skills add <skill> [--profile <profile>]` and `bazframe profile skills remove <skill> [--profile <profile>]`. Omission targets the active profile; an explicit target changes that profile without changing or requiring the active selection. Top-level `add` and `remove` remain active-profile-only compatibility aliases. Bare `bazframe profile skills` lists immediate skill entries discovered in the active profile and shows membership commands; Pi remains authoritative for full runtime validation. Packs are outside the current scope.

### Project defaults and overrides

Absent `~/.bazframe/global.json` means globally enabled. `bazframe global disable` writes an exact schema-v1 `{ disabled: true }` policy; `global enable` validates the adapter and active profile before removing it. Global disable is a recovery path and requires neither adapter nor profile.

Git-worktree project policy takes precedence. No project record means inherit global. Exact schema-v1 records from the earlier opt-in design are redundant inherit records, schema-v2 records are disabled overrides, and schema-v3 records are enabled overrides. `bazframe project enable` or `disable` remains Git-only and writes an override only when behavior differs from global policy; matching behavior removes valid current state and inherits. Non-Git directories inherit global policy without project state. Malformed, mismatched, symlinked, or unsupported state fails visibly and is preserved. Canonical local path remains project-state identity.

### Pi adapter

The Pi adapter is a Bazframe-owned global extension installed in Pi's configured agent directory. At startup and on reload it resolves global policy in every directory, then any current Git worktree override, then the active profile when effective-enabled.

### Effective harness

The effective harness is the adapter-resolved session view. For Pi it combines:

- Pi's runtime, tools, settings, trust decision, and native resources;
- the context files selected by the chosen Pi invocation;
- the active Bazframe profile instructions;
- native and profile skills, with deterministic aliases for collisions.

Bazframe resolves this view at startup and reload from live sources.

### Relationships and invariants

```text
ActiveSelection  -> ProfileId
ProfileId        -> Profile(instructions, skills)
GlobalPolicy     -> enabled | disabled
CanonicalGitRoot -> OptionalOverride(enabled | disabled)
OptionalOverride
  > GlobalPolicy
  + ActiveSelection
  + Profile
  + RuntimeState -> EffectiveHarness
```

- A profile ID identifies one live profile directory within a Bazframe home.
- The active selection contains one valid profile ID.
- An absent global record means enabled in every working directory; an exact disabled record changes the global policy.
- A non-Git directory inherits global policy without a project override.
- An absent Git-worktree project record and compatible schema-v1 record inherit global policy.
- A canonical Git root maps to at most one enabled/disabled override or legacy inherit record.
- Git-worktree project override wins over global policy; effective disable bypasses profile loading.
- The effective harness is resolved data; its sources retain their user, Bazframe, repository, or runtime ownership.
- Adapter-specific projection, such as a Pi skill alias, belongs to the effective harness cache rather than the source profile.

This model makes the profile the portable stored object and the effective harness the runtime composition of that profile with project-over-global policy.

## Pi context behavior

The adapter supports two explicit Pi invocations:

| Invocation | Effective instruction context |
|---|---|
| `pi` | Pi's native global, ancestor, and project context, followed by the active profile |
| `pi -nc` | the global Pi context restored by Bazframe, followed by the active profile |

Pi reports its context files through `systemPromptOptions.contextFiles`. The adapter uses the collection's empty/non-empty state:

```text
contextFiles present -> append profile
contextFiles empty   -> restore global Pi context, then append profile
```

This structured signal gives the adapter one bounded rule for both invocations. Detailed semantics are recorded in [`pi-adaptive-context-adapter.md`](pi-adaptive-context-adapter.md).

## Skills

For the first production slice, Bazframe discovers profile membership from the profile directory, validates skill resources through Pi's Agent Skills loader, exposes them to the runtime, projects collision aliases, and reports diagnostics.

Skillbook owns skill acquisition, copying into its library, versioning, updating, publication, and deletion. Bazframe owns only profile membership. The approved first membership slice resolves Skillbook's library from `SKILLBOOK_LIBRARY`, then the deprecated `SKILLBOOK_LOCK_LIBRARY`, then `~/.skillbook`.

`bazframe skills` and its singular alias `bazframe skill` list valid, directly addable skills in the resolved Skillbook library. The overview identifies the resolved source, uses lexical order, reports invalid neighbors as warnings, and does not include Pi-native or profile-only skills.

`bazframe profile skills add <skill> [--profile <profile>]` adds the named Skillbook skill to the active or explicitly targeted profile as an absolute directory symlink under `profiles/<id>/skills/`. `bazframe profile skills remove <skill> [--profile <profile>]` removes only that verified membership symlink. Both commands are idempotent and must preserve Skillbook's skill directory and lockfile. Bazframe refuses physical entries, foreign or mismatched symlinks, replacement, copy fallback, and unsafe names. The Skillbook directory ID must match the skill's declared Agent Skills name. Membership-time parsing validates only that identity; Pi's Agent Skills loader remains authoritative for the complete schema when the skill enters a session. A missing add target compares its safe ID with valid available skills and offers bounded edit-distance suggestions before pointing to `bazframe skills`.

Existing physical profile skill directories remain readable for compatibility but are not managed by these commands. Packs, manifests, export, and Windows link fallback are outside this slice.

Profile skills enter Pi through `resources_discover`.

A profile skill keeps its name when that name is available. When Pi has already loaded a native skill with the same name, Bazframe projects an Agent Skills-compatible alias under its external cache:

```text
<name>-x-bazframe
```

The alias points to the original skill file and base directory. Diagnostics report every alias. A second collision on the generated alias is a visible profile error.

## Ownership

| Owner | Resources |
|---|---|
| User | profile content and instructions, configured skill roots, and source-provider choices; explicit `profile remove --force` authorizes Bazframe to delete the named non-active physical profile content |
| Skillbook | skill acquisition, library copies, versioning, updating, publication, deletion, lockfile, and Agent Skills-compatible source directories |
| Bazframe | profile lifecycle operations, direct profile membership links, profile selection and resolution, active-profile state, global policy, project overrides, adapter manifest, installed adapter artifact, and generated alias cache |
| Repository | worktree files and project instructions |
| Pi | settings, trust decisions, tools, models, extensions, packages, prompts, themes, system-prompt files, and native skills |

This ownership model lets Bazframe manage composition and apply personal profiles while preserving provider independence, native project behavior, and repository history.

## Commands

The canonical first production command surface is resource-oriented:

```text
bazframe profile | profiles
bazframe profile add <profile>
bazframe profile duplicate <source> <new>
bazframe profile remove <profile> [--force]
bazframe profile rename <old> <new>
bazframe profile use <profile>
bazframe profile list
bazframe profile current
bazframe profile skills
bazframe profile skills add <skill> [--profile <profile>]
bazframe profile skills remove <skill> [--profile <profile>]

bazframe tui
bazframe skill | skills
bazframe global
bazframe global enable
bazframe global disable
bazframe project | projects
bazframe project enable
bazframe project disable
bazframe adapter | adapters
bazframe adapter install pi [--force]
bazframe adapter uninstall pi
bazframe status
```

Bare singular and plural resources produce human overviews. Scoped verbs mutate the named resource. Concise `profile list` and `profile current` outputs remain available for scripts. Top-level `use`, `add`, and `remove` remain compatibility aliases. Old `init`/`uninit` forms fail with migration guidance to `project enable`/`disable`, while `bazframe pi` remains only as the documented deprecated launcher. Root help stays intentionally small and points to `bazframe help <resource>` or `<resource> --help` for the detailed grammar.

CLI color is presentation-only: it is enabled automatically for terminal streams, disabled for pipes and redirects, disabled when `NO_COLOR` is present, and explicitly enabled by nonzero `FORCE_COLOR` only when `NO_COLOR` is absent. Headings, active/current state, warnings, errors, and command hints retain text and symbols that remain understandable without color.

Adapter installation is explicit and orthogonal to global/project policy. Global and project disable operations require neither adapter nor profile. Global enable validates runtime setup before removing disabled state. Project enable validates runtime setup because it makes the current worktree effective-enabled, including when it overrides global disable. Profile skill add/remove mutate only direct membership in the active profile.

For adapter installation, `--force` repairs a drifted artifact only when a valid Bazframe ownership manifest identifies the destination. For `profile remove`, `--force` separately authorizes deletion of all content under the named non-active physical profile; it never extends authority to symlink targets.

Inside Pi, the adapter registers exactly one namespaced command: `/bazframe info` or `/bazframe reload`. `/bazframe reload` awaits Pi's reload operation, which reloads extensions, policy, profiles, skills, and context. Bare, unknown, or extra arguments show `Usage: /bazframe info | /bazframe reload` without reloading.

`/bazframe info` is intentionally compact. It reports only the effective profile (or `(none)`), effective context entries labeled `(pi)` or `(bazframe)` by supplier, effective Pi skill-command names as one deduplicated lexical comma-separated list (or `(none)`), and a deterministic comma-separated `original -> alias` collision line only when collisions exist. Pi context retains `contextFiles` order. With an active error-free profile, Bazframe appends the profile instructions entry; when Pi reports no context it first reports the restored global context when present. Error, disabled, and unresolved states do not report an effective profile or Bazframe context.

## Safety and diagnostics

Bazframe-managed writes use validated external paths, per-resource locks, mode-restricted temporary files, and atomic filesystem operations. Selection validation and all lifecycle mutations occur under the global state lock; membership takes that lock before its profile-specific lock. Duplication copies to a unique sibling staging directory without following symlinks, cleans failed staging, and publishes with a final rename. Active rename coordinates a directory rename with atomic selection replacement and rolls the directory back when selection replacement fails before commit. Adapter install and uninstall compare artifact hashes against the ownership manifest. Exceptional project overrides are external; acceptance tests preserve the worktree snapshot and Git status. Locks coordinate Bazframe writers, but a non-cooperating external process can race profile check/create/duplicate/rename/remove pathnames or the final membership unlink; portable Node filesystem APIs do not provide every conditional pathname operation needed to exclude such writers.

A default-enabled session applies a complete valid profile or reports an actionable error in both Git and non-Git directories. An effective-disabled session retains native Pi behavior.

`bazframe status` reads and reports adapter ownership, drift, current project state and effective behavior, active-profile validity when required, skill counts, collision aliases, and corrective commands.

## Research agenda

Product work now focuses on:

- completing the TUI's remaining source-tree/viewport interaction work after the separate top-tab focus model;
- settling canonical identity and broken-root semantics for symlinked skill sources;
- keeping editor launch, settings writes, additional real sources, and provider-owned move/rename behind their explicit ownership and lifecycle decisions;
- validating Linux, Windows Terminal, SSH, tmux, and manual assistive-technology behavior before any production-ready TUI claim;
- preserving the implemented direct-membership and provider-ownership boundary;
- semantic composition between personal and repository-recommended profiles;
- instruction and skill conflict policy across multiple runtimes.

Skill packs, profile export, and Bazframe-owned skill artifact lifecycle remain deferred.

## Implementation plan

[`pi-adapter-production-design.md`](pi-adapter-production-design.md) records the implemented production baseline, lifecycle rules, milestones, and acceptance evidence. Executable Pi 0.82 evidence is retained in the [`pi-no-launcher-adapter` experiment](../experiments/pi-no-launcher-adapter/REPORT.md).
