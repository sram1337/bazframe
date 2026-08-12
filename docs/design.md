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

[`tui-design.md`](tui-design.md) records the implemented boundary, interaction model, safety requirements, tests, and remaining review gates. Runtime `ink@7.1.1` and `react@19.2.8` are exact pins and load lazily only after CLI dispatch to `bazframe tui`. Deterministic tests cover compact/resize/exit/accessibility behavior and cell-aware bounds; a real macOS pseudo-terminal smoke covers alternate-screen entry/restoration; and the packed-package gate includes an interactive smoke when `script` is available. This does not make the TUI production-ready. The implemented shell keeps active top-tab state separate from a keyboard-focused top-tab cursor and body/pane focus, and reducer-owned per-view viewport offsets preserve stable-row visibility across navigation, refresh, routing, tab changes, and resize. Schema-v1 source identity and broken-root removal remain the implemented CLI baseline; schema-v2 preparation/build mutation has no TUI surface in this slice. Editor launch, settings writes, additional real sources, and provider move/rename remain open. Automated evidence covers macOS direct-PTY/local-tmux and Linux arm64 digest-pinned-base container direct-PTY/tmux/loopback-SSH, with Linux package/tool versions recorded per run. The local installed-tarball tmux gate now also proves actual Ink render-error rejection with exit `1`, diagnostic and terminal restoration/cleanup, plus `80x24`/`60x16` CJK, combining-mark, emoji-ZWJ, ANSI-SGR, and long-unbroken-path cell bounds. Windows Terminal, representative remote SSH, terminal/font/locale ambiguous-width differences, and manual assistive-technology evidence remain open.

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

The profile-local `AGENTS.md` contains personal coding-agent instructions. Each materialized flat skill is an Agent Skills-compatible directory, including any supporting files used by its `SKILL.md`. Source-unit descriptors identify provider inputs and Bazframe-owned immutable snapshots; effective child skills are derived from the activated snapshot rather than the mutable provider input.

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
- A schema-v2 source membership resolves only its activated Bazframe snapshot; mutable provider input is preparation-time state, not runtime state.
- Build execution requires explicit add/build command intent and never occurs while resolving the effective harness.
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

This structured signal gives the adapter one bounded rule for both invocations. For supported Pi 0.82.x, the exact appended form is the incoming Pi `systemPrompt`, two LF characters, and the profile section. When `contextFiles` is empty and a global Pi instruction file exists, the appended portion is the global section, two LF characters, then the profile section. Sections use `<bazframe_global_instructions path="…">` or `<bazframe_profile_instructions path="…">`, followed by LF, the instruction body unchanged, LF, and the matching closing tag. Attribute paths escape `&`, `"`, `<`, and `>` as `&amp;`, `&quot;`, `&lt;`, and `&gt;`; bodies are not escaped or interpreted.

This order and encoding are a transport/provenance contract, not semantic precedence. `pi -nc` omits repository instruction context because the user selected Pi's suppression mode, not because Bazframe resolved a contradiction. Detailed semantics are recorded in [`pi-adaptive-context-adapter.md`](pi-adaptive-context-adapter.md).

## Skills

For the first production slice, Bazframe discovers profile membership from the profile directory, validates skill resources through Pi's Agent Skills loader, exposes them to the runtime, projects collision aliases, and reports diagnostics.

Skillbook owns skill acquisition, copying into its library, versioning, updating, publication, and deletion. Bazframe owns only profile membership. The approved first membership slice resolves Skillbook's library from `SKILLBOOK_LIBRARY`, then the deprecated `SKILLBOOK_LOCK_LIBRARY`, then `~/.skillbook`.

`bazframe skills` and its singular alias `bazframe skill` list valid, directly addable skills in the resolved Skillbook library. The overview identifies the resolved source, uses lexical order, reports invalid neighbors as warnings, and does not include Pi-native or profile-only skills.

