# Native Windows Full-Product Outcome-Parity Proposal

> **Status: Approved design direction; foundation implementation in progress**
>
> Native Windows remains unsupported. Bazframe will make no partial Windows support claim: the complete current product surface in this document must pass native Windows installed-package acceptance before Windows x64 on local NTFS is supported. [`design.md`](design.md) remains the product source of truth, and the shipped macOS/Linux contract is unchanged.

## 1. Decision and support boundary

Bazframe will pursue observable outcome parity with its supported macOS/Linux behavior rather than prescribe a bespoke native API or claim a stronger Windows security boundary. Bazframe TypeScript continues to own ZIP and path policy, Git behavior, lifecycle decisions, journaling and recovery direction, profile/resource identity, consent, presentation, and Pi projection. A Windows filesystem layer supplies only the capabilities needed to achieve those outcomes.

Windows support is one atomic product gate. Internal command-specific capability gates may sequence implementation and testing, but they must not create user-visible partial support. Until every surface in section 2 passes its applicable acceptance gates, Windows remains unsupported and every Windows command that could read managed state, mutate, recover, launch a managed editor/process, or enter the TUI must fail through the central platform gate before those effects.

Pure help, version, command parsing, syntax errors, and migration guidance remain platform-neutral. They must not initialize the Windows filesystem layer or be accidentally blocked by its gate.

The initial platform boundary, once fully accepted, is native Windows x64 with managed state on accepted local NTFS. It does not imply Windows ARM64, another filesystem, network-backed managed state, or broader TUI terminal coverage.

## 2. Required current product surface

The Windows support claim includes the complete current CLI and TUI product, not only a fresh-import path.

### 2.1 CLI and runtime surface

Installed-package acceptance must cover:

```text
bazframe profile list|current|add|duplicate|remove|rename|use|edit|export|publish|import|update
bazframe profile version list|use
bazframe skill list|add|update|remove|edit
bazframe library list|add|update|remove
bazframe package list|add|build|update|remove
bazframe profile skill list|add|remove
bazframe profile library list|add|remove
bazframe profile package list|add|remove
bazframe project list|enable|disable
bazframe global show|enable|disable
bazframe adapter list|install|uninstall
bazframe pi [--dry-run] [-- <Pi args>]
bazframe status
bazframe tui
```

This includes ZIP dry-run, fresh/safe-suffix import, ZIP import with `--overwrite`, Git import, ZIP export, publish, update, and version list/use. It includes local and remote Git Skill/library/package acquisition and update, package build execution, profile resource references, profile favorites, Pi adapter provisioning, and installed Pi projection. Both `bazframe` and `bzf` must expose equivalent behavior wherever the existing dispatcher makes the surface available.

### 2.2 Existing TUI boundary

Windows support includes the currently implemented keyboard-first TUI, not new TUI features. It must preserve:

- the read-only Skills, Profiles, Adapters, and Settings presentations and diagnostics;
- collapsible Added Skill, library, package, and child-Skill rows and previews;
- profile create, duplicate, use, favorite toggle, rename, guarded remove, and instruction editing;
- Added Skill editing and selected-profile Added Skill membership add/remove;
- consent-bound addition of a prepared local library or acquisition of a remote Git library, without adding a profile reference or running source code;
- compact/wide navigation, focus, viewport, accessibility, error, refresh, and terminal restoration behavior; and
- the existing external-editor handoff from profile and Added Skill routes.

The existing CLI-only boundary is unchanged. Profile sharing, Skill add/update/remove, package add/build/update/remove, library update/remove, library/package profile-reference mutation, policy/adapter writes, and source move/rename are not added to the TUI merely to support Windows. Adapter and Settings views remain read-only. The CLI surfaces listed in section 2.1 must nevertheless work on supported Windows.

## 3. Storage and threat boundary

### 3.1 Accepted managed storage

`BAZFRAME_HOME`, Bazframe temporary/staging roots, profile candidates/backups/quarantines, resource state and snapshots, Git/`gh` workspaces, journals, locks, and other managed state must be on an accepted local Windows volume. The first accepted filesystem is local NTFS. Bazframe must reject before sensitive work or recovery when locality, filesystem behavior, identity, privacy, sharing, or required same-volume rename behavior cannot be proved.

The managed-storage boundary rejects UNC paths, mapped remote drives, SMB and other network filesystems, cloud-placeholder roots, FAT, exFAT, ReFS, and every filesystem not separately proved and accepted.

An untrusted ZIP may originate on unsupported or network storage only by a bounded byte copy into proved owner-private accepted local staging before archive parsing or validation. The source is never treated as managed state or traversed as a profile tree. A copy that cannot prove its bound and complete local result fails without managed publication.

Git and GitHub network transport are allowed. All checkouts, worktrees, control state, and process working directories remain in proved private accepted local staging. Network transport does not authorize network-backed `BAZFRAME_HOME` or staging.

External roots used by the current product have these explicit boundaries:

