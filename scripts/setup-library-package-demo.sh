#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"
npm run build

temporary_root="${TMPDIR:-/tmp}"
sandbox="$(mktemp -d "${temporary_root%/}/bazframe-library-package-demo.XXXXXX")"
export BAZFRAME_HOME="$sandbox/bazframe"
export PI_CODING_AGENT_DIR="$sandbox/pi-agent"
export LIBRARY_ROOT="$sandbox/demo-library"
export PACKAGE_ROOT="$sandbox/demo-package"

mkdir -p "$LIBRARY_ROOT/card-search" "$PACKAGE_ROOT/src/deck-analysis"
cat > "$LIBRARY_ROOT/card-search/SKILL.md" <<'EOF'
---
name: card-search
description: Demo library Skill.
---
# Card Search
EOF
cat > "$PACKAGE_ROOT/src/deck-analysis/SKILL.md" <<'EOF'
---
name: deck-analysis
description: Demo package Skill.
---
# Deck Analysis
EOF
cat > "$PACKAGE_ROOT/build.mjs" <<'EOF'
import { cp, mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist/skills/deck-analysis', { recursive: true });
await cp('src/deck-analysis/SKILL.md', 'dist/skills/deck-analysis/SKILL.md');
await mkdir('dist/shared', { recursive: true });
await writeFile('dist/shared/provider.txt', 'shared package resource\n');
EOF
cat > "$PACKAGE_ROOT/bazframe-package.json" <<'EOF'
{"schemaVersion":1,"build":["node","build.mjs"],"artifactRoot":"dist","skillsRoot":"skills"}
EOF

cli=(node "$repository_root/dist/cli.js")
"${cli[@]}" profile add demo
"${cli[@]}" profile use demo
"${cli[@]}" libraries add "$LIBRARY_ROOT"
"${cli[@]}" packages add "$PACKAGE_ROOT"
"${cli[@]}" profile libraries add demo-library
"${cli[@]}" profile packages add demo-package
"${cli[@]}" adapter install pi

printf '\n--- Library and package composition ---\n'
"${cli[@]}" profile libraries
"${cli[@]}" profile packages
printf '\n--- Bazframe status ---\n'
"${cli[@]}" status

cat > "$sandbox/env.sh" <<EOF
export BAZFRAME_HOME=$(printf %q "$BAZFRAME_HOME")
export PI_CODING_AGENT_DIR=$(printf %q "$PI_CODING_AGENT_DIR")
EOF
printf '\nDemo ready. Run: source %q && pi --no-session\n' "$sandbox/env.sh"
printf 'Then use /bazframe info, /skill:card-search, or /skill:deck-analysis.\n'
printf 'Sandbox: %s\nLibrary input: %s\nPackage input: %s\n' "$sandbox" "$LIBRARY_ROOT" "$PACKAGE_ROOT"