`bazframe profile skills add <skill> [--profile <profile>]` adds the named Skillbook skill to the active or explicitly targeted profile as an absolute directory symlink under `profiles/<id>/skills/`. `bazframe profile skills remove <skill> [--profile <profile>]` removes only that verified membership symlink. Both commands are idempotent and must preserve Skillbook's skill directory and lockfile. Bazframe refuses physical entries, foreign or mismatched symlinks, replacement, copy fallback, and unsafe names. The Skillbook directory ID must match the skill's declared Agent Skills name. Membership-time parsing validates only that identity; Pi's Agent Skills loader remains authoritative for the complete schema when the skill enters a session. A missing add target compares its safe ID with valid available skills and offers bounded edit-distance suggestions before pointing to `bazframe skills`.

Existing physical profile skill directories remain readable for compatibility but are not managed by these commands. Packs, manifests, export, and Windows link fallback are outside this slice.

Profile skills enter Pi through `resources_discover`.

Profile-set duplicates are resolved before runtime projection and never receive aliases. Duplicate Pi-loaded names among flat memberships invalidate the complete profile. A prospective source add/build that introduces a duplicate is rejected before activation. For already-active source memberships, a flat/derived conflict preserves the flat skill and atomically withholds the complete derived source unit; a source/source conflict atomically withholds every involved source unit; unrelated valid flat skills and source units remain effective. The exact per-definition `duplicate-name` records and within-source behavior are specified in the snapshot discovery contract below. Bazframe does not infer semantic or dependency incompatibility among differently named skills.

At the Pi boundary, any pre-existing Pi command with `source === "skill"` occupies its `skill:<name>` command; Bazframe does not claim finer ownership provenance. A profile skill keeps its original name when it is free. On a collision, the pre-existing Pi skill-command occupant keeps that name and Bazframe tries exactly one deterministic profile alias. The ordinary alias is:

```text
<name>-x-bazframe
```

The complete alias is limited to 64 characters. When necessary, the Pi adapter truncates the original base to leave room for `-x-bazframe` and removes trailing hyphens from that truncated base before adding the suffix. The alias wrapper points to the original skill file and base directory and preserves the profile skill's description and `disable-model-invocation` setting.

The alias is used only when its generated name is free from pre-existing Pi skill commands, every profile skill's original name, and aliases generated earlier in the same projection. An occupied generated alias is a visible Pi projection error: Bazframe returns no profile skill paths for that projection and does not replace the occupant or try another suffix. Successful aliases are runtime cache under `adapter-cache/pi`; they do not rename or mutate stored profile identity.

Only Pi 0.82.x has an implemented and evidenced adapter contract. A future adapter must define and test its instruction order and provenance, loader compatibility, runtime command namespace, duplicate behavior, and collision projection. It may expose both definitions under adapter-specific deterministic reported names or fail visibly, but it cannot silently drop or overwrite either definition, mutate the profile skill's identity, or persist a runtime alias into the portable profile.

## Provider-neutral source-unit preparation and composition

[Stage 1 and Stage 2](research/provider-neutral-nested-source-unit-composition.md) demonstrated bounded composition from externally prepared roots; those historical experiments remain evidence for discovery and Pi projection, not a permanent ownership constraint. The product now also gives Bazframe an explicit preparation boundary: a selected provider input may declare one build, Bazframe runs that build only when asked, snapshots the resulting artifact into immutable content-addressed storage, and projects skills from the activated snapshot. Selecting a source consents to its declared build running with ordinary user-process authority. This is the same fundamental code-execution trust already present when a user invokes a skill; it is not a claim of sandboxing.

Build execution is never implicit in inspection or runtime loading. It occurs only during `profile sources add` and the explicit `profile sources build` command, never during `status`, profile/source overview, Pi startup, `/bazframe reload`, or child-skill invocation. Acquisition of the provider input, publication, credentials, mutable runtime data, and child-command execution remain outside this slice.

### Direct membership and persistence

A profile may have zero or many direct source-unit memberships in the namespace `profiles/<profile>/source-units/`, which is intentionally distinct from flat `profiles/<profile>/skills/`. Existing profiles need no migration: an absent `source-units/` directory means zero source-unit memberships, and all flat Skillbook behavior remains unchanged.

