# Bazframe TUI Design

> Status: first management slice implemented and still under hardening; not production-ready

Bazframe's first graphical management surface is a keyboard-first terminal UI launched with `bazframe tui`. The TUI is a presentation layer over Bazframe's profile, membership, status, and adapter APIs; it uses typed services rather than implementing a second set of filesystem semantics by spawning CLI commands or mutating state directly.

## Goals

- Make profiles, skill sources, and settings discoverable without sacrificing terminal-native workflows.
- Work well locally, over SSH, and in ordinary developer terminals.
- Keep navigation predictable with the keyboard and usable without a mouse.
- Support one skill source now and multiple sources without redesigning the tree.
- Preserve Bazframe's existing ownership, validation, and destructive-operation safeguards.

## Non-goals for the first slice

- A desktop window, browser server, or embedded web UI.
- Settings writes or provider-owned skill-artifact mutation before their ownership contracts are approved.
- A built-in full text editor or external-editor launch.
- A provider registry or real multi-source configuration.
- Skill packs, profile export, or dependency-aware bundles.
- New skill-artifact ownership hidden behind the UI.

## Implemented boundary

The current slice pins runtime `ink@7.1.1` and `react@19.2.8` and loads them lazily only after the CLI dispatches `bazframe tui`. It implements the three-tab shell; profile create, duplicate, use, rename, and guarded removal; a two-pane selected-profile direct-membership editor; a read-only Skillbook source browser; and structured read-only setup status in Settings. The service and CLI membership paths both accept an explicit profile without changing active selection.

Deterministic reducer/component/service tests cover compact and below-minimum layouts, resize state preservation, pane boundaries, guarded removal, graceful and forced exits, non-color state markers, and screen-reader output. CLI/TUI state-agreement integration coverage exercises profile lifecycle and inactive-profile membership while preserving provider artifacts. A real macOS pseudo-terminal smoke verifies alternate-screen entry/restoration and linear screen-reader output, while the packed-package gate runs an interactive TUI smoke when `script` is available. `npm test` and `npm run test:real-pi` pass with this slice present.

The top-tab focus model is now separate from active-tab and body/pane focus: `Tab` and `Shift+Tab` traverse focus, while `Left`/`Right` or `h`/`l` moves focused-tab selection and `Enter` activates it. Lists accept `j`/`k` as `Down`/`Up`, and the profile editor accepts portable `J`/`K` pane jumps. The reducer now owns persistent offsets for the profile list, Included pane, Available pane, and Skills browser, with stable-row visibility and authoritative shrink/resize clamping. Completed terminal evidence covers macOS direct PTY/local tmux and Linux arm64 digest-pinned-base container direct PTY/tmux/loopback SSH. Local installed-tarball tmux additionally proves real Ink fatal-render restoration and preferred/compact CJK, combining-mark, emoji-ZWJ, ANSI-SGR, and long-unbroken-path terminal-cell bounds. Still open are deeper source-tree behavior; canonical source identity and broken-root semantics for symlinked/retargeted Skillbook roots; editor launch; settings writes; provider move/rename; additional real sources; Windows Terminal; representative remote SSH; terminal/locale ambiguous-width differences; and manual assistive-technology validation. These gaps preclude a production-ready claim.

## Application shell

The TUI has no sidebar. A persistent top navigation bar contains three tabs:

```text
┌──────────────────────────────────────────────────────────────┐
│  Profiles  │  Skills  │  Settings                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                     active tab content                       │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ contextual status, diagnostics, and key hints                │
└──────────────────────────────────────────────────────────────┘
```

Only the active tab's content occupies the body. Active profile and active tab retain `*` markers, while source expansion retains `v`/`>` semantics. Focus uses a cyan bold border (or the same bold border without color under `NO_COLOR`), and selected rows/tabs use inverse/bold styling plus descriptive accessibility labels rather than cursor-arrow prefixes. Inactive focusable sections retain subdued classic borders. Number keys and bracket cycling remain direct active-tab shortcuts. `Tab` and `Shift+Tab` move focus between the top-tab region and the active body; in the profile editor the cycle includes Included and Available as separate pane stops. While the top tabs own focus, `Left`/`Right` or `h`/`l` moves the focused-tab cursor without activation and `Enter` activates it. Each implemented list/browser region retains an independent reducer-owned scroll offset. Deeper tree expansion remains open.

