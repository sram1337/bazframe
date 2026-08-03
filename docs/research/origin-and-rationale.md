# Bazframe 2 origin and rationale research

> Status: evidence and analysis, not a product decision
>
> Scope: local evidence in `~/baz` and `~/foo_bazframe`, reviewed 2026-08-01

## Executive finding

Bazframe 2 most likely exists because Bazframe v1 proved that safe, deterministic harness materialization is technically possible, but the trial exposed a product mismatch:

- v1 became a project-local harness compiler, package manager, and ownership reconciler;
- much of its skill lifecycle overlaps Agent Skills tooling that already exists;
- codifying a real harness still required substantial human classification and package-authoring work;
- the original unmet pain was broader and more personal: carrying one preferred working environment across projects and agents.

V2 appears to move the primary object from a repository's `Bazfile` and package graph to a user-level **harness profile**: instructions plus selected skills that can be activated, projected into a project, used to launch an agent, and exported as a unit.

This is a strong inference, not recorded rationale. The v2 draft contains no decision history.

## 1. What v1 was trying to build

### Observed

V1 defines Bazframe as a repository authoring and maintenance tool:

- The root `Bazfile` is the primary portable artifact.
- Project instructions compile into files such as `AGENTS.md` and `CLAUDE.md`.
- Facets, skills, tools, and extensions use one exact-version package lifecycle.
- `check` and `build` reconcile managed state conservatively.
- Bazframe writes ordinary repository files, exits, and explicitly does **not** launch an agent.

The approved v1 decisions also explicitly reject a separate profile abstraction for v1:

- no separate agent-definition package;
- no multi-agent profile package;
- no `pack`/`apply` flow;
- portability may require companion prompt and local-facet files rather than being self-contained.

Evidence:

- `~/baz/README.md`
- `~/baz/docs/problem-statement.md`
- `~/baz/docs/decisions.md`, especially “The Bazfile is the primary portable agent artifact”
- `~/baz/docs/development/design.md`, especially sections 1, 2.7, 7, 11, and 12

### Analysis

V1 answered “bring a harness to a repository” by making each repository declare and reconstruct its own desired harness. That is coherent for team-owned, reproducible project configuration, but it is not the same as letting one person select a preferred harness once and carry it between unrelated repositories.

## 2. V1 accumulated substantial machinery before reaching its core UX

### Observed

At the current `~/baz` state:

- the repository has 125 commits;
- the design is 1,308 lines, supported by several hundred more lines of ownership, lifecycle, package-schema, and implementation contracts;
- copy-mode parsing, prompt rendering, package acquisition, canonical storage, ownership, drift detection, and `check`/`build` are implemented;
- the latest recorded gate passed 585 unit, 94 integration, and 63 fault tests;
- `install`, `update`, and `uninstall` are still not wired into the CLI;
- `init` and `remove-all` have not been implemented;
- link mode and release acceptance remain open.

The active M5 work is especially safety-heavy: syntax-preserving Bazfile edits, paired current/proposed state, identity-bound snapshots, archive validation, conservative removal proof, and fault handling.

Evidence:

- `~/baz/TODO.md`
- `~/baz/SCRATCHPAD.md`
- `~/baz/status_executive_summary_2026-07-31.md`
- `~/baz/src/`
- `~/baz/test/`

### Analysis

This is evidence of a strong implementation, but also of unfavorable value timing: users would pay the conceptual cost of a package manager and ownership engine before the onboarding and cross-project experience existed. The engineering center of gravity moved toward filesystem and supply-chain correctness rather than validating the simplest user-visible portability flow.

## 3. The real-harness trial exposed authoring and boundary costs

Two local reports evaluate the extraction of the Loam/MTG harness into Bazframe.

### First assessment: technically differentiated

`~/foo_bazframe/BAZFRAME_CRITICAL_ANALYSIS.md` recommends continuing. It identifies real v1 strengths:

- a useful distinction among project-owned sources, managed outputs, reusable resources, and one-time initial files;
- explicit, reviewable inventory;
- capability decomposition;
- multi-harness materialization;
- deterministic prompt ordering;
- drift and removal evidence.

It also records the costs:

- semantic discovery and capability boundaries remained operator-led;
- prompts still had to be manually synthesized;
- selective staging still used custom shell/script work;
- approximately 1,100 manifest lines described 185 initial files;
- first codification cost more than a purpose-built script or template;
- value appeared mainly on later installs and updates.

### Second assessment: broad scope no longer justified

