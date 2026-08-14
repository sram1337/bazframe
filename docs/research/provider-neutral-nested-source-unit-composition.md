# Provider-neutral nested source-unit composition

> **Status: historical mechanics research. Stage 1 and the reopened sanitized MTG Stage 2 completed; their profile-local live-source contract was later superseded by global managed sources, explicit builds, immutable snapshots, and exact profile references.**
>
> [`../design.md`](../design.md) is the current product source of truth. The profile-local descriptor, bounded live discovery, and deferred global-registry statements below record the superseded experiment-era contract rather than current behavior. The experiments did not demonstrate Bazframe-exclusive necessity: a provider plus a bounded wrapper reproduced the mechanics. Acquisition, updates, dependencies, mutable data, credentials, subsets, and packs remain outside Bazframe ownership; current build, snapshot, reference, and projection responsibilities are defined in the design.

## Purpose

The MTG research identifies a credible composition problem: several independently invocable Agent Skills may depend on one intact surrounding tree of shared code, references, locked dependencies, and mutable data. Flattening those children into unrelated top-level installations can break relative paths, duplicate shared material, and detach commands from their runtime dependencies.

This note records the research path from the current flat implementation through the completed experiments and subsequent product decision. It evaluates the smallest provider-neutral model without turning Bazframe into a package manager or silently reviving Bazframe v1 scope.

The research question was:

> Can Bazframe select one intact provider-owned source tree as a profile membership, derive its independently invocable child skills, and project those skills safely without acquiring, updating, or executing the source itself?

The mechanics passed. Exclusive necessity was not shown, but the user answered the separate product question affirmatively for Bazframe's existing profile/runtime integration. This decision is value-based and deliberately bounded, not a claim that only Bazframe can perform the composition.

## Authority and evidence levels

The relevant material has different authority:

1. [`../design.md`](../design.md) records accepted product decisions.
2. The current repository implementation and tests record committed and implemented behavior; release status is a separate question.
3. [`skill-first-projects-and-external-harnesses.md`](skill-first-projects-and-external-harnesses.md) records problem framing and hypotheses.
4. `~/foo/research/BAZFRAME_EXECUTIVE_SUMMARY.md` recommends a provider-neutral composition proof while leaving lifecycle expansion unapproved.
5. The three designs under `~/foo/mtg_test/` are detailed proposals. They supply useful terminology, safety analysis, and an MTG migration candidate, but they do not override Bazframe's product design.

This document separates observed behavior, historical experiment semantics, the later accepted composition decision, and still-unapproved lifecycle expansion accordingly.

## Current implementation compared with the executive summary

### Snapshot correction

The executive summary describes an August 2026 snapshot at commit `8dd7528` with a large uncommitted candidate containing profile lifecycle, direct membership, global policy, collision aliases, and the first TUI slice.

That implementation has since landed in commit `7c43af5` (`Session: dev — ship profile management, TUI, and file-free Pi policy`). The summary's first two maturity rows should therefore now be read as one committed implementation baseline for this checkout. Its strategic ownership analysis remains applicable, but its dirty-worktree and uncommitted-candidate description is historical. This note does not establish that the private prototype package has been released.

### What is implemented now

| Area | Current implementation | Comparison with the executive summary |
|---|---|---|
| Profile lifecycle | Create, duplicate, select, rename, guarded remove, list, and inspect profiles. | The formerly uncommitted candidate is now committed. |
| Direct membership | Add or remove one flat Skillbook skill for the active or an explicitly selected inactive profile. | Landed as described by the candidate snapshot. |
| Policy | File-free global enablement, global disable, and Git-worktree enabled/disabled overrides; non-Git directories inherit global policy. | Landed as described by the candidate snapshot. |
| Pi projection | Native context remains Pi-owned; profile context and immediate profile skills are additive; native/profile name collisions receive deterministic aliases. | Landed and still bounded to Pi 0.82.x. |
| Management UI | Profile lifecycle, selected-profile membership, read-only Skillbook browsing, and read-only setup status. | The first slice is committed, but remains preview-quality pending broader terminal and accessibility validation. |
| Explainability | `status` and `/bazframe info` report effective profile/runtime state and collision aliases. | Landed; current use of “effective skills” means runtime-observed/projected skills, not recursively derived source-unit children. |

