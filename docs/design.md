# Bazframe 2 Product Design

> Status: current product source of truth

Bazframe composes Agent Skills-compatible capabilities into profiles, then applies profiles to coding agents. A profile carries personal instructions, flat direct skill memberships, and optional provider-neutral source-unit memberships across working directories. Runtime adapters resolve an available Git-worktree project override, then global policy, then the file-free enabled default.

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

[`tui-design.md`](tui-design.md) records the implemented boundary, interaction model, safety requirements, tests, and remaining review gates. Runtime `ink@7.1.1` and `react@19.2.8` are exact pins and load lazily only after CLI dispatch to `bazframe tui`. Deterministic tests cover compact/resize/exit/accessibility behavior; a real macOS pseudo-terminal smoke covers alternate-screen entry/restoration; and the packed-package gate includes an interactive smoke when `script` is available. This does not make the TUI production-ready. The implemented shell keeps active top-tab state separate from a keyboard-focused top-tab cursor and body/pane focus, and reducer-owned per-view viewport offsets preserve stable-row visibility across navigation, refresh, routing, tab changes, and resize. Source-unit identity and broken-root removal are settled for the CLI-only descriptor slice; TUI source-unit browsing/mutation remains unimplemented. Editor launch, settings writes, additional real sources, provider move/rename, and Linux/Windows Terminal/SSH/tmux/manual assistive-technology validation remain open.

## Core objects

### Skill

A skill is an Agent Skills-compatible directory supplied through a configured skill root. Bazframe consumes this standard filesystem interface without depending on Skillbook, Git, npm, or any other particular acquisition and versioning provider.

### Skill packs

Skill packs are deferred. Bazframe will not introduce pack behavior unless a later product decision expands its responsibility beyond direct profile composition.

### Profile

A profile combines personal instructions, flat direct skill memberships, and zero or more direct source-unit memberships. Bazframe manages profile definitions, membership, selection, and application to supported coding agents.

The profile layout is:

```text
profiles/<id>/
├── AGENTS.md
├── skills/
│   └── <skill>/SKILL.md
└── source-units/                         # optional; absence means zero memberships
    └── <providerId>/
        └── <sourceId>.json
```

The profile-local `AGENTS.md` contains personal coding-agent instructions. Each materialized flat skill is an Agent Skills-compatible directory, including any supporting files used by its `SKILL.md`. Source-unit descriptors select provider-owned physical roots; their effective child skills are always derived live and are never persisted or copied.

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
- native skills, flat direct profile skills, and source-unit-derived profile skills, with deterministic aliases for native/profile collisions.

Bazframe resolves this view at startup and reload from live sources.

### Relationships and invariants

