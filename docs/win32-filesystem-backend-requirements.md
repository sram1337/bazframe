# Native Windows Full-Product Outcome-Parity Proposal

> **Status: Approved design direction; not implemented**
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

Installation and first use require no compiler toolchain, Visual Studio, Rust, WSL, Git Bash, interactive installer, postinstall binary download, or runtime binary download. Any required platform artifact must be selected by ordinary npm dependency resolution. A missing native artifact, omitted optional dependency, unsupported OS/CPU/Node combination, ABI mismatch, or load failure must produce a specific remediation diagnostic before Windows-sensitive work.

Any accepted capability that depends on native behavior must fail closed rather than silently substitute a mechanism weaker than that capability's tested contract. Binding availability does not prove which mechanism an operation used: a guarded pathname implementation is allowed where this document expressly accepts the supported-platform residual race and native Windows acceptance proves the required outcome. Any production dependency must be pinned to an exact reviewed version and pass installed-artifact acceptance. This proposal does not approve a dependency or require a separately published Bazframe-specific native package.

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

## 7. Preferred prototype candidate: `@openclaw/fs-safe@0.7.2`

`@openclaw/fs-safe@0.7.2` is the preferred prototype candidate, not an adopted dependency. Static inspection establishes only these relevant distribution facts:

- the package is MIT licensed;
- it requires Node `>=22`;
- it declares exact optional `@openclaw/fs-safe-win32-x64-msvc@0.7.2` delivery;
- ordinary installation requires no consumer compilation, postinstall download, or interactive installer;
- Windows x64 is the only currently evidenced Windows target; and
- its Windows containment guarantee is documented as `best-effort`, not a race-free sandbox.

Its public root operations, bounded reads/writes, native reparse rejection, `createPrivateDirectory`, sidecar locking, strict file publication, and `tempWorkspace({ cleanupSafety: "require-bounded" })` are candidate building blocks. Static source/package evidence does not prove Bazframe's Windows outcomes.

If evaluated, the adapter must:

- pin exactly `0.7.2` and its exact platform artifact;
- call `configureFsSafeNative({ mode: "require" })` before any Windows-sensitive work, treating this only as proof that the binding is available;
- use public package exports only, never private `dist/native.js` or unpublished binding internals;
- fail rather than use fallback for each named capability whose accepted contract requires a native mechanism, while permitting explicitly accepted guarded pathname operations;
- bootstrap private roots through creation-time DACL setup or proved safe inheritance;
- map typed package errors to actionable Bazframe diagnostics;
- inspect cleanup receipts rather than assume removal; and
- never authorize from a lossy JavaScript `number` native identity receipt.

A wrapper, upstream extension, or fork is justified only after a named native-Windows evidence gate shows that supported public APIs cannot meet an accepted outcome. A stronger or cleaner API alone is not justification.

### 7.1 Complete-scope evidence gaps and conditional extensions

Native Windows x64 evaluation must resolve:

- **Storage admission:** reliable local-volume and NTFS identification, including managed UNC/mapped-drive refusal and bounded remote ZIP copy into accepted private staging. Add a narrow public volume-admission surface only if reviewed public APIs cannot prove it.
- **Lossless identity:** a stable high-level receipt containing exact volume and file identity fields sufficient for reads, recovery, membership, and reclamation. Its representation is not prescribed; `BigInt`, exact strings, or exact byte tuples may qualify. Add a public lossless identity receipt only if that evidence fails; never authorize from the candidate's rounded numeric native identity.
- **Lifecycle directory operations:** fresh no-replace publication plus generic candidate/backup replacement and post-effect inspection through public APIs. Add a narrow rooted directory-publication primitive only if guarded public operations cannot meet parity.
- **Operation locks:** contention, killed owners, PID reuse resistance, dead-owner/stale recovery, and interrupted/ambiguous reclaim. Replace or narrowly extend the sidecar surface only if it cannot serialize all cooperating lifecycles while failing closed.
- **Membership representation:** creation, inspection, exact-target validation, and link-only removal of accepted directory symlinks/junctions. Extend only after public-API tests show this outcome cannot be achieved safely.
- **Ordinary owned-tree reclamation:** bounded identity-proved cleanup, reparse-as-leaf handling, sharing failures, and private quarantine fallback for profiles/candidates/backups/resource state. Extend only if public bounded cleanup cannot meet those outcomes.
- **Privacy and sharing:** private-root creation, safe DACL inheritance, existing-root admission/repair, antivirus/indexer interference, and open-handle outcomes across all state and external-write locations.
- **Git and processes:** native Git/`gh` acquisition, interruption, termination, output bounds, recovery, and separate process-tree settlement evidence before workspace reclamation.
- **Editors:** profile and Added Skill editor launch, contained final-file links, inherited terminal behavior, Ctrl+C, exit/signal propagation, and revalidation.
- **External roots and state:** local source/build/editor roots, canonical project-worktree identity reads, ZIP output, and Pi adapter install/repair/uninstall writes outside `BAZFRAME_HOME`; global/project policy bytes remain managed state under `BAZFRAME_HOME`.
- **TUI:** current feature-set behavior on Windows Terminal, including editor handoff and terminal restoration.
- **Installed artifacts and Pi:** native binary loading, both entrypoints, adapter provisioning, runtime projection, and the full CLI/TUI matrix from packed local and global installs.

## 8. Acceptance requirements

Acceptance runs on native Windows, not Git Bash emulation, and uses packed or registry-equivalent artifacts. No subgroup authorizes a partial support statement.

### 8.1 Installation and storage

Acceptance must cover:

- ordinary local and global `npm install bazframe` without compiler, WSL, Git Bash, interactive installation, or binary download;
- both installed `bazframe` and `bzf` entrypoints;
- native Windows x64 and every claimed Node version;
- missing/omitted optional artifact, unsupported target, ABI mismatch, and load diagnostics without capability-specific fallback, plus evidence of the actual mechanism used rather than inference from native loader mode;
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

- a current Windows support claim or adoption of `@openclaw/fs-safe`;
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
