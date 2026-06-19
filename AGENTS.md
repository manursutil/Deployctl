# AGENTS.md

Guidance for agents working in this repository:

## Architecture

For architectural context, start with `docs/initial-architecture-proposal.md`. Treat it as orientation material, and verify current behavior against the relevant code before making changes.

- Keep codebase exploration targeted. Start with explicitly mentioned files, then inspect only the minimal nearby files, tests, or call sites needed to make an informed change. If unsure about an API, prefer small scripts or focused print/debug checks before broad exploration.
- Keep changes narrowly scoped to the requested task.
- Prefer existing project conventions when they are visible from the files explicitly provided or mentioned.
- Avoid destructive git or filesystem operations unless explicitly requested.
