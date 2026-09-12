# Native Windows Full-Product Outcomes

> **Status: Internal source/host implementation independently reviewed; native installed-product qualification pending**
>
> This document records Windows implementation outcomes and the native installed-package matrix required before npm publication. [`design.md`](design.md) remains the product source of truth, and the macOS/Linux contract is unchanged.

## 1. Decision and support boundary

Bazframe will pursue observable outcome parity with its supported macOS/Linux behavior rather than prescribe a bespoke native API or claim a stronger Windows security boundary. Bazframe TypeScript continues to own ZIP and path policy, Git behavior, lifecycle decisions, journaling and recovery direction, profile/resource identity, consent, presentation, and Pi projection. A Windows filesystem layer supplies only the capabilities needed to achieve those outcomes.

Implementation and focused testing can proceed by capability. Npm publication requires the complete current surface in section 2 to pass its applicable installed-package acceptance checks. Current entrypoint routing is described in section 5.1; capability test results alone do not establish full installed-product behavior.

Pure help, version, command parsing, syntax errors, and migration guidance remain platform-neutral. They must not initialize the Windows filesystem layer or be accidentally blocked by its gate.

The initial platform boundary is native Windows x64 with managed state on accepted local NTFS. It does not imply Windows ARM64, another filesystem, network-backed managed state, or broader TUI terminal coverage.

## 2. Required current product surface

The Windows acceptance matrix includes the complete current CLI and TUI product, not only a fresh-import path.

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

The Windows matrix includes the currently implemented keyboard-first TUI, not new TUI features. It must preserve:

- the read-only Skills, Profiles, Adapters, and Settings presentations and diagnostics;
- collapsible Added Skill, library, package, and child-Skill rows and previews;
- profile create, duplicate, use, favorite toggle, rename, guarded remove, and instruction editing;
- Added Skill editing and selected-profile Added Skill membership add/remove;
- consent-bound addition of a prepared local library or acquisition of a remote Git library, without adding a profile reference or running source code;
- compact/wide navigation, focus, viewport, accessibility, error, refresh, and terminal restoration behavior; and
- the existing external-editor handoff from profile and Added Skill routes.

The existing CLI-only boundary is unchanged. Profile sharing, Skill add/update/remove, package add/build/update/remove, library update/remove, library/package profile-reference mutation, policy/adapter writes, and source move/rename are not added to the TUI merely to support Windows. Adapter and Settings views remain read-only. The CLI surfaces listed in section 2.1 remain part of Windows acceptance.

## 3. Storage and threat boundary

### 3.1 Accepted managed storage

`BAZFRAME_HOME`, Bazframe temporary/staging roots, profile candidates/backups/quarantines, resource state and snapshots, Git/`gh` workspaces, journals, locks, and other managed state must be on an accepted local Windows volume. The first accepted filesystem is local NTFS. Bazframe must reject before sensitive work or recovery when locality, filesystem behavior, identity, operation access, sharing, or required same-volume rename behavior cannot be proved.

The managed-storage boundary rejects UNC paths, mapped remote drives, SMB and other network filesystems, cloud-placeholder roots, FAT, exFAT, ReFS, and every filesystem not separately proved and accepted.

An untrusted ZIP may originate on unsupported or network storage only by a bounded byte copy into proved owner-private accepted local staging before archive parsing or validation. The source is never treated as managed state or traversed as a profile tree. A copy that cannot prove its bound and complete local result fails without managed publication.

Git and GitHub network transport are allowed. New acquired checkouts, control state and process workspaces are created in private accepted local staging; reused existing objects follow section 5.3. Network transport does not authorize network-backed `BAZFRAME_HOME` or staging.

External roots used by the current product have these explicit boundaries:

| External root | Windows x64/local-NTFS boundary |
| --- | --- |
| Local Skill, library, or package source; Added Skill editor target/cwd | Must independently pass local-NTFS, physical-ancestry, reparse, and stable-read admission. It may be on a different accepted local volume from `BAZFRAME_HOME`. |
| Canonical Git project worktree | Must independently pass local-NTFS identity admission before project-specific policy resolution or mutation. Project policy bytes remain under `BAZFRAME_HOME`; Bazframe does not write policy into the worktree. |
| Configured Pi agent directory | Must independently pass local-NTFS, physical ancestry, and external-publication admission. It may be on a different accepted local volume because its writes use private siblings within that directory, not cross-volume rename from `BAZFRAME_HOME`. |
| ZIP export destination | Must independently pass local-NTFS ancestry and same-directory atomic-publication admission. It may be on a different accepted local volume from `BAZFRAME_HOME`. |
| ZIP import source | May be on unsupported or network storage only through the bounded private-local copy rule above. |

Every unsupported external root produces a category-specific actionable storage diagnostic before Bazframe creates a link, launches a build/editor/helper, writes policy or adapter state, or publishes output. Bounded ZIP-source copying and Git network transport are the only remote-input exceptions in this boundary.

An unsupported managed location must produce an actionable storage diagnostic and remain unchanged. It must not be reported as ordinary profile drift or archive corruption.

### 3.2 Protected conditions

The Windows design protects against:

- untrusted ZIP, Git, profile, resource, manifest, process-output, path, and name inputs;
- pre-existing malformed, aliased, special, or unexpected reparse-backed state;
- unintended access by other ordinary local users to newly created sensitive objects;
- concurrent cooperating Bazframe processes;
- process interruption;
- ordinary user edits, filesystem drift, and sharing failures from editors, antivirus, indexers, or other open handles;
- disclosure from newly created sensitive output being visible before private protection is applied; and
- replacement or discarded local state without explicit overwrite consent.

Detected drift fails closed. If an operation may have mutated state but its result cannot be proved, Bazframe inspects journaled predicates, retains relevant state with its existing protection, and reports an actionable ambiguous outcome rather than guessing.

Deliberate concurrent mutation by a process already running with the same Windows user authority is outside the boundary, as are administrator, kernel, compromised-native-module, and physical-device attacks. Windows retains the supported-platform residual race between final metadata/path revalidation and a pathname-based syscall, plus the possibility that deliberately restored metadata hides an in-place change. Stronger primitives may narrow those races, but support does not claim to eliminate them.

## 4. Installation and dependency boundary

Native Windows installed-package acceptance uses ordinary installation:

```text
npm install bazframe
npm install --global bazframe
```

Installation and first use require no compiler toolchain, Visual Studio, Rust, WSL, Git Bash, interactive installer, postinstall binary download, or runtime binary download. The npm publication artifact must bundle the exact reviewed `artifacts/native/win32-x64-msvc/bazframe-win32.node`, produced from pinned source under `native/win32/`, inside the Bazframe root tarball. The fixed package-relative loader selects it only on native Windows x64 and validates its contract, target, and package version. A missing, corrupt, wrong-target, ABI-incompatible, version-mismatched, or malformed bundled artifact produces a specific remediation diagnostic before Windows-sensitive work.

Any accepted capability that depends on native behavior must fail closed rather than silently substitute a mechanism weaker than that capability's tested contract. A guarded pathname implementation is allowed where this document expressly accepts the supported-platform residual race and native Windows acceptance proves the required outcome. Native source dependencies and toolchains are pinned, and the compiled binary, source commit, tests, and digest form one reviewed evidence set. The accepted binary ships inside the existing single Bazframe npm artifact; no installation lifecycle script or secondary platform package is required. Ordinary checkout builds omit native bytes; the tag-triggered workflow authenticates and includes the binary during package assembly as described in [releasing.md](releasing.md).

## 5. Common filesystem outcomes

Every product group in section 6 composes these common outcomes as applicable.

### 5.1 Central platform and capability gates

The public `src/cli.ts` dispatcher now selects the existing lazy Windows application services for both executable names, without the obsolete blanket platform refusal. Help/version/usage and unsupported JSON remain before native initialization; injected Win32 path grammar does not select POSIX effects. Package-local x64/native version/contract/target/limit checks and local-NTFS admission remain at their existing capability boundaries. Node.js 22.19.0 or newer and Pi >=0.84.4 except 0.85.0 are required. This source transition does not change the already-published beta.3. The default Pi extension separately awaits its existing installer-bound Windows bootstrap: compatibility precedes binding I/O, exact code-owned reference/package/runtime/native integrity precedes runtime import and native construction, and shared handlers then resolve state. This routing implementation does not establish native installed-product or release qualification.

Internal capability refusal must occur before mutation, transaction recovery, stale-lock reclamation, external process launch, adapter/policy writes, or TUI state access that could trigger recovery. If Windows Pi bootstrap initialization fails, the extension registers fail-closed handlers with the actionable initialization reason: no profile resources/context, handled input with nonzero print exit, and visible startup/info/before-agent-start failure. Factory rejection alone is insufficient because Pi can continue natively. Only Pi reloading the extension retries initialization; non-Windows keeps its standalone path. These checks apply consistently to local/global installs; the same CLI capability checks apply to both executable names. Help/version/syntax paths bypass filesystem initialization and remain platform-neutral.

### 5.2 Name policy, containment, reparses, and identity

Bazframe TypeScript remains authoritative for ZIP parsing, portable artifact paths, component collision/equivalence policy, Windows-reserved names, alternate-data-stream syntax, trailing period/space aliases, case collisions, limits, and manifest validation.

The filesystem layer must provide enough lossless evidence for Bazframe to:

