# Bazframe 2 Product Design

> Status: current product source of truth

Bazframe composes Agent Skills-compatible capabilities into profiles, then applies profiles to coding agents. A profile carries personal instructions, flat direct skill memberships, and optional exact references to global managed sources across working directories. Runtime adapters resolve an available Git-worktree project override, then global policy, then the file-free enabled default.

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

Bazframe's first interactive management UI is a keyboard-first terminal UI with no sidebar, launched explicitly as `bazframe tui`. Its top navigation is `Skills`, `Profiles`, `Adapters`, and `Settings`. Preferred layouts show responsive master-detail views for the combined skill/source browser and selected profiles; compact layouts drill into profile details and plain-text `SKILL.md` previews with visible breadcrumbs and Esc/Backspace return. Managed sources and skills remain distinct domain projections even though they share the Skills tab. Adapter and Settings views remain read-only.

[`tui-design.md`](tui-design.md) records the implemented boundary, interaction model, safety requirements, tests, and remaining review gates. Runtime `ink@7.1.1` and `react@19.2.8` are exact pins and load lazily only after CLI dispatch to `bazframe tui`. The TUI calls typed application services rather than spawning CLI subprocesses, and explicit profile targeting never silently changes the active selection. It may add one global managed source from a selected physical, already-prepared input root only when no `bazframe-source.json` build declaration is present; the source name is the canonical root basename. The core rechecks and refuses every declared build with CLI guidance; successful TUI addition snapshots the complete selected tree and never adds a profile reference. Provider acquisition, declared-build execution, source rebuild/remove, profile-reference mutation, editor launch, settings/adapter writes, and provider move/rename remain outside this slice.

Deterministic tests cover compact/resize/exit/accessibility behavior, cell-aware bounds, source-add consent, and terminal-control-neutralized previews. Real terminal gates cover alternate-screen lifecycle and same-width vertical-growth origin. This does not make the TUI production-ready. Windows Terminal, representative remote SSH, terminal/font/locale ambiguous-width differences, and manual assistive-technology evidence remain open.

## Core objects

### Skill

A skill is an Agent Skills-compatible directory supplied through a configured skill root. Bazframe consumes this standard filesystem interface without depending on Skillbook, Git, npm, or any other particular acquisition and versioning provider.

### Skill packs

Skill packs are deferred. Bazframe will not introduce pack behavior unless a later product decision expands its responsibility beyond direct profile composition.

### Profile

A profile combines personal instructions, flat direct skill memberships, and zero or more exact references to global managed sources. Bazframe manages profile definitions, membership, selection, and application to supported coding agents. Global source records—not profiles—own provider roots, activated snapshot digests, and source-unit roots.

The profile layout is:

```text
profiles/<id>/
├── AGENTS.md
├── skills/
│   └── <skill>/SKILL.md
└── sources/                              # optional global-source references
    └── <sourceId>.json
```

The profile-local `AGENTS.md` contains personal coding-agent instructions. Each materialized flat skill is an Agent Skills-compatible directory, including any supporting files used by its `SKILL.md`. Each profile source file contains only one exact source identity. The matching global source record owns the external input root, activated snapshot digest, and snapshot-relative source-unit root; effective child skills are derived from that activated snapshot rather than mutable input.

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
- pre-existing Pi skills, flat direct profile skills, and source-unit-derived profile skills, with deterministic aliases for Pi skill-command/profile collisions.

Bazframe resolves this view at startup and reload from active flat memberships and source-unit snapshots.

The current layered effective-harness composition contract treats runtime-native repository harness material and the active personal Bazframe profile as separate layers, not as stored profiles to merge. Bazframe treats instruction contents as opaque: it does not parse, classify, merge, rank, reject, rewrite, or resolve semantic contradictions. Plain runtime invocation retains native repository context/resources and adds the active personal profile; an explicit runtime context-suppression mode may omit repository instruction context according to that runtime's contract. Every included layer remains in the effective prompt even when its prose contradicts another included layer. Runtime/model behavior is not a Bazframe winner or precedence guarantee, and correction remains user-owned. Repository content does not select or mutate the user's active profile, and no future extension may silently replace it. Bazframe preserves supplier provenance in reporting.

### Relationships and invariants

