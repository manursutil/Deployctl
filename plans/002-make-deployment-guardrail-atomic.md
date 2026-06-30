# Plan 002: Make deployment guardrail acquisition atomic

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a001b1b..HEAD -- src/core/guardrail.ts src/core/history.ts test/guardrail.test.ts test/deploy.test.ts test/frontend.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a001b1b`, 2026-06-30

## Why this matters

The `current.json.inProgress` guardrail is the documented concurrency mechanism for `deployctl`. Today it is implemented as a read followed by a write. With a real S3-backed repository, two operators or pipeline jobs can both read no `inProgress` and both write, allowing concurrent deploys for the same `env/tenant/app`. Before real deploy execution lands, the repository seam should support atomic guardrail acquisition so adapters can enforce conditional writes.

## Current state

Relevant files:

- `src/core/history.ts` — defines `DeployHistoryRepository` and the in-memory implementation.
- `src/core/guardrail.ts` — starts and clears `CurrentState.inProgress`.
- `test/guardrail.test.ts` — guardrail unit tests.
- `test/deploy.test.ts` and `test/frontend.test.ts` — orchestration tests that depend on guardrail behavior.

Current repository seam:

```ts
// src/core/history.ts:63-68
export type DeployHistoryRepository = {
  appendEvent(event: DeployHistoryEvent): Promise<void>;
  listEvents(target: DeployTarget): Promise<DeployHistoryEvent[]>;
  readCurrentState(target: DeployTarget): Promise<CurrentState | undefined>;
  updateCurrentState(state: CurrentState): Promise<void>;
};
```

Current non-atomic guardrail acquisition:

```ts
// src/core/guardrail.ts:9-20
const current = await repository.readCurrentState(target);

if (current?.inProgress !== undefined) {
  throw new DeployctlError(
    `deploy already in progress for ${target.env}/${target.tenant}/${target.app}: ${current.inProgress.eventId} since ${current.inProgress.since}`,
  );
}

