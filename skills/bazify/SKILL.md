---
name: bazify
description: Clones one local Agent Skill into a deterministic provider-owned Bazframe-compatible package, validates it, and optionally publishes it as a private GitHub repository. Use when converting or packaging an existing Skill for optional Bazframe use.
compatibility: Requires Bazframe 2 and Node.js 22.19 or newer. Private GitHub publication additionally requires Git and an authenticated GitHub CLI.
---

# Bazify

Convert one local Skill into one provider-owned, Bazframe-compatible package. The bundled script owns mechanical filesystem, build, validation, Git, and GitHub operations; use agent judgment for package naming and semantic review.

Resolve `<bazify-skill-root>` from the directory containing this loaded `SKILL.md`. Always invoke that absolute bundled script path; never assume the current project contains `scripts/bazify.mjs`.

Treat `./bazframe/`, relative to the current working directory, as Bazframe's working area. Keep agent-owned inventories, review notes, and temporary task files there. First inspect its applicable instructions and existing local todo/task-tracking convention and use that convention when present. If none exists, use one lightweight temporary checklist under `./bazframe/` and delete it after every item is resolved.

## Workflow

1. Read the complete source `SKILL.md` and inspect its scripts, references, manifests, setup instructions, external services, credentials expectations, and license or notice files.
2. Choose a safe package name. Default to the source Skill name unchanged. Never append `-bazframe`. Use a different concise name only when the default destination is occupied or the user requests one.
3. Preview or create the package:

   ```bash
   node <bazify-skill-root>/scripts/bazify.mjs create /absolute/path/to/skill --dry-run
   node <bazify-skill-root>/scripts/bazify.mjs create /absolute/path/to/skill
   ```

   The destination defaults to `~/<package-name>`; reserve `./bazframe/` for working files. For an override, the destination basename must equal the package name and use a separate location:

   ```bash
   node <bazify-skill-root>/scripts/bazify.mjs create /absolute/path/to/skill \
     --name package-name \
     --destination /absolute/parent/package-name
   ```

4. Track and resolve the semantic review in Bazframe's working area:
   - required runtimes, tools, packages, services, data, and environment variables;
   - one-time installation and setup;
   - source provenance without local paths or credentials;
   - preserved or applicable license status, without inventing or replacing terms;
   - secrets, private data, redistribution rights, and publication scope.

   Use the existing todo system discovered under `./bazframe/`, or the temporary checklist described above. Keep unresolved work in that system and record resolved user-facing facts in the package documentation where useful.
5. Review the generated inventory for secrets and confirm the user has the right to copy and publish the Skill. The script rejects several obvious credential forms, but that scan is not proof of safety. Resolve every tracked review item and clean up any temporary checklist before publication.
6. Validate after every package edit:

   ```bash
   node <bazify-skill-root>/scripts/bazify.mjs validate /absolute/path/to/package
   ```

   Validation runs the package's literal build through Bazframe using a disposable `BAZFRAME_HOME`; it never registers the package in the user's real catalog or profile.
7. Preview the exact private GitHub target:

   ```bash
   node <bazify-skill-root>/scripts/bazify.mjs publish /absolute/path/to/package --dry-run
   ```

8. Save the preview's `approval` token. Ask the user to confirm the displayed host, owner/repository, private visibility, package path, publish digest, rights, and secret review. Skip this additional question only when the original Bazify request already included `-y` or `--yes`.
9. Publish only with the exact approval token from that preview:

   ```bash
   node <bazify-skill-root>/scripts/bazify.mjs publish /absolute/path/to/package \
     --yes \
     --approval '<preview-token>'
   ```

   The script rejects the token if the authenticated GitHub account, canonical package path, or any publishable byte changed after preview.

## Safety and ownership

- Create never mutates the source, overwrites a destination, adds a Bazframe profile reference, or contacts GitHub.
- Publish is always private.
- Keep Bazify working files under `./bazframe/`; the provider-owned package defaults to `~/<package-name>`.
- The generated package owns its copied provider source under `src/skills/`; `dist/` is generated and must not be edited.
- Bazframe package builds are unsandboxed. Read the copied Skill and generated build script before activation.
- If GitHub creation or push fails, report the script's recovery state. Do not rerun blindly, delete a remote, or add a different remote.
- Report the local package path, package/Skill names, validation result, and private repository URL when complete.