- prove managed ancestry and traversed entries remain beneath the intended physical root;
- reject unexpected symlinks, junctions, mount points, cloud placeholders, other reparse tags, and special entries;
- never recursively traverse a reparse point;
- bind identity-sensitive read, recovery, publication, membership, and removal decisions to lossless volume/file identity suitable for accepted NTFS; and
- revalidate identity and closure immediately before and after pathname-based effects.

Only product-authorized representations are exceptions: exact membership directory symlinks/junctions and the documented contained final-file links accepted by profile/Skill editor launch. Every other managed reparse is refused. A particular `FileIdInfo` width is not required, and lossy JavaScript numeric identity never authorizes an effect.

### 5.3 Private fresh creation; physical existing-state admission

New sensitive directories and files (including copied input, staging, candidates, journals, snapshots, lock files, workspaces and adapter output) receive private protection from first visibility, analogous to POSIX 0700/0600 creation defaults. Windows uses an explicit protected descriptor for the current user, SYSTEM and Administrators; fresh-creation receipts carry same-handle security evidence for that known recipe. Tightening initially broad protection later is not private creation.

Existing input, state, ancestors and product-authorized editor/membership links are admitted by the shared operation's identity, containment, kind, required access, bounds and drift rules. A particular owner SID, fixed principal/full-control ACL shape, absence of deny ACEs, or protected ancestry anchor is **not** an existing-state admission requirement. There is no ancestor-owner whitelist, general ACL evaluator or recursive permission repair. Read access does not confer mutation authority; writable existing objects still require the shared locks, consent and expected-old checks.

Reusing or renaming an existing object preserves its protection; detachment into a retained name neither proves nor repairs privacy. Atomic replacement legitimately publishes a newly created private object instead of preserving the old object's ACL at the destination path. Fresh private objects retain their protection when moved. These guarantees do not promise every ordinary Node filesystem API works under every custom subset-of-rights ACL: normal access errors remain normal access errors. Ordinary native physical observation does not request or query security descriptors.

### 5.4 Stable bounded reads and enumeration

A stable file read must:

- open one accepted regular file without following an unexpected reparse and return bytes from that opened handle;
- enforce the Bazframe-supplied byte bound while reading;
- use lossless identity for authorization and compare identity, size, available change evidence, and byte count before and after the read;
- fail on incomplete input or detected change; and
- participate in final identity/closure revalidation before a dependent mutation, capture, process launch, or projection.

Ordinary physical profile/resource reads, ZIP source/input reads and editor targets accept stable hardlinked regular files. Link-count changes remain stability evidence; a fixed count of one is required only by a corresponding operation, such as fresh owned creation or guard/owner files whose lock or in-place write must not affect an alias outside the authorized namespace. Moving an ordinary existing file entry without replacement does not require single-link ownership.

Directory enumeration must be bounded, produce deterministic Bazframe ordering, and support pre/post ancestry and closure evidence for the operation. Every entry counts toward the bound; only entries the operation admits or traverses require object-level admission. Requested journal storage need not validate unrelated sibling objects. Share denial and a particular native change token are permitted hardening, not requirements. The contract does not claim to detect a deliberate same-size or timestamp-restored mutation by an excluded same-authority process.

Cached parent-directory entries can refresh a plain physical child directory's write/change timestamps after its first authoritative open. Entry/open and repeated-entry comparisons therefore exclude only those two cached fields for matching plain physical directories; opened-directory metadata stability, file/reparse timestamps, creation time, identity, namespace, attributes and same-domain lengths remain strict. Raw receipts and shared identity digests retain the observed values; this is a capture-local comparison policy, not a retry or metadata-normalization operation.

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
4. rename the old destination to a retained backup/quarantine, preserving its existing protection, and publish the candidate to the absent destination;
5. prove resulting old/candidate/backup/destination predicates and active-selection state; and
6. recover after interruption from strict journal records plus observed identity/closure predicates.

No source-identity-bound rename or native identity-bound file replacement is required solely to defeat the excluded same-user attacker. An unproved outcome is retained rather than guessed; new objects are privately created and existing objects retain their protection. Regular files and recovery records are flushed before dependent mutation. Windows acceptance does not claim POSIX directory-`fsync` equivalence or stronger sudden-power-loss durability.

### 5.7 Logical executable metadata

Windows need not represent POSIX executable mode physically. Bazframe preserves captured executable bits as validated logical manifest metadata so ZIP/Git transport and later export do not lose portable meaning.

## 6. Product capability groups

These groups organize implementation and acceptance evidence.

### 6.1 ZIP capture, import, export, and replacement

ZIP dry-run remains bounded and effect-free with respect to Bazframe state. ZIP input from unaccepted storage is first copied as bounded untrusted bytes into proved private accepted local staging. Capture and export use stable bounded closure reads, exact preview/exclusion policy, deterministic ZIP output, and atomic destination publication. Existing output refuses unless `--overwrite` explicitly authorizes replacement.

Fresh import publishes a complete inactive profile to an absent or accepted safe-suffix destination. Overwrite import uses the full candidate/backup transaction, preserves active selection when replacing the active profile, and never treats occupancy or `--yes` as overwrite consent. Imported Skill/library/package materialization, stable identities, dynamic collision qualification, package-artifact handling, and Pi projection retain the current product contract.

### 6.2 Git import, update, versioning, and publication

All Git/`gh` and exact-revision acquisition processes retain the shipped isolated environment, no-shell execution, disabled prompting/hooks, bounded output and duration, termination handling, exact revision/reachability rules, and authentication/consent boundaries. Network transport is allowed, but newly acquired checkouts and workspaces are privately created on accepted local NTFS.

Git import, `profile update`, and `profile version use` use expected-old closure checks, fresh candidates, candidate/backup recovery, exact Git revisions, active-selection preservation, and explicit discard authorization. `profile version list` is a bounded authenticated/read-only operation with the existing result and privacy contract.

`profile publish` requires stable capture, exact preview and visibility consent, private Git staging, expected-old remote lease/publication, durable local/remote intent, predicate recovery, and atomic local publication-state advancement. It does **not** require a whole-profile candidate swap or recreation of ordinary Skill membership links.

Process interruption must settle or retain each private workspace without weakening a completed profile/publication outcome. Physical reclamation of Git/`gh` workspaces remains blocked until the process tree is proved settled.

### 6.3 Profile lifecycle, selection, favorites, and editors

`profile add`, duplicate, rename, remove, use, list, current, and edit preserve their documented identity, inactivity/selection, favorite, collision, active-profile refusal, recovery, and diagnostics. Duplicate and replacement use private candidates; rename/removal use durable predicate-based transitions; logical removal detaches only the authorized non-active profile into retained state without changing existing protection.

The raw profile-list service enumerates profiles without reading unrelated active selection, acquiring locks, bootstrapping or recovering. The rich CLI/application list still projects active selection through its shared view and validates that actual presentation dependency; service independence is not a selection bypass for the CLI.

Profile favorite and active-selection state use strict bounded codecs, shared locks, and atomic state-file publication. Malformed state is diagnosed and not silently replaced.

Profile editor launch retains the current shell-free `VISUAL`/`EDITOR` executable-only contract, inherited environment/stdio, cwd, signal behavior, and child exit/signal result. Immediately before launch, Bazframe revalidates the profile root and final `AGENTS.md`; the documented allowed final-file link must resolve to the accepted regular-file target. Editor writes are intentionally outside Bazframe locks, and the final pathname race remains disclosed.

### 6.4 Skill membership and source lifecycle

Ordinary Skill membership remains a direct shared reference with no copy fallback. On Windows existing read/use accepts one exactly validated absolute directory symlink or junction independently of catalog registration. Fresh private creation produces a junction with a junction-specific creation receipt. Direct-reference admission requires:

- an accepted safe membership name and physical parent;
- an exact absolute canonical target on independently accepted local storage;
- a recognized directory-symlink or junction tag and normalized exact target;
- immediate parent, link, target, and target-identity revalidation;
- direct target behavior rather than a link chain; and
- refusal of relative, UNC, chained, malformed, substituted, or otherwise unexpected reparses.

Ordinary load/view/use binds the physical link and target plus bounded matching `SKILL.md` evidence, without recursively fingerprinting the external Skill tree. Only exact matching catalog links project catalog resource ownership and selectors. An unregistered or differently targeted reference remains read-only runtime input, not catalog mutation authority. Ordinary view/use also preserves the exact physical profile `source-units` root without traversing its inert contents. Export, lifecycle, candidate, and recovery captures remain strict.

Membership add/remove still requires exact current catalog authorization; creation is no-replace. Removal revalidates the exact current target and removes only the membership link as a leaf, never traversing or deleting its target. Native identity-bound link removal or a held link-object capability may harden this boundary but is not required for parity. After an uncertain final syscall, Bazframe reports the observed present/absent/ambiguous state without deleting a target. The disclosed same-user final-syscall race remains.

`skill add|update|remove|edit|list` and `profile skill add|remove|list` retain stable remote checkout paths, provenance, reference-index refusal, lock ordering, exact parallel links, idempotence, diagnostics, and local-versus-remote ownership. `skill edit` remains limited to an externally owned local Added Skill and retains its contained final-file-link, shell-free editor, and immediate revalidation contract.

### 6.5 Libraries, packages, snapshots, and profile references