Each membership is one Bazframe-owned JSON descriptor at:

```text
profiles/<profile>/source-units/<providerId>/<sourceId>.json
```

The implemented schema-v1 descriptor records a live `sourceRoot`. It remains valid only for removal and migration: runtime reporting marks it `build-required`, and `profile sources build` upgrades it through preparation rather than projecting its live bytes.

Schema version 2 has exactly these fields:

```json
{
  "schemaVersion": 2,
  "providerId": "provider-id",
  "sourceId": "source-id",
  "sourceRoot": "/canonical/absolute/provider-input",
  "snapshotDigest": "<lowercase-sha256>",
  "sourceUnitRoot": "source-unit"
}
```

`providerId` and `sourceId` are each 1–64 lowercase ASCII letters or digits separated by single hyphens, and they must match the descriptor path. `sourceRoot` is the canonical physical provider input used only by add, explicit rebuild, and shallow rebuild-availability reporting. `snapshotDigest` is exactly 64 lowercase hexadecimal characters and selects Bazframe's immutable content-addressed artifact snapshot. `sourceUnitRoot` selects the directory within that snapshot's `artifact/` tree from which runtime discovery begins. Missing provider input does not invalidate an existing snapshot; it only prevents a later build.

A provider input may contain one physical regular non-link `bazframe-source.json` at its root:

```json
{
  "schemaVersion": 1,
  "build": ["npm", "run", "build"],
  "artifactRoot": "dist",
  "sourceUnitRoot": "source-unit"
}
```

The build manifest is absent only when opening it fails with `ENOENT`; any present entry must be the physical regular non-link file above. The manifest is exact and contains no extra fields. `build` is a nonempty literal argv array of nonempty strings, executed directly without a shell with the provider input as CWD. Build-manifest `artifactRoot`, build-manifest `sourceUnitRoot`, and schema-v2 descriptor `sourceUnitRoot` use the same grammar: a value is either the literal `.` root sentinel or `/`-separated nonempty segments; all other `.` or `..` segments, empty segments, backslashes, POSIX absolute paths, and Windows drive, UNC, or device absolute forms are rejected. After the build, Bazframe resolves `artifactRoot` through physical non-link directory components contained by the provider input, then resolves the build-manifest `sourceUnitRoot` the same way within that artifact root. Runtime repeats physical non-link component and containment validation for the descriptor `sourceUnitRoot` beneath the activated snapshot's `artifact/` directory. Bazframe runs the command with the ordinary user process environment and authority. If the build manifest is absent, the provider input is already prepared: Bazframe uses `artifactRoot: "."` and `sourceUnitRoot: "."` and still snapshots it before activation.

Bazframe stages under a unique sibling of the final digest path, copies the complete artifact into staged `<snapshot>/artifact/`, and accepts only physical directories and regular files; links and special entries fail preparation, while empty directories are retained. It writes the snapshot identity to `<snapshot>/manifest.json`. The manifest bytes are UTF-8 without a BOM and consist of one JSON object on one line followed by exactly one LF, with no insignificant whitespace. The root object's fixed key order is `schemaVersion`, then `entries`, with `schemaVersion: 1`. `entries` includes the root path `.` and every descendant directory, including empty directories, and sorts by `path` in lexical Unicode code-point order. Snapshot entry paths have their own physical-path grammar: `.` or `/`-joined nonempty physical basename segments with no NUL and no literal empty, `.`, or `..` segment. They are not provider build-relative paths, so legal POSIX basenames containing backslash, colon, or drive-like text remain representable. Each entry has one of these exact fixed-key forms: a directory is `{"path":string,"type":"directory"}`; a regular file is `{"path":string,"type":"file","executable":boolean,"sha256":64-lowercase-hex}`. A file's `executable` value records whether any executable bit was set in the prepared input on a platform that exposes executable mode bits, and is `false` otherwise. The snapshot digest is the lowercase hexadecimal SHA-256 of the exact manifest bytes.

