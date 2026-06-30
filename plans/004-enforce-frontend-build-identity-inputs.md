# Plan 004: Enforce configured frontend build identity inputs

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a001b1b..HEAD -- src/core/frontend.ts test/frontend.test.ts src/core/config.ts test/config.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a001b1b`, 2026-06-30

## Why this matters

Frontend artifacts are only safe to reuse when all build-time values that affect the static bundle are included in the artifact identity. The config already declares `build.frontend.buildConfigIdentityInputs`, but `deployFrontend()` hashes whatever `buildVariables` object the caller supplies. That means a future CLI/build adapter can accidentally omit required identity inputs or include irrelevant variables, leading to unsafe artifact reuse or unnecessary rebuilds. The core should enforce the contract before real frontend adapters land.

## Current state

Relevant files:

- `src/core/frontend.ts` — frontend artifact key and deploy orchestration.
- `test/frontend.test.ts` — tests for artifact identity and frontend deploy behavior.
- `src/core/config.ts` and `test/config.test.ts` — config parser and tests; likely no source change needed unless validating identity input names.

Config type and parser already expose identity inputs:

```ts
// src/core/config.ts:12-16
build: {
  backend: BuildConfig;
  frontend: BuildConfig & {
    buildConfigIdentityInputs: string[];
  };
};
```

```ts
// src/core/config.ts:86-89
frontend: {
  ...buildConfig(frontend, `${sourceName}.build.frontend`),
  buildConfigIdentityInputs: stringArray(frontend.buildConfigIdentityInputs, `${sourceName}.build.frontend.buildConfigIdentityInputs`),
},
```

Current deploy code uses all supplied build variables:

```ts
// src/core/frontend.ts:127-133
const key = frontendArtifactKey({
  env: input.env,
  tenant: input.tenant,
  resolvedCommit: resolved.resolvedCommit,
  buildVariables: input.buildVariables,
});
```

Documented design constraints:

- `CONTEXT.md:202` says the v1 artifact identity is a fingerprint over resolved commit and exact env/tenant/build-variable values, and build-variable source is a Phase 0 confirmation kept out of core.
- `docs/implementation-plan.md:119` includes frontend build-time variable names and artifact build-config identity among project config facts.
- `docs/implementation-plan.md:123-130` says architectural invariants should live in code/tests rather than broad config switches.

Repo conventions to follow:

- Validate operational config strictly.
- Keep core dependency-injected and testable.
- Do not add real S3/build adapter behavior in this plan.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused frontend tests | `npm test -- test/frontend.test.ts` | exit 0; frontend tests pass |
| Config tests, if changed | `npm test -- test/config.test.ts` | exit 0; config tests pass |
| Full tests | `npm test` | exit 0; all tests pass |
| Typecheck | `npm run typecheck` | exit 0; no TypeScript errors |

## Scope

**In scope**:

- `src/core/frontend.ts`
- `test/frontend.test.ts`
- `src/core/config.ts` only if adding validation for identity input names
- `test/config.test.ts` only if `src/core/config.ts` changes
- `plans/README.md` status row only

**Out of scope**:

- Implementing the real build-variable source.
- Implementing frontend builder, S3 artifact, or sync adapters.
- Changing `deployctl.config.yml` values unless tests prove current values are invalid.
- Adding environment-variable loading to core.

## Git workflow

- Do not push, commit, or open a PR unless explicitly requested.
- Keep source changes focused on core validation and tests.
- Existing commit style is short imperative subject lines, e.g. `Add Phase 7 frontend deploy orchestration`.

## Steps

### Step 1: Add tests for required identity inputs

In `test/frontend.test.ts`, add tests around `deployFrontend(...)` or a new exported helper if you introduce one.

Required cases:

1. If `config.build.frontend.buildConfigIdentityInputs` contains `VITE_TENANT` and `VITE_ENVIRONMENT`, and `input.buildVariables` omits one, `deployFrontend(...)` rejects with `DeployctlError` naming the missing input.
2. When `input.buildVariables` contains extra keys that are not in `buildConfigIdentityInputs`, the artifact fingerprint ignores those extras. Two deploys/key calculations that differ only by an extra non-identity variable should produce the same fingerprint.
3. Existing test `frontendArtifactKey changes when any build variable value differs` should remain true for variables intentionally passed into the key helper, or be adjusted so it tests the lower-level helper separately from configured deploy identity selection.

Use existing `baseInput(...)` and `fakes(...)` helpers in `test/frontend.test.ts`.

**Verify**: `npm test -- test/frontend.test.ts` should fail before implementation.

### Step 2: Add a core helper to select identity build variables

In `src/core/frontend.ts`, add a small helper, exported if useful for direct testing:

```ts
export function frontendIdentityBuildVariables(
  buildVariables: Record<string, string>,
  identityInputs: string[],
): Record<string, string> { /* ... */ }
```

Behavior:

- For each configured identity input, require `buildVariables[name]` to be a non-empty string.
- Return a new object containing only the configured identity input names and their values.
- Throw `DeployctlError` with a clear message if any required input is missing or empty.
- Do not mutate the caller's object.

Then in `deployFrontend(...)`, compute:

```ts
const identityBuildVariables = frontendIdentityBuildVariables(
  input.buildVariables,
  input.config.build.frontend.buildConfigIdentityInputs,
);
```

Pass `identityBuildVariables` to `frontendArtifactKey(...)` so artifact identity is driven by config. Keep passing the full `input.buildVariables` to `builder.build(...)`, because non-identity variables may still be needed by the build command; they just should not affect reuse identity unless configured.

**Verify**: `npm test -- test/frontend.test.ts` exits 0.

### Step 3: Optionally validate identity input names in config

If current config validation accepts empty strings, it already rejects them through `stringArray`. If you add stricter validation, keep it simple:

- Names should be non-empty strings.
- Do not enforce a specific `VITE_` prefix unless the project has documented that as a hard rule.
- If you change `src/core/config.ts`, add/update `test/config.test.ts` accordingly.

**Verify** if config changed: `npm test -- test/config.test.ts` exits 0.

### Step 4: Run full verification

**Verify**:

- `npm test` exits 0.
- `npm run typecheck` exits 0.

## Test plan

Add frontend tests for:

- Missing configured identity input rejects before artifact build/sync.
- Extra non-identity build variable does not alter the configured artifact key.
- Existing deterministic and changed-identity tests still pass.

## Done criteria

All must hold:

- [ ] `deployFrontend(...)` rejects missing/empty configured `buildConfigIdentityInputs`.
- [ ] Artifact identity uses only configured identity inputs, plus env/tenant/resolved commit already included by `frontendArtifactKey(...)`.
- [ ] The builder still receives full `input.buildVariables`.
- [ ] `npm test -- test/frontend.test.ts` exits 0.
- [ ] `npm test` exits 0.
- [ ] `npm run typecheck` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 004 is updated.

## STOP conditions

Stop and report if:

- The config no longer has `build.frontend.buildConfigIdentityInputs`.
- The real frontend build adapter already exists and has a conflicting identity strategy.
- The fix appears to require deciding the Phase 0 source of build variables.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

When the real build-variable source is implemented, reviewers should verify every variable that can change generated static assets is listed in `buildConfigIdentityInputs`. Variables that do not affect bundle contents can be passed to the builder without entering artifact identity.
