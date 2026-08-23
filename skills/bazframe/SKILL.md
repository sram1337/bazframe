---
name: bazframe
description: Manages Bazframe profiles, added Skills, Skill libraries, Skill packages, policy, the Pi adapter, status, and the terminal UI. Use when configuring or diagnosing Bazframe 2.
compatibility: Requires the Bazframe 2 CLI; current adapter commands target Pi 0.82.x.
---

# Bazframe

Bazframe composes a personal profile with coding-agent runtime and repository context.

## Safety and ownership

- Use `bazframe` commands for state under `${BAZFRAME_HOME:-$HOME/.bazframe}`. Do not edit catalog links, profile memberships, records, references, snapshots, policy, or adapter artifacts manually.
- Added Skills in `(default)` remain provider-owned and live. Bazframe links to them and never updates or deletes provider content.
- A library is an already-prepared directory. Adding or updating one executes nothing.
- A package is a buildable project with `bazframe-package.json`. Package add/build executes its literal argv unsandboxed with ordinary user authority.
- Library/package snapshots are immutable. Edit provider input, then explicitly update the library or build the package.
- Treat live `bazframe --help` and resource help as authoritative.

## Added Skills

```bash
bazframe add skill /absolute/path/to/skill
bazframe skills
bazframe profile skills add <skill> [--profile <profile>]
bazframe profile skills remove <skill> [--profile <profile>]
bazframe remove skill <skill>
```

Catalog and profile links point to the same canonical provider directory. Provider changes become visible on the next Pi startup or `/bazframe reload`. `bazframe skill edit <skill>` opens only a live added Skill through executable-only `VISUAL`, then `EDITOR`.

## Skill libraries

```bash
bazframe libraries
bazframe libraries add /absolute/path/to/library
bazframe profile libraries add <library> [--profile <profile>]
bazframe libraries update <library>
bazframe profile libraries remove <library> [--profile <profile>]
bazframe libraries remove <library>
```

A library ID is its canonical root basename and must be 1–64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen. `libraries add` performs the initial snapshot and activation; `libraries update` activates provider changes. Profile references attach the complete library and never prepare it. Removal is refused while referenced.

## Skill packages

A package root must contain a physical regular `bazframe-package.json` with exactly `schemaVersion`, `build`, `artifactRoot`, and `skillsRoot`:

```json
{"schemaVersion":1,"build":["npm","run","build"],"artifactRoot":"dist","skillsRoot":"skills"}
```

A package ID is its canonical root basename and must be 1–64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen. `build` is a nonempty literal argv array. Both roots are portable relative paths (`.` is allowed). Bazframe runs `build` directly with no shell, snapshots the complete artifact root (including shared resources), and discovers Skills only below the Skills root.

```bash
bazframe packages
bazframe packages add /absolute/path/to/package
bazframe profile packages add <package> [--profile <profile>]
bazframe packages build <package>
bazframe profile packages remove <package> [--profile <profile>]
bazframe packages remove <package>
```

`packages add` performs the initial build and activation; `packages build` activates later provider changes. Profile reference changes never build. Removal is refused while referenced. A failed library update or package build leaves the previous activated snapshot in use. Libraries and packages have typed, separate namespaces, so both may have the same ID. A healthy library or package may contain `0 Skills`; profiles always reference the complete object, never selected children.

## Bundled Skills

The npm package ships generated `bazframe` and `bazify` Skills under `dist/skills/`. Installation registers neither one. Add a desired generated directory explicitly with `bazframe add skill <installed-package>/dist/skills/<skill>`, then add its membership to a profile. `bazify` uses `./bazframe/` for working files, clones one local Skill into a provider-owned Bazframe-compatible package at `~/<name>`, and publishes only to a new private GitHub repository after explicit consent.

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

`profile edit` opens the named profile's `AGENTS.md` without changing selection. Use an executable wrapper for editor flags or GUI wait behavior, and run `/bazframe reload` in an existing Pi session afterward.

## Pi adapter and diagnosis

```bash
bazframe adapters
bazframe adapter install pi
bazframe status
bazframe tui
```

Invoke `pi` directly after installing the adapter. Use `/bazframe info` to inspect effective composition and `/bazframe reload` after profile, added Skill, library, or package changes.
