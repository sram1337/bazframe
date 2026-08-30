# Profile Portability Design

> Status: approved product target; unexposed foundations exist, artifact-codec terminology alignment and vertical slice pending
>
> `docs/design.md` remains the product source of truth. This document defines the implementation contract for profile export and import.

## Purpose

Profile portability moves one Bazframe profile between machines as a reviewable declaration. It does not copy `BAZFRAME_HOME` or bundle source trees.

An export captures portable profile contents and resource dependencies, plus explicit local-Skill omissions:

- the profile ID and exact `AGENTS.md` bytes;
- individually added Skill memberships from remote Git sources;
- whole-library references;
- whole-package references;
- the IDs of healthy local direct Skills that were omitted; and
- path-free source requirements for included first-class global resources.

A path-free remote Git requirement is exactly the recorded source's normalized `remote`, credential-free `fetchUrl`, `branch`, and exact `revision`, copied from existing remote Git provenance without a network lookup. It excludes checkout roots and transport preference. Library and package records themselves store only their source directory and snapshot digest; remote Git metadata comes from the separate existing provenance record.

Import always inspects the artifact and displays a plan first. Unless `--dry-run` is present, it then materializes or reuses every included dependency through its ordinary global lifecycle and publishes the composed profile. Included direct Skills become added Skills in `(default)`. Libraries and packages remain typed global objects. Their child Skills remain children and are never promoted into `(default)`. Omitted local direct Skills are reported but are not materialized or mapped.

Import never changes the current active profile. That remains an explicit `bazframe profile use <profile>` action.

## Product contract

1. An export is declarative and reviewable, not an offline bundle.
2. The artifact contains no source checkout, library/package snapshot, cache, adapter state, policy, favorite, recovery state, current active profile, credential, project state, or Pi state.
3. Remote Git source identity is locked to normalized remote identity, credential-free fetch URL, branch, and exact revision copied from existing remote Git provenance. Export performs no network lookup, and import never substitutes the branch's current head for the exported revision.
4. Healthy local direct Skills whose profile links exactly match their added Skills are omitted with a deterministic warning and recorded permanently in `profile.omittedLocalSkills`; there is no local Skill mapping. Local library and package source directories are machine-specific and, in the stages that support them, must be supplied as typed mappings on import.
5. Resource IDs do not change during import. `--as` may change only the destination profile ID.
6. Exact healthy target state is reusable. Occupied mismatched state fails; import never intentionally overwrites, merges, updates, repoints, or implicitly renames resources or profiles.
7. Global resources commit independently. If a later step fails, earlier healthy resources remain globally available and possibly unreferenced.
8. The profile is staged and published last by atomic rename. No partial profile becomes visible to Bazframe-cooperating writers.
9. Retry recomputes the plan and reuses exact committed state.
10. Package builds retain the existing explicit unsandboxed-execution trust boundary and cannot promise rollback of arbitrary process side effects.
11. Import blocks an absent destination whose ID is already stored in `active-profile`; publishing it would activate the profile without changing the `active-profile` file.

## Artifact

### Tree

An example export is:

```text
focused.bazframe-profile/
├── bazframe-profile.json
└── profile/
    └── AGENTS.md
```

