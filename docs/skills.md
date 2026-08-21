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

The provider owns the live bytes. Bazframe stores parallel absolute links in `(default)` and the profile.

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

`bazframe skill edit <skill>` opens only an individually added live Skill. Library and package previews come from immutable snapshots and cannot be edited. Edit provider input, then run:

```bash
bazframe libraries update <library>
# or
bazframe packages build <package>
```

Bazframe never fetches, polls, deletes, or edits provider content. A package build may change provider-owned output because that change is performed by the explicitly authorized provider build.

## Troubleshooting

- **A provider change is missing:** run `libraries update` or `packages build`, then `/bazframe reload` in an existing Pi session.
- **`pi-loader` diagnostic:** fix the reported `SKILL.md`; Bazframe preserves the kind, object ID, relative path, and Pi loader message.
- **Duplicate name:** rename or remove the conflicting Skill/reference. Bazframe does not alias stored-profile duplicates.
- **Package declaration rejected:** use exactly `schemaVersion`, `build`, `artifactRoot`, and `skillsRoot`; paths must be portable relative paths or `.`.
- **Library rejected as a package:** a root-level `bazframe-package.json` belongs to `bazframe packages add`.

Use an agentskills.io validator such as `skills-ref validate` when you need specification portability checks beyond Bazframe's runtime loader contract.
