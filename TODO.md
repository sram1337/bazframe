# TODO

## Product definition

- [x] Define the first-class profile and effective-harness data model, including profile-local `AGENTS.md`, for the first production slice (`docs/design.md`).
- [x] Define first-slice skill responsibilities: profile discovery, validation, runtime exposure, collision projection, and diagnostics.
- [x] Keep skill acquisition, versioning, updating, and publication provider-owned; Bazframe consumes configured Agent Skills-compatible roots.
- [x] Define profile, project, runtime, and effective-harness ownership for the first Pi slice (`docs/design.md`).
- [x] Define Bazframe as the manager of profiles, direct skill membership, and profile application while Skillbook owns skill artifacts and lifecycle.
- [x] Define and implement `use` semantics for global active-profile selection.
- [x] Implement the `profile add/duplicate/remove/rename/use/list/current` lifecycle namespace with guarded destructive behavior.
- [x] Define the first Skillbook-root resolution order and safe direct-membership representation (`docs/design.md`).
- [x] Implement active-profile `add <skill>` and `remove <skill>` with verified symlink-only membership semantics.
- [x] Standardize the resource-oriented CLI overviews/help, available/profile skill listing, and missing-skill suggestions.
- [x] Add accessible terminal-aware color without changing piped or `NO_COLOR` output.
- [x] Define first-slice Pi context ordering and native/profile skill-collision aliases.
- [x] Approve the provider-neutral source-unit production contract: profile-local versioned descriptors, bounded live derivation, CLI-only membership, atomic source failures, and provider-owned lifecycle (`docs/design.md`).
- [x] Implement source-unit descriptor persistence and `bazframe profile sources` add/remove/overview without changing flat Skillbook membership, including no-follow descriptor reads, substitution revalidation, and retry pruning.
- [x] Implement no-follow, identity-checked bounded source-unit discovery, Pi 0.82-authoritative validation, complete-profile-set duplicate rejection, individual Pi projection, and separated status/`/bazframe info` reporting with acceptance coverage.
- [x] Replace redundant per-project opt-in registrations with project-over-global enable/disable policy and file-free enabled defaults.
- [x] Apply global policy and the active profile in non-Git directories while keeping per-project overrides Git-only.
- [ ] Define semantic instruction conflicts and cross-runtime skill conflicts.
- [ ] **Deferred:** Revisit skill packs or profile export only after an explicit product decision.

## Terminal UI

- [x] Capture the initial no-sidebar, top-tab TUI interaction design (`docs/tui-design.md`).
- [ ] Resolve the provider-ownership contract for skill move/rename, including writable roots, cross-root moves, frontmatter IDs, provider lock state, rollback, and destructive recovery.
- [x] Define profile-local provider-neutral source-unit descriptors supporting zero or many direct memberships while preserving current Skillbook resolution; defer a global registry as unnecessary for the first slice.
- [x] Settle canonical source-unit identity and broken-root removal through strict versioned descriptors without following provider roots.
- [x] Settle the first Settings-tab scope as structured read-only setup status.
- [ ] Define writable Settings scope, ownership, persistence, validation, and CLI interoperability.
- [x] Pin Ink 7.1.1 with React 19.2.8 and load the TUI framework only from the lazy `bazframe tui` entry path (`docs/tui-framework-research.md`).
- [ ] Extend the completed macOS real-PTY smoke to Linux, Windows Terminal, SSH, and tmux.
- [x] Define typed application-service seams for profile lifecycle, selected-profile membership, and dashboard reads without spawning CLI subprocesses.
- [x] Extend the typed application-service seam with structured read-only setup status and diagnostic isolation.
- [x] Implement separate top-tab focus with deterministic Tab/Shift+Tab traversal and explicit Enter activation.
- [x] Distinguish focus with consistent active borders and add portable Vim `h`/`j`/`k`/`l` plus profile-pane `J`/`K` navigation.
- [x] Implement reducer-owned persistent viewport offsets for the profile list, both membership panes, and the Skills browser, including reconciliation and resize clamping.
- [ ] Complete deeper source-tree expansion/identity behavior and any node-specific bindings it introduces.
- [x] Implement the read-only Skills source browser with provider-owned move/rename disabled and explained.
- [ ] Implement skill artifact actions only after move/rename ownership review.
- [x] Implement the Profiles list/lifecycle flows and two-pane selected-profile membership editor.
- [ ] Implement selected-profile instruction-editor launch after its lifecycle gate.
- [x] Render structured read-only setup status and corrective actions in Settings; keep writes disabled.
- [x] Add deterministic compact/resize/exit/accessibility reducer/component coverage and a real macOS pseudo-terminal enter/restore smoke test.
- [x] Exercise the installed tarball through a packed interactive TUI smoke when the host provides `script`.
- [x] Pass the full `npm test` and packed real-Pi gates with the TUI dependencies and entrypoint present.
- [x] Add CLI/TUI state-agreement integration coverage across profile lifecycle and inactive-profile membership while preserving provider artifacts.
- [x] Complete independent interaction, safety, and accessibility code reviews; fix and re-review all reported blockers.
- [ ] Expand real-terminal coverage for resize, error, and Ctrl+C paths on Linux, Windows Terminal, SSH, and tmux, plus manual assistive-technology checks.
- [ ] Complete the documented cross-platform/manual validation and remaining feature scope before calling the TUI production-ready.

