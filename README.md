# Bazframe
_Bring your harness with you._

Bazframe is a Skill management tool for coding-agent harnesses. It allows you to move, package, and distribute [Agent Skills](https://agentskills.io/) and AGENTS.md files between projects and dev environments.

## Quick Start
### Install
```bash
npm i -g bazframe
```

### Setup
```bash
bazframe library add /path/to/my-skills-folder   # add your skills to bazframe

bazframe profile add my-coding-harness           # create a profile
bazframe profile edit my-coding-harness          # edit the profile's AGENTS.md
bazframe profile libraries add my-skills-folder  # add skills to your profile
bazframe profile use my-coding-harness           # start using your new profile

bazframe adapters install pi                     # connect bazframe to your preferred harness*
```
### Running bazframe
Then start your harness like normal:
```bash
pi
```

You should see all your profiles added skills.

 > * The current beta version supports only Pi 0.82.0 or newer on macOS and Linux.

### Requirements

- [Node.js](https://nodejs.org/) 22.19.0 or newer.
- Pi 0.82.0 or newer.
- macOS or Linux.
- A model provider supported by Pi; see [Pi's authentication documentation](https://github.com/earendil-works/pi#readme).
- (optional) [Git](https://git-scm.com/) only for managed Git resources. Basic profile use does not require Git.
```


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
