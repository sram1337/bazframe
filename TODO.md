# TODO

## Product definition

- [ ] Define the first-class harness/profile data model.
- [ ] Define which skill-management responsibilities Bazframe owns.
- [ ] Define library, profile, project, and effective-harness ownership boundaries.
- [ ] Define command semantics for `use`, `scan`, `add`, `remove`, and `lift`.
- [ ] Define instruction and skill conflict resolution.
- [ ] Define referenced versus self-contained profile export.

## Research

- [x] Research the likely origin and scope pressure behind Bazframe 2 (`docs/research/origin-and-rationale.md`).
- [x] Document the skill-first refactoring and external-harness problem frame (`docs/research/skill-first-projects-and-external-harnesses.md`).
- [ ] **Deferred:** Map the MTG skills' cross-skill dependencies and test one transferable bundle through an external live library.

## No-launcher override experiment

- [x] Establish that full project-resource replacement is unavailable through the Pi 0.82 extension API and reject project trust as harness selection.
- [x] Prototype an adaptive global extension without a launcher, shim, repository write, prompt parser, context-path comparison, or Pi modification (`experiments/pi-no-launcher-adapter/REPORT.md`).
- [x] When Pi's structured context list is empty, restore global Pi context and append the profile; otherwise append only the profile.
- [x] Validate `pi -nc` replacement mode, plain-`pi` additive mode without duplicate global context, active-profile reload, additive skills, `-x-bazframe` collision aliases, native project resources, unregistered repositories, and repository immutability.
- [x] Accept bounded adaptive instruction-context behavior as the first Pi adapter boundary.
- [x] Draft the Pi adapter production-design outline for review (`docs/pi-adapter-production-design.md`).
- [ ] Review and approve the Pi adapter command surface, install/init relationship, registration profile policy, and drift-repair UX.
- [ ] Settle adapter artifact packaging, ownership metadata, atomic external writes, cache pruning, compatibility, and repository identity.
- [ ] Convert the approved Pi adapter design into implementation milestones and verification gates.

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