The exact published layout is `<BAZFRAME_HOME>/source-snapshots/sha256/<digest>/{manifest.json,artifact/}`. Where the platform supports modes, published directories are normalized to non-writable and searchable, executable files to non-writable and executable, and other files to non-writable. Runtime verifies the actual artifact tree against the stored manifest before using it. An existing digest directory is reused only after its stored manifest and complete artifact verify exactly against the candidate manifest; any mismatch is snapshot corruption and a build failure, not permission to repair or replace the active descriptor. Bazframe validates the candidate source-unit structure and Pi definitions, then evaluates prospective full-profile composition using the candidate in place of the current membership. Candidate structural or Pi failure, or any duplicate involving the candidate, rejects activation; unrelated failures already present in other source units do not. Cross-machine output and digest identity are not required: each digest identifies the exact locally produced artifact. Snapshot publication and descriptor replacement are atomic from the profile's perspective. A failed build, copy, validation, publication, or prospective composition leaves the prior descriptor and snapshot active; an initial failed add creates neither active membership nor a published partial snapshot.

There is no global source registry in this slice. Content-addressed snapshot storage may be shared by digest, but source identity and selection remain profile-local. Repeating a descriptor in another profile is sufficient. Snapshot garbage collection is deferred.

The canonical commands are:

```text
bazframe profile sources
bazframe profile sources add <provider> <source> <absolute-root> [--profile <profile>]
bazframe profile sources build <provider> <source> [--profile <profile>]
bazframe profile sources remove <provider> <source> [--profile <profile>]
```

The overview lists descriptors in lexical `providerId`, then `sourceId` order and distinguishes direct membership, snapshot digest, preparation state, and derived children. Add, build, and remove follow the existing explicit-profile rule. There are no top-level aliases and no TUI source mutation in this slice.

Add canonicalizes the provider input, obtains build consent from the explicit source-selection command, prepares and snapshots it, and writes a new schema-v2 descriptor only after validation. Re-adding the same provider/source identity and canonical input rebuilds only when explicitly requested through `profile sources build`; otherwise an exact active schema-v2 membership is a successful no-op. A valid schema-v1 descriptor with the same identity and canonical input is preserved and refused with direction to run `profile sources build`; add never migrates it without executing the build. An occupied descriptor path that is symlinked, non-regular, malformed, has mismatched IDs, or names a different provider input is preserved and refused.

Build uses the descriptor's canonical provider input and current manifest, then atomically changes only that membership to the newly validated snapshot. It is the sole command that makes later provider-byte changes visible after add. It also upgrades a valid schema-v1 descriptor. Status, overview, startup, reload, and skill execution never trigger or repair a build.

Remove strictly validates and removes either a schema-v1 or schema-v2 descriptor without resolving the provider input or snapshot. It prunes only empty Bazframe-owned descriptor directories and deletes neither provider bytes nor snapshots. Profile duplicate and rename copy or move descriptor bytes; profile removal may delete descriptors but not provider inputs or snapshot storage. Flat Skillbook membership and lifecycle behavior remain unchanged.

### Snapshot discovery contract

Runtime resolution is read-only against activated snapshots. Before parsing descriptor bytes or resolving any snapshot, it validates the complete descriptor namespace. `source-units` must be absent or a physical directory. Each immediate entry beneath it must be a physical directory whose basename is a safe `providerId`; each immediate entry beneath a valid provider directory must be a physical regular file named exactly `<safe-sourceId>.json`. No other namespace entry is allowed. These checks use link-aware metadata: a symlink is invalid even when its target has the required type, and an invalid provider entry is never traversed.

