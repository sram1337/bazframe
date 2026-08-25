# Using Skills with Bazframe

Bazframe consumes standard [Agent Skills](https://agentskills.io/) directories. It adds lifecycle and profile composition; it does not define another Skill format. The buildable collection is a **Skill package**, and every discovered child remains a **Skill** whether it is live, in a library, or produced by a package.

## The three layouts

### 1. Single Skill

```text
explain-code/                    ← Skill root
├── SKILL.md                     ← Skill definition
├── scripts/                     ← Skill-owned scripts
└── references/                  ← Skill-owned references
```

Add a live Skill individually:

```bash
bazframe add skill /absolute/path/to/explain-code
bazframe profile skills add explain-code
```

Absolute-path providers own their live bytes. Managed Git Skills use a stable Bazframe provider path so `(default)` and profile links remain parallel across explicit updates.

### 2. Skill library

A library is already prepared and has no build step:

```text
my-library/                      ← library root
│                               ← artifact root
│                               ← Skills root
├── explain-code/                ← Skill root
│   └── SKILL.md
└── review-code/                 ← Skill root
    └── SKILL.md
```

The library ID is its canonical root basename and must be 1–64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen, such as `my-library`.

```bash
bazframe libraries add /absolute/path/to/my-library  # initial snapshot and activation
bazframe profile libraries add my-library            # attach the whole library

# After changing the prepared provider tree:
bazframe libraries update my-library                 # activate a new snapshot
```

Library add/update never executes provider code. Bazframe snapshots the complete prepared tree. Provider changes remain invisible until explicit `libraries update`; an existing Pi session then needs `/bazframe reload`.

### 3. Skill package

A package is a provider-owned buildable project. Its package ID is the canonical package-root basename and must be 1–64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen, such as `my-package`.

```text
my-package/                      ← package root; build cwd
├── bazframe-package.json        ← package declaration
├── package.json
├── src/                         ← provider source code
└── dist/                        ← artifact root
    ├── shared/                  ← shared artifact resources
    └── skills/                  ← Skills root
        ├── explain-code/        ← Skill root
        │   └── SKILL.md
        └── review-code/         ← Skill root
            └── SKILL.md
```

Exact `bazframe-package.json`:

```json
{
  "schemaVersion": 1,
  "build": ["npm", "run", "build"],
  "artifactRoot": "dist",
  "skillsRoot": "skills"
}
```

The declared build must leave `artifactRoot` as the artifact tree. Each standard Agent Skill directory belongs below `artifactRoot/skillsRoot`; other artifact content, such as shared resources, may live elsewhere under `artifactRoot`.

```bash
bazframe packages add /absolute/path/to/my-package  # initial build and activation
bazframe profile packages add my-package            # attach the whole package

# After changing package source:
bazframe packages build my-package                  # build and activate a new snapshot
```

Both `packages add` and `packages build` execute the literal build argv directly, without a shell or sandbox, using the package root as cwd and inherited environment/stdio. Bazframe validates the output and snapshots the complete artifact root, preserving `shared/`, but discovers Skills only below `skillsRoot`. A failed initial add creates no package record; a failed later build leaves the previously activated snapshot in use. An existing Pi session needs `/bazframe reload` after activation.

For a runnable repository example that creates a package, builds one Skill plus a shared resource, and attaches the package to a profile, see [`scripts/setup-library-package-demo.sh`](../scripts/setup-library-package-demo.sh).

## Managed Git providers

Resource-specific add commands accept `git:<owner>/<repository>`, credential-free HTTPS, and `ssh://` URLs:

```bash
bazframe add skill git:owner/root-skill
bazframe libraries add https://github.com/owner/skill-library.git
bazframe packages add git:owner/skill-package
```

GitHub shorthand uses an authenticated GitHub CLI clone when available and Git HTTPS otherwise. Explicit URLs use Git. Authentication remains in the user's Git credential helper, SSH agent, or GitHub CLI; Bazframe records only the normalized remote, fetch URL, default branch, full revision, resource identity, and canonical managed root.

The checkout lives under `<BAZFRAME_HOME>/providers/git/checkouts/<kind>/<id>`. Initial acquisition validates and activates the selected resource while leaving profile membership unchanged. A package clone is inspected before its literal build argv runs with ordinary user authority and no sandbox. Interactive confirmation defaults to decline; scripts use `--yes`.

```bash
bazframe skill update <skill> [--accept-rewrite]
bazframe libraries update <library> [--accept-rewrite]
bazframe packages update <package> [--accept-rewrite] [--yes]
```

Update acquires the recorded default branch into owned staging, verifies remote identity and a clean checkout, and activates a fast-forward revision transactionally. `--accept-rewrite` authorizes a reviewed non-fast-forward branch change. `packages build` rebuilds the recorded managed revision without network access and restores a clean checkout after success or failure. Repeating an already-current add verifies provenance, checkout, and registration locally. Resource removal applies the existing reference checks, then removes the Bazframe-owned checkout and provenance while leaving the upstream remote available. `bazframe status` reports each managed provider's remote, branch, full revision, path, health, and resource-specific update command. Retained recovery records describe the stopped operation and paths. Recovery is inspect-first and fail-closed. Add, update, and build recovery require manual reconciliation to one revision before removing the record and retrying. Removal recovery retains its record while the same remove command verifies and finishes any surviving resource, checkout, and provenance.

## Bazify Skills

Bazframe ships a `bazify` Agent Skill beside the `bazframe` self-management Skill under `dist/skills/`. Installation activates neither Skill. After a global npm install, locate the package with `BAZFRAME_PACKAGE_ROOT="$(npm root --global)/bazframe"`, then explicitly add `"$BAZFRAME_PACKAGE_ROOT/dist/skills/bazify"` to `(default)` and the desired profile before invoking the Skill or its dependency-free Node script.

Bazify packages one Skill or a collection with provider source under `skills/<name>/`, generated artifacts under `dist/skills/<name>/`, and this exact manifest contract:

```json
{"schemaVersion":1,"build":["node","scripts/bazify-build.mjs"],"artifactRoot":"dist","skillsRoot":"skills"}
```

Use `create` to extract one or more Skills into a new package. One source may be a Skill root or a project/collection root whose immediate `skills/` children are Skills; several explicit Skill roots are also accepted. A singleton defaults to its Skill name, a collection defaults to its source-root basename, and several explicit roots require `--name`. The destination defaults to `~/<package-name>`.

```bash
node <bazify-skill-root>/scripts/bazify.mjs create /path/to/skill --dry-run
node <bazify-skill-root>/scripts/bazify.mjs create /path/to/project
node <bazify-skill-root>/scripts/bazify.mjs create /path/to/first /path/to/second --name collection-name
```

Use `adapt` for a repository already dedicated to a root Skill or immediate `skills/` collection. Adaptation requires a clean Git top-level when Git is present, preserves repository files and Git configuration, appends generated-artifact ignore entries, adds only `bazframe-package.json` and `scripts/bazify-build.mjs`, and rolls back a failed validation. Exact generated state is current and repeatable.

```bash
node <bazify-skill-root>/scripts/bazify.mjs adapt /path/to/skill-repository --dry-run
node <bazify-skill-root>/scripts/bazify.mjs adapt /path/to/skill-repository
node <bazify-skill-root>/scripts/bazify.mjs validate /path/to/package
```

Create and adapt reject links, special entries, duplicate names, unsafe frontmatter/basename pairs, and several obvious credential forms. Their generated multi-Skill build uses stable no-follow reads and transactional `dist/` replacement. Validation calls `bazframe packages add` with disposable Bazframe state. Semantic dependency, setup, provenance, license, privacy, and rights review uses the local task convention under `./bazframe/`, or a temporary checklist there.

A newly extracted package can use consent-gated private publication:

```bash
node <bazify-skill-root>/scripts/bazify.mjs publish ~/<package-name> --dry-run
node <bazify-skill-root>/scripts/bazify.mjs publish ~/<package-name> --yes --approval '<preview-token>'
```

The preview binds fixed host `github.com`, authenticated owner/repository, canonical package path, and publishable bytes. Publication validates again, compares the staged Git index, creates a new private repository with fixed shell-free argv, and rejects drift or existing Git state. An adapted repository uses its existing Git workflow.

## Whole-object references

Profiles attach libraries and packages as wholes:

```bash
bazframe profile libraries add <library> [--profile <profile>]
bazframe profile libraries remove <library> [--profile <profile>]
bazframe profile packages add <package> [--profile <profile>]
bazframe profile packages remove <package> [--profile <profile>]
```

A reference never updates a library, builds a package, or selects child Skills. A valid library or package may contain zero Skills.

## Validation and activation

Bazframe validates physical containment, bounded recursive discovery, Agent Skills loading, duplicate names, and complete prospective profile composition. Library update and package build validate every referencing profile before atomically activating a new digest. Failure preserves the prior active record.

A profile Skill wins over a colliding library/package contribution. The complete conflicting object contribution is withheld while its record and reference remain intact. Unrelated Skills remain effective.

## Editing and ownership

`bazframe skill edit <skill>` opens an individually added absolute-path Skill. Managed Git Skills are edited upstream and activated with `bazframe skill update <skill>`. Library and package previews come from immutable snapshots and cannot be edited. Edit provider input, then run:

```bash
bazframe libraries update <library>
# or
bazframe packages build <package>
```

Bazframe fetches managed Git providers only during their resource-specific add and update commands. Absolute-path providers retain their existing ownership. A package build may change provider-owned output because that change is performed by the explicitly authorized provider build.

## Troubleshooting

- **A provider change is missing:** run the resource's update command for managed Git, or `libraries update` / `packages build` for local provider changes, then `/bazframe reload` in an existing Pi session.
- **`pi-loader` diagnostic:** fix the reported `SKILL.md`; Bazframe preserves the kind, object ID, relative path, and Pi loader message.
- **Duplicate name:** rename or remove the conflicting Skill/reference. Bazframe does not alias stored-profile duplicates.
- **Package declaration rejected:** use exactly `schemaVersion`, `build`, `artifactRoot`, and `skillsRoot`; paths must be portable relative paths or `.`.
- **Library rejected as a package:** a root-level `bazframe-package.json` belongs to `bazframe packages add`.

Use an agentskills.io validator such as `skills-ref validate` when you need specification portability checks beyond Bazframe's runtime loader contract.
