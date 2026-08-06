# Bazframe 2 prototype contract

> Status: deprecated launcher prototype retained temporarily for migration and historical validation.
>
> This records the reversible contract and assumptions of the launcher vertical slice. The current product direction is [`design.md`](design.md).

## Migration to the Pi adapter

The production path uses direct Pi invocation through the global adapter:

```bash
bazframe adapter install pi
bazframe use <profile>
cd <worktree>
bazframe status
pi       # native context + profile
pi -nc   # global context + profile
```

This replaces `bazframe pi` and its temporary composed instruction file. Profiles use a profile-local `AGENTS.md` plus immediate Agent Skills-compatible skill directories. Rename an earlier prototype profile's `instructions.md` to `AGENTS.md` when migrating. Git worktrees resolve project override before global policy; absent global state means enabled.

Use `bazframe global enable|disable` for global policy and `bazframe project enable|disable` for a worktree override. Old init/uninit forms now return migration guidance. Use `bazframe adapter uninstall pi` to remove the verified extension artifact. The deprecated launcher remains available during this migration window.

## Implemented launcher contract

- Scope is only `bazframe use <profile>` and `bazframe pi [--dry-run] [-- <pi args>]` for Pi.
- Profiles are trusted, pre-existing directories under `BAZFRAME_HOME/profiles`. Selection is one global plain-text `active-profile` file.
- A launch requires a Git worktree. Git discovery ignores inherited repository-selection variables, canonicalizes the root and cwd, and requires the cwd to be contained by that root.
- Instructions are the selected profile's required `AGENTS.md`, followed textually by optional root `AGENTS.md`, with visible source headings. This profile-first ordering is an experiment, not a conflict or precedence policy.
- Instruction files are opened once with read-only, nonblocking filesystem flags, inspected through that handle as regular files, and read with a 1 MiB bound before UTF-8 and NUL validation.
- The effective prompt is a mode-`0600` temporary file outside the repository. Bazframe passes it with `--no-context-files --append-system-prompt`; it does not create a repository `.baz.agents.md`.
- Immediate profile skill directories containing `SKILL.md` are passed with explicit `--skill` arguments. **Pi's native skill discovery deliberately remains enabled**, so profile skills are additive rather than exclusive in this prototype.
- Pi is spawned without a shell in the caller's cwd. On real launches Bazframe diagnostics go to stderr and Pi owns stdout byte-for-byte. Help, version, `use`, and dry-run retain their documented stdout output.
- After Pi exits, Bazframe attempts to remove the temporary effective file. Cleanup failure is Bazframe failure status `1`, superseding Pi's status because sensitive generated content remains on disk.
- Startup session options are rejected. `--mode rpc` and `--mode=rpc` are also rejected because RPC can switch sessions without repository-aware recomposition.

The validated baseline is Node.js >=22.19.0, Git, Pi 0.82.0, and macOS/POSIX process behavior.

## Explicit deviations from the concept draft

These are prototype choices, not product decisions:

- no repository `.baz.agents.md`; prompt transport uses system-temporary storage;
- native Pi skills remain available and profile skills are additive;
- instruction composition is profile-first textual concatenation, not a semantic merge;
- only Pi is supported; there is no agent/provider abstraction.

Profile authoring, skill lifecycle commands, export/import, ownership, packaging, and multi-agent behavior remain out of scope.

## Known limitations and trust assumptions

- Interactive Pi `/resume` or `/import` can move to a session from another repository while retaining stale effective instructions. They **must not be used** during a Bazframe launch. Startup session options and RPC mode are rejected, but interactive commands are not intercepted.
- In Pi 0.82, supplying explicit `--append-system-prompt` suppresses Pi's automatic global/project `APPEND_SYSTEM.md` discovery. Bazframe does not restore those files.
- Signal forwarding and cleanup behavior is POSIX/macOS-only. Forwarding SIGINT/SIGTERM may duplicate a signal already delivered to the foreground process group; hard kills, crashes, and unhandled termination signals can leave temporary files.
- Windows npm command shims are not supported by the shell-free launcher or package smoke check.
- Profiles, repository instructions, and skills are trusted local content. Trusted symlinks are followed; there is no v1-style containment, ownership, audit, or sandbox engine.
- `--no-context-files` disables Pi's normal global, ancestor, nested, and `CLAUDE.md` context discovery. Only root `AGENTS.md` is restored by Bazframe.
- Native-skill collisions and project trust remain Pi-owned. Launches are not hermetic because Pi still manages extensions, templates, themes, settings, packages, and other native resources.
