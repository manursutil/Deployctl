# AGENTS.md

Guidance for agents working in this repository:

## Architecture

For architectural context, start with `docs/initial-architecture-proposal.md`. Treat it as orientation material, and verify current behavior against the relevant code before making changes.

Use `docs/implementation-plan.md` as the live implementation tracker. When a change starts, progresses, is blocked, or is completed, update the relevant phase/status in the same change set so the plan does not drift from the code.

- Keep codebase exploration targeted. Start with explicitly mentioned files, then inspect only the minimal nearby files, tests, or call sites needed to make an informed change. If unsure about an API, prefer small scripts or focused print/debug checks before broad exploration.
- Keep changes narrowly scoped to the requested task.
- Prefer existing project conventions when they are visible from the files explicitly provided or mentioned.
- Avoid destructive git or filesystem operations unless explicitly requested.

## Change Workflow

- Treat every feature, bug fix, behavior change, or operational change as PR-sized work.
- Keep each PR focused on one coherent vertical slice.
- Include tests when they protect meaningful behavior through public interfaces.
- Do not add broad speculative test suites before implementation.
- Update `docs/implementation-plan.md` and `CONTEXT.md` when the change affects phase status, commands, source layout, conventions, or operational behavior.
- Do not commit, push, or create a PR unless the user explicitly asks for that action.
