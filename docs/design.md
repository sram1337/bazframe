# Bazframe 2 Product Design

> Status: current product source of truth

Bazframe composes Skills into profiles, then applies profiles to coding agents. A profile carries personal instructions, the profile's Skills, and optional exact references to global libraries and packages across working directories. Runtime adapters resolve an available Git-worktree project override, then global policy, then the file-free enabled default.

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

Bazframe's first interactive management UI is a keyboard-first terminal UI with no sidebar, launched explicitly as `bazframe tui`. Its top navigation is `Skills`, `Profiles`, `Adapters`, and `Settings`. The Skills tab presents one uninterrupted list of peer `Added Skills`, `Library <id>`, and `Package <id>` rows. Every row is collapsible into ordinary Skill rows; profile detail reports individual Skills and whole-object library/package references separately. Compact layouts drill into profile details and plain-text `SKILL.md` previews with visible breadcrumbs and Esc/Backspace return. Adapter and Settings views remain read-only.

[`tui-design.md`](tui-design.md) records the implemented boundary, interaction model, safety requirements, tests, and remaining review gates. Runtime `ink@7.1.1` and `react@19.2.8` are exact pins and load lazily only after CLI dispatch to `bazframe tui`. The TUI calls typed application services rather than spawning CLI subprocesses, and explicit profile targeting never silently changes the active selection. It may add one library from a selected physical, already-prepared input root; a root-level `bazframe-package.json` is blocked with package-command guidance. Successful TUI addition snapshots the complete selected tree, executes nothing, and never adds a profile reference. Package builds, library update/remove, package remove, profile-reference mutation, settings/adapter writes, and provider move/rename remain outside this slice. Selected-profile instruction editing uses the same approved external-editor service as `bazframe profile edit <profile>`. The Skills preview may hand a live `(default)` provider `SKILL.md` to that editor, equivalent to `bazframe skill edit <skill>`; library/package snapshots remain immutable.

Deterministic tests cover compact/resize/exit/accessibility behavior, cell-aware bounds, library-add consent, and terminal-control-neutralized previews. Real terminal gates cover alternate-screen lifecycle and same-width vertical-growth origin. This does not make the TUI production-ready. Windows Terminal, representative remote SSH, terminal/font/locale ambiguous-width differences, and manual assistive-technology evidence remain open.

## Core objects

### Skill

A **Skill** is a directory conforming to the Agent Skills specification and supplied through a configured Skill root. Bazframe consumes this standard filesystem interface independently of any acquisition, versioning, or publication provider.

Bazframe defines no second Skill format. A live provider Skill in `(default)` is an **added Skill**; individually selected memberships are **a profile's Skills**. A Skill remains a Skill when contained in a library or produced by a package.

### Skill packs

Skill packs are deferred. Bazframe will not introduce pack behavior unless a later product decision expands its responsibility beyond current profile composition.

### Default added Skill catalog

The `(default)` catalog is the Bazframe-home registry for individually selectable live skills:

```text
<BAZFRAME_HOME>/skills/
└── <skill> -> /canonical/external/<skill>
```

It is the added Skill catalog, not a library or package. Libraries and packages use immutable snapshots and whole-object references; `(default)` entries remain live external directories and support individual profile membership.

### Profile

A profile combines personal instructions, the profile's Skills, and zero or more exact library and package references. Bazframe manages profile definitions, membership, selection, and application to supported coding agents. Global library/package records own provider roots, activated snapshot digests, and Skills roots.

The profile layout is:

```text
profiles/<id>/
├── AGENTS.md
├── skills/
│   └── <skill>/SKILL.md
├── libraries/                            # optional whole-library references
│   └── <library>.json
└── packages/                             # optional whole-package references
    └── <package>.json
```

The profile-local `AGENTS.md` contains personal coding-agent instructions. Each of a profile's materialized Skills is a standard Skill directory, including any supporting files used by its `SKILL.md`. Each library/package reference contains one exact typed identity. The matching global record owns the provider root and activated snapshot; effective Skills are derived from immutable bytes rather than mutable input.

The first slice has one global active profile selected by `bazframe profile use <profile>`; `bazframe use <profile>` remains a compatibility alias. `profile add` creates a physical profile directory containing a zero-byte physical `AGENTS.md` and an empty physical `skills/` directory without activating it. `profile list` prints valid physical profile IDs and `profile current` prints only the selected ID for scripts. Bare `bazframe profile` and `bazframe profiles` instead render the human profile overview: valid profiles in lexical order, an explicit active marker, current-selection state, and the available profile commands.

