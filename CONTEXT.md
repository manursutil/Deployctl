# CONTEXT.md

This repository now has a TypeScript CLI scaffold, tenant registry loading, docs, and agent guidance. There is no deploy implementation, migrations, remote script, or pipeline configuration yet.

Use this file as the short project context for future work. Treat architecture details below as the current proposed direction from `docs/initial-architecture-proposal.md`, not as verified runtime behavior.

When new implementation phases land, update this file in the same change set with the actual source layout, commands, domain model, and conventions that are introduced.

## Project Purpose

`deployctl` is intended to be a CLI-first deployment automation tool for a multi-tenant application.

The goal is to deploy backend and frontend versions independently per tenant without duplicating the full repository or creating separate infrastructure stacks per tenant.

Version 1 is scoped to deployment automation on top of existing AWS infrastructure. It should not provision tenant infrastructure.

## Current Repository State

Implemented code: Phase 1 CLI foundation, Phase 2 tenant registry, Phase 3 git ref resolution, and Phase 4 deploy history/current-state schemas.

Current files:

- `AGENTS.md`: agent guidance for working in this repo.
- `CONTEXT.md`: this file, optimized as quick context for coding agents.
- `docs/initial-architecture-proposal.md`: primary architecture proposal and decisions.
- `docs/implementation-plan.md`: phased implementation tracker and current phase status.
- `docs/phase-0-checklist.md`: working checklist of Phase 0 infrastructure confirmations, grouped by the AWS adapter each answer unblocks.
- `docs/multi-tenant-deployment-explainer.md`: beginner-friendly explanation of the no-Docker deployment model.
- `package.json`, `package-lock.json`, `tsconfig.json`: TypeScript CLI package scaffold.
- `deployctl.config.yml`: initial project config with placeholder operational values.
- `src/cli.ts`: public CLI entrypoint and command dispatch.
- `src/core/config.ts`: YAML config loader and strict validator.
- `src/core/tenants.ts`: `tenants.yml` loader, strict validator, secret-value guard, and tenant listing.
- `src/core/refs.ts`: deployment ref resolution policy that returns immutable commit metadata.
- `src/core/history.ts`: deploy/rollback event schemas (including the frontend `artifactStorageKey`), current-state schema, repository seam, in-memory repository, event/rollback builders, and previous-version lookup.
- `src/core/deploy.ts`: backend deploy orchestration (`deployBackend`) over the `SsmDeployExecutor` seam; wires tenant lookup, ref resolution, the `inProgress` guardrail, and deploy history.
- `src/core/frontend.ts`: frontend artifact identity (`frontendArtifactKey`/`frontendArtifactStorageKey`) and deploy orchestration (`deployFrontend`) over the `FrontendArtifactStore`, `FrontendBuilder`, `FrontendSync`, and `FrontendSmokeCheck` seams.
- `src/core/rollback.ts`: backend/frontend rollback orchestration (`rollbackBackend`/`rollbackFrontend`) and version selection (`selectRollbackTarget`) over the same history, guardrail, SSM executor, and frontend sync/smoke-check seams.
- `src/core/diagnostics.ts`: status query (`getTenantStatus`) over the `DeployHistoryRepository` seam and CLI rendering (`formatTenantStatus`); reports current state per `<env>/<tenant>/<app>` including the `inProgress` guardrail.
- `src/core/cleanup.ts`: retention decision logic (`planRetention`), candidate derivation from history (`deploymentRetentionCandidates`), and the per-target plan (`planTargetRetention`) over the `DeployHistoryRepository` seam; produces a dry-run keep/delete plan with reasons.
- `src/adapters/git.ts`: Git CLI adapter for resolving refs from the application repository.
- `src/shared.ts`: shared CLI errors, IO, and formatting helpers.
- `tenants.yml`: initial tenant registry with resource references only.
- `test/`: Node test runner tests for public CLI and config behavior.

## Architecture

Proposed version 1 architecture:

```text
Operator or Bitbucket Pipeline
  -> deployctl TypeScript CLI
  -> tenant registry + ref resolution + deploy history
  -> backend or frontend deploy path
```

Backend deploy path:

```text
deployctl
  -> AWS SSM Run Command
  -> staging EC2 or production ASG instances
  -> /opt/sherwood/releases/<commit-sha>
  -> /opt/sherwood/tenants/<tenant>/current symlink
  -> tenant-specific PM2 API and worker processes
  -> health check
  -> deploy history
```

Frontend deploy path:

```text
deployctl
  -> resolve ref to commit SHA
  -> build or reuse frontend artifact for that commit + tenant/env build config
  -> sync static files to tenant S3 frontend bucket
  -> Cloudflare serves tenant domain
  -> smoke check
  -> deploy history
```

Important architectural rules:

- `deployctl` should be a small TypeScript CLI running on Node.js.
- Project-wide infrastructure, build, storage, and policy settings should live in declarative YAML config at `deployctl.config.yml`, parsed and validated into typed TypeScript. Use config for environment-dependent facts, not for replacing core architectural invariants.
- A web dashboard is a confirmed requirement (requested by the project owner), but it is sequenced after the CLI's orchestration modules (tenant registry, ref resolution, history, the `inProgress` guardrail, backend/frontend deploy, rollback, status/logs) are done. See `docs/initial-architecture-proposal.md` section 6a and `docs/implementation-plan.md` Phase 15. Do not start the dashboard before those modules exist and are directly importable.
- The dashboard must call the same orchestration modules as the CLI, not wrap or shell out to the `deployctl` binary.
- Deployment orchestration, validation, AWS SDK calls, history, and user-facing errors belong in TypeScript.
- Shell should be limited to small EC2-local scripts invoked through SSM.
- Backend deploys are commit-based release directories, not a single mutable Git checkout.
- Frontend deploys are static artifacts synced to tenant buckets. In v1, frontend tenant/environment variables are baked in at build time, so artifacts must be keyed by commit plus tenant/env/config identity rather than commit SHA alone.
- Backend and frontend deploy independently.
- Normal deploys should not change Terraform, DNS, Cloudflare routing, tenant onboarding, database provisioning, or migrations.

## Data Flow

Common deploy flow:

1. Operator or Bitbucket Pipeline invokes `deployctl` with tenant, environment, app, and ref.
2. `deployctl` validates inputs against tenant configuration.
3. `deployctl` resolves branch/tag/SHA input to a full commit SHA before doing deployment work.
4. `deployctl` checks and sets the `inProgress` guardrail on `current.json` for `<env>/<tenant>/<app>`.
5. `deployctl` executes the backend or frontend deploy path.
6. `deployctl` runs a health or smoke check.
7. `deployctl` writes append-only deploy history and updates current desired state.
8. `deployctl` clears the `inProgress` guardrail on completion or failure.

Backend-specific flow:

1. Send an SSM command to the target EC2 instance or all healthy production ASG instances.
2. Prepare `/opt/sherwood/releases/<commit-sha>` on each target instance.
3. Install dependencies and build backend output once per release directory.
4. Read tenant secret values from AWS Secrets Manager on EC2 using the instance role.
5. Generate or refresh a protected per-tenant env file.
6. Update `/opt/sherwood/tenants/<tenant>/current` to point at the release directory.
7. Restart only that tenant's PM2 API and worker processes.
8. Check tenant backend health.

Frontend-specific flow:

1. Check whether a frontend artifact exists for the resolved commit and exact tenant/env build config.
2. Build and store the artifact if needed, supplying tenant/env variables at build time.
3. Read the tenant frontend bucket from `tenants.yml`.
4. Sync artifact files to the tenant S3 bucket.
5. Set explicit cache headers.
6. Smoke check the tenant frontend URL.

## Domain Model

There is no database schema, ORM model, or migration set in this repository yet.

The current proposed operational domain model is:

- Environment: deployment scope such as `staging` or `production`.
- Tenant: customer/client deployment target identified by a stable tenant key such as `client1`.
- App: deployable unit, currently `backend` or `frontend`.
- Ref: operator input, either branch, tag, or commit SHA.
- Resolved commit: immutable full commit SHA used for all actual deploy work.
- Backend release: immutable prepared release directory at `/opt/sherwood/releases/<commit-sha>`.
- Tenant backend pointer: symlink at `/opt/sherwood/tenants/<tenant>/current` pointing to a backend release.
- PM2 process: tenant-specific runtime process, normally one API process and one worker process per tenant.
- Frontend artifact: static build output stored by resolved commit plus tenant/env/config identity because v1 bakes tenant variables into the bundle at build time.
- Tenant frontend bucket: tenant-specific S3 bucket receiving the deployed frontend files.
- Deploy event: append-only JSON record of a deploy, rollback, failure, or partial failure.
- Current state: mutable JSON record describing the desired/current version for one tenant/app, including the `inProgress`/`since` concurrency guardrail. Before the first successful deploy, a current-state record may exist only to hold `inProgress`; `currentVersion` and `lastSuccessfulEventId` are then `null`.

No primary keys, foreign keys, or cascade rules exist yet because there is no persisted relational schema in this repo.

Proposed storage relationships:

- Tenant config maps `environment + tenant` to AWS resources and runtime names.
- Deploy history stores events under `environment + tenant + app`.
- Current state is one record per `environment + tenant + app`, and carries the `inProgress` guardrail for that key.
- Backend releases are keyed by commit SHA and may be shared by many tenants.
- Frontend artifacts are not keyed by commit SHA alone in v1; they include tenant/env/config identity so one tenant's build cannot be reused for another tenant by accident.

Proposed cascade/retention behavior:

- Do not delete current backend releases or current frontend artifacts.
- Keep the last 10 successful versions per tenant/app.
- Keep anything deployed in the last 30 days.
- Cleanup should be explicit and dry-run first, not automatic during normal deploys.
- Rollback depends on old releases/artifacts and deploy history remaining available.

## Proposed Tenant Registry Shape

`tenants.yml` stores tenant-specific resource references, not secret values. It stays separate from `deployctl.config.yml`: tenant config maps environments and tenants to resource references, process names, and URLs; project config describes shared infrastructure, build, storage, and policy settings.

Example shape:

```yaml
staging:
  client1:
    frontendBucket: skincair-staging-frontend-client1
    dbSecret: skincair/staging/db/client1
    redisSecret: skincair/staging/redis
    apiProcess: sherwood-api-client1
    workerProcess: sherwood-worker-client1
    appBaseDir: /opt/sherwood/tenants/client1
    backendHealthUrl: https://client1.sherwood.science/health
    frontendUrl: https://client1.sherwood.science
```

Rules:

- Store Secrets Manager paths, not secret values.
- Do not put passwords, tokens, connection strings, or private keys in Git.
- PM2 process names should be explicit config, not guessed from tenant IDs.

## Patterns And Conventions

Implemented patterns:

- Use TypeScript with Node.js ESM.
- Use Node's built-in test runner via `node --import tsx --test`.
- Use YAML for operational config files (`deployctl.config.yml`, `tenants.yml`), validated by strict schemas and represented as typed objects internally.
- CLI behavior tests should invoke the public CLI entrypoint with `spawnSync`, not private functions.
- Non-implemented commands should fail clearly without AWS side effects.
- Keep CLI command controllers thin over directly importable modules. The current public seam is `runCli(argv, io)` in `src/cli.ts`; the config module seam is `loadDeployctlConfig(path)` in `src/core/config.ts`.
- Tenant registry callers should use `loadTenantRegistry(path)` and `listTenants(registry, environment)` from `src/core/tenants.ts` rather than parsing YAML in command code.
- Ref resolution callers should use `resolveDeploymentRef(input)` from `src/core/refs.ts`. Core enforces environment ref policy and returns both `requestedRef` and immutable `resolvedCommit`; Git access stays behind the `RefResolver` adapter interface.
- History callers should use the `DeployHistoryRepository` seam from `src/core/history.ts`. Append-only events and mutable current state are separate operations; successful deploy/rollback events update current state through `applySuccessfulEventToCurrentState(...)`.
- Deploy and rollback orchestration must call `startDeploymentGuardrail(...)` before work starts and `clearDeploymentGuardrail(...)` on completion or failure. The guardrail lives in `CurrentState.inProgress`, scoped per `env/tenant/app`.
- Backend deploy callers should use `deployBackend(input)` from `src/core/deploy.ts`. It accepts its dependencies (config, registry, ref resolver, history repository, and an `SsmDeployExecutor`) rather than creating them, so the CLI and the future dashboard call the same module and tests mock the AWS work behind the executor seam. All real SSM/secret work lives behind `SsmDeployExecutor`; orchestration only passes resolved facts and resource references — never secret values.
- SSM Run Command targets are selected per environment via `deployctl.config.yml` `ssmTargets`, a discriminated selector (`mode: instanceIds` with `instanceIds`, or `mode: asg` with `autoScalingGroupName`). Identifiers are placeholders until Phase 0 confirms them; the selector shape is fixed in code.
- Frontend deploy callers should use `deployFrontend(input)` from `src/core/frontend.ts`, with the same dependency-injection shape (config, registry, ref resolver, history, plus the artifact-store/builder/sync/smoke-check seams). The v1 artifact identity is `frontendArtifactKey`: a fingerprint over the resolved commit and the exact env/tenant/build-variable values, so one tenant's build is never reused for another. Build-variable values are passed in as input; their source is a Phase 0 confirmation kept out of the core. The synced artifact's S3 key is recorded on the deploy event as `artifactStorageKey` so rollback can redeploy the exact artifact.
- Rollback callers should use `rollbackBackend(input)`/`rollbackFrontend(input)` from `src/core/rollback.ts`, with the same dependency-injection shape as deploy. A rollback never resolves a git ref: `selectRollbackTarget(...)` picks the version to restore from recorded history (default: the version before the current one; or an explicit `toVersion` matching an earlier successful deploy). Backend rollback reuses the `SsmDeployExecutor.runBackendDeploy` seam with the target commit; frontend rollback re-syncs the target version's recorded `artifactStorageKey` without rebuilding.
- Status callers should use `getTenantStatus(repository, input)` from `src/core/diagnostics.ts` rather than reading current state in command code. It queries the `DeployHistoryRepository` seam for each app and returns a structured `TenantStatus`; `formatTenantStatus(...)` renders it one target per line. The S3-backed repository adapter is still pending, so the CLI controller validates offline and reports that boundary.
- Cleanup callers should use `planTargetRetention(repository, target, policy, now?)` from `src/core/cleanup.ts` to compute the dry-run keep/delete plan; the pure `planRetention(candidates, policy, now?)` holds the retention rules (keep current, newest `successfulVersionsPerTarget`, and anything within `keepDays`). Deletion of the `delete` set is a separate `CleanupExecutor` adapter concern that is still pending; cleanup must default to dry-run.

Expected implementation conventions from the proposal:

- CLI commands should be thin controllers over focused orchestration modules.
- Business rules should live in reusable deploy orchestration code, not inside command parsing.
- Keep architectural invariants in code/tests rather than broad config switches: commit-pinned deploys, production rejecting moving branch refs, secret values never passing through `deployctl`, the `current.json.inProgress` guardrail, and CLI/dashboard sharing orchestration modules.
- Validate tenant/env/ref before making AWS changes.
- Resolve refs to full commit SHAs before deployment work starts.
- Production should accept tags or commit SHAs, not moving branches.
- Use AWS SDK from TypeScript for orchestration and persistence.
- Use SSM instead of SSH for backend remote execution.
- Use CloudWatch Logs for log retrieval instead of reading server log files over SSH.
- Record failures and partial production failures clearly.
- Do not automatically rollback in version 1.
- Avoid adding compatibility layers until there is real persisted data or external consumer behavior to preserve.