## Research

- [x] Research the likely origin and scope pressure behind Bazframe 2 (`docs/research/origin-and-rationale.md`).
- [x] Document the skill-first refactoring and external-harness problem frame (`docs/research/skill-first-projects-and-external-harnesses.md`).
- [x] Draft a provider-neutral nested source-unit composition proposal, compare it with the current implementation, and enumerate the experiment decisions (`docs/research/provider-neutral-nested-source-unit-composition.md`).
- [x] Approve the experiment-only Stage 1 parameters, fixture-preparer boundary, validation split, counting/error semantics, and isolated allowed write root (`docs/research/provider-neutral-nested-source-unit-composition.md`).
- [x] Complete Stage 1: structural and Pi 0.82 composition mechanics passed; bounded-wrapper evidence did not demonstrate Bazframe-exclusive necessity (`experiments/provider-neutral-nested-source-unit-composition/REPORT.md`).
- [x] Complete the reopened experiment-only Stage 2 sanitized MTG source-tree/runtime proof with two provider-prepared children and two unrelated callers; exclusive necessity was not demonstrated (`experiments/provider-neutral-nested-source-unit-composition/stage2-mtg/REPORT.md`).
- [x] Record the later user-approved narrow production composition seam while retaining bounded-wrapper evidence and provider ownership (`docs/design.md`).
- [ ] **Deferred:** Map the broader MTG skills' cross-skill dependencies or test a production transferable bundle through an external live library; the two-child Stage 2 proof and narrow composition approval do not expand into packs or provider lifecycle.

## Pi adaptive context adapter

- [x] Map the Pi 0.82 extension API boundary and keep project trust as Pi's security decision.
- [x] Prototype a global extension driven by structured Pi context and resource events (`experiments/pi-no-launcher-adapter/REPORT.md`).
- [x] Restore global Pi context and append the profile when Pi reports an empty context list; otherwise append the profile to native context.
- [x] Validate `pi -nc` replacement mode, plain-`pi` additive mode, reload, skills, collision aliases, file-free defaults, global disable, project enable/disable precedence, and stable repositories.
- [x] Accept bounded adaptive instruction-context behavior as the first Pi adapter boundary (`docs/pi-adaptive-context-adapter.md`).
- [x] Approve the production command surface, explicit adapter installation, project-over-global policy, and manifest-gated `--force` repair.
- [x] Settle self-contained artifact packaging, ownership metadata, atomic external writes, cache lifecycle, compatibility, and canonical-path repository identity.
- [x] Convert the production design into implementation milestones and verification gates (`docs/pi-adapter-production-design.md`).

## Pi adapter production implementation

- [x] Milestone 1: implement and test external-state foundations, codecs, locks, atomic writes, and ownership comparison.
- [x] Milestone 2: package the extension artifact and implement safe adapter install, update, repair, and uninstall.
- [x] Milestone 3: implement global/project policy commands and production `status`.
- [x] Milestone 4: productionize adaptive context, skills, aliases, namespaced `/bazframe info | reload`, and compatibility handling.
- [x] Milestone 5: pass packed-package and real-Pi acceptance gates, then deprecate the launcher prototype.

## Prototype vertical slice

- [x] Implement the approved experimental `use <profile>` and Pi launch flow.
- [x] Keep effective instructions temporary and outside the repository.
- [x] Add deterministic additive profile-skill exposure and Pi argument safety checks.
- [x] Add focused unit and fake-Pi integration coverage for implemented prototype behavior.
- [x] Run and record the full install/build/typecheck/lint/test/demo gate for this checkout.
- [x] Complete the MTG skill-refactor experiment and record its bounded validation (`experiments/mtg-skill-refactor/REPORT.md`).

## Validation

- [x] Specify and implement one approved minimal end-to-end user flow (`README.md`).
- [x] Compare that flow with Skillbook, Vercel `skills`, Git, and a small wrapper (`docs/research/prototype-alternatives.md`).
- [x] Provisionally select TypeScript/Node ESM for the approved prototype; this is not a product-stack commitment.
