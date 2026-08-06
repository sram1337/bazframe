# TUI Framework Research

> Evidence date: 2026-08-04. This is design research, not implementation approval.

Bazframe needs a keyboard-first, full-screen management UI with responsive panes, source-rooted trees, modal confirmations, deterministic tests, safe terminal restoration, and a clean boundary around its existing TypeScript application services. This document compares the current released frameworks against those needs.

## Executive conclusion

**Dependency fact:** Ink 7.1.1 is a React renderer and requires React. Pi's `@earendil-works/pi-tui` is imperative and does not require React.

**Ink is the feature-complete proposal** if React/TSX is acceptable. It is the best match for a standalone full-screen Bazframe management application today because the released package provides Flexbox layout, focus management, resize hooks, alternate-screen operation, Kitty keyboard support, child-process terminal suspension, deterministic render tests, and basic screen-reader output. The cost is introducing React/TSX and a larger dependency graph into a project that currently has no runtime dependencies.

Pi itself uses **`@earendil-works/pi-tui`**, a custom imperative line-rendering framework from the Pi monorepo. It is the best no-React alternative and aligns exactly with Bazframe's Node floor, but the released 0.83.0 API leaves tabs, trees, constrained panes, alternate-screen layout, editor suspension, and a consumer test terminal largely to Bazframe. Pi's current unreleased main branch is adding alternate-screen and stack/scroll layout primitives, which is useful direction but also evidence of near-term API churn; unreleased APIs are not a selection basis.

**OpenTUI is not compatible with Bazframe's current runtime contract.** OpenTUI 0.5.1's native renderer uses Bun, or Node 26.4 with experimental FFI. Bazframe currently supports standard Node `>=22.19.0`. OpenTUI should be reconsidered only if that runtime boundary changes.

Terminal-kit is a credible imperative fallback. The Blessed family should not be selected for greenfield work because its released packages and React integration are stale.

## What Pi uses

The installed Pi 0.82.0 package directly depends on `@earendil-works/pi-tui` `^0.82.0`. The current published Pi and TUI packages are 0.83.0.

### Architecture

