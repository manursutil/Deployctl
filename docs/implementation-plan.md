# Implementation Plan

This document tracks implementation phases for `deployctl` based on `docs/initial-architecture-proposal.md`.

## Target Repo Structure

Target layout (aspirational — no code exists yet; the repo currently contains only `docs/`, `AGENTS.md`, and `CONTEXT.md`). Files are flat to start; split a module into a folder only when it grows. The load-bearing split is `commands/` (and later `dashboard/`) as thin controllers over a shared `core/` library, with AWS access isolated in `adapters/` so `core/` stays unit-testable. This is what lets the dashboard be a second thin caller of the same modules rather than a fork (proposal §6/6a).

```
src/
  cli.ts                # entry: arg parsing -> dispatch to commands/   (Phase 1)
  commands/             # thin CLI controllers, one per command
    tenants.ts          #   deployctl tenants list                     (Phase 2)
    deploy.ts           #   deployctl deploy backend|frontend          (Phases 6-7)
    rollback.ts         #   deployctl rollback                         (Phase 8)
    status.ts           #   deployctl status                           (Phase 9)
    logs.ts             #   deployctl logs                             (Phase 9)
    reconcile.ts        #   deployctl reconcile backend                (Phase 10)
    cleanup.ts          #   deployctl cleanup                          (Phase 11)
  core/                 # orchestration modules — the shared library
    tenants.ts          #   load + validate tenants.yml                (Phase 2)
    refs.ts             #   git ref -> immutable commit SHA            (Phase 3)
    history.ts          #   deploy events + current.json               (Phase 4)
    guardrail.ts        #   inProgress/since check + set               (Phase 5)
    deploy.ts           #   backend + frontend orchestration           (Phases 6-7)
    rollback.ts         #   version selection + redeploy               (Phase 8)
    diagnostics.ts      #   status + logs queries                      (Phase 9)
    cleanup.ts          #   retention logic                            (Phase 11)
  adapters/             # thin wrappers over AWS SDK + git (mockable in tests)
    ssm.ts  s3.ts  secrets.ts  cloudwatch.ts  git.ts
  shared.ts             # output formatting, errors, config types
scripts/
  ec2/                  # server-local shell run via SSM (proposal §7)
dashboard/              # later — Phase 15, second controller over core/
test/                   # mirrors src/, public-behavior-first
tenants.yml             # tenant registry config                       (Phase 2)
```

Status legend:

- `Not started`: no implementation work yet.
- `In progress`: implementation has started but the phase is incomplete.
- `Blocked`: waiting on a decision or external dependency.
- `Done`: implemented and verified.

Each phase is `Done` only when its public behavior (a CLI command or module contract) has a passing test and `npm test` plus `npm run typecheck` run clean. Phases that expose a public command carry a `Done when:` line stating the exact observable behavior to verify; phases whose command surface is not yet decided add theirs once it is.

## Phase Dependencies

High-level order (details in each phase):

- Phase 0 (discovery) precedes all AWS-facing work.
- Phases 2-5 (tenant registry, ref resolution, deploy history/current-state, the guardrail) are shared foundations — see "Deploy Prerequisites" — and must land before Phases 6-7 (backend/frontend deploy).
- Phase 5 (guardrail) builds on the Phase 4 current-state schema.
- Phase 8 (rollback) depends on Phases 4, 6, 7.
- Phase 10 (ASG reconciliation) is blocked on Phase 0 ASG-bootstrap discovery.
- Phase 15 (dashboard) requires Phases 2-9 done; it calls the same modules.

## Phase 0: Discovery And Decisions

Status: `Not started`

Goal: confirm infrastructure assumptions before concrete AWS-facing implementation.

Record each confirmed answer in `CONTEXT.md` (and update the relevant section of `docs/initial-architecture-proposal.md` when an answer changes a documented assumption). A task is not "confirmed" until its answer is written down there.

Tasks:

- Confirm existing EC2 filesystem layout.
- Confirm PM2 process naming and tenant process model.
- Confirm CloudWatch log group and stream naming.
- Confirm Secrets Manager naming conventions.
- Confirm production ASG bootstrap behavior for replacement instances.
- Confirm how `deployctl` accesses the application repository for ref resolution and builds.
- Confirm authoritative backend and frontend package managers and build commands.
- Confirm whether backend native dependencies must be installed and built on EC2.
- Confirm frontend build and runtime config model.
- Note: concurrency is handled by an `inProgress` field on `current.json`, not DynamoDB or S3 locks (decided; see Phase 5).
- Choose deploy history and artifact S3 buckets or prefixes.
- Define least-privilege IAM requirements.

## Phase 1: CLI Foundation