### What remains unchanged from the summary

- A profile is portable across working directories but not reconstructible across machines. Membership entries are absolute symlinks into one machine-local Skillbook library.
- One global `active-profile` still constrains simultaneous terminals that need different profiles.
- Bazframe resolves one Skillbook root and assumes flat entries under `<library>/skills/<skill-id>`.
- A managed membership maps one profile entry to one source directory whose root contains `SKILL.md` and whose declared name matches its directory ID.
- Profile loading and the packaged Pi adapter inspect only immediate profile-skill children. Only immediate children containing `SKILL.md` are considered; each considered child must load as exactly one skill.
- Pi itself can recursively discover `SKILL.md` directories in its native skill roots, but Bazframe's current membership and adapter gates do not expose a grouping root without its own `SKILL.md`. Pi's recursion is also not a provider-neutral boundary or symlink-safety policy.
- Provider-neutral source identity, zero/one/many source roots, broken or retargeted root behavior, referenced profile descriptors, and nested source-unit composition remain unimplemented.
- Bazframe does not acquire or update skill sources, install their dependencies, supervise their commands, preserve their mutable data during source updates, or broker credentials.
- Pi remains the only production adapter evidence.

### Current flat composition path

```text
one resolved Skillbook root
  -> skills/<skill-id>/SKILL.md
  -> absolute profile membership symlink
  -> one immediate profile skill
  -> one Pi skill definition and original base directory
```

The missing composition layer is:

```text
provider source
  -> intact source unit
  -> one direct profile membership
  -> bounded descendant discovery
  -> multiple effective skill records
  -> individual runtime definitions with original bases
```

## Observed problem

### Agent Skills boundary

An Agent Skill is an independently loadable directory containing `SKILL.md`. Supporting files inside that directory are freeform and may be referenced relative to the skill root.

Agent Skills does not standardize:

- a parent grouping directory;
- cross-skill dependency resolution;
- source acquisition or updates;
- package-manager or lockfile behavior;
- mutable-data lifecycle;
- process supervision; or
- credential brokerage.

A child directory in the proposed model may remain Agent Skills-compatible. Its parent source unit, group-level shared files, and lifecycle behavior are manager/provider conventions layered around Agent Skills.

### MTG evidence

The MTG work documents skills that currently depend on repository-root scripts, fixed ancestor traversal, shared references, one npm dependency root, CWD-sensitive configuration, caches, decks, and account state. Existing flat copies are therefore not self-contained transferable units.

This supports a larger intact composition boundary. It does not by itself establish:

- a universal source-unit format;
- that `shared/` or `data/` should be reserved Bazframe directories;
- that every child should always be exposed;
- that current Skillbook can provide the intact source;
- or that Bazframe should own source lifecycle.

## Composition model evaluated

```text
SourceProvider
  -> SourceUnit
  -> DirectMembership
  -> EffectiveSkill[]
  -> RuntimeProjection
```

### Source provider

The sole authority that supplies a concrete source tree. A provider may have capabilities such as preparation, update, or removal, but those capabilities do not automatically belong to Bazframe.

Every concrete source must have exactly one writable lifecycle owner.

### Source unit

One intact provider-supplied filesystem root selected as a composition boundary. It may be:

- a standalone skill whose root contains `SKILL.md`; or
- a grouping root containing descendant skill directories and shared files.

For the minimum experiment, a source unit has no Bazframe-defined group metadata, dependency semantics, version selection, child-selection manifest, acquisition operation, or update boundary. One direct membership exposes every valid descendant skill. Any later ability to select a subset is a separate product decision with pack-like semantics and is outside this experiment.

### Direct membership

