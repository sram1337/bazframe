# TODO

## Product definition

- [x] Define the first-class profile and effective-harness data model, including profile-local `AGENTS.md`, for the first production slice (`docs/design.md`).
- [x] Define first-slice skill responsibilities: profile discovery, validation, runtime exposure, collision projection, and diagnostics.
- [x] Keep skill acquisition, versioning, updating, and publication provider-owned; Bazframe consumes configured Agent Skills-compatible roots.
- [x] Define profile, project, runtime, and effective-harness ownership for the first Pi slice (`docs/design.md`).
- [x] Define Bazframe as the manager of profiles, provider-neutral direct-skill registrations and membership, and profile application while external providers own artifact bytes.
- [x] Define and implement `use` semantics for global active-profile selection.
- [x] Implement the `profile add/duplicate/remove/rename/use/list/current` lifecycle namespace with guarded destructive behavior.
- [x] Replace the superseded external-library root with the provider-neutral `(default)` registration catalog under `BAZFRAME_HOME`.
- [x] Implement exact `add skill <absolute-root>` / `remove skill <skill>` catalog lifecycle plus verified parallel profile membership links.
- [x] Standardize the resource-oriented CLI overviews/help, available/profile skill listing, and missing-skill suggestions.
- [x] Ship the tracked Agent Skills-compatible `bazframe` self-management skill as the generated package artifact `dist/skills/bazframe`.
- [x] Add accessible terminal-aware color without changing piped or `NO_COLOR` output.
- [x] Define first-slice Pi context ordering and native/profile skill-collision aliases.
- [x] Implement the superseded first source-unit slice: profile-local schema-v1 live-root descriptors, bounded derivation, CLI-only membership, atomic source failures, and provider-owned preparation.
- [x] Implement source-unit descriptor persistence and `bazframe profile sources` add/remove/overview without changing flat direct membership, including no-follow descriptor reads, substitution revalidation, and retry pruning.
- [x] Implement no-follow, identity-checked bounded source-unit discovery, Pi 0.82-authoritative validation, complete-profile-set duplicate rejection, individual Pi projection, and separated status/`/bazframe info` reporting with acceptance coverage.
- [x] Approve the replacement source lifecycle: explicit Bazframe build, immutable content-addressed snapshot activation, and snapshot-only runtime projection (`docs/design.md`).
- [x] Replace redundant per-project opt-in registrations with project-over-global enable/disable policy and file-free enabled defaults.
- [x] Apply global policy and the active profile in non-Git directories while keeping per-project overrides Git-only.
- [x] Define the first semantic composition contract: runtime-native repository harness material remains a separate provenance-preserving layer, while Bazframe adds the active personal profile without stored merging or repository-selected profile state.
- [x] Define the bounded current-slice conflict policy: opaque provenance-preserving instruction layers with deterministic transport order and no semantic resolution; exact profile duplicate boundaries; Pi 0.82 runtime-cache aliases with truncation and visible no-fallback collision failure; and mandatory explicit behavior without profile-identity mutation for any future adapter.
- [x] Decide against Bazframe inter-skill dependency schema or automation for the current product: the Agent Skills specification has no dependency field, shared resources/runtime packages remain provider-owned, and any future namespaced validate-only sidecar requires separate evidence and approval.
- [x] Collaboratively spec and add the `swarm`, `long`, and `nsn` skills to the active Bazframe profile through their provider; `nsn` bundles its explanatory reference locally.

## Skill libraries, Skill packages, and profile references

- [x] Replace the superseded umbrella with independent exact library/package records and exact typed profile references; old pre-alpha state remains inert.
- [x] Implement library add/update/remove and package add/build/remove, plus whole-object profile reference add/remove, with no legacy aliases or migration.
- [x] Keep library operations build-free; require exact `bazframe-package.json` and direct unsandboxed argv execution for explicit package add/build.
- [x] Validate every referencing profile before atomic library update/package build and refuse referenced deletion.
- [x] Resolve only active-profile typed references while retaining shared immutable snapshot security, bounded Pi validation, zero-Skill validity, and kind-qualified collision handling.
- [x] Bring CLI/status, standalone Pi, pack, real-Pi, TUI projections, generated Skill, and current documentation to library/package parity.
- [x] Unify author-facing Skill library/package messaging around canonical identity, initial activation, later refresh, whole-object profile attachment, and the runnable package example.
- [x] Ship deterministic `bazify` extraction and in-place adaptation for one Skill or an immediate Skill collection, with isolated validation, `./bazframe/` review tracking, and consent-gated private publication for new packages.
- [x] Remove obsolete shipped readers, commands, aliases, and compiled modules; keep old state invisible and unchanged.

## Terminal UI

