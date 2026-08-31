# Bazframe - _Take your harness with you._

Move, package, and distribute [Agent Skills](https://agentskills.io/) and AGENTS.md files between projects and dev environments.

![bazframe TUI](bazframe_tui.png)

## Quick Start
### Install
```bash
npm i -g bazframe@next
```

### Setup
```bash
# add your skills to bazframe
bazframe library add /path/to/my-skills-folder

# setup your _local_ bazframe profile
bazframe profile add my-coding-harness
bazframe profile edit my-coding-harness
bazframe profile library add my-skills-folder
bazframe profile use my-coding-harness

# connect bazframe to your preferred harness*
bazframe adapter install pi
```
### Running bazframe
Then start your harness like normal:
```bash
pi
```

You should see all your profiles added skills.

 > * The current beta version supports only Pi 0.84.4 or newer on macOS and Linux.

### Requirements

- [Node.js](https://nodejs.org/) 22.19.0 or newer.
- Pi 0.84.4 or newer.
- macOS or Linux.
- A model provider supported by Pi; see [Pi's authentication documentation](https://github.com/earendil-works/pi#readme).
- (optional) [Git](https://git-scm.com/) only for remote Git sources. Basic profile use does not require Git.


### Export and import a profile (Stage 2)

Publish a reviewable directory for an explicit profile without changing the active profile:

```bash
bazframe profile export my-coding-harness --output ./my-coding-harness.bazframe-profile
```

Review `./my-coding-harness.bazframe-profile/profile/AGENTS.md` before sharing because Bazframe does not redact user-authored instructions. On the destination machine, inspect first, then import. For an artifact with no local libraries:

```bash
bazframe profile import --dry-run ./my-coding-harness.bazframe-profile
bazframe profile import ./my-coding-harness.bazframe-profile
```

If the artifact comes from the Quick Start profile above, it declares local library `my-skills-folder`. Supply the same mapping during inspection and execution; the absolute physical source directory basename must equal the library ID:

```bash
bazframe profile import --map library:my-skills-folder=/srv/skill-libraries/my-skills-folder --dry-run ./my-coding-harness.bazframe-profile
bazframe profile import --map library:my-skills-folder=/srv/skill-libraries/my-skills-folder ./my-coding-harness.bazframe-profile
# Or choose only the destination profile ID:
bazframe profile import --as imported-harness --map library:my-skills-folder=/srv/skill-libraries/my-skills-folder ./my-coding-harness.bazframe-profile
```

Stage 2 supports direct Skills from recorded exact remote Git revisions and libraries from either exact remote Git revisions or explicit local mappings. Healthy local libraries export only `{ "type": "localMapping" }`, without their source-machine path or snapshot digest. Mapping inspection is read-only; a missing mapping blocks the plan. Import creates an absent mapped library through the ordinary build-free lifecycle or exactly reuses the same canonical root, never overwriting, updating, or repointing it.

Import reports the complete plan before effects. Dry-run performs no network access, build, Bazframe write, or active-profile mutation. A newly published profile remains inactive; an exact existing destination, including one already active, may be reused without changing active selection. Execution never promotes library children into `(default)`; earlier committed resources remain after later failure and exact retry converges through reuse. Healthy local direct Skills remain explicit omissions and cannot be mapped. Packages and `--yes` remain unsupported until Stage 3. Windows publication and full profile portability remain unavailable.

### Terminal interface

```bash
bazframe tui
```

## Safety

Profiles and Skills become trusted input to an agent with filesystem and shell authority. Libraries execute no source code. Package add, build, and update operations execute declared argv without a shell or sandbox and inherit your user authority. Review remote instructions and package build declarations before activation.

See [Using Skills with Bazframe](docs/skills.md#editing-and-ownership) for ownership and [its troubleshooting section](docs/skills.md#troubleshooting) for recovery details.

## Documentation

1. [Getting started](docs/getting-started.md) — installation, first profile, policy, and configuration.
2. [Using Skills with Bazframe](docs/skills.md) — Skills, libraries, packages, remote Git sources, and Bazify.
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