One profile selection of a source-unit root. It answers which intact provider sources the profile selects.

Direct membership remains distinguishable from the runtime-visible child skills derived from that source. It does not install or version them.

### Effective skill

One valid descendant Agent Skill derived from a direct source-unit membership and projected to a runtime. It retains:

- its declared Agent Skills name;
- its physical child base directory;
- its definition path;
- its source/provider identity for diagnostics; and
- a qualified child identity distinct from the runtime name.

A qualified identity such as `provider/source/card-search` is a Bazframe composition identity. It must not rewrite the child's declared Agent Skills name merely to encode ancestry.

### Bounded recursive discovery

Candidate discovery is deterministic traversal constrained to one provider-authorized source root under an explicit canonical-path and link policy. It identifies descendant directories containing `SKILL.md` and does not expose ordinary shared/resource directories as skills.

A bounded Bazframe discovery step may be justified even though Pi recursively discovers skills, because Bazframe must explain direct versus effective membership consistently and cannot treat Pi's runtime-specific traversal and symlink behavior as a provider-neutral safety contract.

### Original-base preservation

The adapter receives individual effective skill definitions while retaining each child's original physical base directory. Bazframe does not flatten descendants into unrelated copies.

The Stage 1 fixture deliberately tests a child reference to `../shared/reference.md` whose canonical target remains inside the source root. This is a Pi 0.82-specific experiment condition, not a cross-runtime portability guarantee or a new Agent Skills rule.

## Ownership boundary entering the experiments

| Owner | Currently accepted responsibility |
|---|---|
| Source provider | Canonical source bytes, acquisition, versioning, preparation, update, publication, deletion, and provider lock state. |
| Bazframe | Profile lifecycle, current flat direct-membership materialization, selection, policy, runtime composition, collision handling, diagnostics, and explanation. |
| Repository | Project instructions, code, project data, and native project resources. |
| Pi/runtime | Runtime trust, native resources, tools, settings, and final runtime loading behavior. |

The experiments proposed adding only three Bazframe composition responsibilities: resolving a direct source-unit membership, deriving bounded effective-skill records, and projecting those records individually. At experiment time these were hypotheses. The later product decision approved that narrow responsibility set, with Bazframe-owned profile-local JSON descriptors replacing the experiment-only membership link. It did not create dual write authority between Bazframe and a provider.

## Historical experiment contract

The following parameters were approved only for Stage 1 to make the fixture falsifiable. The later product decision separately adopted the tested depth, entry, and child bounds as an explicit first-slice compatibility contract. In this continuation, the user separately decided that exact-name `.git` and `node_modules` entries must be pruned before counting because VCS and dependency internals are not direct skill definitions. That pruning rule is product authority, not experimental measurement: Stage 2 established its discovery result before `npm ci --ignore-scripts` prepared `node_modules` and did not rerun discovery afterward. Other production differences, including profile-local JSON descriptors, are specified in [`../design.md`](../design.md).

| Parameter | Stage 1 value |
|---|---|
| Descendant selection | Expose every valid skill under the selected source unit; no subset manifest. |
| Root semantics | A grouping root has no `SKILL.md`. A standalone root containing `SKILL.md` is terminal and must contain no descendant skill definition. |
| Traversal limits | Maximum directory depth 8 below the source root, 256 visited entries, and 64 effective skills. |
| Link policy | Resolve the separately managed direct membership once; reject every symlink found inside the source tree. |
| Duplicate policy | Reject duplicate declared Agent Skills names within the effective set before Pi projection; do not alias them. |
| Shared-reference condition | Permit `../shared/reference.md` only when its canonical target remains inside the selected source root; claim Pi 0.82 compatibility only. |
| Ordering | Discover by lexical relative path and return effective records in that order. |
| Effective record | `{ providerId, sourceId, qualifiedId, sourceRoot, skillRoot, definitionPath, declaredName }`. These experiment fields are not a production persistence schema. |
| Failure oracle | Return failure with a deterministic category and offending relative path. Categories are `broken-root`, `limit-exceeded`, `internal-symlink`, `mixed-root`, `invalid-definition`, and `duplicate-name`. |
| Mutation oracle | Only the isolated Bazframe home may change. Provider and destination-repository path/type/size/content-hash manifests must match before and after. |
| Regression gate | Existing behavior passes `npm test`; a dedicated Pi 0.82 probe asserts the exact two effective definition paths and original bases. |