| External root | Windows x64/local-NTFS boundary |
| --- | --- |
| Local Skill, library, or package source; Added Skill editor target/cwd | Must independently pass local-NTFS, physical-ancestry, reparse, and stable-read admission. It may be on a different accepted local volume from `BAZFRAME_HOME`. |
| Canonical Git project worktree | Must independently pass local-NTFS identity admission before project-specific policy resolution or mutation. Project policy bytes remain under `BAZFRAME_HOME`; Bazframe does not write policy into the worktree. |
| Configured Pi agent directory | Must independently pass local-NTFS, privacy, ancestry, and external-publication admission. It may be on a different accepted local volume because its writes use private siblings within that directory, not cross-volume rename from `BAZFRAME_HOME`. |
| ZIP export destination | Must independently pass local-NTFS ancestry and same-directory atomic-publication admission. It may be on a different accepted local volume from `BAZFRAME_HOME`. |
| ZIP import source | May be on unsupported or network storage only through the bounded private-local copy rule above. |

Every unsupported external root produces a category-specific actionable storage diagnostic before Bazframe creates a link, launches a build/editor/helper, writes policy or adapter state, or publishes output. Bounded ZIP-source copying and Git network transport are the only remote-input exceptions in this boundary.

An unsupported managed location must produce an actionable storage diagnostic and remain unchanged. It must not be reported as ordinary profile drift or archive corruption.

### 3.2 Protected conditions

The Windows design protects against:

- untrusted ZIP, Git, profile, resource, manifest, process-output, path, and name inputs;
- pre-existing malformed, aliased, special, or unexpected reparse-backed state;
- access by other ordinary local users;
- concurrent cooperating Bazframe processes;
- process interruption;
- ordinary user edits, filesystem drift, and sharing failures from editors, antivirus, indexers, or other open handles;
- disclosure through insufficiently private active or retained state; and
- replacement or discarded local state without explicit overwrite consent.

Detected drift fails closed. If an operation may have mutated state but its result cannot be proved, Bazframe inspects journaled predicates, retains relevant private state, and reports an actionable ambiguous outcome rather than guessing.

Deliberate concurrent mutation by a process already running with the same Windows user authority is outside the boundary, as are administrator, kernel, compromised-native-module, and physical-device attacks. Windows retains the supported-platform residual race between final metadata/path revalidation and a pathname-based syscall, plus the possibility that deliberately restored metadata hides an in-place change. Stronger primitives may narrow those races, but support does not claim to eliminate them.

## 4. Installation and dependency boundary

Native Windows support must arrive through ordinary installation:

```text
npm install bazframe
npm install --global bazframe
```

Installation and first use require no compiler toolchain, Visual Studio, Rust, WSL, Git Bash, interactive installer, postinstall binary download, or runtime binary download. A release admitted to open Windows support bundles the exact reviewed `artifacts/native/win32-x64-msvc/bazframe-win32.node`, produced from pinned source under `native/win32/`, inside the Bazframe root tarball. The fixed package-relative loader selects it only on native Windows x64 and validates its contract, target, and package version. A missing, corrupt, wrong-target, ABI-incompatible, version-mismatched, or malformed bundled artifact produces a specific remediation diagnostic before Windows-sensitive work.

Any accepted capability that depends on native behavior must fail closed rather than silently substitute a mechanism weaker than that capability's tested contract. A guarded pathname implementation is allowed where this document expressly accepts the supported-platform residual race and native Windows acceptance proves the required outcome. Native source dependencies and toolchains are pinned, and the compiled binary, source commit, tests, and digest form one reviewed evidence set. The accepted binary ships inside the existing single Bazframe npm artifact; no installation lifecycle script or secondary platform package is required. While the public gate remains closed, ordinary releases omit the unaccepted binary.

## 5. Common filesystem outcomes

Every product group in section 6 composes these common outcomes as applicable.

### 5.1 Central platform and capability gates

One central Windows platform gate must deny the effectful product surface until the full support gate passes. Behind it, explicit command-capability checks may safely sequence development and tests. No command becomes publicly supported merely because its narrower capability tests pass or because portable Node happens to execute it.

Internal capability refusal must occur before mutation, transaction recovery, stale-lock reclamation, external process launch, adapter/policy writes, or TUI state access that could trigger recovery. The packaged Pi extension must perform the same platform gate before startup, reload, or `/bazframe info` reads or recovery. The gate applies consistently to local/global installs and both executable names. Help/version/syntax paths bypass filesystem initialization and remain platform-neutral.

### 5.2 Name policy, containment, reparses, and identity

Bazframe TypeScript remains authoritative for ZIP parsing, portable artifact paths, component collision/equivalence policy, Windows-reserved names, alternate-data-stream syntax, trailing period/space aliases, case collisions, limits, and manifest validation.

The filesystem layer must provide enough lossless evidence for Bazframe to:

- prove managed ancestry and traversed entries remain beneath the intended physical root;
- reject unexpected symlinks, junctions, mount points, cloud placeholders, other reparse tags, and special entries;
- never recursively traverse a reparse point;
- bind identity-sensitive read, recovery, publication, membership, and reclamation decisions to lossless volume/file identity suitable for accepted NTFS; and
- revalidate identity and closure immediately before and after pathname-based effects.

Only product-authorized representations are exceptions: exact membership directory symlinks/junctions and the documented contained final-file links accepted by profile/Skill editor launch. Every other managed reparse is refused. A particular `FileIdInfo` width is not required, and lossy JavaScript numeric identity never authorizes an effect.

### 5.3 Owner-private state from first visibility

Every sensitive home, copied input, checkout, staging root, journal, candidate, backup, quarantine, snapshot, lock, publication workspace, adapter state, and retained ambiguous path must be owner-private from first visibility. Safe ACL inheritance is acceptable only when its parent has already been proved to provide the required effective protection. Otherwise the entry must receive effective owner-private protection at creation; tightening an initially broader ACL later is insufficient.

