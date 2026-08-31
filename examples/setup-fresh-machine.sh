#!/usr/bin/env bash
set -e

# Requires Node.js 22.19 or newer, npm, and Git.
# This is a bootstrap recipe. Stage 2 profile artifacts can import exact remote Git Skills/libraries and explicitly mapped local libraries, but this script does not assume a user-specific artifact.

# Install a current Pi release (Bazframe requires Pi 0.84.4 or newer).
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

# To restore a reviewed Stage 2 artifact, replace the `profile add/use` lines above with:
# bazframe profile import --dry-run /path/to/profile-artifact
# bazframe profile import --as personal /path/to/profile-artifact
# bazframe profile use personal
#
# For every local library declared by the artifact, add the same repeatable option to both import commands.
# The absolute physical source directory basename must equal the library ID:
# bazframe profile import --map library:toolkit=/absolute/path/to/toolkit --dry-run /path/to/profile-artifact
# bazframe profile import --as personal --map library:toolkit=/absolute/path/to/toolkit /path/to/profile-artifact
#
# Remote Git sources remain explicit. Replace the examples before use:
# bazframe skill add git:owner/root-skill
# bazframe profile skill add root-skill
# bazframe library add git:owner/skill-library
# bazframe profile library add skill-library
# bazframe package add git:owner/skill-package
# bazframe profile package add skill-package

# Verify the local setup, then start Pi with: pi
bazframe status