The executable Stage 1 contract was approved on this research branch as recorded below. This approval authorizes only the experiment; it does not change product behavior or approve Stage 2.

### Stage 1: structural fixture

Use an externally prepared, immutable temporary source root containing:

- `alpha/SKILL.md` and `beta/SKILL.md` with different declared names;
- `shared/reference.md`, referenced by both children;
- one ordinary non-skill sibling;
- no credentials or user data; and
- no Bazframe-owned installation step.

One direct membership must produce exactly two effective records in `alpha`, `beta` lexical order. Each child retains its original base and resolves `../shared/reference.md` from two unrelated session working directories.

Negative fixtures have exact outcomes:

| Fixture | Expected outcome |
|---|---|
| Two children declare one name | `duplicate-name` failure before Pi projection. |
| Missing/invalid required definition metadata | `invalid-definition` failure naming the definition. |
| Missing membership target | `broken-root` failure. |
| Depth, entry, or skill count exceeds its bound | `limit-exceeded` failure naming the exceeded bound. |
| Any source-internal symlink | `internal-symlink` failure naming the entry. |
| Root contains `SKILL.md` and a descendant definition | `mixed-root` failure. |

Before and after the probe, complete path/type/size/content-hash manifests must prove that the provider source and both destination repositories are unchanged. The isolated Bazframe home is the only allowed write location.

### Stage 2: completed sanitized MTG proof

The user separately reopened Stage 2 after Stage 1 review. Its provider-prepared public/read-only subset deliberately uses only `card-search` and `deck-analysis`; the external proposal's twelve-child target remains migration-design input, not a generic product invariant.

The proof starts from two unrelated clean Git callers without copying source-project secrets, account state, logs, or unrelated files. Both children consume shared pure code, two exact approved references, synthetic immutable inputs, and a root-prepared locked `tsx` runtime. Direct child-root execution is explicitly source-tree development evidence, not managed lifecycle behavior.

### Bazframe responsibilities in the experiment

Bazframe may:

- record experiment-scoped provider/source/root values;
- resolve one direct membership;
- perform bounded deterministic discovery;
- validate the minimum structure required for composition;
- preserve original child bases;
- project individual definitions to Pi 0.82;
- report direct memberships and effective skills separately; and
- fail visibly on ambiguous or unsafe composition.

## Success and falsification

### Success criteria

- One direct membership yields exactly the two ordered Stage 1 effective records.
- The non-skill sibling is not exposed as a skill.
- Both children retain their physical bases and resolve the in-root shared reference without flattening.
- Every negative fixture produces its specified failure category and relative path.
- Provider and destination manifests are byte-identical before and after; only the isolated Bazframe home changes.
- `npm test` passes, preserving existing flat Skillbook-backed behavior.
- The dedicated Pi 0.82 probe receives the two individual definitions with original bases and does not ask Pi to rescan the grouping root.
- Direct membership and effective skills are independently explainable.

### Falsification criteria

- Either child requires a path or mutable state from the source project that is absent from the declared fixture inputs.
- Preserving the shared reference requires a Bazframe-private skill format rather than the intact provider tree.
- Runtime projection writes either destination repository.
- Bazframe cannot enforce the authorized root and proposed bounds without mutating provider bytes.
- Bazframe must acquire, update, install, supervise, or broker credentials merely to expose the children.
- A provider plus a bounded wrapper produces the same direct/effective records, original-base projection, diagnostics, and no-mutation guarantees without a missing Bazframe profile invariant.

A falsified composition experiment must not be rescued by silently expanding Bazframe's lifecycle scope.

