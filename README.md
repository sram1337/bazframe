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
export EDITOR=/path/to/your/editor
bazframe profile edit focused
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

Use `/bazframe reload` after changing a profile, library activation, or package activation while Pi is open.

## Core workflows

### Switch between profiles

Each profile has its own `AGENTS.md` instructions and skill membership. One profile is active across working directories.

```bash
bazframe profile add reviewer
bazframe profile use reviewer
bazframe profiles
```

Edit any active or inactive profile explicitly, then start a new Pi session or run `/bazframe reload` in an existing one:

```bash
bazframe profile edit reviewer
```

Bazframe uses the first nonblank `VISUAL`, then `EDITOR`, as one executable name or path. It does not parse flags, invoke a shell, or choose a fallback editor. If an editor needs fixed flags such as `--wait`, configure an executable wrapper. Bazframe edits the actual profile `AGENTS.md` directly and waits only for that process; a GUI launcher that returns immediately also needs a waiting wrapper.

The manual equivalent is to open `${BAZFRAME_HOME:-$HOME/.bazframe}/profiles/<profile>/AGENTS.md` directly with an editor. Other lifecycle commands include `duplicate`, `rename`, and `remove`:

```bash
bazframe profile --help
bazframe profile remove --help
```

The second command explains the safeguards around profile deletion.

### Add an individual Skill

