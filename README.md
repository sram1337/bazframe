# Bazframe 2

> **The production adapter and explicit managed source preparation/snapshot lifecycle are implemented; the first TUI management slice remains in progress.** Adapter lifecycle, profiles, project-over-global policy, flat skills, explicit declared builds, immutable content-addressed snapshots, Pi-authoritative bounded snapshot derivation, and individual child projection target Pi 0.82.x. `bazframe tui` manages profiles and selected-profile flat membership but intentionally keeps global-source and profile-reference mutation CLI-only. The earlier `bazframe pi` launcher is deprecated and documented in the [prototype migration contract](docs/prototype.md).

The accepted first [Pi integration boundary](docs/pi-adaptive-context-adapter.md) uses a global extension with direct Pi invocation: plain `pi` keeps native context and adds the profile, while `pi -nc` restores global Pi instructions and adds the profile. The adapter responds to Pi's structured context list and leaves native project resources under Pi's ownership.

Bazframe 2 treats a coding-agent harness as a portable, first-class object. Its CLI is organized around resource overviews and scoped actions. Most established resources accept singular and plural overview forms; global managed sources intentionally use only the plural `bazframe sources` namespace.

## CLI at a glance

| Resource | Overview | Common actions |
|---|---|---|
| Profiles | `bazframe profile` or `bazframe profiles` | `profile add`, `duplicate`, `use`, `rename`, `remove`, `list`, `current` |
| Available skills | `bazframe skill` or `bazframe skills` | Browse the resolved Skillbook library |
| Active-profile skills | `bazframe profile skills` | `profile skills add`, `profile skills remove` |
| Global sources | `bazframe sources` | `sources add`, `build`, `remove` |
| Profile source references | `bazframe profile sources` | `profile sources add`, `remove` |
| Global policy | `bazframe global` | `global enable`, `global disable` |
| Project overrides | `bazframe project` or `bazframe projects` | `project enable`, `project disable` |
| Adapters | `bazframe adapter` or `bazframe adapters` | `adapter install pi`, `adapter uninstall pi` |
| Diagnostics | `bazframe status` | Read-only health and corrective actions |
| Interactive manager | `bazframe tui` | Manage profiles and direct skill membership |

The overview commands list current resources, mark active/current state where applicable, and show the available commands. Detailed reference help stays contextual:

```bash
bazframe --help                  # minimal top-level help and suggestions
bazframe help profiles           # profile reference
bazframe profile skills --help   # active-profile flat-skill reference
bazframe sources --help          # global managed sources
bazframe profile sources --help  # profile source references
```

Top-level `use`, `add`, and `remove` remain compatibility aliases. The old `init`/`uninit` forms report migration guidance to `project enable`/`disable`. `profile list` and `profile current` retain concise output for scripts. The deprecated `bazframe pi [--dry-run] [-- <pi args>]` launcher remains available only for migration.

Color is enabled automatically for terminal output and never carries meaning by itself. Pipes and redirected output remain plain text. Set `NO_COLOR` to disable color or `FORCE_COLOR=1` to enable it explicitly; `NO_COLOR` wins when both are present.

`bazframe tui` opens the keyboard-first Ink interface when both stdin and stdout are interactive terminals. The TUI runtime pins `ink@7.1.1` and `react@19.2.8`; the CLI loads them lazily only after dispatching this command. The interface provides `Profiles`, `Sources`, `Skills`, and `Settings` tabs; profile create, duplicate, activation, rename, and guarded removal; direct membership editing for the selected profile without silently changing active selection; read-only global sources and profile source references; a read-only multi-root Skills browser for Skillbook and valid global managed snapshots; and structured read-only setup status with corrective actions. Provider-owned skill move/rename, source mutation, settings writes, and editor launch remain unavailable. Press `?` for keys, use arrows or Vim `h`/`j`/`k`/`l` for directional navigation, uppercase `J`/`K` to jump between profile-editor panes, `1`–`4` for tabs, and `q` to exit. Non-interactive invocation fails plainly and points back to ordinary CLI commands.