An existing root whose effective privacy cannot be proved must be rejected or pass an explicitly accepted repair flow before sensitive work. Privacy excludes other ordinary users while permitting only the owning user and system/administrative access necessary to administer the machine.

### 5.4 Stable bounded reads and enumeration

A security-relevant file read must:

- open one accepted regular file without following an unexpected reparse and return bytes from that opened handle;
- enforce the Bazframe-supplied byte bound while reading;
- use lossless identity for authorization and compare identity, size, available change evidence, and byte count before and after the read;
- fail on incomplete input or detected change; and
- participate in final identity/closure revalidation before a dependent mutation, capture, process launch, or projection.

Directory enumeration must be bounded, reject unexpected reparses/special entries, produce deterministic Bazframe ordering, and support pre/post ancestry and closure evidence. Share denial and a particular native change token are permitted hardening, not requirements. The contract does not claim to detect a deliberate same-size or timestamp-restored mutation by an excluded same-authority process.

### 5.5 Cooperating-writer serialization

Mutations and any recovery that can mutate state must serialize cooperating Bazframe writers using canonical roots, deterministic operation keys, and existing global/profile/resource lock order. The lock design must ensure that:

- two Bazframe processes cannot simultaneously hold conflicting authority;
- process interruption cannot create overlapping live owners;
- elapsed time alone never authorizes stale-state removal;
- dead-owner recovery uses positive liveness/ownership evidence and cannot delete a newly acquired lock; and
- unproved ownership or interrupted recovery fails closed with actionable retained state.

An OS-released lock or safely guarded sidecar protocol may satisfy these outcomes. No particular native call, opaque capability object, or native tri-state return is required.

### 5.6 Atomic files, directory publication, and recovery

Atomic state-file writes require exclusive private temporary creation, complete bounded write, flush, strict existing-state validation, serialized atomic publication/replacement, and post-read evidence. Bazframe may derive committed, definite no-effect, or ambiguous status from its journal and observed predicates; the filesystem layer need not return a native tri-state result.

Directory publication uses fresh private same-volume siblings. Fresh publication must not replace an occupied destination. Existing-profile/resource replacement must:

1. validate expected-old and candidate identities and closures under the operation lock;
2. preserve explicit overwrite/discard authorization—`--yes` never implies `--overwrite`;
3. durably record intent before each dependent namespace mutation;
4. rename the old destination to a private backup/quarantine and publish the candidate to the absent destination;
5. prove resulting old/candidate/backup/destination predicates and active-selection state; and
6. recover after interruption from strict journal records plus observed identity/closure predicates.

No source-identity-bound rename or native identity-bound file replacement is required solely to defeat the excluded same-user attacker. An unproved outcome remains private and retained rather than guessed. Regular files and recovery records are flushed before dependent mutation. Windows acceptance does not claim POSIX directory-`fsync` equivalence or stronger sudden-power-loss durability.

### 5.7 Logical executable metadata

Windows need not represent POSIX executable mode physically. Bazframe preserves captured executable bits as validated logical manifest metadata so ZIP/Git transport and later export do not lose portable meaning.

## 6. Product capability groups

These groups organize implementation and acceptance evidence only. They do not authorize partial Windows support.

### 6.1 ZIP capture, import, export, and replacement

ZIP dry-run remains bounded and effect-free with respect to Bazframe state. ZIP input from unaccepted storage is first copied as bounded untrusted bytes into proved private accepted local staging. Capture and export use stable bounded closure reads, exact preview/exclusion policy, deterministic ZIP output, and atomic destination publication. Existing output refuses unless `--overwrite` explicitly authorizes replacement.

Fresh import publishes a complete inactive profile to an absent or accepted safe-suffix destination. Overwrite import uses the full candidate/backup transaction, preserves active selection when replacing the active profile, and never treats occupancy or `--yes` as overwrite consent. Imported Skill/library/package materialization, stable identities, dynamic collision qualification, package-artifact handling, and Pi projection retain the current product contract.

### 6.2 Git import, update, versioning, and publication

All Git/`gh` and exact-revision acquisition processes retain the shipped isolated environment, no-shell execution, disabled prompting/hooks, bounded output and duration, termination handling, exact revision/reachability rules, and authentication/consent boundaries. Network transport is allowed, but every checkout and workspace is owner-private on accepted local NTFS.

Git import, `profile update`, and `profile version use` use expected-old closure checks, fresh candidates, candidate/backup recovery, exact Git revisions, active-selection preservation, and explicit discard authorization. `profile version list` is a bounded authenticated/read-only operation with the existing result and privacy contract.

`profile publish` requires stable capture, exact preview and visibility consent, private Git staging, expected-old remote lease/publication, durable local/remote intent, predicate recovery, and atomic local publication-state advancement. It does **not** require a whole-profile candidate swap or recreation of ordinary Skill membership links.

Process interruption must settle or retain each private workspace without weakening a completed profile/publication outcome. Physical reclamation of Git/`gh` workspaces remains blocked until the process tree is proved settled.

### 6.3 Profile lifecycle, selection, favorites, and editors

