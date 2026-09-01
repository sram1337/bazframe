# Bazframe 2 Product Design

> Status: current product source of truth

Bazframe composes Skills into profiles, then applies profiles to coding agents. A profile carries personal instructions, the profile's Skills, and optional exact references to global libraries and packages across working directories. Runtime adapters resolve an available Git-worktree project override, then global policy, then the file-free enabled default.

## Product direction

The first production slice integrates Bazframe with Pi through a global Pi extension. Profile selection and exceptional per-project overrides live under the user's Bazframe home, while each repository keeps its own instructions and agent resources.

The resulting flow is:

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent
npm install --global bazframe@next
bazframe adapter install pi
bazframe profile add focused
bazframe profile edit focused
bazframe profile use focused
cd my-project
pi
```

Bazframe supports Pi 0.84.4 or newer. The npm beta installs from the `next` channel; Pi, Skills, libraries, and packages retain their own distribution lifecycles.

`bazframe adapter install pi` is a one-time, explicit setup step. It copies Bazframe's packaged extension into Pi's global extension directory and records ownership metadata so Bazframe can update, repair, or safely uninstall only that artifact. Pi then discovers the extension automatically.

The user continues to invoke Pi directly. Absent global state means enabled in both Git and non-Git directories. In canonical Git worktrees, explicit project policy overrides global policy; non-Git directories have no per-directory override in this slice and inherit global policy.

## TUI direction

Bazframe's first interactive management UI is a keyboard-first terminal UI with no sidebar, launched explicitly as `bazframe tui`. Its top navigation is `Skills`, `Profiles`, `Adapters`, and `Settings`. The Skills tab presents one uninterrupted list of peer `Added Skills`, `Library <id>`, and `Package <id>` rows. Every row is collapsible into ordinary Skill rows; profile detail reports individual Skills and whole-object library/package references separately. The Profiles list is one create-first logical list ordered as current profile, inactive favorites, then remaining profiles; `f` toggles persistent favorites and `x` starts guarded profile deletion while `d` is inert. Compact layouts drill into profile details and plain-text `SKILL.md` previews with visible breadcrumbs and Esc/Backspace return. Adapter and Settings views remain read-only.

[`tui-design.md`](tui-design.md) records the implemented boundary, interaction model, safety requirements, tests, and remaining review gates. Runtime `ink@7.1.1` and `react@19.2.8` are exact pins and load lazily only after CLI dispatch to `bazframe tui`. The TUI calls typed application services rather than spawning CLI subprocesses, and explicit profile targeting never silently changes the active selection. It may add one library from a selected physical, already-prepared local source or acquire one through the remote Git lifecycle; a local root-level `bazframe-package.json` is blocked with package-command guidance, and remote Git input receives the same library validation after acquisition. Successful TUI addition executes no source code and never adds a profile reference. Package builds, library update/remove, package remove, profile-reference mutation, settings/adapter writes, and source move/rename remain outside this slice. Selected-profile instruction editing uses the same approved external-editor service as `bazframe profile edit <profile>`. The Skills preview may hand a live `(default)` source `SKILL.md` to that editor, equivalent to `bazframe skill edit <skill>`; library/package snapshots remain immutable.

Deterministic tests cover compact/resize/exit/accessibility behavior, cell-aware bounds, library-add consent, and terminal-control-neutralized previews. Real terminal gates cover alternate-screen lifecycle and same-width vertical-growth origin. This does not make the TUI production-ready. Windows Terminal, representative remote SSH, terminal/font/locale ambiguous-width differences, and manual assistive-technology evidence remain open.

## Core objects

### Skill

A **Skill** is a directory conforming to the Agent Skills specification and supplied through a configured Skill root. Bazframe consumes this standard filesystem interface from local sources or explicitly acquired remote Git sources.

Bazframe defines no second Skill format. A live source Skill in `(default)` is an **added Skill**; individually selected memberships are **a profile's Skills**. A Skill remains a Skill when contained in a library or produced by a package.

### Skill packs

Skill packs are deferred. Bazframe will not introduce pack behavior unless a later product decision expands its responsibility beyond current profile composition.

### Default added Skill catalog

The `(default)` catalog is the Bazframe-home registry for individually selectable live skills:

```text
<BAZFRAME_HOME>/skills/
└── <skill> -> /canonical/source/<skill>
```

It is the added Skill catalog, not a library or package. Libraries and packages use immutable snapshots and whole-object references. `(default)` entries remain live source directories and support individual profile membership: local-source targets remain externally owned, while remote Git sources use stable Bazframe-managed checkout paths.

### Profile

A profile combines personal instructions, the profile's Skills, and zero or more exact library and package references. Bazframe manages profile definitions, membership, selection, and application to supported coding agents. Global library/package records own source roots, activated snapshot digests, and Skills roots.

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

The profile-local `AGENTS.md` contains personal coding-agent instructions. Each of a profile's materialized Skills is a standard Skill directory, including any supporting files used by its `SKILL.md`. Each library/package reference contains one exact typed identity. The matching global record owns the source root and activated snapshot; effective Skills are derived from immutable bytes rather than mutable input.

The first slice has one global active profile selected by `bazframe profile use <profile>`. `profile add` creates a physical profile directory containing a zero-byte physical `AGENTS.md` and an empty physical `skills/` directory without activating it. `profile list` is the single rich overview: valid profiles in lexical order, active flags, selected/unselected/missing active state, and available profile commands. `profile current` remains the focused selected-ID query. Bare resources, top-level `use`, plurals, verb-first Skill lifecycle, and plural nested profile resources are rejected with exact migration guidance rather than dispatched. CLI list order is unaffected by TUI favorites.

TUI profile favorites are global preference state in the separate physical `<BAZFRAME_HOME>/profile-favorites.json` file, encoded canonically as exact schema v1 with unique lexically sorted safe profile IDs. Missing state means no favorites. Reads require a bounded physical regular file and fatal UTF-8 decoding; writes use the shared state lock and atomic state-file conventions. Malformed state is diagnosed while the dashboard projects no favorites, and favorite mutation fails without replacing it. Stored IDs for profiles that no longer physically exist are retained and diagnosed but not displayed as favorites. A valid favorite follows rename and is cleared by remove, including absent removal; duplicate does not inherit it. Malformed optional favorite state is preserved and does not block those otherwise unrelated lifecycle operations.

`profile edit <profile>` opens the named profile's actual `AGENTS.md` without changing the active selection. Immediately before launch, Bazframe revalidates the physical `profiles/` and profile directories and requires the final `AGENTS.md` entry, including an allowed user-owned final symlink, to resolve to a regular file; it deliberately does not read or runtime-validate the contents so the editor can repair invalid bytes. The first nonblank `VISUAL`, then `EDITOR`, is treated as one executable name or path—not a command string. Bazframe supplies only the absolute target path, runs with its owning directory as cwd, inherits environment and stdio, sets `shell: false`, installs no editor signal forwarding, takes no state lock, waits for the child, and returns its exit or signal status. While the editor owns a foreground terminal, a temporary no-op parent `SIGINT` handler keeps Bazframe alive so Ctrl+C reaches the editor directly; it is removed as soon as the child settles. Flags, shell expansion, persisted settings, fallback editors, temporary copies, rollback, and editor-specific wait inference are absent; fixed flags require an executable wrapper. Existing Pi sessions use `/bazframe reload` after editing.

`skill edit <skill>` applies that process contract only to a structurally valid externally owned added Skill in `(default)` and refuses remote Git checkout targets. Authorization derives from the safe skill ID and Bazframe home, not a preview path: it reopens the physical catalog, requires the expected absolute registration link, canonical external physical source root and matching basename, resolves `SKILL.md` to a regular file contained within that root, and revalidates catalog, registration, source, and file identities immediately before launch. It deliberately does not parse bytes or frontmatter, so malformed definitions remain repairable. An internal final-file symlink is allowed only when its canonical target remains within the source root. The unavoidable final pathname race against a non-cooperating source process remains. This explicit user-authorized editor launch does not transfer source artifact lifecycle ownership to Bazframe, enable `artifactWritesSupported`, or permit editing a remote Git checkout or immutable library/package snapshot; remote Git source input is edited upstream and activated with its resource-specific update command.

`profile duplicate <source> <new>` copies all content from a physical source profile without resolving children or source targets, preserves symlinks verbatim, refuses profile-root symlinks and occupied destinations, leaves the active selection unchanged, and publishes the new profile only after a complete staged copy. `profile rename <old> <new>` preserves profile content without resolving its children or source targets, refuses symlink roots and replacement, and updates the active selection when renaming the active profile. `profile remove <id>` always refuses the active profile, even when its directory is missing. Without `--force`, removal accepts only the exact generated-empty shape; `--force` is explicit authorization to recursively delete a non-active physical profile. Recursive deletion unlinks membership symlinks without following or mutating source targets. Actual profile creation, duplication, removal, and identity-changing rename clear disposable alias cache for affected new or existing IDs; idempotent add and same-ID rename preserve live cache. Lifecycle mutations use the global state lock before any profile-specific lock and apply to Pi on the next startup or `/reload`.

A profile's Skills are managed canonically with `bazframe profile skill add [--profile <profile>] <skill>` and `bazframe profile skill remove [--profile <profile>] <skill>`. Omission targets the active profile; an explicit target changes that profile without changing or requiring the active selection. Mutations always report the resolved profile ID and whether it came from active selection or an explicit option. `bazframe profile skill list` is active-profile-only; it does not accept `--profile`. Pi remains authoritative for full runtime validation. Packs are outside the current scope.

### Profile portability

Stage 3 profile export and import, including package portability, are live on macOS and Linux. This is not Windows support or full profile portability. A reviewable export directory contains canonical `bazframe-profile.json` plus the profile's physical `profile/AGENTS.md`; it is not a raw home/profile copy, archive, source bundle, or snapshot transfer. The declaration captures portable profile contents and resource dependencies plus required sorted `omittedLocalSkills`. Only direct Skills acquired from remote Git sources are included. A healthy local direct Skill whose profile link exactly matches its same-ID added Skill produces a deterministic terminal-safe warning, is omitted, and has its ID permanently recorded; direct Skills have no local mapping. A broken or mismatched profile Skill link, or a Skill under a Bazframe-managed checkout path without matching provenance, causes export to fail without publishing an artifact. Source composition validation still includes omitted direct Skills. Whole-library and package references are exact typed resources and may come from remote Git or a healthy local source. A healthy local library or package exports path-free as exactly `{ "type": "localMapping" }`, with no source-machine root or snapshot digest. A path-free remote Git requirement is the normalized `remote`, credential-free `fetchUrl`, `branch`, and exact `revision` copied without network lookup from existing provenance. No source tree or activated snapshot is copied. Bazframe warns that exported `profile/AGENTS.md` may contain secrets because user-authored instructions are not redacted.

Import always inspects the artifact and displays a plan first. By default it creates or reuses exact healthy included global resources and publishes the composed profile last; resource order is direct Skills, libraries, then packages, lexical within each kind. `--map (library|package):<id>=<absolute-source-directory>` is a repeatable typed option and each declared local resource requires exactly one physical, basename-matching mapping. Local direct Skills have no mapping. `--dry-run` takes no Bazframe write lock and performs no Bazframe writes, network access, builds, prompts, or active-profile mutation. Included direct Skills become or reuse `(default)` registrations; library/package children remain children and never enter `(default)`. Occupied mismatches fail; import requests no replacement, merge, update, repointing, or implicit rename within the documented portable final-syscall race. `--as` changes only the destination profile ID. An absent destination whose ID is already stored in `active-profile` is blocked so publication cannot activate it implicitly.

Remote Git import acquires the exported branch-reachable historical revision exactly and fails rather than substituting current branch HEAD. An exact healthy package reuse is offline, build-free, report-free, prompt-free, and consent-free. A new package build is authorized only against an immediate exact report of package and source identity, candidate root, working directory, literal argv, manifest path and SHA-256, artifact and Skills roots, `shell: false`, inherited environment, and unsandboxed `current-process-user` authority with possible credential, network, and user-file access. Arbitrary build effects are not rollbackable. Interactive authorization accepts only literal `y` and otherwise declines by default; `--yes` authorizes every revalidated exact report noninteractively and is invalid with `--dry-run`.

Multi-resource import is resumable forward rather than globally atomic. A healthy resource committed before a later failure remains globally available and possibly unreferenced; the profile is not visible until every dependency and the complete prospective composition validate. Outcomes distinguish `created`, `reused`, `not-created`, `recovery-required`, and `commit-ambiguous`; users inspect recovery or ambiguous state and retry, which recomputes the plan and converges through exact reuse. Active selection remains unchanged, including when an exact pre-existing active destination is reused.

[`profile-portability-design.md`](profile-portability-design.md) defines the complete contract. The production Stage 3 package limits are a 64 KiB manifest, at most 64 argv entries, 4 KiB per argument and 16 KiB aggregate argv, 4,096 UTF-8 bytes per package path, a 30-minute build deadline, and a 5-second termination grace. Artifact and snapshot limits remain independently enforced. JSON package reports intentionally omit environment names/values and private filesystem device/inode evidence; local mapping roots are explicit user input and remain visible. Focused Stage 3 implementation and installed-package acceptance, aggregate `npm test`, real-Pi, final pack inspection, and independent final reviews pass. Windows filesystem/privacy validation and the broader hostile/full-portability acceptance gate remain open.

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
- A library/package reference resolves only its global object's activated Bazframe snapshot; mutable source input is preparation-time state, not runtime state.
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

This structured signal gives the adapter one bounded rule for both invocations. For supported Pi versions, the exact appended form is the incoming Pi `systemPrompt`, two LF characters, and the profile section. When `contextFiles` is empty and a global Pi instruction file exists, the appended portion is the global section, two LF characters, then the profile section. Sections use `<bazframe_global_instructions path="…">` or `<bazframe_profile_instructions path="…">`, followed by LF, the instruction body unchanged, LF, and the matching closing tag. Attribute paths escape `&`, `"`, `<`, and `>` as `&amp;`, `&quot;`, `&lt;`, and `&gt;`; bodies are not escaped or interpreted.

