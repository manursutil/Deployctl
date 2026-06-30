# Plan 003: Verify direct commit SHA refs against the configured repository

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a001b1b..HEAD -- src/adapters/git.ts src/core/refs.ts test/refs.test.ts test/git.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S/M
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a001b1b`, 2026-06-30

## Why this matters

Deploys must resolve refs to immutable full commit SHAs before work starts, and production rejects moving branch refs. Today a user-provided full 40-character SHA is accepted by `GitCliRefResolver` without querying the configured application repository. That means a typo, stale SHA, or SHA from a different repository can be reported as resolved until a later build/deploy step fails less clearly. Ref resolution should prove that the selected commit exists in the configured repository.

## Current state

Relevant files:

- `src/adapters/git.ts` — Git CLI adapter using `git ls-remote`.
- `src/core/refs.ts` — environment policy checks over the `RefResolver` seam.
- `test/refs.test.ts` — core ref policy tests with a fake resolver.
- `test/git.test.ts` — create this file if no adapter tests exist.

Current direct-SHA shortcut:

```ts
// src/adapters/git.ts:9-16
export class GitCliRefResolver implements RefResolver {
  async resolve(input: { repositoryUrl: string; ref: string }): Promise<ResolvedGitRef> {
    if (fullCommitShaPattern.test(input.ref)) {
      return { kind: "commit", commitSha: input.ref.toLowerCase() };
    }

    const refs = await lsRemote(input.repositoryUrl, input.ref);
```

Current `git ls-remote` call for non-full refs:

```ts
// src/adapters/git.ts:26-30
const { stdout } = await execFileAsync("git", ["ls-remote", repositoryUrl, ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`], {
  encoding: "utf8",
});
```

Documented design constraints:

- `docs/implementation-plan.md:125-127` says backend releases are immutable commit-keyed directories, deploys resolve refs to immutable full commit SHAs before deploy work, and production does not accept moving branch refs.
- `CONTEXT.md:197` says callers should use `resolveDeploymentRef(input)`, core enforces environment ref policy, and Git access stays behind the `RefResolver` adapter interface.

Repo conventions to follow:

- Keep Git access in `src/adapters/git.ts`, behind `RefResolver`.
- Keep policy in `src/core/refs.ts`; do not put production/staging policy inside the Git adapter.
- Use Node's built-in test runner.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused ref tests | `npm test -- test/refs.test.ts test/git.test.ts` | exit 0; ref and git adapter tests pass |
| Full tests | `npm test` | exit 0; all tests pass |
| Typecheck | `npm run typecheck` | exit 0; no TypeScript errors |

If `test/git.test.ts` does not exist before this plan, create it and run `npm test -- test/git.test.ts` instead of including a missing file in the focused command until created.

## Scope

**In scope**:

- `src/adapters/git.ts`
- `src/core/refs.ts` only if the `RefResolver` type needs a small extension
- `test/git.test.ts` (create)
- `test/refs.test.ts` only if a type signature change requires fake resolver updates
- `plans/README.md` status row only

**Out of scope**:

- Changing production branch/tag policy.
- Changing CLI argument parsing.
- Adding network integration tests against a real remote repository.
- Replacing `git ls-remote` with another Git library.

## Git workflow

- Do not push, commit, or open a PR unless explicitly requested.
- Keep source changes constrained to the Git adapter/ref seam.
- Existing commit style is short imperative subject lines, e.g. `Add Phase 3 ref resolution`.

## Steps

### Step 1: Add an injectable command runner seam for Git adapter tests

`GitCliRefResolver` currently closes over promisified `execFile`, which makes adapter tests hard without invoking real Git. Add a small constructor dependency with a default implementation. Example shape:

```ts
type GitCommandRunner = (args: string[]) => Promise<string>;

export class GitCliRefResolver implements RefResolver {
  constructor(private readonly runGit: GitCommandRunner = defaultRunGit) {}
  // ...
}
```

`defaultRunGit(args)` should call `execFileAsync("git", args, { encoding: "utf8" })` and return `stdout`.

Keep using `execFile`, not shell execution.

**Verify**: `npm run typecheck` exits 0 after tests/fakes are updated.

### Step 2: Add tests for direct full-SHA behavior

Create `test/git.test.ts`. Use the injected runner so tests do not call real Git.

Add a regression test for a full 40-character SHA:

- Given `ref` is `0123456789abcdef0123456789abcdef01234567`.
- Fake runner should record the args it receives and return output proving the commit exists. A practical `git ls-remote` pattern for direct SHA verification is to query all refs or a safe subset and look for an exact matching object ID.
- Assert resolver returns `{ kind: "commit", commitSha: <lowercase sha> }` only when the fake output contains that SHA.
- Add a negative test where output does not contain the SHA and assert `DeployctlError` is thrown.

Do not rely on real network or local Git state.

**Verify**: `npm test -- test/git.test.ts` should fail until the adapter no longer returns before invoking the runner for full SHAs.

### Step 3: Remove the unconditional direct-SHA shortcut

In `src/adapters/git.ts`, change full-SHA handling so it verifies repository membership. Acceptable implementation options:

Option A, safest/simple for now:

- For full SHAs, call `git ls-remote <repositoryUrl>` with no ref filters.
- Parse lines with `parseLsRemoteLine`.
- If any parsed `commitSha` exactly equals the requested SHA, return `{ kind: "commit", commitSha }`.
- Otherwise throw `DeployctlError("Could not resolve git ref ...")` or a clearer message.

Option B, if you know a more efficient `git ls-remote` invocation that proves object existence remotely without fetching and works for Bitbucket, use it, but keep tests runner-injected and deterministic.

Keep non-full ref behavior equivalent: prefer tag, then branch, then abbreviated commit prefix from returned refs.

**Verify**: `npm test -- test/git.test.ts` exits 0.

### Step 4: Run ref policy and full verification

Run existing core ref tests to ensure production branch policy remains unchanged.

**Verify**:

- `npm test -- test/refs.test.ts test/git.test.ts` exits 0.
- `npm test` exits 0.
- `npm run typecheck` exits 0.

## Test plan

Create `test/git.test.ts` with focused adapter tests for:

- Full SHA is verified by querying the configured repository before returning.
- Full SHA absent from remote refs rejects clearly.
- Tag-vs-branch preference remains tag first if both are returned.
- Malformed `ls-remote` output still rejects clearly.

Use `test/refs.test.ts` style: `node:test`, `node:assert/strict`, `DeployctlError` predicate assertions.

## Done criteria

All must hold:

- [ ] `GitCliRefResolver` no longer accepts a full SHA without querying the configured repository.
- [ ] Adapter tests do not call real Git or network.
- [ ] Existing `resolveDeploymentRef` production branch policy still passes.
- [ ] `npm test -- test/refs.test.ts test/git.test.ts` exits 0.
- [ ] `npm test` exits 0.
- [ ] `npm run typecheck` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 003 is updated.

## STOP conditions

Stop and report if:

- Bitbucket/Git remote behavior cannot verify arbitrary SHA membership with `git ls-remote` without fetching the repository.
- A robust fix appears to require adding a new Git fetch/cache subsystem.
- The `RefResolver` interface has already changed substantially from the excerpts.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

This plan improves early validation, not authorization. Production should still reject moving branch refs in `src/core/refs.ts`. If future requirements allow deploying commits not referenced by any remote branch/tag, this plan may need revision because `git ls-remote` only sees advertised refs.
