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
deployctl.config.yml    # project/infra/build config                     (Phase 1)
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

## AWS Connectivity

This section is reference context, not a phase. It describes how `deployctl` reaches AWS, so the phases below can assume it.

`deployctl` connects to AWS purely through each service's HTTPS API, using the AWS SDK (isolated in `adapters/`). There is no SSH, VPN, or tunnel. Every request is signed with least-privilege IAM credentials that come from wherever the tool runs (a Bitbucket pipeline or an operator machine).

Use AWS SDK for JavaScript v3 (modular `@aws-sdk/client-*` packages); credentials resolve from the standard environment/role chain. The region should be read from validated project config once confirmed.

There are two distinct connections to AWS — a "two-hop" model:

- Hop A — `deployctl` -> AWS APIs (control plane). The tool only ever calls AWS APIs. For a backend deploy it does not reach the server directly; it calls the SSM API to run the deploy script on the target EC2/ASG instances. This is why operators need no SSH keys — only permission to call SSM. `deployctl` also calls S3 (frontend sync, deploy history/current-state) and CloudWatch Logs (reads) over the same path.
- Hop B — the EC2 server -> AWS APIs. Once the deploy script runs on the server, the server makes its own AWS calls using its EC2 instance role, not the operator's credentials. The key case is secrets: `deployctl` passes only the secret name; the server reads the value from Secrets Manager at the last moment, so secret values never pass through the tool, pipeline logs, or an operator screen.

| Action | AWS service / API | Caller |
| --- | --- | --- |
| Run the backend deploy on servers | SSM Run Command | `deployctl` (Hop A) |
| Read a tenant's secrets | Secrets Manager | EC2 server (Hop B) |
| Sync frontend files to the tenant bucket | S3 | `deployctl` (Hop A) |
| Store deploy history and current state | S3 | `deployctl` (Hop A) |
| Read application logs | CloudWatch Logs | `deployctl` (Hop A) |

Two connections here are not AWS APIs: ref resolution (Phase 3) talks to Git/Bitbucket, and the frontend is served through Cloudflare, which a normal deploy does not change. Defining the exact least-privilege IAM for both hops is a Phase 0 task; `deployctl`'s IAM covers Hop A, and the EC2 instance role covers Hop B.

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
- Confirm how `deployctl` accesses the application repository for ref resolution and builds, then record it in `deployctl.config.yml`.
- Confirm authoritative backend and frontend package managers and build commands, then record them in `deployctl.config.yml`.
- Confirm whether backend native dependencies must be installed and built on EC2.
- Confirm exact frontend build variables and how tenant/env values are supplied to the build command, then record the allowed variables/config identity inputs in `deployctl.config.yml`. Decision for v1: keep the current build-time variable model rather than introducing runtime config.
- Note: concurrency is handled by an `inProgress` field on `current.json`, not DynamoDB or S3 locks (decided; see Phase 5).
- Choose deploy history and artifact S3 buckets or prefixes, then record them in `deployctl.config.yml`.
- Define least-privilege IAM requirements.

## Project Configuration

`deployctl` should use a declarative YAML project config, `deployctl.config.yml`, for environment-dependent facts that let the implementation progress without hard-coding unconfirmed infrastructure details. The file is operational data, not executable code: parse YAML, validate it against a strict schema, and expose a typed `DeployctlConfig` object internally.

Use `deployctl.config.yml` for configurable facts such as:

- AWS region.
- Application repository URL/path.
- Backend and frontend package managers and build commands.
- Deploy history and artifact S3 bucket/prefix locations.
- Ref policy per environment, such as whether moving branch refs are allowed.
- SSM target selection strategy once confirmed.
- CloudWatch log group and stream patterns once confirmed.
- Frontend build-time variable names and artifact build-config identity.
- Cleanup retention settings.
- Later dashboard auth, hosting, and network restriction settings.

Keep architectural invariants in code and tests, not as broad config switches:

- Backend releases are immutable commit-keyed release directories with tenant `current` symlinks.
- Deploys resolve refs to immutable full commit SHAs before deploy work.
- Production does not accept moving branch refs.
- Secret values never pass through `deployctl`; only secret references do.
- The `current.json.inProgress` guardrail is the concurrency mechanism.
- CLI commands and the future dashboard call the same orchestration modules.