Status: `Not started`

Goal: create a safe TypeScript CLI scaffold with no AWS side effects, starting from an empty repo (only `docs/`, `AGENTS.md`, and `CONTEXT.md` exist).

Tasks:

- Add npm package scaffold and TypeScript configuration.
- Add a minimal CLI entrypoint at `src/cli.ts`.
- Add one public CLI behavior test (for example `--help`).
- Add command parser structure when the next public behavior is chosen.
- Add shared output and error conventions.
- Add thin command handlers that fail clearly until implemented.
- Keep implementation behind stable interfaces where Phase 0 decisions are still open.
- Record verified commands (test, typecheck, CLI invocation) in `CONTEXT.md`.

Done when: `npm test` and `npm run typecheck` run clean and `deployctl --help` prints usage, covered by a test.

## Phase 2: Tenant Registry

Status: `Not started`

Goal: load and validate `tenants.yml` without exposing or storing secret values.

Tasks:

- Define initial `tenants.yml` schema.
- Parse YAML config.
- Validate environments and tenants.
- Validate required resource references.
- Reject likely secret values in config.
- Implement `deployctl tenants list --env <env>`.

Done when: `deployctl tenants list --env staging` prints the configured tenants for a valid config, and exits non-zero with a clear message on an invalid or missing config, both covered by a test.

## Phase 3: Git Ref Resolution

Status: `Not started`

Goal: resolve branch, tag, or SHA input into an immutable full commit SHA before deploy work.

Tasks:

- Resolve refs from the application repository.
- Allow branch/tag/SHA for staging.
- Reject moving branches for production.
- Store both requested ref and resolved commit in deploy metadata.

## Phase 4: Deploy History And Current State

Status: `Not started`

Goal: store deploy audit events and current desired state in S3 JSON records.

Tasks:

- Define deploy event schema.
- Define rollback event schema.
- Define current-state schema.
- Write append-only event records.
- Read and update `current.json`.
- Support previous-version lookup for rollback.

## Phase 5: Deployment Guardrail

Status: `Not started`

Goal: prevent concurrent deploys or rollbacks for the same `<env>/<tenant>/<app>` target.

Decision: no DynamoDB and no S3 lock objects. Use a lightweight `inProgress`/`since` field on the `current.json` current-state record from Phase 4, checked and set by the orchestration module before starting a deploy or rollback. This is visible to any caller of the orchestration module (CLI or future dashboard), scoped per `<env>/<tenant>/<app>`. See `docs/initial-architecture-proposal.md` section 6a.

Tasks:

- Add `inProgress`/`since` fields to the current-state schema (Phase 4).
- Check and set the guardrail at the start of deploy/rollback orchestration; clear it on completion or failure.
- Surface a clear "deploy already in progress" error when blocked.
- Document that this narrows the DynamoDB/S3 lock design in the architecture proposal section 22, given a single-user dashboard as the primary caller.

## Deploy Prerequisites

Backend and frontend deploy commands (Phases 6-7) must not ship until the shared foundations of Phases 2-5 are implemented and wired into the deploy flow: tenant registry, ref resolution, deploy history/current-state, and the `inProgress` guardrail. In addition, the deploy flow must fail clearly and leave no partial state on any of: config validation, guardrail conflict, deploy execution, or history update.

## Phase 6: Backend Deploy

Status: `Not started`

Goal: deploy backend releases through AWS SSM to staging EC2 or production ASG instances.

Tasks:

- Write EC2-local backend deploy script.
- Prepare `/opt/sherwood/releases/<commit>`.
- Install dependencies and build once per release.
- Generate protected tenant env file from Secrets Manager values on EC2.
- Update tenant `current` symlink.
- Restart only selected tenant PM2 processes.
- Run backend health check.
- Record success, failure, and partial production failure.

## Phase 7: Frontend Artifact And Deploy

Status: `Not started`

Goal: build or reuse commit-based frontend artifacts and sync them to tenant S3 buckets.

Tasks:

- Define artifact storage layout.
- Check whether artifact exists for a commit.
- Build and store missing artifacts.
- Sync artifact files to tenant frontend bucket.
- Apply explicit cache headers.
- Write tenant runtime config if needed.
- Run frontend smoke check.

## Phase 8: Rollback

Status: `Not started`

Goal: rollback backend or frontend for one tenant to a previous known version.

Tasks:

- Implement backend rollback to older release directory.
- Prepare missing backend release when needed.
- Implement frontend rollback by redeploying old artifact.
- Record rollback events.
- Update current state after successful rollback.

## Phase 9: Logs And Diagnostics

Status: `Not started`

Goal: expose operational status and CloudWatch logs through the CLI.