This order and encoding are a transport/provenance contract, not semantic precedence. `pi -nc` omits repository instruction context because the user selected Pi's suppression mode, not because Bazframe resolved a contradiction. Detailed semantics are recorded in [`pi-adaptive-context-adapter.md`](pi-adaptive-context-adapter.md).

## Skills

For the first production slice, Bazframe discovers profile membership from the profile directory, validates skill resources through Pi's Agent Skills loader, exposes them to the runtime, projects collision aliases, and reports diagnostics.

Bazframe's built-in added Skill catalog is `(default)`, rooted at `<BAZFRAME_HOME>/skills`. Each entry `<skill>` is an absolute symlink to one canonical physical Skill root. The canonical target basename and declared frontmatter `name` must exactly equal the safe skill ID. Local-source targets remain externally owned; remote Git sources use an exact recorded checkout under `<BAZFRAME_HOME>/providers/git/checkouts/skill/`. Source changes are live on the next Pi startup or `/bazframe reload`.

`bazframe skill add <absolute-root-or-git-source>` adds one structurally validated Skill to `(default)`. An absolute path retains the existing local-source ownership contract. A remote Git source acquires a root Skill at its stable Bazframe-managed checkout path and records exact provenance before catalog publication. The same verified target is idempotently current; occupied, broken, malformed, dirty, or mismatched state is rejected. Paths inside `BAZFRAME_HOME` are accepted only when exact remote Git source provenance proves their identity. `bazframe skill remove <skill>` removes only the catalog link, is absent-idempotent, and refuses every valid profile dependency or unverifiable reference index. A broken absolute registration remains removable only after all literal-target profile memberships are gone. These lifecycles hold the global state lock, revalidate immediately before publication or unlink, and retain the documented final-syscall race against non-cooperating writers.

