# Bazframe 2

> **First production adapter slice implemented.** Adapter lifecycle, registration, status, adaptive context, and profile skills are validated for Pi 0.82.x. The earlier `bazframe pi` launcher is deprecated and documented in the [prototype migration contract](docs/prototype.md).

The accepted first [Pi integration boundary](docs/pi-adaptive-context-adapter.md) uses a global extension with direct Pi invocation: plain `pi` keeps native context and adds the profile, while `pi -nc` restores global Pi instructions and adds the profile. The adapter responds to Pi's structured context list and leaves native project resources under Pi's ownership.

Bazframe 2 treats a coding-agent harness as a portable, first-class object. The checkout contains the validated launcher prototype and the production Pi-adapter installation lifecycle:

```text
bazframe adapter install pi [--force]
bazframe adapter uninstall pi
bazframe init
bazframe uninit
bazframe status
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

## Pi adapter lifecycle

`bazframe adapter install pi` is a one-time, explicit setup step. It copies the packaged extension artifact to `$PI_CODING_AGENT_DIR/extensions/bazframe.ts` and records its hash under `BAZFRAME_HOME/adapters/pi.json`. Pi auto-discovers that global extension, allowing users to invoke `pi` directly. Installation stays separate from `init` so repository registration never silently changes Pi's global configuration. Both environment variables accept absolute paths; their defaults are `~/.pi/agent` and `~/.bazframe`.

Installation is idempotent and updates an older artifact that still matches its ownership manifest. A changed managed artifact is preserved and reported as drift. `--force` explicitly restores that destination from the packaged artifact. An occupied destination without Bazframe ownership stays with its existing owner.

```bash
bazframe adapter install pi
bazframe adapter install pi --force  # explicit drift repair
bazframe adapter uninstall pi
```

Uninstall verifies the artifact hash, removes the ownership manifest, and clears generated Pi alias cache.

After selecting an existing profile, register a Git worktree externally and inspect the resulting state:

```bash
bazframe use focused
cd my-project
bazframe init
bazframe status
pi       # native Pi context + active profile
pi -nc   # global Pi context + active profile
bazframe uninit
```

`status` performs a read-only inspection. Exit status `3` indicates an incomplete or drifted setup and prints corrective commands. Registration files live under `BAZFRAME_HOME/projects`; worktree content and Git status stay stable.

## Prototype profile layout

`BAZFRAME_HOME` defaults to `~/.bazframe`; an override must be an absolute path.

```text
~/.bazframe/
├── active-profile
└── profiles/
    └── focused/
        ├── AGENTS.md             # required UTF-8
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

1. Opens the active profile's `AGENTS.md` once with read-only, nonblocking filesystem flags, verifies the opened handle is a regular file, performs a bounded read, and validates UTF-8 without NUL bytes.
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
| `0` | Command completed successfully; status reports a healthy setup |
| `1` | Malformed or unsafe configuration, filesystem, Git, adapter, launch, or cleanup failure |
| `2` | Bazframe command-line usage error or rejected launcher session/RPC option |
| `3` | `bazframe status` found incomplete or drifted state and printed corrective actions |
| other | The deprecated launcher's Pi exit code is propagated; SIGINT maps to 130 and SIGTERM to 143 |

If Bazframe cannot remove the temporary effective file, the launch returns Bazframe failure `1`, superseding Pi's status because sensitive generated content remains on disk.

## Development validation

The standard gate covers build, typecheck, lint, unit, fake-Pi integration, and packed-package lifecycle checks. The real-Pi gate packs and installs the package, then validates both context modes through Pi 0.82 with an isolated probe provider.

```bash
npm test
npm run test:real-pi
```

See [`docs/prototype.md`](docs/prototype.md) for this slice's reversible contract and limitations, [`docs/design.md`](docs/design.md) for the product direction, and [`docs/pi-adaptive-context-adapter.md`](docs/pi-adaptive-context-adapter.md) for the accepted Pi behavior. Earlier evidence remains in the [alternatives comparison](docs/research/prototype-alternatives.md), [MTG skill-refactor experiment](experiments/mtg-skill-refactor/REPORT.md), and broader [skill-first/external-harness problem frame](docs/research/skill-first-projects-and-external-harnesses.md).