`library add|update|remove|list`, `package add|build|update|remove|list`, and all `profile library|package add|remove|list` operations retain exact typed identities, immutable content-addressed snapshots, all-referencing-profile validation, reference-safe removal, remote provenance, collision behavior, and atomic descriptor activation.

Library operations remain build-free. Package add/build/update execute only the exact validated manifest argv after current explicit consent, directly without a shell or sandbox, with current cwd/environment, bounded process/output/termination behavior, immediate identity revalidation, and nonrollbackable-side-effect diagnostics. A failed candidate or process does not worsen the active snapshot. Profile reference operations change only exact whole-object references and preserve current CLI-only/TUI boundaries.

### 6.6 Policy, adapters, status, and Pi projection

Global and project list/show/enable/disable retain file-free defaults, Git-worktree identity, project-over-global precedence, validation, lock, atomic managed state-file, and recovery behavior. Global and project policy records remain under admitted `BAZFRAME_HOME`; the canonical project worktree is an external identity/read root, not a policy-write destination.

Adapter list/install/uninstall retain packaged-artifact validation, ownership manifests, collision and drift refusal, `--force` repair authorization, private staging, atomic external Pi-directory publication, and uninstall proof. Installed Pi acceptance must cover compatibility/binding/native initialization refusal before managed-state access and production routing that projects the selected profile instructions, physical Added Skills, and immutable library/package Skills with the exact existing `pi`/`pi -nc` context provenance and order, enabled/disabled policy, collision withholding/aliases, `/bazframe info`, reload, status, and diagnostic behavior.

The deprecated `bazframe pi`/`bzf pi` launcher is included in installed-product acceptance. Its dry-run, forwarded-argument validation, JSON refusal, real launch, child exit/signal propagation, and cleanup behavior must match the shipped contract.

`status` remains bounded and read-only while reporting the same profile, policy, adapter, resource, snapshot, Pi cache, and corrective-command state.

### 6.7 Private retained state

Windows follows the shared macOS/Linux lifecycle: authorized logical removal detaches the named non-active profile from the live namespace. Detached existing profiles/backups preserve their protection, while fresh transaction state is privately created, with an honest retained-state result. Physical recursive deletion is not part of successful profile removal. External Skill targets and other unowned content remain untouched; membership unlink removes only the admitted link leaf.

Ordinary resource cleanup and terminal/process settlement keep their shared semantics. Git/acquisition workspaces remain private when process-tree settlement is unproved. Automatic snapshot/blob garbage collection requires a separate ownership and retention policy.

### 6.8 TUI and Windows Terminal

`bazframe tui` and `bzf tui` where available must use the same accepted application services and shared dispatcher. Native Windows Terminal acceptance must cover alternate-screen entry/restoration, keyboard navigation, resize and same-width growth, compact/wide layouts, focus, scrolling, bounded Unicode/ANSI cell width, consent flows, authoritative refresh, handled/fatal errors, Ctrl+C, normal/failure cleanup, and external-editor suspension/restoration.

The Windows port must preserve the exact implemented feature and CLI-only boundaries in section 2.2. It does not add shell process dispatch or optimistic state.

## 7. Native mechanisms and current implementation

Current live-acquisition correction: native contract 9 adds a separately bound, single-pass directory sample exclusively for the non-authoritative Git acquisition monitor. It retains native no-follow physical identity, local-NTFS ancestry, kind, access and entry bounds while allowing mutable directory content metadata. Stable enumeration and final publication proofs are unchanged. Foundation schema 8 requires the new physical/bounded sample observation; product schema 6 binds the new capability. Older contract-8/foundation-v7/product-v5 receipts remain historical and do not certify these semantics. Focused changed-path tests are not full W9 or release qualification.

Current correction: native contract 8 separates physical observations from mandatory `creationSecurity` receipts, removes existing owner/ACL admission and ordinary single-link input refusal, and removes the raw-list selection dependency. Foundation receipt schema 7 and product-slice schema 5 require new observations; older receipts are historical evidence only and cannot qualify these semantics. A lost fresh-junction creation receipt leaves a present authorized junction ambiguous rather than asserting private creation; a previously present exact junction remains current. The correction and its final diagnostic cleanup are independently accepted at source/host level. The changed contract-8 binary still requires native and installed-product qualification; this correction has only source/host evidence.

The Bazframe-owned Windows x64 Rust/N-API backend supplies local-NTFS/path admission, lossless physical identity inspection and separate same-handle fresh-creation security evidence, bounded whole-file and ranged reads/enumeration, protected private directory/file creation, no-replace sibling directory and regular-file publication, same-volume two-admitted-parent directory movement, cooperating-writer locks, exact direct directory-link inspection and private junction creation, and native contract 8 read-only contained final-file editor inspection. These capabilities address measured Node/Windows gaps. TypeScript owns product policy and composes the narrow native operations; implementation topology is not a permanent product requirement.

Internal onboarding, healthy local Skill membership and managed activation/current/switching exist behind injected services. Onboarding retains its directory-publication/recovery composition; the connected product uses shared lifecycle policy rather than nesting transaction engines.

Windows physical profile proofs contain a tagged lossless root identity, nullable sidecar SHA-256 and logical closure SHA-256, matching shared POSIX proof facts. Paths and parent contents are freshly admitted on each capture/assertion. Repeated observations, entry-to-open reconciliation, bounded reads and two-pass closure stability remain local to a capture. A moved physical profile with the same logical profile name can retain its core proof; changed identity, sidecar or logical content cannot. Logical closure includes the profile name.

Internal V2 journal codecs cover candidate swap, rename, remove and publication in the `win32-ntfs` domain. Strict key validation refuses the old internal V2 shape with its removed observation field; occupied old records remain untouched with existing protection, without migration. POSIX V1 serialized bytes and V1-only storage/recovery are unchanged and refuse Windows V2.

The internal Windows journal adapter validates/reconciles the requested final and its owned candidate, revalidates physical directory ancestry and uses bounded current enumeration for exact-name absence, aliases and capacity. Unrelated siblings are counted but not admitted or committed as dependencies. Writes require live operation authority, protected exclusive creation, awaited write/flush/close and canonical requested-ID readback. Updates reconcile actual old/candidate/final state after settled replacement. Initial final-name exclusive creation can leave an empty/partial occupied file on interruption; it is refused and retained. This initial publication limitation is not a completed-temp atomic-visibility claim.

Internal V2 storage now feeds shared candidate swap, rename and removal recovery. Rich reads, private nested stores/materialization, logical executable metadata, duplicate and real shared ZIP import/export compose through injected Windows effects. ZIP parsing uses bounded native ranges over an admitted private local copy, without reducing the archive ceiling or requiring an archive-sized native buffer. New sensitive files under accepted external ZIP parents are protected at creation; those parents require namespace/locality proof, not managed-tree read privacy. Effect-free inspection never recovers or bootstraps home; materialization may read its own live journal only through actual branded operation authority. Host/source evidence and independent data, candidate/ZIP and ready-resource review exist; native qualification remains pending. The internal W6 provider/canonical and W7–W8 project/runtime/editor/TUI groups are now connected through shared engines as described below; native installed-product acceptance remains incomplete. Earlier elevated development results do not establish ordinary-user compatibility or full product acceptance.

Internal ready-resource services now call shared collection preparation/lifecycle/resolver, snapshot, reference-index, favorites and imported-membership engines. Snapshot manifests retain their existing layout and logical modes; private initial objects, descriptor candidates and detached leaves are retained on failure without repair or recursive reclamation. Only bounded namespace/physical admission is required for inactive retained descriptor/reference leaves; their irrelevant payloads are not opened. Mutable source admission occurs at preparation/build boundaries, while ready snapshot use remains independent of source availability. Active shorthand revalidates selection under the shared lock. Owned stale profile alias-cache objects are guardedly detached, not deleted. These are source/host-tested internal effects, not native or installed-product qualification.

Current internal W6 source work connects the shared managed-Git provider and acquisition inspector to Windows private records, lossless identities, branded operation plus live native state-lock scope, retained detachment and the two-parent no-replace move. Skill/library/package acquisition, exact reuse, updates/builds/removal and offline health consume the real ready-resource engines. Exact NUL tree/index evidence retains 40/64-character object IDs and rejects unsupported modes/aliases before checkout. Bounded stable reads transport actual worktree bytes, including built-in EOL conversion, with tracked 100755 bits overlaid into snapshot/bundle manifests without a checkout metadata sidecar. Worktree/blob byte equality is not an admission predicate; exact revision/provenance, clean checkout, tree/index object and mode matching, root identity and repeated closure checks remain required. Generated package files without authoritative mode information remain false. Ordinary view/use consumes immutable snapshots even when mutable source is missing; relevant provider recovery still uses shared diagnostics.

Controlled Git/gh resolution excludes fetched cwd and freezes overrides with Windows casing semantics. Bounded immediate-child uncertainty releases owned Node handles/pipes without claiming descendant extinction. Both known static npm shims and the exact installed Node24 prefix-dispatch launcher are supported; prefix-helper execution occurs only after adjacent authorization, with root/manifest/authority checks before and after. Unknown shims refuse with explicit native/Node guidance. Actual Windows loader/process behavior remains unqualified.

