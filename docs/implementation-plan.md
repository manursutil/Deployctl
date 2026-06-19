# Implementation Plan

This document tracks implementation phases for `deployctl` based on `docs/initial-architecture-proposal.md`.

Status legend:

- `Not started`: no implementation work yet.
- `In progress`: implementation has started but the phase is incomplete.
- `Blocked`: waiting on a decision or external dependency.
- `Done`: implemented and verified.

## Phase 0: Discovery And Decisions

Status: `Not started`

Goal: confirm infrastructure assumptions before concrete AWS-facing implementation.

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
- Decide DynamoDB locks vs S3 lock fallback.
- Choose deploy history and artifact S3 buckets or prefixes.
- Define least-privilege IAM requirements.

## Phase 1: CLI Foundation

Status: `In progress`

Goal: create a safe TypeScript CLI scaffold with no AWS side effects.

Completed:

- Added npm package scaffold.
- Added TypeScript configuration.
- Added minimal CLI entrypoint at `src/cli.ts`.
- Added one public CLI behavior test for `--help`.
- Added verified commands to `CONTEXT.md`.

Remaining:

- Add command parser structure when the next public behavior is chosen.
- Add shared output and error conventions.
- Add thin command handlers that fail clearly until implemented.
- Keep implementation behind stable interfaces where Phase 0 decisions are still open.

Verified commands:

```bash
npm test
npm run typecheck
node --import tsx src/cli.ts --help
```

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

## Phase 5: Deployment Locks

Status: `Blocked`

Blocked by: DynamoDB vs S3 lock decision from Phase 0.

Goal: prevent concurrent deploys or rollbacks for the same `<env>/<tenant>/<app>` target.

Tasks:

- Define lock interface.
- Implement DynamoDB conditional-write lock, or approved S3 fallback.
- Add lock expiry metadata.
- Add stale lock reporting.
- Implement `locks list` and `locks unlock`.

## Deploy Prerequisites

Backend and frontend deploy commands must not ship until these shared foundations are implemented and wired into the deploy flow:

- Tenant registry loading and validation.
- Git ref resolution to an immutable full commit SHA.
- Deploy history and current-state writes.
- Deployment locks for `<env>/<tenant>/<app>`.
- Clear failure behavior for validation, lock acquisition, deploy execution, and history updates.

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

Status: `In progress`

Goal: grow tests vertically with implementation, avoiding broad speculative test suites.

Current test coverage:

- CLI help output through public CLI process invocation.

Future validation areas:

- Tenant config behavior.
- Ref resolution rules.
- History behavior.
- Lock behavior.
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
- `docs/review-questions.md`
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