## Skills tab

The Skills tab is a tree navigator. Every configured skill source is a root node represented by its path. The tree must work with one root and with multiple roots:

```text
▾ ~/.skillbook/skills/
  ▸ code-review
  ▾ testing
      SKILL.md
      references/
▸ ~/mySkillLibrary/skills/
```

The current read-only browser implements one expandable Skillbook root and its immediate valid skill entries. Browsing files below a skill, retained descendant expansion, and additional real roots remain future work.

### Target tree behavior

- Source roots appear in deterministic configured order.
- Skill directories and their children appear in deterministic lexical order.
- `Enter` expands or collapses the selected expandable node.
- Collapsed nodes retain their previous descendant expansion state when practical.
- The view scrolls to keep the cursor visible.
- The UI distinguishes source roots, skill directories, ordinary files, symlinks, broken entries, and validation diagnostics.
- Move and rename actions require both an approved ownership contract and a source capability; a writable flag alone never grants authority.
- Tree discovery uses `lstat`-style entry inspection and never follows directory symlinks outside the source root.
- Operations must refuse replacement, path escape, unsafe skill IDs, and unmanaged or ambiguous symlinks.

### Skill-source model

The tree should consume a provider-neutral source projection rather than read only one hard-coded directory:

```text
SkillSource
  id
  displayPath
  canonicalPath
  provider
  writable capabilities
  diagnostics
```

For the current provider, the displayed tree root is the resolved configuration path to `<Skillbook library>/skills`, not the parent library where provider metadata may live. The service also projects its `realpath` when the root exists, and the browser shows both when they differ. The adapter returns zero or one Skillbook source whose immediate valid skills may be linked into profiles but whose artifacts remain provider-owned and non-writable by Bazframe. The view projection is array-shaped, but additional real sources are not configured or validated. Canonical authority for symlinked/retargeted roots and behavior for a missing or broken root remain unsettled, especially because removal must continue to recognize an expected broken membership without provider content.

### Move and rename ownership gate

The requested move/rename behavior expands beyond Bazframe's current direct-membership ownership. Skillbook presently owns artifacts, IDs, updates, and lock state. Implementation is blocked until review settles:

- which sources are writable by Bazframe;
- whether moves may cross source roots or only occur within one root;
- whether a provider must perform the operation instead of Bazframe;
- how rename updates the directory ID, `SKILL.md` frontmatter `name`, and provider lock metadata;
- how occupied destinations, rollback, broken links, and partial failures are handled;
- whether removal or movement uses trash/undo or is immediately destructive.

Until that contract is approved, move/rename controls may be shown as unavailable with an ownership explanation, but they must not silently mutate provider-owned artifacts.

## Profiles tab

The Profiles tab initially presents a full-width profile list rather than a sidebar:

```text
Profiles

  ● focused
    reviewer
    frontend

  + Create New Profile
```

- The active profile is marked independently of cursor selection.
- `+ Create New Profile` is an ordinary selectable row.
- Opening a profile enters the profile editor within the Profiles tab.
- Returning to the list preserves the prior selection and scroll position.
- Existing guarded create, use, rename, and remove semantics remain authoritative.

## Profile create and edit view

Creating or editing a profile uses two vertically stacked, full-width horizontal panes. Both use the same tree/list visual language as the Skills tab:

```text
Profile: focused                                            [active]

┌─ Included skills ────────────────────────────────────────────┐
│  code-review                                                 │
│  testing                                                     │
└──────────────────────────────────────────────────────────────┘
┌─ Available skills ───────────────────────────────────────────┐
│  ▾ ~/.skillbook/skills/                                      │
│      debugging                                               │
│  ▸ ~/mySkillLibrary/skills/                                  │
└──────────────────────────────────────────────────────────────┘
```

