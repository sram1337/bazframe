# Scratchpad

## Current state

- `docs/design.md` is the current product source of truth.
- Bazframe implements four useful projections without introducing a fourth artifact type: Skills, live individually added Skills in `(default)`, prepared Skill libraries, and buildable Skill packages. Every discovered child remains a Skill.
- Libraries and packages have independent exact schema-v1 global namespaces and exact whole-object profile-reference namespaces. Their typed identity is `(kind, canonical-root-basename)`, so a library and package may share an ID.
- Both kinds publish immutable content-addressed artifacts under `<BAZFRAME_HOME>/skill-snapshots/sha256/<digest>/`. Libraries snapshot prepared roots without executing anything. Packages require exact physical `bazframe-package.json`, execute literal argv directly without a shell or sandbox, snapshot the complete artifact root, and discover only below the declared Skills root.
- Library update/package build validates the candidate and every referencing profile before atomically changing the global record. Failed activation preserves the previous digest. Removal is refused while referenced. Reference-index uncertainty fails closed.
- Old pre-alpha umbrella state, manifests, commands, and profile directories have no reader, alias, migration, or fallback. Obsolete shipped modules are removed.
- Zero-Skill libraries/packages are healthy. Discovery retains lexical DFS, depth/entry/SKILL bounds, physical no-follow containment, `.git`/`node_modules` skips, root-versus-descendant exclusion, and Pi 0.82-authoritative loading.
- Direct profile Skills win over a colliding referenced object by withholding that complete object. Colliding libraries/packages are all withheld atomically; unrelated Skills remain effective. Kind-qualified keys keep same-ID objects independent.
- CLI, status, the standalone Pi artifact, and `/bazframe info` report libraries and packages separately with kind-correct recovery commands.
- The TUI Skills tab presents one uninterrupted list of collapsible `Added Skills`, `Library <id>`, and `Package <id>` peers without category sections. It can add a prepared library only; package commands and all refresh/remove/reference writes remain CLI-only. Library/package preview is immutable and points to provider edit plus `libraries update` or `packages build`.
- `skills/bazframe/SKILL.md` is the tracked self-management Skill and build generates the byte-identical `dist/skills/bazframe/SKILL.md`.

## Current command surface

```text
bazframe libraries [add <absolute-root> | update <library> | remove <library>]
bazframe packages [add <absolute-root> | build <package> | remove <package>]
bazframe profile libraries [add|remove <library> [--profile <profile>]]
bazframe profile packages [add|remove <package> [--profile <profile>]]
```

Individual `add skill`, `remove skill`, and `profile skills` behavior remains live and distinct. There are no singular library/package aliases and no obsolete umbrella commands.

## Ownership and safety

Library providers own prepared bytes and external preparation. Package providers own project bytes, dependencies, build behavior/output, credentials, and publication. Bazframe owns explicit package-process execution, snapshot staging/publication, records, references, activation validation, runtime projection, and diagnostics. Profiles own whole-object selection and individual Skill membership.

All development and acceptance tests use temporary Bazframe/Pi homes. Do not run tests against `$HOME/.bazframe`.

## Current validation

- `npm test`: build, typecheck, lint, 450 unit tests, 36 integration tests, and packed-package validation pass.
- `npm run test:real-pi`: Pi 0.82 adapter, library update, package build, shared artifact, inert old state, provider preservation, and repository-stability checks pass.
- `npm run test:tui-terminal:local`: all 12 recorded macOS tmux scenarios pass with terminal restoration.
- Generated Bazframe Skill bytes match, obsolete production readers are absent, `git diff --check` passes, and the staging area is empty.
- Independent core/security, TUI/product, and proof-matrix reviews accept the migration with no remaining blockers.

## Deferred questions

- Skill packs and transferable profile export.
- Child subsets and independent shared-resource semantics.
- Snapshot garbage collection.
- Writable Settings and deeper provider-tree operations.

## Residual production gate

The automated TUI matrix covers recorded macOS and Linux direct-PTY/tmux/loopback-SSH behavior, resize, editor handoff, error recovery, Ctrl+C, restoration, cleanup, and Unicode/ANSI cell widths. Windows Terminal, representative remote SSH, terminal/font/locale ambiguous-width differences, and manual assistive-technology evidence remain open.