`profile add`, duplicate, rename, remove, use, list, current, and edit preserve their documented identity, inactivity/selection, favorite, collision, active-profile refusal, recovery, and diagnostics. Duplicate and replacement use private candidates; rename/removal use durable predicate-based transitions; logical removal detaches only the authorized non-active profile into private quarantine before any physical cleanup.

Profile favorite and active-selection state use strict bounded codecs, shared locks, and atomic state-file publication. Malformed state is diagnosed and not silently replaced.

Profile editor launch retains the current shell-free `VISUAL`/`EDITOR` executable-only contract, inherited environment/stdio, cwd, signal behavior, and child exit/signal result. Immediately before launch, Bazframe revalidates the profile root and final `AGENTS.md`; the documented allowed final-file link must resolve to the accepted regular-file target. Editor writes are intentionally outside Bazframe locks, and the final pathname race remains disclosed.

### 6.4 Skill membership and source lifecycle

Ordinary Skill membership remains a direct shared reference with no copy fallback. On Windows the accepted representation is one exactly validated directory symlink or junction. Creation and use require:

- an accepted safe membership name and physical parent;
- an exact absolute canonical target on independently accepted local storage;
- no-replace link creation;
- a recognized directory-symlink or junction tag and normalized exact target;
- immediate parent, link, target, and target-identity revalidation;
- direct target behavior rather than a link chain; and
- refusal of foreign, malformed, substituted, or otherwise unexpected reparses.

Removal revalidates the exact current target and removes only the membership link as a leaf, never traversing or deleting its target. Native identity-bound link removal or a held link-object capability may harden this boundary but is not required for parity. After an uncertain final syscall, Bazframe reports the observed present/absent/ambiguous state without deleting a target. The disclosed same-user final-syscall race remains.

`skill add|update|remove|edit|list` and `profile skill add|remove|list` retain stable remote checkout paths, provenance, reference-index refusal, lock ordering, exact parallel links, idempotence, diagnostics, and local-versus-remote ownership. `skill edit` remains limited to an externally owned local Added Skill and retains its contained final-file-link, shell-free editor, and immediate revalidation contract.

### 6.5 Libraries, packages, snapshots, and profile references

`library add|update|remove|list`, `package add|build|update|remove|list`, and all `profile library|package add|remove|list` operations retain exact typed identities, immutable content-addressed snapshots, all-referencing-profile validation, reference-safe removal, remote provenance, collision behavior, and atomic descriptor activation.

Library operations remain build-free. Package add/build/update execute only the exact validated manifest argv after current explicit consent, directly without a shell or sandbox, with current cwd/environment, bounded process/output/termination behavior, immediate identity revalidation, and nonrollbackable-side-effect diagnostics. A failed candidate or process does not worsen the active snapshot. Profile reference operations change only exact whole-object references and preserve current CLI-only/TUI boundaries.

### 6.6 Policy, adapters, status, and Pi projection

Global and project list/show/enable/disable retain file-free defaults, Git-worktree identity, project-over-global precedence, validation, lock, atomic managed state-file, and recovery behavior. Global and project policy records remain under admitted `BAZFRAME_HOME`; the canonical project worktree is an external identity/read root, not a policy-write destination.

Adapter list/install/uninstall retain packaged-artifact validation, ownership manifests, collision and drift refusal, `--force` repair authorization, private staging, atomic external Pi-directory publication, and uninstall proof. Installed Pi must apply the central Windows gate before managed-state access and, after acceptance, project the selected profile instructions, physical Added Skills, and immutable library/package Skills with the exact existing `pi`/`pi -nc` context provenance and order, enabled/disabled policy, collision withholding/aliases, `/bazframe info`, reload, status, and diagnostic behavior.

The deprecated `bazframe pi`/`bzf pi` launcher remains part of the current product gate. Its dry-run, forwarded-argument validation, JSON refusal, real launch, child exit/signal propagation, and cleanup behavior must match the shipped contract; it may not launch Pi before Windows acceptance.

`status` remains bounded and read-only while reporting the same profile, policy, adapter, resource, snapshot, Pi cache, and corrective-command state.

### 6.7 Reclamation and quarantine

Safe reclamation is required for ordinary Bazframe-owned profiles, candidates, backups, quarantines, resource state, snapshots when otherwise authorized, and unpublished staging. Reclamation must:

- begin only after lifecycle ownership and the expected root identity are proved;
- operate on unpublished private staging or state already detached from the live namespace;
- use bounded traversal and accepted-filesystem lossless identity evidence;
- revalidate descendants and never follow a reparse point;
- remove an accepted membership link only as a leaf;
- refuse changed, substituted, foreign, busy, unsupported, or unbounded entries; and
- never reach an external Skill target or other unowned content.

Reclamation occurs after the live-namespace commit. Ordinary unopposed cleanup must succeed in acceptance. Cleanup failure or ambiguity retains owner-private quarantine, reports its storage/privacy cost, and does not roll back an already successful logical mutation.

Git/`gh` and acquisition workspace reclamation has the additional process-tree-settlement precondition. Until settlement is proved, those private workspaces remain retained rather than reclaimed.

### 6.8 TUI and Windows Terminal

`bazframe tui` and `bzf tui` where available must use the same accepted application services and central gate. Native Windows Terminal acceptance must cover alternate-screen entry/restoration, keyboard navigation, resize and same-width growth, compact/wide layouts, focus, scrolling, bounded Unicode/ANSI cell width, consent flows, authoritative refresh, handled/fatal errors, Ctrl+C, normal/failure cleanup, and external-editor suspension/restoration.