The top pane contains the profile's direct included skills. The lower pane contains available skills grouped under their source roots. Adding and removing membership must call the same verified membership APIs as the CLI.

The current editor header shows profile identity and active state. Lifecycle actions are available from the profile list. Pressing `e` reports that instruction editing is unavailable; a later slice may open `AGENTS.md` in the configured editor after CLI discoverability and editor lifecycle are approved.

### Pane navigation and scrolling

- Normal directional movement advances the selection within the focused pane; `j`/`k` are portable aliases for `Down`/`Up`.
- If the next item is outside the viewport, movement scrolls that pane while keeping the cursor visible.
- Reaching the first or last content item does not immediately trap focus: another movement beyond the content boundary transfers focus to the adjacent pane when one exists.
- `Shift+Direction` bypasses item traversal and jumps directly to the adjacent pane in that direction when the terminal reports the modifier.
- For the vertically stacked panes, `Shift+Down` or portable `J` moves from Included to Available; `Shift+Up` or portable `K` moves from Available to Included.
- A pane with no items is still focusable and presents its empty-state action.
- Pane focus and cursor selection must remain visually distinct.
- The current slice retains stable-ID cursor selection and explicit reducer-owned scroll offsets independently for Included and Available. Navigation and authoritative reconciliation keep the selected row visible without resetting the other pane.

The proposed action keys are specified below. `Enter` continues to mean expand/collapse for tree nodes and must not acquire a conflicting destructive meaning.

## Settings tab

Settings currently renders the structured, read-only setup inspection used by `bazframe status`: Pi adapter state/version, global policy, effective current behavior, active-profile readiness and skill count, cached collision-alias count, and corrective actions. A status failure is isolated as a typed diagnostic so profile and source reads can remain available. The view explicitly states that no writable settings are defined.

Potential write surfaces—editor command, configured sources and precedence, adapter paths, and policy—remain unapproved. The TUI must not invent a second settings format; writes require settled ownership, persistence, validation, and CLI interoperability.

## Safety and confirmation behavior

- Read-only browsing must never create state or repair entries implicitly.
- Profile removal follows the current active-profile refusal and `--force` boundary.
- Destructive confirmations state exactly which physical path will change and which external targets remain untouched.
- Skill membership operations preserve source skills and provider lock state.
- Tree operations must display provider and canonical source before a move or rename is confirmed.
- Errors stay in context and preserve cursor, expansion, pane, and scroll state so the user can recover.

## Architecture seam

The TUI should call typed application services for:

- profile list/current/create/duplicate/use/rename/remove;
- skill-source discovery and tree projection;
- direct membership add/remove;
- instruction opening;
- status and diagnostics;
- settings resolution.

Rendering, keyboard input, focus, and viewport state belong to the TUI. Filesystem ownership, locking, path validation, provider behavior, and atomicity remain in the core. Framework selection must preserve this boundary.

## Framework proposal

[`tui-framework-research.md`](tui-framework-research.md) records the framework evidence and alternatives. **Implemented decision: use exact runtime pins Ink 7.1.1 and React 19.2.8.** Framework selection does not settle the remaining interaction, ownership, accessibility, or platform gates.

Ink's released full-screen layout, lifecycle, test, and accessibility machinery outweighs its moderate dependency footprint for Bazframe. Pi's imperative `@earendil-works/pi-tui` remains documented as the lean no-React alternative but is not selected. OpenTUI is excluded while its native renderer requires Bun or Node 26.4 experimental FFI rather than Bazframe's standard Node `>=22.19.0` runtime.

Framework objects must stop at the presentation boundary. Core profile, membership, source, status, and settings modules must not import React, Ink, or terminal types.

## Launch and terminal lifecycle