The output directory name has no semantic meaning. `profile export` requires an explicit output path and refuses it whenever it is observed occupied. The absent destination is resolved through its canonical parent directory and must be disjoint from `BAZFRAME_HOME`: neither path may equal, contain, or be contained by the other. Publication performs no intentional replacement; the portable final-rename race is defined under [Publication races](#publication-races).

In this design, a **physical** file or directory is the filesystem entry itself, not a symlink, junction, reparse point, or other indirection. The artifact root and `profile/` must be physical directories. `bazframe-profile.json` and `profile/AGENTS.md` must be physical regular files. Special files, missing entries, and additional entries are invalid. Where the platform supports POSIX modes, export creates private directories and files.

`AGENTS.md` retains its exact validated bytes. JSON does not inline or normalize it. The manifest binds those bytes with SHA-256.

### Canonical schema v1

```json
{
  "schemaVersion": 1,
  "kind": "bazframe-profile-export",
  "profile": {
    "id": "focused",
    "instructions": {
      "path": "profile/AGENTS.md",
      "sha256": "<lowercase-sha256>"
    },
    "skills": [
      "review-tools"
    ],
    "omittedLocalSkills": [
      "workstation-helper"
    ],
    "libraries": [
      "toolkit"
    ],
    "packages": []
  },
  "resources": [
    {
      "kind": "skill",
      "id": "review-tools",
      "source": {
        "type": "remoteGit",
        "remote": "github.com/example/review-tools",
        "fetchUrl": "https://github.com/example/review-tools.git",
        "branch": "main",
        "revision": "<full-revision>"
      }
    },
    {
      "kind": "library",
      "id": "toolkit",
      "source": {
        "type": "remoteGit",
        "remote": "github.com/example/toolkit",
        "fetchUrl": "https://github.com/example/toolkit.git",
        "branch": "main",
        "revision": "<full-revision>"
      }
    }
  ]
}
```

The remote Git source fields come from the resource's existing remote Git provenance record. They are not reconstructed from a library record and export does not contact the remote. In Stage 1 a local library or any package reference blocks export rather than producing a resource.
Schema rules:

- Top-level keys are exactly `schemaVersion`, `kind`, `profile`, and `resources`.
- `schemaVersion` is `1`; `kind` is `bazframe-profile-export`.
- Profile keys are exactly `id`, `instructions`, `skills`, `omittedLocalSkills`, `libraries`, and `packages`.
- Instruction keys are exactly `path` and `sha256`; `path` is the fixed literal `profile/AGENTS.md`.
- IDs use the existing safe profile/Skill ID contracts.
- Membership/reference arrays and `omittedLocalSkills` contain unique IDs in lexical order. `omittedLocalSkills` is required and always present, including when empty.
- `omittedLocalSkills` is disjoint from `skills`, and an omitted ID has no matching resource.
- Resources are unique by `(kind,id)`, ordered by `skill`, `library`, then `package`, and lexically within each kind.
- Every included membership/reference has exactly one matching resource; orphan resources are invalid.
- Remote Git source keys are exactly `type`, `remote`, `fetchUrl`, `branch`, and `revision`.
- Remote Git identities use the existing credential-free source and provenance-record validators. Embedded credentials, query strings, fragments, local/file sources, option-shaped values, and ambiguous forms remain invalid.
- Remote Git entries omit checkout roots, transport preference, authentication, environment, and timestamps.
- A future local library or package source is exactly `{ "type": "localMapping" }`. Its containing `(kind,id)` is the mapping key. A `skill` resource with `localMapping` is invalid in every stage.
- Unknown keys are rejected rather than ignored or preserved.
- The encoder uses fixed object-key order, two-space indentation, and one final LF. Import requires equality with canonical re-encoding. This also rejects duplicate keys and alternate JSON encodings.

The artifact binds source identity, not publisher trust. Healthy local direct Skills whose profile links exactly match their added Skills are not portable resources: export emits a deterministic terminal-safe warning, omits them from the exported profile state, and records their IDs in `omittedLocalSkills`. There is no local Skill mapping. A future local library or package mapping records less reproducibility than a remote Git exact revision because the importer explicitly chooses the source directory on the destination machine. Package builds can also produce environment-dependent bytes. Exported snapshot digests are therefore not portable identity and are omitted.

## Export

### Command

```text
bazframe profile export <profile> --output <directory>
```

The profile ID and output path are required. Export never defaults to the active profile and never writes the artifact implicitly to stdout.

### Profile contents and dependencies

Export runs under the global state lock and accepts only the following profile contents and filesystem representation:

- a profile directory that is not a link;
- a bounded, fatal-UTF-8, NUL-free `AGENTS.md` regular file that is not a link;
- a `skills/` directory that is not a link;
- optional `libraries/` and `packages/` directories that are not links;
- no unknown entries at the profile root;
- each `skills/<id>` entry as an absolute link directly to the same Skill directory as the same-ID added Skill in `(default)`, not a link chain;
- library/package references represented by exact typed reference files; and
- healthy matching global resources, snapshots, and remote Git provenance where applicable.

An absent optional reference directory and a present but empty one represent the same empty reference set. Export records only that set.

Export rejects:

- entries under the profile's `skills/` directory that are directories, relative links, broken links, link chains, or absolute links that do not directly match the same-ID added Skill in `(default)`;
- a direct Skill or collection under Bazframe's remote Git checkout paths without matching remote Git provenance;
- linked profile roots, instructions, or namespaces;
- malformed or unknown reference content;
- missing, unhealthy, dirty, recovering, or identity-mismatched global dependencies;
- a profile whose effective collection composition, including local direct Skills that will be omitted, is degraded by direct/collection or collection/collection Skill collisions; or
- any source kind not yet supported by the running implementation stage.

For each direct Skill, export checks the same-ID added Skill in `(default)`. A Skill acquired from a remote Git source is included with its existing normalized, credential-free provenance identity. A Skill from a healthy local source directory is omitted, its ID is recorded in `profile.omittedLocalSkills`, and export emits a deterministic terminal-safe warning naming the sorted omissions. A broken or mismatched link, or a Skill under a Bazframe-managed checkout path without matching provenance, causes export to fail without publishing an artifact. No local Skill mapping is emitted.

A profile's library or package reference names a global library or package. Export verifies that the matching global record and activated immutable snapshot are both present and healthy. For a resource acquired from a remote Git source, export copies source identity from its existing remote Git provenance; the library/package record itself supplies only its source directory and snapshot digest. In Stage 1, a local library or any package reference causes export to fail without publishing an artifact. Later stages may emit `localMapping` for local libraries and packages, but the artifact never contains a source-machine filesystem path.

The **children of a collection** are the individual Skills discovered inside a library or produced by a package. They are intentionally absent from `profile.skills`, `profile.omittedLocalSkills`, and `resources`: the profile references the library or package as one unit rather than adding each child to `(default)`.

### Stable publication

Export records identities, builds the manifest, and revalidates all captured profile entries, global records, remote Git provenance, and instruction identity before publication. It resolves the absent destination through a held canonical physical parent and rejects ancestor/descendant overlap with `BAZFRAME_HOME`. Because an export may target any external filesystem and its final rename must remain on one filesystem to be atomic, Bazframe writes a private staging directory beside the requested output rather than in its internal workspace. It separately proves that staging is disjoint from `BAZFRAME_HOME`, verifies the staged artifact with the import codec, holds and revalidates the output-parent and staging identities, rechecks destination absence and disjointness immediately before publication, and performs a final rename without intentional replacement. A failure removes only identity-proven staging.

`AGENTS.md` is intentional portable profile content and may itself contain sensitive prose. Export warns the user to review it. Bazframe omits machine credentials and authentication state but does not claim heuristic secret detection or redaction of user-authored instructions.

### Publication races

Bazframe serializes imported-profile publication against other Bazframe writers with the global state lock. Export destinations are outside Bazframe state and have no cooperative lock. In both cases publication retains and revalidates the physical parent identity, checks destination absence immediately before rename, uses a unique identity-proven staging directory, and verifies the final directory identity after rename.

Portable Node directory rename has no conditional no-replace primitive. On some systems a non-cooperating process can introduce an empty destination between the final check and rename and have it replaced. The contract therefore forbids intentional replacement and protects against Bazframe-cooperating writers while retaining the existing documented final-syscall race against non-cooperating writers. Implementation must test platform behavior and report ambiguous publication rather than claiming universal no-replace semantics.

## Import

### Commands

```text
bazframe profile import <directory>
  [--as <profile>]
  [--map <kind>:<id>=<absolute-source-directory>]...
  [--yes]

bazframe profile import <directory> --dry-run
  [--as <profile>]
  [--map <kind>:<id>=<absolute-source-directory>]...
```

Import always begins with inspection and displays the resulting plan before it does anything else. By default it then executes that plan. `--dry-run` stops after inspection, with no DNS, clone, fetch, build, package-declared process execution, Bazframe-home write, artifact write, active-profile change, or policy/adapter/cache mutation. Inspection may perform bounded local reads and isolated non-network Git health checks for resources already present. Package execution retains its separate interactive confirmation or exact `--yes` authorization.

A local library or package export deliberately omits the old machine's path. A typed mapping such as `--map library:toolkit=/srv/toolkit` tells import which existing source directory on this machine should satisfy that named resource.

`--as` changes only the destination profile ID. Resource IDs remain exact.

Inspection reads the current active profile from `active-profile` without changing it. If there is no current active profile, the import remains inactive. If the destination profile already exists exactly and is the current active profile, import may reuse it and reports that pre-existing state. If the destination is absent while `active-profile` already stores its ID, import blocks and directs the user to repair the current active profile or choose `--as`; otherwise publication would activate the new profile implicitly. Malformed or unreadable `active-profile` state fails this inactivity check closed. Execution repeats the check under the final global state lock.

Stage 1 capability validation rejects every `localMapping` resource and every package membership/resource before planning any mutation. Stage 1 performs no local mapping and executes no package build.

### Artifact validation

Inspection treats the artifact as untrusted and performs:

1. stable no-follow validation of the exact physical tree;
2. bounded fatal-UTF-8 parsing of `bazframe-profile.json`;
3. exact-schema decoding and canonical-byte comparison;
4. physical bounded `AGENTS.md` validation and digest comparison;
5. ID, order, uniqueness, and exact membership/resource correspondence checks;
6. destination-ID and mapping validation;
7. local collision/health classification;
8. prospective composition checks possible from already available resources;
9. a deterministic plan of reuse, creation, network, build, and blocking work.

Execution never trusts a prior displayed plan. It reruns inspection and immediate identity checks, then retains the validated manifest object, exact instruction byte buffer, artifact-root identity, and mapping identity snapshots in memory through publication. Profile staging is written from those captured bytes, not from a later pathname reopen. Any reread must repeat stable no-follow identity and digest validation.

### Local mappings

The grammar is:

```text
--map <kind>:<id>=<absolute-source-directory>
```

For example:

```text
--map library:toolkit=/srv/skill-libraries/toolkit
--map package:automation=/srv/skill-packages/automation
```

`kind` is exactly `library` or `package`. The typed key must identify a `localMapping` resource. Direct Skills never use this grammar. The value must be a non-NUL absolute path to an existing source directory whose canonical basename equals the resource ID. A file, link, special entry, or missing path fails validation. The mapped directory is read-only input: import never writes to or replaces it. Each local resource requires exactly one explicit mapping, even if an existing target resource appears reusable. Missing mappings are reported as blockers. Duplicate or extra mappings, mappings for resources from remote Git sources, and wrong-kind, unsafe-ID, relative, or conflicting mappings fail before mutation. Any occupied Bazframe destination that is not an exact healthy reuse also fails rather than being overwritten.

Inspection captures each mapped source directory's canonical path and physical identity. Execution re-resolves and compares both immediately before its resource lifecycle and again during final dependency validation. Conflicting mappings include duplicate canonical directories and ancestor/descendant overlap among mapped resources or between a mapped source directory and the artifact root or `BAZFRAME_HOME`; this also keeps package builds away from import input and Bazframe staging. A platform that cannot prove the required physical identity fails closed.

Mappings authorize the source directory to use on the destination machine. They neither rename IDs nor become portability state. Ordinary library/package validation still applies, including package declaration and build consent.

### Plan output

The report is deterministic and terminal-safe. It shows:

1. artifact path and schema;
2. exported and destination profile IDs;
3. verified instruction path and digest, not instruction contents;
4. included direct Skill memberships, sorted omitted local direct Skill IDs, and whole-library/package references;
5. local library/package mapping requirements and resolved canonical roots;
6. each included resource's source identity and `create`, `reuse`, or `blocked` action;
7. network acquisition and possible package-build work;
8. the profile's `publish`, `reuse`, or `blocked` action;
9. exclusions, including the current active profile and policy;
10. the invariant that collection children will not enter `(default)`.

All user-controlled values are escaped and bounded in diagnostics.

## Import execution

Running `profile import` without `--dry-run` authorizes the acquisition work and Bazframe-managed state writes shown in the inspection plan. It does not authorize collisions, replacement, branch-head substitution, changing the current active profile, or package execution beyond the package consent rules below.

Execution:

1. recomputes the complete inspection plan and retains its validated artifact bytes and identity snapshots;
2. rejects every detectable mapping, collision, recovery-state, current active profile, and destination-profile blocker before network or builds;
3. materializes direct Skills in lexical order;
4. materializes libraries in lexical order;
5. materializes packages last, in lexical order;
6. revalidates every resource through its normal lifecycle;
7. builds the prospective profile in private sibling staging;
8. validates complete direct-Skill and collection composition;
9. acquires the global state lock, rechecks dependency, destination-parent, destination, and current active profile state, and publishes the profile by final rename;
10. leaves the current active profile unchanged.

Staging contains a physical `AGENTS.md` written from the validated in-memory bytes, a physical `skills/` namespace with newly generated parallel absolute links, and exact typed reference files. It contains no collection-child links. Optional reference namespaces are created only when nonempty.

A successful final rename is publication even if a later durability or reporting action fails. Diagnostics report the final path and publication ambiguity rather than speculatively deleting committed state.

### Exact-revision remote Git

The current ordinary remote Git add path chooses the selected branch head. Portability adds a dedicated locked-revision acquisition path:

1. validate that exported `remote` and `fetchUrl` normalize to one allowed identity;
2. clone/fetch the recorded branch through existing shell-free, credential-isolated Git/GitHub CLI routing;
3. resolve and retain the fetched `refs/remotes/origin/<branch>` head only as reachability evidence;
4. require the exact exported revision object to exist and prove it is an ancestor of that saved fetched head before changing any reference;
5. check out the exported revision detached;
6. set the committed checkout's `refs/remotes/origin/<branch>` specifically to the exported revision so the existing offline health invariant remains exact;
7. verify detached `HEAD`, origin identity, `refs/remotes/origin/<branch>`, and record revision immediately before resource publication;
8. validate and commit through the normal resource-specific remote Git lifecycle.

If the exact revision is missing, malformed, unreachable after rewritten history, or otherwise unverifiable, import fails. It never falls forward to current branch head and has no rewrite override. Transport remains a destination-local acquisition choice and is recorded in ordinary target state, not the artifact.

This requires factoring remote Git acquisition so ordinary add retains branch-head behavior while portability supplies an exact required revision.

### Package builds

A new package must be acquired or mapped and its exact physical `bazframe-package.json` inspected before build authorization. Before each build, import reports:

- package ID and remote Git source identity or local mapped root;
- candidate root and working directory;
- literal build argv;
- package-manifest identity;
- artifact and Skills relative roots;
- `shell: false` execution with inherited environment;
- unsandboxed ordinary-user authority, including possible credential, network, and user-file access;
- the fact that arbitrary process side effects cannot be rolled back.

Interactive confirmation is a literal approval that defaults to decline. `--yes` is accepted only when `--dry-run` is absent; it authorizes each exact revalidated package report noninteractively but does not suppress the report. Consent is bound to package ID, candidate-root identity, remote Git revision or local mapping, and exact manifest snapshot. A declined build cleans identity-proven Bazframe staging and executes nothing. An exact reused package does not rebuild and needs no build consent.

The package preparation lifecycle gains a `beforePackageBuild` callback invoked inside preparation immediately before `executeBuild`. For packages acquired from remote Git sources it revalidates the canonical root identity, clean checkout, detached `HEAD`, origin, `refs/remotes/origin/<branch>`, revision, and authorized manifest. For local mappings it revalidates the canonical path/physical root identity and authorized manifest. The callback and spawn remain adjacent inside the lifecycle; the accepted final race against a non-cooperating same-user writer still applies.

Import reuses the rest of the existing package lifecycle and expected-manifest seam. Filesystem rollback covers Bazframe-managed staging and records, not arbitrary effects of package code.

## Collision and idempotency contract

| Target state | Result |
|---|---|
| Typed resource absent and requirements ready | Create through its ordinary first-class lifecycle |
| Resource from a remote Git source has exact remote, fetch URL, branch, revision, checkout, registration/record, and healthy snapshot where applicable | Reuse without network or build |
| Any remote Git source identity field differs | Fail; do not update or repoint |
| Local resource is at the explicitly mapped canonical root with exact registration/record and healthy snapshot where applicable | Reuse |
| Local resource exists at another root | Fail |
| Same-kind ID has unexpected physical, broken, malformed, recovering, or unrecognized occupancy | Fail |
| A Skill registration link does not exactly target the required Bazframe-managed checkout or mapped root, or a library/package record is linked | Fail |
| Library and package share one ID | Treat independently; this is valid |
| Another kind alone uses the ID | No collision |
| Artifact duplicates or omits an included membership, reference, or matching resource | Invalid artifact |
| An included or omitted local direct Skill collides with a collection child | Fail source/prospective composition; never promote the child |
| Referenced collections collide with each other | Fail prospective composition |
| Destination profile absent and there is no current active profile, or another profile is active | Publish after all resources are healthy |
| Destination profile absent but `active-profile` stores its ID | Block to prevent implicit activation |
| Destination profile has the exact supported contents and healthy dependencies | Reuse without rewriting; preserve and report whether it is already the current active profile |
| Destination profile differs or contains unknown content | Fail; do not merge or overwrite |
| `--as` names occupied mismatched state | Fail |
| Export output path is observed occupied | Fail; do not intentionally replace |

Profile equivalence requires exact instruction bytes, direct Skill IDs and parallel targets, typed reference sets, allowed physical namespaces, and healthy exact dependencies. An absent versus empty physical optional reference namespace is the same canonical empty logical set; other physical differences are mismatches.

Cross-machine snapshot digest equality is not required. The target snapshot must be healthy and its source identity must satisfy the artifact. An environment-dependent package build may legitimately produce different output, so the product does not claim reproducible package artifacts.

## Transactions, failure, and retry

The import is not globally atomic. Each resource uses its existing state lock, journal, validation, identity checks, atomic publication, rollback, and recovery behavior. The profile is the final transaction boundary.

On failure, import performs a read-only exact-state classification and reports each resource as:

- `created`;
- `reused`;
- `not-created` only when absence is proven;
- `recovery-required` when the existing lifecycle retained recovery state;
- `commit-ambiguous` when a commit or absence cannot be proved, including failure during lock release or post-commit reporting.

A `commit-ambiguous` result directs the user to rerun inspection; it never claims absence or recommends destructive cleanup. Import also states whether the profile was published and whether an unsandboxed package may have produced nonrollbackable side effects. Earlier committed resources remain healthy and unreferenced; import does not remove them. Retry recomputes the plan, reuses exact resources, and continues forward. Unreferenced immutable snapshots remain governed by the existing deferred garbage-collection decision.

No serialized machine plan or import recovery format is added. Existing per-resource recovery remains authoritative.

## Safety and bounds

Implementation reuses the existing safe-ID, instruction-byte, traversal, Skill-discovery, terminal-safety, remote-Git, lock, atomic-file, and identity-verification contracts. It must additionally:

- reject linked or special artifact/profile entries;
- use stable no-follow reads and immediate identity revalidation;
- reject noncanonical/duplicate-key JSON, unknown fields, malformed digests, and unsafe sources;
- bound profile/package manifest bytes, decoded resource count, source-field lengths, package argv count and argument/path lengths, diagnostics, and streamed directory enumeration before excessive allocation;
- bound snapshot manifest bytes, entry count, depth, individual file bytes, and aggregate bytes before activation or verification;
- bound Git wall time, transfer/on-disk object consumption where enforceable, checkout entry count/depth, individual blob bytes, and aggregate checkout bytes before publication;
- prevent artifact-relative path escape by accepting only the one fixed instruction path;
- reject export destination or sibling-staging equality/ancestor/descendant overlap with `BAZFRAME_HOME`, using a held canonical physical parent for the absent destination;
- isolate Git hooks/configuration, use literal argv, and avoid shells;
- keep authentication in Git/GitHub CLI ownership;
- redact credential-shaped process diagnostics and terminal control characters;
- show outbound remotes before execution;
- use private staging and identity-checked cleanup preparation with a fresh root identity check before recursive removal;
- avoid printing instruction bodies during ordinary inspection and errors.

Existing authoritative limits apply where their semantics match, including the current effective-instruction and Skill traversal limits. Stage 1 profile artifacts authorize a 1 MiB canonical manifest, 1,024 total profile entries across included Skills, omitted local Skills, libraries, and packages, 256 resources, and 1,024 entries in each streamed profile namespace inspection. Capture will enforce those ceilings before production exposure.

Skill snapshot publication and verification enforce a 4 MiB raw and canonical manifest, 8,192 physical entries including the root, depth 32 with the root at depth zero, 4,096 UTF-8 bytes per relative path, 64 MiB logical bytes per regular file, and 512 MiB aggregate logical regular-file bytes. Directory enumeration and file copy/hash are streamed; per-file and aggregate budgets reconcile actual streamed bytes and stop concurrent growth after reading at most one byte beyond the applicable ceiling. Verification performs two bounded manifest/tree comparisons while retaining stable no-follow per-file reads and held root-directory identities. Cleanup preparation uses the same ceilings, makes only identity-checked physical directories writable through held handles, and refuses linked, special, unknown, or substituted entries. It freshly revalidates the cleanup root's physical identity immediately before recursive removal. Portable Node lacks handle-relative recursive deletion, so a non-cooperating same-user process can still substitute the root between that last check and `rm`; this residual final-pathname race is not claimed as identity-proven deletion. Test-only policy injection may lower but never raise these production limits.

Git/checkout, package-manifest/argv, process-duration, and remaining acquisition limits must be centralized, documented, and tested below/at/above their approved values as their implementation arrives. Git transfer limits need defined timeout/abort, child termination, staging quarantine, and identity-proven cleanup behavior; where a hard portable pre-transfer byte cap cannot be guaranteed, the supported transport/platform contract must state the enforceable approximation and fail safely on timeout or post-transfer budget excess. An unbounded untrusted checkout, package manifest, or process duration remains a release blocker.

Windows validation must cover junctions/reparse points, UNC paths, case-insensitive basename identity, no-follow fallback behavior, destination collision behavior, and ACL/privacy behavior where POSIX modes are unavailable. Private staging is claimed only when platform permissions or inherited ACLs establish it.

A digest proves integrity, not authorship or safety. Portability does not add signatures, trusted publishers, vulnerability scanning, licensing review, or semantic instruction analysis.

## Diagnostics and service boundary

CLI prose is derived from structured service results such as:

```ts
type PortabilityAction = 'create' | 'reuse' | 'blocked';
type PortabilityOutcome =
  | 'created'
  | 'reused'
  | 'not-created'
  | 'recovery-required'
  | 'commit-ambiguous';

interface ResourceImportPlan {
  kind: 'skill' | 'library' | 'package';
  id: string;
  sourceType: 'remoteGit' | 'localMapping';
  action: PortabilityAction;
  reason?: string;
  networkRequired: boolean;
  buildRequired: boolean;
}

interface ProfileImportPlan {
  artifactPath: string;
  exportedProfileId: string;
  destinationProfileId: string;
  omittedLocalSkills: string[];
  resources: ResourceImportPlan[];
  profileAction: PortabilityAction;
  blockers: string[];
}
```

Stable error families cover invalid artifact shape/schema, noncanonical manifest, instruction digest mismatch, inconsistent memberships/resources, unprovenanced export members, mapping errors, resource identity collisions, unavailable exact revisions, changed/declined package builds, profile collisions, partial import, and final-publication ambiguity. Partial-import guidance directs the user to inspect and retry; it never suggests overwrite, forced update, or speculative cleanup.

## Implementation seams

Reuse:

- `src/core/content.ts` for instruction validation and its bound;
- `src/core/safe-text.ts` for safe diagnostics;
- `src/state/lock.ts` and `src/state/atomic-file.ts` for ownership and publication;
- `src/skills/default-skill-catalog.ts` for direct Skill registration;
- `src/profiles/profile-skill-membership.ts` for parallel links;
- `src/profiles/profile-skill-collection-reference.ts` for typed references;
- `src/skill-collections/skill-collection-lifecycle.ts` for activation;
- `src/skill-collections/skill-snapshot.ts` for physical snapshot validation;
- `src/providers/managed-git.ts` and `managed-git-record.ts` for acquisition, provenance, package authorization, and recovery;
- `src/profiles/profile-management.ts` for staged profile conventions;
- `src/skill-collections/skill-collection-resolver.ts` for prospective composition.

Add:

- `src/profile-portability/profile-artifact.ts`: exact object schema and canonical object codec behind explicit approved-limit injection;
- bounded physical artifact I/O and exclusive export publication in later Stage 1 services after the remaining limits are approved;
- `src/profile-portability/profile-export.ts`: locked profile/dependency capture and revalidation;
- `src/profile-portability/profile-import-plan.ts`: no-write planning, mappings, and collision classification;
- `src/profile-portability/profile-import.ts`: resource orchestration and final profile publication.

Required factoring:

- a raw-byte physical no-follow instruction reader whose validated bytes remain captured through execution;
- a path-free remote Git source identity decoder sharing existing validators;
- exact-revision acquisition alongside ordinary branch-head add;
- read-only existing-resource classification that performs no snapshot, build, or network operation and supports post-error ambiguity classification;
- canonical-path plus physical-identity snapshots for artifact roots, local mappings, and publication parents;
- reusable exact-state classification for registrations, records, provenance, the current active profile, and profiles;
- prospective-profile validation independent of a visible final profile path;
- a `beforePackageBuild` callback inside package preparation immediately before process execution;
- a private staged profile publisher rather than public membership commands executed one at a time.

CLI parsing/reporting remains separate from portability orchestration. TUI support is not part of the initial implementation.

## Delivery stages

### Stage 1: remote Git, build-free vertical slice

- implement the complete schema codec, including recognized local-library/package variants and required local-Skill omissions;
- export/import direct Skills and libraries from remote Git sources;
- warn, omit, and permanently record only healthy local direct Skill IDs whose profile links exactly match their added Skills;
- fail export on local libraries and every package reference before publication;
- add exact-revision remote Git acquisition;
- provide inspection/execution, collision/reuse, inactive atomic publication, partial-success, and retry behavior;
- reject local mappings and packages before planning mutation; perform no local mapping or package execution.

### Stage 2: local build-free libraries

- add typed mappings for local libraries only;
- validate mapped roots without mutation during inspection;
- implement exact root reuse and collision handling.

### Stage 3: packages

- add packages from remote Git sources and locally mapped packages;
- retain exact manifest reporting and bound authorization;
- order packages last and report nonrollbackable side effects;
- test decline, manifest drift, build failure, partial success, and retry.

Portability is not described as complete until direct Skills from remote Git sources, explicit local direct-Skill omissions, libraries from remote Git and local sources, packages, and all approved resource/acquisition bounds ship.

## Validation gates

Tests must cover:

- deterministic export and canonical round trips;
- exact physical artifact shape, private staging, occupied-output refusal, output/staging overlap with representative `BAZFRAME_HOME` namespaces, parent substitution, final-rename races, and publication ambiguity;
- malformed UTF-8, NULs, oversized instructions/manifests, digest mismatch, duplicate/unknown/noncanonical JSON, and extra entries;
- symlinked profile/artifact roots, files, namespaces, and references;
- unprovenanced, foreign, broken, or mismatched direct Skills;
- unhealthy records, snapshots, remote Git provenance, and recovery states;
- same-ID library/package independence and collection-child non-promotion;
- exclusion of the current active profile, favorites, policy, adapter, caches, snapshots, credentials, recovery, project, and Pi state;
- exact historical revision after branch advancement;
- missing/rewritten revision refusal with no branch-head substitution;
- every remote Git source identity mismatch;
- missing, duplicate, extra, wrong-kind, relative, unsafe, wrong-basename, duplicate-root, ancestor-overlap, and identity-substituted local library/package maps;
- every resource/profile reuse and occupied-mismatch case;
- absent destinations matching dangling `active-profile` state, malformed `active-profile` failure, and exact reuse of a pre-existing current active profile;
- `--as` changing only profile identity;
- direct/collection and collection/collection collision refusal;
- inspection with zero network, builds, and writes;
- package report, decline, acceptance, immediate pre-build manifest/root/Git revision drift, build failure, and terminal-safe diagnostics;
- bounded package argv/manifests, Git time/disk/object transfer, checkout/snapshot bytes/files/depth, and cleanup at every boundary;
- failure injection at every resource and publication phase, including lock-release/post-commit read failure;
- retained earlier resources with no partial profile and `commit-ambiguous` outcomes when exact state cannot be proved;
- retry convergence and final-rename ambiguity;
- Windows junction/reparse, UNC, case-insensitive ID, no-follow fallback, ACL/privacy, and rename-collision gates;
- parser/help integration, disposable-home integration, packed CLI validation, and full `npm test`.

## Non-goals

- Raw home, profile-tree, source-tree, checkout, snapshot, or archive transfer.
- Offline/self-contained export.
- Collection-child promotion, child subsets, or dependency inference.
- Resource/profile overwrite, merge, update, replacement, or automatic ID remapping.
- Changing or clearing the current active profile.
- Favorites, policies, adapters, caches, recovery, project/Pi state, or credentials.
- Snapshot garbage collection or global rollback across independently committed resources.
- Rollback of arbitrary package process side effects.
- Signatures, publisher trust, vulnerability/license scanning, or semantic instruction review.
- TUI portability flows in the initial implementation.
- New remote transports beyond the existing remote Git source contract.