```text
ActiveSelection  -> ProfileId
ProfileId        -> Profile(instructions, flat skills, global source references)
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
- A profile source reference resolves only the global source object's activated Bazframe snapshot; mutable provider input is preparation-time state, not runtime state.
- Build execution requires explicit add/build command intent and never occurs while resolving the effective harness.
- Adapter-specific projection, such as a Pi skill alias, belongs to the effective harness cache rather than the source profile.

This model makes profiles and global managed sources separate portable stored objects, and the effective harness the runtime composition of the active profile's direct skills and source references with project-over-global policy.

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

This structured signal gives the adapter one bounded rule for both invocations. For supported Pi 0.82.x, the exact appended form is the incoming Pi `systemPrompt`, two LF characters, and the profile section. When `contextFiles` is empty and a global Pi instruction file exists, the appended portion is the global section, two LF characters, then the profile section. Sections use `<bazframe_global_instructions path="…">` or `<bazframe_profile_instructions path="…">`, followed by LF, the instruction body unchanged, LF, and the matching closing tag. Attribute paths escape `&`, `"`, `<`, and `>` as `&amp;`, `&quot;`, `&lt;`, and `&gt;`; bodies are not escaped or interpreted.

This order and encoding are a transport/provenance contract, not semantic precedence. `pi -nc` omits repository instruction context because the user selected Pi's suppression mode, not because Bazframe resolved a contradiction. Detailed semantics are recorded in [`pi-adaptive-context-adapter.md`](pi-adaptive-context-adapter.md).

## Skills

For the first production slice, Bazframe discovers profile membership from the profile directory, validates skill resources through Pi's Agent Skills loader, exposes them to the runtime, projects collision aliases, and reports diagnostics.

Skillbook owns skill acquisition, copying into its library, versioning, updating, publication, and deletion. Bazframe owns only profile membership. The approved first membership slice resolves Skillbook's library from `SKILLBOOK_LIBRARY`, then the deprecated `SKILLBOOK_LOCK_LIBRARY`, then `~/.skillbook`.

`bazframe skills` and its singular alias `bazframe skill` list valid, directly addable skills in the resolved Skillbook library. The overview identifies the resolved source, uses lexical order, reports invalid neighbors as warnings, and does not include Pi-native or profile-only skills.

`bazframe profile skills add <skill> [--profile <profile>]` adds the named Skillbook skill to the active or explicitly targeted profile as an absolute directory symlink under `profiles/<id>/skills/`. `bazframe profile skills remove <skill> [--profile <profile>]` removes only that verified membership symlink. Both commands are idempotent and must preserve Skillbook's skill directory and lockfile. Bazframe refuses physical entries, foreign or mismatched symlinks, replacement, copy fallback, and unsafe names. The Skillbook directory ID must match the skill's declared Agent Skills name. Membership-time parsing validates only that identity; Pi's Agent Skills loader remains authoritative for the complete schema when the skill enters a session. A missing add target compares its safe ID with valid available skills and offers bounded edit-distance suggestions before pointing to `bazframe skills`.

Existing physical profile skill directories remain readable for compatibility but are not managed by these commands. Packs, manifests, export, and Windows link fallback are outside this slice.

Profile skills enter Pi through `resources_discover`.

Profile-set duplicates are resolved before runtime projection and never receive aliases. Duplicate Pi-loaded names among flat memberships invalidate the complete profile. A prospective source add/build that introduces a duplicate is rejected before activation. For already-active source references, a flat/derived conflict preserves the flat skill and atomically withholds the complete derived source unit; a source/source conflict atomically withholds every involved source unit; unrelated valid flat skills and source units remain effective. The exact per-definition `duplicate-name` records and within-source behavior are specified in the snapshot discovery contract below. Bazframe does not infer semantic or dependency incompatibility among differently named skills.

At the Pi boundary, any pre-existing Pi command with `source === "skill"` occupies its `skill:<name>` command; Bazframe does not claim finer ownership provenance. A profile skill keeps its original name when it is free. On a collision, the pre-existing Pi skill-command occupant keeps that name and Bazframe tries exactly one deterministic profile alias. The ordinary alias is:

```text
<name>-x-bazframe
```

The complete alias is limited to 64 characters. When necessary, the Pi adapter truncates the original base to leave room for `-x-bazframe` and removes trailing hyphens from that truncated base before adding the suffix. The alias wrapper points to the original skill file and base directory and preserves the profile skill's description and `disable-model-invocation` setting.