- The TUI is launched explicitly with `bazframe tui`; bare `bazframe` behavior does not change.
- Both stdin and stdout must be interactive TTYs. Otherwise the command exits with a concise diagnostic and points to the ordinary CLI commands; it never emits raw full-screen frames to a pipe.
- The selected TUI framework is loaded through a dynamic `bazframe tui`-only entry path. Existing non-TUI commands must not import React, Ink, or Pi-TUI, so their startup time and memory remain unchanged.
- The default visual mode uses the alternate screen and restores the prior screen, cursor, raw mode, bracketed paste, and keyboard protocol on normal exit, Ctrl+C, handled errors, and rejected startup. Screen-reader mode is the explicit exception: it disables alternate-screen and incremental repaint behavior in favor of linear descriptive output.
- `q` exits only when no text field or modal owns input. `Ctrl+C` requests exit globally. During a mutation, the first `Ctrl+C` records an exit request and waits for the authoritative service result; it does not falsely report cancellation. A second `Ctrl+C` is explicit force-exit authorization: restore terminal state, exit 130, and warn on stderr that the operation outcome may be unknown. Tests cover both graceful and forced paths.
- The instruction editor must run through a Bazframe child-process service using `shell: false` and a framework-appropriate terminal handoff. Ink provides `suspendTerminal()`; a Pi-TUI choice requires Bazframe to stop raw/alternate-screen state, run the child, then restart and fully redraw. Editor parsing, arguments, environment, exit reporting, and recovery remain blocked on the editor-command review gate.
- A process-level fatal-error boundary attempts terminal restoration before printing a plain stderr diagnostic. It must not claim rollback beyond guarantees made by the called application service.
- In the reviewed Ink 7.1.1 lifecycle, `App`'s internal error boundary calls the exit handler. `Ink.unmount(error)` then runs React input cleanup, exits the alternate screen, restores the cursor, drains stdout, and rejects the exit promise. Bazframe's existing `runTui()` catch reports the plain diagnostic after that rejected `waitUntilExit()`.
- The exact package set is runtime `ink@7.1.1` plus `react@19.2.8`, and development `@types/react@19.2.18`, `ink-testing-library@4.0.0`, plus the test oracle `string-width@8.2.2`. The build includes `react-jsx`/`.tsx` support while retaining NodeNext ESM. Runtime imports occur only through the lazy TUI entry path, and the packed application carries its own dependencies rather than relying on Pi's global installation.

## Application data and service contract

The TUI consumes immutable, presentation-neutral projections. The minimum snapshot is:

```text
DashboardSnapshot
  revision, activeProfileId
  profiles[]
    id, directory, instructionsPath, active
    membershipWritable, membershipDiagnostic, memberships[]
  sources[]
    id, provider, label, root, canonicalRoot, artifactWritesSupported, skills[]
  status
    available: structured adapter/policy/repository/profile/cache/corrective-actions inspection
    unavailable: isolated typed diagnostic
  diagnostics[]
```

Tree nodes require stable Bazframe projection IDs, source identity, display labels, canonical paths where applicable, node type, expansion capability, action capabilities, provenance/manageability, and diagnostics. Projection IDs must not assume an unapproved provider contract. A node ID is UI identity, not authority to mutate its path. Every mutation re-resolves and revalidates its target in the core service.

The TUI-facing service interface should expose typed reads and commands rather than CLI strings or preformatted status text:

```text
loadDashboard(signal?)
createProfile(id)
duplicateProfile(sourceId, newId)
useProfile(id)
renameProfile(oldId, newId)
removeProfile(id, authorization)
addProfileSkill(profileId, { sourceId, skillId })
removeProfileSkill(profileId, { sourceId, skillId, membershipId })
openProfileInstructions(profileId)
```

Existing CLI behavior remains authoritative. Profile lifecycle methods delegate to the guarded core operations. Setup status is a structured inspection shared with CLI formatting rather than parsed from `buildStatus().text`; failures are isolated from profile and source projections.

