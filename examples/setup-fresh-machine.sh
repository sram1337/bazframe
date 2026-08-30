#!/usr/bin/env bash
set -e

# Requires Node.js 22.19 or newer, npm, and Git.
# This is a bootstrap recipe. Profile export/import is not available yet.

# Install a current Pi release (Bazframe requires Pi 0.82.0 or newer).
npm install --global --ignore-scripts @earendil-works/pi-coding-agent

# Install the Bazframe public beta from npm's next channel.
npm install --global bazframe@next

# Install the Pi adapter and create a local profile.
bazframe adapter install pi
bazframe profile add personal
bazframe profile use personal

# Bundled Skills are optional and are never activated by npm installation.
# To add Bazframe's management Skill explicitly, uncomment these lines:
# BAZFRAME_PACKAGE_ROOT="$(npm root --global)/bazframe"
# bazframe skill add "$BAZFRAME_PACKAGE_ROOT/dist/skills/bazframe"
# bazframe profile skill add bazframe

# Remote Git sources remain explicit. Replace the examples before use:
# bazframe skill add git:owner/root-skill
# bazframe profile skill add root-skill
# bazframe library add git:owner/skill-library
# bazframe profile library add skill-library
# bazframe package add git:owner/skill-package
# bazframe profile package add skill-package

# Verify the local setup, then start Pi with: pi
bazframe status
