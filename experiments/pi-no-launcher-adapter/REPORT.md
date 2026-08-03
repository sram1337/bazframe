# Pi adaptive no-launcher context adapter report

> Result: **supported.** Plain `pi` adds the active profile alongside native context; `pi -nc` restores global context plus the profile while excluding repository and ancestor context. This is not complete repository-harness replacement.

## Question

Can a globally auto-discovered Bazframe extension adapt to Pi's effective context state without a launcher, repository writes, project-trust manipulation, prompt parsing, context-path matching, or Pi source changes?

## Method

The prototype uses documented structured state and extension APIs:

- `before_agent_start` reads only `systemPromptOptions.contextFiles.length`;
- `resources_discover` adds active-profile skill files;
- public `getCommands()` identifies native skill names before extension-provided paths are loaded;
- `/bzf-reload` re-instantiates the extension and re-resolves `active-profile`;
- public `getAgentDir()` locates the global Pi configuration directory when global context must be restored.

The decision rule is deliberately small:

```text
contextFiles non-empty -> Pi owns native context; append profile only
contextFiles empty     -> restore global Pi context; append profile
```

The adapter does not inspect context paths or parse Pi's generated prompt. An empty collection occurs under the tested CLI when the user invokes Pi's native `-nc` / `--no-context-files` flag. The behavior also follows effective structured state rather than depending on the spelling of process arguments.

The adapter resolves external registrations under `BAZFRAME_HOME/projects/`, the existing plain-text `active-profile`, profile instructions, and Agent Skills-compatible profile skill directories. The experimental registration mode is `adaptive-context`.

The installed Pi executable is not patched, forked, deep-imported, or wrapped. The runner copies the extension into an isolated `PI_CODING_AGENT_DIR/extensions/` directory and launches `pi` directly.

## Effective modes

### Plain `pi`: additive context

Pi has already loaded global, ancestor, and repository context files, so the structured collection is non-empty. The extension appends only active-profile instructions:

```text
Pi baseline and runtime guidance
+ Pi-loaded global/ancestor/repository context
+ active Bazframe profile instructions
```

The extension does not read or append the global file in this mode, preventing duplicate global instructions without comparing paths.

### `pi -nc`: instruction-context replacement

Pi's native flag leaves the structured context collection empty. The extension explicitly loads the global Pi context file and then appends profile instructions:

```text
Pi baseline and runtime guidance
+ restored PI_CODING_AGENT_DIR/AGENTS.md or CLAUDE.md
+ active Bazframe profile instructions
```

Repository and ancestor `AGENTS.md`/`CLAUDE.md` files are absent because Pi disabled discovery before prompt assembly. Bazframe performs no subtraction or generated-prompt parsing.

In both modes, profile skills are additive through `resources_discover`.

### Skill collision aliases

Before returning profile skill paths, the extension reads Pi's already loaded `source: "skill"` commands. A non-colliding profile skill keeps its original name. If a native skill already owns that name, Bazframe materializes an Agent Skills-compatible wrapper under external `BAZFRAME_HOME/adapter-cache/pi/skill-aliases/` and exposes it as:

```text
<original-name>-x-bazframe
```

For example, `reviewer-probe` becomes `reviewer-probe-x-bazframe`. The wrapper points the agent to the original profile `SKILL.md` and original base directory, so relative references remain attributable to the source skill. Bazframe logs and reports every alias. It fails rather than silently choosing a different skill if the generated alias also collides.

Parentheses and consecutive hyphens are not used because Agent Skills names permit only lowercase letters, digits, and single hyphen separators.

## Explicit boundaries

The prototype does not suppress or replace:

- project settings;
- project extensions or packages;
- `.pi/SYSTEM.md` or `.pi/APPEND_SYSTEM.md`;
- project prompts or themes;
- native project, package, or user skills;
- model or tool configuration.

Those remain governed by Pi. Project trust remains an independent user security decision and is not used as a Bazframe selection mechanism.

The empty-versus-non-empty rule intentionally does not prove that a particular global path is present. Under ordinary Pi 0.82 CLI behavior, context discovery is all-or-nothing for `-nc`, which is enough to avoid duplication. A future selective context-loading feature would require an explicit runtime signal rather than reintroducing path matching.

## Validation record

Validated on `2026-08-02` with Pi `0.82.0`, Node `v24.14.1`, and Git `2.50.1 (Apple Git-155)`:

```bash
node experiments/pi-no-launcher-adapter/run-spike.mjs
```

A subsequent manual user installation/trial also succeeded and was cleanly uninstalled.

Observed automated assertions:

- registered nested working directory with `pi -nc --approve`:
  - the structured native context collection was empty;
  - global Pi `AGENTS.md` was restored exactly once;
  - repository-root, nested, and ancestor context markers were absent;
  - focused and reviewer profile instructions and skills switched after `/bzf-reload`;
  - a native `reviewer-probe` collision retained its name while the profile skill appeared as `reviewer-probe-x-bazframe`;
  - diagnostics logged the original-to-alias mapping;
  - approved native project extension, prompt, and skill remained active;
- the same registered directory with plain `pi --approve`:
  - native global, ancestor, repository-root, and nested context remained present;
  - global context appeared exactly once;
  - the extension appended active-profile instructions without restoring global context;
  - the colliding profile skill retained its `-x-bazframe` alias;
  - diagnostics reported additive mode and listed native context;
- unregistered repository under ordinary Pi startup:
  - global and repository context retained native behavior;
  - native project prompt and skill remained active;
  - no Bazframe profile content leaked;
- every tested repository content snapshot and Git status remained unchanged.

## Conclusion

One global extension can support two explicit user-selected behaviors without a launcher or shim:

```bash
pi       # additive native context + profile
pi -nc   # restored global context + profile; repository context excluded
```

This adaptive instruction-context behavior is accepted as Bazframe's first native Pi adapter boundary. Complete harness replacement remains unsupported and must not be implied. The next work is safe adapter installation/removal and external `bzf2 init`/status UX.
