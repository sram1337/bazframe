# MTG deckbuilding source installation UX review

> Status: historical session evidence; the profile-local live-source model described below was superseded by global managed sources, immutable snapshots, and exact profile references
>
> Scope: installing the local `mtg-deckbuilding` npm package/source unit into the active Bazframe profile on SamPC/Windows on 2026-08-10
>
> Current product decisions remain authoritative in [`../design.md`](../design.md) and [`../tui-design.md`](../tui-design.md). Current-state assertions, candidate models, and open questions below record the pre-redesign product and are not current decisions or pending implementation requirements.

## Purpose

This note records how a real request to “install the local `mtg-deckbuilding` skill pack following the normal flow into the current Bazframe profile” unfolded. It separates observed behavior, analysis, and open product questions so the Mac reviewer can reproduce the friction and decide what Bazframe, its documentation, its TUI, or the source provider should change.

The user called the artifact a “skill pack.” Bazframe currently has no pack semantics. The artifact was ultimately composed as one profile-local source unit containing 13 derived Agent Skills.

## Environment and starting state

- Host: SamPC, Windows under Git Bash.
- Bazframe active profile: `foo-profile`.
- Bazframe policy and Pi adapter: enabled and healthy.
- Pi compatibility target observed: `0.82.0`.
- Existing active-profile flat skills included a Skillbook-backed `session-wrap`.
- The TUI implemented only its existing Skillbook source browser and flat direct-membership editor.
- Bazframe had no direct source-unit memberships when the flow began.

Relevant local paths eventually identified:

| Path | Identity observed during the session |
|---|---|
| `C:\Users\sram1\mtg-deckbuilding` | stale hyphenated checkout at `636a5df`; package declared exactly 2 skills |
| `C:\Users\sram1\mtg-deckbuilding-fresh-af03501a` | current hyphenated checkout at `7ece2e5`, matching `origin/main`; package declared exactly 13 skills |
| `C:\Users\sram1\mtg_deckbuilding` | separate underscore-named project; not the requested package |
| `C:\Users\sram1\AppData\Local\mtg-deckbuilding-provider` | durable local npm consumer created for the installed provider package |
| `C:\Users\sram1\AppData\Local\mtg-deckbuilding` | external prepared-data root created by the current 13-skill package |

The two hyphenated checkouts used the same npm package name and version, `mtg-deckbuilding@0.1.0`, despite materially different inventories.

## Session timeline: observed behavior

### 1. The requested “normal flow” crossed two ownership domains

The request sounded like one operation, but completion required two independent domains:

1. Provider lifecycle through npm: select a checkout, prepare it, test it, pack it, install it, and prepare its external data.
2. Bazframe profile composition: add a descriptor for the installed package's `source-unit/` root and project its derived skills.

Bazframe correctly did not acquire or mutate provider-owned package bytes. There was no single workflow or document that joined these domains for the user.

### 2. The first install selected the wrong hyphenated checkout

The first filesystem search found `C:\Users\sram1\mtg-deckbuilding`, an exact lexical match for the requested package name. That checkout was selected without first comparing its commit and declared skill inventory with every same-named local checkout.

Its README explicitly said it contained exactly two offline skills:

- `card-search`
- `deck-analysis`

The checkout passed its own typecheck and 22 tests. It was packed and clean-installed as `mtg-deckbuilding@0.1.0` into the durable local npm consumer. Bazframe then added:

```text
mtg-provider/mtg-deckbuilding
```

The source descriptor was healthy and Bazframe correctly derived exactly those two skills. From Bazframe's perspective, this was a valid installation.

### 3. The source was invisible in the TUI

The user opened the TUI and reported that the source did not appear.

CLI evidence showed the source was active:

```text
Direct source units: 1
Derived effective skills: 2
Source failures: (none)
```

The absence was not a stale refresh or failed installation. The current TUI exposes:

- one read-only Skillbook source in the Skills tab; and
- flat direct Skillbook memberships in the profile editor.

It does not expose profile-local source-unit descriptors, their derived children, or source failures. The user therefore had a healthy runtime configuration with no corresponding TUI representation.

### 4. The user expected 13 skills, not 2

When the user questioned the count, the first investigation also mentioned the underscore-named `mtg_deckbuilding` project. The user correctly rejected that conflation: `mtg-deckbuilding != mtg_deckbuilding`.

A broader search then found a second hyphenated checkout:

```text
C:\Users\sram1\mtg-deckbuilding-fresh-af03501a
```

That checkout matched current `origin/main` at `7ece2e5` and declared exactly 13 skills:

1. `archidekt`
2. `card-search`
3. `cda`
4. `deck-analysis`
5. `deck-building`
6. `deck-categorization`
7. `deck-import`
8. `edhrec`
9. `probability`
10. `rules`
11. `scryfall`
12. `session-wrap`
13. `showcard`

The wrong result came from selecting a stale same-named checkout, not from Bazframe dropping 11 valid children.

### 5. The current package was verified before replacement

The current checkout passed:

- typecheck;
- 329 passing tests, 1 platform skip, and no failures;
- clean installed-package verification with an exact 13-skill inventory; and
- isolated Bazframe composition verification deriving all 13 skills with no source failures.

The old profile source descriptor was then removed through the canonical Bazframe CLI:

```bash
bazframe profile sources remove mtg-provider mtg-deckbuilding
```

The old npm package was removed through npm, and the current packed package was installed into the same durable provider consumer. Its automatic prepared-data flow created one complete generation containing Scryfall Oracle Cards and the official Comprehensive Rules. Strict `setup:data`, `verify:data`, and `doctor` commands all passed afterward.

This preserved the ownership split: Bazframe removed only its descriptor; npm replaced provider package bytes; the package prepared data outside both the package and Bazframe profile.

### 6. A flat/derived duplicate blocked the intended complete source

The current 13-skill source declares `session-wrap`. The active profile already had a flat Skillbook-backed skill with the same name.

Under the approved resolver contract:

- flat and derived names must be unique across the profile;
- the flat skill wins;
- the derived conflict is reported; and
- a failure withholds the complete source unit atomically.

Therefore, adding the descriptor without resolving the collision would have produced one direct source unit, zero effective derived skills from that source, and a `duplicate-name` failure at `session-wrap/SKILL.md`. Bazframe does not partially expose the other 12 children. Child subsets are deferred.

The conflict was identified before re-adding the real descriptor. The user authorized replacing the existing flat `session-wrap` with the package's derived `session-wrap`.

### 7. The removal command grammar was difficult to discover

The user attempted two reasonable command forms.

First:

```bash
bazframe skill remove session-wrap
```

Result:

```text
error: skills accepts no arguments.

Usage:
  bazframe skill
  bazframe skills
```

Second:

```bash
bazframe profile skill remove session-wrap
```

Result:

```text
error: profile requires `skills`, `sources`, `add`, `duplicate`, `remove`, `rename`, `use`, `list`, or `current`.
```

The canonical command is plural:

```bash
bazframe profile skills remove session-wrap
```

That command succeeded. The source was then added with:

```bash
bazframe profile sources add mtg-provider mtg-deckbuilding \
  "C:\Users\sram1\AppData\Local\mtg-deckbuilding-provider\node_modules\mtg-deckbuilding\source-unit"
```

The repository README, product design, generated CLI help, and embedded Bazframe skill all document the plural canonical form correctly. The friction came from command grammar and error guidance, not a factually incorrect command in those documents:

- top-level `skill` is accepted as a singular alias for browsing;
- `skill remove` is not accepted;
- nested `profile skill` is not an alias for `profile skills`; and
- neither error suggested the likely canonical removal command.

### 8. Root help and skill overviews hid source-unit/provider composition

After the healthy 13-skill install, the user tried the ordinary discovery surfaces:

```bash
bazframe skills
bazframe profile skills
bazframe
```

`bazframe skills` displayed only the resolved Skillbook library and its directly addable artifacts. `bazframe profile skills` displayed only the five remaining flat memberships. Neither output mentioned the direct MTG source unit, its 13 derived skills, or the command used to inspect them.

Bare `bazframe` advertised these resources:

```text
profiles, skills, projects, global, adapters, status, tui
```

It did not advertise `sources` or `providers`, and its suggestions contained no source-unit path. Follow-up help behaved as follows:

```text
bazframe help sources    -> Unknown help topic: sources
bazframe help providers  -> Unknown help topic: providers
bazframe help profiles   -> includes `bazframe profile sources ...`
```

The feature is therefore discoverable only after the user already knows to treat source units as a nested profile concern. The recorded design deliberately has no global provider registry, so this evidence does not by itself require a top-level `providers` resource. It does show that the implemented source-unit capability is absent from the root information architecture and both obvious skill overviews.

### 9. Healthy installed state

The completed status was healthy:

```text
Active profile: foo-profile
Flat direct skills: 5
Direct source units: 1
Derived effective skills: 13
Source failures: (none)
Corrective actions: (none)
```

The derived inventory contains all 13 expected skills. The package's `session-wrap` now occupies the name previously held by the flat Skillbook membership.

A Pi `/bazframe reload` or a new Pi process is still required for an already-running runtime session to consume the changed profile resources.