Suggested future module seams, once code exists:

- CLI command parsing.
- Tenant config loading and validation: implemented in `src/core/tenants.ts`.
- Git/Bitbucket ref resolution: implemented in `src/core/refs.ts` with Git access isolated in `src/adapters/git.ts`.
- Concurrency guardrail (`inProgress`/`since` on `current.json`): implemented in `src/core/guardrail.ts`.
- Deploy history/current-state repository: core schemas and repository seam are implemented in `src/core/history.ts`; S3 persistence adapter is still pending.
- Backend SSM deployment orchestration.
- Frontend artifact and S3 sync orchestration.
- Status and logs queries: status is implemented in `src/core/diagnostics.ts`; logs and the S3 history adapter are still pending.
- Rollback orchestration: implemented in `src/core/rollback.ts`; CLI controllers and AWS adapters still pending.
- Cleanup and retention: decision logic implemented in `src/core/cleanup.ts`; CLI controllers and the S3 deletion adapter still pending.

These modules must stay directly importable/callable independent of `process.argv` and stdout, since the planned web dashboard (Phase 15) will call them in-process rather than through the CLI binary.

## File Paths With Purpose

Current paths:

- `docs/initial-architecture-proposal.md`: authoritative proposal for version 1 behavior and decisions.
- `docs/implementation-plan.md`: phase tracker for implementation progress.
- `docs/multi-tenant-deployment-explainer.md`: explanatory companion for the same architecture.
- `AGENTS.md`: local instructions for agents; points agents to the architecture proposal.
- `CONTEXT.md`: concise project context and implementation guardrails.
- `src/cli.ts`: CLI entrypoint and initial dispatch.
- `src/core/config.ts`: project config loading and validation.
- `src/core/tenants.ts`: tenant registry loading, validation, likely-secret rejection, and tenant listing.
- `src/core/refs.ts`: environment-aware ref resolution into immutable commit metadata.
- `src/core/history.ts`: deploy history event validation, current-state validation, repository seam, and in-memory repository.
- `src/adapters/git.ts`: Git CLI ref resolver adapter.
- `src/shared.ts`: shared errors and IO formatting.
- `test/cli.test.ts`: public `deployctl --help` behavior test.
- `test/config.test.ts`: config loading and validation behavior tests.
- `test/tenants.test.ts`: tenant registry validation behavior tests.
- `test/refs.test.ts`: ref resolution policy behavior tests.
- `test/history.test.ts`: deploy history/current-state behavior tests.
- `test/rollback.test.ts`: rollback version-selection and backend/frontend rollback behavior tests.
- `test/diagnostics.test.ts`: status query and rendering behavior tests.
- `test/cleanup.test.ts`: retention decision, candidate derivation, and per-target plan behavior tests.
- `package.json`, `package-lock.json`, `tsconfig.json`: Node package metadata and TypeScript configuration.
- `deployctl.config.yml`: project-wide config for AWS region, app repository, build commands, deploy history/artifact locations, ref policies, and retention settings. Some values are placeholders until Phase 0 discovery confirms them.
- `tenants.yml`: tenant registry with environment/tenant resource mappings. Current values are starter references and should be confirmed before real deploy use.

Proposed paths from the architecture, not yet created (see the target repo structure in `docs/implementation-plan.md`):

- `bitbucket-pipelines.yml`: pipeline entry points for invoking the CLI.
- `scripts/`: small remote scripts, especially EC2-local commands invoked through SSM.

Proposed runtime paths, not repository paths:

- `/opt/sherwood/releases/<commit-sha>`: prepared backend release on EC2.
- `/opt/sherwood/tenants/<tenant>/current`: symlink to the selected backend release.
- `/opt/sherwood/tenants/<tenant>/env.production.json`: protected tenant env file on EC2.
- `s3://.../frontend/<commit-sha>/<env>/<tenant-or-config-fingerprint>.tar.gz`: proposed frontend artifact storage for v1 build-time tenant config.
- `s3://skincair-<env>-deploy-history/deploys/<tenant>/<app>/events/<timestamp>-<deployId>.json`: proposed append-only deploy event storage.
- `s3://skincair-<env>-deploy-history/deploys/<tenant>/<app>/current.json`: proposed current desired state storage.