`bazframe skill list` lists only valid added Skills in lexical order with their external targets and diagnostics. Skills from libraries/packages and Pi-native Skills are not part of this catalog.

`bazframe profile skill add [--profile <profile>] <skill>` resolves the named added Skill and creates a parallel absolute symlink under `profiles/<id>/skills/` directly to the same canonical source target—never a link chain. Removal accepts only an exact parallel link matching the current `(default)` entry. Both operations are idempotent, preserve source content, and take the state lock before the profile membership lock. Bazframe refuses physical, relative, foreign, mismatched, or non-added entries. A missing add target offers bounded suggestions from valid added Skills.

Existing physical profile Skill directories and foreign links remain runtime-readable but are not managed by the membership commands. Updates to Skills from remote Git sources preserve the stable target path, so catalog and profile links continue to agree. Skills from remote Git sources are edited upstream and activated with `skill update`. There is no source-specific environment reader, release migration, copy fallback, or Windows link fallback. Libraries and packages remain separate immutable-snapshot objects with whole-object profile references.

Bazframe ships two product-owned Agent Skills from tracked source to generated npm artifacts: the `bazframe` self-management documentation Skill at `dist/skills/bazframe/` and the `bazify` source helper at `dist/skills/bazify/`. The npm package carries only the generated copies. A global installation root can be resolved as `$(npm root --global)/bazframe`; either Skill can then be added explicitly through `bazframe skill add <package-root>/dist/skills/<skill>`. Build and installation perform no acquisition or membership changes.

