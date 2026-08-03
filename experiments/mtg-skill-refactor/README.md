# MTG Skill-Refactor Experiment

This experiment tests Bazframe 2's narrow profile/session composition model against a real, skill-heavy repository.

## Copy provenance

- Source: local `magic_deck_building` repository (path intentionally not part of the portable contract)
- Source commit: `55ebbf4104cc0ca80e7e907b503ca4c803107785`
- Destination: `project/` (independent local clone)
- The source worktree is not modified.

The destination deliberately removes copied local/generated state: root scratch history, session logs, live deck folders, Forge diagnostics, and a generated media file. Credentials, caches, browser state, dependencies, and ignored account state were never copied by Git.

## Refactor hypothesis

A portable profile should own cross-project behavior and optional profile skills. The repository should own project routing, local-data boundaries, domain workflows, and subsystem skills. Long operational detail belongs beside its owning skill rather than in always-loaded root instructions.

This is an experiment assumption, not a Bazframe product decision.

## Layout

- `project/` — sanitized MTG project copy and refactor
- `bazframe-home/profiles/loam/` — portable Loam profile plus one profile-owned harness-audit skill

## Validation

From the Bazframe repository root:

```bash
npm run build
BAZFRAME_HOME="$PWD/experiments/mtg-skill-refactor/bazframe-home" node dist/cli.js use loam
cd experiments/mtg-skill-refactor/project
BAZFRAME_HOME="$(cd ../bazframe-home && pwd)" node ../../../dist/cli.js pi --dry-run
```

A real Pi smoke should verify that:

1. profile instructions and repository `AGENTS.md` are both present;
2. the profile-owned `harness-codification` skill is exposed;
3. repository-native skills remain discoverable additively;
4. no local/generated files appear and no commit is created.

See `REPORT.md` for implemented boundaries and validation results.