Private Windows workspace/isolation, canonical storage, Git object inspection and exact remote materialization now feed the actual shared canonical Git/lifecycle engines. Real disposable host Git and repository-owned Node builds, with synthetic Windows filesystem/native receipts, cover all-three-kind publication → initial unavailable import → repair → update/version/use → sidecar recovery; uncertain acquisition cannot create an incomplete install, and existing-profile acquisition failure preserves the installed root/state. A separate managed-library capture → Git/ZIP import → re-capture preserves binary/CRLF bytes and executable bits. Read-only/dry-run and cancelled absent-home runtime paths use independently admitted temporary storage without bootstrap/login/recovery beyond policy. Retained workspace identity is proved; neither reclamation nor native qualification is claimed.

Shared linked-lifecycle callers now consume Windows selection/state/capture/view/candidate effects. Windows publication uses the existing shared phase engine and strict V2 recovery but publishes only its sidecar through a protected sibling expected-old CAS. The physical profile root, membership junctions and authored bytes are not swapped. Exact old sidecar bytes are retained under a private requested transaction namespace before replacement and verified against the existing journal hash; absent old state needs no marker. Recovery derives desired state from those proved old bytes and the canonical remote proof, accepts only the original root with old/desired sidecar predicates, and retains ambiguity otherwise. In-flight reads carry branded operation authority, and retained unrelated old-state payloads are not global view dependencies. Late root substitution and genuinely in-flight capture-authority expiry corrections are independently accepted. Canonical Git/process integration is locally exercised; the environment/hash/monitor corrections are independently accepted. The final built-in-EOL parity correction and exact delta are independently accepted at source/host level, with red/green Skill/library shared-journey evidence.

ZIP byte-source classification is separate from managed locality/physical admission: ordinary disk files and the specific cloud reparse family can be copied without trusting source ancestry ownership. Mapped network byte sources retain the source exception; generic reparses, device aliases, pipes and non-regular files still refuse; stable hardlinked regular inputs are accepted. Stage/output admission stays local/private as applicable, copying is bounded and drained, and the canonical parser sees only the reconciled local copy. An operation-bound shared view rechecks the actual branded authority after asynchronous reads settle. Native cloud/provider, mapping, ACL and sharing behavior remains unqualified.

Internal W7–W8 application-plan Tasks 1–12 now compose one lazy shared backend identity into discovery/policy, existing CLI/TUI branches, rich status and actual shipped Pi handlers, private installer-bound runtime integrity, discovery-safe retained uninstall, the controlled launcher and both editors. Native contract 8 editor proof admits and revalidates the complete resolved parent chain without reading editor-target content. Independent source/host reviews accept the application corrections, including the final shared imported-plus-physical collision inputs for library/package listings. Prose/JSON lists, status and actual Pi handlers have connected host regressions for whole-collection withholding and nonmutating reads. The final narrow review verified its exact five-file delta and preservation of the other 386 paths. Evidence is under `/tmp/bazframe-windows-completion.AH77qw/` in `application-consumer-corrections-review.md`, `application-security-corrections-review.md`, `application-final-fix.md` and `application-final-fix-review.md`. Native installed-product outcomes remain unqualified.

Release binary provenance, installed-artifact validation and publication approval remain at the [release boundary](releasing.md). Native-dependent outcomes need native execution when authorized; host mocks and syntax checks cannot establish ACL, sharing or Windows Terminal behavior.

## 8. Acceptance requirements

Before npm publication, acceptance runs on native Windows, not Git Bash emulation, and uses packed or registry-equivalent artifacts. The complete matrix is required; subgroup results retain their narrower scope.

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
- protected private creation from first visibility, separate readable/writable existing-data ACL and owner parity (without repair), and ordinary native inspection without descriptor-read access;
- bounded opened-handle reads/enumeration with lossless identity, pre/post evidence, byte reconciliation, drift refusal, and closure revalidation;
- lock contention, killed owners, stale/dead-owner recovery, PID reuse, interrupted reclaim, and fail-closed ambiguity;
- atomic state files, corruption/torn-write refusal, fresh publication, existing-state candidate/backup swaps, overwrite consent, and interruption after every journal phase;
- Git/`gh`, package build, editor, adapter, and policy process/write interruption;
- accepted membership link creation, exact target validation, immediate revalidation, direct-target behavior, foreign reparse refusal, uncertain removal inspection, and link-only deletion;
- logical removal preserving existing profiles/backups and their protection, external-target preservation and retained ambiguity on drift, bounds or sharing failures;
- antivirus/indexer/open-handle failures before and after possible mutation; and
- logical executable metadata plus no stronger power-loss claim.

Tests verify detected drift and retained ambiguity. They do not assert elimination of the disclosed race against a deliberate same-authority concurrent writer.

### 8.3 Full installed CLI, runtime, and TUI matrix

Through packed local and global installations and both executable names where applicable, acceptance must exercise success, refusal, consent, interruption/recovery, privacy-safe diagnostics, JSON/prose, and unchanged-state behavior for every command in section 2.1. At minimum it must include:

- ZIP dry-run/fresh/safe-suffix/overwrite import, export output replacement, Git import/update/version/publish, exact revisions, visibility/preview consent, and local/remote recovery;
- all profile lifecycle, selection, favorite, editor, active-profile, and removal/retention paths;
- local/remote Skill, library, and package acquisition/update/removal/listing, package build, membership, snapshot, and every profile resource reference path;
- global/project policy commands, adapter list/install/uninstall/repair, and status;
- installed Pi extension initialization refusal before managed-state access, then accepted `pi` and `pi -nc` context restoration/provenance/order, enabled/disabled policy, collision aliases/failure withholding, `/bazframe info`, and `/bazframe reload`;
- deprecated `bazframe pi` and `bzf pi` dry-run, forwarded arguments, refusal, launch, exit/signal, and cleanup behavior;
- current TUI reads and mutations through `bazframe tui` and `bzf tui`, current CLI-only exclusions, Windows Terminal resize/error/Ctrl+C/editor/restoration behavior; and
- platform-neutral help, version, syntax error, migration guidance, and central platform-refusal behavior.

Npm publication requires the complete passing matrix, not just an internal capability group.

## 9. Explicit non-goals

The support boundary excludes:

- network-backed `BAZFRAME_HOME`, staging, checkouts, journals, locks, or other managed state;
- Windows ARM64 or a filesystem other than independently accepted local NTFS;
- Git Bash, WSL, consumer compilation, interactive installation, or runtime downloads;
- new TUI features or movement of existing CLI-only operations into the TUI;
- a generic Windows FFI/filesystem utility API or prescribed opaque capability topology;
- protection against deliberate concurrent mutation by a process with the same user authority;
- mandatory write/delete share denial, 128-bit `FileIdInfo` specifically, native identity-bound file replacement, source-identity-bound rename, held membership-link identity, or native tri-state results solely to defend that excluded attacker;
- membership copying, foreign reparse acceptance, or recursive traversal through a membership target; or
- Git/`gh` workspace reclamation before process-tree settlement is proved, or a stronger sudden-power-loss guarantee than flushed files/records plus predicate-based recovery.

## 10. Delivery roadmap and local Windows testing

This checklist sequences the implementation, native acceptance and npm publication outcomes in sections 2, 6 and 8; it is not execution authorization. Use shared codecs, consent, identity, views and lifecycle policy, adding Windows mechanisms only for concrete gaps.

Checked W0–W8 implementation bullets record the independently reviewed internal source/host work summarized in section 7, not fresh execution receipts or native acceptance. Native/installed/terminal qualification bullets remain open. W9's documentation preparation below is independently reviewed; candidate execution remains pending. W10 package guidance and npm publication remain pending.

Development uses one implementation writer, focused changed-behavior host tests and independent review as appropriate to the task. Native tests establish platform outcomes when authorized. Complete the installed-product matrix and release validation before npm publication.

### W0 — Native foundation and ordinary-user compatibility

- [x] Implement private local storage, stable reads/enumeration, directory publication/recovery, locks and junction membership.
- [x] Compose internal healthy local Skills, absent-home onboarding and activation/current/switching.
- [ ] Complete ordinary-token ACL/handle compatibility and native qualification of current source. Historical elevated development evidence is narrower than full acceptance.

### W1 — Shared filesystem and identity integration

- [x] Share tagged Windows root identity and core profile proofs, with capture-local admission/read stability and unchanged POSIX V1 bytes.
- [x] Implement strict internal V2 codecs and requested-object journal persistence using shared update policy and live operation authority. Old internal V2 shapes refuse without migration.
- [x] Replace standalone journal caller certification with ordinary targeted smoke assertions.
- [ ] Independently qualify changed native reader/journal behavior; host checks do not qualify Windows.
- [x] Complete bounded physical reads for sidecars, nested profile-local contents and collection references through existing shared seams.
- [x] Supply private nested candidate/store materialization with governing entry/byte bounds, no-replace publication and drained writes.
- [x] Preserve executable bits as logical artifact metadata across Windows import/export.
- [x] Complete bounded private-local ZIP staging/random access under the existing archive limits.
- [x] Admit external source/project/Pi/ZIP-destination roots under section 3.1, including permitted different local volumes, before effects.

### W2 — Resources, immutable stores and shared projection

**Depends on:** W0/W1; remote acquisition also needs W6. **Starting seams:** `blob-store.ts`, `artifact-tree.ts`, `profile-materialization.ts`, `profile-view.ts`, `src/skill-collections/`, `src/skills/`.