`bazify` packages one selected local physical Skill or Skill collection with source content under `skills/`, a generated `dist/skills/` artifact, and exact build argv `node scripts/bazify-build.mjs`. `create` accepts explicit Skill roots or one root Skill/immediate `skills/` collection, extracts only the selected Skill trees into a new package, defaults singleton IDs to the Skill name and collection IDs to the source-root name, defaults the destination to `~/<id>`, and requires `--name` for several explicit roots. `adapt` adds the manifest, build script, and ignore entries to a dedicated root-Skill or immediate-collection repository; Git repositories must be clean top-levels, existing source and Git bytes remain externally owned, exact generated state is current, and failed adaptation restores the previous files and artifact. Both routes reject overlap, duplicate names, links, special entries, basename/frontmatter mismatch, source drift, and obvious credential material; the generated multi-Skill build uses stable no-follow reads and transactional artifact replacement. Validation calls `package add` under a disposable `BAZFRAME_HOME`. Semantic requirements, provenance, licensing, privacy, and publication review use the local task convention under `./bazframe/` or a cleaned-up temporary checklist. Private publication applies to new non-Git packages, binds approval to `github.com`, account, repository, canonical path, and publishable bytes, verifies the final Git index, and uses fixed shell-free `git`/`gh` argv. Adapted repositories continue through their existing Git workflow. Bazify does not mutate Bazframe catalog/profile state.

