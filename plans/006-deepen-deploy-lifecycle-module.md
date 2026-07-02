# Plan 006: Deepen the deploy lifecycle module

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 965dcb0..HEAD -- src/core/deploy.ts src/core/frontend.ts src/core/rollback.ts src/core/reconcile.ts src/core/history.ts src/core/guardrail.ts test/deploy.test.ts test/frontend.test.ts test/rollback.test.ts test/reconcile.test.ts docs/implementation-plan.md CONTEXT.md plans/README.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: architecture
- **Planned at**: commit `965dcb0`, 2026-07-02

## Why this matters

Backend deploy, frontend deploy, rollback, and reconcile all repeat the same deploy lifecycle mechanics: operation id generation, `inProgress` guardrail acquisition, failure recording, success recording, current-state update, error normalization, and guardrail cleanup. That makes the current modules shallower than they need to be: each path exposes lifecycle ordering in its implementation instead of concentrating it behind one interface.

Deepen this into one deploy lifecycle module. The module should know the deploy domain (`DeployTarget`, `DeployHistoryRepository`, `DeployHistoryEvent`, current-state rules, and `CurrentState.inProgress`) while each deploy path keeps its own domain work: resolving refs, selecting rollback versions, computing frontend artifact identity, calling SSM, syncing frontend artifacts, and smoke checking.

This is a refactor only. Preserve public behavior, error messages, event ids, event shapes, status semantics, and CLI behavior.

## Current state

Relevant files:

- `src/core/deploy.ts` — backend deploy orchestration.
- `src/core/frontend.ts` — frontend deploy orchestration.
- `src/core/rollback.ts` — backend/frontend rollback orchestration.
- `src/core/reconcile.ts` — backend reconciliation orchestration.
- `src/core/history.ts` — event builders and current-state helper.
- `src/core/guardrail.ts` — lower-level `inProgress` guardrail seam.
- `test/deploy.test.ts`, `test/frontend.test.ts`, `test/rollback.test.ts`, `test/reconcile.test.ts` — public behavior coverage for affected modules.

Current repeated lifecycle shape:

```ts
const startedAt = clock();
const eventId = (input.generateEventId ?? formatDeployEventId)(startedAt);

await startDeploymentGuardrail(input.history, target, {
  eventId,
  since: startedAt.toISOString(),
  actor: input.actor,
});

try {
  // domain work
  // append event
  // update current state on success
} finally {
  await clearDeploymentGuardrail(input.history, target, eventId);
}
```

Documented design constraints:

- `CONTEXT.md` says deploy and rollback orchestration must call `startDeploymentGuardrail(...)` before work starts and `clearDeploymentGuardrail(...)` on completion or failure.
- `CONTEXT.md` says CLI controllers and the future dashboard call the same directly importable orchestration modules.
- `docs/implementation-plan.md` Phases 6-8 and 10 already implement deploy/rollback/reconcile behavior behind seams and tests.
- Pre-work failures such as ref resolution, rollback target selection, and artifact identity validation are not deploy history events for now.

Repo conventions to follow:

- Keep changes PR-sized and narrowly scoped.
- Keep public behavior unchanged.
- Keep the guardrail module as the lower-level seam; do not absorb it into lifecycle.
- Do not introduce new adapters or command-controller refactors.
- Update `docs/implementation-plan.md` and `CONTEXT.md` when source layout or conventions change.
- Do not commit unless the operator explicitly asks.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lifecycle tests | `npm test -- test/lifecycle.test.ts` | exit 0; lifecycle tests pass |
| Affected orchestration tests | `npm test -- test/deploy.test.ts test/frontend.test.ts test/rollback.test.ts test/reconcile.test.ts` | exit 0; public behavior preserved |
| Full tests | `npm test` | exit 0; all tests pass |
| Typecheck | `npm run typecheck` | exit 0; no TypeScript errors |

## Scope

**In scope**:

- Add `src/core/lifecycle.ts`.
- Add `test/lifecycle.test.ts`.
- Migrate `deployBackend(...)`, `deployFrontend(...)`, `rollbackBackend(...)`, `rollbackFrontend(...)`, and `reconcileBackend(...)` onto `runDeployLifecycle(...)`.
- Update affected tests only where test setup must adapt to the internal refactor.
- Update `CONTEXT.md` and `docs/implementation-plan.md` with the new module and convention.
- Update `plans/README.md` status row only.

