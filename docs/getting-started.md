# Getting started with Bazframe

Bazframe is a Skill management tool for coding-agent harnesses. It groups standard [Agent Skills](https://agentskills.io/) and personal `AGENTS.md` instructions into reusable **profiles**. The current release provides an adapter for [Pi](https://github.com/earendil-works/pi), a terminal coding harness that gives a language model tools to read, edit, and run code. The adapter adds one active profile to Pi's existing context while preserving repository instructions.

This guide covers installation of the Pi integration, a first profile, policy, and local configuration. For Skill lifecycles, see [Using Skills with Bazframe](skills.md).

## Prerequisites and Pi authentication

You need:

- Node.js 22.19.0 or newer, including `npm`.
- Pi 0.84.4 or newer.
- macOS or Linux.
- Access to a Pi-supported model provider.

Git is not required for basic profile use or ZIP import/export. System Git is required for public Git profile import and remote resources; publishing and private Git import also require GitHub CLI (`gh`). Bazframe installs only exact profile commits reachable from the repository's `refs/heads/main`.

After installing Pi, start it and enter `/login` to choose and authenticate with a model provider. Pi supports selected subscriptions and API keys; see [Pi's provider and authentication documentation](https://github.com/earendil-works/pi#readme).

## Install and update

Install Pi and the Bazframe public beta globally:

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent
npm install --global bazframe
```

The current beta is Bazframe's default npm release. Verify the installed commands:

```bash
pi --version
bazframe --version
```

Pi must report version 0.84.4 or newer. Bazframe reports `Bazframe <installed-version>`.

To update, repeat the installation commands. After each Bazframe update, reinstall the packaged Pi adapter so its version matches the CLI:

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent
npm install --global bazframe
bazframe adapter install pi
```

`bazframe adapter install pi` also performs the initial adapter installation. If Bazframe reports that a changed owned adapter needs repair, inspect the diagnostic before using the `--force` repair described by `bazframe adapter --help`.

## Configure an editor

`bazframe profile edit` uses the first nonblank `VISUAL`, then `EDITOR`. The value must be one executable name or path:

```bash
export EDITOR=nano
```

Put the export in your shell configuration if you want it to persist. Bazframe does not parse flags, invoke a shell, or select a fallback editor. If your editor needs fixed flags such as a GUI wait option, create an executable wrapper that supplies those flags and set `VISUAL` or `EDITOR` to that wrapper. Bazframe waits for the configured process; a GUI launcher that exits immediately therefore needs a waiting wrapper.

The manual equivalent is to edit:

```text
${BAZFRAME_HOME:-$HOME/.bazframe}/profiles/<profile>/AGENTS.md
```

Replace `<profile>` with the profile ID. Run `/bazframe reload` in an existing Pi session after editing.

## Create and verify your first profile

Install the adapter, create `focused`, and open its instructions:

```bash
bazframe adapter install pi
bazframe profile add focused
bazframe profile edit focused
```

Add one concrete personal instruction, such as:

```text
Explain unfamiliar code in plain language.
```

Save the file, close the editor, activate the profile, and inspect setup:

```bash
bazframe profile use focused
bazframe status
```

A healthy result reports:

- `Pi adapter: current`
- an `Effective behavior` value beginning with `enabled`
- `Active profile: focused`

Start Pi normally:

```bash
pi
```

Run `/bazframe info` inside Pi. `Profile: focused` confirms the active profile is present. Bazframe keeps Pi's own context and appends the profile as a separate opaque layer; it does not semantically merge instructions or resolve precedence.

When a Pi session is already open, run `/bazframe reload` after changing the active profile, profile instructions, individual Skill membership, or library/package activation.

## Switch and edit profiles

One profile is globally active. Inspect available profiles and the current selection:

```bash
bazframe profile list
bazframe profile current
```

Create another profile, edit it without activating it, and then switch to it explicitly:

```bash
bazframe profile add reviewer
bazframe profile edit reviewer
bazframe profile use reviewer
```

Start a new Pi session or run `/bazframe reload` in an open one after switching. Other lifecycle operations include `duplicate`, `rename`, and guarded `remove`; use live help for their exact contracts:

```bash
bazframe profile --help
bazframe profile remove --help
```

Profile Skills are optional. An added Skill is live from its source, a Skill library is an already-prepared collection, and a Skill package is an explicitly buildable source project. Their setup and activation belong in [Using Skills with Bazframe](skills.md).

## Control global and project policy

The global policy is enabled by default, so the active profile applies in Git and non-Git directories. Change that default with:

```bash
bazframe global disable
bazframe global enable
bazframe global show
```

A project override applies to the canonical root of the current Git worktree and takes precedence over global policy:

```bash
cd /path/to/a/git-worktree
bazframe project enable
bazframe project disable
bazframe project list
```

`project enable` and `project disable` require a Git worktree. Bazframe stores the override outside the repository. Non-Git directories cannot have project overrides and inherit global policy.

## Configuration directories

| Environment variable | Purpose | Default |
|---|---|---|
| `BAZFRAME_HOME` | Profiles, policy, resources, snapshots, and adapter records | `~/.bazframe` |
| `PI_CODING_AGENT_DIR` | Pi's global configuration and extension directory | `~/.pi/agent` |

Each override must be an absolute path. For example:

```bash
export BAZFRAME_HOME=/absolute/path/to/bazframe-state
export PI_CODING_AGENT_DIR=/absolute/path/to/pi-agent-state
```

Set these before running Bazframe setup commands. Changing either value points the tools at different state; it does not copy or migrate existing state.

> **Do not copy `BAZFRAME_HOME` between machines.** Use `bazframe profile publish` for a linked GitHub profile or `bazframe profile export --profile <profile> --output <zip>` for an independent ZIP. Inspect either transport with `bazframe profile import --dry-run <zip|git:user/repository>`, then import it. Review the exact preview before sharing: Bazframe applies a finite credential-filename exclusion policy, not secret scanning. `--yes` accepts routine safe defaults and exact package-build reports; `--overwrite` alone authorizes replacement or discard. Imported profiles remain inactive until `profile use`. Exact healthy resources are reused offline, packages execute last, and only settled initial clone/fetch unavailability may create an incomplete profile.

## Diagnose setup with status

Run:

```bash
bazframe status
```

The report covers adapter ownership and version, global and effective policy, the active profile, effective Skills, library/package health, remote Git source state, and corrective actions. A nonzero status means the report lists an action to take. Common checks are:

- If the adapter is missing or outdated, run `bazframe adapter install pi`.
- If no profile is active, create one if needed and run `bazframe profile use <profile>`.
- If effective behavior is disabled, inspect `bazframe global show` and, in a Git worktree, `bazframe project list`.
- If a source change is absent from an open Pi session, follow the resource update/build guidance in [Using Skills with Bazframe](skills.md#troubleshooting), then run `/bazframe reload`.

For complete command syntax, use `bazframe help <resource>` or `bazframe <resource> --help`.