The Windows port must preserve the exact implemented feature and CLI-only boundaries in section 2.2. It does not add shell process dispatch or optimistic state.

## 7. Bazframe-owned native Windows foundation

Bazframe owns the native Windows API, source, compiled binary, conformance tests, provenance, and release evidence. Pinned Rust/N-API source lives under `native/win32/`. The foundation workflow assembles a Windows x64 MSVC binary at `artifacts/native/win32-x64-msvc/bazframe-win32.node` and packs it into a temporary single-root-tarball conformance artifact. Normal macOS/Linux development and unsupported-platform releases omit the binary, and the build refuses an unmarked ignored binary so it cannot enter an ordinary pack accidentally.

Release admission is implemented as a separate same-release-run decision. The tag workflow calls the reusable foundation producer, retrieves its successful artifact by numeric ID, normalizes the upload action's raw digest to the REST API's algorithm-prefixed form, verifies same-run/repository/commit metadata and the downloaded archive digest, strictly validates the exact artifact inventory plus both external and nested conformance receipts, and creates a commit/version/toolchain/digest-bound ephemeral assembly record without changing the foundation receipts. Every release-mode build and `prepack` revalidates that record and the current fixed-path binary. The final root tarball must contain no alternate `.node` member, exactly one regular fixed-path binary with the admitted digest, and no admission record; the protected publish job additionally binds the record's producer repository, repository ID, and run ID to trusted current context before repeating verification without repacking. Ordinary unsupported-platform packs remain binary-free.

The native contract remains deliberately narrow. Contract version 2 and its schema-v2 source-tree and packed-install evidence passed on native Windows x64/Node 22.19.0 for commit `3d2551c` in workflow run `33881686168`. Contract version 3 added only the missing direct-directory fact boundary and passed for commit `eb5dc56` in workflow run `33892131696`. Contract version 4 added protected private-file creation and no-replace sibling-directory rename and passed for commit `cfcedb7` in workflow run `33917043141`. Contract version 5 adds only the held local-file-lock and process-instance facts required by the cooperating-lock composition:

- `getNativeWindowsInfo` reports the exact contract, package version, target, native read ceiling, and native direct-directory entry ceiling;
- `inspectWindowsPath` opens and checks each drive-absolute path component without following reparses, records and immediately reopens/recompares every traversed identity, derives filesystem and device facts from the pinned final object and its canonical volume, admits only a fixed local NTFS disk with persistent ACL support and non-remote device evidence, and returns canonical volume/object facts with lossless fixed-width identities plus owner, group, current-user, descriptor-control, non-null-DACL, and canonical in-use ACL-byte evidence from the same opened object;
- `createWindowsPrivateDirectory` creates exactly one validated direct child without replacement using an explicit protected DACL that grants inheritable full control only to the current user, Local System, and built-in Administrators, then returns same-volume parent-before, created-child, and parent-after identity/security receipts;
- `readWindowsFileStable` opens one admitted non-reparse regular file, enforces the Bazframe byte bound, reads from that handle, and returns bytes plus exact before/after identity, size, link, attribute, and change-time evidence; and
- `enumerateWindowsDirectoryStable` opens one admitted physical directory, enumerates the same handle twice with a fixed bounded buffer, returns exact UTF-16 direct-entry names and lossless identity/type/reparse metadata, refuses truncated or over-limit success, and returns complete directory-before and directory-after inspection evidence;
- `acquireWindowsFileLock` opens one admitted empty single-link physical guard file without delete sharing, attempts the fixed byte range `[0,1)` with `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)`, distinguishes contention from other failures, and retains an opaque in-process handle capability only after guard and current-process facts are stable;
- `releaseWindowsFileLock` unlocks that exact range and closes the retained handle, with handle close remaining the unconditional failure backstop; and
- `inspectWindowsProcessInstance` opens one PID with query and synchronization rights, compares the full process-creation `FILETIME`, and observes that exact process object's current signaled state without treating access denial or other uncertainty as death.

Contract-v2 facts could not prove a directory closure: path inspection and stable read require an already-known path, while pathname-only enumeration could not prove that a complete name set came from the admitted directory handle or bind each listed child to a later opened child. Contract v3 supplied only that unavailable fact. TypeScript retains recursion, deterministic ordering and collision policy, aggregate limits, owner-private and single-link child admission, opened-child reconciliation, file hashing, two-pass logical closure comparison, and final private-root revalidation. Contract-v4 composition then supplied the concrete evidence for its two native mutations, and contract-v5 composition likewise keeps lock records, keys, ordering, owner policy, recovery classification, and mutation authority in TypeScript.

Identity and 64-bit metadata cross N-API as fixed-width lowercase hexadecimal strings; enumerated names cross as exact valid UTF-16 without replacement conversion. TypeScript validates every native DTO, parses the complete canonical ACL bytes, admits protected owner-private directories or an entirely private inherited chain terminating at a protected anchor, conservatively refuses foreign deletion or protection-rewrite authority on the remaining physical namespace ancestors through the drive root, and revalidates the complete chain outer-to-inner. The one-component creation composition validates the parent before mutation, rejects unsafe names and occupancy without replacement, and treats every unproved post-create result as retained ambiguity. TypeScript remains authoritative for product policy. The loader uses one fixed package-relative binary path and has no weaker fallback. These internal capabilities do not bypass or relax the central public Windows gate.

