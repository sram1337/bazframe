# Scratchpad

## Current state

- `docs/design.md` is the current positive product specification for portable profiles, project-over-global enable/disable policy, and the first Pi adapter.
- Bazframe 2 manages profiles, direct skill membership, and application of resolved profiles to coding agents. Skill packs are deferred.
- Skillbook owns skill acquisition, library copies, versioning, updates, publication, deletion, and lock state. Bazframe must not mutate those artifacts.
- The implementation uses TypeScript/Node ESM with no Bazframe runtime dependencies. The stack remains provisional at the broader product level.
- The production Pi flow now covers resource-oriented profile/skill/project/adapter overviews, contextual help, accessible terminal-aware color, the `profile add/duplicate/remove/rename/use/list/current` lifecycle namespace, available and active-profile skill listing, fuzzy missing-skill suggestions, active-profile selection, direct Skillbook-backed skill membership, profile-local `AGENTS.md`, file-free global defaults in Git and non-Git directories with explicit Git-worktree enabled/disabled project overrides, read-only `status`, direct `pi`/`pi -nc` context behavior, the single `/bazframe info | reload` namespace, profile skills, and collision aliases.
- [`docs/prototype.md`](docs/prototype.md) records migration from the deprecated `bazframe pi` launcher and preserves that slice's historical contract.
- `docs/research/origin-and-rationale.md` records why Bazframe 2 likely emerged from the v1 implementation, harness trial, and overlapping skill ecosystem.
- `docs/research/prototype-alternatives.md` finds that the integrated profile-to-session transition is coherent but reproducible by a small wrapper; skill-management ownership remains unjustified pending a bounded baseline test.
- The MTG skill-refactor experiment is complete under `experiments/mtg-skill-refactor/`. It validates profile/repository instruction composition, additive Pi skills, lean repository routing, and skill-local procedures against a real harness-heavy project. Domain skills and local/account state remained repository-owned; no evidence justified Bazframe-owned skill acquisition or updates.
- `docs/research/skill-first-projects-and-external-harnesses.md` records the broader dependency-aware skill-bundle and external-harness problem frame; skill bundle/dependency work is now deferred.
- `docs/pi-adaptive-context-adapter.md` defines the accepted first Pi adapter boundary: plain `pi` keeps native context and adds the profile; `pi -nc` yields an empty structured context list, so the adapter restores global Pi context and adds the profile.
- The Pi 0.82 prototype under `experiments/pi-no-launcher-adapter/` validates direct Pi invocation through a global extension. Global context appears exactly once in each mode; profile instructions and additive skills reload; native/profile skill collisions expose the profile copy as `<name>-x-bazframe` from external cache; project resources remain Pi-owned.
- `docs/pi-adapter-production-design.md` is the implemented baseline. It settles the command surface, explicit install lifecycle, project-over-global policy, canonical-path enabled/disabled overrides, drift repair, artifact packaging, ownership, atomic writes, cache lifecycle, compatibility target, milestones, and verification gates.
- `bazframe tui` now provides the first Ink management slice: separately focused top `Profiles`/`Skills`/`Settings` tabs; profile create/duplicate/use/rename/guarded remove; selected-profile direct membership editing; a read-only Skillbook source browser; and structured read-only setup status with corrective actions in Settings. CLI/TUI state-agreement coverage exercises profile lifecycle and inactive-profile membership. Runtime `ink@7.1.1` and `react@19.2.8` are exact pins and are loaded lazily only by the TUI entry path.

## Current focus

Harden the first TUI management slice without calling it production-ready. The first Settings scope is settled as structured read-only status; writable persistence remains separate and open. Persistent per-view viewport offsets are implemented. Other open work includes deeper source trees, the remaining portable keymap, selected-profile editor launch, a provider-neutral source registry, canonical source identity and broken-root semantics, provider artifact operations, and documented Linux, Windows Terminal, SSH, tmux, and manual assistive-technology validation. Provider-owned skill move/rename remains blocked on frontmatter IDs, lock state, cross-root moves, and rollback.

## Deferred questions

