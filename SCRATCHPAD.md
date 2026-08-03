# Scratchpad

## Current state

- `docs/design.md` is the current positive product specification for portable profiles, external repository registration, and the first Pi adapter.
- Bazframe 2 manages skill packs, profiles composed from direct skills and packs, and application of resolved profiles to coding agents.
- Skill artifacts remain provider-owned. Bazframe consumes configured Agent Skills-compatible roots without depending on Skillbook or another particular acquisition, versioning, update, or publication provider.
- The implementation uses TypeScript/Node ESM with no Bazframe runtime dependencies. The stack remains provisional at the broader product level.
- The production Pi flow now covers adapter install/update/repair/uninstall, active-profile selection, profile-local `AGENTS.md`, external `init`/`uninit`, read-only `status`, direct `pi`/`pi -nc` context behavior, reload, explanation, profile skills, and collision aliases.
- [`docs/prototype.md`](docs/prototype.md) records migration from the deprecated `bazframe pi` launcher and preserves that slice's historical contract.
- `docs/research/origin-and-rationale.md` records why Bazframe 2 likely emerged from the v1 implementation, harness trial, and overlapping skill ecosystem.
- `docs/research/prototype-alternatives.md` finds that the integrated profile-to-session transition is coherent but reproducible by a small wrapper; skill-management ownership remains unjustified pending a bounded baseline test.
- The MTG skill-refactor experiment is complete under `experiments/mtg-skill-refactor/`. It validates profile/repository instruction composition, additive Pi skills, lean repository routing, and skill-local procedures against a real harness-heavy project. Domain skills and local/account state remained repository-owned; no evidence justified Bazframe-owned skill acquisition or updates.
- `docs/research/skill-first-projects-and-external-harnesses.md` records the broader dependency-aware skill-bundle and external-harness problem frame; skill bundle/dependency work is now deferred.
- `docs/pi-adaptive-context-adapter.md` defines the accepted first Pi adapter boundary: plain `pi` keeps native context and adds the profile; `pi -nc` yields an empty structured context list, so the adapter restores global Pi context and adds the profile.
- The Pi 0.82 prototype under `experiments/pi-no-launcher-adapter/` validates direct Pi invocation through a global extension. Global context appears exactly once in each mode; profile instructions and additive skills reload; native/profile skill collisions expose the profile copy as `<name>-x-bazframe` from external cache; project resources remain Pi-owned.
- `docs/pi-adapter-production-design.md` is the implemented baseline. It settles the command surface, explicit install lifecycle, global active-profile registrations, drift repair, artifact packaging, ownership, atomic writes, cache lifecycle, compatibility target, canonical-path identity, milestones, and verification gates.

## Current focus

Define the provider-neutral skill-root, skill-pack, and profile-reference data model, including provenance-preserving add/remove behavior. Then settle referenced versus self-contained profile and pack export. The implemented slice already assigns skill discovery, validation, exposure, collision projection, and diagnostics to Bazframe while source providers own artifact acquisition and lifecycle.

## Deferred questions

- Generalized dependency-aware skill refactoring and transferable bundle design beyond collection-only skill packs.
- Semantic composition between personal and repository-recommended harnesses.

## Product questions after the Pi slice

The first Pi integration now commits to one global active profile, external canonical-path registrations, immediate Agent Skills-compatible profile children, lowercase hyphenated profile IDs, a 1 MiB instruction cap, additive native/profile skills, and deterministic Pi collision aliases.

Semantic conflict resolution, broader cross-runtime alias behavior, pack/profile representation, provider-neutral root resolution, export form, and pack/profile command lifecycles remain open.

## Latest prototype validation

- A manual user trial of the global adapter succeeded, including clean uninstall; the bounded adaptive behavior was subsequently accepted as the first Pi adapter boundary.
- The revised isolated Pi 0.82 global-extension spike passed adaptively: `pi -nc` restored global context while excluding ancestor/repository context; plain `pi` retained native context without duplicating global instructions; both added the profile; a `reviewer-probe` collision became `reviewer-probe-x-bazframe`; reload, native project resources, unregistered behavior, and repository immutability were verified.
- `npm ci` passed with zero reported vulnerabilities.
- `npm test` passed: clean build, typecheck, lint, 97 unit tests, 8 fake-Pi integration tests, and packed-package adapter lifecycle smoke tests.
- `npm run test:real-pi` passed against Pi 0.82.0 using the packed installed CLI, both context modes, profile instructions, a profile skill, external registration, clean uninstall, and stable Git status.
- The production artifact also passed the full isolated Pi adapter spike: reload, deterministic collision alias, native trusted project resources, registration gating, and stable repository snapshots.
- The documented two-profile demo passed: selecting `focused` and then `reviewer` changed the next dry-run's profile section while preserving the same root `AGENTS.md` section.
- A completed real Pi 0.82 smoke launched actual Pi with the `focused` profile and `demo-profile` skill in a temporary Git repository. Pi's response reflected both the profile preference and the root `AGENTS.md` rule; exit was 0; Git status was unchanged; Bazframe diagnostics were on stderr and the Pi response was on stdout.

## Relevant local evidence

- Bazframe v1: `~/baz/`
- Bazframe ecosystem assessment: `~/foo_bazframe/BAZFRAME_ECOSYSTEM_ASSESSMENT.md`
- Vercel `skills`: `~/foo_bazframe/skills/`
- Skillbook: `~/foo_bazframe/skillbook/`
