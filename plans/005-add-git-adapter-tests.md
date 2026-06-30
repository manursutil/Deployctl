# Plan 005: Add focused tests for the Git CLI adapter boundary

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a001b1b..HEAD -- src/adapters/git.ts test/git.test.ts test/refs.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/003-verify-direct-commit-shas.md` if Plan 003 is executed first; otherwise none
- **Category**: tests
- **Planned at**: commit `a001b1b`, 2026-06-30

## Why this matters

`GitCliRefResolver` is the boundary where runtime deploy input crosses into the Git CLI. The implementation uses `execFile`, which is the right shell-safety shape, but the adapter itself has no direct tests. Current ref tests use a fake `RefResolver`, so they verify policy but not parsing, selection precedence, malformed output handling, or command args. Focused adapter tests make future ref-resolution changes safer.

## Current state

Relevant files:

- `src/adapters/git.ts` — Git CLI adapter and `git ls-remote` parsing/selection.
- `test/refs.test.ts` — policy tests using a fake resolver; does not exercise the adapter.
- `test/git.test.ts` — create this file unless Plan 003 already created it.

Current adapter implementation:

```ts
// src/adapters/git.ts:1-7
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DeployctlError } from "../shared.js";
import type { RefKind, RefResolver, ResolvedGitRef } from "../core/refs.js";

const execFileAsync = promisify(execFile);
const fullCommitShaPattern = /^[0-9a-f]{40}$/i;
```

```ts
// src/adapters/git.ts:68-80
function selectRef(ref: string, refs: ResolvedGitRef[]): ResolvedGitRef | undefined {
  const tag = refs.find((candidate) => candidate.kind === "tag");
  if (tag !== undefined) {
    return tag;
  }

  const branch = refs.find((candidate) => candidate.kind === "branch");
  if (branch !== undefined) {
    return branch;
  }

  return refs.find((candidate) => candidate.commitSha.startsWith(ref));
}
```

Repo conventions to follow:

- Use Node's built-in test runner and `node:assert/strict`.
- Keep Git access isolated in `src/adapters/git.ts` behind `RefResolver`.
- Do not run network-dependent tests in the normal test suite.
- CLI behavior tests use `spawnSync`; adapter unit tests should use dependency injection rather than spawning real Git.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused Git adapter tests | `npm test -- test/git.test.ts` | exit 0; Git adapter tests pass |
| Ref policy tests | `npm test -- test/refs.test.ts` | exit 0; existing policy tests pass |
| Full tests | `npm test` | exit 0; all tests pass |
| Typecheck | `npm run typecheck` | exit 0; no TypeScript errors |

## Scope

**In scope**:

- `src/adapters/git.ts`
- `test/git.test.ts` (create if absent)
- `test/refs.test.ts` only if adapter type changes require fake updates
- `plans/README.md` status row only

**Out of scope**:

- Changing deploy policy in `src/core/refs.ts`.
- Adding real-network integration tests.
- Replacing the Git CLI adapter with a Git library.
- Implementing direct-SHA verification if Plan 003 is being done separately. If Plan 003 has not been done, do not broaden this plan beyond testability and existing behavior coverage.

## Git workflow

- Do not push, commit, or open a PR unless explicitly requested.
- Keep the change focused on testability and tests.
- Existing commit style is short imperative subject lines, e.g. `Add Phase 3 ref resolution`.

## Steps

### Step 1: Add a command-runner injection seam if it does not already exist

If Plan 003 has already added an injectable command runner to `GitCliRefResolver`, reuse it and skip this step.

Otherwise, update `src/adapters/git.ts` so tests can pass a fake runner without invoking real Git. Keep production behavior identical. Example shape:

```ts
type GitCommandRunner = (args: string[]) => Promise<string>;

export class GitCliRefResolver implements RefResolver {
  constructor(private readonly runGit: GitCommandRunner = defaultRunGit) {}
}
```

The default runner should still call `execFile("git", args, { encoding: "utf8" })`. Do not switch to shell execution.

**Verify**: `npm run typecheck` exits 0 after any needed test fake updates.

### Step 2: Add adapter tests for command args and selection behavior

Create or update `test/git.test.ts` with fake-runner tests:

1. Resolving a branch/tag ref calls Git with `ls-remote`, the repository URL, the raw ref, `refs/heads/<ref>`, `refs/tags/<ref>`, and `refs/tags/<ref>^{}`.
2. If output contains both `refs/tags/v1.2.3` and `refs/heads/v1.2.3`, resolver returns `kind: "tag"`.
3. If output contains only a branch, resolver returns `kind: "branch"`.
4. If no matching refs are returned, resolver rejects with `DeployctlError`.

Use fixed 40-character hex strings in test output.

**Verify**: `npm test -- test/git.test.ts` exits 0.

### Step 3: Add adapter tests for malformed output and error wrapping

In `test/git.test.ts`, add tests for:

1. Malformed `git ls-remote` output, such as a non-SHA first column, rejects with `Unexpected git ls-remote output`.
2. Runner throwing `new Error("boom")` is wrapped in `DeployctlError` with `Could not query git refs` and includes the repository URL but does not dump secrets. Use a dummy URL without credentials.

**Verify**: `npm test -- test/git.test.ts` exits 0.

### Step 4: Run ref and full verification

**Verify**:

- `npm test -- test/refs.test.ts` exits 0.
- `npm test` exits 0.
- `npm run typecheck` exits 0.

## Test plan

Add `test/git.test.ts` covering the adapter directly with a fake command runner. Keep tests deterministic and offline.

If Plan 003 is executed before this plan, include direct full-SHA verification tests there or here, but avoid duplicate tests with contradictory expectations.

## Done criteria

All must hold:

- [ ] `GitCliRefResolver` can be tested without invoking real Git or network.
- [ ] Tests cover command args, tag-over-branch selection, branch-only selection, no-match rejection, malformed output, and command error wrapping.
- [ ] `npm test -- test/git.test.ts` exits 0.
- [ ] `npm test -- test/refs.test.ts` exits 0.
- [ ] `npm test` exits 0.
- [ ] `npm run typecheck` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 005 is updated.

## STOP conditions

Stop and report if:

- Plan 003 has already created equivalent comprehensive adapter tests; in that case mark this plan `REJECTED` in `plans/README.md` with rationale rather than duplicating tests.
- Testing requires real network access or credentials.
- The adapter no longer uses the Git CLI at all.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

These tests should stay focused on adapter behavior, not production/staging policy. Policy belongs in `src/core/refs.ts` tests. If future changes add another Git provider adapter, keep these tests specific to `GitCliRefResolver` and add separate tests for the new adapter.