The alias is used only when its generated name is free from pre-existing Pi skill commands, every profile skill's original name, and aliases generated earlier in the same projection. An occupied generated alias is a visible Pi projection error: Bazframe returns no profile skill paths for that projection and does not replace the occupant or try another suffix. Successful aliases are runtime cache under `adapter-cache/pi`; they do not rename or mutate stored profile identity.

Only Pi 0.82.x has an implemented and evidenced adapter contract. A future adapter must define and test its instruction order and provenance, loader compatibility, runtime command namespace, duplicate behavior, and collision projection. It may expose both definitions under adapter-specific deterministic reported names or fail visibly, but it cannot silently drop or overwrite either definition, mutate the profile skill's identity, or persist a runtime alias into the portable profile.

## Global managed sources and profile composition

Managed sources are top-level Bazframe objects. A source owns one canonical external input identity, one explicit build declaration, and one activated immutable content-addressed snapshot. Profiles do not own or duplicate source objects; they contain references to global sources and compose the referenced sources' activated skills with their direct flat skills.

Build execution is explicit only. It occurs during `sources add` and `sources build`, never during overview, status, TUI load/refresh, Pi startup, `/bazframe reload`, or skill invocation. Providers retain acquisition, credentials, mutable runtime data, publication, dependencies, and child-command behavior. Bazframe owns declared build execution, snapshot publication and verification, activation, references, and composition validation. Selecting or rebuilding a source consents to the declared build running with ordinary user-process authority; Bazframe provides no sandbox.

### Persistence

A global source object is stored at:

```text
<BAZFRAME_HOME>/sources/<source>.json
```

Its exact schema-v1 object is:

```json
{
  "schemaVersion": 1,
  "source": "source-id",
  "root": "/canonical/absolute/provider-input",
  "digest": "<lowercase-sha256>",
  "sourceUnitRoot": "source-unit"
}
```

A profile reference is stored at:

```text
<BAZFRAME_HOME>/profiles/<profile>/sources/<source>.json
```

Its exact schema-v1 object is:

```json
{
  "schemaVersion": 1,
  "source": "source-id"
}
```

Both namespaces use one safe 1–64 character lowercase hyphenated source ID, exact fields, physical regular non-link files, UTF-8, identity revalidation, and deterministic lexical inspection. The source ID is exactly `basename(realpath(<absolute-root>))`; Bazframe rejects unsafe names and occupied IDs without normalization or fallback. Existing pre-alpha nested/provider-shaped state and `profiles/<profile>/source-units/` content have no migration path: nested current-state entries fail validation, while `source-units/` remains inert ordinary profile content.

A provider input may contain the exact physical `bazframe-source.json` build declaration already specified by the source-build manifest contract:

```json
{
  "schemaVersion": 1,
  "build": ["npm", "run", "build"],
  "artifactRoot": "dist",
  "sourceUnitRoot": "source-unit"
}
```

The build argv is executed directly without a shell with the provider input as CWD. An absent manifest means already-prepared input and still produces a snapshot. Portable relative roots reject path escape, absolute forms, backslashes, empty segments, and `.`/`..` segments except the literal `.` root sentinel.

Snapshot publication retains the exact canonical manifest and immutable storage contract at `<BAZFRAME_HOME>/source-snapshots/sha256/<digest>/{manifest.json,artifact/}`. Complete artifact bytes, empty directories, executable identity, containment, physical entry types, stored manifest bytes, digest, and immutable modes are verified before use. Failed activation may leave an unreferenced valid snapshot; garbage collection is deferred.

### Commands and transactions

The only managed-source commands are:

```text
bazframe sources
bazframe sources add <absolute-root>
bazframe sources build <source>
bazframe sources remove <source>

bazframe profile sources
bazframe profile sources add <source> [--profile <profile>]
bazframe profile sources remove <source> [--profile <profile>]
```

There is no singular `source` alias and no legacy profile-local build/add-root command.

