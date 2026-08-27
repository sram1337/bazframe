# Contributing to Bazframe

Bazframe is an open-source companion for [Pi](https://github.com/earendil-works/pi), a terminal coding agent that lets a language model read, edit, and run code. Bazframe adds reusable personal profiles and standard Agent Skills to Pi sessions without replacing a repository's own instructions.

Report bugs and usage problems in [GitHub issues](https://github.com/sram1337/bazframe/issues). Propose significant behavior or design changes in an issue before investing in an implementation so the intended scope can be agreed first. Do not treat existing code as a product decision: [`docs/design.md`](docs/design.md) is the current product source of truth.

## Development setup

You need [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/) 22.19.0 or newer. Start from a clean clone and install the locked dependencies:

```bash
git clone https://github.com/sram1337/bazframe.git
cd bazframe
npm ci
```

Pi is required only for validation that exercises the real Pi integration. Bazframe's normal build and test dependencies are installed by `npm ci`.

## Making and validating changes

Keep each change focused on an agreed behavior. Update or add tests for observable behavior, preserve existing interfaces outside the change, and update documentation when its claims change.

Never use your real Bazframe or Pi state for development or acceptance checks. For manual commands that may read or write either application's state, create disposable directories and set both overrides to absolute paths, for example:

```bash
TEMP_ROOT="$(mktemp -d)"
export BAZFRAME_HOME="$TEMP_ROOT/bazframe-home"
export PI_CODING_AGENT_DIR="$TEMP_ROOT/pi-agent"
```

Remove the temporary root after the check. Do not point tests at `$HOME/.bazframe` or `$HOME/.pi/agent`.

Run the standard validation gate before submitting a change:

```bash
npm test
```

This builds the project and runs type checking, linting, unit tests, integration tests, and packed-package validation. Also run:

- `npm run test:real-pi` when changing the Pi adapter, runtime projection, compatibility behavior, or packaged flows exercised through a real Pi installation.
- `npm run test:tui-terminal:local` when changing terminal UI rendering, input, resizing, process handoff, or terminal restoration and the host provides `tmux` and `script`. For the Linux terminal matrix, use `npm run test:tui-terminal:linux` on a host with Docker.

Use additional focused checks only when they are relevant to the files or behavior changed. Maintainer-only release validation and publication steps are documented in [`docs/releasing.md`](docs/releasing.md); contributors should not run release or publication work as part of a normal change.

## Pull requests

A useful pull request description explains:

- the problem and intended behavior;
- the focused implementation approach and any user-visible documentation changes;
- tests and manual checks run, including their results;
- safety considerations, limitations, or follow-up work that remains.

Link the relevant issue when one exists, especially for significant changes.