The implemented membership service requires an explicit `profileId` and source/member reference while preserving global-then-profile lock order, symlink validation, source ownership, idempotence, and refusal rules. Legacy physical directories and foreign or mismatched links remain visible but unmanageable with an explanatory diagnostic. The canonical CLI commands are `bazframe profile skills add <skill> --profile <profile>` and matching `remove`; omission preserves active-profile behavior. The TUI never activates a profile as a hidden way to edit it.

## Interaction state model

The target navigation model remains a pure state machine separated from effects and rendering. Its full intended durable state includes:

```text
TuiState
  activeTab
  focusedTab
  routeWithinTab
  focusedRegion
  selectedProfileId
  selectedNodeIdByRegion
  firstVisibleRowByRegion
  expandedNodeIdsByRegion
  overlayStack
  loadState and snapshotRevision
  mutationState
  persistent status/error message
```

The current reducer implements independent active-tab, focused-tab cursor, body/pane focus, stable-ID profile and skill selection, profile route, source-root expansion, modal state, snapshot reconciliation, and persistent offsets for the profile list, both membership panes, and Skills browser. Navigation keeps selected stable-ID rows visible; authoritative refresh/data shrink and resize clamp only offsets that require it. Descendant tree expansion remains incomplete.

Target rules:

- Active profile, active tab, focused-tab cursor, selected row, and body/pane focus are independent state.
- Selection is stored by stable ID, never only by array index.
- Expansion, cursor, and scroll offsets are retained per region while its owning route remains open.
- Refresh reconciles by stable ID. If an item disappeared, selection moves to the nearest surviving sibling, then parent, then the first selectable row.
- Resize only clamps viewport and scroll state; it never changes domain selection, invokes an action, or discards expanded descendants.
- Opening a modal records its invoking focus target. Confirm, cancel, and handled error return focus there when it still exists, otherwise to the nearest valid region.
- Text entry and confirmation modes capture keys before global or view-level handlers.

## Proposed keymap

The primary bindings avoid function keys and platform-specific modifiers. Modified arrows remain accelerators with portable alternatives.

### Global

| Key | Action |
|---|---|
| `1`, `2`, `3` | Open Profiles, Skills, or Settings directly when no text input owns the key |
| `[` / `]` | Open the previous / next top tab directly |
| `Tab` / `Shift+Tab` | Cycle focus between top tabs and body; in the profile editor, traverse top tabs, Included, and Available. |
| `?` | Open contextual help overlay |
| `r` | Refresh the current snapshot when no mutation is running |
| `Esc` | Close the top overlay or return one route level; no implicit mutation |
| `q` | Quit outside text input and modal modes |
| `Ctrl+C` | Request application exit |

### Lists and trees

| Key | Action |
|---|---|
| `Up` / `Down`, `k` / `j` | Previous / next selectable row |
| `PageUp` / `PageDown` | Move by one visible page |
| `Home` / `End` | First / last selectable row |
| `Left` / `h` | Collapse an expanded node; otherwise select its parent |
| `Right` / `l` | Expand a collapsed node; otherwise select its first child |
| `Enter` | Expand/collapse a tree node, open a profile row, or invoke a focused non-destructive button |
| `Shift+Up` / `Shift+Down`, `K` / `J` | Jump directly to Included / Available in the profile editor |

While the top tabs are focused, `Left`/`Right` or `h`/`l` moves the focused-tab selection without activation and `Enter` activates it. `J`/`K` are the required portable pane-transfer bindings when a terminal cannot distinguish modified arrows; `Tab` and `Shift+Tab` also retain deterministic focus traversal. Key-release events never trigger actions. Modals and text input capture these characters before global or view-level shortcuts.

### Profile actions

| Key | Action |
|---|---|
| `c` | Create profile |
| `D` | Duplicate selected profile into a new ID |
| `u` | Use/activate selected profile |
| `R` | Rename selected profile |
| `d` | Open profile removal confirmation |
| `e` | Open the selected profile's instructions in the configured editor |
| `a` | Add the selected Available skill to the open profile |
| `x` | Remove the selected Included skill from the open profile |

