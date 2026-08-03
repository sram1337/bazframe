# Bazframe 2

> **Experimental prototype.** This vertical slice validates one profile-specific Pi launch flow. Its filesystem model, instruction ordering, and TypeScript stack are reversible prototype assumptions—not settled product decisions. See the concise [prototype contract and limitations](docs/prototype.md).

The accepted first [Pi integration boundary](experiments/pi-no-launcher-adapter/REPORT.md) is adaptive and launcher-free: plain `pi` keeps native context and adds the profile, while `pi -nc` restores global Pi instructions plus the profile after native context is disabled. The adapter checks only whether Pi's structured context list is empty—no prompt or path parsing. Other native project resources remain Pi-owned; complete harness replacement is not claimed.

Bazframe 2 treats a coding-agent harness as a portable, first-class object. The implemented slice is intentionally only:

```text
bazframe use <profile>
bazframe pi [--dry-run] [-- <pi args>]
```

## Install for development

Requires Node.js >=22.19.0 and Git. Real launches are validated against Pi 0.82.0.

```bash
npm install
npm run build
node ./dist/cli.js --help
```

The package exposes a `bazframe` bin when installed or linked. A real launch also requires `pi` on `PATH`.

## Prototype profile layout

`BAZFRAME_HOME` defaults to `~/.bazframe`; an override must be an absolute path.

```text
~/.bazframe/
├── active-profile
└── profiles/
    └── focused/
        ├── instructions.md       # required UTF-8
        └── skills/               # optional
            └── demo-profile/
                └── SKILL.md
```

Profile IDs provisionally use 1–64 lowercase ASCII letters/digits separated by single hyphens. `active-profile` is plain text and is replaced atomically. Profiles are pre-existing, live directories; this prototype has no creation or editing UI.

Each immediate child of `skills/` that contains a regular `SKILL.md` is passed in lexical directory-name order. Supporting files remain in that directory for normal Agent Skills behavior.

Two visibly different profiles are in [`examples/profiles/focused`](examples/profiles/focused) and [`examples/profiles/reviewer`](examples/profiles/reviewer).

## Demo

From this checkout:

```bash
npm install
npm run build
BAZFRAME_CLI="$PWD/dist/cli.js"

export BAZFRAME_HOME="$(mktemp -d)/bazframe home"
mkdir -p "$BAZFRAME_HOME/profiles"
cp -R ./examples/profiles/focused "$BAZFRAME_HOME/profiles/focused"
cp -R ./examples/profiles/reviewer "$BAZFRAME_HOME/profiles/reviewer"

node "$BAZFRAME_CLI" use focused

DEMO_REPO="$(mktemp -d)/repository with spaces"
mkdir -p "$DEMO_REPO/packages/api"
git -C "$DEMO_REPO" init --quiet
printf '%s\n' 'Keep the repository demo rule.' > "$DEMO_REPO/AGENTS.md"

(
  cd "$DEMO_REPO/packages/api"
  node "$BAZFRAME_CLI" pi --dry-run -- -p "Describe the effective harness"
)

node "$BAZFRAME_CLI" use reviewer
(
  cd "$DEMO_REPO/packages/api"
  node "$BAZFRAME_CLI" pi --dry-run -- -p "Describe the effective harness"
)
```

The second dry run changes the profile instructions and explicit profile skills while retaining the same repository instructions. Remove `--dry-run` from either launch to run Pi.

A dry run writes its report to stdout: selected profile, Git root, exact caller working directory, instruction sources, sorted profile skills, effective instruction text, and conceptual shell-free argv. It never spawns Pi or creates the temporary effective file.

## Launch behavior

`bazframe pi`:

1. Opens the active profile's `instructions.md` once with read-only, nonblocking filesystem flags, verifies the opened handle is a regular file, performs a bounded read, and validates UTF-8 without NUL bytes.
2. Requires the canonical caller cwd to be inside a canonical Git worktree root; discovery clears inherited Git repository-selection variables.
3. Reads only `<git-root>/AGENTS.md`; that file may be absent.
4. Composes visibly labeled profile instructions first and root repository instructions second.
5. Creates a mode-`0600` temporary `.baz.agents.md` under the system temporary directory, after verifying that directory is outside the repository.
6. Writes pre-launch diagnostics to stderr, then launches `pi` without a shell in the caller's **exact cwd**, leaving stdout exclusively to Pi.
7. Keeps the temporary file through Pi's lifetime (including `/reload`) and attempts to remove its temporary directory after Pi exits. Inability to remove it is a Bazframe failure because sensitive generated content remains.

