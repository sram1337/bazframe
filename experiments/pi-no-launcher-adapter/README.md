# Pi no-launcher instruction-context adapter

This experiment tests an adaptive no-launcher integration for Pi 0.82:

```bash
cd registered-repository
pi       # native context plus the active profile
pi -nc   # restored global context plus the active profile
```

The globally auto-discovered extension checks only whether Pi's structured `contextFiles` collection is empty. When Pi has loaded native context, the extension appends only the profile. When the collection is empty, such as with native `-nc` / `--no-context-files`, it restores the trusted global Pi context before appending the profile. It does not inspect or compare context paths.

The experiment does **not** modify or patch Pi, parse Pi's generated prompt, manipulate project trust, write into repositories, or wrap the Pi process. [`probe-provider.ts`](probe-provider.ts) is a test-only in-process provider that captures the effective system prompt without network requests.

`pi -nc` provides instruction-context replacement; plain `pi` provides additive context. Neither mode is complete harness replacement. Project settings, extensions, prompts, themes, and native skills remain Pi-owned; profile skills are additive. If a profile skill collides with an already loaded native skill, the adapter exposes an external wrapper using the valid `-x-bazframe` suffix and logs the mapping.

## Run

Requires Pi 0.82, Node.js, and Git on `PATH`:

```bash
node experiments/pi-no-launcher-adapter/run-spike.mjs
```

Set `PI_BIN` to test another Pi executable. Set `BAZFRAME_KEEP_SPIKE=1` to retain generated fixtures.

## Manual trial

This is experimental and has no installer. To try it with the default locations:

```bash
export BAZFRAME_HOME="$HOME/.bazframe-context-spike"
mkdir -p ~/.pi/agent/extensions "$BAZFRAME_HOME/profiles/demo" "$BAZFRAME_HOME/projects"
cp experiments/pi-no-launcher-adapter/bazframe.ts ~/.pi/agent/extensions/bazframe.ts
printf 'demo\n' > "$BAZFRAME_HOME/active-profile"
printf 'PROFILE_DEMO_INSTRUCTIONS\n' > "$BAZFRAME_HOME/profiles/demo/AGENTS.md"

REPOSITORY="$(git rev-parse --show-toplevel)"
node -e '
  const fs = require("node:fs");
  const { createHash } = require("node:crypto");
  const repo = fs.realpathSync(process.argv[1]);
  const id = createHash("sha256").update(repo).digest("hex");
  fs.writeFileSync(`${process.env.BAZFRAME_HOME}/projects/${id}.json`,
    `${JSON.stringify({repository: repo, mode: "adaptive-context", profile: "active"}, null, 2)}\n`);
' "$REPOSITORY"

pi       # additive context
pi -nc   # instruction-context replacement
```

Use `/bzf-explain` inside Pi to inspect the active state and `/bzf-reload` after changing `active-profile`. Remove the copied extension and `$BAZFRAME_HOME` trial directory to uninstall.

The runner validates:

- `pi -nc` excludes repository and ancestor context and restores `PI_CODING_AGENT_DIR/AGENTS.md` exactly once;
- plain `pi` retains native context, does not duplicate global context, and adds the profile;
- active-profile instructions and skills switch after `/bzf-reload`;
- a colliding `reviewer-probe` profile skill is exposed as `reviewer-probe-x-bazframe` while the native skill keeps its name;
- native project extensions, prompts, and skills remain active when approved;
- unregistered repositories retain native Pi behavior;
- repository files and Git status remain unchanged.

See [`REPORT.md`](REPORT.md) for findings and scope.