Profile actions are active only in the relevant route and region. Disabled actions remain visible in help/status with an explanation. The Skills-tab `m` move and `R` rename actions remain unavailable until provider ownership is approved.

### Confirmation rules

- `y` confirms an ordinary non-content-removing action; `n` or `Esc` cancels. `Enter` does not confirm a destructive action by itself.
- Removing a generated-empty non-active profile may use the ordinary confirmation.
- Authorizing recursive removal of profile content requires typing the exact profile ID. That authorization is also bound to the dashboard's JSON-safe profile-removal identity: physical directory identity plus a deterministic recursive fingerprint of every profile-owned physical directory entry and regular-file content. Core removal recomputes it under the global state lock immediately before deletion; a mismatch preserves the current profile and requires refresh plus a new confirmation. Every symlink is fingerprinted from its own metadata and raw link text but remains a leaf, so membership, provider, and all other symlink targets are never read. Immediate CLI `profile remove --force` remains live authorization and does not require a dashboard identity. A checkbox or generic `y` must not broaden the CLI's `--force` authority.
- Every destructive dialog keeps the operation, labeled physical profile identity/path, deletion scope, provider/membership-target preservation, and confirm/cancel controls visible. Recursive removal also keeps the exact-profile-ID instruction and input visible.
- While a command is running, its confirmation cannot be submitted again.

## Layout, resizing, and width safety

The implemented preferred terminal size is `80x24`; the minimum is `60x16`.

- At or above `80x24`, render the full border, header metadata, body, persistent status line, and contextual key hints.
- From `60x16` through `79x23`, use compact mode: ASCII-safe separators, shorter hints, and reduced padding while keeping required controls and safety information visible.
- Below `60x16`, replace the body with a non-destructive size message showing current and required dimensions plus `q` quit and `?` help keys. Domain actions remain inert, but Ctrl+C retains global precedence and any already-open modal retains input ownership after a resize, including `Esc`, text entry, and destructive `y`/`n` controls. Below-minimum help and active dialogs use bounded minimal views rather than rendering the full shell or full-size overlay. Keep application state in memory so resizing back restores the prior view.
- The top tab region and bottom status/hint region have fixed row budgets. The body receives the remaining rows.
- The profile editor gives Included and Available the same conservative share of usable body rows. Preferred layouts provide at least three content rows per pane; compact layouts provide one content row per pane. Any remainder stays unallocated rather than changing pane height with focus.
- In the implemented prototype, overlays render inside and are bounded by the application body within the terminal root. They reserve mandatory prompt/input and action-control rows; destructive confirmations also reserve the safety rows named above rather than allowing variable detail to displace them.
- Long destructive target sets use a deterministic count plus the first two examples. Long displayed paths, values, and examples may be terminal-truncated while their labels and the required safety contract remain visible.
- Complete visual detail and scroll affordances for overflow content, access to untruncated values, and two-cell overlay margins remain future production work; the prototype does not claim them.
- Comprehensive terminal-cell-width validation, including CJK, combining-mark, emoji/ZWJ, grapheme, ANSI, and long-unbroken-path cases, remains future production work; current coverage does not claim it.

## Refresh, mutations, and errors

- Initial load, explicit `r`, and successful mutations request a complete new snapshot. File watching is outside the first slice.
- Each load has a monotonically increasing request generation. Late results from superseded loads are ignored.
- The management TUI permits one mutation at a time. Mutation controls are disabled while it runs.
- Domain changes are never optimistic. The UI shows progress, waits for the typed service result, reloads, then reconciles cursor and expansion state.
- A failed mutation keeps the pre-command navigation state, displays the typed error in context, and offers retry only when the service reports it safe.
- Diagnostics are data with severity, resource identity, message, and optional corrective action. Rendering never scrapes CLI output.
- Core services own locks, atomicity, rollback, and partial-failure reporting. The TUI only reports those outcomes.

## Accessibility and presentation

