# Pi Adaptive Context Adapter

> Status: accepted first Pi integration boundary, validated by automated and manual Pi 0.82 trials

## Decision

Bazframe applies an active personal profile through a globally discovered Pi extension. Absent global state means enabled in Git and non-Git directories. In Git worktrees, project override takes precedence over global policy; non-Git directories inherit global policy. Users invoke Pi directly in either of two modes:

```bash
pi       # native Pi context followed by the active profile
pi -nc   # global Pi context followed by the active profile
```

`-nc` is Pi's native `--no-context-files` flag. Pi represents its resulting context choice in `systemPromptOptions.contextFiles`.

## Adaptive rule

The extension responds to the structured context collection:

```text
non-empty contextFiles -> append profile
empty contextFiles     -> restore global context, then append profile
```

Pi 0.82 context discovery is all-or-nothing. Plain `pi` reports the available global, ancestor, and repository files. `pi -nc` reports an empty collection. The rule therefore produces one copy of global instructions in both modes.

### Plain `pi`: additive context

Pi builds its native context. Bazframe appends profile instructions:

```text
Pi system prompt
+ global Pi context
+ ancestor/repository context
+ active profile instructions
```

### `pi -nc`: instruction-context replacement

Bazframe restores the trusted global Pi context and appends profile instructions:

```text
Pi system prompt
+ global Pi context restored by Bazframe
+ active profile instructions
```

Ancestor and repository context files stay out of the assembled prompt in this mode. They remain repository content available through the agent's tools.

## Why structured emptiness is sufficient

Pi 0.82 supplies every discovered native context file or an empty collection. The adapter needs only that distinction:

- a populated collection already includes global context;
- an empty collection has no global context, so Bazframe supplies it.

A future selective-context API would require a new explicit runtime signal and compatibility gate.

## Resource ownership

The adapter changes two session inputs:

1. instruction context, according to the adaptive rule;
2. profile skill paths, through `resources_discover`.

Pi continues to own settings, extensions, packages, prompt templates, themes, system-prompt files, tools, models, native skills, and project trust. `/bazframe info` identifies only effective context suppliers, skills, and collisions rather than restating the full ownership model.

## External state

The validated prototype uses:

```text
~/.bazframe/
├── active-profile
├── profiles/
│   └── <profile>/
│       ├── AGENTS.md
│       └── skills/
├── global.json                       # present only when globally disabled
├── projects/                         # absent/empty when projects inherit
│   └── <sha256-canonical-root>.json  # enabled or disabled overrides
└── adapter-cache/
    └── pi/skill-aliases/<profile>/<alias>/SKILL.md
```

Absent `global.json` means globally enabled; its exact schema-v1 disabled form is `{ "schemaVersion": 1, "disabled": true }`. No project state means inherit global policy. Exact schema-v1 project records are legacy inherit records, schema-v2 records disable, and schema-v3 records enable. Project override wins over global policy. Canonical path identity is sufficient for the first local production slice; moves and clones do not inherit overrides.

## Adapter flow

At startup and reload, the extension:

1. attempts to resolve the current canonical Git root when one exists;
2. reads bounded exact global policy in every working directory and optional hashed project state when a Git root exists;
3. resolves an available Git-worktree project override before global policy;
4. leaves Pi native when effective-disabled and otherwise validates the active profile;
5. loads bounded UTF-8 profile instructions;
6. loads profile skills with Pi's public Agent Skills loader;
7. compares profile skill names with Pi's current skill commands;
8. materializes deterministic collision aliases in Bazframe's external cache;
9. contributes skill paths through `resources_discover`;
10. applies the adaptive context rule during `before_agent_start` and reports precedence.

Globally disabled Git worktrees remain native unless an enabled project override exists. A disabled project override wins over global enable. Non-Git directories inherit global enabled or disabled behavior without a project override. Malformed applicable policy state fails visibly.

## Skill collisions

A profile skill keeps its declared name when available. A collision with a previously loaded Pi skill becomes:

```text
<original>-x-bazframe
```

The alias is an Agent Skills-compatible wrapper that directs Pi to the original skill file and base directory. The native skill keeps its command name. A collision on the generated alias produces a visible profile error.

This policy preserves Agent Skills naming rules and gives each loaded skill a deterministic invocation.

## Safety and diagnostics

- Global policy, exceptional project overrides, and generated aliases live under the user's Bazframe home.
- Instruction sources are bounded regular UTF-8 files and reject NUL bytes.
- Canonical Git roots are resolved with inherited repository-selection environment variables cleared.
- Project trust stays with Pi's trust flow.
- `/bazframe info` reports only the effective profile, supplier-labeled context, sorted effective skills, and deterministic collisions when present; `/bazframe reload` awaits Pi reload.
- Validation compares repository snapshots and Git status before and after adapter activity.

## Validation

The executable prototype and report are under [`../experiments/pi-no-launcher-adapter/`](../experiments/pi-no-launcher-adapter/).

The isolated Pi 0.82 suite demonstrated:

- `pi -nc` produces an empty native context list, restores global instructions once, and excludes ancestor/repository context;
- plain `pi` keeps native global, ancestor, and repository context with one copy of global instructions;
- both modes append the active profile;
- the historical prototype's reload command observed active-profile instruction and skill changes; production now exposes reload as `/bazframe reload`;
- profile skills are additive;
- native/profile collisions produce deterministic `-x-bazframe` aliases;
- native project settings, extensions, prompts, themes, and skills follow Pi's trust behavior;
- the historical prototype's registration gate worked as recorded; production now uses project-over-global policy with file-free enabled defaults;
- repository snapshots and Git status stay stable.

## Production gate

[`pi-adapter-production-design.md`](pi-adapter-production-design.md) defines installation, ownership, global/project policy, status, runtime packaging, and acceptance milestones for this behavior.