- [x] Adapt immutable blob/tree publication and validation to accepted Windows file identities, private fresh storage and logical executable metadata; ordinary stable hardlinked inputs are not refused, and exclusive fresh publication retains its own isolation checks.
- [x] Materialize ready local/imported/profile-local Skill and collection artifacts through the existing stable-identity and exact-cache-reuse policy; preserve source ownership and build-free reuse.
- [x] Complete shared system-view reads for sidecars, collection records and artifact trees; remove hard-coded POSIX path splitting and supply the currently hard-coded store reads through existing seams. Occupied state must never disappear as an empty result.
- [x] Complete local and remote `skill list|add|update|remove`, including broken-target/reference-index refusal and link-leaf-only removal without touching source targets. Editor completion is tracked in W8.
- [x] Complete local/remote `library list|add|update|remove`, preserving build-free snapshots and all-referencing-profile validation.
- [x] Complete `package list|add|build|update|remove`, including exact manifest/argv consent, process outcomes, packages-last effects and preservation of the active snapshot after failure (W6).
- [x] Complete active and explicit-profile `skill|library|package list|add|remove` using shared selectors/reference identity, collision withholding and imported collection-child projection. Preserve active-only list and CLI-only mutation boundaries.
- [x] Exercise healthy/changed/missing/foreign/malformed resource paths with host shared-engine tests; connect the internal resource services.
- [ ] Qualify those resource paths, busy handles, native store publication and link/refusal behavior on Windows.

### W3 — One shared profile transaction and recovery policy

**Depends on:** W1 and ready-resource parts of W2. **Starting seams:** `profile-transaction.ts`, `transaction-journal.ts`, `profile-recovery.ts`, `profile-materialization.ts`.

- [x] Compose Windows effects into the existing profile candidate-swap policy for fresh import, overwrite, update, repair and version selection. Do not nest two complete transaction engines or write a second Windows import lifecycle.
- [x] Preserve sorted operation locks, state-lock ordering, expected-old closure, candidate sidecar binding, active selection, explicit overwrite consent and the non-worsening missing-resource rule.
- [x] Carry exact package-effect records and immutable resource references through materialization, commit and failure; never call a side-effectful build a rollbackable file operation.
- [x] Compose bounded deterministic Windows journal discovery and reacquisition/re-read into shared ordinary rename/removal recovery. Recorded host phase/effect-window tests cover convergence and private retention; candidate and sidecar-publication recovery are internally composed without entering POSIX effects, but remain natively unqualified.
- [x] Extend shared recovery composition to candidate swaps and sidecar-only publication; unknown or ambiguous state remains retained with existing protection.
- [ ] Qualify actual native candidate/publication interruption and sharing behavior.
- [ ] Prove fresh/no-replace and candidate/backup replacement at each existing interruption boundary, including postcommit failures, concurrent contenders, sharing denial and clean-process retry.

### W4 — ZIP export/import and cross-platform round trips

**Depends on:** W1/W2/W3; referenced remote acquisition needs W6. **Starting seams:** `profile-capture.ts`, `profile-zip.ts`, `profile-lifecycle.ts`.

- [x] Run the actual shared capture over ready direct Skills, libraries and package artifacts: deterministic preview/exclusions, build-free capture, remote-reference retention and `--bundle-remote` behavior.
- [x] Publish deterministic ZIP output through private siblings at the admitted destination; refuse existing output without explicit overwrite and reconcile failed replacement honestly.
- [x] Inspect/import bounded local or copied network ZIP input through existing canonical/path/manifest checks, including reserved names, aliases, traversal, unexpected entries and malformed data.
- [x] Preserve dry-run's no-home-mutation/no-recovery/no-build/no-login contract, collision reporting, safe suffix, cancellation and `--yes` versus `--overwrite` semantics.
- [x] Execute fresh inactive, exact reuse, safe-suffix and overwrite import; preserve active selection on active-profile replacement and permit initial incompleteness only under the existing settled-network-unavailability rule.
- [ ] Prove macOS/Linux → Windows → macOS/Linux capture/import round trips, resource identities, executable metadata, instructions and source-path/ownership-ID exclusion. Preserve user-authored bytes without promising every Skill or build script is OS-independent.

### W5 — Remaining profile lifecycle and private retention

**Depends on:** W1/W2/W3. **Starting seams:** `profile-managed-lifecycle.ts`, `src/profiles/`, `profile-recovery.ts`.

- [x] Internally compose ordinary-profile rename with shared policy, existing native no-replace sibling movement, lossless root/name-relative closure proof, active selection and valid favorites. Bounded malformed favorite bytes are preserved in shared lifecycle code without a wire change.
- [x] Complete duplicate and rich-profile rename with existing identity/publication rules; preserve imported identities without copying publication linkage.
- [x] Internally compose guarded ordinary removal: generated-empty or fresh lossless preview confirmation, active/stale refusal, absent favorite cleanup, exact retained sibling preserving existing protection and untouched added-Skill targets. Host tests use real shared phase policy and V2 storage.
- [x] Extend guarded removal to rich profiles and applicable authorized cache cleanup; detach only owned state.
- [x] Keep ordinary current/use available after supported terminal lifecycle journals; run recovery only at effectful boundaries, never from views. Selection/favorites use real shared private state-file publication; unsafe or oversized preference objects still refuse.
- [x] Complete favorite reads/writes, malformed-state diagnostics and full profile list/current/use behavior for imported, incomplete and collection-bearing profiles.
- [ ] Natively qualify logical removal and retained profiles/backups with preserved protection without undoing successful detachment or deleting external Skill targets. Preserve the shared resource cleanup semantics; do not add automatic snapshot/blob GC.

### W6 — Git, GitHub and package process behavior

**Depends on:** W1; resource/profile publication uses W2/W3. **Starting seams:** `src/core/child-process.ts`, `profile-github-process.ts`, `profile-remote-materializer.ts`, `src/providers/managed-git.ts`.

- [x] Preserve exact argv, no implicit shell, consent, current process/output limits and bounded failure classification on Windows. Implement bounded interruption/child settlement or honest uncertainty; direct-child closure is not proof that descendants stopped.
- [x] Use private admitted local acquisition/publication workspaces with the existing Git environment, prompting/hooks and credential rules; retain workspaces whenever process-tree settlement is unproved.
- [x] Use independently admitted external Git worktrees for shared project discovery; acquisition/publication workspaces remain private managed state.
- [x] Complete exact-revision acquisition/update for Skills, libraries and packages, including provenance, reachable historical revisions, stable checkout paths and build authorization.
- [x] Complete Git profile import, update, version list/use and repair with exact revisions, linkage, offline cache reuse, discard consent and non-worsening existing-profile updates.
- [x] Complete publish using shared preview/visibility consent, private-first creation, expected-old leases, local/remote intent and predicate recovery; do not replace this with an unnecessary whole-profile swap.
- [x] Implement host refusal/uncertainty paths for absent Git/`gh`, authentication, transport/build and bounded-output failure.
- [ ] Qualify native process/shim interruption and those refusal paths. Real repository creation/push/publication tests require explicit authorization and disposable destinations.

### W7 — Policy, adapters, status and installed Pi

**Depends on:** W1/W2/W5; project/process integration uses W6. **Starting seams:** `src/policy/`, `src/project/`, `src/adapters/pi/`, `src/status/`, `artifacts/pi/bazframe.ts`.

- [x] Wire global/project list/show/enable/disable to shared codecs, locks and state-file behavior; preserve file-free defaults, Git-only project overrides, non-Git inheritance and malformed-state refusal. Do not invent new policy journals.
- [x] Complete adapter list/install/uninstall and explicit `--force` repair at the independently admitted Pi agent directory; preserve extension/manifest ownership and collision behavior rather than swapping the entire Pi directory.
- [x] Complete bounded read-only status and corrective diagnostics for profiles, resources, policy, adapters and caches without bootstrap or recovery side effects.
- [x] Implement installer-bound Windows bootstrap and shared Pi handlers, now reached by awaited default dispatch with fail-closed initialization errors. Default-dispatch regressions use synthetic host/platform/I/O boundaries, not installed Windows evidence.
- [ ] Prove installed `pi` and `pi -nc` instructions, provenance/order, native/profile resource layers, aliases/collision withholding, enable/disable behavior, `/bazframe info` and reload with ordinary and imported profiles.
- [x] Implement the shared deprecated-launcher branch: dry-run, forwarded arguments, refusals, child exit/signal and cleanup uncertainty.
- [ ] Qualify actual Windows launcher/process outcomes through both installed `bazframe pi` and `bzf pi`.

### W8 — Editors and the existing Windows Terminal TUI

**Depends on:** W2/W5/W6/W7. **Starting seams:** editor services, `src/application/tui-service.ts`, existing TUI components/tests.

- [x] Complete profile/Added-Skill editor admission, documented contained final-file links, executable-only `VISUAL`/`EDITOR`, cwd/stdio, Ctrl+C and exact exit/signal outcomes; preserve managed-snapshot/remote-checkout refusal.
- [x] Connect the existing TUI to the same accepted application services for reads, profile mutations, membership, editors and consent-bound library acquisition; do not add new TUI features or move CLI-only operations into it.
- [ ] Qualify native editor target/link admission, executable/shim launch, inherited stdio, Ctrl+C and exact exit/signal outcomes.
- [ ] Automate applicable native terminal enter/restore, resize/same-width growth, compact layout, navigation, refresh, Unicode/ANSI bounds, errors and editor-handoff regressions.
- [ ] **Local:** verify the actual Windows Terminal interaction and restoration checklist below. Headless/fake renderer evidence alone does not establish this environment's behavior.