`profile edit <profile>` opens the named profile's actual `AGENTS.md` without changing the active selection. Immediately before launch, Bazframe revalidates the physical `profiles/` and profile directories and requires the final `AGENTS.md` entry, including an allowed user-owned final symlink, to resolve to a regular file; it deliberately does not read or runtime-validate the contents so the editor can repair invalid bytes. The first nonblank `VISUAL`, then `EDITOR`, is treated as one executable name or path—not a command string. Bazframe supplies only the absolute target path, runs with its owning directory as cwd, inherits environment and stdio, sets `shell: false`, installs no editor signal forwarding, takes no state lock, waits for the child, and returns its exit or signal status. While the editor owns a foreground terminal, a temporary no-op parent `SIGINT` handler keeps Bazframe alive so Ctrl+C reaches the editor directly; it is removed as soon as the child settles. Flags, shell expansion, persisted settings, fallback editors, temporary copies, rollback, and editor-specific wait inference are absent; fixed flags require an executable wrapper. Existing Pi sessions use `/bazframe reload` after editing.

`skill edit <skill>` applies that process contract only to a structurally valid added Skill in `(default)`. Authorization derives from the safe skill ID and Bazframe home, not a preview path: it reopens the physical catalog, requires the expected absolute registration link, canonical external physical provider root and matching basename, resolves `SKILL.md` to a regular file contained within that root, and revalidates catalog, registration, provider, and file identities immediately before launch. It deliberately does not parse bytes or frontmatter, so malformed definitions remain repairable. An internal final-file symlink is allowed only when its canonical target remains within the provider root. The unavoidable final pathname race against a non-cooperating provider process remains. This explicit user-authorized editor launch does not transfer provider artifact lifecycle ownership to Bazframe, enable `artifactWritesSupported`, or permit editing an immutable library/package snapshot; provider input is edited through its own workflow and explicitly refreshed.

`profile duplicate <source> <new>` copies all content from a physical source profile without resolving children or provider targets, preserves symlinks verbatim, refuses profile-root symlinks and occupied destinations, leaves the active selection unchanged, and publishes the new profile only after a complete staged copy. `profile rename <old> <new>` preserves profile content without resolving its children or provider targets, refuses symlink roots and replacement, and updates the active selection when renaming the active profile. `profile remove <id>` always refuses the active profile, even when its directory is missing. Without `--force`, removal accepts only the exact generated-empty shape; `--force` is explicit authorization to recursively delete a non-active physical profile. Recursive deletion unlinks membership symlinks without following or mutating provider targets. Actual profile creation, duplication, removal, and identity-changing rename clear disposable alias cache for affected new or existing IDs; idempotent add and same-ID rename preserve live cache. Lifecycle mutations use the global state lock before any profile-specific lock and apply to Pi on the next startup or `/reload`.

A profile's Skills are managed canonically with `bazframe profile skills add <skill> [--profile <profile>]` and `bazframe profile skills remove <skill> [--profile <profile>]`. Omission targets the active profile; an explicit target changes that profile without changing or requiring the active selection. There are no top-level membership aliases. Bare `bazframe profile skills` lists the active profile's immediate Skills and shows membership commands; Pi remains authoritative for full runtime validation. Packs are outside the current scope.

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
- pre-existing Pi Skills, a profile's Skills, and Skills from libraries/packages, with deterministic aliases for Pi skill-command/profile collisions.

Bazframe resolves this view at startup and reload from the active profile's Skills and library/package snapshots.

The current layered effective-harness composition contract treats runtime-native repository harness material and the active personal Bazframe profile as separate layers, not as stored profiles to merge. Bazframe treats instruction contents as opaque: it does not parse, classify, merge, rank, reject, rewrite, or resolve semantic contradictions. Plain runtime invocation retains native repository context/resources and adds the active personal profile; an explicit runtime context-suppression mode may omit repository instruction context according to that runtime's contract. Every included layer remains in the effective prompt even when its prose contradicts another included layer. Runtime/model behavior is not a Bazframe winner or precedence guarantee, and correction remains user-owned. Repository content does not select or mutate the user's active profile, and no future extension may silently replace it. Bazframe preserves supplier provenance in reporting.

### Relationships and invariants