## Stage 1 evidence and disposition

Stage 1 ran against baseline HEAD `7c43af59238109479291fcc5ef04c0f19f8e6651` and Pi 0.82.0. The pre-existing untracked `todo.txt` was observed and left untouched; no historical content-hash comparison was captured or claimed.

The experiment's mechanics passed: one experiment-local membership resolved to ordered `alpha` and `beta` effective records, each retained its original base, real Pi loaded only the individual definitions from two unrelated working directories, both bases resolved the same in-root shared reference, the negative structural fixtures returned their specified diagnostics, Pi-invalid metadata was withheld with an intentional loader diagnostic, and provider/destination manifests plus destination Git statuses remained unchanged.

Bazframe-exclusive necessity was nevertheless **not demonstrated**. The externally prepared fixture plus experiment-local bounded resolver and extension supplied the same direct/effective records, original-base projection, diagnostics, and mutation guarantees without using a production Bazframe profile or exposing a missing Bazframe profile invariant. This is the bounded-wrapper evidence defined above.

That evidence does not invalidate the bounded composition mechanics. Stage 1 alone did not establish an exclusive-necessity argument for Bazframe ownership or production integration. The later user decision used a different authority: deliberate product value in Bazframe's profile/runtime integration. Current production semantics are therefore those now recorded in [`../design.md`](../design.md), not an inference from Stage 1.

## Stage 2 evidence and disposition

The reopened Stage 2 proof lives under [`../../experiments/provider-neutral-nested-source-unit-composition/stage2-mtg/`](../../experiments/provider-neutral-nested-source-unit-composition/stage2-mtg/). Its sanitized source bytes derive only from Git objects at MTG source commit `55ebbf4104cc0ca80e7e907b503ca4c803107785`, read with `git show`; generated provenance verifies pinned source hashes, exact copied-reference hashes, transformed destination hashes, and exclusions.

Before the mutation window, the provider prepared one grouping root with `card-search` and `deck-analysis`, the Stage 1 resolver established the exact child records, and `npm ci --ignore-scripts` then prepared exact `tsx@4.21.0` from the root lock. Discovery was not rerun after that `node_modules` preparation, so Stage 2 supplies no evidence for pruning `.git` or `node_modules` during discovery. During measurement, both child-local adapters ran offline/no-install from each of two unrelated Git caller CWDs, deliberately changed to their physical child roots, resolved ancestor runtime/shared modules/references, and emitted equal canonical JSON per child. Both consumed the same pure card loader/search code, exact `card-evaluation-framework.md` and `synergy-support-math.md` copies, and synthetic immutable card/deck inputs.

Real Pi 0.82 independently loaded only the two exact child definitions with their original bases from both callers; the grouping root was never requested. Complete provider/caller manifests and caller Git statuses remained unchanged.

**Stage 2 evidence disposition: source-tree/runtime composition mechanics passed; Bazframe-exclusive necessity remains not demonstrated.** Bazframe did not acquire, install, or execute the source as experiment behavior. The proof does not establish a managed gateway, dependency lifecycle, leases, updates, mutable data, credentials, or cross-runtime portability. It informed—but did not itself authorize—the later narrow production membership and projection decision in [`../design.md`](../design.md).

Residual evidence limits are Pi 0.82.x-only runtime coverage, unexpected I/O and concurrent-race behavior, privileged bypass of permission-bit isolation, and lack of a safely portable direct fixture for unsupported special filesystem entries. The resolver conservatively rejects such entries, but that branch is not directly fixture-tested.

## Historical decisions required before Stage 1 implementation