- Skill packs, dependency-aware bundle behavior, and transferable bundle design.
- Referenced or self-contained profile export.
- Semantic composition between personal and repository-recommended harnesses.

## Product questions after the Pi slice

The first Pi integration now commits to one global active profile, file-free enabled global policy, project-over-global canonical-path overrides, immediate Agent Skills-compatible profile children, lowercase hyphenated profile IDs, a 1 MiB instruction cap, additive native/profile skills, and deterministic Pi collision aliases.

Semantic conflict resolution and broader cross-runtime alias behavior remain open. Direct Skillbook-backed membership is implemented; packs and export are deferred.

## Latest planning evidence

- A fresh `scout` and `context-builder` pass confirmed that current profile and Pi loaders already follow immediate directory symlinks, so direct membership needs no adapter format change.
- Canonical membership commands accept optional `--profile <profile>` for explicit inactive-profile editing without changing active selection; omission and top-level `add`/`remove` aliases remain active-profile-only.
- Bare singular/plural resources provide human overviews; `profile list` and `profile current` remain concise scripting commands. Root help is intentionally minimal and delegates to resource help.
- The global `pi-subagents` package was enabled and updated to 0.40.0 outside this repository. One parallel context run was marked failed because `context-builder` requested unavailable `web_search`, but both read-only handoffs completed and agreed on the symlink slice.

## Latest prototype validation

- A manual user trial of the global adapter succeeded, including clean uninstall; the bounded adaptive behavior was subsequently accepted as the first Pi adapter boundary.
- The revised isolated Pi 0.82 global-extension spike passed adaptively: `pi -nc` restored global context while excluding ancestor/repository context; plain `pi` retained native context without duplicating global instructions; both added the profile; a `reviewer-probe` collision became `reviewer-probe-x-bazframe`; reload, native project resources, the then-current registration gate, and repository immutability were verified.
- `npm ci` passed with zero reported vulnerabilities.
- `npm test` passes: build, typecheck, lint, 238 unit tests, 23 integration tests, and packed-package smoke checks, including deterministic TUI reducer/component/service coverage and a packed interactive TUI smoke on hosts with `script`.
- The current packed `npm run test:real-pi` gate passes against Pi 0.82.0 with nine runtime probes covering Git and non-Git file-free defaults, non-Git global disable, legacy inherit state, global disable, enabled-project override, disabled-project override, restored inheritance, both context modes, provider preservation, and stable Git status.
- A live status check in the non-Git `/Users/sram/foo/mtg_test` directory confirmed the installed current adapter applies global-enabled policy, selects `mtg-advisor`, and exposes its 13 skills; the installed artifact hash matched the reviewed source artifact.
- Deterministic TUI tests cover compact and below-minimum layouts, resize state preservation, pane boundaries, guarded removal, graceful/forced exit behavior, non-color markers, and screen-reader output. A real macOS PTY smoke verifies alternate-screen entry/restoration; cross-platform PTY and manual accessibility validation remain open.
- Independent interaction, safety, and accessibility code reviews completed; all reported blockers were fixed and re-reviewed. Production readiness remains blocked on the documented cross-platform/manual terminal validation and open future-feature scope.
- Deterministic artifact tests define the compact `/bazframe info` projection and strict `/bazframe reload` dispatch; the packed real-Pi gate does not claim live slash-command coverage.
- The documented two-profile demo passed: selecting `focused` and then `reviewer` changed the next dry-run's profile section while preserving the same root `AGENTS.md` section.
- A completed real Pi 0.82 smoke launched actual Pi with the `focused` profile and `demo-profile` skill in a temporary Git repository. Pi's response reflected both the profile preference and the root `AGENTS.md` rule; exit was 0; Git status was unchanged; Bazframe diagnostics were on stderr and the Pi response was on stdout.

## Relevant local evidence

- Bazframe v1: `~/baz/`
- Bazframe ecosystem assessment: `~/foo_bazframe/BAZFRAME_ECOSYSTEM_ASSESSMENT.md`
- Vercel `skills`: `~/foo_bazframe/skills/`
- Skillbook: `~/foo_bazframe/skillbook/`
