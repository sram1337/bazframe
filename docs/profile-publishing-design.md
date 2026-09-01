# Profile Publishing and Import Redesign

> **Status: Draft — not implementation authority**
>
> `docs/design.md` remains the current product source of truth. The live Stage 3 CLI and portability behavior remain unchanged until a complete replacement vertical slice is approved.

## Purpose and authority

This Draft records the agreed future behavior for profile publishing, export, import, update, and version management. It also identifies current behavior that the future design will replace and technical choices that remain open.

This Draft must not be interpreted as approval of an archive schema, repository layout, storage mechanism, or partial command implementation. Where it conflicts with the current product design or CLI, the current behavior remains live until the redesign is approved and replaced atomically.

## Settled user-visible contract

### Primary journey and scope

- The primary source workflow is `bazframe profile publish`, targeting the active profile by default.
- The primary fresh-machine workflow is one command: `bazframe profile import git:user-name/my-profile-name`. The `git:user-name/my-profile-name` shorthand identifies `https://github.com/user-name/my-profile-name`.
- `publish`, `export`, `update`, and neutral `profile version` operations accept `--profile <name>` for an inactive profile; without it they target the active profile.
- A newly imported profile remains inactive. Activation remains the explicit `profile use` operation.
- Bazframe continues to manage profile instructions and Skill resources. Pi, model, provider, and runtime settings; credentials; adapter installation; and global/project policy remain machine-local and outside this redesign.
- The supported portability boundary remains macOS and Linux. Windows and full-portability acceptance remain existing open gates.

### GitHub publication

- Publish ensures GitHub authentication and prompts for login when needed.
- First publication creates a repository in the authenticated user's account named for the profile. It is private by default.
- `--public` makes the repository public and requires a sensitivity warning and confirmation. `-y`/`--yes` accepts that routine confirmation. `--private` makes the repository private. The two flags are mutually exclusive. Without either flag, first publication is private and later publication preserves the repository's current visibility.
- Every publish previews the exact files and resources that will be uploaded and asks for confirmation unless `-y`/`--yes` is used. Review, not secret scanning, is the safety boundary.
- Every successful publish creates a Git commit. User-visible versions are commit IDs: output may use short IDs, while selection accepts a unique prefix or full ID.
- Republish updates the linked repository only when the local profile is based on its latest published commit. It refuses if the repository contains a newer unseen commit and directs the user to update. A deliberately selected older commit cannot be republished as a new latest version.
- First publish refuses if the expected repository already exists but the local profile has never been linked to it; Bazframe does not adopt or overwrite it implicitly.
- An incomplete profile cannot be published, with no override.
- Publish and export never trigger a package build. They capture existing package build artifacts and fail with actionable `bazframe package build <package>` guidance when required artifacts are missing or unhealthy.
- A locally renamed profile retains its publication link. A duplicate is independent and unpublished.
- Any machine or user with write access to a linked repository may publish an imported linked profile.
- Removing a local profile never deletes its GitHub repository. Remote deletion remains an explicit GitHub operation; there is no `profile unpublish` command.

### Published and exported content

Publishing or exporting a profile includes the ready-to-use material that its harness currently uses. It does not include the editable source projects used to produce that material:

- a local direct Skill contributes its ready-to-use Skill files;
- a local library contributes its current prepared/installed content;
- a local package contributes its existing package build artifacts, not its editable source project;
- a remote resource remains an exact upstream reference by default; and
- `--bundle-remote` instead includes only that remote resource's ready-to-use Skill/library content or package build artifacts, never its complete source repository.

A file placed inside a package's declared artifact root by its build is included profile content. Bazframe does not infer whether those bytes are sensitive; the exact publication preview is the safety boundary. Imported package build artifacts are immutable, immediately usable, and build-free. They do not confer ownership of or local rebuild capability for the original editable source.