**Out of scope**:

- Changing CLI behavior or output.
- Changing deploy history event schema.
- Changing event id formats.
- Recording pre-work failures as deploy history events.
- Adding real AWS adapters.
- Refactoring command context loading.
- Introducing a generic `withGuardrail(...)` helper for non-deploy code.

## Git workflow

The requested PR structure is one PR with focused commits, but do not create commits unless the operator explicitly asks. If commits are requested, use this shape:

1. `Add deploy lifecycle module`
2. `Move backend deploy onto lifecycle`
3. `Move frontend deploy onto lifecycle`
4. `Move rollback onto lifecycle`
5. `Move backend reconcile onto lifecycle`
6. `Document deploy lifecycle convention`

## Design

Add `src/core/lifecycle.ts` exporting `runDeployLifecycle(...)`.

Use deploy-specific vocabulary, not a generic operation abstraction. The module's interface should accept `DeployTarget` and `DeployHistoryRepository`; it should call `startDeploymentGuardrail(...)` and `clearDeploymentGuardrail(...)`.

Recommended interface shape:

```ts
export type DeployLifecycleInput<WorkResult> = {
  target: DeployTarget;
  actor: string;
  history: DeployHistoryRepository;
  clock?: () => Date;
  generateEventId: (startedAt: Date) => string;
  work: (context: { eventId: string; startedAt: Date }) => Promise<WorkResult>;
  record?: {
    success: (result: WorkResult, context: { eventId: string; startedAt: Date; finishedAt: Date }) => DeployHistoryEvent;
    failure: (error: unknown, context: { eventId: string; startedAt: Date; finishedAt: Date }) => DeployHistoryEvent;
    updateCurrentStateOnSuccess: boolean;
  };
  errorMessage: (error: unknown) => string;
};

export type DeployLifecycleResult<WorkResult> = {
  eventId: string;
  startedAt: Date;
  result: WorkResult;
};
```

Expected behavior:

- Generate `startedAt` and `eventId`.
- Acquire the guardrail before `work(...)`.
- Run `work(...)`.
- If `record` exists, append `record.success(...)`.
- If the success event has `status === "success"` and `record.updateCurrentStateOnSuccess === true`, update current state via `applySuccessfulEventToCurrentState(...)`.
- If `work(...)` throws and `record` exists, append `record.failure(...)`, then rethrow `DeployctlError` as-is or wrap unknown errors with `new DeployctlError(errorMessage(error))`.
- Always clear the matching guardrail in `finally`.
- If `record` is omitted, still guard and clear, but do not append history or update current state. This is how `reconcileBackend(...)` should use the module.

The exact type names may change if a clearer local shape emerges during implementation, but preserve the design constraints above.

## Steps

### Step 1: Add lifecycle module and focused tests

Create `src/core/lifecycle.ts` and `test/lifecycle.test.ts`.

Tests should cover:

1. Starts the guardrail before work.
2. Clears the guardrail when work succeeds.
3. Clears the guardrail when work throws.
4. Appends a failure event before rethrowing when guarded work throws.
5. Appends a success event.
6. Updates current state only when `updateCurrentStateOnSuccess: true` and event status is `success`.
7. Does not update current state for `partial_failure` or `failure`.
8. Supports guarded work with no history recording for `reconcileBackend`-style usage.

Use `InMemoryDeployHistoryRepository` and existing event builders from `src/core/history.ts`.

**Verify**: `npm test -- test/lifecycle.test.ts` exits 0.

### Step 2: Move backend deploy onto lifecycle

In `src/core/deploy.ts`, keep pre-work outside lifecycle:

- tenant lookup
- SSM target lookup
- ref resolution

Then call `runDeployLifecycle(...)` for executor work and deploy event recording.

Preserve:

- event id format (`formatDeployEventId`)
- failure event details
- `Backend deploy failed for <env>/<tenant>: ...` wrapping
- all-instance failure / partial failure status semantics
- current-state update only on success

Do not move `overallStatus(...)` unless it clearly improves locality without broadening the change.

**Verify**: `npm test -- test/deploy.test.ts test/lifecycle.test.ts` exits 0.

### Step 3: Move frontend deploy onto lifecycle

In `src/core/frontend.ts`, keep pre-work outside lifecycle:

- tenant lookup
- ref resolution
- frontend identity input validation
- artifact key/storage key calculation