1. Approve or revise the Stage 1 parameter table.
2. Select the bounded fixture preparer that owns the first source root and approve an experiment-only direct-membership representation under an isolated Bazframe home.
3. Define depth and visited-entry counting, deterministic failure precedence, unexpected I/O handling, and treatment of unreadable or unsupported filesystem entries.
4. Decide what minimum structural validation belongs to the experiment resolver versus the Pi-version compatibility probe.
5. Define all allowed write roots for the real-Pi probe; provider and destination roots remain immutable.
6. Separately approve Stage 2 and its sanitized MTG child set after Stage 1 review. This later occurred under the reopened two-child experiment contract recorded above.
7. Define the provider failure or recurring workflow invariant that would justify reopening Bazframe-owned lifecycle scope.

## Approved Stage 1 executable contract

The user approved Tasks 0-3 with these exact experiment-only semantics:

- The fixture preparer is the sole owner of fixture creation. It creates the provider source, experiment-only membership link, isolated Bazframe home, and two destination Git repositories before the mutation window, then makes the provider and destination trees read-only.
- Direct membership is a symbolic link at `<isolated-bazframe-home>/memberships/<sourceId>` plus explicit `providerId` and `sourceId` resolver inputs. No production profile schema or Skillbook command is involved. The resolver resolves this membership once to a canonical directory root.
- Provider and source IDs, declared skill names, and skill-directory basenames use the Agent Skills-compatible `1-64` lowercase-letter/digit/single-hyphen form. A declared name must match its skill-directory basename. The resolver owns these filesystem/name identity and definition checks; Pi owns only the later Pi 0.82 loading compatibility probe.
- The source root has depth 0. A descendant directory's depth is its relative directory-component count. Directories through depth 8 may be inspected, including files immediately inside a depth-8 directory; encountering a directory at depth 9 fails.
- The source root itself is excluded from entry counting. Every immediate `readdir` result below it counts once before type-specific processing, including files, directories, links, and unsupported entry types. The 257th entry fails. A detected 65th skill fails.
- Traversal is lexical, relative-path, depth-first traversal. Checks occur in encounter order. For one entry, entry and depth/skill limits are checked before definition parsing; symlink rejection occurs before unsupported-type or definition handling. A duplicate fails when its second definition is encountered. This is also the deterministic multiple-failure precedence.
- Every source-internal symbolic link is rejected without following it. Unsupported filesystem entry types are conservatively rejected as `invalid-definition`. Ordinary non-skill files and directories are permitted and still count toward the limits.
- A grouping root without `SKILL.md` may resolve to zero or more effective skills. A root with `SKILL.md` is a standalone skill; it yields one root effective record only when no descendant `SKILL.md` exists. A descendant definition under a standalone root fails as `mixed-root` before parsing that descendant definition.
- Expected structural failures use `{ category, path }` diagnostics with one of `broken-root`, `limit-exceeded`, `internal-symlink`, `mixed-root`, `invalid-definition`, or `duplicate-name`. Relative paths use `/`, the root is `.`, and limit diagnostics also identify `depth`, `entries`, or `skills`.
- Unexpected filesystem I/O errors and concurrent filesystem races are explicit experiment limitations and may reject the resolver promise rather than being normalized into a product guarantee. The fixture and tests do not simulate permission behavior that is unreliable for privileged users.
- Complete manifests include every root and descendant path without following links, recording relative path, filesystem type, byte size, and SHA-256 content hash for files and link-target bytes. Provider and both destination manifests must compare exactly before and after resolution.
- After baseline manifests are captured and until their after-manifests are captured, the only writable filesystem root is `<isolated-bazframe-home>/**`. For the later Pi probe, `HOME`, Pi agent/config/cache/session state, XDG state, and `TMPDIR` must all resolve beneath that same isolated home. Provider and destination roots remain immutable.
- The preparer and structural tests may create and remove their enclosing experiment-local temporary workspace outside the measured mutation window. No experiment runtime artifact may be written outside `experiments/provider-neutral-nested-source-unit-composition/`.
- Stage 2, Pi projection, runtime compatibility, source lifecycle, dependencies, credentials, subsets, packs, and registries remain unapproved and out of Tasks 0-3.

## Stage 1 task and delegation plan