### W9 — Complete installed-product acceptance

Source preparation opens the public dispatcher and corrects two deterministic startup seams: local Skill-first setup validates source/name and canonical overlap through admitted existing ancestry before protected home/lock bootstrap, with full overlap/provenance rechecks under authority; a successfully validated complete imported managed view may omit its physical membership namespace without a global ENOENT warning. Ordinary missing/invalid directories, unavailable imports and other native/access errors remain diagnostic, membership capability remains explicit, and strict removal proof is still captured before disclosure. No read-time mkdir or permission repair is introduced.

Historical unreproduced native activation/selection/prompt refusals are owner-waived nonblocking launch follow-ups, not passing or cured observations. Preserve their receipts and the separately harness-interrupted import. New current failures and safety assertions are not waived. Independent source review, exact changed-boundary Windows package execution and final release admission remain separate.

**Depends on:** W0–W8; the matrix must cover the integrated product, not just isolated capability tests.

- [x] Independently accept the W9 surface/evidence map below. Every current command/TUI operation is mapped with direct, indirect and missing evidence distinguished.
- [x] Independently accept the full-surface candidate procedure below, including actual CLI and default-Pi routing. Full candidate execution remains pending.
- [ ] Exercise local and global packed installation through `bazframe` and `bzf`, without compiler/WSL/Git Bash/runtime binary downloads, on each Node version the release will claim.
- [ ] Verify missing/corrupt/wrong-target/version/ABI native-artifact diagnostics and storage refusal cases; preserve platform-neutral help/version/syntax, CLI public-routing/admission-refusal tests and Pi initialization-refusal tests.
- [ ] Bind the complete candidate matrix to its exact source, package/native bytes and environment using the existing qualification/release infrastructure.
- [ ] **Local:** complete the fresh-machine/real-terminal matrix below against the designated candidate tarball, not an arbitrary local rebuild or current npm beta.
- [ ] Pass macOS/Linux regression and packed/real-Pi acceptance; reconcile automation, independent evidence review and local findings before npm publication.

### W9 surface/evidence map

**How to use this map.** Anchors below are inspected host tests/scripts, not passed receipts. `test/unit/cli/platform-support.test.ts` retains the compile-time exhaustive list of all 49 reachable command shapes; `profiles-overview` is an unreachable retained union member, not another command. `test/unit/cli/parse-argv.test.ts` covers grammar/migration; `test/unit/cli/json-output.test.ts` and `test/unit/cli/command-results.test.ts` anchor protocol/presentation. These common anchors apply to every CLI row, including lazy Windows application routing and admission refusal. Windows-named host tests use injected/synthetic filesystem/native boundaries; host Git or real shared handlers do not turn them into native runs.

For each exact invocation record success/refusal and privacy-safe diagnostics, prose and supported JSON, and applicable unchanged-state guarantees for read-only/dry-run/cancel/pre-effect refusal paths. After possible effects, verify exact effect reporting, non-worsening/private retention and recovery rather than inventing rollback. Apply consent only where the command offers it (including overwrite/discard/build/rewrite/visibility); it is **not applicable** to effect-free lists/status/help/version or unconditional selection/policy writes. Apply interruption/recovery/private-retention to managed writes/processes according to sections 5–6/8; mutation interruption is **not applicable** to pure reads, which instead need no bootstrap/recovery/build evidence. Editors are user-owned writes, not rollbackable Bazframe transactions; terminal restoration and child outcomes replace transaction-recovery assertions. `--yes` never grants overwrite/discard.

Export/publish/import/update/version commands use schema v2; other JSON-capable commands retain v1. Help/version/TUI/editors/deprecated Pi reject JSON before effects (not missing JSON success coverage). TUI/Pi have no CLI JSON protocol. Status attention is schema-v1 success with exit 3. Existing CLI-only exclusions in section 2.2 remain unchanged.

Historical section 7 source/host reviews and foundation run `34081175304` at `70834d5` are tied to their own snapshots. Current mainline aggregate/packed/real-Pi results must be recorded by the executing owner against final hashes and actual dependencies; this document asserts no fresh pass. **All rows still need the applicable installed/native candidate observations**, through both names and local/global installs; row-specific gaps below supplement that common requirement. Missing outcomes remain failed/not-run, not inferred from a test filename.

| Exact public operations | Existing host anchors | Required outcome distinctions and remaining native/installed evidence |
|---|---|---|
| `profile list`, `profile current`, `profile use <profile>` | `test/unit/profiles/win32-profile-selection.test.ts`; `test/unit/profile-publishing/win32-profile-activation.test.ts`; `test/unit/application/win32-application-journeys.test.ts`; `test/integration/profile-management-cli.test.ts` | Ordinary/imported/incomplete profiles; malformed or missing selection; list/current remain nonmutating; use recovery and private atomic selection. Native sharing/interruption and installed names remain pending. |
| `profile add`, `duplicate`, `rename`, `remove` | `test/unit/profiles/win32-profile-provisioning.test.ts`; `test/unit/profile-publishing/win32-profile-lifecycle.test.ts`; `test/unit/profile-publishing/profile-managed-lifecycle.test.ts`; `test/unit/profile-publishing/profile-recovery.test.ts`; `test/integration/profile-management-cli.test.ts` | Inactive creation/duplicate, rich-profile identities, active rename, guarded removal/`--force`, active-removal refusal, favorite preservation, retained state with preserved protection and untouched external targets; native phase interruption and contention pending. |
| `profile edit <profile>`, `skill edit <skill>` | `test/unit/cli/profile-edit-command.test.ts`, `test/unit/cli/skill-edit-command.test.ts`; `test/unit/core/win32-editor-target.test.ts`; `test/unit/application/win32-application-journeys.test.ts` | Executable-only `VISUAL`/`EDITOR`, target/cwd/link admission, managed/remote Skill refusal, inherited stdio, exit/signal, prelaunch revalidation; JSON rejected. Actual Windows executable/shim and terminal handoff pending. |
| `profile export [--profile …] [--output …] [--overwrite] [--bundle-remote]` | `test/unit/profile-publishing/win32-profile-data-path.test.ts`, `test/unit/profile-publishing/win32-profile-zip-lifecycle.test.ts`; `test/integration/profile-export-cli.test.ts` | Stable deterministic capture, exclusions, bundle/reference behavior, executable metadata, existing-output refusal/explicit replacement, v2 effects and output privacy. Native output publication and cross-platform round trip pending. |
| ZIP `profile import [--dry-run] [--overwrite] [--yes] <zip>` | `test/unit/profile-publishing/win32-profile-zip-lifecycle.test.ts`; `test/unit/application/win32-application-journeys.test.ts`; `test/integration/profile-import-cli.test.ts` | Bounded copy/inspection, dry-run all-false effects and absent-home preservation, fresh inactive/suffix/exact reuse/overwrite/cancel, active replacement, package consent and non-worsening failure. Native unsupported-source copying, ACLs, sharing and interrupted swaps pending. |
| Git `profile import [--commit …] … git:owner/repository`; `profile update [--profile …] [--overwrite]`; `profile version list`; `profile version use <commit>` | `test/unit/profile-publishing/win32-profile-git-host.test.ts`, `test/unit/profile-publishing/win32-profile-git-lifecycle.test.ts`; `test/unit/application/win32-provider-cli-journey.test.ts`; `test/integration/profile-remote-materializer.test.ts` | Exact revision/provenance, unavailable initial import versus non-worsening existing update, repair, offline reuse, discard consent, read-only version listing, candidate recovery. Host Git plus synthetic Windows I/O is not native transport/process acceptance. |
| `profile publish [--profile …] [--public\|--private] [--bundle-remote] [--yes]` | `test/unit/profile-publishing/win32-profile-publication.test.ts`, `test/unit/profile-publishing/profile-publication.test.ts`, `test/unit/profile-publishing/profile-github-process.test.ts`; `test/unit/application/win32-provider-cli-journey.test.ts` | Preview/visibility consent, exact leases, private workspaces, sidecar-only local advancement, local/remote ambiguity and recovery, v2 diagnostics. Actual disposable GitHub effects require later explicit authorization. |
| `skill list`, `add <absolute-root-or-git-source>`, `update [--accept-rewrite] <skill>`, `remove <skill>` | `test/unit/providers/win32-managed-git.test.ts`, `test/unit/providers/win32-managed-git-host.test.ts`; `test/unit/application/win32-provider-cli-journey.test.ts`; `test/integration/managed-git-cli.test.ts`, `test/integration/skill-membership-cli.test.ts` | Local versus owned remote lifecycle, stable paths/provenance, exact reuse/update/rewrite refusal, reference-index uncertainty and source preservation. Native junction and process behavior pending. |
| `library list`, `add`, `update [--accept-rewrite]`, `remove` | `test/unit/skill-collections/win32-ready-resources.test.ts`; provider/application Windows tests above; `test/integration/skill-collection-cli.test.ts`, `test/integration/managed-git-cli.test.ts` | Local/remote preparation, build-free snapshots, all-dependent validation, zero-Skill objects, imported/physical collisions, missing mutable source, referenced-remove refusal and failed-candidate non-worsening. Native stores and installed listings pending. |
| `package list`, `add [--yes]`, `build`, `update [--accept-rewrite] [--yes]`, `remove` | `test/unit/skill-collections/win32-ready-resources.test.ts`; `test/unit/providers/win32-managed-git.test.ts`; `test/integration/skill-collection-cli.test.ts`, `test/integration/managed-git-cli.test.ts` | Exact manifest argv and explicit build consent, local/remote distinctions, immutable active snapshot preservation, referenced removal, stdout/stderr/exit/signal and nonrollbackable effects. Native child/process/shim uncertainty pending. |
| `profile skill list`; `profile skill add\|remove [--profile <profile>] <skill>` | `test/unit/profiles/profile-skill-membership.test.ts`; `test/unit/profile-publishing/profile-resource-membership.test.ts`; `test/unit/skill-collections/win32-ready-resources.test.ts`; `test/integration/skill-membership-cli.test.ts` | Active-only list versus active/explicit mutations, imported membership, exact target/name/link identity, idempotence, link-leaf-only removal and stale selection refusal. Native junction behavior pending. |
| `profile library list`; `profile library add\|remove [--profile …] <library>`; `profile package list`; `profile package add\|remove [--profile …] <package>` | `test/unit/profiles/profile-skill-collection-reference.test.ts`; `test/unit/application/reference-index-consumers.test.ts`; `test/unit/skill-collections/win32-ready-resources.test.ts`; `test/unit/application/win32-application-journeys.test.ts`; `test/integration/skill-collection-cli.test.ts` | Exact whole-object references, no build/update side effect, collision withholding, imported-plus-physical inputs, read-only listing and narrow removal. Native installed projection/reference mutations pending. |
| `project list\|enable\|disable`; `global show\|enable\|disable` | `test/unit/application/win32-policy-discovery.test.ts`, `test/unit/application/win32-application-journeys.test.ts`; `test/integration/cli.test.ts` | File-free defaults; Git/non-Git distinction; external worktree admission; project-over-global precedence; enable setup validation; disable without setup; malformed/expected-old refusal and retained private writes. Native external-root and atomic policy behavior pending. |
| `adapter list`; `adapter install pi [--force]`; `adapter uninstall pi` | `test/unit/adapters/pi/win32-installation.test.ts`, `test/unit/adapters/pi/win32-bootstrap.test.ts`; `test/unit/application/win32-application-journeys.test.ts`; `scripts/test-pack.mjs` | Package/runtime/native integrity, external Pi-root admission, ownership/drift/collision refusal, authorized repair, retained discovery-safe uninstall and unrelated-file preservation. Actual installed default Pi bootstrap remains pending. |
| `status` | `test/unit/status/status.test.ts`; `test/unit/application/reference-index-consumers.test.ts`, `test/unit/application/win32-application-journeys.test.ts`; `scripts/test-pack.mjs` | Read-only bounded profile/policy/adapter/resource/cache diagnostics; physical-direct counts; collection withholding; schema-v1 success with attention exit 3. No bootstrap/recovery/build. Native installed reads pending. |
| `pi [--dry-run] [-- <Pi args>]` | `test/unit/agents/win32-spawn-pi.test.ts`; `test/unit/application/win32-application-journeys.test.ts`; parser and integration CLI tests | Deprecated launcher preserved; dry-run/no temporary publication; forwarded-argument refusal; JSON rejection; actual launch, exact child status/signal and cleanup uncertainty. Both installed Windows names pending. |
| `tui` | TUI map below; `test/unit/cli/tui-command.test.ts`; `test/integration/tui-cli-state-agreement.test.ts`, `test/integration/tui-pty.test.ts`; terminal scripts | Lazy capability admission; JSON and noninteractive refusal; real terminal entry/error/restoration. Both installed names and Windows Terminal pending. |
| Help, version, malformed syntax, migration guidance | Parser/platform tests; alias/help checks in `scripts/test-pack.mjs` | Remain platform-neutral without native initialization. Validate actual Windows path grammar and npm launchers, not just injected platform values on POSIX. |

