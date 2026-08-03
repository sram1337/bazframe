# MTG Harness Codification Report

## Observed before refactor

- Root startup always asked for a mode and loaded large state files even when intent was explicit.
- Deck workspace, primer cadence, social threading, Forge clocks/build commands, and commit behavior had conflicting live descriptions.
- YouTube transcript, child delegation, primer maintenance, and harness guard operation were implemented but lacked focused skills.
- Stable social identity/platform procedure and live relationship state were mixed across root files and a large subsystem skill.
- Archidekt sync committed automatically, deck creation accepted an implicit name, and broad wrap instructions staged every path.
- Tracked source state included files described as local-only plus generated diagnostics.

## Implemented experiment decisions

- Reduced `AGENTS.md` to intent routing and cross-cutting repository policy.
- Added focused skills: `dev-maintenance`, `harness-operations`, `primer-health`, `youtube-transcript`, and `delegate`.
- Added skill-local resources for deck workspace/mutation safety, primer semantics, entropy scans, runtime gates, and Moltbook identity/operations/bootstrap.
- Made the `socialize` skill canonical; root social/soul files are compatibility pointers.
- Removed Archidekt sync auto-commit and required an explicit deck name for remote creation.
- Limited session-writeback gates to touched deck workspaces; dev scratch state is optional/local.
- Corrected the probability hit-rate example and removed false independent-category joint math.
- Replaced stale Forge compilation guidance with `forge/patch/build.sh` and aligned live testing guidance on a 240-second comparable clock.
- Added a profile-owned `harness-codification` skill to exercise additive Bazframe profile skill exposure.
- Hardened transcript channel enumeration against shell injection and unsafe video IDs; cached exports are deterministic and non-overwriting.
- Preserved existing Archidekt card metadata during quantity/category mutations and reject invalid quantities before mutation.
- Made session gates recognize Git global options and made Pi count only successful deck/scratchpad writes.
- Made active Forge paths configurable through `FORGE_DIR`, `FORGE_JAR`, and `FORGE_COMMANDER_DIR` while retaining macOS defaults.

These are prototype choices for this copy, not decisions for the source project or Bazframe product.

## Validation results

Passed on the sanitized experiment copy:

- `npm run check`: semantic TypeScript checks for project, Forge runner, and Moltbook director; syntax checks for eight harness TypeScript files; 23 skills audited with zero errors/warnings; offline runtime smoke passed.
- `npm audit --audit-level=low`: zero vulnerabilities.
- `tests/smoke_tests.sh`: 12 network/CLI checks passed; Archidekt read/login were explicitly skipped because the sanitized copy has no deck or exported credentials.
- Session/runtime smoke covered Pi and Claude-style commit gates, Git global options, failed-write handling, transcript argv safety/cache export behavior, and pre-auth Archidekt quantity rejection.
- `forge/patch/build.sh`: 32 patched classes compiled, including metadata preflight classes.
- Bazframe root `npm test`: build, typecheck, lint, 62 unit tests, 7 integration tests, and package-install smoke passed.
- Bazframe dry-run composed Loam profile instructions before repository instructions, exposed the profile-owned skill, preserved native Pi discovery, and left project status/HEAD unchanged.
- A real Pi launch recognized the effective Loam/repository routing; explicit `/skill:primer-health` invocation expanded successfully; no project mutation occurred.
- Changed shell scripts passed `bash -n`; Python tooling parsed; `git diff --check` passed; the source repository remained clean at the recorded commit.

Not exercised deliberately: authenticated Archidekt mutations, Moltbook account operations, and a full Forge game. Those require local account/deck state excluded from this copy. Forge compilation, runner typechecking, and metadata smoke are the bounded substitutes. Claude Code's PostToolUse/PreToolUse hook model can race when an edit and commit are emitted as sibling parallel calls; the runtime matrix prohibits that call shape.

## Product evidence, not decisions

- The profile cleanly carries cross-project voice/evidence policy and an optional profile skill without absorbing repository paths or account state.
- Domain procedures, local-data boundaries, and subsystem skills remain more coherent under repository ownership.
- Pi can consume profile and repository skills additively. Claude Code consumes the same routing through the tracked `CLAUDE.md` → `AGENTS.md` symlink and direct `SKILL.md` paths; whether Bazframe should project native per-harness skill directories remains open.
- This experiment does not establish a need for Bazframe-owned skill acquisition or updates. The demonstrated value remains session composition and portable profile behavior, still reproducible by a small wrapper.