Stage 1 implementation and runtime artifacts stay entirely under `experiments/provider-neutral-nested-source-unit-composition/`. Evidence-only updates to this note, `TODO.md`, and `SCRATCHPAD.md` are allowed. The experiment must not change `src/`, `artifacts/pi/bazframe.ts`, production profile state, CLI/TUI/status behavior, the package manifest or executable payload, or [`../design.md`](../design.md); no experiment code enters the package. Existing helpers and runtime patterns may be studied or invoked, but experiment types and behavior do not become production APIs.

### Task 0: approve the executable contract

**Owner:** user and parent agent.
**Delegation:** read-only planners and reviewers only.

Approve or revise:

- the parameter table and missing filesystem/error semantics listed above;
- a fixture preparer as the sole source owner;
- an experiment-only membership record or link under an isolated Bazframe home;
- validation ownership between the resolver and Pi 0.82 compatibility probe;
- precise allowed write roots; and
- the production non-change boundary.

**Gate:** no writer starts until these choices are recorded. Any request for production persistence, provider registration, source lifecycle, subset manifests, dependency installation, or Stage 2 stops this plan for a separate product decision.

### Task 1: freeze the baseline

**Owner:** parent agent.
**Delegation:** read-only scout may collect evidence.

- Record the current commit, worktree state, Node version, and Pi version.
- Run `npm test` and the unchanged `npm run test:real-pi` when Pi 0.82.x is available.
- Record the immediate-only production tests and files that Stage 1 must not modify.
- Identify pre-existing files such as untracked `todo.txt` so the experiment does not absorb them.

**Gate:** unrelated failures stop the experiment; they are not fixed inside this workstream.

### Task 2: create the isolated structural harness

**Owner:** one implementation worker.
**Likely files:** experiment-local `README.md`, fixture builder, manifest helper, and resolver modules.

- Create the isolated Bazframe home, provider root, and two destination repositories before the mutation window.
- Create the exact `alpha`, `beta`, `shared/reference.md`, and non-skill fixture.
- Represent one experiment-only direct membership without invoking current Skillbook membership commands.
- Capture complete agreed manifests for provider and destination roots.

**Acceptance:** only the isolated Bazframe/Pi state is writable after baseline manifests are captured.

### Task 3: implement bounded discovery and structural tests

**Owner:** the same sole writer, sequentially after Task 2.

- Resolve the direct membership once.
- Traverse lexically under the approved limits and canonical-path policy.
- Reject internal links, mixed roots, invalid definitions, duplicate names, and exceeded bounds with deterministic category/path diagnostics.
- Emit the exact ordered direct-membership and effective-skill records.
- Add positive, at-boundary, over-boundary, zero-skill/standalone decisions, and multiple-failure-precedence tests according to Task 0.

**Acceptance:** experiment-local tests prove the two exact records, every approved negative oracle, and no provider writes.

### Review gate A: structure, safety, and scope

**Delegation:** parallel fresh-context reviewers; no edits.

1. Traversal/canonical-path/symlink/bounds reviewer.
2. Provider ownership and mutation-oracle reviewer.
3. Product-scope reviewer confirming no production behavior or pack/lifecycle semantics leaked in.

The parent synthesizes findings. One writer applies accepted fixes, then focused tests and Review gate A rerun as needed.

### Task 4: add the isolated Pi 0.82 projection probe

**Owner:** one implementation worker after Review gate A passes.

- Install only an experiment-local extension into the isolated Pi agent directory.
- Load each effective child individually and capture exact `filePath` and `baseDir` values.
- Return only the two individual definition paths through `resources_discover`; never pass the grouping root to Pi.
- Run from two unrelated working directories.
- Resolve and read the shared reference relative to both captured child bases.
- Confine Pi captures, agent state, cache, and session material to the approved isolated write root.

**Acceptance:** both runs prove exact child definitions/bases and shared-reference resolution against Pi 0.82.x. A Pi-version mismatch is an explicit environment-blocked result, not broader compatibility evidence.

### Task 5: enforce mutation and regression gates

