# Pi Adapter Production Design

> Status: outline for product review
>
> Accepted behavior: [`no-launcher-harness-override.md`](no-launcher-harness-override.md)
>
> Executable evidence: [`../experiments/pi-no-launcher-adapter/REPORT.md`](../experiments/pi-no-launcher-adapter/REPORT.md)
>
> This document proposes production installation and lifecycle UX. Unmarked command names and filesystem details are not approved until review.

## Index

1. Product boundary
2. User journeys
3. Runtime behavior
4. Proposed CLI
5. External state and ownership
6. Adapter installation lifecycle
7. Repository registration lifecycle
8. Profiles and skills
9. Diagnostics and failure behavior
10. Security and compatibility
11. Acceptance criteria
12. Review TODOs

## 1. Product boundary

Bazframe's first Pi integration is a globally installed native Pi extension. Bazframe does not launch or wrap Pi and does not write into registered repositories.

Accepted runtime behavior:

```bash
pi       # Pi native context + active Bazframe profile
pi -nc   # restored global Pi context + active profile; project context excluded
```

Both modes leave Pi settings, extensions, packages, prompts, themes, system-prompt files, models, tools, project trust, and native skills under Pi's control. Profile skills are additive. Bazframe does not claim complete harness replacement.

## 2. User journeys

### 2.1 First installation

Proposed flow:

```bash
npm install --global bazframe
bazframe adapter install pi
bazframe status
```

Installation places one Bazframe-owned extension in Pi's global extension directory without changing Pi source or settings.

### 2.2 Register a repository

From any directory inside a Git worktree:

```bash
bazframe init
```

Initialization validates the active profile and writes one external registration. It does not modify the repository.

The final summary explains both launch modes rather than selecting one implicitly.

### 2.3 Select a profile

```bash
bazframe use focused
```

New Pi sessions resolve the selected profile. A running session uses `/bzf-reload` to reload instructions, skills, and collision aliases together.

### 2.4 Inspect behavior

Outside Pi:

```bash
bazframe status
```

Inside Pi:

```text
/bzf-explain
```

### 2.5 Remove registration and adapter

Proposed flow:

```bash
bazframe uninit
bazframe adapter uninstall pi
```

Unregistration removes only the current repository's external record. Adapter uninstall removes only an extension artifact Bazframe can prove it owns. Profiles remain unless separately removed by a future profile-lifecycle command.

## 3. Runtime behavior

The extension activates only when the canonical Git root matches an external registration.

At startup or `/bzf-reload`, it:

1. resolves the repository registration;
2. resolves and validates the active profile;
3. inspects native skill commands already loaded by Pi;
4. projects colliding profile skills as `<name>-x-bazframe` in external cache;
5. returns non-colliding and projected skill files through `resources_discover`;
6. checks whether `systemPromptOptions.contextFiles` is empty;
7. when empty, restores the global Pi context file and appends profile instructions;
8. when non-empty, leaves context entirely to Pi and appends profile instructions only;
9. logs the selected context mode and skill aliases once per load.

The extension does not inspect context paths or parse Pi's generated prompt.

## 4. Proposed CLI

| Command | Proposed responsibility |
|---|---|
| `bazframe adapter install pi` | Install or safely update the global Pi extension. |
| `bazframe adapter uninstall pi` | Remove the owned Pi extension after content/ownership verification. |
| `bazframe init [--profile <id>]` | Register the canonical current Git repository externally. Default to `active`. |
| `bazframe uninit` | Remove the current repository's external registration. |
| `bazframe use <profile>` | Atomically change the global active profile. |
| `bazframe status` | Report adapter, registration, active profile, and actionable problems. |

Review must settle whether adapter installation is explicit or automatically offered by `init`.

No command launches Pi. No implicit shell alias, shim, or default-argument injection is installed.

## 5. External state and ownership

Proposed layout:

```text
~/.bazframe/
├── active-profile
├── profiles/
│   └── <profile>/
│       ├── instructions.md
│       └── skills/
├── projects/
│   └── <sha256-canonical-root>.json
├── adapters/
│   └── pi.json
└── adapter-cache/
    └── pi/skill-aliases/<profile>/<alias>/SKILL.md

~/.pi/agent/extensions/
└── bazframe.ts
```

Ownership categories for this integration:

- **User-owned:** profiles and their source skills.
- **Bazframe-managed:** project registration records, adapter ownership metadata, installed extension artifact, and generated skill-alias cache.
- **Repository-owned:** every file in the Git worktree.
- **Pi-owned:** all native runtime configuration and resources.

The adapter manifest should record the installed path, Bazframe version, artifact hash, and expected bytes or package artifact identity. Cache is disposable and reproducible.

## 6. Adapter installation lifecycle

Installation requirements:

- resolve Pi's configured agent directory without hard-coding `~/.pi/agent`;
- preflight the extension destination before writing;
- refuse to overwrite an unmanaged or modified file by default;
- write atomically with user-only permissions where supported;
- install a versioned, self-contained extension artifact using only Node built-ins and Pi's public package exports;
- record ownership only after the artifact is installed successfully;
- be idempotent when expected bytes are already installed.

Upgrade requirements:

- compare installed and desired artifact identity;
- report drift before replacement;
- never silently replace an unmanaged extension;
- preserve registrations, profiles, and cache unless migration requires an explicit validated step.

Uninstall requirements:

- remove only an artifact matching recorded or reconstructable expected identity;
- preserve modified or unrecognized files and return an actionable failure;
- remove adapter ownership metadata after successful artifact removal;
- leave Pi settings and unrelated extensions unchanged.

