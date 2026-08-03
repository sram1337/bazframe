# Scratchpad

## Current state

- `docs/design.md` is copied from `~/baz/bazframeV2.md` as the initial concept.
- Bazframe 2 intentionally explores a product that mixes profiles and skill management.
- Delegating skill artifact management to another tool is an alternative under evaluation, not a settled decision.
- An autonomous, approved vertical-slice prototype now uses TypeScript/Node ESM with no runtime dependencies. The stack is provisional, not a product commitment.
- The implemented flow is limited to `bazframe use <profile>` and `bazframe pi [--dry-run] [-- <pi args>]`; profile authoring and independent skill lifecycle are excluded.
- [`docs/prototype.md`](docs/prototype.md) records the slice's reversible contract, deviations from the concept draft, trust assumptions, and known limitations.
- `docs/research/origin-and-rationale.md` records why Bazframe 2 likely emerged from the v1 implementation, harness trial, and overlapping skill ecosystem.
- `docs/research/prototype-alternatives.md` finds that the integrated profile-to-session transition is coherent but reproducible by a small wrapper; skill-management ownership remains unjustified pending a bounded baseline test.
- The MTG skill-refactor experiment is complete under `experiments/mtg-skill-refactor/`. It validates profile/repository instruction composition, additive Pi skills, lean repository routing, and skill-local procedures against a real harness-heavy project. Domain skills and local/account state remained repository-owned; no evidence justified Bazframe-owned skill acquisition or updates.
- `docs/research/skill-first-projects-and-external-harnesses.md` records the broader dependency-aware skill-bundle and external-harness problem frame; skill bundle/dependency work is now deferred.
- `docs/no-launcher-harness-override.md` defines the accepted first Pi adapter boundary: plain `pi` keeps native context and adds the profile; `pi -nc` yields an empty structured context list, so the adapter restores global Pi context and adds the profile.
- The Pi 0.82 prototype under `experiments/pi-no-launcher-adapter/` validates both modes without a launcher, shim, repository write, prompt parser, context-path comparison, trust manipulation, or Pi modification. Global context appears exactly once in each mode; profile instructions and additive skills reload; native/profile skill collisions expose the profile copy as `<name>-x-bazframe` from external cache; other project resources remain Pi-owned.
- `docs/pi-adapter-production-design.md` is a production-design outline awaiting review. It covers install/uninstall, external registration, status, ownership, cache, compatibility, diagnostics, acceptance, and unresolved decisions.

## Current focus

Review `docs/pi-adapter-production-design.md`, settle its command and lifecycle decisions, then convert the approved design into implementation milestones and verification gates.

## Deferred questions

- Generalized dependency-aware skill refactoring and transferable bundle design.
- Bazframe ownership of skill acquisition, scanning, lifting, updates, or publishing.
- Semantic composition between personal and repository-recommended harnesses.

## Prototype assumptions still open as product decisions

- One global active profile stored as plain text under `BAZFRAME_HOME`.
- Live self-contained profile directories and immediate Agent Skills-compatible skill children.
- Root `AGENTS.md` only; profile text is transported before repository text with no semantic merge.
- Pi-only, temporary out-of-repository `--append-system-prompt` transport and additive explicit `--skill` paths.
- Native Pi skills deliberately coexist. In the global-adapter experiment only, a colliding profile skill is projected under external Bazframe cache as `<name>-x-bazframe`; broader cross-runtime alias semantics remain unsettled.
- Lowercase hyphenated profile IDs, a 1 MiB instruction cap, and system-temp cleanup behavior.

Instruction precedence, conflict resolution, profile/library/project ownership, export form, provider integration, and the `scan`/`add`/`remove`/`lift` lifecycles remain unsettled.

## Latest prototype validation

- A manual user trial of the global adapter succeeded, including clean uninstall; the bounded adaptive behavior was subsequently accepted as the first Pi adapter boundary.
- The revised isolated Pi 0.82 global-extension spike passed adaptively: `pi -nc` restored global context while excluding ancestor/repository context; plain `pi` retained native context without duplicating global instructions; both added the profile; a `reviewer-probe` collision became `reviewer-probe-x-bazframe`; reload, native project resources, unregistered behavior, and repository immutability were verified.
- `npm ci` passed with zero reported vulnerabilities.
- `npm test` passed: clean build, typecheck, lint, 62 unit tests, 7 fake-Pi integration tests, and installed-package smoke test.
- `npm pack --dry-run --json` passed and included built output, linked docs, `TODO.md`, both example profiles, and `package.json`.
- The documented two-profile demo passed: selecting `focused` and then `reviewer` changed the next dry-run's profile section while preserving the same root `AGENTS.md` section.
- A completed real Pi 0.82 smoke launched actual Pi with the `focused` profile and `demo-profile` skill in a temporary Git repository. Pi's response reflected both the profile preference and the root `AGENTS.md` rule; exit was 0; Git status was unchanged; Bazframe diagnostics were on stderr and the Pi response was on stdout.

## Relevant local evidence

- Bazframe v1: `~/baz/`
- Bazframe ecosystem assessment: `~/foo_bazframe/BAZFRAME_ECOSYSTEM_ASSESSMENT.md`
- Vercel `skills`: `~/foo_bazframe/skills/`
- Skillbook: `~/foo_bazframe/skillbook/`
