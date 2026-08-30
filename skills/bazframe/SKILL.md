---
name: bazframe
description: Manages Bazframe profiles, added Skills, Skill libraries, Skill packages, policy, the Pi adapter, status, and the terminal UI. Use when configuring or diagnosing Bazframe.
compatibility: Requires the Bazframe CLI and Pi 0.82.0 or newer.
---

# Bazframe

Bazframe composes a personal profile with coding-agent runtime and repository context.

## Safety and ownership

- Use `bazframe` commands for normal state changes under `${BAZFRAME_HOME:-$HOME/.bazframe}`. Do not edit catalog links, profile memberships, records, references, snapshots, policy, or adapter artifacts manually. Follow retained managed-Git recovery guidance exactly: add/update/build require inspected manual reconciliation before removing the recovery record; removal keeps its recovery record while the listed remove command verifies and finishes forward cleanup.
- Added Skills in `(default)` are live. Absolute-path providers remain externally owned; managed Git Skills update only through `bazframe skill update`.
- A library is an already-prepared directory. Adding or updating one executes nothing; managed Git updates acquire the recorded branch before snapshot activation.
- A package is a buildable project with `bazframe-package.json`. Package add/build/update executes its literal argv unsandboxed with ordinary user authority.
- Library/package snapshots are immutable. Edit provider input, then explicitly update the library or build the package.
- Treat live `bazframe --help` and resource help as authoritative.

## Added Skills

```bash
bazframe skill add /absolute/path/to/skill
bazframe skill add git:<owner>/<repository>
bazframe skill update [--accept-rewrite] <skill>
bazframe skill list
bazframe profile skill add [--profile <profile>] <skill>
bazframe profile skill remove [--profile <profile>] <skill>
bazframe skill remove <skill>
```

Catalog and profile links point to the same canonical provider directory. Provider changes become visible on the next Pi startup or `/bazframe reload`. `bazframe skill edit <skill>` opens an externally owned added Skill through executable-only `VISUAL`, then `EDITOR`; managed Git Skills update from their recorded branch.

## Skill libraries

```bash
bazframe library list
bazframe library add /absolute/path/to/library
bazframe library add git:<owner>/<repository>
bazframe profile library add [--profile <profile>] <library>
bazframe library update [--accept-rewrite] <library>
bazframe profile library remove [--profile <profile>] <library>
bazframe library remove <library>
```

A library ID is its canonical root basename and must be 1–64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen. `library add` performs the initial snapshot and activation; `library update` activates provider changes. Profile references attach the complete library and never prepare it. Removal is refused while referenced.

## Skill packages

A package root must contain a physical regular `bazframe-package.json` with exactly `schemaVersion`, `build`, `artifactRoot`, and `skillsRoot`:

```json
{"schemaVersion":1,"build":["npm","run","build"],"artifactRoot":"dist","skillsRoot":"skills"}
```

A package ID is its canonical root basename and must be 1–64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen. `build` is a nonempty literal argv array. Both roots are portable relative paths (`.` is allowed). Bazframe runs `build` directly with no shell, snapshots the complete artifact root (including shared resources), and discovers Skills only below the Skills root.

```bash
bazframe package list
bazframe package add /absolute/path/to/package
bazframe package add [--yes] git:<owner>/<repository>
bazframe profile package add [--profile <profile>] <package>
bazframe package build <package>
bazframe package update [--accept-rewrite] [--yes] <package>
bazframe profile package remove [--profile <profile>] <package>
bazframe package remove <package>
```

`package add` performs the initial build and activation; `package build` rebuilds the current provider revision; `package update` acquires and activates a managed Git revision. Profile reference changes never build. Removal is refused while referenced. Removing a managed resource removes its Bazframe checkout and provenance while leaving the upstream remote available. A failed library update or package build leaves the previous activated snapshot in use. Libraries and packages have typed, separate namespaces, so both may have the same ID. A healthy library or package may contain `0 Skills`; profiles always reference the complete object, never selected children.

## Bundled Skills

The npm package ships generated `bazframe` and `bazify` Skills under `dist/skills/`. Installation registers neither one. Add a desired generated directory explicitly with `bazframe skill add <installed-package>/dist/skills/<skill>`, then add its membership to a profile. `bazify` uses `./bazframe/` for review tracking, extracts one Skill or a collection into a provider-owned package at `~/<name>`, adapts dedicated Skill repositories in place, and publishes new packages only to a private GitHub repository after explicit consent.

## Profiles and policy

```bash
bazframe profile list
bazframe profile add <profile>
bazframe profile edit <profile>
bazframe profile use <profile>
bazframe profile current
bazframe global show
bazframe project list
```

`profile edit` opens the named profile's `AGENTS.md` without changing selection. Use an executable wrapper for editor flags or GUI wait behavior, and run `/bazframe reload` in an existing Pi session afterward.

## Pi adapter and diagnosis

```bash
bazframe adapter list
bazframe adapter install pi
bazframe status
bazframe tui
```

Invoke `pi` directly after installing the adapter. `bazframe status` reports managed Git remotes, branches, revisions, provider paths, and recovery guidance without network access. Use `/bazframe info` to inspect effective composition and `/bazframe reload` after profile, added Skill, library, or package changes.
