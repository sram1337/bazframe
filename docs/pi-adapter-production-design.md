# Pi Adapter Production Design

> Status: implemented baseline; acceptance gates passing for Pi 0.82.0 on the current macOS/Node environment
>
> Product source of truth: [`design.md`](design.md)
>
> Accepted runtime behavior: [`pi-adaptive-context-adapter.md`](pi-adaptive-context-adapter.md)
>
> Executable evidence: [`../experiments/pi-no-launcher-adapter/REPORT.md`](../experiments/pi-no-launcher-adapter/REPORT.md)

## 1. Product boundary

Bazframe's first Pi integration is a global Pi extension. Pi remains the session entrypoint, and Bazframe supplies the active profile for registered Git worktrees.

```bash
pi       # Pi native context + active Bazframe profile
pi -nc   # restored global Pi context + active Bazframe profile
```

Pi owns runtime settings and resources. Bazframe owns profile selection, repository registration, adapter installation, and generated profile-skill aliases.

## 2. User journeys

### 2.1 Install

```bash
npm install --global bazframe
bazframe adapter install pi
bazframe status
```

Adapter installation is explicit. The command places one self-contained Bazframe artifact in Pi's effective global extension directory and records its identity under the Bazframe home. Pi auto-discovers the extension, which lets the user invoke `pi` directly; separating installation from `init` prevents repository registration from silently changing Pi's global configuration.

### 2.2 Register a repository

From any directory inside a Git worktree:

```bash
bazframe use focused
bazframe init
```

`init` validates the active profile and records the canonical worktree root externally. The final summary explains the two Pi context modes.

### 2.3 Run and reload

```bash
pi
# or
pi -nc
```

A running session uses `/bzf-reload` to reload profile instructions, skills, and aliases as one operation.

### 2.4 Inspect

Outside Pi:

```bash
bazframe status
```

Inside Pi:

```text
/bzf-explain
```

### 2.5 Remove

```bash
bazframe uninit
bazframe adapter uninstall pi
```

`uninit` removes the current worktree's registration. Adapter uninstall removes the verified installed artifact, ownership manifest, and generated adapter cache. User profiles and active-profile selection persist.

## 3. Command decisions

| Command | Responsibility |
|---|---|
| `bazframe adapter install pi [--force]` | Install, update, or explicitly repair the global Pi extension. |
| `bazframe adapter uninstall pi` | Remove the verified Bazframe-owned Pi extension. |
| `bazframe init` | Register the canonical current Git worktree against the global active profile. |
| `bazframe uninit` | Remove the canonical current worktree's registration. |
| `bazframe use <profile>` | Atomically select the global active profile. |
| `bazframe status` | Report adapter, registration, profile, and actionable problems. |

Decisions:

- Adapter installation is a separate explicit command.
- Every first-slice registration follows the global active profile.
- Plain `pi` is the additive-context mode; `pi -nc` is instruction-context replacement.
- `adapter install pi --force` repairs a drifted destination only when a valid ownership manifest identifies that destination.
- Pi is invoked directly by the user.

## 4. Runtime behavior

The extension activates when the canonical Git root matches an external registration.

At startup and `/bzf-reload`, it:

1. resolves the canonical Git root with repository-selection environment variables cleared;
2. resolves and validates the external registration;
3. resolves and validates the active profile;
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
├── projects/
│   └── <sha256-canonical-root>.json
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

- **User-owned:** profiles, profile instructions, and source skills.
- **Bazframe-managed:** selection state, registrations, adapter manifest, installed artifact, locks, and alias cache.
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

### 6.2 Repository registration

```json
{
  "schemaVersion": 1,
  "repository": "/canonical/path/to/repo",
  "mode": "adaptive-context",
  "profile": "active"
}
```

The registration filename is the SHA-256 of the canonical repository path. The extension validates both the key and stored path.

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

Bazframe-managed directories reject symlinked state and adapter destinations. User-owned profile entries may use symlinks; validation follows them as trusted profile content and applies regular-file, UTF-8, NUL, and size checks to the resolved targets.

The CLI performs state mutations. Runtime cache materialization uses atomic writes to deterministic profile/alias paths. Old alias files are inert because `resources_discover` returns only aliases selected for the current load. Adapter uninstall clears the full Pi alias cache.

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

Upgrade preserves profiles, registrations, and alias cache. A package migration runs only after validating the source schema and writing a recoverable destination.

Uninstall verifies the installed hash against the manifest, removes the artifact, removes the manifest, and clears the Pi alias cache. Drift remains visible for `--force` repair or manual recovery.

## 9. Repository registration lifecycle

`init` requirements:

- resolve a Git worktree from the caller's exact working directory;
- clear inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, and related repository selectors;
- canonicalize the worktree root;
- require a current Pi adapter installation;
- validate the active profile;
- compute the registration key from the canonical root;
- write the schema-v1 registration atomically;
- treat an identical registration as success;
- report both Pi context modes in the final summary.

`uninit` resolves the same canonical root and removes its matching registration. Canonical local path is the first-slice identity, so a moved worktree is initialized at its new location.

Registration acceptance captures a content snapshot and Git status before and after each lifecycle operation.

## 10. Profiles and skills

Profile IDs contain 1–64 lowercase ASCII letters or digits separated by single hyphens.

Instruction requirements:

- `AGENTS.md` resolves to a regular file;
- maximum size is 1 MiB;
- content is valid UTF-8;
- NUL bytes are rejected.

Skill requirements:

- immediate children of `skills/` are loaded in lexical directory-name order;
- Pi's public Agent Skills loader parses each skill;
- duplicate profile skill names are profile errors;
- available profile names remain unchanged;
- native collisions receive the deterministic `-x-bazframe` suffix;
- aliases retain the original description and invocation setting;
- aliases direct Pi to the original skill file and base directory;
- a generated alias collision is a profile error.

Profile instructions and skills are trusted user content. Their source lifecycle stays independent from the adapter implementation so future skill-library providers can interoperate with the same profile contract.

## 11. Diagnostics and failure behavior

### 11.1 `bazframe status`

Status reads existing state and reports:

- Bazframe home;
- Pi agent directory and adapter path;
- adapter state, version, hash, and drift;
- canonical current Git root;
- registration state;
- active-profile ID and validation;
- instruction source and skill count;
- aliases present in cache;
- launch guidance;
- one corrective command for each problem.

Status returns success for a healthy setup, a distinct attention status for incomplete setup or drift, and Bazframe failure for malformed or unsafe state.

### 11.2 `/bzf-explain`

The runtime command reports:

- additive or instruction-context replacement mode;
- global-context source;
- context files reported by Pi;
- profile ID and instruction source;
- profile skills and collision aliases;
- registration and canonical repository paths;
- Pi-owned resource categories.

### 11.3 Failure policy

A registered session applies the complete validated profile. Malformed registration, invalid selection, invalid instructions, unreadable skills, duplicate names, alias collision, or unsafe paths produce a visible error before an agent turn. Ordinary Pi behavior applies when the current worktree has no matching registration.

## 12. Security and compatibility

- Project trust is Pi's security decision.
- Profiles and skills are trusted user-controlled instructions and code.
- External writes are confined to validated Bazframe-managed state and the installed extension destination.
- Ownership hashes protect modified and independently owned extension files.
- Locking and atomic rename protect concurrent CLI operations.
- Runtime Git discovery uses an argument array, sanitized environment, captured output, and timeout.
- The initial verified platform is macOS with Node `>=22.19.0` and Pi `0.82.x`.
- Adapter startup checks the Pi APIs required for `resources_discover`, command provenance, reload, and structured system-prompt options.
- A Pi context API that supports selective context loading requires a new compatibility decision before activation.

## 13. Acceptance criteria

A production-ready slice proves:

1. clean install, idempotent reinstall, managed update, explicit drift repair, clean uninstall, and preservation of occupied files;
2. init, status, and uninit with stable repository content and Git status;
3. plain `pi` loads native context once and appends the active profile;
4. `pi -nc` restores global context once, excludes ancestor/repository context, and appends the profile;
5. `/bzf-reload` observes active-profile instruction and skill changes;
6. native project resources follow Pi's project-trust behavior;
7. skill collisions produce deterministic `-x-bazframe` aliases and diagnostics;
8. other repositories retain native Pi behavior;
9. broken registration, profile, cache, adapter, and lock states produce corrective diagnostics;
10. packed-package tests exercise the installed CLI and a supported Pi executable in isolated user state.

## 14. Implementation milestones

### Milestone 1: external-state foundation

Deliver:

- shared Bazframe-home and Pi-agent-directory resolution;
- atomic file writes, permissions, locks, hashing, and ownership comparison;
- schema-v1 adapter manifest and registration codecs;
- focused unit tests for path, symlink, lock, codec, and drift states.

Gate: unit tests cover every filesystem state transition and leave fixtures stable after failure.

### Milestone 2: adapter lifecycle

Deliver:

- packaged self-contained Pi extension artifact;
- `adapter install pi [--force]`;
- `adapter uninstall pi`;
- install-state diagnostics.

Gate: isolated install, idempotent reinstall, update, drift, occupied destination, force repair, and uninstall tests pass against the packed package.

### Milestone 3: registration and status

Deliver:

- `init` and `uninit`;
- production `status` output and exit semantics;
- active-profile validation shared by CLI and adapter.

Gate: fake-Git and real-worktree tests prove canonical identity, external-only state, actionable diagnostics, and stable repository snapshots.

### Milestone 4: production runtime adapter

Deliver:

- adaptive context composition;
- profile skill discovery and collision aliases;
- `/bzf-explain` and `/bzf-reload`;
- compatibility and visible failure handling;
- bounded asynchronous Git discovery and file operations where startup latency benefits.

Gate: isolated Pi 0.82 tests pass for both context modes, reload, collisions, trust-owned resources, malformed state, and other repositories.

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
| External state and codecs | Unit coverage for paths, symlinks, permissions, atomic replacement, locks, stale recovery, manifests, registrations, hashing, and every adapter ownership state. |
| Adapter lifecycle | Unit and packed-package checks cover install, idempotence, managed update, adoption, drift preservation, manifest-gated repair, occupied destinations, uninstall, and cache cleanup. |
| Registration and status | Unit and fake-CLI integration checks cover canonical registration, read-only status, exit status 3, corrective actions, malformed state, and stable worktree snapshots. |
| Runtime adapter | The isolated Pi 0.82 suite covers additive and replacement context, one global-context copy, reload, native resources, profile skills, collision aliases, explanation, registration gating, and stable repositories. |
| Packed real-Pi flow | `npm run test:real-pi` packs and installs Bazframe, uses the installed CLI for adapter lifecycle and registration, and probes both Pi context modes with profile instructions and a profile skill. |

The repeatable gates are:

```bash
npm test
npm run test:real-pi
BAZFRAME_ADAPTER_SOURCE="$PWD/artifacts/pi/bazframe.ts" \
  node experiments/pi-no-launcher-adapter/run-spike.mjs
```