Global add derives the source ID from the canonical root basename, then explicitly builds, validates, snapshots, and activates it without requiring a profile. Any occupied source ID, including an exact same-root re-add, is rejected. Global build prepares a candidate and validates it against every profile that references that identity. If the candidate would introduce a structural, Pi-loader, or duplicate conflict in any dependent profile, activation is rejected for everyone and the previous global record/digest remains active. Unrelated pre-existing failures do not alone block activation, but malformed or raced reference namespaces fail closed because Bazframe cannot prove the complete dependent set.

Profile reference add validates the global object, snapshot, and prospective profile without building. Reference remove deletes only the named reference and does not require the global object or provider input. Neither changes active profile selection.

Global source removal is refused while any profile references it and reports the sorted dependent profiles. Once unreferenced, removal unlinks only the global JSON object; external input and immutable snapshots remain untouched. All source and reference writers take the global state lock; a one-profile reference write then takes that profile's source lock.

### Runtime discovery and conflicts

Runtime reads only references from the active profile, joins them to global records, verifies activated snapshots, and derives children from snapshot-relative roots. Unreferenced global sources never enter a profile or Pi composition and never affect active status readiness. A valid reference with a missing/malformed global target reports `invalid-source`; a malformed reference namespace reports `invalid-reference` and withholds managed sources for that profile while preserving flat skills.

Traversal retains depth 8, 256 visited entries, and 64 effective children per source; lexical DFS; skipped `.git`/`node_modules`; no-follow containment; source-atomic failures; Pi 0.82-authoritative Agent Skills loading; exact diagnostic ordering; and profile-wide duplicate semantics. Flat/source conflicts preserve flat skills and withhold the derived unit. Source/source conflicts withhold every involved source. Pi command collisions remain adapter-specific and use the existing one deterministic alias attempt.

`bazframe sources` reports every global source, including unreferenced health, root, digest, source-unit root, rebuild availability, derived children/failures, and reference count. `bazframe profile sources`, `bazframe status`, and `/bazframe info` report active-profile references, effective derived children, and scoped failures. Active status corrective actions use `bazframe sources build <source>`; unreferenced source failures do not require active-runtime attention.

## Ownership

| Owner | Resources |
|---|---|
| User | profile content and instructions, source-provider choices, explicit selection/build consent, and provider inputs; `profile remove --force` authorizes Bazframe to delete only the named non-active physical profile content |
| Skillbook | flat skill acquisition, library copies, versioning, updating, publication, deletion, lockfile, and Agent Skills-compatible source directories |
| Other source providers | provider input bytes, acquisition, versioning, updates, dependencies, build declaration, publication, deletion, mutable runtime data, credentials, and child-command behavior |
| Bazframe | profile lifecycle operations, flat direct membership links, global source objects, profile source references, declared build execution, prepared-artifact staging, immutable content-addressed snapshots, all-dependent atomic activation, referenced-delete refusal, snapshot validation and child derivation, profile selection and resolution, runtime projection, active-profile state, global policy, project overrides, adapter manifest, installed adapter artifact, diagnostics, and generated alias cache |
| Repository | worktree files and project instructions |
| Pi | settings, trust decisions, tools, models, extensions, packages, prompts, themes, system-prompt files, native skills, and execution |

This ownership model lets Bazframe prepare and freeze selected source artifacts before composition while leaving provider acquisition and runtime capabilities independent.

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
bazframe sources
bazframe sources add <absolute-root>
bazframe sources build <source>
bazframe sources remove <source>
bazframe profile sources
bazframe profile sources add <source> [--profile <profile>]
bazframe profile sources remove <source> [--profile <profile>]

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

Adapter installation is explicit and orthogonal to global/project policy. Global and project disable operations require neither adapter nor profile. Global enable validates runtime setup before removing disabled state. Project enable validates runtime setup because it makes the current worktree effective-enabled, including when it overrides global disable. Profile skill add/remove mutate only flat direct membership in the active or explicitly targeted profile. Global source add/build explicitly prepare and activate snapshots; profile source add/remove change references only. Managed-source mutation has no singular CLI alias. The TUI exposes only bounded global add for manifest-free already-prepared roots; declared builds and every other source/reference mutation remain CLI-only.

For adapter installation, `--force` repairs a drifted artifact only when a valid Bazframe ownership manifest identifies the destination. For `profile remove`, `--force` separately authorizes deletion of all content under the named non-active physical profile; it never extends authority to symlink targets.