`~/foo_bazframe/BAZFRAME_ECOSYSTEM_ASSESSMENT.md` reaches a stricter conclusion: pause broad package-manager development and validate a narrow compiler/projector or interoperability layer.

The faithful trial recorded:

- three author-selected facets;
- 1,595 lines of package manifests;
- 300 packaged content files plus three manifests;
- several content categories with different natural owners: Git, Agent Skills, npm, or mutable project state;
- intentional canonical/runtime/project duplication;
- a root prompt copied byte-for-byte into one source;
- generated `AGENTS.md` differing only by Bazframe's 96-byte header;
- no demonstrated prompt decomposition, conflict resolution, agent-specific variation, or facet prompt contribution in that trial.

The trial did demonstrate a successful build and a subsequent no-op build. It did **not** demonstrate reduced extraction effort, an easier transfer than Git plus established tools, or a useful lifecycle for large project-owned initial-file trees.

Supporting artifacts:

- `~/foo_bazframe/copy_mtg_harness/Bazfile`
- `~/foo_bazframe/copy_mtg_harness/prompts/AGENTS.md`
- `~/foo_bazframe/copy_mtg_harness/AGENTS.md`
- `~/foo_bazframe/copy_mtg_harness/facets/*/bazframe-package.yaml`
- `~/foo_bazframe/HARNESS_CODIFICATION_AND_TRANSFER_REPORT.md`

### Analysis

The trial separated two different jobs:

1. **Semantically extract and organize a harness.** This requires human or agent judgment.
2. **Safely reproduce an already-organized harness.** V1 does this well.

V1 invested heavily in the second job while its product story implied help with the first. V2's `scan`, `lift`, profile, and GUI sketches appear aimed at making discovery and organization visible user workflows rather than assuming a finished package already exists.

## 4. Existing skill tools overlap much of v1

### Vercel `skills`

The local checkout at `~/foo_bazframe/skills` already provides a broad Agent Skills lifecycle:

- install from Git, GitHub/GitLab, URLs, local paths, direct `SKILL.md`, and archives;
- project or global scope;
- canonical symlink or copy projection;
- a catalog of 76 advertised agent identifiers;
- list, find, update, remove, and init;
- lock/provenance behavior;
- temporary `skills use`, including launching a supported agent with one generated skill prompt.

Evidence:

- `~/foo_bazframe/skills/README.md`
- `~/foo_bazframe/skills/AGENTS.md`
- `~/foo_bazframe/skills/src/`

### Skillbook

The local Skillbook checkout is even closer to several v2 sketches. It provides:

- a central `~/.skillbook/skills` library;
- committable project-local `.skillbook/skills` copies;
- project and library locks and content hashes;
- recursive project scanning and an interactive project/skill view;
- library-to-project install/pull;
- project-to-library push;
- uninstall;
- synced/ahead/behind/diverged/local-only/library-only states;
- copy or symlink projection to Claude Code, Codex, Cursor, OpenCode, and Pi;
- harness import, status, sync, enable, and disable.

Evidence:

- `~/foo_bazframe/skillbook/README.md`
- `~/foo_bazframe/skillbook/src/commands/scan.ts`
- `~/foo_bazframe/skillbook/src/tui/ScanApp.tsx`
- `~/foo_bazframe/skillbook/src/lib/lock-status.ts`
- `~/foo_bazframe/skillbook/src/lib/lock-operations.ts`

### Analysis

Skill packaging, scanning, central storage, project installation, projection, drift state, update, and removal are not sufficient Bazframe differentiation. Implementing them independently risks rebuilding Skillbook and Vercel `skills` while also maintaining Bazframe's package and ownership model.

The close command parallels are notable:

| V2 sketch | Existing analogue |
|---|---|
| `bazframe scan` | Skillbook `scan` |
| `bazframe add` | Skillbook `install`; Vercel `skills add` |
| `bazframe remove` | Skillbook `uninstall`; Vercel `skills remove` |
| `bazframe lift` | Closest to Skillbook `push`, plus profile membership and project removal |
| GUI showing local/library/modified | Skillbook scan/status model |
| agent launch | Vercel `skills use --agent`, but only for temporary use of selected skills |

## 5. What v2 changes

The current `baz2/docs/design.md` is byte-for-byte identical to the untracked `~/baz/bazframeV2.md`.

