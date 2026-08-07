# Stage 1 report: provider-neutral nested source-unit composition

## Disposition

**Stage 1 composition mechanics: PASSED. Bazframe-exclusive necessity: NOT DEMONSTRATED.**

The structural resolver and Pi 0.82 composition mechanics passed. An externally prepared experiment fixture plus an experiment-local bounded resolver and Pi extension produced the required direct/effective records, original-base projection, deterministic diagnostics, and provider/destination no-mutation guarantees. It did so without using a production Bazframe profile or demonstrating a missing Bazframe profile invariant. This is the preserved bounded-wrapper evidence: it defeats a Bazframe-exclusive product claim, not the composition mechanics or continued provider-neutral experimentation.

The evidence does not justify Bazframe ownership or production integration. Production semantics and `docs/design.md` remain unchanged. Stage 2 was subsequently reopened and completed as the separately bounded sanitized MTG source-tree proof in `stage2-mtg/`.

## Baseline and scope

- Baseline HEAD: `7c43af59238109479291fcc5ef04c0f19f8e6651`.
- Node: `v24.14.1`.
- Pi: `0.82.0`.
- `todo.txt` was pre-existing untracked state and was left untouched. No historical content-hash comparison was captured or claimed.
- No production source, `artifacts/pi/bazframe.ts`, package manifest, production test/schema/CLI/TUI/status behavior, or `docs/design.md` was changed.
- Experiment runtime code remains under `experiments/provider-neutral-nested-source-unit-composition/`.

## Structural mechanics evidence

One experiment-only membership symlink resolved once to its canonical provider-owned source root. Resolution returned two effective records in lexical order:

| Qualified ID | Definition | Original base |
|---|---|---|
| `fixture-provider/fixture-source/alpha` | `<sourceRoot>/alpha/SKILL.md` | `<sourceRoot>/alpha` |
| `fixture-provider/fixture-source/beta` | `<sourceRoot>/beta/SKILL.md` | `<sourceRoot>/beta` |

The ordinary sibling and `shared/` resource directory were not exposed. Both child bases resolved `../shared/reference.md` to the same canonical `<sourceRoot>/shared/reference.md` containing `provider-owned shared reference`.

The 13 structural tests passed. They cover:

- exact positive records and immutable inputs;
- zero-skill grouping roots and a terminal standalone root;
- accepted depth 8 / rejected depth 9;
- accepted 256 / rejected 257 visited entries;
- accepted 64 / rejected 65 effective skills;
- `broken-root`, `internal-symlink`, `mixed-root`, `invalid-definition`, and `duplicate-name` diagnostics;
- entry-limit precedence before symlink rejection; and
- lexical depth-first multiple-failure precedence.

Unsupported special filesystem entries are conservatively rejected as `invalid-definition`, but no safely portable direct fixture was added. Creating FIFO/socket/device entries is not portable across the supported Node platforms; this remains an explicit coverage limitation rather than adding platform-specific scaffolding.

## Pi 0.82 runtime mechanics evidence

The direct runner emitted:

- `mechanicsResult: "passed"` and `mechanicsScope: "pi-0.82-runtime-projection"` (not an overall research result);
- two real-Pi runs from unrelated destination Git worktrees;
- only the individual `alpha/SKILL.md` and `beta/SKILL.md` paths through `resources_discover`;
- exactly one loaded skill per child with its expected `filePath`, `baseDir`, and declared name;
- zero loader diagnostics for the **positive projection only**;
- `groupingRootRequested: false` in both runs;
- the same canonical shared-reference target and expected content from both original bases; and
- `probe-ok` from both provider invocations.

A separately structurally valid negative fixture omitted Pi-required `description` metadata from `beta`. Pi 0.82.0 intentionally reported `description is required`; the extension marked the set incompatible, returned no `skillPaths`, and neither definition path appeared in the prompt. This diagnostic is why the evidence claim is qualified as `positiveProjectionNoLoaderDiagnostics`, not a global no-diagnostics claim.

## Mutation manifests and Git status

Complete non-following manifests recorded every root and descendant path, filesystem type, byte size, and SHA-256 for regular-file bytes or exact symlink-target bytes. Positive-run after-manifest counts were:

- provider repository, including `.git`: 18 entries;
- destination session A, including `.git`: 11 entries;
- destination session B, including `.git`: 11 entries.

Every before/after manifest comparison returned no difference. Both destination Git statuses also matched their baselines exactly. Their stable fixture status was `?? README.md` because each prepared repository deliberately contained an untracked README before the mutation window; the claim is unchanged status, not a clean fixture repository. The harness also verified that all non-link entries outside the isolated Bazframe home lacked write bits. Pi HOME, agent/config/cache/session-capable state, XDG roots, npm cache, and temp state were directed beneath that isolated home.

## Negative-fixture disposition

