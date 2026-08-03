---
name: harness-codification
description: Audit an agent-enabled repository and classify durable behavior into lean always-loaded instructions, on-demand skills, skill-local resources/scripts, or historical/local state. Use when refactoring a harness for clarity or transfer.
metadata:
  tag: "baz2"
---

# Harness Codification

Classify evidence before moving it:

1. **Always-loaded policy:** repository boundaries, routing, safety, and ownership rules needed for most tasks. Keep this concise in `AGENTS.md`.
2. **On-demand workflow:** repeatable procedures with clear triggers. Put these in a compatible `SKILL.md` with a precise description.
3. **Skill-local support:** long examples, API notes, templates, static inventories, and helper scripts. Keep them under the owning skill and reference them progressively.
4. **State/history:** session narratives, relationship memory, current deck status, generated logs, and dated experiments. Do not promote these wholesale into instructions.

Audit for conflicting authorities, undocumented mutating side effects, stale commands/defaults, missing compatibility requirements, and resources that are loaded globally despite narrow use.

Separate observed behavior, recommended refactor, and product decisions. Validate referenced paths and run the smallest relevant smoke checks after moving guidance.
