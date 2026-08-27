---
name: bazify
description: Turns one Agent Skill or a Skill collection into a provider-owned Bazframe-compatible package, validates it, and optionally publishes a new package to a private GitHub repository. Use when the user asks to bazify local Skills.
compatibility: Requires Bazframe and Node.js 22.19 or newer. Private GitHub publication additionally requires Git and an authenticated GitHub CLI.
---

# Bazify

Bazify selected Skills into a package with provider source under `skills/`, a reproducible `dist/skills/` artifact, and a Bazframe package manifest.

Resolve `<bazify-skill-root>` from the directory containing this loaded `SKILL.md` and invoke its bundled script by absolute path. Use `./bazframe/`, relative to the current working directory, for review notes and task tracking. Follow an existing local todo convention there when available; otherwise keep one temporary checklist and remove it when the work is complete.

## Workflow

1. Inspect every selected `SKILL.md` and supporting file. Identify runtime tools, packages, services, environment variables, setup, credentials, provenance, licenses, notices, private data, and publication rights.
2. Choose the package boundary:
   - Extract Skills that live inside a broader project into a new package with `create`.
   - Add the package manifest and build to a repository already dedicated to the selected Skill or collection with `adapt`.
3. Use positive source-derived naming. A singleton uses its Skill name; a collection uses its source-root name; several explicit roots use a concise `--name`. New packages default to `~/<package-name>`.
4. Preview the selected operation with `--dry-run`, then run it. A typical extraction is:

   ```bash
   node <bazify-skill-root>/scripts/bazify.mjs create /absolute/path/to/source --dry-run
   node <bazify-skill-root>/scripts/bazify.mjs create /absolute/path/to/source
   ```

   A typical repository adaptation is:

   ```bash
   node <bazify-skill-root>/scripts/bazify.mjs adapt /absolute/path/to/skill-repository --dry-run
   node <bazify-skill-root>/scripts/bazify.mjs adapt /absolute/path/to/skill-repository
   ```

   Use `--help` for multiple explicit Skill roots, custom names, and custom destinations.
5. Resolve the semantic-review checklist in `./bazframe/`. Record useful final requirements, setup, provenance, and rights in provider documentation.
6. Validate after package creation, adaptation, or source edits:

   ```bash
   node <bazify-skill-root>/scripts/bazify.mjs validate /absolute/path/to/package
   ```

   Validation builds through Bazframe using disposable state and leaves the user's catalog and profiles unchanged.
7. When a newly extracted package needs a repository, preview its private GitHub target, confirm the displayed account, repository, package path, digest, rights, and privacy review, then publish with the exact approval token:

   ```bash
   node <bazify-skill-root>/scripts/bazify.mjs publish /absolute/path/to/package --dry-run
   node <bazify-skill-root>/scripts/bazify.mjs publish /absolute/path/to/package \
     --yes \
     --approval '<preview-token>'
   ```

   An adapted repository continues through its established Git workflow.

## Safety

- `create` copies physical Skill files into a new destination and preserves the source.
- When Git is present, `adapt` requires the selected directory to be its clean top-level. Non-Git directories are also supported. It preserves provider files and Git state and rolls back when ownership can be proven.
- Generated builds use stable physical-file reads and transactional artifact replacement.
- Obvious credential filenames and private-key material are rejected; semantic and privacy review remains required.
- GitHub publication is private, consent-bound, and byte-bound.
- Report the package path, Skill names, validation result, and publication result.