Inside Pi, the adapter registers exactly one namespaced command: `/bazframe info` or `/bazframe reload`. `/bazframe reload` awaits Pi's reload operation, which reloads extensions, policy, profiles, skills, and context. Bare, unknown, or extra arguments show `Usage: /bazframe info | /bazframe reload` without reloading.

`/bazframe info` remains compact. It reports the effective profile (or `(none)`); effective context entries labeled `(pi)` or `(bazframe)` by supplier; separate lexical lines for flat direct skills, profile source references, and source-derived effective skills; effective Pi skill-command names as one deduplicated lexical comma-separated list (or `(none)`); source-scoped failures when present; and deterministic live `original -> alias` mappings only when the projected alias commands are present in Pi's current command set. Pi context retains `contextFiles` order. With an active profile whose flat state is valid, Bazframe appends the profile instructions entry; when Pi reports no context it first reports the restored global context when present. A failed source unit is reported and omitted atomically without hiding the otherwise effective profile. Disabled, unresolved, or flat-profile-error states do not report an effective profile or Bazframe context.

## Safety and diagnostics

Bazframe-managed writes use validated external paths, per-resource locks, mode-restricted temporary files, and atomic filesystem operations. Selection validation and all lifecycle mutations occur under the global state lock; membership takes that lock before its profile-specific lock. Source preparation runs only after explicit add/build authorization, copies output to private staging, validates and hashes it before publication, and replaces a descriptor only after the immutable snapshot is available. Failed staging is cleaned without changing the active descriptor; unreferenced snapshot garbage collection is deferred. Duplication copies to a unique sibling staging directory without following symlinks, cleans failed staging, and publishes with a final rename. Active rename coordinates a directory rename with atomic selection replacement and rolls the directory back when selection replacement fails before commit. Adapter install and uninstall compare artifact hashes against the ownership manifest. Exceptional project overrides are external; acceptance tests preserve the worktree snapshot and Git status. Locks coordinate Bazframe writers, but a non-cooperating external process can still race pathname-based operations where portable Node lacks a conditional handle-relative API.

A default-enabled session validates flat profile state as before and reports actionable errors in both Git and non-Git directories. Source-unit errors are additionally reported at their atomic unit boundary: a failed source contributes no children, while valid flat skills and other valid sources remain available. An effective-disabled session retains native Pi behavior.

`bazframe status` reads and reports adapter ownership, drift, current project state and effective behavior, active-profile validity when required, flat direct skill counts, profile source-reference target health and snapshot digests, derived effective skill counts, source-scoped failures, the physical cached Pi alias count, and corrective commands. It does not discover live Pi alias mappings and never prepares or rebuilds a source.

## Research agenda

Product work now focuses on:

- completing deeper source-tree navigation beyond the current source/skill master-detail view;
- retaining the global source-object and profile-reference lifecycle, declared builds, immutable snapshots, all-dependent activation validation, and snapshot-based bounded discovery;
- keeping editor launch, settings/adapter writes, declared-build execution in the TUI, source rebuild/remove, profile-reference mutation, additional provider operations, and provider move/rename behind their explicit ownership and lifecycle decisions;
- retaining Linux and local tmux evidence while validating Windows Terminal, representative remote SSH, terminal/font/locale width differences, and manual assistive-technology behavior before any production-ready TUI claim;
- preserving flat direct-membership behavior while adding the smallest explicit source preparation lifecycle.

The Agent Skills specification defines no standard dependency field; it permits arbitrary additional files and string-valued `metadata`, and recommends that scripts be self-contained or clearly document dependencies. Bazframe's current product decision is to add no inter-skill dependency schema or automation: source providers own shared resources and runtime packages, and Bazframe does not infer dependency semantics from prose, `compatibility`, `metadata`, `allowed-tools`, sibling paths, or co-packaging. Any future namespaced validate-only sidecar requires separate interoperability evidence and an explicit product decision before schema or automation.

Skill packs, child subsets, profile export, and snapshot garbage collection remain deferred.

## Implementation plan

[`pi-adapter-production-design.md`](pi-adapter-production-design.md) records the implemented production baseline, lifecycle rules, milestones, and acceptance evidence. Executable Pi 0.82 evidence is retained in the [`pi-no-launcher-adapter` experiment](../experiments/pi-no-launcher-adapter/REPORT.md).
