# Integrated Profile Publishing Implementation Contract

> **Status: Approved engineering contract for the shipped replacement lifecycle**
>
> `docs/profile-publishing-design.md` is the approved product design for the replacement lifecycle. The implementation is exposed in the unreleased working tree. `docs/design.md` remains excluded pending its separately authorized consolidation.

## 1. Governing product contract

- ZIP and GitHub transport the same captured-profile model.
- Export and publish never build packages.
- Export may retain unavailable remote resources as exact references.
- “Creation may be incomplete” means **initial imported-profile creation**. Ordinary local `profile add`/creation acquires no remote resources and remains complete.
- Initial Git or ZIP import may become incomplete only when an unbundled remote resource is unavailable.
- Update, repair, overwrite, and version selection are atomic and cannot worsen an existing profile.
- ZIP import creates an independent unpublished profile.
- Git import preserves repository linkage and is idempotent by canonical GitHub origin.
- Imported resource instances remain logically distinct even when byte-identical.
- Ordinary profiles continue sharing ordinary catalog resource instances.
- Git commits are versions. Branches, merges, rebases, history rewriting, unpublish, and remote deletion are not Bazframe user operations.
- Git import dry-run may perform read-only GitHub inspection with already available authentication. It never logs in or mutates local or remote state.
- Schema v2 applies only to:
  - `profile publish`;
  - `profile export`;
  - `profile import`;
  - `profile update`;
  - `profile version list|use`.
- Unrelated JSON commands remain schema v1.
- Current Stage 3 limits remain the only numeric limit authority.
- `bazframe` and `bzf` remain identical executable entrypoints.
- Public parser, help, DTO, documentation, Skill, status, and TUI changes happen only in one public cutover.

## 2. Explicit simplifications

Reject the following unnecessary complexity:

- profile-generation symlinks;
- eager migration of existing profiles;
- a global UUID registry for ordinary catalog resources;
- an alternate expanded Git repository tree;
- UUID identity for immutable bytes;
- new quotas, retention periods, timers, background garbage collection, signing, or encryption;
- backward reading of Stage 3 export directories.

Existing physical profile directories remain authoritative:

```text
$BAZFRAME_HOME/profiles/<profile-name>/
```

A strict sidecar is added only when publication or imported-instance state requires one.

## 3. Canonical captured-profile format

### 3.1 Types

```ts
type Sha256 = string; // exactly 64 lowercase hexadecimal characters
type CommitId = string; // full validated 40- or 64-hex Git commit ID
type ResourceKind = 'skill' | 'library' | 'package';

interface CapturedProfileV1 {
  schemaVersion: 1;
  kind: 'bazframe-captured-profile';
  profile: CapturedProfileHeader;
  resources: CapturedResource[];
  blobs: BlobRecord[];
}

interface CapturedProfileHeader {
  name: string;
  instructions: BlobFile;
}

interface CapturedResource {
  id: Sha256;
  key: CapturedResourceKey;
  payload: BundledPayload | RemoteGitPayload;
}

interface CapturedResourceKey {
  kind: ResourceKind;
  name: string;
}

interface BundledPayload {
  kind: 'bundled';
  role: 'skill' | 'library' | 'packageArtifacts';
  sourceForm?: 'profile-local';
  origin?: ExactRemoteGitIdentity;
  files: BlobFile[];
}

interface RemoteGitPayload {
  kind: 'remoteGit';
  identity: ExactRemoteGitIdentity;
}

interface BlobFile {
  path: string;
  sha256: Sha256;
  bytes: number;
  executable: boolean;
}

interface BlobRecord {
  sha256: Sha256;
  bytes: number;
}

interface ExactRemoteGitIdentity {
  remote: string;
  fetchUrl: string;
  branch: string;
  revision: CommitId;
}
```

Every `bytes` value:

- is a nonnegative safe integer;
- is not negative zero;
- satisfies the applicable existing byte limit;
- exactly matches the physical byte count and corresponding blob record.

### 3.2 Canonical JSON

Exact object key order:

| Object | Keys |
|---|---|
| `CapturedProfileV1` | `schemaVersion`, `kind`, `profile`, `resources`, `blobs` |
| `CapturedProfileHeader` | `name`, `instructions` |
| `CapturedResource` | `id`, `key`, `payload` |
| `CapturedResourceKey` | `kind`, `name` |
| bundled, no origin/source form | `kind`, `role`, `files` |
| bundled profile-local Skill | `kind`, `role`, `sourceForm`, `files` |
| bundled, with origin | `kind`, `role`, `origin`, `files` |
| remote payload | `kind`, `identity` |
| `BlobFile` | `path`, `sha256`, `bytes`, `executable` |
| `BlobRecord` | `sha256`, `bytes` |
| `ExactRemoteGitIdentity` | `remote`, `fetchUrl`, `branch`, `revision` |

Optional keys are omitted, never encoded as `null`.

Unknown and duplicate JSON keys are rejected. Canonical bytes are:

```ts
JSON.stringify(validatedCanonicalValue, null, 2) + '\n'
```

Decoding requires strict UTF-8, exact validation, canonical re-encoding, and byte equality.

### 3.3 Resource identity and ordering

Captured resource ID:

```text
SHA256(
  UTF8("bazframe-captured-resource-v1\0") ||
  UTF8(resource-kind) || 0x00 ||
  UTF8(stable-resource-identity)
)
```

Stable identities:

```text
catalog:<kind>:<canonical-catalog-id>
imported:<canonical-instance-uuid>
```

The original identity string and UUID are not encoded in the capture.

Resources sort by:

1. kind order `skill`, `library`, `package`;
2. Unicode code-point order of canonical name;
3. resource ID.

Resource IDs are unique.

Git-linked profiles persist capture-ID bindings so later versions retain IDs. ZIP import always allocates fresh local imported-instance IDs.

### 3.4 Paths and blob closure

`profile.instructions.path` is exactly `AGENTS.md`.

Resource file paths are relative to each resource’s ready-to-use root and:

- are nonempty UTF-8;
- use `/`;
- are not absolute;
- contain no backslash;
- contain no empty, `.`, or `..` segment;
- contain no NUL, control character, or drive prefix;
- remain within existing depth/path limits.