Then call `runDeployLifecycle(...)` for artifact store/build/sync/smoke-check work and deploy event recording.

Preserve:

- artifact reuse behavior
- builder receives full `buildVariables`
- artifact identity uses only configured identity inputs
- thrown build/sync/smoke-check failures record one failure event
- returned `false` smoke check records a failure event and returns a failure result
- current-state update only on success

**Verify**: `npm test -- test/frontend.test.ts test/lifecycle.test.ts` exits 0.

### Step 4: Move rollback onto lifecycle

In `src/core/rollback.ts`, keep pre-work outside lifecycle:

- tenant lookup
- SSM target lookup for backend rollback
- rollback target selection
- frontend artifact key validation

Then call `runDeployLifecycle(...)` for backend redeploy and frontend re-sync/smoke-check work.

Preserve:

- event id format (`formatRollbackEventId`)
- rollback event shapes
- backend partial failure semantics
- frontend missing-artifact behavior remains pre-work and does not record a rollback event
- current-state update only on success
- existing error messages

**Verify**: `npm test -- test/rollback.test.ts test/lifecycle.test.ts` exits 0.

### Step 5: Move backend reconcile onto lifecycle

In `src/core/reconcile.ts`, keep pre-work outside lifecycle:

- tenant lookup
- SSM target lookup
- current-state read and no-current-version error

Then call `runDeployLifecycle(...)` with no `record` block. It should still use the guardrail and clear it on success/failure, but it must not append history or update current state.

Preserve:

- event id format (`formatReconcileEventId`)
- no history event for reconcile
- returned result shape
- existing error messages

**Verify**: `npm test -- test/reconcile.test.ts test/lifecycle.test.ts` exits 0.

### Step 6: Run affected and full verification

Run the affected orchestration suite, then full verification.

**Verify**:

- `npm test -- test/deploy.test.ts test/frontend.test.ts test/rollback.test.ts test/reconcile.test.ts test/lifecycle.test.ts` exits 0.
- `npm test` exits 0.
- `npm run typecheck` exits 0.

### Step 7: Update docs and plan status

Update `CONTEXT.md` and `docs/implementation-plan.md`:

- Add `src/core/lifecycle.ts` to the current file list once implemented.
- Record the convention that deploy/rollback/reconcile guarded work uses `runDeployLifecycle(...)`.
- Keep `src/core/guardrail.ts` documented as the lower-level guardrail seam.

Update this plan's row in `plans/README.md` from `TODO` to `DONE` only after all verification passes.

**Verify**: docs mention the lifecycle module without implying a behavior change.

## Test plan

Add focused lifecycle tests for the lifecycle module and keep existing public module tests for deploy, frontend deploy, rollback, and reconcile. The lifecycle tests protect the shared interface; existing tests protect each caller's domain-specific event builders and adapter work.

## Done criteria

All must hold:

- [ ] `src/core/lifecycle.ts` exists and exports `runDeployLifecycle(...)`.
- [ ] `src/core/guardrail.ts` remains the lower-level guardrail seam.
- [ ] `deployBackend(...)`, `deployFrontend(...)`, `rollbackBackend(...)`, `rollbackFrontend(...)`, and `reconcileBackend(...)` use the lifecycle module for guarded work.
- [ ] Pre-work failures are still not recorded as deploy history events.
- [ ] Public behavior, event ids, event shapes, and error messages are preserved.
- [ ] `reconcileBackend(...)` uses lifecycle guardrail handling without recording history/current-state changes.
- [ ] `npm test -- test/deploy.test.ts test/frontend.test.ts test/rollback.test.ts test/reconcile.test.ts test/lifecycle.test.ts` exits 0.
- [ ] `npm test` exits 0.
- [ ] `npm run typecheck` exits 0.
- [ ] `CONTEXT.md` and `docs/implementation-plan.md` are updated.
- [ ] `plans/README.md` status row for Plan 006 is updated.

## STOP conditions

Stop and report if:

- Preserving public behavior requires changing the proposed lifecycle interface substantially.
- The refactor appears to require changing `DeployHistoryRepository` or event schemas.
- Tests show current behavior differs from the assumptions in this plan.
- `reconcileBackend(...)` cannot use the same lifecycle module without introducing fake history events.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

This module should stay deploy-specific. Do not turn it into a generic `withGuardrail(...)` helper unless another non-deploy use case appears and justifies a separate seam. One adapter or caller variation is not enough reason to widen the interface.