#### Existing TUI and installed Pi

| Exact operation set | Existing host anchors | Pending acceptance |
|---|---|---|
| `loadDashboard`, `loadSkillPreview`: Skills/Profiles/Adapters/Settings views; Added Skill/library/package/child collapse, preview, diagnostics, authoritative refresh | `test/unit/application/tui-service.test.ts`; `test/unit/tui/app.test.tsx`, `test/unit/tui/state.test.ts`; `test/unit/application/win32-application-journeys.test.ts` | Native bounded reads and Windows Terminal rendering/navigation; Adapters/Settings remain read-only. |
| `createProfile`, `useProfile`, `toggleProfileFavorite`, `renameProfile`, `removeProfile` | `src/application/tui-service.ts:246–251`; `test/unit/application/tui-service.test.ts`; `test/unit/tui/app.test.tsx`; `test/unit/profile-publishing/win32-profile-lifecycle.test.ts`; `test/unit/profiles/win32-profile-selection.test.ts` | Native publication, stale preview/active-profile refusal, favorites and private retention, through both installed names. No new CLI favorite command. |
| `duplicateProfile` | `test/unit/profile-publishing/profile-managed-lifecycle.test.ts` exercises shared duplication; `test/integration/tui-cli-state-agreement.test.ts` duplicates through CLI then checks dashboard visibility. Both are indirect evidence for the TUI method. | Direct TUI-service/UI duplication coverage remains pending, along with native publication and both installed names. |
| `editProfileInstructions`, `editSkillDefinition`, `addMembership`, `removeMembership` (selected profile) | `src/application/tui-service.ts:252–255`; `test/unit/core/win32-editor-target.test.ts`; `test/unit/application/win32-application-journeys.test.ts`; `test/integration/tui-cli-state-agreement.test.ts`, `test/integration/tui-pty.test.ts` | Real editor suspension/restoration, target revalidation, exit/Ctrl+C and native link behavior. |
| `inspectLibraryInput`, directory browsing, `inspectLibraryCandidate`, `addLibrary` (prepared-local/remote-Git consent) | `src/application/tui-service.ts:257–259`; `test/unit/application/tui-service.test.ts`; `test/unit/tui/app.test.tsx`; `test/unit/application/win32-provider-cli-journey.test.ts` | Native external-source/path/process behavior, explicit consent/cancel, no build or automatic profile reference. |
| Compact/wide layout, focus, scrolling, resize/same-width growth, Unicode/ANSI width, accessibility/error/refresh/Ctrl+C/cleanup | `test/unit/tui/app.test.tsx`, `test/unit/tui/state.test.ts`, `test/unit/tui/run-tui.test.tsx`, `test/unit/tui/app-color.test.ts`; `test/integration/tui-pty.test.ts`; `scripts/test-tui-terminal.mjs`, `scripts/test-tui-terminal-linux.mjs` | Actual Windows Terminal; representative SSH/font/locale/manual assistive evidence remains separately open under `docs/tui-design.md:106`. |
| Actual `pi`, `pi -nc`, `/bazframe info`, `/bazframe reload`, session startup, resource discovery, input and before-agent-start | `test/unit/adapters/pi-artifact.test.ts`; `test/unit/adapters/pi/win32-runtime.test.ts`, `test/unit/adapters/pi/win32-bootstrap.test.ts`; `scripts/test-real-pi.mjs` | Real installed default extension, native/profile context provenance/order, policy, ordinary/imported resource projection, alias/whole-object failure withholding, reload and compatibility. Mock ExtensionAPI handlers are not installed Pi evidence. |

The Pi evidence has three distinct boundaries: `test/unit/adapters/pi-artifact.test.ts` tests shared handlers, but its Windows missing-binding case **rewrites the platform declaration and poisons `resolveState` in the source under test**; it is synthetic failure evidence. `test/unit/adapters/pi/win32-bootstrap.test.ts` retains exact installer-produced internal-bootstrap tests and also exercises the actual default export with simulated platform/version and byte/import/native boundaries, without replacing routing. `test/unit/core/win32-native.test.ts` and `test/unit/cli/platform-support.test.ts` separately test loader refusal and public CLI routing without rewriting the shipped Pi source. None proves installed Windows default Pi; genuine normal discovery against exact installed bytes remains required.

### W9 candidate procedure (reviewed; execution pending)

This procedure prepares and qualifies exact package bytes before npm publication. Native/remote execution and publication still require authorization.