Profile skills enter Pi through `resources_discover`.

Profile-set duplicates are resolved before runtime projection and never receive aliases. Duplicate Pi-loaded names among a profile's Skills invalidate the complete profile. A prospective library update or package build that introduces a duplicate is rejected before activation. For already-active references, the complete conflicting library/package contribution is withheld while its records and references remain intact; unrelated Skills remain effective. Bazframe does not infer semantic or dependency incompatibility among differently named Skills.

At the Pi boundary, any pre-existing Pi command with `source === "skill"` occupies its `skill:<name>` command; Bazframe does not claim finer ownership provenance. A profile skill keeps its original name when it is free. On a collision, the pre-existing Pi skill-command occupant keeps that name and Bazframe tries exactly one deterministic profile alias. The ordinary alias is:

```text
<name>-x-bazframe
```

The complete alias is limited to 64 characters. When necessary, the Pi adapter truncates the original base to leave room for `-x-bazframe` and removes trailing hyphens from that truncated base before adding the suffix. The alias wrapper points to the original skill file and base directory and preserves the profile skill's description and `disable-model-invocation` setting.

The alias is used only when its generated name is free from pre-existing Pi skill commands, every profile skill's original name, and aliases generated earlier in the same projection. An occupied generated alias is a visible Pi projection error: Bazframe returns no profile skill paths for that projection and does not replace the occupant or try another suffix. Successful aliases are runtime cache under `adapter-cache/pi`; they do not rename or mutate stored profile identity.

Pi 0.84.4 is the minimum supported runtime; the adapter supports newer Pi releases through the same public extension contract. A future coding-agent adapter must define and test its instruction order and provenance, loader compatibility, runtime command namespace, duplicate behavior, and collision projection. It may expose both definitions under adapter-specific deterministic reported names or fail visibly, but it cannot silently drop or overwrite either definition, mutate the profile skill's identity, or persist a runtime alias into the portable profile.

## Skill libraries, Skill packages, and profile composition

A **Skill library** is an already-prepared physical directory containing zero or more Skills. Bazframe never executes source code for a library. A **Skill package** is a buildable project with a required `bazframe-package.json`; an explicit package add or build produces an artifact containing a Skills root and optionally shared resources. Every discovered child is simply a Skill.

Both objects use immutable content-addressed snapshots and whole-object profile references. The typed identity is `(library, id)` or `(package, id)`, where the ID is exactly `basename(realpath(root))` and satisfies the safe lowercase hyphenated ID rules. A library and package may share an ID. Same-kind occupancy is rejected without normalization.

### Persistence

```text
<BAZFRAME_HOME>/libraries/<library>.json
<BAZFRAME_HOME>/packages/<package>.json
<BAZFRAME_HOME>/profiles/<profile>/libraries/<library>.json
<BAZFRAME_HOME>/profiles/<profile>/packages/<package>.json
<BAZFRAME_HOME>/skill-snapshots/sha256/<digest>/{manifest.json,artifact/}
<BAZFRAME_HOME>/providers/git/checkouts/<kind>/<id>/
<BAZFRAME_HOME>/providers/git/records/<kind>/<id>.json
<BAZFRAME_HOME>/providers/git/{staging,recovery}/
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

### Remote Git acquisition

The public source kinds are **local source** and **remote Git source**. “Managed” describes Bazframe-managed checkout/state; it is not a source kind. User-facing documentation, diagnostics, and portability artifacts must use source terminology rather than calling a source a provider.

The resource-specific add forms accept a canonical absolute path or a remote Git source:

```text
bazframe skill add <absolute-root-or-git-source>
bazframe library add <absolute-root-or-git-source>
bazframe package add [--yes] <absolute-root-or-git-source>
```

`git:<owner>/<repository>` identifies GitHub. Credential-free HTTPS and `ssh://` URLs identify explicit remotes. Parsing rejects embedded secrets, query/fragment data, local/file and SCP-like forms, option-shaped values, and unsafe repository IDs. GitHub shorthand uses authenticated `gh repo clone` when available and Git HTTPS otherwise; explicit URLs use Git. Child processes receive literal argv without a shell. Authentication remains in Git/GitHub CLI and is absent from persisted provenance and diagnostics.

A clone first receives objects without checkout. Bazframe verifies normalized origin identity, discovers the remote default branch and full commit, then materializes the detached commit with hooks and configured content filters disabled. Exact schema-v1 provenance records `kind`, `id`, canonical Bazframe-managed checkout `root`, credential-free normalized `remote` and `fetchUrl`, selected `transport`, `branch`, and full `revision`. A Skill requires a matching root `SKILL.md`; a library uses the build-free library contract; a package requires the exact package declaration.