`tenants.yml` remains separate from `deployctl.config.yml`: `tenants.yml` maps environments and tenants to tenant-specific resource references, process names, and URLs; `deployctl.config.yml` describes project-wide infrastructure, build, storage, and policy settings.

## Phase 1: CLI Foundation

Status: `Done`

Goal: create a safe TypeScript CLI scaffold with no AWS side effects, starting from an empty repo (only `docs/`, `AGENTS.md`, and `CONTEXT.md` exist).

Tasks:

- [x] Add npm package scaffold and TypeScript configuration.
- [x] Add a minimal CLI entrypoint at `src/cli.ts`.
- [x] Add `deployctl.config.yml` schema/types and a loader that validates YAML into a typed config object without AWS side effects.
- [x] Add one public CLI behavior test (for example `--help`).
- [x] Add command parser structure when the next public behavior is chosen.
- [x] Add shared output and error conventions.
- [x] Add thin command handlers that fail clearly until implemented.
- [x] Keep implementation behind stable interfaces where Phase 0 decisions are still open.
- [x] Record verified commands (test, typecheck, CLI invocation) in `CONTEXT.md`.

Completed:

- Added a TypeScript ESM npm scaffold with Node's built-in test runner through `node --import tsx --test`.
- Added `src/cli.ts` with a public `runCli(argv, io)` entrypoint, `--help`, `config check`, and clear non-implemented command failures.
- Added `src/core/config.ts` with `loadDeployctlConfig(path)` and strict YAML validation into `DeployctlConfig`.
- Added tests for public CLI help behavior and config loading/validation.
- Added initial `deployctl.config.yml` with placeholder operational values to keep Phase 0 decisions explicit and editable.

Done when: `npm test` and `npm run typecheck` run clean, `deployctl --help` prints usage, and `deployctl.config.yml` loading/validation is covered by tests without making AWS calls.

## Phase 2: Tenant Registry

Status: `Done`

Goal: load and validate `tenants.yml` without exposing or storing secret values.

Tasks:

- [x] Define initial `tenants.yml` schema.
- [x] Parse YAML config.
- [x] Validate environments and tenants.
- [x] Validate required resource references.
- [x] Reject likely secret values in config.
- [x] Implement `deployctl tenants list --env <env>`.

Completed:

- Added `src/core/tenants.ts` with `loadTenantRegistry(path)`, `parseTenantRegistry(value)`, and `listTenants(registry, environment)`.
- Added initial `tenants.yml` with resource references only; no secret values.
- Added `deployctl tenants list --env <env> [--tenants <path>]`.
- Added tests for listing tenants, missing config, required tenant resource references, and likely secret value rejection.

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
- Generate protected tenant env file from Secrets Manager values on EC2. The Secrets Manager read happens inside the `scripts/ec2/` server-side script (Hop B), not in `core/`; the TypeScript side passes only the secret name, never the value.
- Update tenant `current` symlink.
- Restart only selected tenant PM2 processes.
- Run backend health check.
- Record success, failure, and partial production failure.

## Phase 7: Frontend Artifact And Deploy

Status: `Not started`

Goal: build or reuse tenant/env-specific frontend artifacts and sync them to tenant S3 buckets.

Decision: v1 keeps the current frontend model where tenant/environment variables are baked into the static bundle at build time. Runtime config would be cleaner for artifact reuse, but it would require changing all frontend clients before `deployctl` can ship. Therefore v1 artifacts must be keyed by resolved commit plus tenant/environment or a build-config fingerprint, not by commit SHA alone.

Tasks:

- Define artifact storage layout.
- Include tenant/environment/build-config identity in the artifact key so one tenant's build cannot be reused for another tenant by accident.
- Check whether artifact exists for the resolved commit and exact tenant/env build config.
- Build and store missing artifacts using the tenant/env build-time variables from config.
- Sync artifact files to tenant frontend bucket.
- Apply explicit cache headers.
- Do not introduce runtime config in v1; record it as a future improvement once the frontend can read a public config file at startup.
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
- `docs/implementation-plan-detailed.md`
- `docs/presentation-qa.md`
- `CONTEXT.md`

Completed:

- Added agent guidance requiring `docs/implementation-plan.md` to be updated with implementation progress.
- Added PR-sized work guidance for features, bug fixes, behavior changes, and operational changes.
- Added presentation Q&A covering architecture, scope, security, failure modes, rollback, observability, and known Phase 0 gaps.

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