Tasks:

- Implement `deployctl status`.
- Implement `deployctl logs` from CloudWatch Logs.
- Filter logs by environment, tenant, service, and time range.
- Show SSM command IDs and per-instance results where relevant.

Done when: `deployctl status` reports current state per `<env>/<tenant>/<app>` and `deployctl logs` returns filtered CloudWatch entries for a given env/tenant/service, both covered by a test (live AWS calls mocked).

## Phase 10: ASG Replacement And Reconciliation

Status: `Blocked`

Blocked by: production ASG bootstrap discovery from Phase 0.

Goal: ensure replacement production instances can match recorded tenant backend state.

Tasks:

- Document existing bootstrap behavior if it already restores state.
- Otherwise implement `deployctl reconcile backend --env production` or a manual recovery procedure.
- Compare healthy ASG instances against current desired state.

## Phase 11: Cleanup And Retention

Status: `Not started`

Goal: provide explicit cleanup for old backend releases and frontend artifacts.

Tasks:

- Keep current versions.
- Keep last 10 successful versions per tenant/app.
- Keep anything deployed in the last 30 days.
- Add dry-run cleanup commands before any destructive cleanup.

## Phase 12: Bitbucket Pipeline Integration

Status: `Not started`

Goal: expose safe pipeline entry points for deploys and rollbacks.

Tasks:

- Add staging deploy pipelines.
- Add production deploy pipelines with stricter ref rules.
- Add manual rollback pipelines.
- Configure AWS auth safely.

## Phase 13: Testing And Validation

Status: `Not started`

Goal: grow tests vertically with implementation, avoiding broad speculative test suites.

Future validation areas:

- Tenant config behavior.
- Ref resolution rules.
- History behavior.
- Guardrail (`inProgress`) behavior.
- Backend deploy failure handling.
- Frontend cache header behavior.
- Rollback version selection.

## Phase 14: Documentation And Handoff

Status: `In progress`

Goal: keep operator and developer documentation current as implementation evolves.

Current docs:

- `AGENTS.md`
- `docs/initial-architecture-proposal.md`
- `docs/multi-tenant-deployment-explainer.md`
- `docs/implementation-plan.md`
- `CONTEXT.md`

Completed:

- Added agent guidance requiring `docs/implementation-plan.md` to be updated with implementation progress.
- Added PR-sized work guidance for features, bug fixes, behavior changes, and operational changes.

Future docs:

- Deploy runbook.
- Rollback runbook.
- Troubleshooting guide.
- Tenant config update guide.
- Security and IAM notes.

## Phase 15: Web Dashboard

Status: `Not started`

Blocked by: Phases 2-9 (tenant registry, ref resolution, deploy history/current-state including the Phase 5 guardrail, backend deploy, frontend deploy, rollback, status/logs) must be `Done` first. The dashboard imports the same orchestration modules; it has nothing to call until they exist.

Goal: confirmed requirement from the project owner for a web dashboard with deploy actions and visibility, scoped for a single user (the project owner) initially but built with guardrails suitable for later multi-user access. See `docs/initial-architecture-proposal.md` section 6a.

Decisions already made:

- Architecture: the dashboard imports the same TypeScript orchestration modules the CLI uses. It is not a wrapper around the `deployctl` binary.
- Lives in the same repository as `deployctl`.
- v1 scope: backend deploy, frontend deploy, status. Rollback and logs are deferred to a later phase.
- Concurrency guardrail: reuses the Phase 5 `inProgress` field, no new lock infrastructure.
- Auth: basic auth or a shared secret from Secrets Manager. Not Google SSO.
- Audit: every dashboard-triggered deploy is recorded in deploy history with `deployedBy` set to the authenticated identity.
- Tech stack: a small server-rendered TypeScript app (for example Express/Fastify with EJS or htmx), not a full SPA framework or Next.js.

Open items to confirm before/during this phase:

- Network restriction mechanism: possibly Google Identity-Aware Proxy (IAP), mentioned but not confirmed; IP-allowlisted security group is the fallback.
- Hosting target: likely a small dedicated instance separate from the tenant-serving ASG/EC2 instances, not yet confirmed.

Tasks:

- Confirm open items above.
- Scaffold a minimal server-rendered app in the same repo, importing orchestration modules directly.
- Implement backend/frontend deploy actions calling the same modules as the CLI.
- Implement status view reading `current.json`.
- Wire the Phase 5 `inProgress` guardrail into the dashboard's deploy flow with a clear "already in progress" UI state.
- Implement basic auth/shared secret and apply the chosen network restriction.
- Record authenticated identity into deploy history on every dashboard-triggered action.
