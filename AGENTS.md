# Agent Instructions

**Name: Bazframe 2**

Bazframe 2 explores portable, first-class coding-agent harnesses that combine profiles and skill management.

## Session startup

Ask: **"Play mode or dev mode?"**

- **Play mode** → Read `PLAY.md`, then `docs/design.md`.
- **Dev mode** → Read `TODO.md`, `SCRATCHPAD.md`, and `DEV.md`, then the relevant design sections.

## Rules

- Treat `docs/design.md` as the current product source of truth.
- Treat the relationship between profiles and skill management as an open product-design question unless the design records a decision.
- Do not inherit Bazframe v1 scope merely because an implementation already exists.
- Preserve Agent Skills compatibility when designing skill behavior.
- Separate observed ecosystem behavior, analysis, and product decisions.
- Keep changes small and keep `TODO.md` current during development.
- Do not commit or push unless the user explicitly asks.
