# Bazframe — _Take your harness with you._

Compose standard [Agent Skills](https://agentskills.io/) and personal `AGENTS.md` instructions into reusable profiles, then apply them to [Pi](https://github.com/earendil-works/pi) across projects and development environments.

![Bazframe TUI](https://raw.githubusercontent.com/sram1337/bazframe/main/bazframe_tui.png)

## What Bazframe does

- Keeps personal instructions and selected Skills together in one active profile.
- Adds that profile to Pi without replacing native global, ancestor, or repository instructions.
- Supports live added Skills, prepared immutable Skill libraries, and explicitly built Skill packages.
- Switches profiles globally, with optional Git-worktree project enable/disable overrides.
- Shares ready profiles through deterministic ZIP exports or versioned GitHub repositories.
- Provides a scriptable CLI, setup diagnostics, and a keyboard-first terminal UI.

Bazframe is currently a beta for Pi 0.84.4 or newer on macOS and Linux.

## Requirements

- [Node.js](https://nodejs.org/) 22.19.0 or newer, including npm.
- Pi 0.84.4 or newer.
- macOS or Linux.
- A model provider configured for Pi; see [Pi's authentication documentation](https://github.com/earendil-works/pi#readme).
- Git for remote resources and Git profile imports; [GitHub CLI](https://cli.github.com/) (`gh`) for publishing and private Git imports. Neither is required for basic profile use or ZIP sharing.

## Quick start

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent
npm install --global bazframe

# Create a profile. `profile edit` uses VISUAL, then EDITOR.
bazframe profile add personal
bazframe profile edit personal

# Add a standard Agent Skill and attach it to this profile.
bazframe skill add /absolute/path/to/review
bazframe profile skill add --profile personal review

# Select the profile and connect Bazframe to Pi.
bazframe profile use personal
bazframe adapter install pi
bazframe status

# Start Pi normally.
pi
```

Inside Pi, run `/bazframe info` to inspect the effective profile and `/bazframe reload` after changing profile instructions or resources. `bzf` is an equivalent short alias for `bazframe`.

## Skills, libraries, and packages

Bazframe keeps resource ownership explicit:

| Resource | Behavior |
| --- | --- |
| **Added Skill** | A live local or remote Git Skill registered individually in `(default)`. Local source edits are visible after reload. |
| **Skill library** | An already-prepared directory captured as an immutable snapshot. Adding or updating a library executes no source code. |
| **Skill package** | A source project with `bazframe-package.json`. Bazframe runs its declared build command, then snapshots the resulting artifact. |
| **Profile** | Personal `AGENTS.md` instructions plus individual Skills and whole-library/package references. |

```bash
# Individual local or remote Skills
bazframe skill add /absolute/path/to/a-skill
bazframe skill add git:owner/repository
bazframe profile skill add a-skill

# Prepared libraries
bazframe library add /absolute/path/to/a-library
bazframe profile library add a-library

# Buildable packages
bazframe package add /absolute/path/to/a-package
bazframe profile package add a-package
```

Acquisition and profile membership are separate: adding a resource never silently attaches it to a profile. See [Using Skills with Bazframe](docs/skills.md) for updates, immutable snapshots, package manifests, remote Git sources, editing, and recovery.

## Profiles and policy

One profile is selected globally and applies in every directory by default. A Git worktree can explicitly disable Bazframe or override a global disable:

```bash
bazframe profile list
bazframe profile use personal
bazframe global show
bazframe project disable   # current Git worktree only
bazframe project enable
```

Repository instructions remain a separate Pi-owned layer; selecting a profile does not rewrite or merge project files.

## Share profiles

Export an independent deterministic ZIP, or publish a linked private GitHub repository:

```bash
bazframe profile export --profile personal --output ./personal.bazframe-profile.zip
bazframe profile publish --profile personal
```

Inspect before importing. A newly imported profile remains inactive until explicitly selected:

```bash
bazframe profile import --dry-run ./personal.bazframe-profile.zip
bazframe profile import ./personal.bazframe-profile.zip

bazframe profile import --dry-run git:owner/personal
bazframe profile import git:owner/personal
bazframe profile use personal
```

ZIP imports are independent. Git imports stay linked for `profile update` and `profile version list|use`. Export and publish capture ready-to-use content and never build packages. Bazframe excludes defined credential filenames but does not scan file contents or instructions for secrets—review the exact preview before sharing.

See [Portable profile sharing](docs/skills.md#portable-profile-sharing) for collisions, overwrite authorization, package consent, incomplete initial imports, version selection, and JSON behavior.

## Terminal UI and diagnostics

```bash
bazframe tui
bazframe status
```

The beta TUI browses Skills and manages profiles; operations with broader execution or recovery implications remain CLI-only. `status` reports adapter, policy, profile, resource, snapshot, and recovery health without updating or building resources.

## Safety

Profiles and Skills become trusted input to an agent with filesystem and shell authority. Review remote instructions before activation. Libraries execute no source code, but package operations—and some profile imports—may execute declared build commands without a shell or sandbox after an exact report and consent. Those commands inherit your user authority.

See [editing and ownership](docs/skills.md#editing-and-ownership) and [troubleshooting](docs/skills.md#troubleshooting) for the operational boundaries.

## Documentation

1. [Getting started](docs/getting-started.md) — installation, profiles, policy, and Pi setup.
2. [Using Skills with Bazframe](docs/skills.md) — Skills, libraries, packages, sharing, remote Git sources, and Bazify.
3. [Fresh-machine setup recipe](examples/setup-fresh-machine.sh) — bootstrap commands for a new machine.
4. [Terminal UI design](docs/tui-design.md) — implemented TUI behavior and remaining gates.
5. [Product design](docs/design.md) — product contracts for contributors.
6. [Release process](docs/releasing.md) — validation and npm publication.
7. [Contributing](CONTRIBUTING.md) — development setup, validation, and pull requests.

## Support

Report bugs and ask usage questions in [GitHub issues](https://github.com/sram1337/bazframe/issues).

## License

[MIT](LICENSE)