```text
ActiveSelection  -> ProfileId
ProfileId        -> Profile(instructions, Skills, library/package references)
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
- A library/package reference resolves only its global object's activated Bazframe snapshot; mutable provider input is preparation-time state, not runtime state.
- Build execution requires explicit add/build command intent and never occurs while resolving the effective harness.
- Adapter-specific projection, such as a Pi skill alias, belongs to the effective harness cache rather than the source profile.

This model makes profiles and global libraries/packages separate portable stored objects, and the effective harness the runtime composition of the active profile's Skills and whole-object references with project-over-global policy.

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

Bazframe's built-in added Skill catalog is `(default)`, rooted at `<BAZFRAME_HOME>/skills`. Each entry `<skill>` is an absolute symlink to one canonical external physical Skill root. The canonical target basename and declared frontmatter `name` must exactly equal the safe skill ID. Bazframe owns only the catalog and profile links: it never copies, updates, polls, rewrites, or deletes provider content. Provider changes are live on the next Pi startup or `/bazframe reload`.

`bazframe add skill <absolute-root>` adds one structurally validated external Skill to `(default)`. The same exact canonical target is idempotently current; any physical, relative, broken, malformed, or different occupied entry is rejected. Targets inside `BAZFRAME_HOME` are refused to prevent ownership cycles. `bazframe remove skill <skill>` removes only the catalog link, is absent-idempotent, and refuses every valid profile dependency or unverifiable reference index. A broken absolute registration remains removable only after all literal-target profile memberships are gone. These lifecycles hold the global state lock, revalidate immediately before publication or unlink, and retain the documented final-syscall race against non-cooperating writers.

`bazframe skills` and its singular alias list only valid added Skills in lexical order with their external targets and diagnostics. Skills from libraries/packages and Pi-native Skills are not part of this catalog.

`bazframe profile skills add <skill> [--profile <profile>]` resolves the named added Skill and creates a parallel absolute symlink under `profiles/<id>/skills/` directly to the same canonical provider target—never a link chain. Removal accepts only an exact parallel link matching the current `(default)` entry. Both operations are idempotent, preserve provider content, and take the state lock before the profile membership lock. Bazframe refuses physical, relative, foreign, mismatched, or non-added entries. A missing add target offers bounded suggestions from valid added Skills.

Existing physical profile Skill directories and foreign links remain runtime-readable but are not managed by the membership commands. There is no provider-specific environment reader, release migration, copy fallback, or Windows link fallback. Libraries and packages remain separate immutable-snapshot objects with whole-object profile references.

Bazframe ships its own `bazframe` Skill from tracked `skills/bazframe/` to generated `dist/skills/bazframe/`. The npm package carries only the generated copy. This product-owned documentation artifact can be added through `bazframe add skill <installed-package>/dist/skills/bazframe`; it is not a general skill/profile export feature and does not perform acquisition or membership changes during build or installation.

Profile skills enter Pi through `resources_discover`.

Profile-set duplicates are resolved before runtime projection and never receive aliases. Duplicate Pi-loaded names among a profile's Skills invalidate the complete profile. A prospective library update or package build that introduces a duplicate is rejected before activation. For already-active references, the complete conflicting library/package contribution is withheld while its records and references remain intact; unrelated Skills remain effective. Bazframe does not infer semantic or dependency incompatibility among differently named Skills.

At the Pi boundary, any pre-existing Pi command with `source === "skill"` occupies its `skill:<name>` command; Bazframe does not claim finer ownership provenance. A profile skill keeps its original name when it is free. On a collision, the pre-existing Pi skill-command occupant keeps that name and Bazframe tries exactly one deterministic profile alias. The ordinary alias is:

```text
<name>-x-bazframe
```

The complete alias is limited to 64 characters. When necessary, the Pi adapter truncates the original base to leave room for `-x-bazframe` and removes trailing hyphens from that truncated base before adding the suffix. The alias wrapper points to the original skill file and base directory and preserves the profile skill's description and `disable-model-invocation` setting.

The alias is used only when its generated name is free from pre-existing Pi skill commands, every profile skill's original name, and aliases generated earlier in the same projection. An occupied generated alias is a visible Pi projection error: Bazframe returns no profile skill paths for that projection and does not replace the occupant or try another suffix. Successful aliases are runtime cache under `adapter-cache/pi`; they do not rename or mutate stored profile identity.

Only Pi 0.82.x has an implemented and evidenced adapter contract. A future adapter must define and test its instruction order and provenance, loader compatibility, runtime command namespace, duplicate behavior, and collision projection. It may expose both definitions under adapter-specific deterministic reported names or fail visibly, but it cannot silently drop or overwrite either definition, mutate the profile skill's identity, or persist a runtime alias into the portable profile.

## Skill libraries, Skill packages, and profile composition

A **Skill library** is an already-prepared physical directory containing zero or more Skills. Bazframe never executes provider code for a library. A **Skill package** is a buildable project with a required `bazframe-package.json`; an explicit package add or build produces an artifact containing a Skills root and optionally shared resources. Every discovered child is simply a Skill.

Both objects use immutable content-addressed snapshots and whole-object profile references. The typed identity is `(library, id)` or `(package, id)`, where the ID is exactly `basename(realpath(root))` and satisfies the safe lowercase hyphenated ID rules. A library and package may share an ID. Same-kind occupancy is rejected without normalization.

### Persistence

```text
<BAZFRAME_HOME>/libraries/<library>.json
<BAZFRAME_HOME>/packages/<package>.json
<BAZFRAME_HOME>/profiles/<profile>/libraries/<library>.json
<BAZFRAME_HOME>/profiles/<profile>/packages/<package>.json
<BAZFRAME_HOME>/skill-snapshots/sha256/<digest>/{manifest.json,artifact/}
```

Exact library record:

```json
{"schemaVersion":1,"library":"toolkit","root":"/canonical/toolkit","digest":"<lowercase-sha256>"}
```

Exact package record:

```json
{"schemaVersion":1,"package":"toolkit","root":"/canonical/toolkit","digest":"<lowercase-sha256>","artifactRoot":"dist","skillsRoot":"skills"}
```

Exact references are `{"schemaVersion":1,"library":"toolkit"}` and `{"schemaVersion":1,"package":"toolkit"}`. References follow the global object's atomically activated digest; they do not pin or copy children.

Old `sources/`, profile `sources/`, profile `source-units/`, `source-snapshots/`, `bazframe-source.json`, and `sourceUnitRoot` state is inert pre-alpha content. Bazframe provides no reader, alias, migration, or fallback for it.

### Package declaration

A package root requires a physical regular non-link `bazframe-package.json` with exactly:

```json
{
  "schemaVersion": 1,
  "build": ["npm", "run", "build"],
  "artifactRoot": "dist",
  "skillsRoot": "skills"
}
```

`build` is a nonempty literal argv array. Bazframe executes it directly with `shell: false`, inherited environment and stdio, and the package root as cwd. `artifactRoot` is relative to the package root; `skillsRoot` is relative to the artifact root. The complete artifact root is snapshotted, preserving shared resources, while discovery begins only at the Skills root. Missing, malformed, symlinked, or changed declarations fail activation. Package builds are unsandboxed and may modify provider-owned output.

A library has no declaration and uses its root as both artifact root and Skills root. `libraries add` and `libraries update` execute nothing. A library root containing `bazframe-package.json` is rejected with package guidance.

### Commands and transactions

```text
bazframe libraries
bazframe libraries add <absolute-root>
bazframe libraries update <library>
bazframe libraries remove <library>
bazframe packages
bazframe packages add <absolute-root>
bazframe packages build <package>
bazframe packages remove <package>
bazframe profile libraries
bazframe profile libraries add <library> [--profile <profile>]
bazframe profile libraries remove <library> [--profile <profile>]
bazframe profile packages
bazframe profile packages add <package> [--profile <profile>]
bazframe profile packages remove <package> [--profile <profile>]
```

There are no singular aliases and no `sources` commands. Library add performs the initial snapshot and activation; library update activates a later prepared provider tree. Package add performs the initial declared build and activation; package build builds and activates later provider changes. Profile reference changes never update a library, build a package, or select child Skills. Removal is refused while referenced.

Candidate activation validates the complete object and every referencing profile before atomically replacing its record. Any failure preserves the previous digest for all profiles. Reference-index uncertainty fails closed. Valid zero-Skill libraries and packages remain healthy and visible.

Discovery retains lexical bounded traversal, no-follow containment, physical entries, `.git`/`node_modules` discovery skips, root-versus-descendant exclusion, and Pi 0.82-authoritative loading. Duplicate names within one object reject activation. A profile Skill wins over a colliding referenced object and the complete conflicting object contribution is withheld. Library/package collisions withhold every involved object contribution while unrelated Skills remain effective. Stored collisions never receive aliases.

The TUI presents `Added Skills`, `Library <id>`, and `Package <id>` as collapsible peers in one Skills list without category sections. It can add a prepared library only; package add/build remains CLI-only. Library/package Skill previews are immutable and direct the user to edit provider input, then run `libraries update` or `packages build`.


## Ownership

| Owner | Resources |
|---|---|
| User | profile content and instructions, library/package provider choices, explicit selection/build consent, and provider inputs; `profile remove --force` authorizes Bazframe to delete only the named non-active physical profile content |
| Library/package providers | provider input bytes, acquisition, versioning, updates, dependencies, build declaration, publication, deletion, mutable runtime data, credentials, and child-command behavior |
| Bazframe | profile lifecycle operations, profile Skill membership links, global library/package objects, typed profile references, declared package-build execution, prepared-artifact staging, immutable content-addressed snapshots, all-dependent atomic activation, referenced-delete refusal, snapshot validation and child derivation, profile selection and resolution, runtime projection, active-profile state, global policy, project overrides, adapter manifest, installed adapter artifact, diagnostics, and generated alias cache |
| Repository | worktree files and project instructions |
| Pi | settings, trust decisions, tools, models, extensions, packages, prompts, themes, system-prompt files, native skills, and execution |

This ownership model lets Bazframe freeze selected library/package artifacts before composition while leaving provider acquisition and runtime capabilities independent.

## Commands

The canonical first production command surface is resource-oriented:

```text
bazframe profile | profiles
bazframe profile add <profile>
bazframe profile duplicate <source> <new>
bazframe profile remove <profile> [--force]
bazframe profile rename <old> <new>
bazframe profile use <profile>
bazframe profile edit <profile>
bazframe profile list
bazframe profile current
bazframe add skill <absolute-root>
bazframe remove skill <skill>
bazframe skill edit <skill>
bazframe profile skills
bazframe profile skills add <skill> [--profile <profile>]
bazframe profile skills remove <skill> [--profile <profile>]
bazframe libraries
bazframe libraries add <absolute-root>
bazframe libraries update <library>
bazframe libraries remove <library>
bazframe packages
bazframe packages add <absolute-root>
bazframe packages build <package>
bazframe packages remove <package>
bazframe profile libraries add <library> [--profile <profile>]
bazframe profile libraries remove <library> [--profile <profile>]
bazframe profile packages add <package> [--profile <profile>]
bazframe profile packages remove <package> [--profile <profile>]

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