Remote package manifest inspection precedes build authorization. Bazframe reports remote identity, full revision, Bazframe-managed checkout path, literal build argv, and the ordinary-authority unsandboxed boundary. Interactive confirmation defaults to decline; non-interactive callers use `--yes`. An already-current add is network-free and skips build authorization after verifying provenance, origin, branch, revision, clean checkout, Bazframe-managed checkout path, resource record/link, and activated snapshot.

Remote Git updates are resource-specific:

```text
bazframe skill update [--accept-rewrite] <skill>
bazframe library update [--accept-rewrite] <library>
bazframe package update [--accept-rewrite] [--yes] <package>
```

An update clones the recorded branch into Bazframe-managed staging and requires the previous revision to be its ancestor. `--accept-rewrite` authorizes a reviewed non-fast-forward change. Skill links retain their stable target path. Library/package activation reuses complete candidate and dependent-profile validation; `package update` authorizes and builds the candidate, while `package build` rebuilds the recorded remote Git revision without network access. Profile selection and references remain separate operations.

The global state lock serializes source publication, provenance, resource activation, update, build cleanup, and remote Git removal. Journals record the operation phase, credential-free remote, branch, revisions, stable root, staging, and backup paths before multi-file changes. A caught pre-activation failure restores the prior source checkout, provenance, snapshot record, and registration; cleanup removes only identity-proven owned files and directories. Interrupted or unprovable cleanup remains under the named recovery path. `bazframe status` reports the retained record, stopped operation, and operation-specific retry guidance. Recovery is inspect-first and fail-closed. For add, update, and build, inspect the recorded root, staging, backup, provenance, and active resource; restore them to one consistent revision; then remove the recovery record before retrying. A stopped remote Git removal retains the exact source revision, transport, and pre-removal resource-state hash; after inspection, retry the listed remove command with the recovery record present so Bazframe can verify any surviving resource, checkout, and provenance before completing forward cleanup.

Resource removal keeps the existing reference checks. Removing a resource acquired from a remote Git source also removes its identity-proven Bazframe-managed checkout and provenance under the same global transaction; the upstream remote remains available. Local-source input retains its existing preservation contract.

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

`build` is a nonempty literal argv array. Bazframe executes it directly with `shell: false`, inherited environment and stdio, and the package root as cwd. `artifactRoot` is relative to the package root; `skillsRoot` is relative to the artifact root. The complete artifact root is snapshotted, preserving shared resources, while discovery begins only at the Skills root. Missing, malformed, symlinked, or changed declarations fail activation. Package builds are unsandboxed and may modify source-owned output.

A library has no declaration and uses its root as both artifact root and Skills root. `library add` and `library update` execute nothing. A library root containing `bazframe-package.json` is rejected with package guidance.

### Commands and transactions

```text
bazframe library list
bazframe library add <absolute-root-or-git-source>
bazframe library update [--accept-rewrite] <library>
bazframe library remove <library>
bazframe package list
bazframe package add [--yes] <absolute-root-or-git-source>
bazframe package build <package>
bazframe package update [--accept-rewrite] [--yes] <package>
bazframe package remove <package>
bazframe profile library list
bazframe profile library add [--profile <profile>] <library>
bazframe profile library remove [--profile <profile>] <library>
bazframe profile package list
bazframe profile package add [--profile <profile>] <package>
bazframe profile package remove [--profile <profile>] <package>
```

These singular forms are canonical; plural resources and `sources` commands do not dispatch. Library add performs the initial snapshot and activation; library update activates a later local tree or acquires a remote Git revision. Package add performs the initial declared build and activation; package build rebuilds the current source revision; package update acquires, builds, and activates a remote Git revision. Profile reference changes never update a library, build a package, or select child Skills. Removal is refused while referenced.

Candidate activation validates the complete object and every referencing profile before atomically replacing its record. Any failure preserves the previous digest for all profiles. Reference-index uncertainty fails closed. Valid zero-Skill libraries and packages remain healthy and visible.

Discovery retains lexical bounded traversal, no-follow containment, physical entries, `.git`/`node_modules` discovery skips, root-versus-descendant exclusion, and authoritative loading through Pi's public Agent Skills loader. Duplicate names within one object reject activation. A profile Skill wins over a colliding referenced object and the complete conflicting object contribution is withheld. Library/package collisions withhold every involved object contribution while unrelated Skills remain effective. Stored collisions never receive aliases.

The TUI presents `Added Skills`, `Library <id>`, and `Package <id>` as collapsible peers in one Skills list without category sections. It can add an already-prepared local library or acquire a library from a remote Git source after explicit consent; package add/build remains CLI-only. Library/package Skill previews are immutable and direct the user to edit source input, then run `library update` or `package build`.


