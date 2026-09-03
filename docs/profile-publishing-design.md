# Profile Publishing and Import Redesign

> **Status: Shipped replacement lifecycle on macOS and Linux**
>
> The profile publish, ZIP/Git import/export, update, version, managed lifecycle, projection, documentation, and packed surfaces are exposed coherently in the unreleased working tree. `docs/design.md` records the consolidated product behavior.

## Purpose and authority

This design records the shipped behavior for profile publishing, export, import, update, and version management. The implementation contract is recorded separately in `docs/profile-publishing-engineering.md`.

The replacement is now the public CLI authority for this lifecycle. Its archive, Git, storage, recovery, authentication, and JSON contracts were exposed together rather than as partial surfaces.

## Settled user-visible contract

### Primary journey and scope

- The primary source workflow is `bazframe profile publish`, targeting the active profile by default.
- The primary fresh-machine workflow is one command: `bazframe profile import git:user-name/my-profile-name`. The `git:user-name/my-profile-name` shorthand identifies `https://github.com/user-name/my-profile-name`.
- `publish`, `export`, `update`, and neutral `profile version` operations accept `--profile <name>` for an inactive profile; without it they target the active profile.
- A newly imported profile remains inactive. Activation remains the explicit `profile use` operation.
- Bazframe continues to manage profile instructions and Skill resources. Pi, model, provider, and runtime settings; credentials; adapter installation; and global/project policy remain machine-local and outside this redesign.
- The supported portability boundary remains macOS and Linux. [`win32-filesystem-backend-requirements.md`](win32-filesystem-backend-requirements.md) defines an approved but unimplemented outcome-parity native-Windows x64/local-NTFS path. Windows remains unsupported until ZIP overwrite, Git import/export/publish/update/versioning, the complete current CLI/runtime/resource/adapter/editor lifecycle, ordinary owned-state reclamation, and the existing TUI all pass one installed-package acceptance gate through both entrypoints where applicable. Network-backed Bazframe home/staging and full-portability acceptance remain open; bounded ZIP copy and Git transport into proved private local staging are allowed.

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
- Import retains `--dry-run` as effect-free inspection. ZIP dry-run is local and read-only. A `git:` dry-run may inspect GitHub through read-only requests using authentication that is already available, but it never changes local or remote state: it performs no login or authentication changes, Bazframe writes, cache writes, locks, builds, repository writes, visibility changes, refs, or commits. If required authentication is unavailable, dry-run reports that condition without prompting for login.
- `profile publish`, `export`, `import`, `update`, and `version` support the `--json` scripting transport through a clean schema version 2. Schema-v2 results do not retain dual compatibility with the superseded Stage 3 schema-v1 DTO semantics. JSON mode never prompts interactively and emits exactly one bounded JSON document. A command that needs routine confirmation requires `-y`/`--yes`; destructive replacement or discard still requires explicit `--overwrite`, which `--yes` never implies.
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

- Initial imported-profile creation may succeed when an unbundled remote resource is unavailable. The result is incomplete but usable, and `profile use` permits activation with a warning. Ordinary local profile creation remains complete.
- Missing or incomplete state remains visible in `profile list`, `status`, and the TUI until repaired.
- `profile update` retries missing resources even when no newer profile commit exists. Exact already-cached resources count as available without network access.
- Initial imported-profile creation may be incomplete; mutation of an existing profile must never make it worse.
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

## Export compatibility inspection (designed, not implemented)

### Command and purpose

```text
bazframe profile exportable [--profile <profile>] [--bundle-remote]
```

`profile exportable` answers whether Bazframe can produce a valid export from a profile at the inspected point in time. It defaults to the active profile; `--profile` selects an inactive profile. `bzf` and the global `--json` option behave as elsewhere.

The command is a read-only query, not an export dry-run. It writes no archive or Bazframe state, acquires no mutation lock, performs no startup recovery, network request, login, build, prompt, cache write, or remote mutation. Concurrently changing input fails closed as unstable. A later export repeats all validation and can differ if the profile changes.

`--bundle-remote` checks whether every remote resource can be captured from its existing validated ready artifact. It never fetches or builds missing content. Without the flag, a healthy exact remote reference is exportable without proving current network reachability.

### Three separate conclusions

The report keeps these questions distinct:

1. **Exportable:** whether the production capture, policy, bounds, canonicalization, and ZIP representation succeed now. This is the authoritative verdict.
2. **Resource closure:** either `bundled` or `requires-remote-acquisition`, with exact remote resource identities and possible destination package-build requirements. “Bundled” does not claim general machine independence.
3. **Environment signals:** deterministic advisory observations such as absolute paths, environment-variable names, external command names, platform conditions, or references to excluded files. These do not alter the exportable verdict.

The command must not use “self-contained” without qualification: Bazframe cannot prove availability of credentials, executables, services, models, providers, project files, operating-system facilities, or the meaning of arbitrary instructions.

### Deterministic inspection

The authoritative check reuses the production capture and archive-validation paths rather than implementing a permissive approximation. It validates:

- the physical profile root, managed state, resource bindings, membership, and publication-independent capture identity;
- stable no-follow regular-file closure, valid direct Skills, canonical relative paths and order, excluded credential filenames, and all file/count/depth/path/byte limits;
- ready local library snapshots and package artifacts without source capture or build;
- credential-free exact provenance for unbundled remote resources;
- existing ready artifacts for every resource under `--bundle-remote`;
- complete manifest/blob closure and deterministic ZIP representability; and
- stability of all authoritative inputs through final revalidation.

The report includes a bounded exact relative-path preview, capture digest when capture succeeds, resource counts and modes, exclusions, destination acquisition/build requirements, blockers, and warnings. It never prints managed absolute paths, temporary paths, credentials, file contents, source ownership IDs, or publication linkage not already allowed by lifecycle presentation policy.

Known compatibility blockers produce a completed report with `exportable: false`; unexpected inability to perform the inspection remains an operational error. Warnings and environment signals do not convert a successful capture into failure.

### Human and JSON behavior

Human exit status is:

- `0` when inspection completes and `exportable` is true;
- `3` when inspection completes and `exportable` is false;
- `2` for usage or refusal; and
- `1` for operational, integrity, or unexpected failure outside the closed compatibility-blocker set.

JSON uses lifecycle schema v2 with command `profile.exportable`. A completed positive or negative inspection has `outcome: "success"`; the result contains `exportable`, capture mode, optional capture digest and files, resource requirements, exclusions, blockers, warnings, and environment signals. It emits exactly one bounded newline-terminated document. Because this command is intrinsically effect-free, its result omits mutation `effects` rather than repeating false values.

Finding codes, kinds, ordering, fields, and limits require an engineering-contract amendment before implementation. Blockers sort by stable code and logical path; resources use the existing kind/name order; files use canonical code-point path order. Human and JSON presentations derive from one typed result.

### LLM boundary

The Bazframe command is entirely deterministic. It does not invoke a model or make semantic claims about arbitrary prose or code. A separate agent may optionally consume the JSON result and inspect only flagged bounded files or spans to identify implicit machine assumptions. Such findings are advisory, must remain separate from the exportable verdict, must not be described as secret detection, and must not be required for use of the command. Excluded credential files must never be supplied to a model by this workflow.

### Acceptance gate

Implementation is complete only when tests prove parity with real export capture in default and bundled modes; no mutation, recovery, lock, network, login, build, prompt, or cache activity; stable false-verdict classification; concurrent-change failure; bounded/redacted human and JSON output; exact exit statuses; 64/65 path-depth boundaries; deterministic ordering; and packed behavior through both `bazframe` and `bzf`.

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

The redesign instead uses zip/GitHub transports, bundles local ready-to-use content and existing package artifacts, applies dynamic qualification, permits explicit atomic overwrite, and limits degradation to initial imported-profile creation. The former Stage 3 implementation, grammar, directory artifact, mappings, and behavior are historical and no longer live.

## Behavior suitable for reuse

The redesign may reuse behavior whose semantics still match:

- acquisition of an exact remote revision rather than branch-head substitution;
- bounded package builds;
- exact build-risk reports and explicit consent;
- immutable snapshot/artifact validation;
- unchanged active-profile selection after initial import; and
- exclusion of machine-local credentials, policy, and adapters.

Reuse is evidence, not permission to carry over incompatible artifact, collision, or partial-mutation behavior.

## Approved engineering contract and deferred scope

`docs/profile-publishing-engineering.md` is the approved engineering contract for hidden implementation. It resolves the capture/archive representation, integrity and limits, GitHub repository and commit representation, profile and resource identity, namespace ordering, schema-v2 DTOs, storage and garbage collection, transactions and recovery, authentication boundary, and deterministic test seams.

Organization publishing and generic Git transports beyond the primary GitHub `git:user/repository` contract remain deferred. They do not block the approved GitHub-first implementation.

## Engineering implications, not product decisions

The following observations may guide later design, but are **not approved product or storage decisions**:

- The default closure is hybrid: local ready-to-use bytes plus exact remote references; `--bundle-remote` makes remote entries artifact-backed as well.
- Package records may need to distinguish source-backed, locally buildable packages from immutable artifact-backed imports.
- Stable resource identity must be separate from dynamic display aliases.
- Atomic non-worsening mutation likely requires staged closure materialization followed by one publication/selection transaction.
- Git is a transport and version store, not the CLI mental model; branches, merges, rebases, and history-rewrite controls should not leak into the user workflow.

These implications do not select storage layout, archive entries, manifests, repository representation, or transaction mechanics.

## Implementation guardrails

- Implement and validate changes as coherent parser/dispatch, lifecycle, projection, documentation, generated-Skill, and packed-acceptance slices. Release readiness requires the complete public family to agree.
- Do not invent archive trees, entry names, manifest fields, repository schemas, branch/ref layouts, signing schemes, storage models, or size/resource limits.
- Keep `docs/design.md`, this product contract, the engineering contract, help, and generated Skill synchronized with each implemented public slice.
- Do not leave completed snapshots with partial commands, DTOs, or service surfaces.
- Continue to apply existing bounded, no-follow, safe-diagnostic, portability, and package-consent protections where their semantics remain applicable.