Bare singular and plural resources produce human overviews. Scoped verbs mutate the named resource. Concise `profile list` and `profile current` outputs remain available for scripts. Top-level `use` remains a compatibility alias; top-level `add skill` and `remove skill` exclusively manage `(default)` catalog registrations. Old `init`/`uninit` forms fail with migration guidance to `project enable`/`disable`, while `bazframe pi` remains only as the documented deprecated launcher. Root help stays intentionally small and points to `bazframe help <resource>` or `<resource> --help` for the detailed grammar.

CLI color is presentation-only: it is enabled automatically for terminal streams, disabled for pipes and redirects, disabled when `NO_COLOR` is present, and explicitly enabled by nonzero `FORCE_COLOR` only when `NO_COLOR` is absent. Headings, active/current state, warnings, errors, and command hints retain text and symbols that remain understandable without color.

Adapter installation is explicit and orthogonal to global/project policy. Global and project disable operations require neither adapter nor profile. Global enable validates runtime setup before removing disabled state. Project enable validates runtime setup because it makes the current worktree effective-enabled, including when it overrides global disable. Profile Skill add/remove mutate only that profile's Skills. Library add/update and package add/build explicitly activate snapshots; profile library/package add/remove changes references only. These resources have no singular CLI aliases. The TUI exposes only bounded library add; package builds and every other collection/reference mutation remain CLI-only.

