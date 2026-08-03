# Dev Mode

Use dev mode after a vertical slice and implementation stack have been approved.

## Start

1. Read `TODO.md` and `SCRATCHPAD.md`.
2. Read the relevant sections of `docs/design.md`.
3. Confirm the requested behavior is settled before implementing it.

## Rules

- Implement the smallest approved vertical slice.
- Keep product logic independent from any one skill-library provider where the design requires interoperability.
- Add tests for observable behavior.
- Keep `TODO.md` synchronized with implementation progress.
- Do not import Bazframe v1 code wholesale; reuse only deliberately selected components.