## Exact Commands

Verified local development commands:

```bash
npm test
npm run typecheck
node --import tsx src/cli.ts --help
node --import tsx src/cli.ts config check
node --import tsx src/cli.ts tenants list --env staging
node --import tsx src/cli.ts deploy backend --tenant client1 --env staging --ref main
node --import tsx src/cli.ts deploy frontend --tenant client1 --env staging --ref main
```

The `deploy backend` and `deploy frontend` commands currently validate inputs offline (tenant/env existence, and for backend a configured SSM target selector) and then fail clearly that AWS execution is still pending; they make no AWS or network calls until the SSM/S3/build adapters land.

Proposed operator commands from the architecture:

```bash
deployctl tenants list --env staging
deployctl status --tenant client1 --env staging
deployctl deploy backend --tenant client1 --env staging --ref feature/foo
deployctl deploy frontend --tenant client1 --env staging --ref feature/foo
deployctl rollback backend --tenant client1 --env production --version abc123
deployctl rollback frontend --tenant client1 --env production --version abc123
deployctl logs --tenant client1 --env production --service api --since 1h
deployctl reconcile backend --env production
deployctl cleanup releases --env production --dry-run
deployctl cleanup artifacts --env production --dry-run
```

Update this section as new phases add linting, integration tests, CLI smoke tests, or AWS-adapter tests.

## Known Gaps And Open Questions

Repository gaps:

- Tenant registry values are starter references and still need infrastructure confirmation.
- No deploy scripts exist yet.
- No Bitbucket pipeline config exists yet.
- No deploy history schemas exist yet.
- No IAM policies exist yet.

Architecture and implementation open questions (tracked as a working checklist in `docs/phase-0-checklist.md`, grouped by the AWS adapter each answer unblocks):

- Confirm existing production ASG bootstrap behavior for replacement instances.
- Choose exact deploy history S3 bucket or prefix.
- Define final least-privilege IAM policies.
- Define the runbook for releases that require manual database migrations.
- Confirm CloudWatch log group and stream naming conventions for tenant/process filtering.
- Confirm exact frontend build-time variable names and how they differ per tenant/environment.
- Define exact artifact retention and cleanup implementation.
- Confirm the dashboard's network restriction mechanism: possibly Google Identity-Aware Proxy (IAP), mentioned by the project owner but not confirmed; IP-allowlisted security group is the fallback.
- Confirm the dashboard's hosting target: likely a small dedicated instance separate from the tenant-serving ASG/EC2 instances, not yet confirmed.

Intentional version 1 non-goals:

- No Terraform changes.
- No tenant onboarding automation.
- No database provisioning.
- No DNS or broad Cloudflare infrastructure changes.
- No Docker, Kubernetes, ECS, or ECR-based deployment path.
- No automatic rollback.
- No database migration automation.
- No dashboard rollback or logs support in the first dashboard phase (deferred, see Phase 15 in `docs/implementation-plan.md`).
- No DynamoDB or S3 lock store for the dashboard guardrail; see Phase 5 in `docs/implementation-plan.md`.

## Security Notes

- `deployctl` should pass secret references, not secret values.
- EC2 should read secrets from AWS Secrets Manager using its instance role.
- Tenant env files should be protected with strict permissions.
- Deploy history should contain metadata only, not secrets.
- Operators should not need SSH keys for normal backend deploys.
- Logs should come from CloudWatch.
- IAM should be scoped to the minimum required actions.
- The web dashboard (Phase 15) needs basic auth or a shared secret from Secrets Manager, a network restriction, and audit logging of the authenticated identity into deploy history (`deployedBy`). It must not be reachable without restriction, since it can trigger production deploys.
