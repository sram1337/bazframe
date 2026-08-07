# Provider-neutral nested source-unit composition

## Outcome

**Composition mechanics passed in Stage 1 and the reopened Stage 2 MTG proof. Bazframe-exclusive necessity was not demonstrated.** The experiment-local provider plus bounded resolver/Pi extension met the structural record, original-base projection, diagnostic, and mutation requirements without exposing a missing Bazframe profile invariant. That bounded-wrapper evidence limits the product claim; it does not prohibit continued provider-neutral experiment work.

Stage 1 proves the bounded alpha/beta structure and Pi 0.82 projection. [`stage2-mtg/`](stage2-mtg/) proves more realistic provider-prepared MTG source-tree/runtime mechanics with shared pure code, exact references, synthetic inputs, locked `tsx`, and two unrelated callers. Neither stage changes or justifies production Bazframe ownership.

This directory is research code, is excluded from the npm package, and does not change immediate-only production profile or adapter behavior.

## Fixture ownership and mutation window

`fixture.mjs` is the sole fixture preparer. Each run creates an experiment-local temporary workspace:

```text
.work/structural-*/
  provider/                       # immutable Git repository, including .git
    fixture-source/
      alpha/SKILL.md
      beta/SKILL.md
      shared/reference.md
      ordinary.txt
  bazframe-home/                  # the only writable root during measurement
    memberships/fixture-source
    pi-agent/extensions/
    captures/
    home/ xdg/ tmp/
  destinations/
    session-a/                    # immutable, unrelated Git repository
    session-b/                    # immutable, unrelated Git repository
```

Preparation, Git initialization, extension installation, and HOME/XDG/temp directory creation finish before baseline capture. The workspace, provider repository, destinations parent, and both destination repositories then have all write bits removed; `assertOnlyBazframeHomeWritable` walks the enclosing workspace and rejects any other writable entry. Complete before/after manifests cover the provider and destination repositories, including `.git`. Destination Git status is also compared exactly. On a mismatch, the runner reports the first differing manifest record.

The manifest records path, filesystem type, byte size, and SHA-256. Regular files hash their bytes. Symbolic links hash the exact link-target bytes using buffer-encoded `readlink` without following the link.

## Structural contract

- Resolve the direct membership link once and traverse its canonical target read-only.
- Root depth is 0. Depth 8, 256 visited descendants, and 64 skills are accepted; the next directory, entry, or skill fails.
- Every `readdir` result counts. Traversal and failure precedence are lexical relative-path depth-first order.
- Definitive `lstat` metadata, not `Dirent` type hints, determines root standalone detection and traversal entry types.
- Reject all internal symbolic links, unsupported entry types, mixed standalone/grouping roots, invalid definitions or name/directory identity, and duplicate declared names.
- A grouping root may yield zero skills. A valid standalone root yields itself and may contain ordinary resources, but no descendant definition.
- Return effective records in relative definition-path order with original absolute `skillRoot` and `definitionPath` values.
- Normalize only approved structural failures. Unexpected I/O and concurrent filesystem races remain experiment limitations rather than product guarantees.

Structural validation covers UTF-8 frontmatter, one Agent Skills-compatible `name`, and name/directory identity. Pi-specific metadata compatibility remains a separate runtime gate.

## Real-Pi 0.82 projection probe

`run-real-pi.mjs` refuses versions outside Pi 0.82.x. It discovers the membership structurally, writes only experiment configuration/captures beneath the isolated home, and invokes real Pi from the two unrelated destination Git worktrees.

The experiment-local extension:

1. calls Pi's `loadSkillsFromDir` separately for each already-discovered child root;
2. requires exactly one skill and zero diagnostics for each child;
3. captures exact `filePath`, `baseDir`, and `name`;
4. returns only the individual `alpha/SKILL.md` and `beta/SKILL.md` paths from `resources_discover`; and
5. never asks Pi to scan the grouping root.

The runner proves that both captured child bases canonically resolve `../shared/reference.md` to the same file inside `sourceRoot` and reads the expected provider-owned content. Its zero-loader-diagnostics claim is explicitly limited to this positive projection. A second structurally valid fixture omits Pi-required `description` metadata from one child. Pi intentionally reports a loader diagnostic, the extension returns no `skillPaths`, and neither definition appears in the provider prompt.

`PI_CODING_AGENT_DIR`, `BAZFRAME_HOME`, `HOME`, all XDG roots, `TMPDIR`, npm cache, settings, captures, and session-capable state are directed beneath the one isolated allowed root. Pi runs offline with `--no-session`.

## Reproduce

From the repository root:

```bash
node --test experiments/provider-neutral-nested-source-unit-composition/resolver.test.mjs
node --test experiments/provider-neutral-nested-source-unit-composition/run-real-pi.test.mjs
node experiments/provider-neutral-nested-source-unit-composition/run-real-pi.mjs
npm test
npm run test:real-pi
npm pack --dry-run --json
git diff --check
git status --short
```

The real-Pi runner emits JSON evidence containing the Pi version, a mechanics-only result/scope, exact direct/effective records, both working directories, loader results and diagnostics, returned paths, shared-reference targets/content, manifest entry counts, destination status, invalid-metadata result, and qualified boolean claims. Its mechanics result is not the overall research disposition.

Unsupported special filesystem entries are conservatively rejected by the resolver, but direct fixture coverage is retained as a portability limitation: creating a FIFO/socket/device is not safely portable across the supported Node platforms. Concurrent filesystem races, unexpected I/O behavior, privileged bypass of permission bits, and runtimes other than Pi 0.82.x also remain outside the evidence.

## Exclusions

No code here implements production persistence, source registration or lifecycle, Bazframe dependency installation/execution, execution supervision, mutable provider data, credentials, subset manifests, packs, or registries. Stage 2's provider-owned preparation and source-tree command runner are experiment fixtures, not product behavior. The passed mechanics are bounded Pi 0.82 evidence, not a product decision or cross-runtime claim; Bazframe-exclusive necessity was not demonstrated.
