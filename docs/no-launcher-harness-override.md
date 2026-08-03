# No-launcher Pi adaptive context adapter

> Status: accepted first Pi integration boundary, validated by automated and manual Pi 0.82 trials. Production installation and CLI UX remain unimplemented. It supports additive or replacement instruction context, not complete repository-harness replacement.

## Focus

Bazframe should let a user maintain personal profiles outside repositories and apply one without a Bazframe launcher or shim. A globally installed extension supports two native Pi invocations:

```bash
cd repoA
bzf2 init
pi       # native context plus active profile
pi -nc   # restored global context plus active profile
```

`-nc` is Pi's native `--no-context-files` flag. It disables automatic `AGENTS.md`/`CLAUDE.md` discovery before Pi assembles its prompt.

## Adaptive rule

The extension uses Pi's structured `systemPromptOptions.contextFiles` collection, not process arguments, path matching, or generated-prompt parsing:

```text
non-empty contextFiles -> append profile only
empty contextFiles     -> restore global context, then append profile
```

Under ordinary Pi 0.82 CLI behavior:

- plain `pi` loads global, ancestor, and repository context, so the extension leaves all context loading to Pi and adds only the active profile;
- `pi -nc` loads no native context, so the extension restores the trusted global Pi context and adds the active profile.

This avoids duplicate global instructions without requiring the adapter to recognize the paths in Pi's context list.

## Effective modes

### Plain `pi`: additive context

```text
Pi baseline and runtime guidance
+ Pi-loaded global/ancestor/repository instructions
+ active Bazframe profile instructions
```

### `pi -nc`: instruction-context replacement

```text
Pi baseline and runtime guidance
+ ~/.pi/agent/AGENTS.md or CLAUDE.md (restored explicitly)
+ active Bazframe profile instructions
```

In replacement mode, repository and ancestor `AGENTS.md`/`CLAUDE.md` files are not loaded. Repository files remain ordinary content that the agent may read through tools when relevant.

## Scope boundary

Both modes:

- preserve Pi's baseline system prompt and tool guidance;
- add active-profile skills through `resources_discover`;
- leave project settings, extensions, prompts, themes, system-prompt files, packages, native skills, models, and tools under Pi's normal behavior;
- leave project trust entirely under user control.

Profile skills are additive. This is not complete harness replacement. The experimental registration mode is named `adaptive-context` to avoid implying broader replacement.

Before adding profile skills, the adapter uses Pi's public command list to identify native skill names. Non-colliding profile skills keep their names. A collision is projected into external Bazframe cache as an Agent Skills-compatible wrapper named `<original>-x-bazframe`; for example, `reviewer-probe-x-bazframe`. The native winner remains unchanged, and diagnostics log the mapping. The adapter fails if the generated alias also collides. The suffix uses single hyphens because Agent Skills names prohibit parentheses and consecutive hyphens.

Project trust is a security-consent boundary, not a harness-selection mechanism. Bazframe must not return an untrusted decision merely to suppress project resources.

## Why structured emptiness is sufficient

The prototype originally considered checking `process.argv` or comparing loaded context paths with `getAgentDir()`. Neither is necessary for choosing whether to restore global context.

Pi 0.82's native `-nc` behavior is all-or-nothing: with the flag, `contextFiles` is empty; without it, ordinary discovery includes every available native context file. Therefore:

- when any native context is present, Bazframe never restores global context;
- when no native context is present, there is nothing to duplicate, and Bazframe may restore the global file.

The extension still uses public `getAgentDir()` to locate the source only when restoration is needed. It follows Pi's filename precedence:

1. `AGENTS.md`;
2. `AGENTS.MD`;
3. `CLAUDE.md`;
4. `CLAUDE.MD`.

A future Pi feature that selectively disables only global or only project context would invalidate the all-or-nothing assumption. That case should require an explicit runtime signal; Bazframe should not fall back to path heuristics.

## External state

The prototype keeps registration and profiles outside repositories:

```text
~/.bazframe/
├── profiles/
│   ├── my-fav-profile/
│   │   ├── instructions.md
│   │   └── skills/
│   │       ├── deck-building -> <skill-library>/deck-building
│   │       └── card-search   -> <skill-library>/card-search
│   └── other-profile/
├── active-profile
├── projects/
│   └── <sha256-of-canonical-repository>.json
└── adapter-cache/
    └── pi/skill-aliases/<profile>/<aliased-skill>/SKILL.md
```

An experimental registration is:

```json
{
  "repository": "/canonical/path/to/repoA",
  "mode": "adaptive-context",
  "profile": "active"
}
```

Canonical paths are sufficient for this local spike but do not settle identity across clones, worktrees, or renames. The plain-text `active-profile` representation is provisional.

## Ownership boundary

- **Skill library:** owns available skill artifacts and lifecycle; managed by Skillbook or another provider.
- **Bazframe:** owns profiles, active-profile selection, external repository registration, explicit global-context restoration, additive profile skill exposure, externally cached collision aliases, and diagnostics.
- **Repository:** owns source and native Pi resources.
- **Pi:** owns native context discovery, its baseline prompt, project trust, settings, extensions, packages, prompts, themes, native skills, tools, and model behavior.

## Adapter flow

A global extension at `~/.pi/agent/extensions/bazframe.ts`:

1. identifies the canonical Git repository;
2. resolves its external registration;
3. resolves the active profile and validates instruction and skill paths;
4. compares profile names with Pi's already loaded native skill commands;
5. materializes `-x-bazframe` wrappers for collisions and returns per-skill paths through `resources_discover`;
6. checks only whether the structured native context collection is empty;
7. conditionally restores global context, then appends profile instructions in `before_agent_start`;
8. logs context mode and skill aliases, exposes `/bzf-explain`, and supports `/bzf-reload`.

Unregistered repositories remain inactive and retain native Pi behavior.

## Safety and diagnostics

- Profile and global instructions are trusted user-controlled instructions.
- Linked profile skills may execute code and retain normal Agent Skills trust implications.
- Broken registrations, profiles, instruction files, or skill roots fail visibly.
- Instruction sources are limited to 1 MiB, regular files, valid UTF-8, and no NUL bytes in the prototype.
- `/bzf-explain` reports additive versus replacement mode, the global-context handling decision, profile sources, additive skills, collision aliases, and Pi's native context list.
- Bazframe does not edit repositories; validation compares content snapshots and Git status.
- `/bzf-reload` is required to switch both profile instructions and skill resources consistently in a running session.

## Non-goals

- Complete replacement of project settings, extensions, prompts, themes, native skills, models, or tools.
- Semantic merging or conflict resolution between profile and repository instructions.
- Skill acquisition, scanning, lifting, updates, dependency management, publishing, or export.
- Hiding `-nc` behind an implicit launcher or shell shim.
- Generalizing the Pi mechanism to Claude Code or Codex before testing their native capabilities.

## Validation

The executable prototype and report are under [`../experiments/pi-no-launcher-adapter/`](../experiments/pi-no-launcher-adapter/).

The isolated Pi 0.82 run proves:

- `pi -nc` yields an empty native context list, excludes ancestor/repository context, and restores global Pi instructions exactly once;
- plain `pi` retains native global/ancestor/repository context and does not duplicate global instructions;
- both modes append active profile instructions;
- active profile instructions and skills switch after `/bzf-reload`;
- a native/profile `reviewer-probe` collision preserves the native name and exposes the profile as `reviewer-probe-x-bazframe`;
- approved native project resources remain active;
- unregistered repositories retain native behavior;
- repository files and Git status remain unchanged.

No Bazframe launcher, shell shim, repository write, generated-prompt parser, context-path comparison, trust manipulation, private Pi import, or Pi source modification is involved.

## Decision and next gate

The adaptive instruction-context behavior is accepted as Bazframe's first no-launcher Pi adapter boundary. Complete harness replacement remains unsupported and must not be implied by product language.

The next gate is production UX: install and remove the global adapter safely, make `bzf2 init` create external registration, expose status/explanation, and clearly distinguish plain `pi` additive mode from `pi -nc` instruction-context replacement without installing a launcher or shim.
