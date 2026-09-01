---
name: bazframe
description: Manages, exports, and imports Bazframe profiles, added Skills, Skill libraries, Skill packages, policy, the Pi adapter, status, and the terminal UI. Use when configuring or diagnosing Bazframe.
compatibility: Requires the Bazframe CLI and Pi 0.84.4 or newer.
---

# Bazframe

Bazframe composes a personal profile with coding-agent runtime and repository context.

## Safety and ownership

- Use `bazframe` commands for normal state changes under `${BAZFRAME_HOME:-$HOME/.bazframe}`. Do not edit catalog links, profile memberships, records, references, snapshots, policy, or adapter artifacts manually. Follow retained remote-Git recovery guidance exactly: add/update/build require inspected manual reconciliation before removing the recovery record; removal keeps its recovery record while the listed remove command verifies and finishes forward cleanup.
- Added Skills in `(default)` are live. Local sources remain externally owned; Skills acquired from remote Git sources update only through `bazframe skill update`.
- A library is an already-prepared directory. Adding or updating one executes nothing; remote Git updates acquire the recorded branch before snapshot activation.
- A package is a buildable project with `bazframe-package.json`. Package add/build/update executes its literal argv unsandboxed with current-process-user authority.
- Library/package snapshots are immutable. Edit source input, then explicitly update the library or build the package.
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

Catalog and profile links point to the same canonical source directory. Source changes become visible on the next Pi startup or `/bazframe reload`. `bazframe skill edit <skill>` opens an externally owned added Skill through executable-only `VISUAL`, then `EDITOR`; Skills acquired from remote Git sources update from their recorded branch.

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

A library ID is its canonical root basename and must be 1–64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen. `library add` performs the initial snapshot and activation; `library update` activates source changes. Profile references attach the complete library and never prepare it. Removal is refused while referenced.

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

`package add` performs the initial build and activation; `package build` rebuilds the current source revision; `package update` acquires and activates a remote Git revision. Profile reference changes never build. Removal is refused while referenced. Removing a resource acquired from a remote Git source removes its Bazframe-managed checkout and provenance while leaving the upstream remote available. A failed library update or package build leaves the previous activated snapshot in use. Libraries and packages have typed, separate namespaces, so both may have the same ID. A healthy library or package may contain `0 Skills`; profiles always reference the complete object, never selected children.

## Bundled Skills

The npm package ships generated `bazframe` and `bazify` Skills under `dist/skills/`. Installation registers neither one. Add a desired generated directory explicitly with `bazframe skill add <installed-package>/dist/skills/<skill>`, then add its membership to a profile. `bazify` uses `./bazframe/` for review tracking, extracts one Skill or a collection into a source-owned package at `~/<name>`, adapts dedicated Skill repositories in place, and publishes new packages only to a private GitHub repository after explicit consent.

## Profiles and policy

```bash
bazframe profile list
bazframe profile add <profile>
bazframe profile edit <profile>
bazframe profile use <profile>
bazframe profile current
bazframe profile export <profile> --output <directory>
bazframe profile import --dry-run <directory>
bazframe profile import <directory>
bazframe global show
bazframe project list
```

`profile edit` opens the named profile's `AGENTS.md` without changing selection. Use an executable wrapper for editor flags or GUI wait behavior, and run `/bazframe reload` in an existing Pi session afterward.

Stage 3 package portability is live on macOS and Linux; Windows publication and full portability are not. `profile export` publishes path-free canonical `bazframe-profile.json` plus exact `profile/AGENTS.md` bytes without changing active selection. It includes direct Skills and whole libraries/packages from exact remote Git revisions. Healthy local libraries/packages export only `{ "type": "localMapping" }`, without source-machine paths, snapshots, or copied source. Healthy local direct Skills remain named omissions and have no mapping. Review exported `profile/AGENTS.md` for secrets because Bazframe does not redact user-authored instructions.

`profile import` always reports an inspection plan first. Its canonical grammar is `bazframe profile import [--json] [--as <profile>] [--map (library|package):<id>=<absolute-source-directory>]... [--dry-run | --yes] <directory>`. Supply one repeatable typed map for each declared local library/package; each root must be absolute, physical, and basename-matching:

```bash
bazframe profile import --map library:toolkit=/srv/libraries/toolkit --map package:automation=/srv/packages/automation --dry-run <directory>
bazframe profile import --as <profile> --map library:toolkit=/srv/libraries/toolkit --map package:automation=/srv/packages/automation --yes <directory>
```

Dry-run takes no Bazframe write lock and performs no Bazframe writes, network access, builds, prompts, or active-selection mutation. `--yes` is invalid with it. Execution creates or exactly reuses branch-reachable historical remote revisions, never substitutes current branch HEAD, and processes packages last. Exact healthy package reuse is offline, build/report/prompt/consent-free.

Before each new package build, inspect the exact package/source, candidate-root/cwd, literal argv, manifest path/SHA-256, artifact/Skills roots, `shell: false`, inherited-environment, and authority report. Builds are unsandboxed as `current-process-user`, may access credentials, networks, and user files, and can have nonrollbackable effects. Interactive consent accepts only literal `y` and defaults to decline; `--yes` authorizes exact revalidated reports. Limits are 64 KiB manifest; 64 argv entries, 4 KiB each and 16 KiB aggregate; 4,096-byte package paths; 30-minute builds; and 5-second termination grace.

Import retains earlier resources on partial failure; inspect recovery-required/commit-ambiguous outcomes and retry for exact reuse. JSON hides environment names/values and private physical identity fields but reports explicit local mapping roots. A newly published profile remains inactive; exact reuse of an already-active destination leaves that selection unchanged. Active selection never changes, and collection children never enter `(default)`.

## Pi adapter and diagnosis

```bash
bazframe adapter list
bazframe adapter install pi
bazframe status
bazframe tui
```

Invoke `pi` directly after installing the adapter. `bazframe status` reports remote Git sources, branches, revisions, checkout paths, and recovery guidance without network access. Use `/bazframe info` to inspect effective composition and `/bazframe reload` after profile, added Skill, library, or package changes.