The earlier exact-`0.7.2` OpenClaw probe remains reproducible historical evidence. Its native Windows run established ordinary binary loading and useful private-directory behavior, while its public receipts could not establish accepted storage or lossless identity. That evidence motivated the initial Bazframe foundation capabilities. Adapted HANDLE-management, reparse-inspection, and N-API error-bridging techniques retain the complete MIT notice and source provenance in `native/win32/`.

### 7.1 Remaining capability and product evidence

The foundation build-and-conformance workflow binds the Windows binary digest to its source commit and pinned Node, Rust, MSVC, and action inputs. The equivalent clean-checkout local PowerShell harness is `scripts/run-win32-native-foundation.ps1`; it binds the same source/toolchain facts and preserves the binary, tarball, digests, installation logs, and source/installed receipts in an ignored evidence directory. Both paths test native loading, fixed local NTFS facts, exact identities, ancestor/final reparse refusal, bounded stable reads, and loading from a packed root tarball. Passing foundation evidence is now a required input to the separate release-admission mechanism described above; neither mechanism authorizes a Windows support claim.

Contract-v2 source composition and conformance cover protected owner-private first visibility for one direct child, effective DACL evidence, inherited private-chain admission, unsafe-root refusal, Unicode-name creation, occupied no-replace refusal, and invalid/reparse-backed-parent refusal. Its source-tree and packed-install receipts passed with exact path-free schema-v2 booleans. Contract-v3 source added bounded handle enumeration and TypeScript-composed deterministic, aggregate-bounded, no-follow directory closure evidence; exact run `33892131696` accepted that milestone. Contract-v4 exact source-tree and packed-install evidence then passed protected private-file creation, bounded materialization, fresh/replacement no-replace publication, and clean-process recovery in run `33917043141` for commit `cfcedb7`. Every receipt retains only booleans rather than names, paths, identities, SIDs, ACL bytes, or file content, and none authorizes release admission or a Windows support claim.

After that evidence run, Bazframe must resolve the remaining outcomes through narrowly bounded composition and native evidence:

- unsafe-root repair and ordinary sharing-failure behavior beyond the proved one-component private-directory slice;
- contract-v5 cooperating-lock source, packed-install, contention, killed-owner, PID-reuse, and interrupted-announcement evidence for the composition below;
- exact directory-symlink/junction membership creation, inspection, and link-only removal;
- generic bounded owned-tree reclamation with reparse-as-leaf and private quarantine behavior;
- native Git/`gh`, package, editor, policy, adapter, and child-process interruption/settlement;
- admitted external roots, bounded remote ZIP copying, installed Pi projection, and the current Windows Terminal TUI; and
- packed local/global installation through both executable names for the complete section 2 matrix.

A new native operation is added only when a concrete composition test shows that the current fact/receipt boundary cannot produce an accepted outcome. Native local-NTFS evidence supplied that trigger: Node's Windows directory rename replaced a competing regular file and the post-operation tuple was indistinguishable from a legitimate commit. Contract v4 therefore adds one narrow no-replace directory-rename operation. The complete public product gate remains closed throughout this internal sequencing.

### 7.2 Directory-publication composition contract

The directory-publication internal slice composes contract-v4 no-replace directory renames with the existing contract-v3 facts. The native operation accepts one admitted parent plus validated source and destination components, admits a physical direct-child directory source on the same fixed local NTFS volume, and invokes `MoveFileExW(source, destination, 0)`. It exposes no replace, copy, delayed, or fallback mode. Both old-to-backup and candidate-to-destination use this primitive; Node's replacement-capable Windows rename is not used by production composition.

The syscall result is not treated as proof by itself. Before and after every attempted rename—including a rejected call—TypeScript derives the transaction outcome only from an admitted private parent, stable bounded parent enumeration, exact lossless directory identities and closure digests, and the journaled dependent-state digest. Native Windows conformance must show that an occupied file, empty or nonempty directory, case-equivalent name, symlink, or junction is not replaced. Source-handle binding and native tri-state transaction results remain unnecessary under the accepted threat model; TypeScript retains predicate reconciliation and all journal policy.

Elevated-runner evidence also showed that Node-created files cannot be assumed to receive the required current-user ownership from an owner-private parent. Contract v4 therefore creates each empty file with `CreateFileW(CREATE_NEW)` and the final protected current-user/System/Administrators security descriptor before TypeScript writes bytes through the exact created pathname and revalidates identity, security, single-link status, and closure. The publication materializer receives only a lower-only bounded direct-file creation capability, not the candidate path; ordinary pathname-based file creation is not part of the seam. Entry count, UTF-8 path bytes, per-file bytes, and aggregate bytes are reserved before mutation against the authoritative production ceilings. Publication expires the capability and drains every started operation before closure capture, including operations the callback failed to await.

The composition requires a separately supplied exclusive-operation authority. Until cooperating Windows locks pass their own later gate, only isolated internal conformance may supply that authority; this slice is not wired to public commands. The publication parent, journal root, per-transaction journal directory, candidate, destination, and backup must be owner-private on one admitted local NTFS volume with one current-user security identity. The destination is one validated Windows component. Candidate and backup names are derived only from the exact 32-lowercase-hex transaction ID.