A **Skill** is a directory conforming to the [Agent Skills specification](https://agentskills.io) and containing a `SKILL.md` file with instructions for a coding agent. A profile's Skills are optional. Bazframe's `(default)` catalog stores absolute links to canonical external Skill directories; providers retain their content. See [Using Skills with Bazframe](docs/skills.md) for the standard format, Bazframe lifecycle choices, validation timing, and troubleshooting.

Create a minimal local skill for this example:

```bash
SKILL_ROOT="$HOME/example-skills/explain-code"
mkdir -p "$SKILL_ROOT"
cat > "$SKILL_ROOT/SKILL.md" <<'EOF'
---
name: explain-code
description: Explain unfamiliar code in plain language.
---

# Explain code

Describe the code's purpose, data flow, and important assumptions.
EOF
```

Register the external directory, then add the skill to the active profile:

```bash
bazframe add skill "$SKILL_ROOT"
bazframe skills
bazframe profile skills add explain-code
bazframe profile skills
```

After `/bazframe reload`, `/bazframe info` should report `Flat direct skills: 1` and list `explain-code`.

Open an added Skill's live provider definition explicitly with the same external-editor contract used for profiles:

```bash
bazframe skill edit explain-code
```

The command derives the provider `SKILL.md` from the `(default)` entry rather than trusting a displayed path. A successful editor exit does not claim that content was saved. Skills from libraries and packages come from immutable snapshots and cannot be edited this way; edit provider input, then run `bazframe libraries update <library>` or `bazframe packages build <package>`.

The added Skill and its profile membership are parallel links to the same provider directory. Provider changes are visible after a new Pi session or `/bazframe reload`. Remove the profile membership before `bazframe remove skill explain-code`; catalog removal is refused while any profile references it.

Bazframe's npm package ships the `bazframe` and `bazify` Skills under `dist/skills/`. Add either generated directory with `bazframe add skill <installed-package>/dist/skills/<skill>`; installation itself never changes the `(default)` catalog or profile membership.

### Add a Skill library or Skill package

Use a **Skill library** for an already-prepared directory of zero or more Skills. Its ID is the canonical root basename and must be 1–64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen:

```bash
TOOLKIT="$HOME/example-toolkit"
mkdir -p "$TOOLKIT/review-code"
cat > "$TOOLKIT/review-code/SKILL.md" <<'SKILL'
---
name: review-code
description: Review a change for correctness and maintainability.
---
# Review code
SKILL
bazframe libraries add "$TOOLKIT"                 # initial snapshot and activation
bazframe profile libraries add example-toolkit      # attach the whole library
```

Provider changes become active only after `bazframe libraries update example-toolkit`.

Use a **Skill package** for a provider-owned buildable project containing zero or more ordinary Skills. Its ID is the canonical root basename and must be 1–64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen (`my-package` here). Its required `bazframe-package.json` declares literal build argv, an artifact root, and a Skills root:

```json
{
  "schemaVersion": 1,
  "build": ["npm", "run", "build"],
  "artifactRoot": "dist",
  "skillsRoot": "skills"
}
```

```bash
bazframe packages add /absolute/path/to/my-package  # initial build and activation
bazframe profile packages add my-package            # attach the whole package

# After changing package source:
bazframe packages build my-package                  # build and activate a new snapshot
```

Both package add and package build are explicit and unsandboxed. Bazframe snapshots the complete artifact root, including shared resources, while discovering Skills only below the Skills root. Profile references never build or select individual children. See [Using Skills with Bazframe](docs/skills.md) for the complete layout, lifecycle, and runnable example.

### Bazify Skills

The shipped `bazify` Skill packages one Skill or a collection with provider source under `skills/`, generated artifacts under `dist/skills/`, and a Bazframe package manifest. It extracts Skills from a broader project into a new package, or adapts a dedicated Skill repository in place.

```bash
# Extract one Skill or every immediate Skill under a source root's skills/ directory.
node <bazify-skill-root>/scripts/bazify.mjs create /absolute/path/to/source

# Add Bazframe compatibility to a dedicated Skill repository.
node <bazify-skill-root>/scripts/bazify.mjs adapt /absolute/path/to/skill-repository

node <bazify-skill-root>/scripts/bazify.mjs validate /absolute/path/to/package
```

New packages default to `~/<name>` and use the source Skill or collection name. Bazify uses disposable validation state and `./bazframe/` for temporary review tracking. A new package can be published to a consent-bound private GitHub repository after preview; an adapted repository continues through its existing Git workflow. See [Using Skills with Bazframe](docs/skills.md#bazify-skills) for the complete workflow.

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

`bazframe tui` opens a keyboard-driven `Skills`, `Profiles`, `Adapters`, `Settings` interface. Preferred layouts show profile and Skills master-detail panes; compact layouts drill into profile details and plain-text `SKILL.md` previews with Esc/Backspace return. The Profiles list keeps Create first, then the current profile, favorite inactive profiles, and remaining profiles. Press lowercase `f` to toggle a persistent profile favorite and lowercase `x` for guarded profile deletion; lowercase `d` does not delete. Press `e` on an added Skill's live `(default)` preview to open its provider `SKILL.md`; library/package Skills instead show provider-input and refresh guidance. Profile details retain `e` for the selected profile's `AGENTS.md` and `x` for contextual membership removal. The interface preserves explicit inactive-profile membership editing and keeps adapter/settings status read-only.

```bash
bazframe tui
```

Press `?` for its key guide. In Skills, `o`/`c` expand or collapse groups and `a` can add an already-prepared library. The library ID is its canonical root basename, and final literal `y` creates no profile reference. Package writes and all profile library/package reference changes remain CLI-only.

## Command map

| Goal | Command |
|---|---|
| Inspect profiles | `bazframe profiles` |
| Select the active profile | `bazframe profile use <profile>` |
| Add or remove a Skill | `bazframe add skill` / `bazframe remove skill` |
| Browse added Skills | `bazframe skills` |
| Manage a profile's Skills | `bazframe profile skills` |
| Manage Skill libraries | `bazframe libraries` / `bazframe profile libraries` |
| Manage Skill packages | `bazframe packages` / `bazframe profile packages` |
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
├── profile-favorites.json
├── skills/
├── profiles/
├── libraries/
├── packages/
├── skill-snapshots/
├── projects/
└── adapters/
```

| Environment variable | Purpose | Default |
|---|---|---|
| `BAZFRAME_HOME` | Bazframe profiles, settings, libraries, packages, snapshots, and adapter records | `~/.bazframe` |
| `PI_CODING_AGENT_DIR` | Pi’s global configuration and extension directory | `~/.pi/agent` |

Each override must be an absolute path.

## Safety

Profiles and skills become trusted input to a coding agent with filesystem and shell tools. Review their instructions and scripts before adding them. Review a package's build declaration before running `packages add` or `packages build`. `bazframe profile remove --force` permanently deletes the named non-active profile directory.

`bazframe status` reports adapter ownership, active-profile validity, effective project behavior, library/package health, and corrective actions.

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