### 10. Provider-only removal exposed the current tuple identity

The user then tried:

```bash
bazframe profile sources remove mtg-provider
```

Bazframe rejected it because the persisted membership identity is the pair `providerId/sourceId`:

```text
error: profile sources remove requires <provider> <source> followed only by optional --profile <profile>.
```

The canonical current command requires both values:

```bash
bazframe profile sources remove mtg-provider mtg-deckbuilding
```

This is consistent with the descriptor schema, where one provider namespace may contain multiple source IDs. It did not match the user's mental model: `mtg-provider` looked like a first-class object whose selected source inventory should be inspectable or removable as one thing. The user expressed a preference for working with these objects under the user-facing name “sources,” while keeping “provider” as a possible implementation or ownership concept.

## Analysis

### A. “Install this skill pack” has no visible end-to-end model

The user expressed one goal. The implementation required npm package lifecycle, external data lifecycle, Bazframe source membership, profile conflict resolution, and runtime reload. Each individual ownership boundary behaved as designed, but the joined experience was agent-dependent.

The term “skill pack” also conflicts with Bazframe's current vocabulary. Bazframe deliberately defers pack semantics, while a grouping source unit can still look exactly like a pack to a user because it yields many skills at once.

### B. A healthy source can be operationally invisible

The TUI is currently unable to confirm the existence, health, inventory, or failures of source-unit membership. This creates two conflicting truths:

- CLI/status/runtime: the source is installed and effective.
- TUI: the source appears not to exist.

The gap is especially confusing because the Skills tab describes itself as a source browser and the profile editor describes included skills, but both omit this second implemented membership kind.

### C. Lexical path selection was insufficient provider identification

Two same-named hyphenated checkouts existed. The obvious path was stale, and both old and current package contents reported version `0.1.0`. The initial flow confirmed only that the selected package was internally valid, not that it was the package revision or inventory the user intended.

This is principally provider/user provenance, not Bazframe ownership. However, a normal composition workflow needs to surface enough inventory and provenance for the user to confirm the selected physical root before it becomes profile state.

### D. Atomic failure is safe but has a surprising blast radius

The atomic source boundary prevents a silently partial composition and preserves coupled source semantics. That is a valid safety property. The user-facing surprise is that one duplicate child means 0 of 13 children become effective.

The current model needs unusually clear preflight and diagnostics. A user should not have to infer that a single `session-wrap` conflict disables `archidekt`, `rules`, `scryfall`, and every unrelated sibling.

### E. Singular/plural aliases create a false grammar

Accepting `bazframe skill` for browsing teaches that `skill` is a valid resource namespace. Rejecting `bazframe skill remove` and `bazframe profile skill remove` makes that learned grammar unreliable.

The canonical docs are technically correct, but correctness alone did not make the operation discoverable. Both errors had enough argv context to suggest `bazframe profile skills remove session-wrap` and did not do so.

### F. Conflict resolution changes semantics, not just membership shape

Removing flat `session-wrap` and accepting derived `session-wrap` preserved the command name but changed the underlying instructions and provenance. The flow needed to say “the MTG version will replace the existing flat version,” not merely “remove a duplicate.” Similar collisions may deserve a side-by-side origin display before authorization.

### G. Provider preparation succeeded but was easy to miss

The current package's npm install automatically prepared live external data, but npm did not present a prominent lifecycle result in the captured install output. Only later inspection and strict provider commands proved that data existed and was valid.

This is primarily `mtg-deckbuilding` provider UX. Bazframe should not take over preparation, network access, or data ownership. The joined installation guide should nevertheless make provider readiness an explicit prerequisite and evidence point.

### H. Source units are missing from the root information architecture

The ordinary progression `bazframe` → `bazframe skills` → `bazframe profile skills` never reveals the active source unit. The only obvious general command that reports it is `bazframe status`; the dedicated command requires prior knowledge of `bazframe profile sources`.

The user's word “providers” is understandable because descriptors require a `providerId`, help says provider roots are provider-owned, and the TUI calls Skillbook a source. Bazframe nevertheless has no provider registry or provider lifecycle resource. The UX needs a discoverability and terminology decision that exposes existing profile-local source composition without falsely promising global provider management.

### I. “Source” currently names two different layers

The TUI's `SkillSource` means a top-level library/root that contains available skill artifacts. Today that projection is zero or one Skillbook root. By contrast, CLI `profile sources` means profile-local source-unit descriptors. Each descriptor itself contains a `providerId`, a `sourceId`, and a `sourceRoot`, then derives effective skills.

The likely product-history explanation is that the TUI source browser and the later profile-local source-unit seam were designed as separate slices. Both selected “source” as a reasonable local term, but the combined product now has overlapping nouns:

| Current term | Current meaning | Example |
|---|---|---|
| skill | one Agent Skills-compatible capability | `rules` |
| Skillbook source / TUI skill source | a root containing artifacts available for individual flat membership | `C:\Users\sram1\.skillbook\skills` |
| provider | external lifecycle owner or descriptor namespace; not a configured Bazframe object | `mtg-provider` or Skillbook |
| source unit | one provider-owned physical root selected as an atomic profile membership | `mtg-deckbuilding` |
| derived/effective skill | a child discovered from a selected source unit | `mtg-deckbuilding:rules` |

This explains the implementation, but it is not a coherent user-facing object model. In particular, `bazframe skills` means available Skillbook artifacts, `bazframe profile skills` means only flat direct memberships, and `bazframe profile sources` is the only place that shows the 13 effective MTG skills.

## Candidate coherent naming model for Mac review

This is analysis based on the user's stated preference, not an approved design.

### Source

A **source** would be the first-class configured object users inspect and select. It identifies one concrete external root and its skill inventory. Examples:

- `skillbook` → `C:\Users\sram1\.skillbook\skills`
- `mtg-deckbuilding` → the installed package's `source-unit/`

A source may expose one or many skills and declares whether profiles may select individual skills, the complete source, or both. A globally unique source ID removes the need for users to repeat an opaque provider namespace during ordinary profile operations.

### Provider

A **provider** would be source metadata describing who owns lifecycle and how the source arrived, such as Skillbook, npm, Git, or a local filesystem workflow. It is not necessarily a separately configured user object and does not grant Bazframe permission to install, update, prepare, or delete provider bytes.

This keeps the important ownership boundary without making `providerId` the primary command identity.

### Skill

A **skill** remains one Agent Skills-compatible capability exposed by a source. Its origin is always displayable as `source/skill`, even when its runtime command name remains the unqualified Agent Skill name.

### Profile membership

A profile may select:

- an individual skill from a source that supports direct selection; or
- a complete source as one atomic membership.

The effective profile is the resolved skill set after validation and collisions. “Direct,” “derived,” and “effective” remain useful diagnostic adjectives, not competing top-level object nouns.

### Candidate command shape

A consistent resource shape could be reviewed along these lines:

```text
bazframe sources
bazframe source show <source>
bazframe profile sources add <source>
bazframe profile sources remove <source>
bazframe profile skills add <source>/<skill>
bazframe profile skills remove <source>/<skill>
```

Exact commands are undecided. A first-class source model would reopen the currently deferred registry, persistence, ordering, migration, and lifecycle-capability questions. It should not be implemented merely as aliases over the existing tuple without settling those semantics.

## Product decisions in force when this evidence was recorded

The following were recorded decisions at the time. The global-source redesign later superseded the profile-local/live-source and TUI projection statements; see the current design documents linked above:

- Bazframe does not acquire, update, publish, prepare, or delete provider source artifacts.
- Skill packs, child subsets, and a global source registry are deferred.
- Source-unit membership is profile-local and uses descriptors separate from flat Skillbook membership.
- Source-unit derivation is live and read-only.
- A source-unit failure withholds the complete unit atomically.
- Flat/derived duplicate names preserve the flat skill and withhold the affected source unit.
- Source-unit mutation currently has CLI actions but no TUI action.
- The implemented TUI Skills browser currently projects zero or one Skillbook source, not arbitrary provider roots.

## Historical questions for Mac review

These were open questions before the global-source redesign, not current recommendations or pending approvals.

### 1. Read-only source-unit visibility

Should the selected profile editor display, without mutation controls:

- direct source-unit identities and physical roots;
- derived skill names and origin paths;
- source failures; and
- an explicit effective count such as `13 of 13` or `0 of 13`?

The narrow option is profile-local read-only display. Treating source-unit roots as general Skills-tab sources is broader and intersects the deferred additional-source model.

### 2. CLI grammar and suggestions

Should Bazframe:

- support singular aliases for `skill add/remove` and `profile skill add/remove`;
- keep only the plural canonical grammar but add intent-aware suggestions;
- emphasize the existing top-level compatibility alias `bazframe remove <skill>`; or
- make another explicit consistency decision?

At minimum, review whether the two observed errors should have printed the exact likely command with the supplied skill ID.

### 3. Source-add preflight

Should source membership gain a read-only preflight that resolves the target profile before mutation and reports:

- candidate child count and names;
- duplicate names and their existing origins;
- whether the complete source would be withheld;
- the exact descriptor that would be created; and
- provider bytes that Bazframe will not change?