This is not a production-ready TUI. Automated evidence covers macOS direct PTY and local tmux, plus Linux arm64 direct PTY, tmux, and loopback SSH in a container built from a digest-pinned base image; each Linux run records the installed package and tool versions rather than claiming a byte-reproducible apt environment. Local installed-tarball tmux now also covers an actual Ink fatal render propagated through rejected `waitUntilExit()`—including exit `1`, diagnostic, raw-mode/cursor/alternate-screen restoration, and cleanup—and `80x24`/`60x16` cell bounds for CJK, combining marks, emoji-ZWJ, ANSI SGR, and a long unbroken path. Global-source and profile-reference mutation is deliberately CLI-only in the implemented slice. Windows Terminal, representative remote SSH, terminal/font/locale ambiguous-width differences, and manual assistive-technology validation remain open, as do deeper TUI source trees and the deferred editor/settings/provider operations.

## Install for development

Requires Node.js >=22.19.0 and Git. The CLI pins the Pi 0.82.0 loader for authoritative source-unit inspection; installed adapter artifacts continue to use the host Pi 0.82.x loader. Real launches are validated against Pi 0.82.0.

```bash
npm install
npm run build
./dist/cli.js --help
```

The build marks `dist/cli.js` executable. Run `npm link` to expose the `bazframe` bin globally from this checkout; rebuild after source changes. A real launch also requires `pi` on `PATH`.

## Pi adapter lifecycle

`bazframe adapter install pi` is a one-time, explicit setup step. It copies the packaged extension artifact to `$PI_CODING_AGENT_DIR/extensions/bazframe.ts` and records its hash under `BAZFRAME_HOME/adapters/pi.json`. Pi auto-discovers that global extension, allowing users to invoke `pi` directly. Bazframe is globally enabled by default without a policy file; project overrides take precedence over that global policy. Both environment variables accept absolute paths; their defaults are `~/.pi/agent` and `~/.bazframe`.

Installation is idempotent and updates an older artifact that still matches its ownership manifest. A changed managed artifact is preserved and reported as drift. `--force` explicitly restores that destination from the packaged artifact. An occupied destination without Bazframe ownership stays with its existing owner.

```bash
bazframe adapter install pi
bazframe adapter install pi --force  # explicit drift repair
bazframe adapter uninstall pi
```

Uninstall verifies the artifact hash, removes the ownership manifest, and clears generated Pi alias cache.

Inside Pi, use `/bazframe info` for a compact view of the effective profile, supplier-labeled context, sorted effective skills, and collision mappings when present. Use `/bazframe reload` to reload the adapter and profile resources. These are the adapter's only slash-command subcommands; invalid forms print `Usage: /bazframe info | /bazframe reload`.

Create and select a profile, then enter any working directory:

```bash
bazframe profile add focused
$EDITOR "$HOME/.bazframe/profiles/focused/AGENTS.md"
bazframe profile use focused
bazframe skills                         # browse available skills
bazframe profile skills add my-skill
bazframe profile skills                 # inspect included skills
cd my-project
bazframe status
pi       # native Pi context + active profile
pi -nc   # global Pi context + active profile
bazframe profile skills remove my-skill
```

`status` performs a read-only inspection. Exit status `3` indicates an incomplete or drifted setup and prints corrective commands. Default behavior writes no project state. Git-worktree overrides preserve worktree content and Git status.

### Project defaults and overrides

Bazframe is globally enabled by default in both Git and non-Git directories. `bazframe global disable` writes exact bounded state to `BAZFRAME_HOME/global.json`; `global enable` validates runtime setup and removes that file. Non-Git directories inherit global policy without a per-directory override.

```bash
bazframe global disable       # native Pi unless a project is explicitly enabled
bazframe project enable       # enabled override when global policy is disabled
bazframe project disable      # disabled override when global policy is enabled
bazframe global enable        # restore file-free global defaults
bazframe projects             # inspect overrides and effective precedence
```