Namespace validation is a lexical two-pass operation over the `source-units` directory and the immediate children of physical, safe provider directories. It reports every malformed entry that can be reached without following a symlink. Every such record has exactly `{ category: "invalid-descriptor", providerId, sourceId, path }` and a namespace-relative `/`-separated `path`: `.` for the `source-units` entry itself, the exact provider basename for a provider entry, or `<provider-basename>/<child-basename>` for a child entry. The stable placeholder IDs are `<unknown-provider>` and `<unknown-source>`. `providerId` is the basename only when that basename is safe; otherwise it is `<unknown-provider>`. `sourceId` is the filename stem only when the provider ID is known and the child name is exactly `<safe-sourceId>.json`; otherwise it is `<unknown-source>`. Thus an invalid `source-units` entry uses both placeholders, an invalid provider entry always uses the source placeholder, and an unsafe child name uses the known provider ID plus the source placeholder. Bazframe does not parse descriptors or resolve snapshots if namespace validation emits a record. This malformed-namespace state withholds all source-unit composition for the profile while preserving valid flat skills. Once the namespace shape is valid, malformed descriptor bytes or fields emit the same exact record shape with known IDs and `path: <providerId>/<sourceId>.json`; they remain failures of only their identified source unit.

Portable Node does not expose `openat` or directory enumeration directly from a `FileHandle`. Bazframe therefore opens each namespace directory with no-follow/directory flags, keeps that handle open, and compares physical device/inode identity for the handle and pathname before and after pathname-based enumeration. Changed or raced identity becomes `invalid-descriptor` and withholds composition. A non-cooperating process can still replace and restore the same pathname wholly inside the irreducible pathname-based `readdir` window; excluding that race requires a native handle-relative enumeration API.

For each valid schema-v2 descriptor, the resolver opens the digest-addressed snapshot, verifies its stored content identity, resolves `sourceUnitRoot` within it, and traverses that physical root depth-first by lexical relative path. A missing, mutable, or digest-mismatched snapshot fails closed; the provider input is never consulted during runtime resolution. For every discovered physical definition directory, Bazframe calls the Pi 0.82 Agent Skills loader, requires exactly one returned skill whose base directory and definition path equal that discovered snapshot child, and uses Pi's loaded name. This accepts Pi-valid YAML metadata forms and uses Pi's directory-name fallback when `name` is omitted. Every effective record preserves that Pi-loaded name, physical snapshot child base directory, and physical `SKILL.md` definition path, plus provider/source/relative-path identity for diagnostics. Bazframe never flattens a child, rewrites its metadata, asks Pi to scan a grouping root, or applies an additional YAML/frontmatter parser.

A source root containing a regular `SKILL.md` is a terminal standalone skill. It yields that root definition only; any descendant `SKILL.md` makes the source unit invalid as `mixed-root`. A root without `SKILL.md` is a grouping root and exposes every valid descendant Agent Skill. Zero valid descendants is allowed. Child subsets, manifests, and pack semantics remain deferred.

Traversal has these first-slice compatibility bounds:

- a maximum directory depth of 8 below the source root, where the root is depth 0 and files immediately inside a depth-8 directory may be inspected;
- at most 256 visited entries below the root; and
- at most 64 effective children per source unit.

These exact values were explicitly approved by the user and tested in Stage 1. They are now part of the first-slice compatibility contract, not defaults inferred from examples or agent judgment. The root itself is not an entry. After 256 counted entries, the next encountered entry fails the source; after 64 effective children, the next child fails it. A directory encountered at depth 9 fails it.

Exact-name `.git` and `node_modules` directory or symlink entries are skipped before counting, are not counted, and are never inspected or followed; this includes every symlink beneath a skipped root because traversal never enters that root. The user explicitly selected this production pruning rule in this continuation because VCS and dependency internals are not direct skill definitions. It is a product decision, not Stage 2 evidence: Stage 2 established discovery before `node_modules` preparation and did not rerun discovery afterward, so it did not measure this pruning behavior. Other encountered internal symlinks are rejected without following them. All other entries count once when encountered. Ordinary files and directories—including names such as `shared/` and `data/`—remain provider resources with no universal Bazframe semantics. Unsupported filesystem entries, canonical-containment failures, and filesystem races fail the source rather than broadening traversal.

