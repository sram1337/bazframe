# Prototype alternatives comparison

> Status: observed behavior and analysis, not a product decision
>
> Scope: the implemented profile-to-Pi flow, not the broader concept draft

## Flow under comparison

```text
bazframe use <profile>
cd <existing Git repository>
bazframe pi
```

The prototype persists one named profile selection, combines that profile's instructions with the repository-root `AGENTS.md`, exposes profile skills additively, and launches Pi without installing profile material into the repository.

Evidence:

- [`../prototype.md`](../prototype.md)
- [`../../README.md`](../../README.md)
- `src/profiles/profile-store.ts`
- `src/harness/compose-instructions.ts`
- `src/agents/pi-args.ts`
- `src/agents/spawn-pi.ts`
- `test/integration/cli.test.ts`

## Observed comparison

Legend: **yes** = built in; **partial** = possible with manual or additional wiring; **no** = outside the tool's observed scope.

| Alternative | Named cross-project selection | Profile + root instructions | Profile skills in Pi | Launch Pi | Default target-repository writes |
|---|---:|---:|---:|---:|---|
| Bazframe prototype | yes | yes, textual/root-only | yes, explicit and additive | yes | none with the recommended home layout |
| Skillbook | no | no | partial, through project projection | no | `.skillbook/` and harness projections |
| Vercel `skills` | no | no | partial, through project/global install | no observed Pi launcher | project writes by default; global mode avoids project writes |
| Git | partial, by choosing a checkout/ref | no runtime composition | partial, stores files only | no | depends on checkout arrangement |
| Git + Pi flags | manual | manual | yes with `--skill` | yes | avoidable |
| Git + skill tool + Pi | no integrated profile selection | manual | yes, with stronger skill lifecycle | separate command | depends on skill-tool scope |
| Git + custom wrapper + Pi | yes if implemented | yes if implemented | yes if implemented | yes | avoidable |

### Skillbook

Observed strengths:

- central Git-backed skill library;
- recursive scanning;
- project copies and lock state;
- synced/ahead/behind/diverged states;
- push, pull, install, uninstall, and conflict resolution;
- copy/symlink projection to Pi and four other harnesses.

Observed gap for this flow: Skillbook manages skill sets, not a named bundle containing profile instructions plus an agent launch transition.

Evidence:

- `~/foo_bazframe/skillbook/README.md`
- `~/foo_bazframe/skillbook/src/commands/scan.ts`
- `~/foo_bazframe/skillbook/src/commands/harness.ts`
- `~/foo_bazframe/skillbook/src/lib/lock-status.ts`

### Vercel `skills`

Observed strengths:

- broad source acquisition;
- project and global installation;
- copy and symlink projection;
- locks, update, remove, list, and search;
- many agent path adapters;
- temporary one-skill use.

Observed gap for this flow: it does not model a switchable profile containing both root instructions and a selected skill set. The local `skills use --agent` implementation launches Claude Code and Codex, not Pi.

Evidence:

- `~/foo_bazframe/skills/README.md`
- `~/foo_bazframe/skills/src/use.ts`
- `~/foo_bazframe/skills/src/installer.ts`

### Git

Git naturally owns profile history, sharing, and version selection. It does not define effective-harness composition, skill discovery paths, active profile selection, or agent launch behavior. Those require conventions or a wrapper.

### Small wrapper

A small shell or Node wrapper can reproduce the prototype's happy path:

1. read a selected profile;
2. find the Git root;
3. concatenate profile and repository instructions into a temporary file;
4. enumerate profile skill directories;
5. invoke Pi with fixed flags;
6. clean up and propagate status.

The current prototype adds tested handling for bounded UTF-8 reads, path containment, Git environment overrides, temporary-file permissions, protocol-safe stdout, argument restrictions, and package behavior. Those controls make it a hardened wrapper, but they do not establish a unique product category.

## Analysis

### What is currently distinct

Neither observed skill tool implements the complete transition:

> Select one named user-level bundle, enter an existing repository, combine its instructions with the repository's instructions, expose its skills without project installation, and launch Pi in one command.

This is Bazframe's narrow current distinction. It is an integrated UX and policy layer, not a novel skill format or runtime primitive.

### What is not distinct

Bazframe does not currently have differentiated skill acquisition, scanning, versioning, update, divergence, or projection behavior. Skillbook and Vercel `skills` are stronger at those jobs. Reimplementing them would add scope without validating the profile-specific value.

The current flow is also reproducible with Git, Pi's existing flags, and a custom wrapper. The prototype proves feasibility and hardening, not demand or durable differentiation.

### Ownership implication

The cleanest observed split is:

- **Git or another profile source** owns authored profile content and history;
- **Agent Skills-compatible tooling** may own skill acquisition and update;
- **the repository** owns project instructions;
- **Pi** owns native runtime resources and project trust;
- **Bazframe** owns active profile selection and effective-harness composition at launch.

This is only a candidate boundary. The product has not decided whether profiles snapshot skills or reference an external library/provider.

## Next falsifiable validation

Before implementing `scan`, `add`, `remove`, or `lift`, compare the prototype with a deliberately small baseline:

- at most 40 lines of shell or 150 lines of dependency-free Node;
- the same two Git-backed profiles;
- Skillbook or Vercel `skills` for skill lifecycle where needed;
- two real repositories, including nested launch directories;
- two simultaneous terminals selecting different profiles;
- one profile transfer and one skill update.

Capture:

- commands and setup steps;
- effective instruction text and Pi argv;
- repository filesystem changes;
- profile-switch behavior across terminals;
- update and transfer errors;
- which safety behavior users notice or value.

Falsification criterion:

> If the baseline reproduces the effective harness and clean-repository behavior with at most one additional user action, and no recurring profile-level invariant is missing, Bazframe should remain a small wrapper rather than expand into an independent skill-management product.

## Current conclusion

The prototype identifies a coherent but narrow job. It does not yet justify owning skill management. The next work should compare this integrated transition against the bounded wrapper baseline, not broaden the command surface.