- [x] Capture the initial no-sidebar, top-tab TUI interaction design (`docs/tui-design.md`).
- [x] Define profile-local provider-neutral source-unit descriptors supporting zero or many direct memberships while preserving direct membership; defer a global registry as unnecessary for the first slice.
- [x] Settle canonical source-unit identity and broken-root removal through strict versioned descriptors without following provider roots.
- [x] Settle the first Settings-tab scope as structured read-only setup status.
- [x] Pin Ink 7.1.1 with React 19.2.8 and load the TUI framework only from the lazy `bazframe tui` entry path (`docs/tui-framework-research.md`).
- [x] Define typed application-service seams for profile lifecycle, selected-profile membership, and dashboard reads without spawning CLI subprocesses.
- [x] Extend the typed application-service seam with structured read-only setup status and diagnostic isolation.
- [x] Implement separate top-tab focus with deterministic Tab/Shift+Tab traversal and immediate focused-tab activation.
- [x] Distinguish focus with consistent active borders and add portable Vim `h`/`j`/`k`/`l` plus profile-pane `J`/`K` navigation.
- [x] Implement reducer-owned persistent viewport offsets for the profile list, both membership panes, and the Skills browser, including reconciliation and resize clamping.
- [x] Implement the read-only Skills browser as one uninterrupted list of collapsible `Added Skills`, `Library <id>`, and `Package <id>` peers, with provider-owned move/rename disabled and explained.
- [x] Implement the Profiles list/lifecycle flows and two-pane selected-profile membership editor.
- [x] Add persistent global profile favorites with create-first current/favorite ordering, responsive markers/alignment, and `x` guarded profile deletion.
- [x] Render structured read-only setup status and corrective actions in Settings; keep writes disabled.
- [x] Add deterministic compact/resize/exit/accessibility reducer/component coverage and a real macOS pseudo-terminal enter/restore smoke test.
- [x] Exercise the installed tarball through a packed interactive TUI smoke when the host provides `script`.
- [x] Pass the full `npm test` and packed real-Pi gates with the TUI dependencies and entrypoint present.
- [x] Add CLI/TUI state-agreement integration coverage across profile lifecycle and inactive-profile membership while preserving provider artifacts.
- [x] Complete independent interaction, safety, and accessibility code reviews; fix and re-review all reported blockers.
- [x] Apply the August TUI usability reviews: responsive Skills/Profiles master-detail views, plain-text skill preview, combined source presentation, Adapters/Settings regrouping, back/breadcrumb and `o`/`c` navigation, honest loading, path-only manifest-free source add, height-aware compact panes, aligned profile counts, grouped Available skills, centralized hints, transient-message clearing, immediate tab activation, and same-width growth repaint coverage.
- [x] Apply the follow-up TUI feedback: uppercase `H`/`L` route navigation, first-tab startup, preferred master panes that fill their allocated columns, bare profile skill counts, independently collapsible Available groups for every healthy browsable source, CLI guidance for whole-source attachment, snapshot-warning dismissal with persistent errors, proportional visual scrollbars for offset-driven content, and healthy/failed managed-source visibility coverage.
- [x] Apply natural Left/Right and lowercase `h`/`l` master/detail traversal globally to Skills and Profiles, retain uppercase `H`/`L` compatibility, unwind nested Available rows before returning, and show active/dim-parent/inactive hierarchy that disappears while top tabs own focus.
- [x] Preserve canonical kind-qualified validation diagnostics through library add/update and package add/build instead of leaking the resolver's private generic failure text.
- [x] Document only Skill, added Skill, Skill library, and Skill package vocabulary; every discovered child remains a Skill.
- [x] Implement `bazframe profile edit <profile>` / `bazframe skill edit <skill>` and route-specific TUI `e` with explicit inactive-profile/live-`(default)` targeting, managed-snapshot refusal, executable-only `VISUAL`/`EDITOR`, physical contained-target revalidation, shell-free inherited child execution, Ink terminal suspension/restoration, outcome refresh/reconciliation, CLI parity, and focused terminal evidence.
- [ ] Complete the TUI production-readiness gate: macOS direct-PTY/local-tmux and Linux arm64 digest-pinned-base container direct-PTY/tmux/loopback-SSH resize, external-editor handoff/recovery, handled/fatal-render error, Ctrl+C, restoration, cleanup, and bounded CJK/combining/emoji-ZWJ/ANSI/long-path cell-width behavior are automated with run-recorded package/tool versions; Windows Terminal, representative remote SSH, terminal/font/locale ambiguous-width differences, and manual assistive-technology evidence remain open.

## Deferred candidates (not active work)

- Skill packs, profile export, child subsets, and snapshot garbage collection require separate product decisions.
- TUI skill artifact move/rename requires provider ownership, writable-root, cross-root, identity, locking, rollback, and recovery semantics.
- Writable Settings and deeper provider-tree browsing remain candidate slices pending their documented lifecycle and interoperability gates.

## Research

- [x] Research the likely origin and scope pressure behind Bazframe 2 (`docs/research/origin-and-rationale.md`).
- [x] Document the skill-first refactoring and external-harness problem frame (`docs/research/skill-first-projects-and-external-harnesses.md`).
- [x] Draft a provider-neutral nested source-unit composition proposal, compare it with the current implementation, and enumerate the experiment decisions (`docs/research/provider-neutral-nested-source-unit-composition.md`).
- [x] Approve the experiment-only Stage 1 parameters, fixture-preparer boundary, validation split, counting/error semantics, and isolated allowed write root (`docs/research/provider-neutral-nested-source-unit-composition.md`).
- [x] Complete Stage 1: structural and Pi 0.82 composition mechanics passed; bounded-wrapper evidence did not demonstrate Bazframe-exclusive necessity (`experiments/provider-neutral-nested-source-unit-composition/REPORT.md`).
- [x] Complete the reopened experiment-only Stage 2 sanitized MTG source-tree/runtime proof with two provider-prepared children and two unrelated callers; exclusive necessity was not demonstrated (`experiments/provider-neutral-nested-source-unit-composition/stage2-mtg/REPORT.md`).
- [x] Record the historical narrow live-composition seam and its bounded-wrapper evidence, then supersede its read-only/provider-preparation constraint with the explicit build-and-snapshot lifecycle (`docs/design.md`).
- [x] Audit the production-shaped external MTG bundle and hand off its remaining package-local contract and lifecycle fixes; broader inter-skill dependency semantics remain the single product question above.

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
- [x] Compare that flow with external skill-library tools, Vercel `skills`, Git, and a small wrapper (`docs/research/prototype-alternatives.md`).
- [x] Provisionally select TypeScript/Node ESM for the approved prototype; this is not a product-stack commitment.