- Every Bazframe state transition exposed by the TUI retains an ordinary CLI equivalent; the full-screen UI is not the only accessible path. Opening `AGENTS.md` in an external editor is a convenience action and remains unavailable until its underlying path and equivalent manual/CLI workflow are documented.
- Color is never the sole signal. Strong versus classic border styles distinguish focused and inactive sections; inverse/bold styling and accessibility labels identify selection; text markers remain for active and expanded state.
- `NO_COLOR` disables the cyan active border without removing its stronger border style or hierarchy.
- Compact/ASCII-safe rendering keeps `>` only for a collapsed expandable source, `v` for an expanded source, `*` for active profile/tab state, `[active]` where shown, and `-` for ordinary hierarchy.
- Setting `INK_SCREEN_READER=true` enables Ink's linear screen-reader mode, disables alternate-screen and incremental rendering, and exposes descriptive labels for implemented tabs, lists, panes, and status. Automated output checks are best-effort; a Bazframe-named option/bridge and manual assistive-technology validation remain open because terminal screen-reader behavior varies.
- Animation is nonessential and disabled in screen-reader/reduced-refresh mode.
- Status and errors remain available until superseded or dismissed; transient color flashes are not the only feedback.
- Mouse input may be added later but must never be required.

## Test strategy

Current deterministic coverage includes stable-ID reducer reconciliation; separate active/focused top-tab and body/pane state; forward and reverse focus cycles; top-tab cursor movement and Enter activation; source expansion; modal precedence, including resize-while-modal ownership; typed service projections and selected-profile authorization; fixed-size Ink rendering with `string-width@8.2.2` cell bounds for CJK, decomposed combining text, emoji-ZWJ, ANSI SGR, and long unbroken paths at `80x24` and `60x16`; compact and below-minimum behavior, including bounded minimal help; resize state preservation including focused-tab cursor state; pane-boundary transfer; guarded removal; graceful/forced Ctrl+C; Kitty key-release handling; non-color state markers; and linear screen-reader output. Service tests prove explicit inactive-profile membership changes preserve active selection and provider content, and CLI/TUI state-agreement integration coverage exercises the shared profile lifecycle and membership state.

On macOS, the default real pseudo-terminal coverage verifies normal quit, idle Ctrl+C with exit 130, alternate-screen/cursor restoration, handled diagnostic rendering with continued interaction, no leaked process group, and screen-reader output without erase/alternate-screen sequences. The package gate installs the tarball, verifies exact runtime dependencies and lazy non-TTY behavior, and runs an interactive smoke when `script` is available.

The opt-in `npm run test:tui-terminal:local` gate packs and installs the current tarball into isolated temporary state and uses an isolated tmux server—never the user's server—to prove preferred → compact → below-minimum → restored resizing with the profile editor preserved; a live-lock service error followed by continued interaction; idle Ctrl+C; graceful and forced in-flight Ctrl+C; an actual Ink render error propagated by rejected `waitUntilExit()` with exit `1` and the exact plain diagnostic; and `80x24`/`60x16` tmux-grid behavior for CJK, decomposed combining text, emoji-ZWJ, ANSI SGR, and a truncated long unbroken path. Every scenario checks the exact exit status, tmux alternate-screen state, cursor and `stty` restoration, owned-server/process cleanup, and temporary-artifact cleanup under the existing measured eight-second whole-scenario contract.

The opt-in `npm run test:tui-terminal:linux` gate passed twice consecutively in a Linux arm64 Node 22 Debian container built from a digest-pinned base image. Debian apt repositories and package selections are mutable, so this is not a byte-reproducible environment claim; every run records the base digest plus the installed versions of all directly requested apt packages and their exercised tools. The gate runs the direct GNU `script` PTY checks and the complete installed-tarball tmux matrix, then creates ephemeral host/client keys and uses public-key-only, batch-mode loopback SSH with strict host-key checking and a forced PTY to repeat the tmux matrix. The uniquely named container/image tag, sshd, keys, state, and tmux servers are removed on completion. This is Linux arm64 container PTY/tmux/loopback-SSH evidence—not Linux desktop-terminal or representative remote-network evidence.

