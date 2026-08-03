# Bazframe v2 Spec

Bring your harness with you.
Treat the harness as a first class object.

# Problem
Managing a harness across projects is a pain. Some skills exist in some projects, you don't remember where they are, you need to copy them over, but don't know which files in the skill are project specific vs not. Copy pasting is a pain. Updating a skill in one place means you have to update it everywhere. You can't manage multiple harnesses well. Its slightly cumbersome to switch between coding agents (pi, claude, codex.) Some repos have their own AGENTS.md - how to reconcile that?


# Bazframe Example Usage
```bash
bazframe use myFavoriteHarness
cd myProject
bazframe pi # automatically writes a .baz.agents.md in the local dir copied from my profile, and launches pi using that agents.md
```

```bash
cd myProject
bazframe scan # scan project recursively for skills
# can then take them back to local bazframe skill library
```

```bash
cd myProject
bazframe add socialize # adds the local @moltbook/socialize skill to the current project's skill dir
```

```bash
cd myProject
bazframe remove socialize # removes the local @moltbook/socialize skill
```

```bash
bazframe lift socialize # removes the local @moltbook/socialize skill and adds it to the current profile and bazframe skill library 
```

```bash
bazframe use profile myOtherProfile
```

```bash
bazframe --gui # opens gui skill manager which shows all projects in home dir and their skills,
#                 whether they are project owned, or copied into the bazframe library, or modified
```

```bash
bazframe export myFavProfile # exports harness as .harness (its a tar.gz file)
```

```bash
bazframe import myFavProfile ./path/to/myFavProfile.harness
```

## Current narrowed direction

The active experiment focuses on **no-launcher instruction-context replacement**. Bazframe maintains external profiles that reference a separately managed live skill library, registers repositories outside their worktrees, and uses a native runtime adapter. Skill acquisition, scanning, lifting, updates, dependency management, profile export, and GUI behavior remain outside this experiment.

The validated Pi 0.82 adapter is adaptive. It checks only whether Pi's structured context-file collection is empty. Plain `pi` retains native context and receives the active profile; `pi -nc` disables native context, after which the extension restores global Pi instructions and applies the active profile. Profile skills are added through Pi's native discovery hook. No Bazframe launcher, shell shim, repository write, generated-prompt parser, context-path comparison, trust manipulation, or Pi modification is involved.

This is materially narrower than complete harness replacement. Project settings, extensions, prompts, themes, system-prompt files, and native skills remain Pi-owned; profile skills are additive. If a profile skill name collides with a native Pi skill, the adapter leaves the native name intact and exposes an external wrapper as `<name>-x-bazframe`, logging the alias. Project trust remains an independent security decision. The candidate registration mode is `adaptive-context`.

See [`no-launcher-harness-override.md`](no-launcher-harness-override.md) and the executable [`pi-no-launcher-adapter` report](../experiments/pi-no-launcher-adapter/REPORT.md) for exact semantics and validation. This bounded adaptive behavior is accepted as the first Pi adapter boundary. The next work is installation and `bzf2 init`/status UX; complete harness replacement remains outside the contract.