1. **Identify the current routing and evidence.** Inspect the real CLI entrypoint and default Pi export, including the current platform checks described in section 5.1. Ordinary source builds/tests omit native bytes; normal push CI runs foundation/Added-Skill-slice workloads, not the full W9 matrix. Test-time source patches or internal-dispatch wrappers do not establish installed entrypoint behavior.
2. **Identify and isolate the candidate.** Record the clean source commit, disposable qualification checkout, ordinary-user native Windows x64 machine/token and local-NTFS roots, concrete Node/npm/Pi versions, native shell/npm launchers, local/global prefixes, Windows Terminal/font/locale, reviewed ZIP/Git/build fixtures, and explicitly authorized disposable remote accounts/repositories. Do not reuse personal installations or the unsettled historical remote workspace. The existing Node 22.19.0 job does not qualify all of `>=22.19.0`; untested claimed versions remain gaps. Pi must be stable in `>=0.84.4 <0.85.0 || >=0.85.1`.
3. **Review production routing.** The central CLI transition must let the real `src/cli.ts` entrypoint reach existing production Windows application composition. Both bins remain `dist/cli.js`. Separately, the actual default Pi extension must await installer-bound Windows bootstrap, validate its reference/package/runtime/native bytes before runtime import, and register the real shared handlers. The default now calls the existing `createWindowsBoundPiAdapterForInternalTesting` bootstrap and catches initialization errors into active fail-closed handlers, rather than relying on Pi to stop after a factory rejection. Review that routing and bootstrap failure reporting (absent/stale binding before import) through the normal development workflow, preserving non-Windows behavior and capability checks. Merely opening the CLI gate or calling the internal export from a harness is not installed-default evidence. Installed acceptance must use those production entrypoints rather than a test-only switch.
4. **Bind exact source, bytes and environment.** Build from the designated candidate using pinned Rust/MSVC/native sources and the existing build-only `foundation-evidence` packaging mechanism; that mode does not create the assembly admission record required by the npm publication workflow. Record commit/tree and any reviewed source delta, package/native version and contract, Node/npm/Rust/MSVC versions, native SHA-256, whole-tarball SHA-256 and inventory. Never relabel an older native binary. Designate and retain one tarball, then install that same file everywhere without repacking. Record resolved dependency versions/lock or installed-tree inventory and Pi executable path/package/version: a Bazframe tarball alone does not bind transitively resolved dependencies or an external `PI_BIN`.
5. **Reuse qualification infrastructure truthfully.** `scripts/run-win32-qualification.mjs` runs foundation and Added-Skill product-slice workloads, not this matrix. Current tooling uses native contract 9, foundation-v8 and product-v6 schemas. Historical foundation-v6/all-62 and product-v3/all-72 receipts (including `70834d5`/run `34081175304`) cannot certify W9 or new source. `scripts/verify-win32-added-skill-evidence.mjs` requires open dispatch and verifies the limited existing internal slice plus public CLI smoke: each alias independently adds/uses/reads a fresh profile, refuses active forced removal with unchanged profile/selection, and preserves an absent home during read-only listing. Source runs execute the real CLI; packed runs execute genuine local npm CMD shims. Native contract 9 and foundation schema 8 require new qualification. Product schema 6 retains `releaseAdmission: "not-authorized"` and `windowsSupportClaim: false`; it does not certify full W9. Review actual changed-boundary native/package execution separately; do not hand-edit receipts, reuse old counts as thresholds or introduce a parallel certification service. Platform-refusal evidence stays bound to the exact source/artifacts that produced it.
6. **Exercise genuine installed entrypoints.** Install the designated tarball locally and into a disposable global prefix with dependency lifecycle scripts disabled, without compiler/WSL/Git Bash/runtime binary-download requirements. Execute every applicable CLI row through both installed `bazframe` and `bzf` in both modes, using separate operation state. Invoke actual npm-generated launchers through the native shell being claimed; POSIX-style `spawnSync(".cmd", …, {shell:false})` or substituting `node dist/cli.js` is not Windows npm-entrypoint proof. Install the adapter with those public commands and run actual installed Pi's normal discovery/default-extension path: plain `pi`, `pi -nc`, info/reload, resource discovery/input/before-agent-start, ordinary/imported profiles, disabled policy, collisions and deprecated launchers. No replaced extension or test-factory registration counts.
7. **Run and retain the complete outcome matrix.** Apply sections 8.1–8.3 and the local checklist, including first-visibility ordinary-user ACLs, external roots/reparses/aliases, native reads/locks/journal phases, busy handles/antivirus, Git/build/shim/editor effects, executable transport and terminal restoration. Use separately identified disposable corrupt copies for missing/corrupt/wrong-target/ABI/version/malformed-artifact negatives, never mutate the designated good tarball. Accepted routing must refuse these before sensitive effects; the public CLI now reaches those capability checks. Preserve first failures, sanitized output and private retained fixtures. Repairs require a new reviewed source/artifact binding and affected reruns; overlapping historical passes are not a final-snapshot aggregate.
8. **Obtain independent full-matrix sign-off before npm publication.** Classify each outcome passed/failed/not-run/not-applicable, with reasons and source/artifact/environment/invocation bindings. Missing native, remote, claimed-Node or terminal evidence leaves the npm publication matrix incomplete. Existing `scripts/test-pack.mjs` and `scripts/test-real-pi.mjs` are supported-host regressions: each packs/installs afresh and deletes its tarball/fixture tree in `finally`; pack checks aliases but not every operation through both, and real-Pi primarily uses `bazframe` plus a separately resolved Pi. They do not consume a designated external candidate or retain native failure state. Reusing them for candidate acceptance requires a separately reviewed exact-input/retention/Windows-launcher delta. A final source/version/dependency change requires new provenance and affected validation; beta.3 evidence cannot authorize differently versioned bytes.
9. **Keep publication separate and exact.** Follow [releasing.md](releasing.md), preserving same-run numeric artifact-ID, repository/run/commit, archive-digest and whole-tarball checks, not historical artifact-name searches. The existing final foundation inventory is exactly `artifacts/native/win32-x64-msvc/bazframe-win32.node`, `native-binary.sha256`, `native-foundation-evidence.json`, `native-source-evidence.json`, `native-installed-evidence.json`, `native-rust-version.txt`, `native-msvc-version.txt`; final product contains `source.json` and `installed.json`. Input/diagnostic artifacts are not final admission outputs. Eventual release tarball inspection requires exactly one regular `.node` at `package/artifacts/native/win32-x64-msvc/bazframe-win32.node`, its admitted digest, and no assembly admission record. Assembly admission authenticates the binary but does not exercise the installed-product matrix. Publication needs separate authorization, an unused version and protected npm environment; publish only the reviewed checksummed file without rebuild/repack, then verify registry bytes/tags and repeat disposable installed acceptance.

### W10 — Release preparation and publication

**Depends on:** W9. **Authority:** `docs/releasing.md`; no release action is authorized merely by this checklist.

- [ ] Update help, README, platform/storage/Node prerequisites and generated Skill guidance for the actual accepted surface; retain TUI production-readiness caveats and do not claim arbitrary source Skills/builds are cross-platform.
- [ ] **Maintainer:** configure/verify npm trusted publishing and the protected GitHub `npm` environment; choose an unused version and explicitly authorize tag/publication.
- [ ] Run final release checks/audit and review the exact package contents; prove same-workflow-run native admission, checksum binding and repeated final-tarball validation without a repack between approval and publication.
- [ ] Publish only the authorized exact artifact, verify registry byte identity/tags and repeat disposable Windows installation through both executable names.

`profile exportable`, automatic historical snapshot GC, additional architectures/filesystems, new TUI features and stronger same-authority attack guarantees are separate product work, not hidden additions to this Windows roadmap.

### Local maintainer checklist

When native validation is separately authorized, select focused smoke tests for changed platform behavior or the existing `scripts/run-win32-native-foundation.ps1` developer harness as appropriate. Use a fresh disposable private local-NTFS tree, record the source/environment and ordinary versus elevated token, and preserve failed state. Developer build tools are not end-user installation requirements. Do not run qualifications concurrently on a machine using the foundation harness's machine-global SUBST fixture.

Return sanitized pass/fail/not-run results and requested artifact bindings, not raw private logs or fixture trees. Historical local evidence references in section 7 and local startup notes are provenance only, not portable execution prerequisites. The stopped historical Windows journal worker’s remote process settlement remains unconfirmed: preserve its workspace/evidence/fixtures and do not reuse it for qualification. Its private execution-record reference remains in local startup guidance; neither that record nor private logs are portable qualification prerequisites.

**Complete installed candidate: follow W9’s routing and exact-artifact procedure.** Use a designated checksummed candidate and disposable `BAZFRAME_HOME`, `PI_CODING_AGENT_DIR` and installation prefix/global environment; do not replace a working personal installation or import unreviewed private instructions.

- [ ] **Local — installation:** clean local and isolated global install, both executables, supported Node version(s), no native build tools needed; record candidate digest and environment.
- [ ] **Local — migration:** import a reviewed macOS/Linux ZIP with direct Skills and collection/package artifacts; verify instructions/resources, inactive import, activation and Pi use; export back and compare on macOS/Linux. Include suffix/overwrite/cancel/dry-run and bundled versus referenced remote resources.
- [ ] **Local — lifecycle:** create/list/current/use/duplicate/rename/favorite/remove, active-removal refusal, local/remote resource operations, package consent, explicit versus active membership and source-target preservation.
- [ ] **Local — policy/runtime:** Git and non-Git directories, global/project precedence, adapter install/repair/uninstall, status, `pi`/`pi -nc`, info/reload, collisions and deprecated launcher outcomes.
- [ ] **Local — terminal/editor:** Windows Terminal navigation, resize, compact/wide layouts, previews, library consent, editor handoff, Ctrl+C, handled failure and terminal restoration, including the user's normal shell/font/display settings.
- [ ] **Local — failures:** safe disposable cases for denied sharing/open handles, occupied output, invalid selection/records and unsupported storage. Only run interruption fixtures against dedicated test state; report retention/diagnostics instead of deleting ambiguous state.
- [ ] **Local — real Git effects:** use explicitly authorized disposable repositories/accounts for publish/private-import/visibility tests; never a working repository as a failure fixture.
- [ ] **Local — sign-off:** link findings to the candidate/environment, distinguish passed/failed/not-run, and hand back sanitized results. Local sign-off complements, rather than replaces, the automated full matrix and release authorization.
