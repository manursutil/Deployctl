# Plan 001: Record frontend smoke-check exceptions as deploy failure events

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a001b1b..HEAD -- src/core/frontend.ts test/frontend.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a001b1b`, 2026-06-30

## Why this matters

`deployFrontend()` records a failure event when build/artifact/sync work throws, and records a failure event when the frontend smoke check returns `false`. However, if the smoke-check adapter throws (for example timeout, DNS failure, HTTP client exception), the `finally` block clears the guardrail but no failure event is appended. Deploy history is an audit trail for operations; failed deploy attempts must be visible there.

## Current state

Relevant files:

- `src/core/frontend.ts` — frontend deploy orchestration and history recording.
- `test/frontend.test.ts` — unit tests for frontend deploy behavior.

Current implementation excerpt:

```ts
// src/core/frontend.ts:175-189
const healthy = await input.smokeCheck.check(tenant.frontendUrl);
const status: DeployEventStatus = healthy ? "success" : "failure";
const event = newDeployEvent({
  target,
  eventId,
  requestedRef: resolved.requestedRef,
  resolvedCommit: resolved.resolvedCommit,
  actor: input.actor,
  status,
  startedAt,
  finishedAt: clock(),
  errorMessage: healthy ? undefined : `frontend smoke check failed: ${tenant.frontendUrl}`,
});

await input.history.appendEvent(event);
```

Existing test covers `false`, not thrown exceptions:

```ts
// test/frontend.test.ts:142-155
test("deployFrontend reports failure and clears the guardrail when the smoke check fails", async () => {
  const f = fakes({ exists: true, smokeOk: false });
  // ...
  const result = await deployFrontend(baseInput(f, { history }));
  assert.equal(result.status, "failure");
  // ...
});
```

Repo conventions to follow:

- Use TypeScript with Node.js ESM.
- Use Node's built-in test runner via `node --import tsx --test`.
- Deploy orchestration accepts dependencies by interface so CLI and future dashboard can call the same modules.
- Deploy and rollback orchestration must call `startDeploymentGuardrail(...)` before work starts and `clearDeploymentGuardrail(...)` on completion or failure.
- Record failures and partial production failures clearly.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `npm test -- test/frontend.test.ts` | exit 0; frontend tests pass |
| Full tests | `npm test` | exit 0; all tests pass |
| Typecheck | `npm run typecheck` | exit 0; no TypeScript errors |

## Scope

**In scope**:

- `src/core/frontend.ts`
- `test/frontend.test.ts`
- `plans/README.md` status row only

**Out of scope**:

- Any real S3, HTTP, or AWS adapter implementation.
- CLI command wiring.
- Backend deploy behavior in `src/core/deploy.ts`.

## Git workflow

- Do not push, commit, or open a PR unless the operator explicitly requested it.
- Keep the diff focused on the in-scope files.
- Existing commit style is short imperative subject lines, e.g. `Extract shared deploy event builder`.

## Steps

### Step 1: Add a regression test for thrown smoke-check errors

In `test/frontend.test.ts`, add a test near the existing smoke-check failure test. The new test should:

1. Use normal fake artifact existence/build/sync behavior.
2. Override `smokeCheck.check()` to throw `new Error("smoke timed out")`.
3. Call `deployFrontend(...)` and assert it rejects with `DeployctlError` containing `smoke timed out` or a clear frontend deploy failure message.
4. Assert `history.listEvents(target)` has exactly one event with `status === "failure"` and an `errorMessage` containing `smoke timed out`.
5. Assert current state exists or remains initialized, with `inProgress === undefined` and no `currentVersion` update.

Use existing tests in `test/frontend.test.ts` as the structure pattern.

**Verify**: `npm test -- test/frontend.test.ts` should fail before the implementation, because no failure event is appended for thrown smoke checks.

### Step 2: Catch smoke-check exceptions and append a failure event

In `src/core/frontend.ts`, wrap the smoke check in a `try/catch` or reuse a helper so both forms are handled:

- `check()` returns `true` → append success event, update current state, return `{ status: "success", reused, event }`.
- `check()` returns `false` → append failure event, do not update current state, return `{ status: "failure", reused, event }`.
- `check()` throws → append failure event with `errorMessage: formatError(error)`, then throw a `DeployctlError` that includes context for `env/tenant` and the formatted error.

Keep the existing `finally` behavior so the matching guardrail is cleared.

Do not swallow the thrown smoke-check failure. The operator should still receive a non-zero failure while deploy history records it.

**Verify**: `npm test -- test/frontend.test.ts` exits 0.

### Step 3: Run full verification

Run the full local verification commands.

**Verify**:

- `npm test` exits 0.
- `npm run typecheck` exits 0.

## Test plan

Add one regression test in `test/frontend.test.ts` for a thrown smoke-check error. Existing tests already cover success, artifact reuse, returned-false smoke failure, and in-progress guardrail rejection.

## Done criteria

All must hold:

- [ ] `npm test -- test/frontend.test.ts` exits 0.
- [ ] `npm test` exits 0.
- [ ] `npm run typecheck` exits 0.
- [ ] A thrown `smokeCheck.check()` appends exactly one failure deploy event.
- [ ] The frontend guardrail is cleared after the thrown smoke-check failure.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 001 is updated.

## STOP conditions

Stop and report if:

- `src/core/frontend.ts` no longer uses `newDeployEvent(...)` for frontend history events.
- `DeployHistoryRepository` no longer exposes `appendEvent`, `readCurrentState`, or `updateCurrentState` as shown in this plan.
- The fix appears to require changing adapter interfaces or CLI behavior.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

When real smoke-check adapters are implemented, they may choose to return `false` for HTTP-level unhealthy responses and throw for transport/runtime failures. Both should remain audited as failed deploy attempts. Reviewers should check that the failure event is appended before rethrowing and that successful current state is not updated on smoke-check failure.
