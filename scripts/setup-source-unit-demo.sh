#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

npm run build

temporary_root="${TMPDIR:-/tmp}"
sandbox="$(mktemp -d "${temporary_root%/}/bazframe-source-unit-demo.XXXXXX")"
export BAZFRAME_HOME="$sandbox/bazframe"
export PI_CODING_AGENT_DIR="$sandbox/pi-agent"
export PROVIDER="$sandbox/provider"

mkdir -p "$PROVIDER/card-search" "$PROVIDER/nested/deck-analysis"

cat > "$PROVIDER/card-search/SKILL.md" <<'EOF'
---
name: card-search
description: Test card-search skill.
---

# Card Search

Respond that card-search loaded successfully.
EOF

cat > "$PROVIDER/nested/deck-analysis/SKILL.md" <<'EOF'
---
name: deck-analysis
description: Test deck-analysis skill.
---

# Deck Analysis

Respond that deck-analysis loaded successfully.
EOF

cli=(node "$repository_root/dist/cli.js")
"${cli[@]}" profile add demo
"${cli[@]}" profile use demo
"${cli[@]}" profile sources add custom test-suite "$PROVIDER"
"${cli[@]}" adapter install pi

printf '\n--- Source-unit discovery ---\n'
"${cli[@]}" profile sources

printf '\n--- Bazframe status ---\n'
"${cli[@]}" status

environment_file="$sandbox/env.sh"
printf 'export BAZFRAME_HOME=%q\n' "$BAZFRAME_HOME" > "$environment_file"
printf 'export PI_CODING_AGENT_DIR=%q\n' "$PI_CODING_AGENT_DIR" >> "$environment_file"
printf 'export PROVIDER=%q\n' "$PROVIDER" >> "$environment_file"

printf '\nDemo ready. To test it interactively in Pi:\n\n'
printf '  source %q\n' "$environment_file"
printf '  pi --no-session\n\n'
printf 'Then run `/bazframe info`, `/skill:card-search`, or `/skill:deck-analysis`.\n'
printf 'Sandbox: %s\n' "$sandbox"
printf 'Provider: %s\n' "$PROVIDER"
