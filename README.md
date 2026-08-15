# Bazframe 2

Bazframe is a profile manager for [Pi](https://github.com/earendil-works/pi), a terminal program that lets a language model read, edit, and run code. It gives developers who use Pi across multiple repositories one place to manage personal instructions and reusable capabilities.

Choose a named profile such as `focused`, `reviewer`, or `documentation`, then start Pi normally:

```text
Pi's tools, model, and settings ─┐
Current project's instructions  ─┼─> Pi session
Active Bazframe profile ─────────┘
```

The current release is an experimental source-installed prototype for macOS and Linux. It supports Pi 0.82.0.

## Requirements

- [Node.js](https://nodejs.org/) 22.19.0 or newer. Node runs Bazframe and includes the `npm` package manager used below.
- [Git](https://git-scm.com/), both to download Bazframe and to identify repositories for project-specific settings.
- A terminal and shell on macOS or Linux.
- Access to a model provider supported by Pi. Pi can authenticate with selected subscriptions or API keys.

The quick start introduces Pi and Agent Skills as they appear.

## Install

### 1. Install Pi

Pi is the coding-agent application that hosts the model session, tools, project context, and Bazframe adapter.

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.82.0
pi --version
```

The version command should report `0.82.0`.

Start Pi once and enter `/login` to choose and authenticate with a model provider. See [Pi’s README](https://github.com/earendil-works/pi#readme) for its provider and interface documentation.

> **Dependency notice:** Pi 0.82.0 is the supported runtime for this prototype. npm currently reports security advisories in its dependency tree. Review those advisories before using the prototype with sensitive repositories or credentials.

### 2. Install Bazframe

Clone this repository, build the command-line program, and link it into your shell:

```bash
git clone https://github.com/sram1337/bazframe.git
cd bazframe
npm install
npm run build
npm link
bazframe --version
```

The version command should report `0.0.0-prototype.0`. After pulling a Bazframe update, run `npm install`, `npm run build`, and `bazframe adapter install pi` again.

## Quick start

Install the Bazframe adapter into Pi, create a profile, and give it one personal instruction:

```bash
bazframe adapter install pi
bazframe profile add focused

PROFILE_FILE="${BAZFRAME_HOME:-$HOME/.bazframe}/profiles/focused/AGENTS.md"
printf '%s\n' 'Prefer small, tested changes. Explain important tradeoffs.' > "$PROFILE_FILE"

bazframe profile use focused
bazframe status
```

A healthy status includes these lines:

```text
Pi adapter: current
Global policy: enabled
Effective behavior: enabled (global-enabled)
Active profile: focused
Corrective actions:
  (none)
```

Now open any project and start Pi:

```bash
cd /path/to/a/project
pi
```

Enter `/bazframe info` inside Pi. `Profile: focused` confirms that Bazframe added the profile. The profile’s instruction now accompanies Pi’s own project context in that session.

Use `/bazframe reload` after changing a profile or managed source while Pi is open.

## Core workflows

### Switch between profiles

Each profile has its own `AGENTS.md` instructions and skill membership. One profile is active across working directories.

```bash
bazframe profile add reviewer
bazframe profile use reviewer
bazframe profiles
```

Edit the profile shown by `bazframe profiles`, then start a new Pi session or run `/bazframe reload` in an existing one. Other lifecycle commands include `duplicate`, `rename`, and `remove`:

```bash
bazframe profile --help
bazframe profile remove --help
```

The second command explains the safeguards around profile deletion.

### Add an individual skill

An [Agent Skill](https://agentskills.io) is a directory containing a `SKILL.md` file with instructions for a coding agent. Direct skills are optional. The current workflow uses a Skillbook library: a local directory of installed skills at `~/.skillbook/skills` by default. You or a skill-library tool populate that directory; Bazframe manages profile membership.

To create a minimal local skill for this example:

```bash
SKILL_LIBRARY="${SKILLBOOK_LIBRARY:-$HOME/.skillbook}"
mkdir -p "$SKILL_LIBRARY/skills/explain-code"
cat > "$SKILL_LIBRARY/skills/explain-code/SKILL.md" <<'EOF'
---
name: explain-code
description: Explain unfamiliar code in plain language.
---

# Explain code

Describe the code's purpose, data flow, and important assumptions.
EOF
```

List the library and add the skill to the active profile:

```bash
bazframe skills
bazframe profile skills add explain-code
bazframe profile skills
```

After `/bazframe reload`, `/bazframe info` should report `Flat direct skills: 1` and list `explain-code`.

Set `SKILLBOOK_LIBRARY` to another absolute library path when your skills live elsewhere.

### Add a related collection of skills

A managed source is a named collection of Agent Skills that share files, scripts, or dependencies. Bazframe copies a prepared collection into an immutable snapshot. Profiles refer to the source by its provider and source names; the global source record selects the active snapshot.

This example creates an already-prepared source containing one skill:

```bash
TOOLKIT="$HOME/bazframe-toolkit-example"
mkdir -p "$TOOLKIT/review-code"
cat > "$TOOLKIT/review-code/SKILL.md" <<'EOF'
---
name: review-code
description: Review a change for correctness and maintainability.
---

# Review code

Inspect the change, verify its behavior, and report actionable findings.
EOF

bazframe sources add local example-toolkit "$TOOLKIT"
bazframe profile sources add local example-toolkit
bazframe profile sources
```

Here `local` is a provider namespace chosen for the example, and `example-toolkit` is the source name. Both are stable lowercase identifiers used together as the source identity.

After `/bazframe reload`, `/bazframe info` should report one profile source reference and list `review-code` under derived effective skills.

Run an explicit build after changing the input collection:

```bash
bazframe sources build local example-toolkit
```

Already-prepared directories work directly. A source that requires preparation can include `bazframe-source.json` with a build command and artifact paths. `sources add` and `sources build` run that declared command as your user. See [Managed source composition](docs/design.md#global-managed-sources-and-profile-composition) for the manifest and snapshot contract.

## Control where the profile applies

The active profile applies by default in Git repositories and other working directories. A Git repository can override the global setting.

```bash
bazframe global disable   # change the global default
bazframe project enable   # enable the current Git repository
bazframe project disable  # disable the current Git repository
bazframe global enable    # enable the global default
bazframe projects         # inspect repository settings
```

## Terminal interface

`bazframe tui` opens a keyboard-driven interface for profile lifecycle and individual skill membership. It also displays managed sources, profile source references, available skills, and setup health.

```bash
bazframe tui
```

Press `?` for its key guide. Use `bazframe sources` and `bazframe profile sources` for managed-source changes.

## Command map

| Goal | Command |
|---|---|
| Inspect profiles | `bazframe profiles` |
| Select the active profile | `bazframe profile use <profile>` |
| Browse individual skills | `bazframe skills` |
| Manage profile skill membership | `bazframe profile skills` |
| Manage shared skill collections | `bazframe sources` |
| Manage profile source references | `bazframe profile sources` |
| Control the global setting | `bazframe global` |
| Control the current Git repository | `bazframe project` |
| Inspect adapter state | `bazframe adapters` |
| Install the Pi adapter | `bazframe adapter install pi` |
| Diagnose setup | `bazframe status` |
| Open the terminal interface | `bazframe tui` |

Run `bazframe help <resource>` or `bazframe <resource> --help` for complete command syntax.

## Files and configuration

Bazframe stores user state in `~/.bazframe` by default:

```text
~/.bazframe/
├── active-profile
├── profiles/
├── sources/
├── source-snapshots/
├── projects/
└── adapters/
```

| Environment variable | Purpose | Default |
|---|---|---|
| `BAZFRAME_HOME` | Bazframe profiles, settings, sources, snapshots, and adapter records | `~/.bazframe` |
| `PI_CODING_AGENT_DIR` | Pi’s global configuration and extension directory | `~/.pi/agent` |
| `SKILLBOOK_LIBRARY` | Library containing direct Agent Skills | `~/.skillbook` |

Each override must be an absolute path.

## Safety

Profiles and skills become trusted input to a coding agent with filesystem and shell tools. Review their instructions and scripts before adding them. Review a managed source’s build declaration before running `sources add` or `sources build`. `bazframe profile remove --force` permanently deletes the named non-active profile directory.

`bazframe status` reports adapter ownership, active-profile validity, effective project behavior, source health, and corrective actions.

## Documentation

- [Product design](docs/design.md) — current behavior and data contracts
- [Pi adapter](docs/pi-adaptive-context-adapter.md) — session context and runtime integration
- [Terminal interface](docs/tui-design.md) — interaction model and current capabilities
- [Command help](#command-map) — entry points for built-in reference text

## Contributing

Bazframe contributors should read [DEV.md](DEV.md), [TODO.md](TODO.md), and the relevant section of the [product design](docs/design.md). Run the standard validation gate before submitting a change:

```bash
npm test
```

Adapter changes also use the isolated Pi compatibility gate:

```bash
npm run test:real-pi
```