**Owner:** the Task 4 writer.

- Compare provider and destination manifests after all probes.
- Require unchanged destination Git status.
- Run experiment-local structural tests, `npm test`, unchanged `npm run test:real-pi`, `git diff --check`, and packaging checks.
- Confirm current immediate-only profile behavior and collision aliases remain unchanged.

**Acceptance:** no unexpected write or baseline regression is tolerated or repaired silently.

### Review gate B: runtime, regression, and evidence

**Delegation:** parallel fresh-context reviewers; no edits.

1. Pi projection and original-base reviewer.
2. Mutation/regression and packaging reviewer.
3. Falsification/scope reviewer comparing the evidence with this contract and a bounded-wrapper baseline.

One writer addresses accepted blockers. Affected gates and focused independent review rerun afterward.

### Task 6: record the outcome

**Owner:** one documentation writer after all gates.

- Write the experiment `REPORT.md` as **passed**, **falsified**, or **inconclusive/environment-blocked**.
- Record exact commands, Pi version, effective records, negative results, manifests, reviewer dispositions, and residual risks.
- Update `TODO.md` and `SCRATCHPAD.md` only for Stage 1 evidence.
- Keep Stage 2 deferred and leave [`../design.md`](../design.md) unchanged.

### Delegation order

```text
Task 0 human approval
  -> Task 1 parent baseline
  -> Tasks 2-3 one writer
  -> Review gate A parallel read-only reviewers
  -> one fix writer if needed
  -> Tasks 4-5 one writer
  -> Review gate B parallel read-only reviewers
  -> one fix writer if needed
  -> Task 6 documentation writer
  -> parent final diff and evidence review
```

Parallelism is limited to read-only planning and review. Only one writer may touch the active worktree at a time.

## Explicit non-goals

- Skill packs, dependency-aware bundles, or a new package format.
- A Bazframe-owned canonical skill library.
- Source acquisition, update, publication, removal, or Skillbook migration.
- Dependency installation or npm lifecycle-script policy.
- A `bazframe skills run` gateway, process supervision, lifecycle leases, or hot-update coordination.
- Universal `shared/` or `data/` directory semantics.
- Mutable-data migration or destructive-removal behavior.
- Credential storage, brokerage, or authenticated Archidekt mutation.
- Profile export/import or live-versus-locked reference semantics.
- TUI implementation for nested sources.
- Semantic instruction precedence or repository-recommended profile composition.
- Cross-runtime guarantees beyond the explicitly tested Pi version.

## Product decision after the experiments

The user selected the second historical outcome: approve provider-neutral composition semantics through a deliberate update to [`../design.md`](../design.md). The smallest production slice uses profile-local versioned descriptors as direct memberships, derives all children live with approved bounds, projects individual definitions through the existing Pi 0.82.x path, and keeps source lifecycle provider-owned.

This approval is not the third historical outcome. It does not commission or imply Bazframe-owned acquisition, dependency installation, updates, execution, mutable-data or credential management, child subsets, packs, or a global source registry.

## Source material

- [`../design.md`](../design.md) — current product boundary.
- [`skill-first-projects-and-external-harnesses.md`](skill-first-projects-and-external-harnesses.md) — earlier bundle/dependency hypothesis and external-harness framing.
- [`../../experiments/mtg-skill-refactor/REPORT.md`](../../experiments/mtg-skill-refactor/REPORT.md) — bounded MTG harness-refactor evidence.
- `~/foo/research/BAZFRAME_EXECUTIVE_SUMMARY.md` — strategic reconciliation and staged recommendation.
- `~/foo/mtg_test/MTG_SKILL_SUITE_DESIGN.md` — canonical external nested-suite proposal.
- `~/foo/mtg_test/BAZFRAME_SKILL_GROUP_REFACTOR_DESIGN.md` — Bazframe-specific external proposal.
- `~/foo/mtg_test/MAGIC_DECK_BUILDER_REFACTOR_DESIGN.md` — MTG extraction proposal.