Conceptual wrapper-owned argv, always before user arguments:

```text
--no-context-files
--append-system-prompt /absolute/temporary/.baz.agents.md
--skill /absolute/profile/skills/one
--skill /absolute/profile/skills/two
...forwarded Pi arguments...
```

The wrapper's `--` delimiter is not sent to Pi. The following forwarded options are rejected because they can select or switch to a session composed for another cwd: `--continue`/`-c`, `--resume`/`-r`, `--session`, `--session-id`, `--fork` (including long `--option=value` forms), and RPC mode (`--mode rpc` or `--mode=rpc`). Other post-delimiter arguments are forwarded unchanged.

In the default and recommended layout, `BAZFRAME_HOME` and the temporary prompt transport are outside the repository, so Bazframe setup writes no repository files. A user may explicitly set absolute `BAZFRAME_HOME` inside a repository; Bazframe does not prohibit that configuration, and `bazframe use` then writes `active-profile` there. Pi itself remains an ordinary coding agent with its configured tools and can change the repository after launch.

## Limits and trust boundaries

- Profile-first/repository-second concatenation is a transport experiment, **not** a precedence or conflict-resolution policy.
- `--no-context-files` prevents duplicate root loading but also disables Pi's normal global, ancestor, nested, and `CLAUDE.md` context discovery. This slice restores only root `AGENTS.md`.
- Pi's native user/project/settings/package skill discovery **deliberately stays enabled for this prototype**; explicit profile skills are additive, not an exclusive Bazframe-owned set. Project resources still follow Pi's project-trust rules. A user-forwarded Pi option can alter native behavior.
- Skill collisions are not resolved by Bazframe. Pi currently warns and keeps its first-discovered skill.
- Profiles, repository instructions, and skills are trusted local content. Skills may instruct the model to run arbitrary code; Bazframe does not audit or sandbox them. Trusted symlinks are followed.
- Interactive `/resume` or `/import` can switch repositories while retaining stale effective instructions and **must not be used** during a Bazframe launch.
- In Pi 0.82, explicit `--append-system-prompt` suppresses automatic `APPEND_SYSTEM.md` discovery. Pi extensions, prompt templates, themes, settings, packages, and other native resources remain Pi-managed, so launches are not hermetic.
- Instruction sources and the composed prompt are capped at 1 MiB. Non-UTF-8 and NUL-containing instruction files fail before launch.
- Signal forwarding and cleanup are POSIX/macOS-only and may duplicate foreground-process-group SIGINT/SIGTERM delivery. Hard kills, crashes, or unhandled termination signals can leave a system-temporary directory behind.
- Windows npm command shims are not supported by this prototype's shell-free launcher or package smoke check.
- Pi path-as-prompt behavior was validated against installed Pi 0.82.0 but is not version-pinned by this prototype.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Help/version/use/dry-run success, or Pi exited 0 |
| `1` | Configuration, profile, filesystem, Git, launch, or temporary cleanup failure |
| `2` | Bazframe command-line usage error or rejected Pi session/RPC option |
| other | Pi's numeric exit code is propagated; SIGINT maps to 130 and SIGTERM to 143 |

If Bazframe cannot remove the temporary effective file, the launch returns Bazframe failure `1`, superseding Pi's status because sensitive generated content remains on disk.

## Development validation

```bash
npm run build
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:pack
npm test
```

See [`docs/prototype.md`](docs/prototype.md) for this slice's reversible contract and limitations, [`docs/design.md`](docs/design.md) for the broader concept, and [`docs/no-launcher-harness-override.md`](docs/no-launcher-harness-override.md) for the current narrowed direction. Earlier evidence remains in the [alternatives comparison](docs/research/prototype-alternatives.md), [MTG skill-refactor experiment](experiments/mtg-skill-refactor/REPORT.md), and broader [skill-first/external-harness problem frame](docs/research/skill-first-projects-and-external-harnesses.md).
