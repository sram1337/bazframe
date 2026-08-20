# Pi Adapter Production Design

> Status: implemented baseline; acceptance gates passing for Pi 0.82.0 on the current macOS/Node environment
>
> Product source of truth: [`design.md`](design.md)
>
> Accepted runtime behavior: [`pi-adaptive-context-adapter.md`](pi-adaptive-context-adapter.md)
>
> Executable evidence: [`../experiments/pi-no-launcher-adapter/REPORT.md`](../experiments/pi-no-launcher-adapter/REPORT.md)

## 1. Product boundary

Bazframe's first Pi integration is a global Pi extension. Pi remains the session entrypoint. Absent global state means enabled in Git and non-Git directories. In Git worktrees, explicit project policy overrides global policy; effective-disabled sessions remain native.

```bash
pi       # Pi native context + active Bazframe profile
pi -nc   # restored global Pi context + active Bazframe profile
```

Pi owns runtime settings and resources. Bazframe owns profile lifecycle, selection, membership links, global policy, project overrides, adapter installation, and generated aliases. Profile content remains user-owned; `profile remove --force` is explicit authorization to delete the named non-active physical profile.

## 2. User journeys

### 2.1 Install

```bash
npm install --global bazframe
bazframe adapter install pi
bazframe status
```

Adapter installation is explicit. The command places one self-contained Bazframe artifact in Pi's effective global extension directory and records its identity under the Bazframe home. Pi auto-discovers the extension, which lets the user invoke `pi` directly. Absent global state enables Bazframe without a policy file. Project overrides take precedence.

### 2.2 Configure defaults

From any directory, configure the global active profile:

```bash
bazframe profile add focused
bazframe profile edit focused
bazframe profile use focused
```

`profile add` creates the empty physical profile shape without selecting it. `profile edit` opens its actual `AGENTS.md` with the first nonblank executable-only `VISUAL`, then `EDITOR`; `skill edit` applies the same process contract to an authoritative live `(default)` provider `SKILL.md`, while managed snapshots remain immutable. Fixed flags require a wrapper executable. `profile use` validates and selects it; top-level `bazframe use focused` remains a supported alias. Every working directory that inherits enabled global policy uses that profile.

### 2.3 Run and reload

```bash
pi
# or
pi -nc
```

A running session uses `/bazframe reload` to await Pi's reload of policy, profile instructions, skills, and aliases.

### 2.4 Inspect

Outside Pi:

```bash
bazframe status
```

Inside Pi:

```text
/bazframe info
/bazframe reload
```

### 2.5 Global and project policy

```bash
bazframe global enable|disable
bazframe project enable|disable
```

Within Git worktrees, project override wins over global policy. Project commands remain Git-only. Non-Git directories inherit global policy. Disable operations need neither adapter nor profile. Global enable validates runtime setup before removing disabled state; project enable validates because it activates the current worktree. Adapter lifecycle remains orthogonal and preserves policy.

## 3. Command decisions

| Command | Responsibility |
|---|---|
| `bazframe adapter` / `adapters` | Show supported adapters, current state, and commands. |
| `bazframe adapter install pi [--force]` | Install, update, or explicitly repair the global Pi extension. |
| `bazframe adapter uninstall pi` | Remove the verified Bazframe-owned Pi extension. |
| `bazframe global` | Show global policy and state. |
| `bazframe global enable` / `disable` | Remove disabled global state or write it atomically. |
| `bazframe project` / `projects` | List overrides and show project-over-global effective behavior. |
| `bazframe project enable` / `disable` | In a Git worktree, set effective project behavior using an override only when it differs from global policy. |
| `bazframe profile` / `profiles` | List profiles, mark the active selection, and show commands. |
| `bazframe profile add <profile>` | Create an empty physical profile without selecting it. |
| `bazframe profile duplicate <source> <new>` | Copy all physical profile content without following symlinks or changing selection. |
| `bazframe profile remove <profile> [--force]` | Remove a non-active generated-empty profile, or explicitly delete its physical contents with `--force`. |
| `bazframe profile rename <old> <new>` | Rename a physical profile and update matching active selection. |
| `bazframe profile use <profile>` | Atomically validate and select the global active profile. |
| `bazframe profile list` | Print runtime-valid physical profile IDs in lexical order for scripts. |
| `bazframe profile current` | Print only the selected profile ID for scripts. |
| `bazframe skill` / `skills` | List valid registrations in the `(default)` catalog. |
| `bazframe add skill <absolute-root>` / `remove skill <skill>` | Register or remove an unreferenced live external skill link. |
| `bazframe profile skills` | List immediate skill entries discovered in the active profile; Pi performs full runtime validation. |
| `bazframe profile skills add <skill>` | Add a registered `(default)` skill link to the active profile. |
| `bazframe profile skills remove <skill>` | Remove only the verified active-profile membership link. |
| `bazframe status` | Report adapter, effective project behavior, required profile state, and actionable problems. |

