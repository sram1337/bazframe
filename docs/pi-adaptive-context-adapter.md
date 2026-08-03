# Pi Adaptive Context Adapter

> Status: accepted first Pi integration boundary, validated by automated and manual Pi 0.82 trials

## Decision

Bazframe applies an active personal profile to registered Git worktrees through a globally discovered Pi extension. Users invoke Pi directly in either of two modes:

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

Pi continues to own settings, extensions, packages, prompt templates, themes, system-prompt files, tools, models, native skills, and project trust. This ownership split is part of `/bzf-explain` diagnostics.

## External state

The validated prototype uses:

```text
~/.bazframe/
├── active-profile
├── profiles/
│   └── <profile>/
│       ├── AGENTS.md
│       └── skills/
├── projects/
│   └── <sha256-canonical-root>.json
└── adapter-cache/
    └── pi/skill-aliases/<profile>/<alias>/SKILL.md
```

A registration records the canonical worktree root, `adaptive-context` mode, and the global active-profile selector:

```json
{
  "schemaVersion": 1,
  "repository": "/canonical/path/to/repo",
  "mode": "adaptive-context",
  "profile": "active"
}
```

Canonical path identity is sufficient for the first local production slice. Repository moves and clones receive their own registrations.

## Adapter flow

At startup and reload, the extension:

1. resolves the current canonical Git root;
2. hashes that root to find its external registration;
3. validates the registration and active profile;
4. loads bounded UTF-8 profile instructions;
5. loads profile skills with Pi's public Agent Skills loader;
6. compares profile skill names with Pi's current skill commands;
7. materializes deterministic collision aliases in Bazframe's external cache;
8. contributes skill paths through `resources_discover`;
9. applies the adaptive context rule during `before_agent_start`;
10. reports mode and alias decisions once per load.

A repository with a matching registration activates the adapter. Other working directories use their native Pi behavior.

## Skill collisions

A profile skill keeps its declared name when available. A collision with a previously loaded Pi skill becomes:

```text
<original>-x-bazframe
```

The alias is an Agent Skills-compatible wrapper that directs Pi to the original skill file and base directory. The native skill keeps its command name. A collision on the generated alias produces a visible profile error.

This policy preserves Agent Skills naming rules and gives each loaded skill a deterministic invocation.

## Safety and diagnostics

- Registrations and generated aliases live under the user's Bazframe home.
- Instruction sources are bounded regular UTF-8 files and reject NUL bytes.
- Canonical Git roots are resolved with inherited repository-selection environment variables cleared.
- Project trust stays with Pi's trust flow.
- `/bzf-explain` reports context mode, context sources, profile sources, skills, aliases, registration, and repository paths.
- Validation compares repository snapshots and Git status before and after adapter activity.

## Validation

The executable prototype and report are under [`../experiments/pi-no-launcher-adapter/`](../experiments/pi-no-launcher-adapter/).

The isolated Pi 0.82 suite demonstrated:

- `pi -nc` produces an empty native context list, restores global instructions once, and excludes ancestor/repository context;
- plain `pi` keeps native global, ancestor, and repository context with one copy of global instructions;
- both modes append the active profile;
- `/bzf-reload` observes active-profile instruction and skill changes;
- profile skills are additive;
- native/profile collisions produce deterministic `-x-bazframe` aliases;
- native project settings, extensions, prompts, themes, and skills follow Pi's trust behavior;
- registration gates activation by canonical worktree root;
- repository snapshots and Git status stay stable.

## Production gate

[`pi-adapter-production-design.md`](pi-adapter-production-design.md) defines installation, ownership, registration, status, runtime packaging, and acceptance milestones for this behavior.
