# TODO

## Product definition

- [x] Define the first-class profile and effective-harness data model, including profile-local `AGENTS.md`, for the first production slice (`docs/design.md`).
- [x] Define first-slice skill responsibilities: profile discovery, validation, runtime exposure, collision projection, and diagnostics.
- [x] Keep skill acquisition, versioning, updating, and publication provider-owned; Bazframe consumes configured Agent Skills-compatible roots.
- [x] Define profile, project, runtime, and effective-harness ownership for the first Pi slice (`docs/design.md`).
- [x] Define Bazframe as the manager of skill packs, profiles, and profile application without coupling it to a skill-library provider.
- [x] Define and implement `use` semantics for global active-profile selection.
- [ ] Define provider-neutral skill-root resolution and collision behavior.
- [ ] Define pack/profile storage and provenance-preserving add/remove command semantics.
- [x] Define first-slice Pi context ordering and native/profile skill-collision aliases.
- [ ] Define semantic instruction conflicts and cross-runtime skill conflicts.
- [ ] Define referenced versus self-contained profile export.

## Research

- [x] Research the likely origin and scope pressure behind Bazframe 2 (`docs/research/origin-and-rationale.md`).
- [x] Document the skill-first refactoring and external-harness problem frame (`docs/research/skill-first-projects-and-external-harnesses.md`).
- [ ] **Deferred:** Map the MTG skills' cross-skill dependencies and test one transferable bundle through an external live library.

## Pi adaptive context adapter

- [x] Map the Pi 0.82 extension API boundary and keep project trust as Pi's security decision.
- [x] Prototype a global extension driven by structured Pi context and resource events (`experiments/pi-no-launcher-adapter/REPORT.md`).
- [x] Restore global Pi context and append the profile when Pi reports an empty context list; otherwise append the profile to native context.
- [x] Validate `pi -nc` replacement mode, plain-`pi` additive mode with one global context copy, active-profile reload, additive skills, `-x-bazframe` collision aliases, native project resources, registration gating, and stable repository state.
- [x] Accept bounded adaptive instruction-context behavior as the first Pi adapter boundary (`docs/pi-adaptive-context-adapter.md`).
- [x] Approve the production command surface, explicit adapter installation, global active-profile registrations, and manifest-gated `--force` repair.
- [x] Settle self-contained artifact packaging, ownership metadata, atomic external writes, cache lifecycle, compatibility, and canonical-path repository identity.
- [x] Convert the production design into implementation milestones and verification gates (`docs/pi-adapter-production-design.md`).

## Pi adapter production implementation

- [x] Milestone 1: implement and test external-state foundations, codecs, locks, atomic writes, and ownership comparison.
- [x] Milestone 2: package the extension artifact and implement safe adapter install, update, repair, and uninstall.
- [x] Milestone 3: implement external `init`, `uninit`, and production `status`.
- [x] Milestone 4: productionize adaptive context, skills, aliases, reload, explanation, and compatibility handling.
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
