# Stage 2 report: sanitized MTG source-unit composition

## Disposition

**PASSED for source-tree/runtime mechanics.** A provider-prepared sanitized `mtg-deckbuilding` source unit exposed `card-search` and `deck-analysis` as independent child skills. Both consumed intact shared pure code, exact approved references, synthetic immutable inputs, and a root-prepared locked `tsx` runtime from each of two unrelated Git caller repositories.

**Bazframe-exclusive necessity remains not demonstrated.** This is an experiment-local provider and harness. Bazframe did not acquire, install, or execute the source as product behavior. The result is not a managed command gateway, lifecycle, dependency-management, credential, or production nested-membership proof.

## Provenance and transformation

- Source Git commit: `55ebbf4104cc0ca80e7e907b503ca4c803107785`.
- Read method: only `git show <commit>:<path>`; the dirty source worktree is not read.
- Pinned input hashes are enforced in `fixture.mjs` for both original skills, the card and scorecard code, deck-analysis reference, package/lock, and both approved references.
- Exact reference copies retain SHA-256 `a9d5e35...bef0a` and `1feb5d27...ede7`.
- `scripts/cards.ts` became explicit-input immutable loading plus deterministic pure search. Cache migration, writes, account identifiers, prices, API fallback, and CLI state were removed.
- Scorecard/skill inputs became a child-local deterministic adapter over one synthetic deck. Archidekt, Scryfall, shell execution, project deck folders, and mutable state were removed.
- The root runtime was reduced to exact `tsx@4.21.0`; provider preparation ran the locked `npm ci --ignore-scripts` before measurement.

No credentials, real decks, caches, account state, logs, network API behavior, Forge, Moltbook, source dependencies, or unrelated files were copied.

## Proof

- Stage 1 bounded discovery ran before dependency preparation and returned exactly `card-search` then `deck-analysis`, with physical child bases.
- Provider preparation completed `npm ci --ignore-scripts --no-audit --no-fund` before baseline manifests and confirmed installed `tsx` 4.21.0.
- Four offline/no-install command measurements ran: both children from both caller repositories.
- Every helper began with the caller repository as CWD, deliberately changed to the child root, found `package.json`, `package-lock.json`, and `node_modules/.bin/tsx` at the group ancestor, and executed the prepared runtime.
- `card-search` deterministically returned only `Harmonize` for the fixed query.
- `deck-analysis` deterministically returned five known cards, zero missing cards, average CMC 2.8, sorted role counts, and shared-card search evidence.
- Both payloads included both exact shared-reference hashes. Payloads were byte-canonical JSON and equal across callers for the same child.
- Real Pi 0.82 loaded each exact child definition independently with zero positive-loader diagnostics and preserved both original bases from both caller CWDs. `groupingRootRequested` was false.
- Complete provider/caller manifests and both caller Git statuses matched before/after.

## Commands

Run sequentially from the Bazframe repository root:

1. `node --test experiments/provider-neutral-nested-source-unit-composition/resolver.test.mjs` — passed: 13 tests, 0 failed.
2. `node --test experiments/provider-neutral-nested-source-unit-composition/run-real-pi.test.mjs` — passed: 1 test, 0 failed, Pi 0.82.0.
3. `node --test experiments/provider-neutral-nested-source-unit-composition/stage2-mtg/run-stage2.test.mjs` — passed: 1 test, 0 failed; four child commands, two callers, exact references/runtime/projection, unchanged manifests.
4. `node experiments/provider-neutral-nested-source-unit-composition/stage2-mtg/run-stage2.mjs` — passed: two children, four canonical command payloads, two Pi runs, 136-entry provider manifest and two 11-entry caller manifests unchanged.
5. `npm test` — passed: build, typecheck, lint, 32 unit files / 238 tests, 5 integration files / 23 tests, and packed-package smoke.
6. `npm run test:real-pi` — passed on Pi 0.82.0; all reported production probes were true, including provider preservation and repository stability.
7. `npm pack --dry-run --json | <experiment-exclusion assertion>` — passed: 56 entries and zero `experiments/` entries.
8. `git diff --check` — passed with no output.
9. `git diff --cached --name-only` — passed with no output; no files are staged.

## Residual limits and rejected claims

- The direct child-root flow is explicitly source-tree development evidence. It bypasses any installed managed gateway or lifecycle safety.
- The Stage 1 resolver runs before provider dependency preparation because the approved Stage 1 bounds/link policy intentionally reject npm's prepared tree. No production sequencing policy follows from this.
- Offline evidence uses code without network calls plus npm/Pi offline flags and invalid local proxies; it is not an OS network sandbox proof.
- Coverage is Pi 0.82.x and the observed Node/npm platform only.
- Bazframe-exclusive necessity, acquisition, install, execution, updates, leases, mutable state, credentials, and cross-runtime behavior remain unproved and unimplemented.