Failures are atomic per source unit. A schema-v1 descriptor awaiting build, missing or broken snapshot, malformed descendant, mixed root, internal symlink, exceeded depth/entry/child bound, duplicate profile-declared name, unexpected I/O, or Pi-loader failure withholds every derived child from that source unit. `invalid-descriptor` records use the namespace-relative paths defined above. Every other diagnostic record contains `category`, `providerId`, `sourceId`, and a snapshot source-root-relative `/`-separated `path` (`.` for the root and `SKILL.md` for a standalone definition); `build-required` and root-level missing, corrupt, or broken snapshot records always use `path: "."`. `limit-exceeded` also contains `limit: depth | entries | skills`. The stable categories add `build-required` and `broken-snapshot` to `invalid-descriptor`, `limit-exceeded`, `internal-symlink`, `unsupported-entry`, `mixed-root`, `invalid-definition`, `duplicate-name`, `pi-loader`, and `io-error`.

Traversal failures use encounter order. For each lexical entry, exact skipped internal names are handled first; otherwise the entry is counted, then depth, symlink, filesystem type, and definition checks occur in that order. Root validation precedes descendants; finding a descendant definition under a root definition yields `mixed-root` without projecting the root. Profile-wide duplicate analysis occurs only after structural and Pi-loader validation of all candidate sources, so it can mark every source involved rather than whichever one happened to be visited later. Reported diagnostics sort by provider ID, source ID, path, and category. Multiple `pi-loader` records with the same keys then sort by `diagnosticIndex` and `message`. Other valid source units and existing flat skills remain available, so the unit—not provider content or the complete profile—is the ordinary source failure boundary; the malformed descriptor-namespace rule above is the sole profile-wide source-composition exception.

Pi-loader normalization retains every Pi diagnostic rather than aggregating it. For each rejected child definition, Bazframe emits one record per Pi diagnostic with exactly `{ category: "pi-loader", providerId, sourceId, path, diagnosticIndex, message }`: `path` is that child's source-root-relative definition path, `diagnosticIndex` is the zero-based index in Pi's returned diagnostic list, and `message` is Pi's reported message string unchanged. Records for that definition order by `diagnosticIndex`, then `message`. If Pi rejects a definition without returning a diagnostic, Bazframe emits the single deterministic record `{ category: "pi-loader", providerId, sourceId, path, diagnosticIndex: 0, message: "Pi loader rejected definition without a diagnostic" }`. Any Pi-loader record withholds the source unit.

Pi-loaded effective names must be unique across the complete Bazframe profile set before Pi command-namespace collision projection. Discovery first retains valid flat direct skills, then evaluates every source unit and builds one profile-name index. Each `duplicate-name` record has exactly `{ category: "duplicate-name", providerId, sourceId, path, name }`, where `path` is the conflicting derived definition's source-root-relative `SKILL.md` path and `name` is its Pi-loaded effective name. A within-source duplicate emits one record at every conflicting definition path and withholds that unit. A cross-source duplicate emits one record at every conflicting definition path in every involved source unit and withholds every involved unit. A flat/derived conflict emits one record only for each conflicting derived definition path, withholds its source unit, and preserves the flat membership; it never emits a synthetic flat-source record. A derived definition receives only one duplicate record for its name and path even when more than one other definition has that name. These complete-set outcomes do not depend on traversal arrival order.

A valid derived child that collides only with a pre-existing Pi skill command is not a profile duplicate: it enters the existing Pi command-namespace collision pipeline and receives the deterministic alias only when that alias is free. The resulting alias points to the derived child's physical definition and base directory within the active snapshot. A collision on the generated alias is a visible runtime projection error; Bazframe does not replace the occupant or generate a second alias. Other Pi projection errors likewise remain visible runtime errors.

### Runtime reporting and acceptance behavior

`bazframe status` and `/bazframe info` distinguish:

- flat direct skills from `profiles/<profile>/skills/`;
- direct source units from descriptor files, including schema, active snapshot digest, and `ready | build-required | failed` preparation state;
- rebuild availability as a separate `available | unavailable` observation; and
- derived effective skills, including their provider/source/relative-path origin.