| Case | Result |
|---|---|
| Duplicate declared name | `duplicate-name` at the second lexical definition |
| Missing/invalid structural metadata | `invalid-definition` at the definition |
| Missing membership target | `broken-root` at `.` |
| Depth/entry/skill over bound | `limit-exceeded` naming `depth`, `entries`, or `skills` |
| Source-internal symlink | `internal-symlink` at the encountered entry |
| Root plus descendant definition | `mixed-root` at the descendant definition |
| Pi-invalid required metadata | intentional Pi diagnostic; no projected skill paths |
| Unsupported special entry | implemented conservative rejection; direct portable fixture unavailable |

## Review dispositions

### Review Gate A

- Fixed the writable sibling escape by making the provider repository, destinations parent, destination repositories, and workspace read-only outside the isolated home, then directly asserting the allowed writable root.
- Fixed standalone detection to use definitive `lstat` metadata rather than `Dirent` hints.
- Fixed manifests to hash exact buffer-encoded symlink-target bytes.
- Added entry-limit-before-symlink precedence coverage.
- Retained unsupported-special-entry direct coverage as the explicit portability limitation above.

### Review Gate B

- Replaced contradictory `noLoaderDiagnostics` evidence with `positiveProjectionNoLoaderDiagnostics`.
- Replaced the ambiguous real-Pi `result` field with mechanics-only `mechanicsResult` and `mechanicsScope` fields.
- Recorded that the bounded-wrapper criterion left Bazframe-exclusive necessity unproved, while preserving the passed mechanics evidence and not treating that product limit as a prohibition on later experiment stages.
- Reran `npm test` cleanly and sequentially. The earlier concurrent `dist/` deletion failure was not reproduced and is not recorded as a repository regression.
- Root `plan.md`/`progress.md` absence is not a repository blocker: those files were not repository requirements. Progress for this completion run was maintained only at the requested external artifact path.

## Commands and exact results

Run sequentially from the repository root:

1. `node --test experiments/provider-neutral-nested-source-unit-composition/resolver.test.mjs`
   Passed: 13 tests, 0 failed.
2. `node --test experiments/provider-neutral-nested-source-unit-composition/run-real-pi.test.mjs`
   Passed: 1 test, 0 failed, Pi 0.82.0.
3. `node experiments/provider-neutral-nested-source-unit-composition/run-real-pi.mjs`
   Passed mechanics: Pi 0.82.0, two exact effective definitions/bases, positive diagnostics empty, intentional invalid-metadata diagnostic present, no immutable-input or Git-status change.
4. `npm test`
   Passed cleanly: build, typecheck, lint, 32 unit-test files / 238 tests, 5 integration-test files / 23 tests, and package smoke.
5. `npm run test:real-pi`
   Passed unchanged production gate on Pi 0.82.0; packed CLI, adapter lifecycle, policy/context modes, profile/skill lifecycle, provider preservation, and repository stability were all `true`.
6. `npm pack --dry-run --json`
   Passed: 56 package entries. No experiment runtime path appeared; the research note appears only through the existing `docs/` package inclusion.
7. `npm pack --dry-run --json | node --input-type=module -e '<package-exclusion assertion>'`
   Passed: `{"entryCount":56,"experimentEntries":[]}`.
8. `git diff --check`
   Passed with no output.

No repository link-check command or installed `markdown-link-check`/`lychee` executable was available. Final Git status/staged checks are recorded in the completion evidence.

## Package exclusion

The package dry-run contained zero `experiments/` entries, so `fixture.mjs`, `resolver.mjs`, tests, runner, and extension are excluded from the package payload. `docs/research/provider-neutral-nested-source-unit-composition.md` is included only because `package.json` already packages `docs/`; no package configuration was changed.

## Residual risks and limits

- Runtime evidence applies only to Pi 0.82.x (observed 0.82.0), not other Pi versions or runtimes.
- Unexpected filesystem I/O errors and concurrent filesystem races are not normalized into product guarantees.
- Permission-bit isolation can be bypassed by privileged processes; byte manifests and Git-status comparisons remain the mutation evidence for measured roots.
- Unsupported special-entry rejection lacks a directly portable fixture test.
- The experiment does not establish a provider registry, persistence schema, cross-machine identity, source lifecycle, subset/pack semantics, dependency management, mutable-data handling, credentials, or a missing Bazframe profile invariant.

These limits do not change the Stage 1 disposition: composition mechanics passed and Bazframe-exclusive necessity was not demonstrated. Stage 2 was later reopened under its own experiment-only contract; it does not alter this Stage 1 product limit.

## Stage 2 continuation

The reopened sanitized MTG proof is implemented and reported under [`stage2-mtg/`](stage2-mtg/). It passed source-tree/runtime mechanics for two independently discoverable MTG children from two unrelated immutable Git callers, with shared pure modules, exact approved references, synthetic immutable inputs, provider-prepared locked `tsx`, offline/no-install measurement, exact Pi 0.82 definitions/original bases, and unchanged provider/caller manifests.

This continuation preserves the Stage 1 bounded-wrapper finding: Bazframe-exclusive necessity was not demonstrated. It rejects, rather than implies, product claims about acquisition, dependency installation, execution gateways, lifecycle, mutable data, credentials, or production nested membership. See [`stage2-mtg/REPORT.md`](stage2-mtg/REPORT.md) for provenance, transformations, commands, evidence, and residual limits.