For adapter installation, `--force` repairs a drifted artifact only when a valid Bazframe ownership manifest identifies the destination. For `profile remove`, `--force` separately authorizes deletion of all content under the named non-active physical profile; it never extends authority to symlink targets.

Inside Pi, the adapter registers exactly one namespaced command: `/bazframe info` or `/bazframe reload`. `/bazframe reload` awaits Pi's reload operation, which reloads extensions, policy, profiles, skills, and context. Bare, unknown, or extra arguments show `Usage: /bazframe info | /bazframe reload` without reloading.

`/bazframe info` remains compact. It reports the effective profile (or `(none)`); effective context entries labeled `(pi)` or `(bazframe)` by supplier; separate lexical lines for flat direct skills, profile library/package references, and their effective Skills; effective Pi skill-command names as one deduplicated lexical comma-separated list (or `(none)`); library/package-scoped failures when present; and deterministic live `original -> alias` mappings only when the projected alias commands are present in Pi's current command set. Pi context retains `contextFiles` order. With an active profile whose flat state is valid, Bazframe appends the profile instructions entry; when Pi reports no context it first reports the restored global context when present. A failed library or package is reported and omitted atomically without hiding the otherwise effective profile. Disabled, unresolved, or flat-profile-error states do not report an effective profile or Bazframe context.