Alias reporting keeps static cache inspection and live runtime mappings distinct. `bazframe status` performs no runtime namespace discovery and reports only the count of physical cached Pi alias files, which may be stale or inert. `/bazframe info` reports live `original -> alias` mappings only after those alias commands appear in Pi's current command set. A schema-v1 membership reports the corrective `profile sources build` command. A failed or missing snapshot is shown with its scoped diagnostic and contributes no derived children. Reporting may only shallowly check that the provider input still resolves to the stored canonical physical directory; it never traverses that input, reads its build manifest, or executes a build. A missing or retargeted provider input makes rebuild unavailable but, when the active snapshot remains valid, is informational and does not make status require attention or hide valid children. `build-required` and broken-snapshot states do require attention. With no `source-units/` directory, status, runtime projection, flat-skill ordering, and collision behavior remain the current flat behavior apart from the explicit zero source-unit/derived counts.

The initial runtime compatibility claim remains Pi 0.82.x. Preparation acceptance requires fixtures for manifest absence and exact manifest validation; literal argv execution; ordinary environment/CWD behavior; add-time build and snapshot; explicit rebuild after provider changes; provider changes remaining invisible before rebuild; schema-v1 `build-required`, upgrade, and removal; initial and replacement build failure; immutable digest-addressed storage; atomic descriptor activation and rollback; missing provider input with a usable active snapshot; no build during status, overview, Pi startup, reload, or child execution; and content validation before activation. Tests assert the produced local digest and bytes but do not require different machines to produce the same snapshot.

Composition acceptance retains the implemented fixtures for zero memberships; malformed descriptor namespaces; profile duplicate/rename/remove; standalone, zero-child, nested, skipped-internal, symlink, mixed-root, invalid-definition, boundary and over-boundary discovery; duplicate names; multi-diagnostic Pi-loader normalization; snapshot-relative physical bases delivered individually to Pi; pre-existing Pi skill-command collision aliases; status and `/bazframe info` separation; and flat Skillbook regressions. Historical Stage 1 and Stage 2 provider-preservation manifests remain evidence for those experiments, not a requirement that add-time provider build execution leave its input unchanged.

Bazframe still does not acquire, publish, or remove provider inputs; run child skill commands; own credentials or mutable runtime data; or supervise skill processes. It now owns declared build execution, prepared-artifact snapshotting, validation, activation, and rebuild for selected sources.

## Ownership

| Owner | Resources |
|---|---|
| User | profile content and instructions, source-provider choices, explicit selection/build consent, and provider inputs; `profile remove --force` authorizes Bazframe to delete only the named non-active physical profile content |
| Skillbook | flat skill acquisition, library copies, versioning, updating, publication, deletion, lockfile, and Agent Skills-compatible source directories |
| Other source providers | provider input bytes, acquisition, versioning, updates, dependencies, build declaration, publication, deletion, mutable runtime data, credentials, and child-command behavior |
| Bazframe | profile lifecycle operations, flat direct membership links, source-unit descriptors, declared build execution, prepared-artifact staging, immutable content-addressed snapshots, atomic activation, snapshot validation and child derivation, profile selection and resolution, runtime projection, active-profile state, global policy, project overrides, adapter manifest, installed adapter artifact, diagnostics, and generated alias cache |
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
bazframe profile sources
bazframe profile sources add <provider> <source> <absolute-root> [--profile <profile>]
bazframe profile sources build <provider> <source> [--profile <profile>]
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

Adapter installation is explicit and orthogonal to global/project policy. Global and project disable operations require neither adapter nor profile. Global enable validates runtime setup before removing disabled state. Project enable validates runtime setup because it makes the current worktree effective-enabled, including when it overrides global disable. Profile skill add/remove mutate only flat direct membership in the active or explicitly targeted profile. Profile source add/build prepare and activate Bazframe-owned snapshots; source remove deletes only the descriptor. Source-unit mutation has no top-level compatibility aliases or TUI action in this slice.

For adapter installation, `--force` repairs a drifted artifact only when a valid Bazframe ownership manifest identifies the destination. For `profile remove`, `--force` separately authorizes deletion of all content under the named non-active physical profile; it never extends authority to symlink targets.

Inside Pi, the adapter registers exactly one namespaced command: `/bazframe info` or `/bazframe reload`. `/bazframe reload` awaits Pi's reload operation, which reloads extensions, policy, profiles, skills, and context. Bare, unknown, or extra arguments show `Usage: /bazframe info | /bazframe reload` without reloading.