Each transaction uses immutable, append-only, canonically encoded, bounded journal records. A protected private transaction directory is created before candidate creation. Every record file is exclusively created under a proved inheritable-private parent, completely written and flushed, stably reread, and included in a final owner-private journal-directory closure proof before the corresponding phase is accepted. Records bind the transaction, mode, literal `explicit-overwrite` authorization or `not-authorized`, parent/journal identities, destination/candidate/backup names, expected-old/candidate/backup identity and closure digests, dependent-state digest, sequence, and phase. No Windows directory-`fsync` or sudden-power-loss equivalence is claimed.

The legal fresh route is:

```text
PLANNED -> CANDIDATE_READY -> CANDIDATE_RENAME_INTENT
        -> CANDIDATE_RENAME_PROVEN -> DEPENDENT_STATE_PROVEN -> COMMITTED
```

The legal replacement route inserts:

```text
CANDIDATE_READY -> OLD_RENAME_INTENT -> OLD_RENAME_PROVEN
                -> CANDIDATE_RENAME_INTENT
```

`ABORTED` is permitted only before a rename intent. `AMBIGUOUS` is permitted from any nonterminal phase and is terminal. Every other transition, identity width, field, key order, sequence, mode/authorization combination, or changed immutable proof is refused. A fresh transaction always records `not-authorized`; replacement requires the literal `explicit-overwrite` value before journal or candidate creation. Routine confirmation has no representation at this seam.

Recovery receives the trusted parent and journal-root paths plus the transaction ID; journal bytes never authorize arbitrary paths. It independently proves the current dependent state and namespace tuple before mutation. Before rename intent, a proved untouched transaction may abort while retaining its private candidate. At `OLD_RENAME_INTENT`, only exact `(destination=old, candidate=new, backup=absent)` may retry old-to-backup, while exact `(destination=absent, candidate=new, backup=old)` may advance. At `CANDIDATE_RENAME_INTENT`, only the exact fresh or detached-replacement tuple may retry candidate-to-destination, while exact `(destination=new, candidate=absent, backup=absent|old)` may advance. Candidate proof, dependent-state proof, and commit each re-prove that final tuple. A rename error with the exact before tuple is retryable retained state; an error with the exact after tuple advances; every other tuple, unreadable object, malformed journal, drifted parent/security/dependent state, or unprovable journal write remains retained and ambiguous.

No recursive removal occurs in this slice. A committed replacement retains its exact private backup and journal for the later reclamation capability. Aborted or ambiguous candidates, backups, journals, and partial journal records likewise remain private. Cleanup failure cannot roll back a proved publication. Evidence receipts remain path-, content-, SID-, ACL-, identity-, and machine-detail-free and continue to report `releaseAdmission: not-authorized` and `windowsSupportClaim: false`.

### 7.3 Cooperating Windows operation-lock contract

Each logical lock is a protected private direct-child directory beneath an admitted local-NTFS lock root. Its namespace contains exactly two persistent single-link regular files: an empty `guard` and a bounded `owner` announcement. Both are created without replacement through the contract-v4 first-visible private-file primitive. The requested component is restricted to the product's lowercase ASCII lock-name alphabet, and the logical key digest binds that canonical component to the admitted lock-root identity; the owner record additionally binds the lock-directory, guard-file, and owner-file identities. Unexpected entries, object kinds, reparses, hard links, security drift, valid records bound to different objects, and owner records exceeding the existing 4,096-byte lock ceiling are refused.

The empty guard is the sole serialization authority. Native code opens it with read/write access and `FILE_SHARE_READ | FILE_SHARE_WRITE` but not delete sharing, then attempts an exclusive nonblocking `LockFileEx` lock over `[0,1)`. A conflicting byte lock reports busy; sharing failures and every other error fail before mutation authority. Windows closes the retained handle and removes its byte lock when a process is killed. A process-local physical-directory registry also rejects same-process reentrancy before a second native acquisition.

After acquiring the guard, TypeScript creates or rewrites the fixed owner file in place, flushes it, rereads its exact bytes through the stable native reader, revalidates private identity and security, and proves the exact two-entry namespace before exposing a time-limited authority to the callback. The canonical owner schema contains an acquisition ID, logical and physical lock bindings, PID, full process-creation `FILETIME`, command, target, informational timestamp, held/released state, and a domain-separated checksum. The announcement is diagnostic and recovery evidence; it never grants lock authority.

A busy guard with a stable `held` announcement is attributed only when `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)`, `GetProcessTimes`, and a zero-time wait prove the same PID/creation-time process instance is running. Missing, malformed, changing, released, PID-reused, exited, inaccessible, or otherwise unprovable announcements while busy produce ambiguous contention and authorize no mutation. PID alone and elapsed time never prove staleness.

Once the guard is acquired, an absent or malformed owner file represents an interrupted announcement and may be rewritten and proved before use. A prior `held` record permits dead-owner recovery only when the process-instance receipt reports absent, exited, or a different creation time; a matching live or unprovable owner remains retained ambiguity. Normal completion expires callback authority, writes and proves `released`, then unlocks and closes the guard. Operation failure follows the same release sequence. Announcement or release uncertainty invokes no new callback authority; closing the handle remains the safety backstop, and persistent files are never unlinked, renamed, or recursively reclaimed by this slice.

