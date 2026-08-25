# Pi Adaptive Context Adapter

> Status: accepted first Pi integration boundary; Pi 0.82.0 is the minimum and initial validated baseline

## Decision

Bazframe applies an active personal profile through a globally discovered Pi extension. Absent global state means enabled in Git and non-Git directories. In Git worktrees, project override takes precedence over global policy; non-Git directories inherit global policy. Users invoke Pi directly in either of two modes:

```bash
pi       # native Pi context followed by the active profile
pi -nc   # global Pi context followed by the active profile
```

`-nc` is Pi's native `--no-context-files` flag. Pi represents its resulting context choice in `systemPromptOptions.contextFiles`. Bazframe supports Pi 0.82.0 or newer; the recorded executable evidence begins with the Pi 0.82 baseline.

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

### Exact composition and semantic boundary

Bazframe treats every instruction body as opaque. It does not parse, classify, merge, rank, reject, rewrite, diagnose, or resolve contradictory prose. Included layers remain included, and their deterministic position is a transport/provenance contract rather than a semantic winner or promise that later prose takes precedence. Repository omission under `pi -nc` is the effect of the user's Pi invocation, not Bazframe conflict resolution.

For a non-empty `contextFiles` list, the exact return is the incoming `event.systemPrompt`, `\n\n`, then:

```text
<bazframe_profile_instructions path="ESCAPED_PROFILE_PATH">
PROFILE_BODY_UNCHANGED
</bazframe_profile_instructions>
```

For an empty list, Bazframe returns the incoming prompt, `\n\n`, the restored-global section when a supported global file exists, `\n\n` between sections, then the profile section:

```text
<bazframe_global_instructions path="ESCAPED_GLOBAL_PATH">
GLOBAL_BODY_UNCHANGED
</bazframe_global_instructions>

<bazframe_profile_instructions path="ESCAPED_PROFILE_PATH">
PROFILE_BODY_UNCHANGED
</bazframe_profile_instructions>
```

The section constructor places one LF after the opening tag and one LF before the closing tag; instruction bodies otherwise retain their loaded bytes, including their own trailing LF. Path attributes replace `&`, `"`, `<`, and `>` with `&amp;`, `&quot;`, `&lt;`, and `&gt;` respectively. Bodies are not escaped, so these provenance markers are XML-like transport delimiters rather than a claim that arbitrary instruction text is XML.

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
10. applies the adaptive context rule during `before_agent_start` and reports the selected composition mode without claiming semantic precedence.

Globally disabled Git worktrees remain native unless an enabled project override exists. A disabled project override wins over global enable. Non-Git directories inherit global enabled or disabled behavior without a project override. Malformed applicable policy state fails visibly.

## Skill collisions

Profile duplicates are handled before this runtime boundary and never receive aliases. Duplicate directly added Skill names invalidate the complete profile. Prospective library add/update, package add/build, and whole-object profile reference changes reject duplicate activation. If malformed external state later creates a direct-Skill/object collision, the direct Skill remains effective and the complete conflicting library or package is withheld. Library/package collisions withhold every involved object; unrelated valid Skills and objects remain effective.

At runtime, any pre-existing Pi command with `source === "skill"` occupies its `skill:<name>` command; the adapter does not infer more specific ownership. A profile skill keeps its original name when free. When occupied, the pre-existing Pi skill command keeps the name and Bazframe attempts exactly one deterministic alias. The ordinary spelling is:

```text
<original>-x-bazframe
```

The full alias is capped at 64 characters. Bazframe truncates the original base as needed to leave room for the suffix and strips trailing hyphens from that truncated base before appending `-x-bazframe`. The Agent Skills-compatible wrapper preserves description and `disable-model-invocation`, directs Pi to the original skill file and base directory, and exists only in the Pi adapter cache.

Bazframe uses that alias only when it is absent from pre-existing Pi skill commands, all profile skills' original names, and aliases already generated in the projection. Occupation is a visible projection error with no fallback suffix, silent overwrite, or replacement. Successful aliases do not rename or mutate the stored profile skill.

No semantic or dependency compatibility is inferred from skill prose, metadata, layout, or co-packaging. A future adapter must define and test its own ordering/provenance, loader, command namespace, duplicate, and collision behavior. It may expose both definitions under adapter-specific deterministic reported names or fail visibly, but it may not silently drop or overwrite a definition, mutate profile identity, or persist a runtime alias into the portable profile.

## Safety and diagnostics

- Global policy, exceptional project overrides, and generated aliases live under the user's Bazframe home.
- Instruction sources are bounded regular UTF-8 files and reject NUL bytes.
- Canonical Git roots are resolved with inherited repository-selection environment variables cleared.
- Project trust stays with Pi's trust flow.
- `/bazframe info` reports the effective profile, supplier-labeled context, sorted effective skills, and live `original -> alias` mappings only for alias commands present in Pi's current command set; `/bazframe reload` awaits Pi reload.
- Static `bazframe status` cannot inspect Pi's live command namespace and reports only a physical cached Pi alias count; cached files may be stale or inert.
- Validation compares repository snapshots and Git status before and after adapter activity.

## Validation

The executable prototype and report are under [`../experiments/pi-no-launcher-adapter/`](../experiments/pi-no-launcher-adapter/).

The isolated Pi 0.82 suite demonstrated:

- `pi -nc` produces an empty native context list, restores global instructions once, and excludes ancestor/repository context;
- plain `pi` keeps native global, ancestor, and repository context with one copy of global instructions;
- both modes append the active profile;
- the historical prototype's reload command observed active-profile instruction and skill changes; production now exposes reload as `/bazframe reload`;
- profile skills are additive;
- pre-existing Pi skill-command/profile collisions produce deterministic `-x-bazframe` aliases when the generated alias is free;
- native project settings, extensions, prompts, themes, and skills follow Pi's trust behavior;
- the historical prototype's registration gate worked as recorded; production now uses project-over-global policy with file-free enabled defaults;
- repository snapshots and Git status stay stable.

## Production gate

[`pi-adapter-production-design.md`](pi-adapter-production-design.md) defines installation, ownership, global/project policy, status, runtime packaging, and acceptance milestones for this behavior.
