# Stage 2: sanitized MTG source-tree proof

## Result

Stage 2 proves the requested **source-tree/runtime composition mechanics** for a realistic sanitized `mtg-deckbuilding` source unit. It is experiment code, not Bazframe product behavior. It does not prove a Bazframe managed command gateway, acquisition/update lifecycle, dependency manager, credential broker, or production nested membership.

One provider-prepared grouping root exposes exactly two independent Agent Skills:

- `card-search`
- `deck-analysis`

Both child-local TypeScript adapters import the same pure group-level card loader/search modules, read the same two exact approved references, consume synthetic immutable JSON inputs, and execute with the group-root locked `tsx`. Each command process starts in each of two unrelated immutable Git caller repositories, records that start, deliberately changes to the physical child root, resolves the prepared ancestor runtime, and emits canonical deterministic JSON. A Pi 0.82 probe separately proves the exact child definitions and original bases; it never requests the grouping root.

## Provider preparation and measurement

`fixture.mjs` is the sole preparer. Before the mutation-window manifests it:

1. copies only the authored sanitized template;
2. reads every source input with `git show 55ebbf4104cc0ca80e7e907b503ca4c803107785:<path>` from the prior MTG experiment Git object database;
3. verifies pinned SHA-256 values;
4. writes the two approved reference files byte-for-byte;
5. resolves the grouping root with the Stage 1 bounded resolver, before `node_modules` exists;
6. runs `npm ci --ignore-scripts --no-audit --no-fund` with its cache inside the isolated experiment home; and
7. installs the existing Stage 1 Pi projection extension and all isolated Pi state.

The mutation window then makes the provider and callers read-only. Measurement invokes the already-prepared `node_modules/tsx/dist/cli.mjs` directly through Node with offline/proxy-blocked environment flags. No install command runs during measurement. Complete before/after manifests and caller Git statuses must match.

The pre-install resolver ordering is intentional: Stage 1's approved experiment policy rejects all source-internal symlinks and bounds visited entries, while npm's prepared `node_modules` contains `.bin` links and a dependency tree. Stage 2 reuses the resolver to establish exact child records before provider dependency preparation, then uses those prepared records without rescanning the grouping root. This is experiment sequencing, not a proposed production policy.

## Sanitization and provenance

Generated `PROVENANCE.json` records all source/destination hashes and transformation notes. Exact copies:

| Source at pinned commit | Destination | SHA-256 |
|---|---|---|
| `mtg/knowledge/deckbuilding/card-evaluation-framework.md` | `shared/references/card-evaluation-framework.md` | `a9d5e35e9dad86a2ed3761ae8f4dba3673fd551a933f90a2b1aa950ed97bef0a` |
| `mtg/knowledge/deckbuilding/synergy-support-math.md` | `shared/references/synergy-support-math.md` | `1feb5d2749aab85225bfe58f6c86de624262ce9e1ce4f5144459383f5106ede7` |

The source `scripts/cards.ts` and deck-analysis materials are transformation inputs, not copied commands. The fixture extracts only explicit-input immutable card loading and deterministic pure search, and replaces API/exec/deck-folder behavior with synthetic input analysis. Root package metadata is reduced to exact `tsx@4.21.0`; the lock is mutually consistent and records the prepared dependency closure.

Excluded: credentials, real decks, caches, account state, logs, networked APIs, source `node_modules`, Forge, Moltbook, mutable data, and unrelated files.

## Reproduce

From the Bazframe repository root:

```bash
node --test experiments/provider-neutral-nested-source-unit-composition/stage2-mtg/run-stage2.test.mjs
node experiments/provider-neutral-nested-source-unit-composition/stage2-mtg/run-stage2.mjs
```

The direct runner emits evidence for provenance, provider preparation, direct/effective records, all four source-tree commands, both Pi projections, mutation manifests, and qualified claims.

## Rejected claims

- Bazframe-exclusive necessity: not demonstrated; a provider plus bounded experiment harness proves these mechanics.
- Bazframe acquisition/install/execute behavior: not implemented or exercised.
- Managed gateway, lifecycle lease, update, or mutable-data proof: not exercised.
- Credentials, authenticated operations, network APIs, Forge, Moltbook, and real user state: excluded.
- Runtime portability beyond Pi 0.82.x and the observed Node/npm platform: not claimed.