Remaining coverage includes deeper trees and additional roots; Windows Terminal; representative remote SSH behavior; terminal/font/locale differences for ambiguous-width and emoji presentation; manual assistive-technology validation; and editor suspension after that feature is approved. The bounded local corpus is dependency- and tmux-specific and does not prove those environments, so this remains not production-ready.

## Implementation sequence

Implementation proceeds as separate vertical slices:

1. **Framework foundation — implemented:** exact dependencies, build support, terminal lifecycle wrapper, reducer, shell, and test harness.
2. **First management slice — implemented, under hardening:** `bazframe tui`; active top tabs with a separate focused-tab cursor and body/pane focus cycle; profile lifecycle; zero-or-one Skillbook source projection; two-pane selected-profile membership; structured read-only setup status; confirmations; compact/below-minimum modes; help; and current automated/PTY/package coverage. Deeper trees and broader terminal validation remain outside the completed subset; persistent per-view offsets are implemented.
3. **Instruction editor — open:** selected-profile instruction launch after editor ownership, CLI discoverability, and child-process lifecycle are approved.
4. **Additional providers/settings — open:** zero/many real roots and editable settings only after registry and persistence decisions.
5. **Skill artifact move/rename — open:** only after provider ownership, lock metadata, cross-root, rollback, and recovery semantics are approved.

Each slice updates `TODO.md`, passes the existing default and real-Pi gates when relevant, adds observable TUI tests, and receives independent interaction/safety review. TUI documentation and implementation remain separate from the current profile/policy/adapter release batch.

## Review gates

### Recorded decisions

1. **Framework — approved:** Ink 7.1.1 with React 19.2.8, exact initial pins, TUI-only dynamic loading, and framework-neutral application services.
2. **Management scope — approved:** profile create/duplicate/use/rename/remove plus direct skill-membership add/remove for the selected profile and matching explicit-profile CLI commands, while Skillbook artifacts and lock state remain untouched.
3. **Service boundary and safety — approved:** explicit-profile membership service, unambiguous source/member identity, one mutation at a time, no optimistic domain state, and parity with current guards and `--force` authorization.
4. **Interaction and support targets — approved for implementation:** the top tabs and full profile/membership keymap; confirmations; macOS, Linux, Windows Terminal, SSH, and tmux validation; preferred `80x24`, minimum `60x16`; inert below-minimum state; no-color/ASCII/screen-reader behavior; and component plus PTY test layers. Platform validation remains an acceptance task, not a claim of completed support.

### Deferred approvals

5. **Editor lifecycle:** editor command ownership, CLI discoverability, parsing, and terminal suspension.
6. **Additional sources:** registry, ordering, provider contracts, and real multi-root configuration.
7. **Settings writes:** scope, ownership, persistence, validation, and CLI interoperability.
8. **Skill artifact operations:** provider ownership and transaction semantics for move/rename.

Decisions 1–4 and the first management acceptance boundary are approved. Deferred controls remain unavailable and explanatory.

## Remaining acceptance outline

Before a production-ready claim, Bazframe must:

- implement and test deeper source navigation and any bindings introduced with those deeper nodes;
- settle canonical identity and broken-root removal semantics for symlinked/retargeted provider roots;
- retain the proven macOS direct-PTY/local-tmux and Linux arm64 digest-pinned-base container direct-PTY/tmux/loopback-SSH gates with run-recorded package/tool versions while adding Windows Terminal and representative-remote SSH evidence;
- validate residual terminal/font/locale differences for ambiguous-width and emoji presentation;
- complete manual assistive-technology checks;
- keep editor launch, settings writes, additional real sources, and provider move/rename unavailable until their respective ownership and lifecycle decisions are approved.

The implemented tests already cover guarded profile lifecycle, explicit selected-profile membership without hidden activation, provider preservation, compact/resize state behavior, deterministic exits, read-only structured Settings status, macOS real-PTY restoration, and packed interactive startup/exit.