Inside a Git worktree, project policy wins over global policy. No project state means inherit global policy. Exact schema-v1 records remain compatible redundant inherit records; schema-v2 records are disabled overrides; schema-v3 records are enabled overrides. When a project command requests the same behavior as global policy, Bazframe removes valid current project state and inherits without a file. `bazframe project enable/disable` remains Git-only in this slice; non-Git directories inherit global policy. Malformed or unsupported policy state fails visibly and is preserved.

## Prototype profile layout

`BAZFRAME_HOME` defaults to `~/.bazframe`; an override must be an absolute path.

```text
~/.bazframe/
├── active-profile
├── global.json                    # optional disabled global policy
├── projects/                      # optional per-worktree overrides
├── source-snapshots/sha256/       # immutable prepared artifacts by manifest digest
├── sources/
│   └── provider-id/source-id.json # global source identity and active digest
└── profiles/
    └── focused/
        ├── AGENTS.md             # required UTF-8
        ├── skills/
        │   └── demo-profile -> /absolute/path/.skillbook/skills/demo-profile
        └── sources/
            └── provider-id/source-id.json # portable global-source reference
```

Profile IDs provisionally use 1–64 lowercase ASCII letters/digits separated by single hyphens. `active-profile` is plain text and is replaced atomically.

### Profile lifecycle

`bazframe profile add <id>` creates a physical profile with a zero-byte `AGENTS.md` and empty physical `skills/` directory without activating it. `profile use <id>` validates and selects it; top-level `bazframe use <id>` remains an equivalent alias. Bare `profile` and `profiles` list valid profiles, mark the active one, and show profile commands. `profile list` prints valid physical IDs one per line and `profile current` prints only the selected ID for scripts.

`profile duplicate <source> <new>` copies all profile content, including membership symlinks, without following or rewriting symlink targets. It requires a physical source profile, refuses an occupied destination, leaves the active profile unchanged, and exposes the new profile only after the copy completes. `profile rename <old> <new>` preserves profile content without resolving its children or provider targets, refuses replacement and profile-root symlinks, and updates the active selection when necessary. `profile remove <id>` always refuses the active profile, even when its directory is missing, and removes only the exact generated-empty shape. `profile remove <id> --force` explicitly authorizes permanent recursive deletion of a non-active physical profile; membership symlinks are unlinked without touching their Skillbook targets. Actual create/duplicate/remove/identity-changing rename clears affected alias cache; idempotent add and same-ID rename preserve live cache. Lifecycle changes apply on the next Pi startup or `/reload`.

Each immediate child of `skills/` that contains a regular `SKILL.md` is passed in lexical directory-name order. Supporting files remain in that directory for normal Agent Skills behavior. Existing physical skill directories remain readable for compatibility, but `add` and `remove` do not manage them.

### Direct Skillbook membership

`bazframe skills` lists all valid skills in the resolved Skillbook library, identifies that source path, and warns about invalid neighboring entries. It does not list Pi-native skills or skills that exist only inside a profile. `bazframe profile skills` separately lists immediate skill entries discovered in the active profile; Pi remains authoritative for full Agent Skills validation at runtime.

`bazframe profile skills add <skill> [--profile <profile>]` and `bazframe profile skills remove <skill> [--profile <profile>]` do not require a Git worktree. Without `--profile`, they operate on the global active profile. An explicit profile target changes that profile without changing or requiring active selection. The profile and its physical `skills/` directory must already exist. Bazframe resolves the Skillbook library root from `SKILLBOOK_LIBRARY`, then the deprecated `SKILLBOOK_LOCK_LIBRARY`, then `~/.skillbook`; the source skill is `<root>/skills/<skill>`. Top-level `add` and `remove` remain active-profile-only aliases.

Add requires a safe lowercase hyphenated ID and a regular `SKILL.md` whose frontmatter `name` matches that ID. This is an identity check, not a complete Agent Skills schema validation; Pi's loader validates the full skill when it enters a session. A misspelled missing ID offers close valid matches with `Did you mean ...?` and otherwise points to `bazframe skills`. Add creates one absolute directory symlink. Re-adding the exact link and re-removing an absent link are successful no-ops. Bazframe refuses to replace or remove physical, relative, foreign, or mismatched entries. It never copies, edits, locks, updates, or deletes Skillbook skill content or `skillbook.lock.json`.