If mutation remains one-step, should successful descriptor creation exit nonzero or display a prominent warning when immediate resolution yields zero effective children due to a source failure?

### 4. Joined provider-to-profile documentation

Where should a normal external-provider recipe live, given that Bazframe must not own provider lifecycle? A useful recipe may need explicit phases:

1. provider selects and prepares an installed physical source root;
2. user confirms package identity and inventory;
3. Bazframe preflights profile conflicts;
4. Bazframe adds the descriptor;
5. user verifies CLI/TUI/runtime state; and
6. the running adapter is reloaded.

The recipe should not imply that Bazframe ran npm, prepared data, or established provider licensing compliance.

### 5. Provenance and live-root reporting

Should Bazframe remain limited to physical root identity and derived inventory, or may a provider-neutral optional projection expose provider-supplied version/provenance? The old and current packages shared version `0.1.0`, so a version field alone would not have prevented this incident.

### 6. Collision replacement UX

When a flat skill and a derived skill share a name, should diagnostics show both physical origins and explain the atomic consequence before offering the canonical removal command? The UI must not imply that two same-named skills are semantically interchangeable.

### 7. Root help discoverability and terminology

How should a user discover the already-implemented profile-local source feature from bare `bazframe` without introducing the deferred global registry? Options to review include:

- mentioning profile sources under the root `profiles` resource description or suggestions;
- accepting `bazframe help sources` as a documentation alias that points to `profile sources`;
- making `bazframe skills` and `bazframe profile skills` explicitly state that source-derived skills are excluded and point to `bazframe profile sources`; or
- approving a broader resource model separately.

The review should also decide when to say “source,” “source unit,” and “provider.” A `providerId` in a profile-local descriptor must not imply that Bazframe owns a global provider object or lifecycle.

### 8. First-class source objects

The user's emerging preference is to work with top-level objects called **sources**, with provider/lifecycle ownership represented as metadata. Mac review should decide whether to reopen the deferred global source registry and, if so:

- whether source IDs are globally unique;
- whether Skillbook becomes one source object alongside package roots;
- whether a source declares individual-skill versus whole-source selection capabilities;
- how existing profile-local `providerId/sourceId` descriptors migrate;
- how ordering, broken roots, and source removal behave while profiles reference a source; and
- how Bazframe preserves provider-owned lifecycle without turning `source remove` into provider artifact deletion.

## Candidate acceptance scenarios for any approved changes

These scenarios describe the observed gaps without selecting an implementation.

1. A profile with flat `session-wrap` evaluates the 13-skill MTG source. Before or immediately at add, the user sees that one conflict means the complete source contributes zero skills and sees both origins.
2. Entering either observed singular command produces an exact useful suggestion while preserving the canonical grammar decision.
3. After a healthy source is added, the TUI can represent its direct membership, all derived skills, and no failures without claiming provider mutation authority.
4. After a failed source is added, the TUI and CLI agree on direct membership, zero effective children, and the same failure.
5. A normal-flow guide keeps npm/data preparation provider-owned while making the handoff to Bazframe explicit.
6. A user selecting among multiple local roots sees inventory/provenance evidence before confirming the descriptor.
7. Replacing a live provider at the same canonical source root updates derived inventory after refresh/reload without Bazframe claiming an update lifecycle.
8. Starting from bare `bazframe`, a user can discover how to inspect profile-local source units without already knowing the nested command.
9. `bazframe skills` and `bazframe profile skills` accurately explain their exclusions and point to the source-derived inventory.
10. If first-class sources are approved, `bazframe sources` shows both Skillbook and MTG roots with distinct lifecycle ownership and selection capabilities.
11. A profile can remove the globally identified `mtg-deckbuilding` source membership without restating an otherwise opaque provider namespace, while provider bytes and prepared data remain untouched.

## Operator and ecosystem note

One initial packaging attempt used `npm --prefix <repo> pack` from the Bazframe checkout. In this environment, `npm pack` acted on the current working directory rather than the assumed prefix and attempted to pack Bazframe. Cleanup prevented that artifact from becoming the provider install, and the command was corrected by changing the process working directory before `npm pack`.

This is npm/operator friction rather than Bazframe product behavior, but it reinforces why an end-to-end recipe should use commands whose working-directory assumptions are explicit.

## Historical handoff state

At the end of the recorded SamPC session, the installation was complete and healthy under the then-current profile-local model, and this review document itself made no implementation changes. The later Mac review and product work superseded that handoff by approving and implementing global managed sources, immutable snapshot activation, exact profile references, and read-only TUI projections. Current product behavior is defined by `docs/design.md` and `docs/tui-design.md`.