## Ownership

| Owner | Resources |
|---|---|
| User | profile content and instructions, library/package source choices, explicit selection/build consent, and source inputs; `profile remove --force` authorizes Bazframe to delete only the named non-active physical profile content |
| Skill/library/package source owners | upstream bytes, dependency and build declarations, publication, credentials, and child-command behavior |
| Bazframe | explicit remote Git acquisition/provenance/update/recovery; profile lifecycle operations, profile Skill membership links, global library/package objects, typed profile references, declared package-build execution, prepared-artifact staging, immutable content-addressed snapshots, all-dependent atomic activation, referenced-delete refusal, snapshot validation and child derivation, profile selection and resolution, runtime projection, active-profile state, global policy, project overrides, adapter manifest, installed adapter artifact, diagnostics, and generated alias cache |
| Repository | worktree files and project instructions |
| Pi | settings, trust decisions, tools, models, extensions, packages, prompts, themes, system-prompt files, native skills, and execution |

This ownership model lets Bazframe freeze selected library/package artifacts before composition while remote Git acquisition remains an explicit Bazframe operation and runtime capabilities remain source-defined.

## Commands

The canonical first production command surface uses singular noun-verb namespaces and explicit queries:

```text
bazframe profile list | current | add | duplicate | remove | rename | use | edit | export | import
bazframe skill list | add | remove | update | edit
bazframe library list | add | update | remove
bazframe package list | add | build | update | remove
bazframe profile skill list | add | remove
bazframe profile library list | add | remove
bazframe profile package list | add | remove
bazframe project list | enable | disable
bazframe global show | enable | disable
bazframe adapter list | install pi | uninstall pi
bazframe status
bazframe tui
```

Canonical help places options before operands, for example `profile remove [--force] <profile>`, `profile skill add [--profile <profile>] <skill>`, and `package update [--accept-rewrite] [--yes] <package>`. Known options parse before or after operands, and `--profile=<profile>` is accepted.

The live Stage 3 portability grammar is:

```text
bazframe profile export <profile> --output <directory>
bazframe profile import [--json] [--as <profile>] [--map (library|package):<id>=<absolute-source-directory>]... [--dry-run | --yes] <directory>
```

`--map` is repeatable and typed, supplying one explicit source directory for each artifact-declared local library or package. Local direct Skills cannot be mapped. `--yes` authorizes exact new-package build reports noninteractively and cannot be combined with `--dry-run`; without it, interactive input accepts only literal `y` and defaults to decline.

Bare singular resources, old plurals, verb-first Skill lifecycle, top-level `use`, and plural nested profile resources fail with `CLI_MIGRATION_REQUIRED` and a complete terminal-safe replacement; they are not aliases. Unknown or malformed input uses `CLI_USAGE`. `bazframe pi` remains only as the deprecated launcher. Root help stays intentionally small and points to singular help topics.

One exact `--json` before Pi's literal `--` selects the CLI-only schema-v1 protocol for supported queries, mutations, and errors. Success is `{schemaVersion:1,ok:true,command,result,diagnostics}`; error is `{schemaVersion:1,ok:false,command,error,diagnostics}`. Exactly one newline-terminated JSON document is written to stdout. Diagnostics are structured; operational errors preserve stable Bazframe codes; unexpected failures use `INTERNAL_ERROR` without stack, cause, class, terminal escapes, or credentials. A completed blocked import dry-run is successful inspection with the complete blocked plan; blocked execution fails with `error.plan`, and later execution failure includes exact `error.partialResult` outcomes and retry diagnostics. Status attention remains `ok:true` with health `attention` and exit 3. Help, version, TUI, external editors, and deprecated Pi reject JSON with `CLI_JSON_UNSUPPORTED` before side effects. JSON package-process stdout and stderr both route to parent stderr while stdin remains inherited. Package add/update from a remote Git source requires `--yes` before acquisition, prompting, or build. The DTO transport is internal CLI surface and adds no public JavaScript export.

CLI color is presentation-only and never affects JSON.

Adapter installation is explicit and orthogonal to global/project policy. Global and project disable operations require neither adapter nor profile. Global enable validates runtime setup before removing disabled state. Project enable validates runtime setup because it makes the current worktree effective-enabled, including when it overrides global disable. Profile Skill add/remove mutate only that profile's Skills. Library add/update and package add/build explicitly activate snapshots; profile library/package add/remove changes references only. These resources use only the singular CLI namespaces. The TUI exposes only consent-bound local or remote-Git library add; package builds and every other collection/reference mutation remain CLI-only.

For adapter installation, `--force` repairs a drifted artifact only when a valid Bazframe ownership manifest identifies the destination. For `profile remove`, `--force` separately authorizes deletion of all content under the named non-active physical profile; it never extends authority to symlink targets.