The published or exported profile excludes credentials, process environment, runtime settings, source projects, package source trees, build tooling, tests, `node_modules`, Git history, adapter state, and machine-local policy. Unbundled remote packages use the existing package lifecycle during import, including its exact build/risk report and explicit consent; bundled package artifacts require no build consent.

### Export and import transports

- Export and publish capture the same profile content through different destinations: export writes a zip, while publish writes it to GitHub.
- Export defaults to the active profile and `./<profile-name>.bazframe-profile.zip`. `--output <path>` selects another destination. Existing output refuses unless `--overwrite` is supplied.
- Import accepts either the new zip or `git:user/repository`. A private `git:` import prompts for GitHub login when necessary.
- A `git:` import selects the latest published commit by default. `--commit <id>` selects a specific published commit using the same unique short-prefix or full-ID semantics as `profile version use`.
- Import presents an informational summary without a general confirmation.
- Import retains `--dry-run` as effect-free inspection; exact presentation remains an implementation choice.
- `profile publish`, `export`, `import`, `update`, and `version` support the existing `--json` scripting transport. Exact DTO evolution remains an implementation choice.
- Backward compatibility with the current unzipped directory artifact is not required.

**Zip-origin rule:** export deliberately strips or breaks any GitHub publication link. Importing an exported zip always creates an independent, unpublished profile. A live publication/update link is obtained only through `publish` followed by `git:` import.

### Names, collisions, and resource identity

- On a profile-name collision, interactive import offers the first free safe suffix (`<name>-1`, `<name>-2`, and so on) as the default, explicit overwrite, or cancel.
- `-y`/`--yes` chooses the safe suffixed-name default. `--overwrite` chooses replacement.
- Overwriting an active profile is allowed, is atomic, and leaves it active.
- A suffixed profile imported through `git:` stays linked to the original GitHub repository for updates.
- A `git:` origin already present locally is idempotent: import does not create a duplicate or suffixed profile. Origin identity, not local display name, identifies the existing local profile; import reports it and suggests `profile update` to obtain the latest version.
- Bundled/imported Skills appear in the global/default catalog.
- Normal profiles share a single global resource instance. Virtual qualification applies only when independently imported resources are distinct instances, even when their bytes match.
- Distinct resource collisions use dynamic virtual qualification, for example `work/review` and `personal/review`. Canonical source identity and name are not mutated. When a collision disappears, the remaining resource automatically returns to its ordinary unqualified display.
- CLI commands select a virtually qualified Skill through that same `profile/name` form, for example `bazframe profile skill add work/review`. The slash is unambiguous because canonical Skill names cannot contain `/`.
- Profile membership binds to a stable underlying resource identity, so display alias changes cannot retarget membership.

### Incomplete profiles, repair, and atomicity

- Initial creation/import may succeed when an unbundled remote resource is unavailable. The result is incomplete but usable, and `profile use` permits activation with a warning.
- Missing or incomplete state remains visible in `profile list`, `status`, and the TUI until repaired.
- `profile update` retries missing resources even when no newer profile commit exists. Exact already-cached resources count as available without network access.
- Creation may be incomplete; mutation of an existing profile must never make it worse.
- Update, version selection, repair, and import overwrite are atomic: success publishes the complete staged result, while failure leaves the existing profile/version and any existing degraded state unchanged.
- Publishing an incomplete profile refuses.

### Updates and versions

- `bazframe profile update` targets the active profile by default and accepts `--profile` for an inactive profile. It moves the profile to the latest published commit and retries missing resources.
- Local changes cancel update by default. `--overwrite` explicitly discards them; `-y`/`--yes` does not authorize that discard.
- If required remote material is unavailable, update fails atomically. If both local and published versions changed, Bazframe refuses automatic synchronization; there is no merge UI.
- Version commands are neutral: `bazframe profile version list` and `bazframe profile version use <commit>`. Selection can move older or newer, is atomic, and follows the same local-change/`--overwrite` safeguards.
- Update returns a deliberately selected older version to latest.