## 7. Repository registration lifecycle

A registration contains at least:

```json
{
  "schemaVersion": 1,
  "repository": "/canonical/path/to/repo",
  "mode": "adaptive-context",
  "profile": "active"
}
```

Initialization requirements:

- require a Git worktree and canonicalize its root;
- ignore inherited Git repository-selection environment variables;
- validate the selected or active profile before writing;
- compute the registration key from the same canonical root used by the extension;
- preflight an existing registration and require explicit replacement when its content differs;
- atomically write external state with no repository mutation;
- print plain `pi` and `pi -nc` behavior in the final summary.

Unregistration removes only the matching external registration. A moved or renamed repository is not silently matched; identity beyond canonical local path remains deferred.

## 8. Profiles and skills

The first production slice retains the validated profile shape:

```text
profiles/<id>/
├── instructions.md
└── skills/<skill>/SKILL.md
```

Requirements:

- profile IDs use lowercase letters, digits, and single hyphens;
- instruction files are bounded, regular UTF-8 files without NUL bytes;
- Agent Skills parsing uses Pi's public loader;
- non-colliding profile skill names remain unchanged;
- a collision with an already loaded native skill becomes `<name>-x-bazframe`;
- generated aliases remain Agent Skills-compatible and point to the original skill file/base directory;
- alias mappings are logged and shown in diagnostics;
- an alias that also collides fails explicitly;
- collisions with resources simultaneously returned by another extension remain a documented limitation.

This slice does not add profile creation, import/export, or skill artifact lifecycle management.

## 9. Diagnostics and failure behavior

### 9.1 `bazframe status`

Status should report:

- Bazframe home;
- Pi adapter path, installed version/hash, and current/drifted/missing state;
- canonical current repository and registration state;
- active or pinned profile and validation state;
- profile instruction source and skill count;
- generated collision aliases currently present in cache;
- launch guidance for `pi` and `pi -nc`;
- corrective commands for every failure.

Status is read-only and must not create cache or repair state.

### 9.2 `/bzf-explain`

The runtime command reports effective session facts:

- additive or instruction-context replacement mode;
- whether global context was left to Pi or restored by Bazframe;
- native context files reported by Pi;
- profile instructions and skills;
- skill collision aliases;
- registration and canonical repository paths;
- native resource categories that remain Pi-owned.

### 9.3 Failure policy

A registered session must fail visibly rather than partially apply an invalid profile. Unregistered repositories remain fully native.

Failures include malformed registration, missing/invalid active profile, invalid instructions, unreadable skills, duplicate profile names, unresolvable alias collisions, and unsafe external paths.

## 10. Security and compatibility

- Project trust remains exclusively Pi's security decision.
- Profiles and skills are trusted user-controlled instructions/code.
- The extension never writes to a repository.
- External writes are confined to validated Bazframe state/cache and the explicitly installed extension path.
- Symlinks are followed only under the documented trusted-profile boundary; exact containment policy requires review.
- The initial compatibility target is Pi 0.82 on the currently supported Node/macOS baseline.
- Startup must fail clearly when required public Pi APIs are unavailable or behavior no longer matches the supported contract.
- The all-or-nothing context assumption must be version-gated or revalidated if Pi adds selective context loading.

## 11. Acceptance criteria

A production-ready first slice must prove:

1. clean install, idempotent reinstall, safe upgrade, clean uninstall, and drift preservation;
2. external init/status/uninit without any repository file or Git-status change;
3. plain `pi` retains native context once and appends the active profile;
4. `pi -nc` restores global context once, excludes ancestor/project context, and appends the profile;
5. active-profile changes are observed after `/bzf-reload`;
6. native project resources remain active under Pi's own trust behavior;
7. skill collisions produce deterministic `-x-bazframe` aliases and logs;
8. unregistered repositories retain native behavior;
9. broken registration/profile/cache/adapter states produce actionable diagnostics;
10. packed-package tests exercise the installed CLI and a real supported Pi executable in isolated user state.

## 12. Review TODOs

### Product decisions

- [ ] Approve or revise the proposed command names.
- [ ] Decide whether `init` automatically installs the Pi adapter, offers installation interactively, or requires an explicit prior command.
- [ ] Decide whether registrations always follow the global active profile or may pin a profile in the first slice.
- [ ] Approve plain `pi` additive mode as normal behavior and `pi -nc` as explicit instruction-context replacement terminology.
- [ ] Decide whether adapter drift replacement gets a `--force` option or a separate repair command.

### Architecture decisions

- [ ] Choose copied self-contained extension artifact versus a stable loader that imports the installed Bazframe package.
- [ ] Define adapter ownership-manifest schema, versioning, and migration behavior.
- [ ] Define exact atomic-write, permissions, symlink, lock, and concurrent-install policy for external state.
- [ ] Define stale alias-cache pruning and concurrent-session behavior.
- [ ] Define supported Pi/Node/platform versions and compatibility failure behavior.
- [ ] Decide whether canonical-path registration is sufficient for v1 worktrees, repository moves, and clones.

### Implementation planning

- [ ] Split the accepted design into installation, registration/status, runtime packaging, and end-to-end validation milestones.
- [ ] Replace the experimental extension's synchronous filesystem/process calls where production behavior requires cancellation or bounded latency.
- [ ] Add unit tests for registration codecs, ownership comparison, alias generation, and diagnostics.
- [ ] Add isolated real-Pi tests for both context modes, reload, collisions, drift, and uninstall.
- [ ] Remove or explicitly deprecate the launcher prototype only after the production adapter passes all acceptance criteria.