Top-level `use`, `add`, and `remove` remain compatibility aliases. Old `init`/`uninit` forms return migration guidance. Bare resource overviews are human-readable; `profile list` and `profile current` retain concise scripting output.

Decisions:

- Adapter installation is a separate explicit command.
- A Git-worktree project override wins over global policy; absent global state is enabled everywhere, absent Git project state inherits, and non-Git directories inherit without project state.
- Plain `pi` is the additive-context mode; `pi -nc` is instruction-context replacement.
- `adapter install pi --force` repairs a drifted destination only when a valid ownership manifest identifies that destination.
- Pi is invoked directly by the user.
- CLI color is terminal-aware presentation only: pipes remain plain, `NO_COLOR` disables it, and nonzero `FORCE_COLOR` explicitly enables it when `NO_COLOR` is absent.

## 4. Runtime behavior

The extension activates when project-over-global policy resolves enabled.

At startup and reload, it:

1. attempts to resolve a canonical Git root with repository-selection environment variables cleared;
2. resolves exact bounded global policy in every directory and optional project state when a Git root exists;
3. applies an available Git-worktree project override before global policy, bypassing Bazframe when disabled;
4. inspects Pi's loaded skill commands and provenance;
5. projects colliding profile skills as `<name>-x-bazframe` in external cache;
6. contributes profile and alias skill paths through `resources_discover`;
7. inspects `systemPromptOptions.contextFiles` as an empty/non-empty structured signal;
8. restores global Pi context for an empty collection;
9. appends profile instructions after the selected context;
10. logs context mode and aliases once per load.

The extension uses Pi's public exports and structured event data. Git discovery has a bounded timeout, and instruction reads have a 1 MiB bound.

## 5. External state and ownership

Default layout:

```text
~/.bazframe/
├── active-profile
├── profiles/
│   └── <profile>/
│       ├── AGENTS.md
│       └── skills/
├── global.json                       # present only when globally disabled
├── projects/                         # absent/empty when projects inherit
│   └── <sha256-canonical-root>.json  # enabled/disabled overrides or legacy records
├── adapters/
│   └── pi.json
├── adapter-cache/
│   └── pi/skill-aliases/<profile>/<alias>/SKILL.md
└── locks/
    ├── adapter-pi.lock
    └── state.lock

$PI_CODING_AGENT_DIR/extensions/
└── bazframe.ts
```

`PI_CODING_AGENT_DIR` selects Pi's agent directory; the default is `~/.pi/agent`. The CLI and extension use the same resolution rule.

Ownership categories:

- **User-owned:** profile content and instructions, live added-Skill provider roots, prepared library roots, and package projects; `profile remove --force` explicitly authorizes deletion of the named non-active physical profile content.
- **Bazframe-managed:** profile lifecycle operations, direct membership links, selection state, exceptional project overrides, adapter manifest, installed artifact, locks, and alias cache.
- **Repository-owned:** the Git worktree and its project instructions.
- **Pi-owned:** runtime settings, trust, tools, models, packages, extensions, prompts, themes, system prompts, and native skills.

## 6. State formats

### 6.1 Adapter manifest

```json
{
  "schemaVersion": 1,
  "adapter": "pi",
  "bazframeVersion": "0.1.0",
  "installedPath": "/Users/me/.pi/agent/extensions/bazframe.ts",
  "artifactSha256": "<hex>",
  "artifactBytes": 12345
}
```

The manifest path is `adapters/pi.json`. Paths are absolute and normalized. The hash and byte count identify the exact installed artifact.

### 6.2 Global policy and project override

Absent `global.json` means enabled. Its only stored form is exact schema-v1 disabled state. No project record means inherit global. Exact schema-v1 project records remain legacy inherit state; schema-v2 disables and schema-v3 enables. Extra, malformed, mismatched, unsupported, or symlinked state is rejected. Project filenames remain the SHA-256 of canonical repository paths.

## 7. Filesystem and concurrency policy

Bazframe-managed writes follow one shared policy:

1. resolve and validate the Bazframe home and destination;
2. acquire the relevant lock with exclusive creation;
3. create parent directories with user-only access;
4. write a uniquely named mode-`0600` temporary file in the destination directory;
5. flush and close the file;
6. atomically rename it over the destination;
7. release the lock in `finally`.

