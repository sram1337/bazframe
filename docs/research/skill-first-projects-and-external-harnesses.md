# Skill-first projects and external harnesses

> Status: problem framing, analysis, and candidate experiments—not a product decision.
>
> This note records two connected challenges raised after the MTG skill-refactor experiment: finding a repeatable way to extract transferable skill systems from projects, and defining Bazframe as an external harness/profile composer without necessarily making it a skill manager.

## Working vision

A coding harness can become the user's IDE-like interface to a project: personal, consistent across repositories, configurable per project, and normally stored outside project code. A repository may still publish a recommended `AGENTS.md` and skills, just as it may publish editor settings, but the user can bring a different harness.

The proposed lifecycle is:

1. Refactor useful project behavior into portable skills and supporting artifacts.
2. Lift transferable artifacts into a live local skill library using Skillbook or another skill-lifecycle tool.
3. Define Bazframe profiles as lean instructions plus references to selected library skills or skill bundles.
4. Associate a profile and optional user-owned overlay with a project without copying the harness into that repository.
5. Let Bazframe compose the effective harness and launch the chosen agent.

This depends on solving portability and shared-dependency problems well enough that a lifted skill system still works outside its source repository.

## Challenge 1: a generalized skill-first refactoring pattern

### Goal

Find a repeatable method for turning a project with scattered local procedures, scripts, knowledge, and state into a **nearly entirely skill-driven harness** with:

- lean always-loaded instructions;
- explicit, on-demand workflows;
- transferable resources and executable support;
- declared rather than accidental dependencies;
- no copied credentials, generated state, or historical session noise;
- a useful unit that can be lifted and reused in another project.

"Nearly" matters. Project source code, safety/ownership rules, secrets, live account state, and current task state should not be forced into skills. The desired outcome is not literally "everything is a skill"; it is that reusable agent behavior is skill-addressable and the irreducible project residue is small and explicit.

### The unresolved portability unit

A `SKILL.md` is a good **activation unit**: it describes when and how an agent should perform one workflow. It is not necessarily the right **installation or transfer unit**.

The MTG experiment already contains non-singleton groups of skills that share:

- domain knowledge under `mtg/knowledge/`;
- common scripts and npm dependencies;
- canonical deck-workspace and mutation rules;
- Forge runtime/build assumptions;
- external service credentials and local state contracts.

Treating every skill as independently transferable would either break those references or duplicate shared material. A likely model is therefore:

> **Skill = activation unit. Bundle/package = dependency, installation, and transfer unit.**

This is a hypothesis to test, not yet a chosen format.

### Dependency taxonomy

A generalized refactor should identify at least five kinds of dependency:

1. **Skill dependency** — one workflow delegates to or requires another workflow, such as deck building invoking primer maintenance.
2. **Resource dependency** — multiple skills consume the same knowledge, schema, template, API note, or workspace contract.
3. **Executable dependency** — skills invoke shared scripts, Node packages, Python packages, Java classes, binaries, or services.
4. **Capability dependency** — the environment must provide credentials, network access, a browser, Forge, Git, or a compatible harness feature.
5. **Project/state dependency** — the workflow expects repository files, user configuration, live account state, or generated data that should not travel with the skill.

Agent Skills currently provides a portable skill shape, but not a standard dependency manifest, package resolver, capability negotiation protocol, or cross-skill name/version conflict policy. A repeatable solution must preserve Agent Skills compatibility while adding any dependency metadata outside or alongside `SKILL.md`.

### Candidate ownership rules for shared resources

Use the narrowest stable owner:

- A resource specific to one workflow stays under that skill's `resources/` or `scripts/`.
- A canonical contract owned by one skill may be referenced by sibling skills when they are distributed as one bundle.
- Peer-neutral domain knowledge used by many skills belongs in a bundle-level shared resource directory, not arbitrarily under one skill.
- Shared executable code belongs in a package-level scripts/library directory with ordinary runtime dependency metadata.
- Secrets, account state, current project state, caches, and logs remain external inputs and are never packaged as resources.

Duplication should be reserved for tiny stable interfaces where independent skill portability is more valuable than a shared source. Generated copies require an explicit generation/update mechanism; manual copy-paste is not a dependency strategy.

### Can npm and Node provide the dependency layer?

Potentially, but only for part of the problem.

npm already provides:

- package identity and versions;
- transitive runtime dependency resolution;
- lockfiles and integrity metadata;
- distribution of Markdown, templates, scripts, and other package files;
- workspaces and local/live package development;
- lifecycle integration for Node-based tooling.

A candidate skill bundle could remain Agent Skills-compatible while using npm as its distribution envelope:

```text
mtg-skill-bundle/
├── package.json
├── skills/
│   ├── deck-building/SKILL.md
│   ├── deck-analysis/SKILL.md
│   └── archidekt/SKILL.md
├── shared/
│   ├── knowledge/
│   └── deck-workspace.md
└── scripts/
```

The npm tarball can include `skills/`, `shared/`, and `scripts/`; normal `dependencies` can provide executable libraries. A Pi package can expose the skill roots from its `package.json`. Related skills and shared resources then move together.

npm does **not** by itself solve:

- when one skill should activate another;
- how Markdown resolves a dependency by logical skill/resource identity rather than a relative path;
- whether two skills with the same name or incompatible shared-resource versions can coexist;
- non-Node dependencies and environment capabilities;
- project-specific configuration and account state;
- cross-harness skill discovery and projection;
- whether profiles reference live versions or reproducible snapshots.

Pi package installs also use separate module roots: independent Pi packages do not automatically share modules, and resources from another Pi package must currently be bundled and exposed explicitly. npm can therefore be a useful package substrate, but it is not a complete semantic skill-dependency system.

### Candidate compatible metadata

One experiment should test optional bundle-level metadata without changing the required Agent Skills files. For example, a package manifest could describe:

- stable skill IDs and paths;
- required sibling skills;
- shared resource roots;
- runtime packages and external capabilities;
- expected project inputs;
- configuration schema;
- compatibility with supported harnesses.

The metadata should be provider-neutral if Skillbook or another tool owns library management. Bazframe should not invent a private skill format merely to resolve profile membership.

### Repeatable refactoring procedure to test

1. **Inventory** all instructions, scripts, knowledge, state, hooks, and recurring procedures.
2. **Classify** each item as always-loaded policy, on-demand workflow, shared resource, executable support, project input, local state, or history.
3. **Build a dependency graph** across skills, resources, executables, capabilities, and project inputs.
4. **Find cohesive clusters**. Strongly connected or commonly versioned skills are candidates for one bundle rather than independent installation.
5. **Assign canonical ownership** and remove duplicate authorities.
6. **Parameterize project assumptions** such as paths, service endpoints, workspace names, and runtime locations.
7. **Declare compatibility and missing-state behavior**. A transferable skill must fail or bootstrap explicitly rather than inventing local state.
8. **Test extraction** from a clean directory containing only the candidate bundle and declared inputs.
9. **Lift to an external library** and consume it from a second project without copying source-project state.
10. **Update one shared dependency** and verify that all consuming skills see a coherent version without manual edits.

### Portability levels

A useful audit may classify results rather than pretending every skill is equally portable:

- **P0 — project-bound:** depends directly on source-repository structure or state.
- **P1 — repository bundle:** reusable within the source repository because sibling skills/resources travel together.
- **P2 — cross-project bundle:** works in another repository after explicit configuration and capability checks.
- **P3 — cross-harness bundle:** works across supported agents through standard files plus runtime adapters, without repository installation.

The refactor is successful when the desired subset reaches P2 or P3; it need not force every project-specific workflow beyond P0/P1.

### MTG as the proving case

The current MTG refactor proves that large root guidance can be decomposed, but it does not prove independent skill transfer. Candidate clusters to analyze include:

- core deck research/build/analysis plus shared MTG knowledge and verification scripts;
- Archidekt as an optional remote-storage adapter with mutation safety and credentials;
- primer maintenance as derived-data behavior shared by build and analysis;
- Forge simulation as a capability-heavy bundle with Java and local runtime requirements;
- Moltbook/social behavior, separating reusable conversation method from identity and live relationship state;
- generic harness maintenance and codification skills that may already be cross-project.

The dependency graph, not the current directory layout, should determine the actual bundle boundaries.

## Challenge 2: define Bazframe without owning skill lifecycle

### Candidate product boundary

Skillbook or another library tool can own:

- acquisition and scanning;
- lifting/copying into a live library;
- versioning, updates, and divergence;
- publication and synchronization;
- installation/removal of skill artifacts.

Bazframe can instead own:

- profiles as named harness configurations;
- references from profiles to live library skills/bundles;
- lean profile instructions;
- per-user, per-project harness overlays stored outside repositories;
- composition with optional repository-provided instructions and skills;
- conflict/dependency/capability preflight;
- agent-specific runtime adaptation and launch;
- explanation of the effective harness.

Adding a library skill reference to a profile is **profile composition**, not necessarily skill management. Bazframe need not know how that skill was acquired or updated.

### Candidate data organization