Two visibly different profiles are in [`examples/profiles/focused`](examples/profiles/focused) and [`examples/profiles/reviewer`](examples/profiles/reviewer).

## Global managed sources and profile references

Global sources are first-class built objects under `<BAZFRAME_HOME>/sources/<provider>/<source>.json`. Profiles include exact references under `profiles/<profile>/sources/<provider>/<source>.json`. `sources add` performs the explicit initial build/snapshot activation; `sources build` is the only operation that makes later provider-input changes visible. Activation is rejected if any referencing profile would become invalid. Source deletion is refused while referenced. Provider inputs and immutable snapshots are never deleted by source removal.

```text
bazframe sources
bazframe sources add <provider> <source> <absolute-root>
bazframe sources build <provider> <source>
bazframe sources remove <provider> <source>
bazframe profile sources
bazframe profile sources add <provider> <source> [--profile <profile>]
bazframe profile sources remove <provider> <source> [--profile <profile>]
```

The TUI has Profiles, Sources, Skills, and Settings tabs. Sources and profile source references are read-only. Skills renders Skillbook and all valid global managed snapshots as independent roots using `[-]` expanded and `[+]` collapsed rows with indented children. Legacy pre-alpha `profiles/<profile>/source-units/` content is inert and is never read or migrated.

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

"$BAZFRAME_CLI" profile use focused

DEMO_REPO="$(mktemp -d)/repository with spaces"
mkdir -p "$DEMO_REPO/packages/api"
git -C "$DEMO_REPO" init --quiet
printf '%s\n' 'Keep the repository demo rule.' > "$DEMO_REPO/AGENTS.md"

(
  cd "$DEMO_REPO/packages/api"
  node "$BAZFRAME_CLI" pi --dry-run -- -p "Describe the effective harness"
)

"$BAZFRAME_CLI" profile use reviewer
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
- The deprecated `bazframe pi` launcher does not resolve skill collisions. Pi currently warns and keeps its first-discovered skill; the production adapter instead projects deterministic `-x-bazframe` aliases.
- Profiles, repository instructions, and skills are trusted local content. Skills may instruct the model to run arbitrary code; Bazframe does not audit or sandbox them. Trusted symlinks are followed.
- Locks coordinate Bazframe writers. Source descriptors are read through no-follow handles, and source namespace directories keep no-follow handles open while device/inode identity is checked around enumeration. Portable Node has no handle-relative `readdir`/`openat`, so a non-cooperating external process can still replace and restore a namespace pathname wholly inside the pathname-enumeration window or race profile check/create/duplicate/rename/remove pathnames and the final verified membership unlink.
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

The standard gate covers build, typecheck, lint, deterministic TUI reducer/component/service tests, fake-Pi integration, and packed-package lifecycle and interactive-TUI smoke checks. The real-Pi gate packs and installs the package, validates both context modes through Pi 0.82 with an isolated probe provider, proves provider edits stay invisible, then uses explicit source build plus Pi RPC `/bazframe reload` to expose the activated snapshot in the same model-free process. Passing these gates does not replace the open cross-platform and manual accessibility validation.

```bash
npm test
npm run test:real-pi
```

See [`docs/prototype.md`](docs/prototype.md) for this slice's reversible contract and limitations, [`docs/design.md`](docs/design.md) for the product direction, and [`docs/pi-adaptive-context-adapter.md`](docs/pi-adaptive-context-adapter.md) for the accepted Pi behavior. Earlier evidence remains in the [alternatives comparison](docs/research/prototype-alternatives.md), [MTG skill-refactor experiment](experiments/mtg-skill-refactor/REPORT.md), and broader [skill-first/external-harness problem frame](docs/research/skill-first-projects-and-external-harnesses.md).