await repository.updateCurrentState({
  ...(current ?? initialCurrentState(target, inProgress.since)),
  inProgress,
});
```

Documented design constraints:

- `docs/implementation-plan.md:123-130` says deploys resolve refs to immutable SHAs, secret values never pass through `deployctl`, `current.json.inProgress` is the concurrency mechanism, and CLI/dashboard call the same orchestration modules.
- `CONTEXT.md:198-200` says history callers use `DeployHistoryRepository`; deploy orchestration must call `startDeploymentGuardrail(...)` before work starts and `clearDeploymentGuardrail(...)` on completion or failure.

Repo conventions to follow:

- Keep business rules in reusable core modules, not CLI parsing.
- Keep AWS/S3-specific mechanics behind adapter seams.
- Avoid broad compatibility layers until real persisted data or external consumers exist.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused guardrail tests | `npm test -- test/guardrail.test.ts` | exit 0; guardrail tests pass |
| Related deploy tests | `npm test -- test/deploy.test.ts test/frontend.test.ts` | exit 0; deploy orchestration tests pass |
| Full tests | `npm test` | exit 0; all tests pass |
| Typecheck | `npm run typecheck` | exit 0; no TypeScript errors |

## Scope

**In scope**:

- `src/core/history.ts`
- `src/core/guardrail.ts`
- `test/guardrail.test.ts`
- `test/deploy.test.ts` only if existing test setup must adapt to the new repository seam
- `test/frontend.test.ts` only if existing test setup must adapt to the new repository seam
- `plans/README.md` status row only

**Out of scope**:

- Implementing an S3 adapter.
- Changing deploy/rollback public behavior.
- Adding timeout/stale-lock recovery. That is a separate policy decision.
- Changing the `CurrentState` JSON shape unless absolutely necessary for atomic compare-and-set.

## Git workflow

- Do not push, commit, or open a PR unless explicitly requested.
- Keep the diff focused on the in-scope files.
- Existing commit style is short imperative subject lines, e.g. `Add Phase 5 deployment guardrail`.

## Steps

### Step 1: Extend the repository seam with atomic guardrail acquisition

In `src/core/history.ts`, add a method to `DeployHistoryRepository` that represents atomic guardrail acquisition. Prefer a domain-specific method rather than leaking S3 implementation details into core, for example:

```ts
tryStartDeployment(target: DeployTarget, inProgress: InProgressState): Promise<CurrentState>;
```

Semantics:

- Atomically reads/creates/updates current state for `target`.
- If no `inProgress` exists, stores the supplied `inProgress` and returns the new current state.
- If an `inProgress` exists, throws `DeployctlError` with the same clear message used today.
- Adapters must implement this with conditional write / compare-and-set semantics when persistent storage lands.

Keep `readCurrentState` and `updateCurrentState` because other code still needs them.

**Verify**: `npm run typecheck` should fail until implementations and call sites are updated.

### Step 2: Implement the method in `InMemoryDeployHistoryRepository`

In `src/core/history.ts`, implement `tryStartDeployment(...)` on `InMemoryDeployHistoryRepository` with the same behavior as `startDeploymentGuardrail` currently performs, but as one synchronous critical section with no `await` between checking and setting in the in-memory implementation.

Use the same initial state shape as `initialCurrentState(...)` in `src/core/guardrail.ts`:

```ts
{
  ...target,
  currentVersion: null,
  lastSuccessfulEventId: null,
  updatedAt: inProgress.since,
  inProgress,
}
```

Validate stored state with `validateCurrentState(...)` before saving.

**Verify**: `npm run typecheck` still may fail until `guardrail.ts` is updated, but no syntax errors should be introduced.

### Step 3: Make `startDeploymentGuardrail` delegate to the atomic seam

In `src/core/guardrail.ts`, replace the read-then-write implementation with a call to `repository.tryStartDeployment(target, inProgress)`. Keep `clearDeploymentGuardrail(...)` unchanged unless the type change requires minor adaptation.

Remove or keep `initialCurrentState(...)` only if still used. Do not leave dead code.

**Verify**: `npm run typecheck` exits 0.

### Step 4: Add a regression-style test for repository-level atomic semantics

In `test/guardrail.test.ts`, add or adjust tests to assert:

1. `startDeploymentGuardrail(...)` initializes state before the first successful deploy.
2. A second `startDeploymentGuardrail(...)` on the same target rejects with `deploy already in progress` and keeps the original `inProgress.eventId`.
3. Direct `repository.tryStartDeployment(...)` behaves the same if you expose and test it directly.

A true concurrent race is difficult to prove with the in-memory repository. The important executable check is that the core guardrail no longer performs the check/write itself; the atomic operation lives behind the repository seam for persistent adapters.

**Verify**: `npm test -- test/guardrail.test.ts` exits 0.

### Step 5: Run related and full verification

Run deploy and frontend tests because both orchestration modules call the guardrail.

**Verify**:

- `npm test -- test/deploy.test.ts test/frontend.test.ts` exits 0.
- `npm test` exits 0.
- `npm run typecheck` exits 0.

## Test plan

Update `test/guardrail.test.ts` to cover the unchanged public guardrail behavior and, if practical, the new repository method behavior. Existing deploy/frontend tests should continue to pass without behavior changes.

## Done criteria

All must hold:

- [ ] `DeployHistoryRepository` exposes an atomic/domain-specific guardrail acquisition method.
- [ ] `startDeploymentGuardrail(...)` no longer performs read-then-write itself.
- [ ] `InMemoryDeployHistoryRepository` implements the new method.
- [ ] Existing guardrail behavior and error messages remain clear.
- [ ] `npm test -- test/guardrail.test.ts` exits 0.
- [ ] `npm test -- test/deploy.test.ts test/frontend.test.ts` exits 0.
- [ ] `npm test` exits 0.
- [ ] `npm run typecheck` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 002 is updated.

## STOP conditions

Stop and report if:

- A real persistent history adapter already exists and has different concurrency semantics not described here.
- Implementing atomic acquisition appears to require changing the persisted `current.json` schema.
- Tests reveal callers rely on the old read-then-write interleaving.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

When the S3-backed `DeployHistoryRepository` is implemented, reviewers must verify `tryStartDeployment(...)` uses conditional write or compare-and-set semantics. A method with the right name but implemented as read-then-write in S3 would reintroduce the race this plan removes from the core seam.
