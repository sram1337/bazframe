---
name: bazframe
description: Manages Bazframe profiles, registered direct skills, managed skill sources, policy, the Pi adapter, status, and the terminal UI. Use when configuring or diagnosing Bazframe 2.
compatibility: Requires the Bazframe 2 CLI; current adapter commands target Pi 0.82.x.
---

# Bazframe

Bazframe composes a personal profile with coding-agent runtime and repository context.

## Safety and ownership

- Use `bazframe` commands for state under `${BAZFRAME_HOME:-$HOME/.bazframe}`. Do not edit catalog links, profile memberships, source records, snapshots, policy, or adapter artifacts manually.
- Provider directories registered in `(default)` remain provider-owned and live. Bazframe links to them; it never copies, updates, polls, or deletes their content.
- Managed sources are different: explicit add/build commands may run a provider-declared build with ordinary user authority, then Bazframe activates an immutable snapshot.
- Inspect build declarations before adding or rebuilding a managed source.
- Use `profile remove --force` or adapter `--force` only with explicit authorization.
- Treat live `bazframe --help` and resource help as authoritative when installed behavior differs from remembered instructions.

## Direct skills

Register one external Agent Skill in Bazframe's `(default)` catalog, then select it for a profile:

```bash
bazframe add skill /absolute/path/to/skill
bazframe skills
bazframe profile skills add <skill> [--profile <profile>]
bazframe profile skills
```

Catalog and profile links point directly to the same canonical provider directory. Provider changes become visible on the next Pi startup or `/bazframe reload`.

Remove profile selection before removing its catalog registration:

```bash
bazframe profile skills remove <skill> [--profile <profile>]
bazframe remove skill <skill>
```

Catalog removal is refused while any profile references the skill and never deletes provider content.

Open a registered live provider definition explicitly:

```bash
bazframe skill edit <skill>
```

This re-derives the provider-contained `SKILL.md` from `(default)` and can open malformed content for repair. It uses the same executable-only `VISUAL` then `EDITOR` contract described below. A successful child exit does not claim a save. Managed snapshots cannot be edited; use the provider workflow and then `bazframe sources build <source>`.

## Managed sources

Use managed sources for a skill or collection that should be built, snapshotted, and attached as a whole:

```bash
bazframe sources add /absolute/path/to/source
bazframe sources build <source>
bazframe profile sources add <source> [--profile <profile>]
bazframe profile sources remove <source> [--profile <profile>]
bazframe sources remove <source>
```

The source name is the canonical root basename. `sources add` and `sources build` explicitly run any declared build. Profile reference changes never build. Removal is refused while referenced.

## Profiles and policy

```bash
bazframe profiles
bazframe profile add <profile>
bazframe profile edit <profile>
bazframe profile use <profile>
bazframe profile current
bazframe global
bazframe project
```

`profile edit` opens the named active or inactive profile's actual `AGENTS.md` without changing selection. It uses the first nonblank `VISUAL`, then `EDITOR`, as one executable name or path with no shell, flag parsing, or fallback. Use an executable wrapper for fixed flags or GUI wait behavior, and run `/bazframe reload` in an existing Pi session afterward.

Global policy is enabled by default. A Git-worktree project override takes precedence.

## Pi adapter and diagnosis

```bash
bazframe adapters
bazframe adapter install pi
bazframe status
bazframe tui
```

Invoke `pi` directly after installing the adapter. Use `/bazframe info` to inspect effective composition and `/bazframe reload` after profile, direct-skill, or managed-source changes.