### Flags, alias, and status

- `-y`/`--yes` accepts routine confirmations and safe defaults.
- `--overwrite` explicitly authorizes replacement or discard.
- The new commands do not introduce an ambiguous `--force`.
- `bzf` is an official installed executable alias for `bazframe`, using the same entrypoint and behavior.
- Status reports publication source, installed commit, publication state, and missing resources; exact formatting remains implementation discretion.

## Explicitly superseded behavior

The following Stage 1–3 product intent is superseded for the future redesign:

- the unzipped directory artifact and required explicit output directory;
- path-free declarations that omit local ready-to-use content;
- typed local library/package mappings during import;
- omission of healthy local direct Skills;
- exact-name resource collision refusal as the user-visible collision model;
- exclusion of imported collection children from the global/default catalog;
- the no-overwrite import contract; and
- forward-resumable partial mutation of existing state.

The redesign instead uses zip/GitHub transports, bundles local ready-to-use content and existing package artifacts, applies dynamic qualification, permits explicit atomic overwrite, and limits degradation to initial creation. Superseded product intent does **not** itself remove or alter the currently live Stage 3 implementation, grammar, help, directory artifact, mappings, or behavior.

## Behavior suitable for reuse

The redesign may reuse behavior whose semantics still match:

- acquisition of an exact remote revision rather than branch-head substitution;
- bounded package builds;
- exact build-risk reports and explicit consent;
- immutable snapshot/artifact validation;
- unchanged active-profile selection after initial import; and
- exclusion of machine-local credentials, policy, and adapters.

Reuse is evidence, not permission to carry over incompatible artifact, collision, or partial-mutation behavior.

## Unresolved owner and engineering choices

These choices remain unresolved and block any implementation that would encode them:

1. The concrete bundle/archive schema, integrity and signing representation, compression implementation, and applicable limits.
2. The GitHub repository representation and ref/layout choices, including how commits map to exact bundle data.
3. Virtual-namespace rendering beyond the approved `profile/name` display and CLI-selection form, including tie-breaking and ordering.
4. Dry-run presentation and exact JSON DTO evolution, including compatibility with the current schema-v1 JSON protocol. Effect-free `--dry-run` and `--json` support are settled; their exact representations are not.
5. Organization publishing and generic Git transports beyond the primary GitHub `git:user/repository` contract.
6. Storage, deduplication, cache lifetime, garbage collection, and sharing of bundled artifacts across profiles.

## Engineering implications, not product decisions

The following observations may guide later design, but are **not approved product or storage decisions**:

- The default closure is hybrid: local ready-to-use bytes plus exact remote references; `--bundle-remote` makes remote entries artifact-backed as well.
- Package records may need to distinguish source-backed, locally buildable packages from immutable artifact-backed imports.
- Stable resource identity must be separate from dynamic display aliases.
- Atomic non-worsening mutation likely requires staged closure materialization followed by one publication/selection transaction.
- Git is a transport and version store, not the CLI mental model; branches, merges, rebases, and history-rewrite controls should not leak into the user workflow.

These implications do not select storage layout, archive entries, manifests, repository representation, or transaction mechanics.

## Implementation guardrails

- Do not implement or expose publish, update, version, bundle, or replacement import/export behavior until the unresolved choices required by a complete vertical slice are approved.
- Do not invent archive trees, entry names, manifest fields, repository schemas, branch/ref layouts, signing schemes, storage models, or size/resource limits.
- Preserve current parser grammar, help, portability services, `docs/design.md`, and live `docs/profile-portability-design.md` behavior until an atomic replacement slice is ready.
- Do not expose partial commands, DTOs, or service surfaces that imply the redesign is live.
- Continue to apply existing bounded, no-follow, safe-diagnostic, portability, and package-consent protections where their semantics remain applicable.