```text
<skill-library>/                 # managed by Skillbook or another provider
└── <skill-or-bundle-id>/...

BAZFRAME_HOME/
├── config                       # configured library/provider locations
├── profiles/
│   └── loam/
│       ├── instructions.md
│       └── profile manifest     # references library skill/bundle IDs
└── projects/
    └── <stable-project-id>/
        ├── selected profile
        ├── user-owned instructions/overrides
        └── project-specific skill configuration
```

At launch, Bazframe would resolve references against the live library, combine profile and user-owned project configuration with any accepted repository harness material, and expose the result through the chosen agent's supported mechanisms. Temporary runtime projections may be necessary, but the target repository should not be modified by default.

This layout is illustrative. Stable project identity, profile format, reference format, and lock behavior remain open.

### Harness as an external IDE configuration

The analogy suggests several UX requirements:

- A user can carry one profile across many repositories.
- The same repository can be opened with different profiles without rewriting project files.
- Personal per-project customization lives outside the repository.
- Repository-recommended harness material is visible and optionally composable, not silently authoritative or silently ignored.
- The user can inspect exactly which instructions, skills, resources, and adapters are effective.
- Updates in the live skill library can flow into profiles without recopying, subject to an explicit live-versus-locked policy.
- Agent switching should preserve the logical profile even if each runtime needs different projection mechanics.

Possible commands should be derived from those user actions, not inherited from the original v2 sketch. In particular, `scan`, `lift`, acquisition, and updates may belong to Skillbook, while Bazframe may need profile membership, project association, `explain`, `doctor`, and launch operations.

### Composition questions

An external harness cannot simply assume that personal configuration always overrides repository guidance. Open questions include:

- whether repository instructions are ignored, merged, appended, or selected per project;
- whether repository skills remain enabled alongside profile skills;
- how skill name/version conflicts are surfaced;
- whether safety and ownership rules can be overridden;
- how a profile declares required bundles and optional adapters;
- whether profiles reference mutable library heads, locked versions, or both;
- how simultaneous terminals choose profiles without a single global-state race;
- how the same logical profile maps to Pi, Claude Code, Codex, and other harnesses;
- how project identity survives worktrees, clones, renames, and remote changes.

Bazframe's value would be the coherent composition and launch experience around these questions, not duplication of the underlying library's artifact lifecycle.

## Combined hypothesis

If skill extraction yields coherent transferable bundles, then Bazframe can remain a composition layer:

```text
project behavior
  → refactor into Agent Skills-compatible bundles
  → library tool acquires/updates those bundles
  → Bazframe profile references selected bundles
  → Bazframe adds external per-project configuration
  → runtime adapter launches the agent without repository installation
```

This would distinguish three concepts clearly:

- **Library:** what skill artifacts exist and which versions are available.
- **Profile:** which behavior the user wants to carry.
- **Effective harness:** the profile resolved for one project, one agent runtime, and one launch.

## Next falsifiable experiment

Use the MTG repository to test the full transfer loop:

1. Produce a machine-readable dependency inventory for all current skills.
2. Select a non-singleton cluster with shared resources and scripts.
3. Package it as an Agent Skills-compatible bundle, using npm only where it materially helps.
4. Move or copy the bundle into an external live library managed independently of Bazframe.
5. Replace profile-owned skill copies with library references.
6. Configure a profile and an external project overlay without changing the destination repository.
7. Launch the bundle in the MTG copy and a second clean repository.
8. Update one shared resource and one executable dependency in the library; observe propagation, conflicts, and rollback needs.
9. Compare live references with a locked/snapshotted profile.
10. Record every manual path fix, hidden dependency, repository write, collision, and harness-specific projection.

Success criteria:

- the selected cluster works in both projects from declared inputs;
- no source-project secrets, state, logs, or unrelated files travel with it;
- shared resources have one authoritative version;
- missing capabilities fail with actionable diagnostics;
- profile switching requires no repository edits;
- library updates require no manual recopying;
- Bazframe does not need to implement acquisition/update logic to compose and launch the result.

Falsification criteria:

- useful skills cannot be separated from project state without excessive abstraction;
- cross-skill dependencies require enough custom semantics that Agent Skills compatibility becomes nominal;
- npm/package bundling creates more complexity than repository-local ownership;
- runtime projection still requires persistent project writes;
- Skillbook plus a small launch wrapper provides the same user experience with no meaningful missing invariant.

## Current position

The MTG experiment supports the direction but has not solved it. It shows that procedures can move out of root instructions and that Bazframe can add a profile without modifying the repository. It also exposes the key unresolved fact: many useful skills are not singleton artifacts. The next experiment should treat dependency-aware bundles and external profile references as the central subject, while keeping Bazframe skill-lifecycle ownership explicitly undecided.
