# Bazframe

Bazframe is an open-source companion for the [Pi coding agent](https://github.com/earendil-works/pi). Pi is a terminal coding agent that lets a language model read, edit, and run code. A Bazframe **profile** is a named set of personal `AGENTS.md` instructions with optional reusable Skills. An [Agent Skill](https://agentskills.io/) is a standard directory of instructions and supporting files that a compatible agent can load.

Bazframe lets you use reusable personal instructions and standard Agent Skills across projects without replacing repository instructions. It adds the active profile as a separate layer after Pi's own context:

```text
Pi's tools, model, and settings ─┐
Current project's instructions  ─┼─> Pi session
Active Bazframe profile ─────────┘
```

The current release is a public beta for macOS and Linux and requires Pi 0.82.0 or newer.

## Install

### Requirements

- [Node.js](https://nodejs.org/) 22.19.0 or newer.
- Pi 0.82.0 or newer.
- macOS or Linux.
- A model provider supported by Pi; see [Pi's authentication documentation](https://github.com/earendil-works/pi#readme).
- [Git](https://git-scm.com/) only for Git-worktree project overrides and managed Git resources. Basic profile use does not require Git.

### Install Pi and Bazframe

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent
npm install --global bazframe@next
```

`next` is Bazframe's explicit beta channel. Verify both installations:

```bash
pi --version
bazframe --version
```

Bazframe reports `Bazframe <installed-version>`. Pi login, updates, and adapter reinstall guidance are in [Getting started](docs/getting-started.md).

## Quick start

### Create your first profile

Before running these commands, `VISUAL` or `EDITOR` must name an editor executable. When the editor opens, add one personal instruction, for example: `Explain unfamiliar code in plain language.`

```bash
bazframe adapter install pi
bazframe profile add focused
bazframe profile edit focused
bazframe profile use focused
bazframe status
```

In the status output, confirm these stable success signals:

- `Pi adapter` is `current`.
- `Effective behavior` is `enabled`.
- `Active profile` is `focused`.

### Confirm it in Pi

Start Pi normally:

```bash
pi
```

Inside Pi, run `/bazframe info`. `Profile: focused` confirms that Bazframe added the profile to the session. After changing an open session's profile or Skill activation, run `/bazframe reload`.

See [Getting started](docs/getting-started.md) for expanded setup, editor, policy, and troubleshooting guidance.

## What Bazframe manages

### Profiles

Profiles contain personal `AGENTS.md` instructions and optional Skill memberships or library/package references. One profile is globally active. Bazframe appends that profile as a separate opaque layer; it does not merge, rank, or override repository instructions.

Use `bazframe profiles` to inspect profiles and `bazframe profile current` for the active profile ID.

### Agent Skills, libraries, and packages

Bazframe uses the standard [Agent Skills](https://agentskills.io/) format and defines no alternative Skill format:

- An **added Skill** is one live provider Skill.
- A **Skill library** is an already-prepared collection; library operations execute no provider code.
- A **Skill package** is an explicitly buildable provider project.

Installing the npm package activates neither a profile nor the shipped `bazframe` and `bazify` Skills. See [Using Skills with Bazframe](docs/skills.md) for resource lifecycles, managed Git providers, Bazify, ownership, and troubleshooting.

### Global and project policy

Profiles apply by default in Git and non-Git directories. A canonical Git worktree can override the global policy; non-Git directories inherit the global policy. See [Getting started](docs/getting-started.md#control-global-and-project-policy) for the commands.

### Terminal interface

```bash
bazframe tui
```

This implemented beta interface has `Skills`, `Profiles`, `Adapters`, and `Settings` views. It can inspect resources, manage profiles and individual Skill memberships, edit live profile or added-Skill text, and add a reviewed Skill library; adapter and settings views are read-only. It is not presented as broadly production-ready. See the [terminal UI design](docs/tui-design.md) for the implemented boundary and remaining gates.

## Safety

Profiles and Skills become trusted input to an agent with filesystem and shell authority. Libraries execute no provider code. Package add, build, and update operations execute declared argv without a shell or sandbox and inherit your user authority. Review remote instructions and package build declarations before activation.

See [Using Skills with Bazframe](docs/skills.md#editing-and-ownership) for ownership and [its troubleshooting section](docs/skills.md#troubleshooting) for recovery details.

## Command overview

| Resource | Entry points |
|---|---|
| Profiles | `bazframe profiles`, `bazframe profile` |
| Added Skills | `bazframe skills`, `bazframe add skill`, `bazframe remove skill` |
| Skill libraries | `bazframe libraries`, `bazframe profile libraries` |
| Skill packages | `bazframe packages`, `bazframe profile packages` |
| Global/project policy | `bazframe global`, `bazframe project`, `bazframe projects` |
| Adapters | `bazframe adapters`, `bazframe adapter` |
| Setup status | `bazframe status` |
| Terminal interface | `bazframe tui` |

Run `bazframe help <resource>` or `bazframe <resource> --help` for canonical command syntax.

## Documentation

1. [Getting started](docs/getting-started.md) — installation, first profile, policy, and configuration.
2. [Using Skills with Bazframe](docs/skills.md) — Skills, libraries, packages, managed Git, and Bazify.
3. [Terminal UI design](docs/tui-design.md) — implemented TUI boundary and remaining gates.
4. [Fresh-machine setup recipe](examples/setup-fresh-machine.sh) — bootstrap commands for a new machine.
5. [Product design](docs/design.md) — product contracts for contributors.
6. [Release process](docs/releasing.md) — release validation and publication.

## Support

Report bugs and ask usage questions in [GitHub issues](https://github.com/sram1337/bazframe/issues).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, validation, safety guidance, and pull request expectations.

## License

[MIT](LICENSE)