A lock records PID, creation time, command, and target. A live lock produces an actionable busy result. A stale lock whose PID is absent can be replaced by the next owning command after reporting the recovery.

Bazframe-managed state, including `active-profile`, rejects symlinks. Profile lifecycle requires a physical profile root, while runtime validation follows user-owned `AGENTS.md`, `skills/`, and immediate skill-entry symlinks as trusted profile content and applies the existing file and skill checks to resolved targets. Duplicate and rename intentionally validate only the source physical root so broken provider references do not prevent copying or preserving profile content. Duplication preserves symlinks verbatim, stages the full copy under the physical profiles directory, cleans failed staging, and publishes with a final rename.

The CLI performs state mutations. Profile add/duplicate/remove/rename/select share the global state lock; membership takes it before a profile-specific lock. `profile edit` is a direct user-owned external write: after physical-root/final-file revalidation it launches without a lock, temporary copy, or rollback and waits for the shell-free inherited child. Actual create, duplicate, remove, and identity-changing rename clear affected alias cache, while idempotent add and same-ID rename preserve it. Runtime cache materialization uses atomic writes to deterministic profile/alias paths. Old alias files are inert because `resources_discover` returns only aliases selected for the current load. Adapter uninstall clears the full Pi alias cache.

Locks coordinate Bazframe writers. A non-cooperating external process can still race profile check/create/duplicate/rename/remove pathnames or final membership unlink after verification because portable Node APIs do not provide every conditional pathname operation needed to exclude such writers.

## 8. Adapter installation lifecycle

The production artifact is a copied, self-contained TypeScript extension that imports Node built-ins and Pi's public package exports. Copying fixes the runtime bytes independently of global npm module resolution.

The installer resolves these states:

| State | Meaning | Action |
|---|---|---|
| `missing` | artifact and manifest absent | install |
| `adoptable` | artifact exactly matches the packaged bytes and manifest is absent | record ownership |
| `current` | artifact matches desired bytes and manifest | succeed idempotently |
| `managed-outdated` | artifact matches its manifest and desired bytes changed | update |
| `managed-missing` | manifest exists and artifact is absent | restore |
| `drifted` | manifest identifies the path and artifact hash differs | report; repair with `--force` |
| `occupied` | destination exists outside a valid ownership record | report path for manual resolution |
| `manifest-path-mismatch` | manifest records another effective Pi agent directory | report both paths for explicit resolution |

Install flow:

1. validate the packaged artifact and compute its identity;
2. resolve Pi's effective agent directory;
3. lock the adapter lifecycle;
4. classify the destination and ownership manifest;
5. stage and atomically install the artifact;
6. atomically write the manifest;
7. verify the installed hash and manifest;
8. report the installed version and path.

An exact desired artifact found without a manifest can be adopted because its bytes are reconstructably Bazframe's packaged artifact. Other occupied files stay under their current owner.

Adapter upgrade preserves profiles, global policy, project overrides, and alias cache. It does not migrate pre-alpha Skill collection state: old `sources/`, profile `sources/`, `source-snapshots/`, `source-units/`, and `bazframe-source.json` content remains inert and unchanged.

Uninstall verifies the installed hash against the manifest, removes the artifact, removes the manifest, and clears the Pi alias cache. Drift remains visible for `--force` repair or manual recovery.

## 9. Global and project policy lifecycle

`global disable` writes exact schema-v1 disabled state atomically and idempotently without requiring adapter/profile. `global enable` validates current adapter and profile before removing disabled state. Invalid state is preserved.

Project commands resolve the canonical Git root and global policy. `project enable` validates adapter/profile, writes schema-v3 enabled override when global is disabled, and otherwise removes valid current state to inherit enabled. `project disable` requires no runtime setup, writes schema-v2 disabled override when global is enabled, and otherwise removes valid state to inherit disabled. Existing opposite overrides survive global policy changes. Invalid current state is preserved.

Lifecycle acceptance captures a content snapshot and Git status before and after each operation.

## 10. Profiles and skills

Profile IDs contain 1–64 lowercase ASCII letters or digits separated by single hyphens.

Lifecycle behavior:

- `profile add` creates zero-byte physical `AGENTS.md` and an empty physical `skills/` directory without selecting it; an existing runtime-valid physical-root profile is `current`;
- `profile list` reports runtime-valid physical-root profiles and warns on invalid neighbors without contaminating stdout;
- `profile edit <profile>` targets active or inactive profiles explicitly, preserves active selection, does not pre-read instruction bytes, and returns the configured editor's exit or signal status;
- `skill edit <skill>` targets only a structurally authorized live `(default)` provider definition, does not parse its bytes before launch, and returns the same editor status without granting managed-snapshot or Bazframe artifact-lifecycle authority;
- bare `profile` and `profiles` render the human profile overview, while `profile list` and `profile current` remain concise scripting commands;
- duplicate copies all child content without resolving provider targets, preserves symlinks verbatim, refuses replacement and profile-root symlinks, publishes only after a complete staged copy, and leaves active selection unchanged;
- rename preserves all child content without resolving provider targets, refuses replacement and profile-root symlinks, and updates active selection with rollback on pre-commit write failure;
- remove always refuses the selected ID, including a selected-but-missing profile; without `--force` it accepts only the exact generated-empty shape, and force-removal unlinks symlink entries without following targets.

Instruction requirements:

- `AGENTS.md` resolves to a regular file;
- maximum size is 1 MiB;
- content is valid UTF-8;
- NUL bytes are rejected.

Skill requirements:

- bare `skills` lists valid live registrations from `<BAZFRAME_HOME>/skills`, warns about invalid neighbors, and does not claim provider lifecycle ownership;
- missing add targets use bounded edit-distance matching to suggest valid available skills;
- immediate children of profile `skills/` are loaded in lexical directory-name order;
- Pi's public Agent Skills loader parses each skill;
- duplicate profile skill names are profile errors;
- available profile names remain unchanged;
- native collisions receive the deterministic `-x-bazframe` suffix;
- aliases retain the original description and invocation setting;
- aliases direct Pi to the original skill file and base directory;
- a generated alias collision is a profile error.

Profile instructions and Skills are trusted user content. Added-Skill, library, and package lifecycles stay independent from the adapter implementation so providers can interoperate with the same profile contract.

## 11. Diagnostics and failure behavior

### 11.1 `bazframe status`

Status reads existing state and reports:

- Bazframe home;
- Pi agent directory and adapter path;
- adapter state, version, installed path, and drift;
- canonical current Git root when one exists, otherwise explicit non-Git state;
- current project state and effective default/disabled behavior;
- active-profile ID and validation;
- profile instruction path, directly added Skill count, typed library/package references, derived effective Skills, failures, and kind-qualified corrective commands;
- aliases present in cache;
- launch guidance;
- one corrective command for each problem.

Status returns success for a healthy setup, a distinct attention status for incomplete setup or drift, and Bazframe failure for malformed or unsafe state.

### 11.2 `/bazframe info`

The runtime command reports:

- `Profile: <effective-id>` or `Profile: (none)`;
- effective context entries in Pi order, each labeled `(pi)` or `(bazframe)`, or `Context: (none)`;
- flat directly added Skills with paths;
- kind-qualified library/package references with provider root, health, refresh availability, digest, and Skills root;
- derived effective Skills with kind-qualified provenance;
- kind-qualified library/package failures and exact `libraries update` / `packages build` corrective commands;
- `Skills:` followed by deduplicated, lexically sorted names from Pi's effective `skill:` commands, or `(none)`;
- a deterministic comma-separated `Aliases: original -> alias` line only when aliases exist.

An active error-free profile contributes its instructions after Pi context. If Pi context is empty, the restored global context is listed first when present. Error, disabled, and unresolved states do not claim an effective profile or Bazframe context. The notification may use error severity without adding an error-detail line.

### 11.3 Failure policy

A default-enabled session applies the complete validated profile in Git and non-Git directories. Malformed global or applicable project state, invalid selection, invalid instructions, unreadable skills, duplicate names, alias collision, or unsafe paths produce a visible error before an agent turn. A valid effective-disabled state retains ordinary Pi behavior.

## 12. Security and compatibility

- Project trust is Pi's security decision.
- Profiles and skills are trusted user-controlled instructions and code.
- External writes are confined to validated Bazframe-managed state and the installed extension destination.
- Ownership hashes protect modified and independently owned extension files.
- Locking and atomic operations coordinate concurrent Bazframe CLI operations; non-cooperating external pathname races remain a documented boundary.
- Runtime Git discovery uses an argument array, sanitized environment, captured output, and timeout.
- The initial verified platform is macOS with Node `>=22.19.0` and Pi `0.82.x`.
- Adapter startup checks the Pi APIs required for `resources_discover`, command provenance, reload, and structured system-prompt options.
- A Pi context API that supports selective context loading requires a new compatibility decision before activation.

## 13. Acceptance criteria

A production-ready slice proves:

1. clean install, idempotent reinstall, managed update, explicit drift repair, clean uninstall, and preservation of occupied files;
2. file-free enabled defaults in Git and non-Git directories plus global/project enable-disable precedence with stable repository content and Git status;
3. plain `pi` loads native context once and appends the active profile;
4. `pi -nc` restores global context once, excludes ancestor/repository context, and appends the profile;
5. `/bazframe reload` observes policy, active-profile instruction, and skill changes;
6. native project resources follow Pi's project-trust behavior;
7. skill collisions produce deterministic `-x-bazframe` aliases and diagnostics;
8. global disable, enabled-project override, disabled-project override, and non-Git global inheritance follow precedence;
9. broken project state, profile, cache, adapter, and lock states produce corrective diagnostics;
10. profile lifecycle tests cover guarded deletion, force preservation of symlink targets, staged duplication with verbatim symlinks and unchanged selection, active rename/rollback, provider-independent rename, selection, listing, cache cleanup/no-op preservation, and state symlink rejection;
11. packed-package tests exercise the installed CLI and executable mode plus a supported Pi executable in isolated user state.

## 14. Implementation milestones

### Milestone 1: external-state foundation

Deliver:

- shared Bazframe-home and Pi-agent-directory resolution;
- atomic file writes, permissions, locks, hashing, and ownership comparison;
- schema-v1 adapter/global policy plus legacy-inherit/schema-v2-disabled/schema-v3-enabled project codecs;
- focused unit tests for path, symlink, lock, codec, and drift states.

Gate: unit tests cover every filesystem state transition and leave fixtures stable after failure.

### Milestone 2: adapter lifecycle

Deliver:

- packaged self-contained Pi extension artifact;
- `adapter install pi [--force]`;
- `adapter uninstall pi`;
- install-state diagnostics.

Gate: isolated install, idempotent reinstall, update, drift, occupied destination, force repair, and uninstall tests pass against the packed package.

### Milestone 3: project state and status

Deliver:

- `global enable/disable` and `project enable/disable`;
- production `status` output and exit semantics;
- active-profile validation shared by CLI and adapter.

Gate: fake-Git and real-worktree tests prove canonical identity, external-only state, actionable diagnostics, and stable repository snapshots.

### Milestone 4: production runtime adapter

Deliver:

- adaptive context composition;
- profile skill discovery and collision aliases;
- the single `/bazframe info | reload` namespace;
- compatibility and visible failure handling;
- bounded asynchronous Git discovery and file operations where startup latency benefits.

Gate: isolated Pi 0.82 tests pass for both context modes, reload, collisions, trust-owned resources, malformed state, file-free defaults, disabled sessions, and enabled/disabled non-Git directories.

### Milestone 5: package and migration gate

Deliver:

- packed-package end-to-end test with the supported Pi executable;
- installation and user-flow documentation;
- launcher-prototype deprecation and migration note;
- final acceptance matrix.

Gate: install/build/typecheck/lint/unit/integration/pack/real-Pi checks pass from a clean checkout, and repository snapshots remain stable.

## 15. Acceptance evidence

| Area | Evidence |
|---|---|
| External state and codecs | Unit coverage for paths, symlinks, atomic replacement, locks, manifests, exact global policy, legacy inherit, disabled/enabled project state, hashing, and adapter ownership. |
| Adapter lifecycle | Unit and packed-package checks cover install, idempotence, managed update, adoption, drift preservation, manifest-gated repair, occupied destinations, uninstall, and cache cleanup. |
| Policy and status | Unit and fake-CLI integration cover global/project precedence, file-free defaults, enabled/disabled overrides, legacy compatibility, read-only status, malformed-state preservation, and stable worktrees. |
| Profile and membership lifecycle | Unit and built-CLI integration cover create/duplicate/list/current/use/rename/remove, force guards, active and missing-active refusal, selection rollback, staged-copy cleanup, parallel catalog/profile link policy, broken provider references, alias-cache cleanup/no-op preservation, provider preservation, and strict CLI parsing. |
| Runtime adapter | Packed Pi 0.82 probes cover context modes, profile skills, global disable, project enable/disable precedence, and stable repositories. Deterministic current-artifact tests cover the exact compact `/bazframe info` projection, context restoration reporting, effective skills and collisions, command registration, strict argument dispatch, awaited reload, and fail-closed behavior. The packed real-Pi gate does not claim live slash-command coverage. |
| Packed real-Pi flow | `npm run test:real-pi` proves file-free defaults, global disable, project-enabled override, project-disabled override, both Pi context modes, provider preservation, and stable Git status. |

The repeatable production gates are:

```bash
npm test
npm run test:real-pi
```

The earlier registration-gated spike remains historical evidence for the adaptive Pi API boundary; its activation assumptions are superseded by project-over-global policy.