Files within a resource sort by Unicode code-point path order and are unique under exact and portable case-fold comparison.

Preview paths are derived:

```text
profile/AGENTS.md
resources/<resource-id>/<resource-relative-path>
```

Blob closure is exact:

- blobs sort by digest;
- each digest appears once;
- every file references exactly one blob record;
- file and record byte counts match;
- every blob record is referenced;
- physical bytes match length and SHA-256;
- missing and orphan blobs are rejected.

Equal bytes may share a blob without merging logical resource instances.

### 3.5 Content boundary

Include:

- local direct Skill ready-to-use files;
- prepared local library files;
- current healthy package artifact-root files;
- remote ready-to-use files only with `--bundle-remote`.

Exclude:

- editable source projects;
- package source and build environment;
- build commands and tooling;
- tests and `node_modules`;
- Git history and `.git`;
- credentials and process environment, including case variants of `.env`, `.env.*`, known credential filenames, `credentials.*`, `.git-credentials.*`, OpenSSH private-key names (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` and their `.pub` companions), and private-key/container extensions (`.pem`, `.key`, `.p12`, `.pfx`); this is a finite filename policy, not secret scanning;
- runtime/model/provider settings;
- adapters and machine policy;
- publication linkage and local instance IDs.

Unbundled remotes retain exact Git identity.

`fetchUrl` must be canonical, credential-free, consistent with `remote`, and allowed by the existing managed-acquisition protocol policy. Reject userinfo, credential-like query data, fragments, unsafe protocols, and host/origin mismatch.

Reject symlinks and special files. Stable regular-file hardlinks are captured by value. Preserve only the executable bit.

## 4. ZIP and Git representation

Both transports contain exactly:

```text
bazframe-profile.json
blobs/<64-lowercase-sha256>
```

Git commits contain this exact tree. ZIP wraps the same tree.

### 4.1 Dependencies

Use exact runtime dependencies:

```text
yauzl@3.4.0
yazl@3.3.1
```

Use exact matching declaration packages when required. Record all exact versions in the lockfile and prove them with typecheck.

### 4.2 ZIP writer

- STORE only.
- Manifest first; blobs in digest order.
- No directory entries, comments, encryption, ZIP64, data descriptors, or extra fields.
- UTF-8 filename flag required.
- Fixed DOS timestamp `1980-01-01 00:00:00`.
- Normalized regular-file metadata.
- No link, device, FIFO, socket, sparse, or executable archive metadata.
- No prepended or appended bytes.
- Same capture produces identical ZIP bytes.

### 4.3 ZIP reader

Open lazily and validate raw local and central headers.

Reject:

- malformed/truncated records;
- multi-disk, ZIP64, encryption, unsupported methods, data descriptors, comments, or extra fields;
- duplicate names, portable case collisions, duplicate manifest/blob entries, and unknown entries;
- directory, absolute, traversal, backslash, NUL, control, invalid UTF-8, link, and special entries;
- missing UTF-8 flags;
- local/central name, size, CRC, flag, or method disagreement;
- overlapping ranges or entries outside the body;
- prepended/appended bytes;
- missing/orphan blobs;
- manifest/entry size disagreement;
- bound, CRC, or SHA mismatch;
- noncanonical order or metadata.

Require exactly one manifest and one entry for each manifest blob.

Dry-run streams, counts, CRC-checks, and hashes bodies without staging files.

## 5. Existing numeric authorities

No new numeric limit is introduced.

| Check | Existing authority |
|---|---|
| Manifest, sidecar, journal JSON | `artifactManifestBytes` |
| Membership entries | `profileEntries` |
| Resources | `resources` |
| Profile namespace | `profileNamespaceEntries` |
| ZIP/blob/tree entries | `stagingEntries` |
| Relative path depth | `stagingDepth` |
| Relative path bytes | `stagingPathBytes` |
| Individual blob | `checkoutFileBytes` |
| Archive input and extracted aggregate, separately | `stagingBytes` |
| GitHub API/Git process output | `gitStreamBytes` |
| Git metadata duration | `gitMetadataMilliseconds` |
| Git transfer duration | `gitCloneFetchMilliseconds` |
| Diagnostic item | `diagnosticBytes` |
| JSON/diagnostic aggregate | `diagnosticReportBytes` |
| Exact Git identity record | `provenanceBytes` |

Instruction-specific limits continue to apply. Test policies may only lower production limits.

## 6. Local state and identities

### 6.1 Layout

```text
$BAZFRAME_HOME/
  profiles/
    <profile-name>/
      AGENTS.md
      skills/...
      libraries/...
      packages/...
      .bazframe-profile-state.json

    .bazframe-candidate-<transaction-id>/
    .bazframe-backup-<transaction-id>/

  profile-publishing/
    blobs/<sha256>
    trees/<tree-id>/manifest.json
    trees/<tree-id>/root/...
    transactions/<transaction-id>.json
    operation-locks/<profile-lock-key>.lock
```

Reserved sibling names are never profile names and are excluded from profile enumeration.

`transaction-id` is exactly 32 lowercase hexadecimal characters generated from cryptographically random bytes.

A candidate and backup:

- are direct children of the same physical `profiles` parent as the destination;
- use only the exact reserved grammar above;
- are created no-follow and exclusively;
- must have the same device identity as the `profiles` parent before publication;
- never use an absolute or caller-controlled path token in a journal.

Journal path tokens are exactly:

```ts
type CandidateToken = `candidate:${TransactionId}`;
type BackupToken = `backup:${TransactionId}`;
```

Resolution is anchored to the trusted physical `profiles` parent. Cross-device publication is rejected before mutation.

A profile without a sidecar remains valid and needs no migration.

### 6.2 Sidecar

```ts
interface ManagedProfileStateV1 {
  schemaVersion: 1;
  profileInstanceId: string;
  publication: PublicationState | null;
  capturedResourceIds: CapturedResourceIdBinding[];
  importedResources: ImportedResourceState[];
}

interface PublicationState {
  transport: 'git';
  origin: string;
  installedCommit: CommitId;
  latestSeenCommit: CommitId;
  baselineCaptureSha256: Sha256;
  visibility: 'private' | 'public';
}

`baselineCaptureSha256` is `SHA256` of canonical `CapturedProfileV1` bytes after replacing only `profile.name` with the fixed valid sentinel `"profile"`. It is therefore invariant under local profile rename and sensitive to instructions, resource identities, payloads, files, blob records, modes, lengths, ordering, and every other transported field.

interface CapturedResourceIdBinding {
  resourceIdentityDigest: Sha256;
  capturedResourceId: Sha256;
  identityKind: 'catalog' | 'profileLocal' | 'imported';
  instanceId: string | null;
}

interface ImportedResourceState {
  instanceId: string;
  capturedResourceId: Sha256;
  key: CapturedResourceKey;
  source:
    | {
        kind: 'artifact';
        treeId: Sha256;
        origin?: ExactRemoteGitIdentity;
      }
    | {
        kind: 'remoteGit';
        identity: ExactRemoteGitIdentity;
        treeId: Sha256;
      }
    | {
        kind: 'missingRemoteGit';
        identity: ExactRemoteGitIdentity;
        diagnosticCode: string;
      };
}
```

Exact key order follows the interfaces. Union keys are `kind` followed by fields in declaration order. Optional keys are omitted.

Identity digest:

```text
SHA256(
  UTF8("bazframe-resource-identity-digest-v1\0") ||
  UTF8(stable-resource-identity)
)
```

`capturedResourceIds`:

- sorts by `resourceIdentityDigest`, then `capturedResourceId`;
- requires unique `resourceIdentityDigest`;
- requires unique `capturedResourceId`;
- records an explicit `identityKind`; classification is never inferred from content equality or the absence of imported state;
- stores `null` in `instanceId` only for ordinary catalog bindings;
- stores a canonical UUID in `instanceId` for profile-local and imported bindings;
- requires every non-null `instanceId` to hash with the domain selected by `identityKind` to `resourceIdentityDigest`, so retained identity cannot be reclassified.

`importedResources`:

- sorts by `instanceId`;
- requires unique `instanceId`;
- requires unique `capturedResourceId`;
- requires each `capturedResourceId` to identify exactly one captured resource;
- uses canonical UUID text for `instanceId`.

The sidecar is strict, bounded, canonical, no-follow, and Bazframe-managed.

### 6.3 Ordinary, profile-local, and imported instances

Stable identities are:

```text
catalog:<kind>:<canonical-catalog-id>
profileLocal:<canonical-resource-instance-uuid>
imported:<canonical-resource-instance-uuid>
```

For a sidecar-free profile, the provisional `profileInstanceId` is derived from the race-proved physical profile identity by SHA-256 domain separation, taking the first 16 bytes and setting canonical UUID version-8 and variant bits. Publication persists that exact provisional identity. A physical profile-local Skill instance UUID is derived the same way from `(profileInstanceId, canonical Skill name)` under a distinct domain.

- A physical direct Skill is transported with the non-identifying `sourceForm: 'profile-local'` marker. The marker is valid only on a bundled direct Skill and cannot be combined with `origin`; it transports no local instance/ownership ID, path, owner, profile instance, or publication linkage.
- Fresh ZIP/Git import allocates imported IDs for transported resources except a bundled direct Skill carrying that marker. A marked Skill is materialized as a new physical profile-local Skill with identity derived from the destination profile instance. An older origin-free bundle with no marker remains an imported immutable artifact.
- The destination profile-local binding remains keyed by the transported `CapturedResource.id`, even though its local identity is newly derived. Linked Git update/version therefore retains the local classification across publisher/importer identity differences.
- Duplicate preserves imported IDs because it shares those immutable instances, but derives new profile-local IDs because its copied physical Skills are independently mutable.
- Rename preserves the profile instance and therefore its profile-local IDs.
- Git update/version preserves each retained classification by captured resource ID. A retained profile-local bundled Skill materializes back into its physical `skills/<name>/` directory; it is never silently converted to a catalog or imported instance.
- Profile-local source-only files excluded from transport are preserved during ordinary update and discarded only by explicit overwrite.
- Removed and later reintroduced imported resources use retained bindings; profile-local identity remains derivable from profile identity and Skill name.
- Byte equality never changes identity.

Imported memberships live in the sidecar. Existing ordinary membership links and physical profile-local Skill directories remain unchanged.

### 6.4 Artifact trees

```ts
interface ArtifactTreeManifestV1 {
  schemaVersion: 1;
  kind: 'bazframe-artifact-tree';
  role: 'skill' | 'library' | 'packageArtifacts';
  files: BlobFile[];
}
```

Exact key order is `schemaVersion`, `kind`, `role`, `files`.

```text
treeId = SHA256(canonical ArtifactTreeManifestV1 bytes)
```

A tree is valid only when:

- canonical manifest bytes hash to the directory ID;
- a final regular `COMMITTED` marker contains the exact directory ID plus one newline;
- the marker is published last while the real operation lock is held, after all files, modes, directories, and the store parent are fsynced;
- readers reject a tree without that marker and therefore never observe partially populated final content;
- every root file is a physical regular file opened no-follow;
- bytes, hash, executable state, closure, and ordering match;
- no additional entry exists.

The hidden read-only store may land before transaction authority. Blob/tree publication and deletion remain unavailable until the transaction module supplies the real operation lock and journal/staging proof; a caller-constructible boolean is not authority.

### 6.5 Namespace

Combine ordinary registrations and imported instances referenced by current valid sidecars. Group by `(kind, canonical name)`.

- One logical instance displays as `name`.
- Multiple instances display as `profile/name`.
- A shared instance referenced by several profiles uses the lexically smallest profile name as its catalog display qualifier.
- Every current owning `profile/name` resolves to that shared instance.
- Resolution returns stable identity, never a path.
- Ambiguous/stale aliases fail without fallback.
- Removing a collision dynamically unqualifies the survivor.
- Membership never stores a display alias.

Canonical Skill names cannot contain `/`.

### 6.6 Reachability and cleanup

Roots:

- current valid sidecars;
- valid transaction journals;
- staging owned by a held operation lock.

Remove a tree only when no root references it. Remove a blob only when no retained tree references it.

Cleanup is post-success, identity-proven, no-follow, and nonessential to command success. Ambiguous state is retained. There is no timer, quota, or background collector. Cleanup APIs are not exposed before the transaction module can discover and validate every root while holding the real operation lock.

## 7. Race-safe profile closure identity

### 7.1 Canonical physical closure

Every candidate-swap or publication expectation includes:

```ts
interface PhysicalProfileExpectation {
  identity: string;
  sidecarSha256: Sha256 | null;
  profileClosureSha256: Sha256;
}
```

`profileClosureSha256` is:

```text
SHA256(
  UTF8("bazframe-physical-profile-closure-v1\0") ||
  canonical PhysicalProfileClosureV1 bytes
)
```

```ts
interface PhysicalProfileClosureV1 {
  schemaVersion: 1;
  profileName: string;
  entries: PhysicalProfileClosureEntryV1[];
}

type PhysicalProfileClosureEntryV1 =
  | {
      path: string;
      kind: 'file';
      sha256: Sha256;
      bytes: number;
      executable: boolean;
    }
  | {
      path: string;
      kind: 'membership-link';
      targetIdentity: string;
    }
  | {
      path: string;
      kind: 'managed-sidecar';
      sha256: Sha256;
      bytes: number;
    };
```

Exact key order follows each interface. Entries sort by path and are unique under exact and portable case-fold comparison.

Closure includes:

- `AGENTS.md`;
- every valid ordinary Skill/library/package membership link represented by semantic target identity rather than raw pathname spelling;
- every bounded regular file in each physical profile-local Skill, including source-only files excluded from transport, so local candidate copying cannot silently delete them;
- `.bazframe-profile-state.json` when present;
- every other managed physical entry required by the existing profile model.

Unknown, malformed, special, substituted, or unsupported entries prevent a closure digest.

Every `bytes` value is a nonnegative safe integer, not negative zero.

### 7.2 Required proofs

Before long-running work:

- anchor the physical profile;
- capture its physical identity and closure digest.

Immediately before destructive publication under the global state lock:

- re-open from the trusted profiles parent;
- prove physical identity, sidecar digest, and closure digest unchanged.

After renaming old profile to backup:

- prove backup physical identity;
- recompute and prove the same closure digest before candidate publication.

Before deleting backup:

- recompute and prove the same closure digest again.

If backup closure changes or cannot be proved:

- never delete it;
- retain the journal;
- mark the outcome ambiguous;
- emit recovery guidance.

Direct noncooperating filesystem edits remain a portable race, but no unproved backup is deleted.

All managed traversal, writes, replacement, and removal also require:

- physical-directory ancestor validation;
- no-follow opens;
- opened-handle regular-file checks;
- before/after identity checks;
- handle-relative traversal where the supported OS exposes a directory-fd namespace;
- explicit fail-closed behavior for operations that require handle-relative mutation when it is unavailable;
- path-revalidated read-only traversal and random private owned-staging writes on macOS, with complete physical-ancestry and pre/post identity proofs and the residual direct-writer race reported rather than described as handle-anchored;
- exclusive private staging;
- sibling-temp write, file fsync, rename, parent fsync;
- identity-proven cleanup;
- ambiguity retention after uncertain rename/fsync.

## 8. Locking, journals, and recovery

### 8.1 Lock order

A mutating command holds an OS-backed profile operation lock for the whole operation.

- Rename locks old/new names in lexical order.
- Duplicate locks source/destination names in lexical order.
- Global state lock is held only for bounded state inspection/publication/recovery.
- Operation lock precedes global state lock.
- Recovery acquires the operation lock nonblocking.
- A held lock means “operation in progress.”
- Abandonment is established by OS lock release, never PID-only evidence or timeout.

Operation-lock sockets remain beneath `$BAZFRAME_HOME/profile-publishing/operation-locks/`. Unix-domain socket pathname limits, notably Darwin's short pathname ceiling, therefore bound the usable canonical `BAZFRAME_HOME` length. If either private or canonical socket pathname is unsupported, Bazframe fails closed with `PROFILE_OPERATION_LOCK_PATH_UNSUPPORTED`; it does not relocate authority outside `BAZFRAME_HOME`. Disposable acceptance homes must use short physical paths.

The journal plus held lock forms the live staging lease.

### 8.2 Candidate swap

```ts
interface CandidateSwapJournalV1 {
  schemaVersion: 1;
  kind: 'candidate-swap';
  transactionId: string;
  operation: 'fresh-import' | 'overwrite' | 'update' | 'repair' | 'version-use';
  profileName: string;
  expectedOld:
    | { kind: 'absent' }
    | ({ kind: 'physical-directory' } & PhysicalProfileExpectation);
  candidate: {
    token: CandidateToken;
    identity: string | null;
    sidecarSha256: Sha256 | null;
    profileClosureSha256: Sha256 | null;
  };
  backup:
    | null
    | {
        token: BackupToken;
        identity: string;
        profileClosureSha256: Sha256;
      };
  activeProfileBefore: string | null;
  phase:
    | 'PLANNED'
    | 'MATERIALIZING'
    | 'PACKAGES_LAST'
    | 'CANDIDATE_READY'
    | 'OLD_RENAME_INTENT'
    | 'OLD_RENAME_PROVEN'
    | 'CANDIDATE_RENAME_INTENT'
    | 'CANDIDATE_RENAME_PROVEN'
    | 'ACTIVE_SELECTION_PROVEN'
    | 'COMMITTED'
    | 'ABORTED'
    | 'AMBIGUOUS';
  possiblePackageEffects: string[];
}
```

At `PLANNED`, candidate proof fields are null because materialization has not occurred. They may change only once from null to their exact proved values and are all required from `CANDIDATE_READY` onward. Package-effect IDs are append-only. Backup proof is required from `OLD_RENAME_PROVEN` onward. Every persisted update reads the current journal, permits exactly one directed phase transition, preserves immutable fields, fsyncs the replacement and parent, and refuses skipped, reversed, or terminal rewrites.

Existing-profile replacement:

1. prove expected old identity, sidecar, and closure;
2. fsync old-rename intent;
3. rename old to sibling backup;
4. prove backup identity and unchanged closure;
5. fsync old-rename proof;
6. fsync candidate-rename intent;
7. rename sibling candidate to destination;
8. prove candidate identity and closure;
9. prove active-selection name unchanged;
10. commit;
11. re-prove backup closure before cleanup.

Recovery:

- candidate at destination and expected old at backup: finish forward only after both closure proofs;
- expected old at destination and candidate staged: abort safely;
- destination absent, old proven at backup, candidate proven: finish candidate rename;
- substituted, duplicated, changed, unreadable, or otherwise unproved state: retain all and mark ambiguous.

Existing-profile failure preserves or recovers old linkage, installed commit, active name, prior missing-resource state, and profile bytes. A candidate with a larger missing set is never published.

### 8.3 Rename journal

Rename is durably journaled because directory rename, active-profile update, and favorites update are separate publications.

```ts
interface RenameProfileJournalV1 {
  schemaVersion: 1;
  kind: 'rename-profile';
  transactionId: string;
  oldName: string;
  newName: string;
  expectedOld: PhysicalProfileExpectation;
  expectedNew: { kind: 'absent' };
  activeBefore: string | null;
  activeAfter: string | null;
  favoritesBeforeSha256: Sha256 | null;
  favoritesAfterCanonicalBytesSha256: Sha256 | null;
  phase:
    | 'INTENT'
    | 'DIRECTORY_RENAME_INTENT'
    | 'DIRECTORY_RENAME_PROVEN'
    | 'ACTIVE_SELECTION_INTENT'
    | 'ACTIVE_SELECTION_PROVEN'
    | 'FAVORITES_INTENT'
    | 'FAVORITES_PROVEN'
    | 'COMMITTED'
    | 'ABORTED'
    | 'AMBIGUOUS';
}
```

Before intent:

- lock both names lexically;
- prove old expectation and new absence;
- calculate exact active/favorites before and intended after values;
- write/fsync journal.

Recovery predicates:

- old present with expected identity/closure and new absent: abort before rename or resume rename;
- old absent and new present with expected identity/closure: finish active/favorites publication forward;
- both present, both absent, closure changed, identity changed, or metadata before-state no longer provable: retain journal and mark ambiguous;
- active/favorites are published by canonical atomic writes and proved against intended after values;
- sidecar moves with the physical directory, preserving linkage and imported IDs.

Rollback after a proven directory rename is allowed only when new still has the expected identity/closure and old remains absent. Otherwise recovery finishes forward or retains ambiguity.

### 8.4 Publication journal

```ts
interface PublicationJournalV1 {
  schemaVersion: 1;
  kind: 'publication';
  transactionId: string;
  profileName: string;
  expectedProfile: PhysicalProfileExpectation;
  origin: string;
  expectedBaseCommit: CommitId | null;
  capturedManifestSha256: Sha256;
  originalVisibility: 'absent' | 'private' | 'public';
  desiredVisibility: 'preserve' | 'private' | 'public';
  repositoryCreated: boolean;
  repositoryId: number | null; // immutable positive GitHub repository database ID once proved
  observedCommit: CommitId | null;
  phase:
    | 'INTENT'
    | 'REPOSITORY_CREATED'
    | 'PRIVATE_BEFORE_PUSH_INTENT'
    | 'PRIVATE_BEFORE_PUSH_PROVEN'
    | 'PUSH_INTENT'
    | 'COMMIT_PUSH_PROVEN'
    | 'PUBLIC_AFTER_PUSH_INTENT'
    | 'PUBLIC_AFTER_PUSH_PROVEN'
    | 'LOCAL_STATE_INTENT'
    | 'LOCAL_STATE_PROVEN'
    | 'COMMITTED'
    | 'AMBIGUOUS';
}
```

Publication ordering:

1. capture and validate;
2. present exact preview;
3. obtain preview confirmation unless `--yes`;
4. for `--public`, present a distinct sensitivity warning and obtain confirmation unless `--yes`;
5. acquire operation lock;
6. revalidate profile expectation and write durable intent;
7. create absent repository when required;
8. if private is requested for a public repository, make and prove it private before push;
9. create first-publish repositories private, including `--public`;
10. refetch and revalidate expected base;
11. revalidate local closure before push;
12. record push intent;
13. create and exact-lease-push the commit;
14. prove exact parent and captured tree;
15. if public is requested, make and prove it public only after push;
16. revalidate local identity; update sidecar with published baseline, retaining dirty-local detection if current closure now differs from captured closure;
17. commit and clean up.

Without a visibility flag, preserve current visibility.

Recovery proves the journaled immutable GitHub repository ID, visibility, parent, tree, and local profile identity. It finishes local publication state only for the exact proved remote commit. It never adopts, deletes, rewrites, or merges a remote repository.

### 8.5 Other lifecycle operations

- Duplicate stages a physical copy, assigns a new profile instance ID, clears publication and publication bindings, preserves shared imported instance IDs, and publishes to an absent destination.
- Remove deletes only identity-proven local state. GitHub is untouched.
- Existing sidecar-free profiles remain valid and adopt a sidecar lazily.
- Old Stage 3 export directories remain unsupported.

## 9. GitHub and Git isolation

### 9.1 Source and ownership

Accept only:

```text
git:<user>/<repository>
```

Map exactly to:

```text
https://github.com/<user>/<repository>
```

Canonical origin:

```text
github.com/<canonical-owner>/<canonical-repository>
```

First publish is restricted to the authenticated user’s account. Import may use any repository the caller can read.

### 9.2 Tools

- GitHub CLI owns login and GitHub API authentication.
- System Git owns object transfer, validation, commits, and pushes.
- Public import may use Git without authenticated `gh`.
- Publish/private import require `gh`.
- Missing `gh` returns installation guidance.
- Human mode may run `gh auth login --hostname github.com --git-protocol https --web`.
- JSON and dry-run never log in.
- Bazframe never extracts, persists, or prints a GitHub token.
- Never invoke `gh auth setup-git`.

### 9.3 Process environment

Every Git subprocess uses a newly constructed allowlisted environment, not inherited `process.env`.

Allowed values are limited to those needed for:

- executable lookup;
- locale normalization;
- temporary directory;
- isolated Git home/config;
- explicit `GH_CONFIG_DIR` for the fixed `gh auth git-credential` helper when authenticated access is needed.

Required isolation:

```text
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=<empty-private-file>
HOME=<empty-private-directory>
XDG_CONFIG_HOME=<empty-private-directory>
GIT_TERMINAL_PROMPT=0
```

Clear or omit:

- all inherited `GIT_CONFIG_*` except the explicit values above;
- `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_SSH`, `GIT_SSH_COMMAND`;
- repository-altering Git environment variables;
- credential, proxy, tracing, object-directory, index, worktree, and alternate-object variables not explicitly required;
- editor/pager variables.

Every Git invocation supplies fixed process-local configuration:

```text
-c credential.helper=
-c core.hooksPath=<empty-private-directory>
-c protocol.allow=never
-c protocol.https.allow=always
```

For authenticated canonical GitHub HTTPS only, append one fixed helper:

```text
-c credential.helper=!gh auth git-credential
```

Local bare-repository tests may explicitly enable `protocol.file`; production GitHub flow may not.

Further requirements:

- operate only in Bazframe-created quarantine repositories with strict allowlisted local config;
- disable hooks for commit, fetch, and push;
- reject URL rewrite configuration and all inherited local/global/system config;
- never use repository-supplied hooks/config;
- never fall back from authenticated flow to unauthenticated flow;
- never inherit stdin except explicit human `gh auth login`;
- bound duration/output;
- sanitize diagnostics.

Portable Node cannot prove that a descendant which created a new process session has stopped using a workspace, and it cannot perform race-free handle-relative recursive deletion on both supported operating systems. Therefore every directory exposed to `git`, `gh`, or their helpers—including exact-revision resource-acquisition homes under `profile-publishing/remote-materialization/`—is a private random retained quarantine after use: disposal proves that the pathname still names the opened physical identity, closes Bazframe's handles, and performs no traversal, unlink, rename, or removal. Expected retention is nonessential to command success. Identity ambiguity fails closed without exposing the private path or deleting either the original or a substitute. Reclamation requires a separately approved native containment/cleanup design and is outside this slice.

### 9.4 Repository and versions

Repository tree is exactly the captured manifest/blobs.

Internal ref:

```text
refs/heads/main
```

Every publish creates a commit, including identical-tree publish.

Version selection:

- accepts nonempty lowercase hex prefix or full ID;
- resolves only reachable commits;
- requires exactly one match;
- stores full ID;
- rejects rev syntax, tags, unreachable commits, and ambiguity.

Linked publication requires local base equal to remote tip.

Immediately before push:

1. fetch the owned ref;
2. prove exact expected tip;
3. create commit with that parent;
4. push with exact lease.

Lease failure is stale refusal. No merge, rebase, rewrite, or retry against a changed base.

First publish refuses an existing unlinked repository.

## 10. Materialization and incompleteness

Bundled resources:

- validate and publish immutable blobs/trees;
- materialize build-free;
- require no package-build consent.

Unbundled resources:

- use exact-revision acquisition;
- never substitute branch HEAD;
- reuse exact healthy cache offline;
- retain package risk report and explicit consent;
- execute packages last;
- revalidate authorization inputs before and after consent.

Only unavailable unbundled remote material during **initial imported-profile creation** may create `missingRemoteGit`.

Ordinary local profile creation remains complete.

Malformed archive/tree, integrity error, declined build, build failure, authorization drift, bundled-resource failure, or arbitrary execution error never becomes incomplete success.

`profile use` allows incomplete activation with warning.

Update, repair, version use, and overwrite cannot increase the existing missing set.

Publish refuses incomplete profiles. Export remains allowed.

## 11. JSON contracts

### 11.1 Schema ownership

Schema v2 applies only to:

```text
profile publish
profile export
profile import
profile update
profile version list
profile version use
```

All unrelated JSON commands continue to emit their existing schema-v1 envelopes and result semantics. There is no global schema bump and no dual negotiation for the lifecycle commands.

Only `profile import` supports dry-run.

JSON never prompts or starts login.

### 11.2 Lifecycle v2 envelope

```ts
type JsonLifecycleV2<T> =
  | {
      schemaVersion: 2;
      command: string;
      outcome: 'success';
      result: T;
      diagnostics: JsonDiagnosticV2[];
    }
  | {
      schemaVersion: 2;
      command: string;
      outcome: 'refusal';
      refusal: JsonRefusalV2;
      diagnostics: JsonDiagnosticV2[];
    }
  | {
      schemaVersion: 2;
      command: string;
      outcome: 'error';
      error: JsonErrorV2;
      diagnostics: JsonDiagnosticV2[];
    };

interface JsonRefusalV2 {
  code: string;
  message: string;
  interaction:
    | { kind: 'none' }
    | {
        kind: 'confirmation-required';
        confirmations: Array<
          'publish-preview' |
          'public-visibility' |
          'package-build'
        >;
        acceptedBy: '--yes';
      }
    | {
        kind: 'overwrite-required';
        operation:
          | 'replace-profile'
          | 'discard-local-changes'
          | 'replace-output';
        acceptedBy: '--overwrite';
      }
    | {
        kind: 'collision-choice-required';
        suggestedName: string;
        safeDefaultAcceptedBy: '--yes';
        replacementAcceptedBy: '--overwrite';
      };
  details?: JsonDetailsV2;
}

interface JsonErrorV2 {
  category:
    | 'usage'
    | 'authentication'
    | 'network'
    | 'integrity'
    | 'operational'
    | 'internal';
  code: string;
  message: string;
  details?: JsonDetailsV2;
}

interface JsonDiagnosticV2 {
  level: 'warning' | 'info';
  code: string;
  message: string;
}

type JsonDetailsV2 = Record<string, JsonScalar | JsonScalar[]>;
type JsonScalar = string | number | boolean | null;
```

Exact top-level and nested key order follows declaration order. Empty optional details are omitted.

### 11.3 Shared lifecycle v2 fields

```ts
interface JsonProfileStateV2 {
  name: string;
  active: boolean;
  completeness: 'complete' | 'incomplete';
  missingResources: JsonMissingResourceV2[];
  publication: JsonPublicationV2 | null;
}

interface JsonMissingResourceV2 {
  kind: ResourceKind;
  name: string;
  code: string;
}

interface JsonPublicationV2 {
  repository: string;
  installedCommit: string;
  latestSeenCommit: string;
  visibility: 'private' | 'public';
}

interface JsonCapturedFileV2 {
  logicalPath: string;
  resourceKind: ResourceKind | 'profile';
  resourceName: string | null;
  bytes: number;
  sha256: Sha256;
  executable: boolean;
}

interface JsonMutationEffectsV2 {
  localStateWritten: boolean;
  profilePublished: boolean;
  cacheWritten: boolean;
  lockAcquired: boolean;
  buildExecuted: boolean;
  loginStarted: boolean;
  repositoryCreated: boolean;
  refUpdated: boolean;
  commitCreated: boolean;
  visibilityChanged: boolean;
}
```

All numeric byte values are nonnegative safe integers.

### 11.4 Lifecycle v2 results

```ts
interface JsonProfileExportResultV2 {
  profile: JsonProfileStateV2;
  output: string;
  captureSha256: Sha256;
  files: JsonCapturedFileV2[];
  overwritten: boolean;
}

interface JsonProfilePublishResultV2 {
  profile: JsonProfileStateV2;
  repository: string;
  commit: string;
  visibility: 'private' | 'public';
  captureSha256: Sha256;
  files: JsonCapturedFileV2[];
}

interface JsonProfileImportResultV2 {
  mode: 'executed' | 'dry-run';
  source:
    | { kind: 'zip' }
    | {
        kind: 'git';
        repository: string;
        resolvedCommit: string;
      };
  requestedName: string;
  resolvedName: string;
  collisionResolution: 'none' | 'safe-suffix' | 'overwrite';
  profile: JsonProfileStateV2 | null;
  effects: JsonMutationEffectsV2;
}

interface JsonProfileUpdateResultV2 {
  profile: JsonProfileStateV2;
  previousCommit: string;
  currentCommit: string;
  movedToNewCommit: boolean;
  repairedResources: JsonResourceKeyV2[];
}

interface JsonProfileVersionListResultV2 {
  profile: string;
  currentCommit: string;
  latestCommit: string;
  versions: JsonVersionV2[];
}

interface JsonProfileVersionUseResultV2 {
  profile: JsonProfileStateV2;
  previousCommit: string;
  currentCommit: string;
}

interface JsonVersionV2 {
  commit: string;
  current: boolean;
  latest: boolean;
}

interface JsonResourceKeyV2 {
  kind: ResourceKind;
  name: string;
}
```

Dry-run import has `profile: null` and every mutation-effect field `false`.

A public publish requiring both confirmations reports:

```json
["publish-preview", "public-visibility"]
```

`--yes` accepts routine confirmations only. `--overwrite` authorizes replacement/discard only.

### 11.5 Exact schema-v1 profile projection extensions

Existing profile-list/status JSON envelopes remain schema v1.

Each existing profile projection object may append these optional keys, in this exact order after all pre-existing keys:

```ts
interface JsonProfileStateV1OptionalExtension {
  completeness?: 'complete' | 'incomplete';
  missingResources?: JsonMissingResourceV1[];
  publication?: JsonPublicationV1;
}

interface JsonMissingResourceV1 {
  kind: ResourceKind;
  name: string;
  code: string;
}

interface JsonPublicationV1 {
  repository: string;
  installedCommit: string;
  latestSeenCommit: string;
  visibility: 'private' | 'public';
}
```

Rules:

- omit all three fields for an ordinary complete unpublished profile to preserve its existing schema-v1 bytes;
- for a managed complete profile, encode `completeness: "complete"`, `missingResources: []`, then `publication` when linked;
- for an incomplete profile, encode `completeness: "incomplete"`, sorted nonempty `missingResources`, then optional `publication`;
- `missingResources` sorts by kind order, name, then code;
- `publication` is omitted when unpublished, never `null`;
- no other schema-v1 field changes.

Human status, activation warning, and TUI consume the same domain projection but are not relabeled as JSON schema v2.

### 11.6 JSON transport and privacy

- Exactly one bounded JSON document plus newline.
- No prompts.
- Routine confirmation requires `--yes`.
- Replacement/discard requires `--overwrite`.
- Exact preview is not truncated; refuse if it cannot fit.
- Exclude Stage 3 partial results, mappings, omitted-Skill fields, artifact directories, causes, stacks, environment, tokens, private checkout paths, and build environment.
- Never relay raw child output.

Exit statuses:

- success `0`;
- refusal/usage `2`;
- operational error `1`;
- interruption uses existing signal-derived status.

## 12. Human diagnostics

Construct diagnostics from allowlisted Bazframe codes and validated fields.

Raw child output is not relayed by default. Any approved excerpt must:

- strip terminal controls;
- redact known credential headers, URL userinfo, tokens, environment values, private managed paths, and temporary paths before bounding;
- exclude raw GitHub API bodies;
- safe-normalize hostile ZIP names;
- be tested in human and JSON modes for private evidence and controls.

## 13. Public CLI contract

The completed public surface exposes:

```text
bazframe profile export
  [--profile <name>]
  [--output <zip-path>]
  [--overwrite]
  [--bundle-remote]
  [--json]

bazframe profile publish
  [--profile <name>]
  [--public | --private]
  [--bundle-remote]
  [-y | --yes]
  [--json]

bazframe profile import <zip-path | git:user/repository>
  [--commit <full-or-unique-prefix>]
  [--dry-run]
  [--overwrite]
  [-y | --yes]
  [--json]

bazframe profile update
  [--profile <name>]
  [--overwrite]
  [--json]

bazframe profile version list
  [--profile <name>]
  [--json]

bazframe profile version use <commit>
  [--profile <name>]
  [--overwrite]
  [--json]
```

Defaults:

- export/publish/update/version target active unless `--profile`;
- export writes `./<profile-name>.bazframe-profile.zip`;
- Git import selects latest unless `--commit`;
- imported profiles remain inactive;
- first publish is private;
- no visibility flag preserves current visibility;
- collision suffixes are `<name>-1`, `<name>-2`, …;
- `--yes` chooses safe suffix;
- `--overwrite` chooses replacement;
- active-profile replacement leaves it active.

Negative surface:

- no `--force`, `--as`, or `--map`;
- no directory artifact or partial-result DTO;
- no branches, merges, rebases, or rewrite controls;
- no `profile unpublish` or repository deletion;
- no dry-run outside import;
- no incomplete-publication override.

`bzf` uses the same entrypoint and behavior.

## 14. Hidden implementation boundaries

Create only after this contract is recorded:

```text
src/profile-publishing/
  captured-profile.ts
  captured-profile-policy.ts
  profile-capture.ts
  blob-store.ts
  artifact-tree.ts
  managed-profile-state.ts
  imported-resource-store.ts
  resource-namespace.ts
  profile-materialization.ts
  profile-transaction.ts
  profile-zip.ts
  github-control-plane.ts
  github-git-transport.ts
  profile-lifecycle.ts
  profile-view.ts
  contracts.ts

src/cli/
  json-v2.ts
  profile-publishing-presentation.ts
```

Rules:

- capture knows no transport;
- ZIP and Git use the same capture;
- transports never publish local profile state;
- materialization never chooses collision policy;
- transaction owns replacement/recovery;
- namespace resolves identity, not display path;
- presentation performs no effects;
- parser/help remain unchanged until cutover.

Cutover must migrate every consumer that assumes the current profile representation:

- add/create/edit/use/list/current;
- rename/duplicate/remove/favorites;
- Skill membership;
- library/package references;
- status/TUI;
- Pi runtime composition;
- export/import/publish/update/version;
- active-profile selection.

Profiles remain physical directories.

## 15. Implementation gates

1. Record this contract and replace the resolved-engineering list in `docs/profile-publishing-design.md`.
2. TDD canonical capture codec and lower-only policy.
3. TDD sidecar, imported projection, blobs/trees, and build-free capture.
4. TDD materialization, candidate-swap, rename, and publication journals with fault injection.
5. TDD strict ZIP.
6. TDD isolated GitHub/Git transport with injected fakes and local bare repositories.
7. TDD hidden lifecycle services.
8. TDD namespace, unified projection, lifecycle JSON v2, schema-v1 optional projections, and lazy sidecar adoption.
9. Independently review hidden services.
10. Expose parser, help, dispatch, lifecycle JSON, docs except `docs/design.md`, generated Skill, status, and TUI in coherent reviewable slices; require their agreement at the packed acceptance gate.
11. Run full release-readiness validation without release.

No public command is exposed before gate 10.

## 16. Required evidence

| Contract | Evidence |
|---|---|
| Capture | exact keys/order, safe integers, duplicate-key rejection, canonical bytes, path/blob closure |
| Content | exact ready-to-use bytes, excluded source/Git/env/tests, zero builds |
| Filesystem | anchored no-follow, handle identity, closure CAS, backup reproving, substitution races |
| Sidecar | sidecar-free compatibility, exact digest/order/uniqueness, malformed refusal |
| Trees | canonical hash, root closure, corruption/substitution |
| ZIP | deterministic bytes, hostile structures, bounds, CRC/SHA, no-write dry-run |
| Git | isolated config/HOME/hooks/env, canonical URL, local bare remotes, exact lease, prefix ambiguity |
| Authentication | missing `gh`, human login, JSON/dry-run no login, no credentials |
| Identity | ordinary sharing, imported IDs, rename retention, duplicate sharing, Git-origin idempotence |
| Namespace | unique/unqualified, collisions, dynamic unqualification, stale alias refusal |
| Candidate swap | every phase fault-injected, same-device sibling proof, closure CAS, active overwrite |
| Rename | crash after each phase, old/new predicates, active/favorites recovery |
| Publication | private-before-push, public-after-push, two confirmations, exact lease, forward recovery |
| Packages | publish/export/bundled import zero builds; exact unbundled report/consent; package-last |
| Incomplete | only unavailable unbundled initial imported-profile creation; ordinary creation complete |
| JSON | exact lifecycle v2; unrelated schema v1; exact optional list/status extensions; privacy |
| CLI | every flag/default/negative rule in §13 |
| Consumers | all consumers in §14 work with sidecars/imported instances |
| Packed | deterministic fake GitHub/Git, ZIP, both executables, zero forbidden mutation |
| Final | build, typecheck, lint, unit, integration, pack, aggregate tests, pack inspection, independent review |

## 17. Residual risks

- GitHub remote effects and local sidecar state cannot form one transaction; the journal supports proof and forward recovery, not remote rollback.
- Portable filesystem races cannot be eliminated against noncooperating direct writers; changed or unproved backup state is retained rather than deleted.
- Rename/fsync outcomes can remain ambiguous; identity evidence and journals must be retained.
- Unsandboxed package subprocesses can leave external effects.
- GitHub CLI is a visible prerequisite for publish/private import.
- Newly created repository behavior still needs deterministic fake coverage and separately authorized live acceptance.
- Exact ZIP dependencies require normal supply-chain maintenance.
- Git/GitHub workspaces are intentionally retained private quarantines because portable process-tree settlement and race-free recursive deletion cannot be proved; they can contain sensitive repository objects or captured blobs and create an unbounded storage/privacy cost until a separately authorized reclamation design exists.
- Other ambiguous cleanup may also retain identity-proven state rather than claim deletion.

## Review findings

- **No unresolved blocker or high-severity finding in this corrected contract.**
- **Closed — product:** lifecycle-only schema v2; unrelated schema v1; exact optional list/status extensions; incomplete creation clarified as imported-profile creation.
- **Closed — security:** system/global Git configuration suppression, isolated HOME/config, disabled hooks, allowlisted environment, canonical URL controls, and physical-profile closure CAS with backup reproving.
- **Closed — recovery:** same-device hidden sibling candidate/backup grammar and durable rename journal covering names, active selection, and favorites.
- **Closed — canonical state:** domain-separated resource identity digest, exact sidecar sorting/uniqueness, and nonnegative safe-integer byte fields.
- **Preserved:** prior archive, visibility-ordering, no-follow, operation-lock, hostile-ZIP, diagnostic, dry-run, package, identity, and atomic-cutover corrections.
- **Repository paths affected during implementation:** `docs/profile-publishing-design.md`, `src/profile-publishing/**`, `src/profiles/profile-management.ts`, `src/profiles/profile-store.ts`, `src/providers/managed-git-process.ts`, `src/cli/json-protocol.ts`, `src/cli/command-results.ts`, and their tests.
- **Scope:** `docs/design.md` remains unchanged.