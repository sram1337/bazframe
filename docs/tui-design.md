# Bazframe terminal UI design

> Status: implemented boundary; terminal production-readiness gates remain open.

## Purpose and scope

`bazframe tui` is a keyboard-first Ink interface with top tabs `Skills`, `Profiles`, `Adapters`, and `Settings`. It uses typed application services directly and never parses CLI output or spawns Bazframe subprocesses.

The Skills tab presents one uninterrupted list of collapsible peers under `Skills`:

- **Added Skills** — live, individually added Skills from the internal `(default)` catalog.
- **Library `<id>`** — one prepared Skill library.
- **Package `<id>`** — one built Skill package.

There are no category headings or separator rows. The Added Skills parent appears first, followed by current library order and then current package order. Library/package children are informational. Profiles select whole libraries or packages; no child-selection model exists. Healthy zero-Skill objects remain visible with `0 Skills`.

The TUI may add a prepared library after explicit literal-`y` consent. It does not add a profile reference. Package add/build, library update/remove, package remove, and library/package profile-reference mutations remain CLI-only. Package build output must remain visible in the invoking terminal, so no package build runs in the TUI.

## Typed application boundary

The dashboard service exposes:

```text
DashboardSnapshot
  activeProfileId?
  profiles[]
    id, directory, instructionsPath, active, favorite, memberships[]
    libraryReferences[], packageReferences[]
  collections[]
    key, kind, id, root, digest, artifactRoot?, skillsRoot
    referenceCount, health, refreshAvailability, diagnostics[]
  skillGroups[]
    added-Skill group and kind-qualified library/package groups
  status, diagnostics[]
```

Collection keys and Skill origins are kind-qualified (`library:<id>` and `package:<id>`). Displayed paths are not mutation authority. Every write re-resolves and revalidates its target in core services.

The write surface is:

```text
createProfile / duplicateProfile / useProfile / toggleProfileFavorite / renameProfile / removeProfile
editProfileInstructions
editSkillDefinition                 # Added Skills only
addMembership / removeMembership    # Added Skills only
inspectLibraryCandidate
addLibrary
```

Framework objects stop at the presentation boundary. Core profile, Skill, collection, status, and settings modules do not import React, Ink, or terminal types.

## Skills interaction

The Skills master pane renders selectable `Added Skills`, `Library <id>`, and `Package <id>` parent rows directly beneath the single `Skills` title. Its viewport offset and resize clamping use that rendered peer-and-child row list without category rows. Library/package rows show kind, ID, provider root, activated digest, reference count, health, and Skill count. Object detail shows artifact root, Skills root, and update/build availability, including for a zero-Skill object; compact layouts expose the same fields in a dedicated route.

Right/`l` expands any parent or moves to its first Skill, while `o`/`c` explicitly expand/collapse any parent. Enter/`L` opens detail for a selected library/package or previews a selected Skill; Enter on Added Skills retains its collapse toggle. Left/`h` unwinds hierarchy in the browser and returns from detail; `H`, Escape, and Backspace also return. Stable kind-qualified row IDs prevent a library and package with the same ID from collapsing into one row.

Added Skill previews read live provider `SKILL.md`. `e` may launch the external editor only for Added Skills. A library/package preview is immutable and directs the user to edit provider input, then run `bazframe libraries update <library>` or `bazframe packages build <package>`.

### Add Library

The `a` flow accepts an absolute physical directory or exact `~`/`~/` expansion, then shows entered and canonical roots and the canonical-basename library ID. Browsing and inspection write nothing. Final literal `y` calls the library lifecycle once.

A root-level `bazframe-package.json` blocks the flow with `bazframe packages add <absolute-root>` guidance. Library addition executes no provider command and creates no profile reference.

## Profiles interaction

Preferred layout uses a Profiles master and detail pane; compact layout drills into one route. Detail shows separate sections for:

- individual Included Skills;
- referenced Libraries;
- referenced Packages;
- Available Skills and unreferenced library/package objects.

Added Skill children support individual membership through `a`. A selected library/package object or child reports the whole-object CLI reference command and never toggles a child. Unavailable references remain visible with diagnostics.

The Profiles master is exactly one logical list: `+ Create New Profile` first, then the valid current profile, inactive favorites in lexical order, and all remaining profiles in lexical order. Initial and fallback reconciliation selects the current profile when present; Up from it reaches Create, and an empty profile set selects Create. Compact layout left-aligns Create, while preferred/wide layout right-aligns it within the same Profiles-column row. Current profiles use `▶`; inactive favorites use `★`. A current favorite remains stored and is announced accessibly, but only `▶` is visible.

Lowercase `f` toggles persistent global favorites for the selected current physical profile. Lowercase `x` starts the existing guarded profile-deletion confirmation; lowercase `d` does not delete. Profile-detail `x` continues to remove the selected direct membership. Profile lifecycle, explicit inactive-profile membership, instruction editing, stable selection, stale removal authorization, and viewport behavior retain their existing guarded core contracts. Selecting an inactive profile never changes global active selection unless the user invokes Use.

## Focus, layout, and accessibility

Tab focus is separate from body focus. `Tab`/`Shift+Tab` traverse focus; number/bracket keys and focused-tab Left/Right select top tabs. Body Left/Right uses the nested master/detail hierarchy. `j`/`k` and `h`/`l` are portable directional aliases; uppercase `H`/`L` remain compatibility bindings.

Preferred size is `80x24`; minimum interactive size is `60x16`. Below minimum, the UI renders a bounded resize message and domain actions are inert. Reducer-owned offsets preserve selections across refresh and resize and clamp after resource removal.

Color is supplementary. `NO_COLOR` and accessibility output retain text markers, active/parent/inactive hierarchy, diagnostics, counts, and action meaning. Plain-text Skill preview neutralizes terminal controls and uses cell-width-aware truncation.

## Safety invariants

- Provider roots are never edited, deleted, fetched, or implicitly prepared by browsing or library operations.
- Package processes run only from explicit CLI package add/build.
- Snapshot previews are immutable.
- Library/package references are whole-object and read-only in this TUI slice.
- A mutation is serialized, followed by authoritative refresh; no optimistic domain state is shown.
- Favorite state is an exact bounded schema-v1 physical state file under `BAZFRAME_HOME`, written atomically under the shared state lock. Malformed state is diagnosed without hiding profiles and is never replaced by a toggle.
- Dismissible snapshot warnings are separate from persistent errors.
- External editor handoff suspends Ink, restores the terminal, redraws, and refreshes after every child outcome.
- Adapter and Settings tabs remain read-only and consume structured status diagnostics.

## Verification and residual gates

Deterministic reducer/component/service tests cover stable reconciliation, nested navigation, compact and preferred layouts, library consent, package-manifest refusal, profile references, immutable editor guidance, no-color/accessibility output, scrolling, resize, and error recovery.

PTY gates cover alternate-screen entry/restoration, Ctrl+C, resize, editor handoff, handled/fatal errors, cleanup, and bounded Unicode/ANSI cell widths on the recorded macOS and Linux environments. Windows Terminal, representative remote SSH, terminal/font/locale ambiguous-width differences, and manual assistive-technology evidence remain open before claiming broad production readiness.
