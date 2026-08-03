# Bazframe 2 Product Design

> Status: current product source of truth

Bazframe composes Agent Skills-compatible capabilities into reusable skill packs and profiles, then applies profiles to coding agents. A profile carries personal instructions, direct skills, and skill packs across registered repositories. Runtime adapters compose that profile with each agent's native project behavior.

## Product direction

The first production slice integrates Bazframe with Pi through a global Pi extension. Repository registration and profile selection live under the user's Bazframe home, while each repository keeps its own instructions and agent resources.

The resulting flow is:

```bash
npm install --global bazframe
bazframe adapter install pi
bazframe use focused
cd my-project
bazframe init
pi
```

`bazframe adapter install pi` is a one-time, explicit setup step. It copies Bazframe's packaged extension into Pi's global extension directory and records ownership metadata so Bazframe can update, repair, or safely uninstall only that artifact. Pi then discovers the extension automatically. Keeping installation separate from `init` ensures that registering a repository never silently changes Pi's global configuration.

The user continues to invoke Pi directly. Bazframe's global extension recognizes registered repositories and adds the active profile.

## Core objects

### Skill

A skill is an Agent Skills-compatible directory supplied through a configured skill root. Bazframe consumes this standard filesystem interface without depending on Skillbook, Git, npm, or any other particular acquisition and versioning provider.

### Skill pack

A skill pack is a named, reusable collection of skill references. Packs contain skills rather than other packs. Bazframe manages pack definitions and membership so a pack can be added to or removed from a profile as one entity.

### Profile

A profile combines personal instructions, direct skill references, and skill-pack references. Bazframe manages profile definitions, membership, selection, and application to supported coding agents.

The implemented first slice stores a profile as a user-owned directory:

```text
profiles/<id>/
├── AGENTS.md
└── skills/
    └── <skill>/SKILL.md
```

The profile-local `AGENTS.md` contains personal coding-agent instructions. Each materialized skill is an Agent Skills-compatible directory, including any supporting files used by its `SKILL.md`.

The first slice has one global active profile selected by `bazframe use <profile>`. Pack definitions, provider-neutral skill roots, and direct skill and pack references are product direction beyond the implemented profile-directory baseline.

### Repository registration

`bazframe init` records a canonical Git worktree root under `~/.bazframe/projects/`. The record opts that worktree into the Pi adapter and follows the global active profile.

Canonical local path is the repository identity for the first production slice. A moved worktree receives a new registration.

### Pi adapter

The Pi adapter is a Bazframe-owned global extension installed in Pi's configured agent directory. It resolves registrations and profiles at startup and on reload.

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
CanonicalGitRoot -> Registration(mode, profile selector)
Registration
  + ActiveSelection
  + Profile
  + RuntimeState -> EffectiveHarness
```

- A profile ID identifies one live profile directory within a Bazframe home.
- The active selection contains one valid profile ID.
- A first-slice registration selects `active`, so profile changes apply to the next startup or reload.
- A canonical Git root maps to at most one registration.
- The effective harness is resolved data; its sources retain their user, Bazframe, repository, or runtime ownership.
- Adapter-specific projection, such as a Pi skill alias, belongs to the effective harness cache rather than the source profile.

This model makes the profile the portable stored object and the effective harness the runtime composition of that profile with a registered project.

## Pi context behavior

The adapter supports two explicit Pi invocations:

| Invocation | Effective instruction context |
|---|---|
| `pi` | Pi's native global, ancestor, and repository context, followed by the active profile |
| `pi -nc` | the global Pi context restored by Bazframe, followed by the active profile |

Pi reports its context files through `systemPromptOptions.contextFiles`. The adapter uses the collection's empty/non-empty state:

```text
contextFiles present -> append profile
contextFiles empty   -> restore global Pi context, then append profile
```

This structured signal gives the adapter one bounded rule for both invocations. Detailed semantics are recorded in [`pi-adaptive-context-adapter.md`](pi-adaptive-context-adapter.md).

## Skills

For the first production slice, Bazframe discovers profile membership from the profile directory, validates skill resources through Pi's Agent Skills loader, exposes them to the runtime, projects collision aliases, and reports diagnostics.

The broader product resolves direct skills and pack members from configured Agent Skills-compatible roots. Skill acquisition, versioning, updating, and publication remain the responsibility of the user or an external source provider. Bazframe retains provenance while resolving a profile so removing one pack does not remove a skill still supplied directly or by another pack.

Profile skills enter Pi through `resources_discover`.

A profile skill keeps its name when that name is available. When Pi has already loaded a native skill with the same name, Bazframe projects an Agent Skills-compatible alias under its external cache:

```text
<name>-x-bazframe
```

The alias points to the original skill file and base directory. Diagnostics report every alias. A second collision on the generated alias is a visible profile error.

## Ownership

| Owner | Resources |
|---|---|
| User | profile and pack content, profile instructions, configured skill roots, and source-provider choices |
| Skill source provider | skill acquisition, versioning, updating, publication, and Agent Skills-compatible directories |
| Bazframe | pack and profile membership semantics, profile selection and resolution, active-profile state, repository registrations, adapter manifest, installed adapter artifact, and generated alias cache |
| Repository | worktree files and project instructions |
| Pi | settings, trust decisions, tools, models, extensions, packages, prompts, themes, system-prompt files, and native skills |

This ownership model lets Bazframe manage composition and apply personal profiles while preserving provider independence, native project behavior, and repository history.

## Commands

The first production command surface is:

```text
bazframe adapter install pi [--force]
bazframe adapter uninstall pi
bazframe init
bazframe uninit
bazframe use <profile>
bazframe status
```

Adapter installation is explicit. `init` focuses on repository registration and prints the installation command when the adapter needs attention. Registrations follow the global active profile.

`--force` repairs a drifted artifact only when a valid Bazframe ownership manifest identifies the destination. Files outside that ownership record require manual resolution.

Inside Pi, the adapter provides:

```text
/bzf-explain
/bzf-reload
```

`/bzf-reload` reloads profile instructions, skills, and collision aliases together. `/bzf-explain` reports the effective context mode and resource sources.

## Safety and diagnostics

Bazframe-managed writes use validated external paths, per-resource locks, mode-restricted temporary files, and atomic rename. Adapter install and uninstall compare artifact hashes against the ownership manifest. Repository registration is external; acceptance tests preserve the worktree snapshot and Git status.

A registered session applies a complete valid profile or reports an actionable error. Other repositories continue with their ordinary Pi behavior.

`bazframe status` reads and reports adapter ownership, drift, current repository registration, active-profile validity, skill counts, collision aliases, and corrective commands.

## Research agenda

Product research now focuses on:

- provider-neutral skill-root discovery and deterministic skill resolution;
- pack and profile storage, commands, provenance, and add/remove semantics;
- semantic composition between personal and repository-recommended profiles;
- portable profile and pack export with references to live skill sources;
- instruction and skill conflict policy across multiple runtimes.

## Implementation plan

[`pi-adapter-production-design.md`](pi-adapter-production-design.md) records the implemented production baseline, lifecycle rules, milestones, and acceptance evidence. Executable Pi 0.82 evidence is retained in the [`pi-no-launcher-adapter` experiment](../experiments/pi-no-launcher-adapter/REPORT.md).