Pi-TUI components implement:

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}
```

The TUI owns raw terminal input, focus, overlays, render scheduling, ANSI-safe differential redraws, synchronized output, and terminal capability handling. Focusable text inputs emit a zero-width `CURSOR_MARKER`, allowing the renderer to position the hardware cursor for IME candidate windows.

The released package provides:

- `TUI`, `ProcessTerminal`, `Container`, `Box`, `Text`, and width-safe string utilities;
- `Input`, `Editor`, `SelectList`, `SettingsList`, loaders, Markdown, and images;
- structured key matching with legacy and Kitty keyboard handling;
- capturing and non-capturing overlays with focus restoration;
- resize callbacks, synchronized output, Windows terminal handling, and differential rendering.

Pi builds complex controls itself. Its session tree selector flattens a domain tree into visible rows and owns expansion, filtering, selection, scrolling, help, and input routing. This is the relevant model for Bazframe: the framework supplies terminal machinery, while the application supplies tree and navigation semantics.

### Released-package limitations for Bazframe

The released 0.83.0 package does not export the `HStack`, `VStack`, `ScrollView`, `TuiAltScreen`, or `TuiMainScreen` APIs currently present on the repository's unreleased main branch. Its `Container` vertically concatenates children; it is not a layout engine. Bazframe would own its fixed shell, body-height allocation, tabs, trees, pane clipping, independent scroll state, and compact-mode layout.

The README mentions a `VirtualTerminal`, but the npm package does not export or ship that test helper. Bazframe would need its own fake `Terminal` for unit/integration tests and a separate PTY test layer.

The package should be consumed only as a direct pinned dependency. Bazframe must never import Pi's globally installed nested copy.

### Package evidence

- Current release: `@earendil-works/pi-tui` 0.83.0, published 2026-07-29.
- Runtime: Node `>=22.19.0`, ESM.
- Package's own unpacked size: 1,802,523 bytes across 118 files.
- Direct runtime dependencies: `marked` and `get-east-asian-width`.
- License: MIT.
- Repository: [earendil-works/pi, packages/tui](https://github.com/earendil-works/pi/tree/v0.83.0/packages/tui).
- Installed API reviewed locally: Pi 0.82.0 and Pi-TUI 0.82.0.

## Candidate comparison

Package sizes below are npm `dist.unpackedSize` for the named package only, not total installed dependency size.

| Candidate | Current release | Runtime/package facts | Strongest fit | Main concern | Disposition |
|---|---|---|---|---|---|
| Ink | 7.1.1, 2026-07-16 | Node `>=22`; ESM; 556,730 B/186 files; 25 direct dependencies plus required React `>=19.2` peer | Responsive full-screen layouts, lifecycle, testing, accessibility | React/TSX and dependency/build expansion | **Feature-complete proposal** |
| `@earendil-works/pi-tui` | 0.83.0, 2026-07-29 | Node `>=22.19`; ESM; 1,802,523 B/118 files; 2 direct dependencies | Lean imperative control and Pi alignment | Released layout/test/suspension gaps; young API | **No-React proposal** |
| OpenTUI core | 0.5.1, 2026-08-04 | Bun `>=1.3`; native Zig core; Node renderer requires Node 26.4 experimental FFI; 13,056,185 B/181 files plus platform packages | Rich, fast full-screen renderer and test API | Violates current runtime; native distribution; 0.x churn | **Reject under current constraints** |
| terminal-kit | 3.1.4, 2026-07-19 | Node `>=16.13`; CommonJS; 4,111,526 B/106 files; 8 direct dependencies; types separate | Broad imperative terminal/document toolkit | Large API, weaker strict-TS/ESM fit, custom app state | Fallback only |
| blessed | 0.1.81, 2015-09-03 | Legacy CommonJS; no current release | Mature classic widget catalog | Stale release and modern terminal/Unicode risk | Reject |
| neo-blessed | 0.2.0, 2018-06-13 | Legacy CommonJS | Blessed-compatible fixes | Repository last pushed in 2021; stale release | Reject |
| react-blessed | 0.7.2, 2021-03-11 | React peer range `<18`; reconciler from the React 17 era | Declarative Blessed widgets | Incompatible with current React and stale | Reject |

### Ink

Ink is a React terminal renderer using Yoga/Flexbox. Version 7.1.1 has the specific primitives Bazframe otherwise has to build around a lower-level renderer:

- `Box` layout with width/height/flex constraints for tabs, fixed header/footer, and stacked panes;
- `useWindowSize` and `useBoxMetrics` for responsive layout and viewport budgets;
- `useFocus` and `useFocusManager` for focus regions;
- `useInput` with arrows, modifiers, Kitty protocol metadata, and paste-aware handling;
- `alternateScreen` for a full-screen application;
- `suspendTerminal()` to leave raw/alternate-screen mode for `$EDITOR`, then restore and redraw;
- `incrementalRendering`, synchronized output, and configurable frame limits;
- `ink-testing-library`, `renderToString`, injected streams, and frame assertions;
- basic screen-reader mode with a subset of ARIA roles, state, and labels.

Ink does not provide Bazframe's source tree, navigation reducer, modal policy, or ownership semantics. Those remain application code. The proposed exact initial set is runtime `ink@7.1.1` and `react@19.2.8`, plus development `@types/react@19.2.18` and `ink-testing-library@4.0.0`. The build would need `.tsx` includes and `react-jsx` compiler settings, followed by packed-package verification.

Official sources: [Ink repository](https://github.com/vadimdemedes/ink/tree/v7.1.1), [Ink npm package](https://www.npmjs.com/package/ink), and [ink-testing-library](https://github.com/vadimdemedes/ink-testing-library).

### OpenTUI

OpenTUI offers an imperative core plus React and Solid bindings, a native Zig renderer, Flexbox layout, selectable and scrollable components, structured keyboard events, and an unusually capable `@opentui/core/testing` API. Its published optional packages cover Darwin, Linux glibc/musl, and Windows on x64/arm64.

Those capabilities do not overcome the runtime mismatch. The official getting-started documentation says creating the native renderer requires Bun, or Node 26.4 with `--experimental-ffi` (and `--allow-ffi` when Node permissions are enabled). Selecting it would change Bazframe's runtime and distribution contract, not merely add a UI library.

Official sources: [OpenTUI repository](https://github.com/anomalyco/opentui), [getting started](https://opentui.com/docs/getting-started), [testing](https://opentui.com/docs/core-concepts/testing), and [`@opentui/core` on npm](https://www.npmjs.com/package/@opentui/core).

### Terminal-kit and Blessed family

Terminal-kit remains active and has broad terminal control, screen buffers, document widgets, input, and menus. It is viable when imperative low-level control matters more than declarative composition. For Bazframe it would introduce a broad CommonJS runtime plus separately maintained TypeScript declarations while still leaving responsive state and test adapters to the application.

Blessed and its forks have useful classic widgets, but their release history makes them poor foundations for a new Node 22+ TypeScript application. `react-blessed` additionally requires React below 18, while current Ink and OpenTUI React bindings use React 19.

Official sources: [terminal-kit](https://github.com/cronvel/terminal-kit), [blessed](https://github.com/chjj/blessed), [neo-blessed](https://github.com/embark-framework/neo-blessed), and [react-blessed](https://github.com/Yomguithereal/react-blessed).

## Accessibility and terminal portability

No terminal framework provides browser-equivalent accessibility across terminal emulators and screen readers. Alternate-screen repainting, cursor motion, and cell updates may be poorly announced. Ink's screen-reader mode is a meaningful advantage, not a universal guarantee.

Bazframe should require all of the following regardless of framework:

- every Bazframe state transition exposed by the TUI remains available through the ordinary CLI;
- focus, active state, selection, expansion, diagnostics, and disabled actions use text/symbol cues, not color alone;
- `NO_COLOR` is honored and an ASCII-safe presentation is available;
- help and errors persist long enough to review;
- mouse input is optional and never required;
- a screen-reader mode disables alternate-screen/incremental repainting, uses linear descriptive output, and avoids animation where practical;
- modified keys have unmodified portable alternatives;
- manual checks cover representative macOS, Linux, Windows Terminal, SSH, and tmux environments.

## Testing and package gates

A framework is acceptable for the first management slice only if it proves:

1. `80x24`, `60x16`, below-minimum, and rapid-resize behavior without state loss.
2. Zero, one, and multiple synthetic roots with nested expansion and independent pane scrolling.
3. Keyboard-only tab, region, list, tree, and pane navigation with portable key paths.
4. Capturing help and confirmation overlays that restore focus after close, confirm, cancel, and service errors.
5. Profile lifecycle and direct-membership commands remain disabled while another mutation runs and refresh from authoritative core state afterward.
6. Unicode paths containing CJK, combining marks, emoji, and long unbroken segments.
7. No-color, ASCII-safe, and framework-appropriate screen-reader render paths.
8. Clean teardown after normal exit, graceful Ctrl+C, explicit force-exit Ctrl+C during a stalled mutation, and thrown errors.
9. Deterministic reducer and renderer tests plus a real PTY smoke test.
10. `npm pack` installation and launch on the declared OS/architecture matrix.
11. No imports from Pi's global installation and no filesystem mutations in UI components.

`$EDITOR` suspension, real additional sources, Settings writes, and provider-owned skill-artifact operations are separate acceptance gates for later slices.

## Decision

**Selected: Ink 7.1.1 plus React 19.2.8.** Its stronger released full-screen layout, lifecycle, testing, and accessibility features justify the moderate dependency footprint for Bazframe. Initial runtime versions will be pinned exactly, and the TUI will be loaded only by `bazframe tui` so existing commands do not pay its startup or memory cost.

`@earendil-works/pi-tui` 0.83.0 remains the documented no-React alternative but is not selected. Application services and view models remain framework-neutral so this decision does not alter ownership or persistence behavior.