| Concern | V1 | V2 draft |
|---|---|---|
| Primary object | Project `Bazfile` | Harness/profile |
| Primary scope | Repository-local | User-level across projects |
| Portability | Referenced config plus companions | Exportable `.harness` archive is proposed |
| Agent operation | Materialize files, then exit | Materialize profile instructions and launch Pi |
| Skills | Exact package declarations in each project | Central local library, profile membership, project add/remove/lift |
| Discovery | Package references are already known | Recursively scan existing projects |
| Visibility | CLI desired-state and drift model | Proposed GUI across projects and ownership states |
| Existing project instructions | Authored prompt sources | Explicit unresolved reconciliation with repository `AGENTS.md` |

V2 therefore reopens several boundaries v1 deliberately closed: profiles, self-contained export, launching agents, user-global state, and cross-project discovery.

## 6. Likely causal chain

The evidence supports this origin hypothesis:

1. The original pain was repeated copying and inconsistent harness behavior across projects and agents.
2. V1 translated that pain into a repository-local compiler and general resource package lifecycle.
3. The implementation proved safe reconciliation but became large before the principal UX existed.
4. The Loam trial showed that package manifests do not perform semantic extraction and can be expensive wrappers around Git-owned content.
5. Agent Skills and existing CLIs made much of the independent skill lifecycle non-distinctive.
6. Skillbook demonstrated that scanning, a central library, project copies, divergence status, and harness projection are already practical.
7. The remaining unclaimed product object was the **whole personal harness**: selected instructions, skills, and agent choice as one reusable profile that meets each repository and produces an effective local harness.
8. V2 was drafted as a reset around that object rather than as the next implementation milestone of v1.

A suggestive local chronology supports this reading, although filesystem modification times are not proof of intent:

- the codification and first critical analysis were written around 13:17 on 2026-07-31;
- the ecosystem assessment was modified around 15:50;
- the local Skillbook README was modified around 16:14;
- `~/baz/bazframeV2.md` was modified around 17:27;
- it was copied into `baz2/docs/design.md` around 17:47.

`~/baz/status_executive_summary_2026-07-31.md` explicitly notes that `bazframeV2.md` is untracked and outside the v1 source of truth.

## 7. The plausible v2 product thesis

The most defensible thesis is:

> Existing tools can own portable skill artifacts and perhaps their library/install lifecycle. Bazframe's distinctive job is to make a complete harness profile first-class, combine it safely with project context, materialize the effective harness for a selected agent, and let the user carry or export that profile.

Under this thesis, a profile is more than a list of skills. It must include enough instruction and agent wiring to change how a session starts and behaves. Otherwise Bazframe is only another skill manager.

Potentially distinctive behavior:

- select one profile once, then use it in many repositories;
- combine profile instructions with repository instructions by an explicit rule;
- project one profile into Pi, Claude Code, or Codex without duplicating authored content;
- launch the selected agent with that effective harness;
- show which effective resources came from the profile, project, or external skill provider;
- export/import the profile with explicit referenced versus bundled semantics.

## 8. Product risks exposed by the research

V2 can repeat v1's scope problem if it simultaneously owns:

- profiles;
- a central skill library;
- scanning and classification;
- skill versioning and conflict resolution;
- project projection;
- instruction compilation;
- agent launch;
- all-project indexing and GUI state;
- archive transport.

The key unresolved boundary is therefore not “how should the skill manager work?” It is:

> Which profile lifecycle requires skill awareness, and which underlying skill operations should be delegated to Agent Skills-compatible tooling?

Other decisions that must precede implementation:

1. Define **library**, **profile**, **project**, and **effective harness** as separate ownership scopes.
2. Decide whether profile skills are references, snapshots, or either.
3. Specify precedence and conflict behavior for profile instructions versus repository `AGENTS.md`/`CLAUDE.md`.
4. Define `lift`: copy or move, source of truth afterward, and behavior for modified/diverged skills.
5. Decide whether `bazframe pi` temporarily injects a harness or writes persistent project files.
6. Decide what an exported `.harness` contains and how secrets, machine paths, and provider metadata are excluded.
7. Preserve Agent Skills directory compatibility rather than introducing another skill artifact format.

## 9. Implication for the next validation

The first validation should test the profile-specific job, not rebuild skill management first. A minimal candidate flow is:

```text
bazframe use <profile>
cd <existing-repository-with-AGENTS.md>
bazframe pi
```

The demonstration should make these observable:

- which profile instructions and skills are active;
- how repository instructions are preserved and combined;
- what files, if any, are written;
- what happens after the launched agent exits;
- whether the same profile can launch a second agent product;
- whether Vercel `skills`, Skillbook, Git, or a small wrapper can provide the skill operations underneath.

Only after this flow is judged valuable should Bazframe decide whether to own `scan`, `add`, `remove`, and `lift` or orchestrate another provider.