`/bazframe info` remains compact. It reports the effective profile (or `(none)`); effective context entries labeled `(pi)` or `(bazframe)` by supplier; separate lexical lines for flat direct skills, direct source units, and source-derived effective skills; effective Pi skill-command names as one deduplicated lexical comma-separated list (or `(none)`); source-scoped failures when present; and deterministic live `original -> alias` mappings only when the projected alias commands are present in Pi's current command set. Pi context retains `contextFiles` order. With an active profile whose flat state is valid, Bazframe appends the profile instructions entry; when Pi reports no context it first reports the restored global context when present. A failed source unit is reported and omitted atomically without hiding the otherwise effective profile. Disabled, unresolved, or flat-profile-error states do not report an effective profile or Bazframe context.

## Safety and diagnostics

Bazframe-managed writes use validated external paths, per-resource locks, mode-restricted temporary files, and atomic filesystem operations. Selection validation and all lifecycle mutations occur under the global state lock; membership takes that lock before its profile-specific lock. Source preparation runs only after explicit add/build authorization, copies output to private staging, validates and hashes it before publication, and replaces a descriptor only after the immutable snapshot is available. Failed staging is cleaned without changing the active descriptor; unreferenced snapshot garbage collection is deferred. Duplication copies to a unique sibling staging directory without following symlinks, cleans failed staging, and publishes with a final rename. Active rename coordinates a directory rename with atomic selection replacement and rolls the directory back when selection replacement fails before commit. Adapter install and uninstall compare artifact hashes against the ownership manifest. Exceptional project overrides are external; acceptance tests preserve the worktree snapshot and Git status. Locks coordinate Bazframe writers, but a non-cooperating external process can still race pathname-based operations where portable Node lacks a conditional handle-relative API.

A default-enabled session validates flat profile state as before and reports actionable errors in both Git and non-Git directories. Source-unit errors are additionally reported at their atomic unit boundary: a failed source contributes no children, while valid flat skills and other valid sources remain available. An effective-disabled session retains native Pi behavior.

`bazframe status` reads and reports adapter ownership, drift, current project state and effective behavior, active-profile validity when required, flat direct skill counts, direct source-unit preparation state and snapshot digests, derived effective skill counts, source-scoped failures, the physical cached Pi alias count, and corrective commands. It does not discover live Pi alias mappings and never prepares or rebuilds a source.

## Research agenda

Product work now focuses on:

- completing the TUI's remaining source-tree/viewport interaction work after the separate top-tab focus model;
- implementing and validating schema-v2 source descriptors, declared builds, immutable snapshots, explicit rebuild, and snapshot-based bounded discovery;
- keeping editor launch, settings writes, TUI source mutation, additional provider operations, and provider move/rename behind their explicit ownership and lifecycle decisions;
- retaining Linux and local tmux evidence while validating Windows Terminal, representative remote SSH, terminal/font/locale width differences, and manual assistive-technology behavior before any production-ready TUI claim;
- preserving flat direct-membership behavior while adding the smallest explicit source preparation lifecycle.

The Agent Skills specification defines no standard dependency field; it permits arbitrary additional files and string-valued `metadata`, and recommends that scripts be self-contained or clearly document dependencies. Bazframe's current product decision is to add no inter-skill dependency schema or automation: source providers own shared resources and runtime packages, and Bazframe does not infer dependency semantics from prose, `compatibility`, `metadata`, `allowed-tools`, sibling paths, or co-packaging. Any future namespaced validate-only sidecar requires separate interoperability evidence and an explicit product decision before schema or automation.

Skill packs, child subsets, a global source registry, profile export, and snapshot garbage collection remain deferred.

## Implementation plan

[`pi-adapter-production-design.md`](pi-adapter-production-design.md) records the implemented production baseline, lifecycle rules, milestones, and acceptance evidence. Executable Pi 0.82 evidence is retained in the [`pi-no-launcher-adapter` experiment](../experiments/pi-no-launcher-adapter/REPORT.md).