Contract-v5 evidence must cover private first visibility, exact namespace persistence, independent-process contention, authority expiry, lock-backed directory publication, killed-owner recovery, interrupted pre-announcement recovery, PID-reuse distinction, ordinary release/reacquisition, malformed/ambiguous refusal, and source-tree/packed-install equivalence. Receipts remain path-, process-, content-, SID-, ACL-, identity-, and machine-detail-free and retain `releaseAdmission: not-authorized` and `windowsSupportClaim: false`. This internal capability does not wire public Windows commands or change the existing lock acquisition order.

## 8. Acceptance requirements

Acceptance runs on native Windows, not Git Bash emulation, and uses packed or registry-equivalent artifacts. No subgroup authorizes a partial support statement.

### 8.1 Installation and storage

Acceptance must cover:

- ordinary local and global `npm install bazframe` without compiler, WSL, Git Bash, interactive installation, or binary download;
- both installed `bazframe` and `bzf` entrypoints;
- native Windows x64 and every claimed Node version;
- missing, corrupt, wrong-target, ABI-incompatible, version-mismatched, and malformed bundled-artifact diagnostics without fallback, plus evidence that each accepted operation used the reviewed Bazframe binary;
- local NTFS admission and managed UNC, mapped-drive, network, cloud-placeholder, other-reparse, and unproved-filesystem refusal;
- bounded remote/unsupported-storage ZIP copy into proved private local staging;
- allowed Git network transport with private local workspaces; and
- unchanged non-Windows installation/loading and shipped behavior.

### 8.2 Filesystem and interruption outcomes

Native NTFS tests must cover:

- Windows component aliases, reserved names, ADS syntax, trailing periods/spaces, and case collisions;
- unexpected ancestor/final-entry reparses and the separately accepted membership/editor-link cases;
- effective owner-private DACLs from first visibility, safe inheritance, and unsafe-existing-root refusal/repair;
- bounded opened-handle reads/enumeration with lossless identity, pre/post evidence, byte reconciliation, drift refusal, and closure revalidation;
- lock contention, killed owners, stale/dead-owner recovery, PID reuse, interrupted reclaim, and fail-closed ambiguity;
- atomic state files, corruption/torn-write refusal, fresh publication, existing-state candidate/backup swaps, overwrite consent, and interruption after every journal phase;
- Git/`gh`, package build, editor, adapter, and policy process/write interruption;
- accepted membership link creation, exact target validation, immediate revalidation, direct-target behavior, foreign reparse refusal, uncertain removal inspection, and link-only deletion;
- ordinary owned-tree reclamation in unopposed cases plus safe private quarantine retention on drift, bounds, sharing, or ambiguity;
- antivirus/indexer/open-handle failures before and after possible mutation; and
- logical executable metadata plus no stronger power-loss claim.

Tests verify detected drift and retained ambiguity. They do not assert elimination of the disclosed race against a deliberate same-authority concurrent writer.

### 8.3 Full installed CLI, runtime, and TUI matrix

Through packed local and global installations and both executable names where applicable, acceptance must exercise success, refusal, consent, interruption/recovery, privacy-safe diagnostics, JSON/prose, and unchanged-state behavior for every command in section 2.1. At minimum it must include:

- ZIP dry-run/fresh/safe-suffix/overwrite import, export output replacement, Git import/update/version/publish, exact revisions, visibility/preview consent, and local/remote recovery;
- all profile lifecycle, selection, favorite, editor, active-profile, and removal/reclamation paths;
- local/remote Skill, library, and package acquisition/update/removal/listing, package build, membership, snapshot, and every profile resource reference path;
- global/project policy commands, adapter list/install/uninstall/repair, and status;
- installed Pi extension pre-acceptance refusal before managed-state access, then accepted `pi` and `pi -nc` context restoration/provenance/order, enabled/disabled policy, collision aliases/failure withholding, `/bazframe info`, and `/bazframe reload`;
- deprecated `bazframe pi` and `bzf pi` dry-run, forwarded arguments, refusal, launch, exit/signal, and cleanup behavior;
- current TUI reads and mutations through `bazframe tui` and `bzf tui`, current CLI-only exclusions, Windows Terminal resize/error/Ctrl+C/editor/restoration behavior; and
- platform-neutral help, version, syntax error, migration guidance, and unsupported pre-acceptance central-gate behavior.

Only the complete passing matrix permits a Windows x64/local-NTFS support claim. Passing an internal capability group does not.

## 9. Explicit non-goals

This proposal does not include:

- a current Windows support claim;
- partial Windows support for a subset of the current product;
- network-backed `BAZFRAME_HOME`, staging, checkouts, journals, locks, or other managed state;
- Windows ARM64 or a filesystem other than independently accepted local NTFS;
- Git Bash, WSL, consumer compilation, interactive installation, or runtime downloads;
- new TUI features or movement of existing CLI-only operations into the TUI;
- a generic Windows FFI/filesystem utility API or prescribed opaque capability topology;
- protection against deliberate concurrent mutation by a process with the same user authority;
- mandatory write/delete share denial, 128-bit `FileIdInfo` specifically, native identity-bound file replacement, source-identity-bound rename, held membership-link identity, or native tri-state results solely to defend that excluded attacker;
- membership copying, foreign reparse acceptance, or recursive traversal through a membership target; or
- Git/`gh` workspace reclamation before process-tree settlement is proved, or a stronger sudden-power-loss guarantee than flushed files/records plus predicate-based recovery.