Inside Pi, the adapter registers exactly one namespaced command: `/bazframe info` or `/bazframe reload`. `/bazframe reload` awaits Pi's reload operation, which reloads extensions, policy, profiles, skills, and context. Bare, unknown, or extra arguments show `Usage: /bazframe info | /bazframe reload` without reloading.

`/bazframe info` remains compact. It reports the effective profile (or `(none)`); effective context entries labeled `(pi)` or `(bazframe)` by supplier; separate lexical lines for flat direct skills, profile library/package references, and their effective Skills; effective Pi skill-command names as one deduplicated lexical comma-separated list (or `(none)`); library/package-scoped failures when present; and deterministic live `original -> alias` mappings only when the projected alias commands are present in Pi's current command set. Pi context retains `contextFiles` order. With an active profile whose flat state is valid, Bazframe appends the profile instructions entry; when Pi reports no context it first reports the restored global context when present. A failed library or package is reported and omitted atomically without hiding the otherwise effective profile. Disabled, unresolved, or flat-profile-error states do not report an effective profile or Bazframe context.

## Safety and diagnostics

Bazframe-managed writes use validated external paths, per-resource locks, mode-restricted temporary files, and atomic filesystem operations. Selection validation and all lifecycle mutations occur under the global state lock; membership takes that lock before its profile-specific lock. Package preparation runs only after explicit add/build authorization; library snapshotting runs only after explicit add/update authorization, copies output to private staging, validates and hashes it before publication, and replaces a descriptor only after the immutable snapshot is available. Failed staging is cleaned without changing the active descriptor; unreferenced snapshot garbage collection is deferred. Duplication copies to a unique sibling staging directory without following symlinks, cleans failed staging, and publishes with a final rename. Active rename coordinates a directory rename with atomic selection replacement and rolls the directory back when selection replacement fails before commit. Adapter install and uninstall compare artifact hashes against the ownership manifest. Exceptional project overrides are external; acceptance tests preserve the worktree snapshot and Git status. Locks coordinate Bazframe writers, but a non-cooperating external process can still race pathname-based operations where portable Node lacks a conditional handle-relative API. External profile/added Skill editing is intentionally a user-owned direct write outside Bazframe locks and atomic-write guarantees; Bazframe bounds target selection with immediate physical-root/final-file validation but cannot eliminate final pathname substitution by a non-cooperating writer.

A default-enabled session validates the profile's Skills as before and reports actionable errors in both Git and non-Git directories. Library/package errors are reported at their atomic boundary: a failed object contributes no Skills, while the profile's other valid Skills remain available. An effective-disabled session retains native Pi behavior.

`bazframe status` reads and reports adapter ownership, drift, current project state and effective behavior, active-profile validity when required, flat direct Skill counts, profile library/package reference target health and snapshot digests, derived effective skill counts, library/package-scoped failures, the physical cached Pi alias count, and corrective commands. It does not discover live Pi alias mappings and never updates a library or builds a package.

## Research agenda

Product work now focuses on:

- completing deeper source-tree navigation beyond the current library/package/Skill master-detail view;
- retaining the global library/package and typed-reference lifecycle, declared package builds, immutable snapshots, all-dependent activation validation, and snapshot-based bounded discovery;
- keeping settings/adapter writes, declared-build execution in the TUI, library update/remove, package build/remove, profile-reference mutation, additional source operations, and source move/rename behind their explicit ownership and lifecycle decisions;
- retaining Linux and local tmux evidence while validating Windows Terminal, representative remote SSH, terminal/font/locale width differences, and manual assistive-technology behavior before any production-ready TUI claim;
- implementing reviewable profile portability through exact first-class resource materialization, an inspect-first execution plan with `--dry-run`, separate package-build consent, and inactive atomic profile publication;
- preserving the profile's Skill-membership behavior while adding the smallest explicit library/package preparation lifecycle.

The Agent Skills specification defines no standard dependency field; it permits arbitrary additional files and string-valued `metadata`, and recommends that scripts be self-contained or clearly document dependencies. Bazframe's current product decision is to add no inter-skill dependency schema or automation: library/package source owners own shared resources and runtime packages, and Bazframe does not infer dependency semantics from prose, `compatibility`, `metadata`, `allowed-tools`, sibling paths, or co-packaging. Any future namespaced validate-only sidecar requires separate interoperability evidence and an explicit product decision before schema or automation.

Skill packs, child subsets, and snapshot garbage collection remain deferred.

## Implementation plan

[`profile-portability-design.md`](profile-portability-design.md) records the approved next-feature contract and staged implementation gates. [`pi-adapter-production-design.md`](pi-adapter-production-design.md) records the implemented Pi production baseline, lifecycle rules, milestones, and acceptance evidence.