```text
ActiveSelection  -> ProfileId
ProfileId        -> Profile(instructions, flat skills, source units)
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

## Provider-neutral source-unit composition

This is the approved next production slice. [Stage 1 and Stage 2](research/provider-neutral-nested-source-unit-composition.md) demonstrated the bounded composition mechanics, but a provider plus a small wrapper could reproduce them, so the experiments did not demonstrate that Bazframe was the exclusive necessary owner. The user nevertheless deliberately values Bazframe's existing profile selection, runtime integration, collision handling, and diagnostics, and has approved the narrow composition seam here. That decision adds profile membership, read-only derivation, and runtime projection; it does not transfer provider lifecycle or execution ownership to Bazframe.

### Direct membership and persistence

A profile may have zero or many direct source-unit memberships in the namespace `profiles/<profile>/source-units/`, which is intentionally distinct from flat `profiles/<profile>/skills/`. Existing profiles need no migration: an absent `source-units/` directory means zero source-unit memberships, and all flat Skillbook behavior remains unchanged.

Each membership is one Bazframe-owned JSON descriptor at:

```text
profiles/<profile>/source-units/<providerId>/<sourceId>.json
```

Schema version 1 has exactly these fields:

```json
{
  "schemaVersion": 1,
  "providerId": "provider-id",
  "sourceId": "source-id",
  "sourceRoot": "/canonical/absolute/provider-owned/root"
}
```

`providerId` and `sourceId` each use the existing safe ID form: 1–64 lowercase ASCII letters or digits separated by single hyphens. The descriptor IDs must match its path components. `sourceRoot` is the physical directory obtained by canonicalizing the user-supplied absolute root at add time. Relative roots, non-directories, and roots that cannot be resolved to one canonical absolute directory are refused. At runtime, the stored path must still be a physical directory whose canonical path equals the stored value; a missing path or symlink retarget fails the source, while provider byte changes at that same physical path are allowed. The descriptor is a direct membership, not a source snapshot or installation record.

There is no global source registry in this slice. A registry would add a second identity and lifecycle surface that must be synchronized with profile membership without being needed for the approved outcome. Repeating a descriptor in another profile is sufficient, keeps selection profile-local, and leaves acquisition and source lifecycle with the provider.

The only canonical commands are:

```text
bazframe profile sources
bazframe profile sources add <provider> <source> <absolute-root> [--profile <profile>]
bazframe profile sources remove <provider> <source> [--profile <profile>]
```

The overview lists the active profile's descriptors in lexical `providerId`, then `sourceId` order and distinguishes their direct membership from derived children. Add and remove follow the existing explicit-profile rule: omission requires and targets the active profile, while `--profile` targets that physical profile without changing or requiring active selection. There are no top-level aliases and no TUI mutation for source units in this slice.

Add canonicalizes and validates the provider root before taking ownership of a new descriptor. Re-adding the same provider ID, source ID, and canonical root to an exact valid descriptor is a successful no-op. Any occupied descriptor path that is symlinked, non-regular, malformed, unsupported, has extra or mismatched fields, or names a different canonical root is preserved and refused; add never replaces or retargets it.

Remove does not resolve or require the provider root. Under the normal Bazframe locks, it opens and strictly validates the regular schema-v1 descriptor, including the provider/source IDs requested and encoded by its pathname, and removes only that same verified descriptor. It therefore works when the provider root is missing or broken while refusing malformed, symlinked, substituted, or mismatched state. It prunes only empty Bazframe-owned `source-units/<providerId>/` and `source-units/` directories and never removes provider bytes. As with other pathname-based Bazframe writes, a non-cooperating process can still race the final verified unlink.

Profile duplicate, rename, and remove treat descriptors as ordinary Bazframe-owned profile content. They copy or move descriptor bytes and delete them only within the profile, never resolve or follow `sourceRoot`. A normal generated-empty profile has no descriptors; forced profile removal may delete descriptors but never provider roots. Provider content may change in place at the same physical root and the next startup or `/bazframe reload` sees the live result. Bazframe has no source update command, update lifecycle, pin, snapshot, or reproducibility guarantee.

### Read-only discovery contract

The production resolver is read-only. Before parsing descriptor bytes or resolving any `sourceRoot`, it validates the complete descriptor namespace. `source-units` must be absent or a physical directory. Each immediate entry beneath it must be a physical directory whose basename is a safe `providerId`; each immediate entry beneath a valid provider directory must be a physical regular file named exactly `<safe-sourceId>.json`. No other namespace entry is allowed. These checks use link-aware metadata: a symlink is invalid even when its target has the required type, and an invalid provider entry is never traversed.

Namespace validation is a lexical two-pass operation over the `source-units` directory and the immediate children of physical, safe provider directories. It reports every malformed entry that can be reached without following a symlink. Every such record has exactly `{ category: "invalid-descriptor", providerId, sourceId, path }` and a namespace-relative `/`-separated `path`: `.` for the `source-units` entry itself, the exact provider basename for a provider entry, or `<provider-basename>/<child-basename>` for a child entry. The stable placeholder IDs are `<unknown-provider>` and `<unknown-source>`. `providerId` is the basename only when that basename is safe; otherwise it is `<unknown-provider>`. `sourceId` is the filename stem only when the provider ID is known and the child name is exactly `<safe-sourceId>.json`; otherwise it is `<unknown-source>`. Thus an invalid `source-units` entry uses both placeholders, an invalid provider entry always uses the source placeholder, and an unsafe child name uses the known provider ID plus the source placeholder. Bazframe does not parse any descriptors, resolve any provider root, or traverse any provider content if namespace validation emits a record. This malformed-namespace state withholds all source-unit composition for the profile while preserving valid flat skills. Once the namespace shape is valid, malformed descriptor bytes or fields emit the same exact record shape with known IDs and `path: <providerId>/<sourceId>.json`; they remain failures of only their identified source unit and do not cause provider traversal.

Portable Node does not expose `openat` or directory enumeration directly from a `FileHandle`. Bazframe therefore opens each namespace directory with no-follow/directory flags, keeps that handle open, and compares physical device/inode identity for the handle and pathname before and after pathname-based enumeration. Changed or raced identity becomes `invalid-descriptor` and withholds composition. A non-cooperating process can still replace and restore the same pathname wholly inside the irreducible pathname-based `readdir` window; excluding that race requires a native handle-relative enumeration API.

The resolver then resolves valid source descriptors in lexical `providerId`/`sourceId` order and traverses each canonical root depth-first by lexical relative path. For every discovered physical definition directory, Bazframe calls the Pi 0.82 Agent Skills loader, requires exactly one returned skill whose base directory and definition path equal that discovered child, and uses Pi's loaded name. This accepts Pi-valid YAML metadata forms and uses Pi's directory-name fallback when `name` is omitted. Every effective record preserves that Pi-loaded name, physical child base directory, and physical `SKILL.md` definition path, plus provider/source/relative-path identity for diagnostics. Bazframe never flattens a child, rewrites its metadata, asks Pi to scan a grouping root, or applies an additional YAML/frontmatter parser.

A source root containing a regular `SKILL.md` is a terminal standalone skill. It yields that root definition only; any descendant `SKILL.md` makes the source unit invalid as `mixed-root`. A root without `SKILL.md` is a grouping root and exposes every valid descendant Agent Skill. Zero valid descendants is allowed. Child subsets, manifests, and pack semantics remain deferred.

Traversal has these first-slice compatibility bounds:

- a maximum directory depth of 8 below the source root, where the root is depth 0 and files immediately inside a depth-8 directory may be inspected;
- at most 256 visited entries below the root; and
- at most 64 effective children per source unit.

These exact values were explicitly approved by the user and tested in Stage 1. They are now part of the first-slice compatibility contract, not defaults inferred from examples or agent judgment. The root itself is not an entry. After 256 counted entries, the next encountered entry fails the source; after 64 effective children, the next child fails it. A directory encountered at depth 9 fails it.

Exact-name `.git` and `node_modules` directory or symlink entries are skipped before counting, are not counted, and are never inspected or followed; this includes every symlink beneath a skipped root because traversal never enters that root. The user explicitly selected this production pruning rule in this continuation because VCS and dependency internals are not direct skill definitions. It is a product decision, not Stage 2 evidence: Stage 2 established discovery before `node_modules` preparation and did not rerun discovery afterward, so it did not measure this pruning behavior. Other encountered internal symlinks are rejected without following them. All other entries count once when encountered. Ordinary files and directories—including names such as `shared/` and `data/`—remain provider resources with no universal Bazframe semantics. Unsupported filesystem entries, canonical-containment failures, and filesystem races fail the source rather than broadening traversal.

Failures are atomic per source unit. A broken or retargeted root, malformed descendant, mixed root, internal symlink, exceeded depth/entry/child bound, duplicate profile-declared name, unexpected I/O, or Pi-loader failure withholds every derived child from that source unit. `invalid-descriptor` records use the namespace-relative paths defined above. Every other diagnostic record contains `category`, `providerId`, `sourceId`, and a source-root-relative `/`-separated `path` (`.` for the root and `SKILL.md` for a standalone definition); `limit-exceeded` also contains `limit: depth | entries | skills`. The stable categories are `invalid-descriptor`, `broken-root`, `limit-exceeded`, `internal-symlink`, `unsupported-entry`, `mixed-root`, `invalid-definition`, `duplicate-name`, `pi-loader`, and `io-error`.

Traversal failures use encounter order. For each lexical entry, exact skipped internal names are handled first; otherwise the entry is counted, then depth, symlink, filesystem type, and definition checks occur in that order. Root validation precedes descendants; finding a descendant definition under a root definition yields `mixed-root` without projecting the root. Profile-wide duplicate analysis occurs only after structural and Pi-loader validation of all candidate sources, so it can mark every source involved rather than whichever one happened to be visited later. Reported diagnostics sort by provider ID, source ID, path, and category. Multiple `pi-loader` records with the same keys then sort by `diagnosticIndex` and `message`. Other valid source units and existing flat skills remain available, so the unit—not provider content or the complete profile—is the ordinary source failure boundary; the malformed descriptor-namespace rule above is the sole profile-wide source-composition exception.

Pi-loader normalization retains every Pi diagnostic rather than aggregating it. For each rejected child definition, Bazframe emits one record per Pi diagnostic with exactly `{ category: "pi-loader", providerId, sourceId, path, diagnosticIndex, message }`: `path` is that child's source-root-relative definition path, `diagnosticIndex` is the zero-based index in Pi's returned diagnostic list, and `message` is Pi's reported message string unchanged. Records for that definition order by `diagnosticIndex`, then `message`. If Pi rejects a definition without returning a diagnostic, Bazframe emits the single deterministic record `{ category: "pi-loader", providerId, sourceId, path, diagnosticIndex: 0, message: "Pi loader rejected definition without a diagnostic" }`. Any Pi-loader record withholds the source unit.

Pi-loaded effective names must be unique across the complete Bazframe profile set before native-runtime collision handling. Discovery first retains valid flat direct skills, then evaluates every source unit and builds one profile-name index. Each `duplicate-name` record has exactly `{ category: "duplicate-name", providerId, sourceId, path, name }`, where `path` is the conflicting derived definition's source-root-relative `SKILL.md` path and `name` is its Pi-loaded effective name. A within-source duplicate emits one record at every conflicting definition path and withholds that unit. A cross-source duplicate emits one record at every conflicting definition path in every involved source unit and withholds every involved unit. A flat/derived conflict emits one record only for each conflicting derived definition path, withholds its source unit, and preserves the flat membership; it never emits a synthetic flat-source record. A derived definition receives only one duplicate record for its name and path even when more than one other definition has that name. These complete-set outcomes do not depend on traversal arrival order.

A valid derived child that collides only with a Pi-native skill is not a profile duplicate: it enters the existing native/profile collision pipeline and receives the existing deterministic alias when available. The derived/native collision alias continues to point to the derived child's original physical definition and base directory. A collision on the generated alias is a visible runtime projection error; Bazframe does not replace the occupant or generate a second alias. Other Pi projection errors likewise remain visible runtime errors.

### Runtime reporting and acceptance behavior

`bazframe status` and `/bazframe info` distinguish:

- flat direct skills from `profiles/<profile>/skills/`;
- direct source units from descriptor files; and
- derived effective skills, including their provider/source/relative-path origin.

They retain the existing total effective Pi command names and native/profile alias diagnostics. Failed source units are shown with their scoped diagnostic and contribute no derived children. With no `source-units/` directory, status, runtime projection, flat-skill ordering, and collision behavior remain the current flat behavior apart from the new explicit zero source-unit/derived counts.

The initial runtime compatibility claim remains Pi 0.82.x. Acceptance for implementation requires fixtures for zero memberships; descriptor add/idempotence/refused retarget/remove-with-broken-root; malformed descriptor namespaces at the root, provider, and child levels with exact placeholder identities and paths; profile duplicate/rename/remove without provider traversal; standalone, zero-child, nested, skipped-internal, symlink, mixed-root, invalid-definition, boundary and over-boundary discovery; skipped entries excluded from the entry count and symlinks beneath skipped `.git`/`node_modules` roots never inspected; exact per-path within-source, cross-source, and flat/source duplicate records; atomic source failure including exact multi-diagnostic Pi-loader normalization; exact original bases and definitions delivered individually to Pi; a derived/native collision whose generated alias preserves the derived child's original definition and base; a generated-alias collision that fails visibly without replacement or a second alias; status and `/bazframe info` separation; and regression coverage for existing flat Skillbook profiles.

Every acceptance fixture that exercises source add, source remove (including a broken root), discovery, profile duplicate/rename/remove, or Pi projection must capture a complete provider manifest immediately before and after the operation. For every configured provider root, the manifest is sorted by `/`-separated relative path and records the root plus every descendant without following links: path, physical filesystem type, SHA-256 of regular-file bytes, and SHA-256 of symlink-target bytes; other types carry an explicit no-content marker. A missing or broken configured root is represented by an explicit `missing` root record. Before and after manifests must be byte-for-byte equal. Operation-specific assertions must separately prove the intended Bazframe-owned descriptor, profile, or alias-cache change, so an unchanged provider manifest cannot mask a missing Bazframe mutation. Manifest collection occurs outside the measured operation; no lifecycle operation gains permission to resolve or traverse a provider root.

Bazframe does not acquire, install, update, publish, or remove provider sources; install dependencies; run child commands; manage mutable data or credentials; supervise processes; or own execution. Stage 2's source-tree command evidence proves composition mechanics only and does not introduce a Bazframe gateway.

## Ownership

| Owner | Resources |
|---|---|
| User | profile content and instructions, configured skill roots, source-provider choices, and explicit selection of provider-owned physical roots; `profile remove --force` authorizes Bazframe to delete only the named non-active physical profile content |
| Skillbook | flat skill acquisition, library copies, versioning, updating, publication, deletion, lockfile, and Agent Skills-compatible source directories |
| Other source providers | source-unit bytes, acquisition, preparation, versioning, updates, dependencies, publication, deletion, mutable data, credentials, and any source execution lifecycle |
| Bazframe | profile lifecycle operations, flat direct membership links, source-unit descriptor files, read-only child derivation, profile selection and resolution, runtime projection, active-profile state, global policy, project overrides, adapter manifest, installed adapter artifact, diagnostics, and generated alias cache |
| Repository | worktree files and project instructions |
| Pi | settings, trust decisions, tools, models, extensions, packages, prompts, themes, system-prompt files, native skills, and execution |

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
bazframe profile sources
bazframe profile sources add <provider> <source> <absolute-root> [--profile <profile>]
bazframe profile sources remove <provider> <source> [--profile <profile>]

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

Adapter installation is explicit and orthogonal to global/project policy. Global and project disable operations require neither adapter nor profile. Global enable validates runtime setup before removing disabled state. Project enable validates runtime setup because it makes the current worktree effective-enabled, including when it overrides global disable. Profile skill add/remove mutate only flat direct membership in the active or explicitly targeted profile. Profile source add/remove mutate only Bazframe-owned source-unit descriptors; they do not mutate provider roots. Source-unit mutation has no top-level compatibility aliases or TUI action in this slice.

For adapter installation, `--force` repairs a drifted artifact only when a valid Bazframe ownership manifest identifies the destination. For `profile remove`, `--force` separately authorizes deletion of all content under the named non-active physical profile; it never extends authority to symlink targets.

Inside Pi, the adapter registers exactly one namespaced command: `/bazframe info` or `/bazframe reload`. `/bazframe reload` awaits Pi's reload operation, which reloads extensions, policy, profiles, skills, and context. Bare, unknown, or extra arguments show `Usage: /bazframe info | /bazframe reload` without reloading.

`/bazframe info` remains compact. It reports the effective profile (or `(none)`); effective context entries labeled `(pi)` or `(bazframe)` by supplier; separate lexical lines for flat direct skills, direct source units, and source-derived effective skills; effective Pi skill-command names as one deduplicated lexical comma-separated list (or `(none)`); source-scoped failures when present; and a deterministic comma-separated `original -> alias` collision line only when collisions exist. Pi context retains `contextFiles` order. With an active profile whose flat state is valid, Bazframe appends the profile instructions entry; when Pi reports no context it first reports the restored global context when present. A failed source unit is reported and omitted atomically without hiding the otherwise effective profile. Disabled, unresolved, or flat-profile-error states do not report an effective profile or Bazframe context.

## Safety and diagnostics

Bazframe-managed writes use validated external paths, per-resource locks, mode-restricted temporary files, and atomic filesystem operations. Selection validation and all lifecycle mutations occur under the global state lock; membership takes that lock before its profile-specific lock. Duplication copies to a unique sibling staging directory without following symlinks, cleans failed staging, and publishes with a final rename. Active rename coordinates a directory rename with atomic selection replacement and rolls the directory back when selection replacement fails before commit. Adapter install and uninstall compare artifact hashes against the ownership manifest. Exceptional project overrides are external; acceptance tests preserve the worktree snapshot and Git status. Locks coordinate Bazframe writers, but a non-cooperating external process can race profile check/create/duplicate/rename/remove pathnames or the final membership unlink; portable Node filesystem APIs do not provide every conditional pathname operation needed to exclude such writers.

A default-enabled session validates flat profile state as before and reports actionable errors in both Git and non-Git directories. Source-unit errors are additionally reported at their atomic unit boundary: a failed source contributes no children, while valid flat skills and other valid sources remain available. An effective-disabled session retains native Pi behavior.

`bazframe status` reads and reports adapter ownership, drift, current project state and effective behavior, active-profile validity when required, flat direct skill counts, direct source-unit counts, derived effective skill counts, source-scoped failures, collision aliases, and corrective commands.

## Research agenda

Product work now focuses on:

- completing the TUI's remaining source-tree/viewport interaction work after the separate top-tab focus model;
- implementing and validating the approved canonical source-unit descriptor, bounded live discovery, and CLI-only mutation contract;
- keeping editor launch, settings writes, TUI source mutation, additional provider operations, and provider-owned move/rename behind their explicit ownership and lifecycle decisions;
- validating Linux, Windows Terminal, SSH, tmux, and manual assistive-technology behavior before any production-ready TUI claim;
- preserving flat direct-membership behavior and the provider-ownership boundary while adding only profile-local source descriptors and read-only composition;
- semantic composition between personal and repository-recommended profiles;
- instruction and skill conflict policy across multiple runtimes.

Skill packs, child subsets, a global source registry, profile export, and Bazframe-owned skill or source artifact lifecycle remain deferred.

## Implementation plan

[`pi-adapter-production-design.md`](pi-adapter-production-design.md) records the implemented production baseline, lifecycle rules, milestones, and acceptance evidence. Executable Pi 0.82 evidence is retained in the [`pi-no-launcher-adapter` experiment](../experiments/pi-no-launcher-adapter/REPORT.md).