## Safety and diagnostics

Bazframe-managed writes use validated external paths, per-resource locks, mode-restricted temporary files, and atomic filesystem operations. Selection validation and all lifecycle mutations occur under the global state lock; membership takes that lock before its profile-specific lock. Package preparation runs only after explicit add/build authorization; library snapshotting runs only after explicit add/update authorization, copies output to private staging, validates and hashes it before publication, and replaces a descriptor only after the immutable snapshot is available. Failed staging is cleaned without changing the active descriptor; unreferenced snapshot garbage collection is deferred. Duplication copies to a unique sibling staging directory without following symlinks, cleans failed staging, and publishes with a final rename. Active rename coordinates a directory rename with atomic selection replacement and rolls the directory back when selection replacement fails before commit. Adapter install and uninstall compare artifact hashes against the ownership manifest. Exceptional project overrides are external; acceptance tests preserve the worktree snapshot and Git status. Locks coordinate Bazframe writers, but a non-cooperating external process can still race pathname-based operations where portable Node lacks a conditional handle-relative API. External profile/added Skill editing is intentionally a user-owned direct write outside Bazframe locks and atomic-write guarantees; Bazframe bounds target selection with immediate physical-root/final-file validation but cannot eliminate final pathname substitution by a non-cooperating writer.

A default-enabled session validates the profile's Skills as before and reports actionable errors in both Git and non-Git directories. Library/package errors are reported at their atomic boundary: a failed object contributes no Skills, while the profile's other valid Skills remain available. An effective-disabled session retains native Pi behavior.

`bazframe status` reads and reports adapter ownership, drift, current project state and effective behavior, active-profile validity when required, flat direct Skill counts, profile library/package reference target health and snapshot digests, derived effective skill counts, library/package-scoped failures, the physical cached Pi alias count, and corrective commands. It does not discover live Pi alias mappings and never updates a library or builds a package.

## Research agenda

Product work now focuses on:

- completing deeper provider-tree navigation beyond the current library/package/Skill master-detail view;
- retaining the global library/package and typed-reference lifecycle, declared package builds, immutable snapshots, all-dependent activation validation, and snapshot-based bounded discovery;
- keeping settings/adapter writes, declared-build execution in the TUI, library update/remove, package build/remove, profile-reference mutation, additional provider operations, and provider move/rename behind their explicit ownership and lifecycle decisions;
- retaining Linux and local tmux evidence while validating Windows Terminal, representative remote SSH, terminal/font/locale width differences, and manual assistive-technology behavior before any production-ready TUI claim;
- preserving the profile's Skill-membership behavior while adding the smallest explicit library/package preparation lifecycle.

The Agent Skills specification defines no standard dependency field; it permits arbitrary additional files and string-valued `metadata`, and recommends that scripts be self-contained or clearly document dependencies. Bazframe's current product decision is to add no inter-skill dependency schema or automation: library/package providers own shared resources and runtime packages, and Bazframe does not infer dependency semantics from prose, `compatibility`, `metadata`, `allowed-tools`, sibling paths, or co-packaging. Any future namespaced validate-only sidecar requires separate interoperability evidence and an explicit product decision before schema or automation.

Skill packs, child subsets, profile export, and snapshot garbage collection remain deferred.

## Implementation plan

[`pi-adapter-production-design.md`](pi-adapter-production-design.md) records the implemented production baseline, lifecycle rules, milestones, and acceptance evidence. Executable Pi 0.82 evidence is retained in the [`pi-no-launcher-adapter` experiment](../experiments/pi-no-launcher-adapter/REPORT.md).
