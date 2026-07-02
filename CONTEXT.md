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
- `docs/phase-0-simulation-plan.md`: Docker-based simulation plan for demoing deploy, rollback, status, logs, and replacement-instance behavior before real Phase 0 answers are available.
- `docs/phase-0-real-cutover.md`: checklist for replacing simulation values/adapters with confirmed AWS/EC2/CloudWatch/Secrets/IAM facts once Phase 0 is complete.
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
- `src/core/logs.ts`: logs query (`getTenantLogs`) over the `LogQuery` seam plus `parseSinceDuration`/`parseLogService`/`formatLogEntries`; parses `--since` to an absolute cutoff and returns entries oldest-first.
- `src/core/reconcile.ts`: backend reconciliation (`reconcileBackend`) over the `SsmDeployExecutor` seam; reads the recorded current version and re-prepares that release on every configured instance (no ref, no new version, no current-state change), guardrail-protected. Simulates the Phase 10 replacement-instance recovery.
- `src/adapters/git.ts`: Git CLI adapter for resolving refs from the application repository.
- `src/adapters/filesystem-history.ts`: `FileSystemDeployHistoryRepository`, a filesystem-backed `DeployHistoryRepository` for the Sim Phase 1 simulation lane (docs/phase-0-simulation-plan.md), storing events/current state under `.deployctl-sim/history/deploys/<env>/<tenant>/<app>/`.
- `src/adapters/docker-ssm.ts`: `DockerSimSsmDeployExecutor`, the Sim Phase 2 `SsmDeployExecutor` that runs `scripts/ec2/deploy-backend.sh` in the Docker app-server container via `docker exec`, reusing `ssmTargets.<env>.instanceIds` entries as container names.
- `src/adapters/filesystem-frontend.ts`: Sim Phase 3 `FileSystemFrontendArtifactStore` (stores artifacts under `.deployctl-sim/artifacts/<storageKey>`) and `FileSystemFrontendSync` (copies to `.deployctl-sim/frontend-buckets/<bucket>/index.html`).
- `src/adapters/fixture-frontend.ts`: Sim Phase 3 `FixtureFrontendBuilder` (synthesizes an `index.html` embedding commit/env/tenant/build variables, no real build) and `NoopFrontendSmokeCheck` (always healthy; no HTTP server stood up in the sim).
- `src/adapters/filesystem-logs.ts`: Sim Phase 4 `FileSystemLogQuery` reading newline-delimited JSON entries from `.deployctl-sim/logs/<env>/<tenant>/<service>.log`, filtered by the `since` cutoff.
- `src/shared.ts`: shared CLI errors, IO, and formatting helpers.
- `tenants.yml`: initial tenant registry with resource references only.
- `deployctl.sim.config.yml`: simulation config (`adapterMode: sim`) for the Docker-based demo lane; values are simulation fixtures, not confirmed Phase 0 facts.
- `tenants.sim.yml`: tenant registry for the Docker demo lane; secret names must match `docker/sim/app-server/secret-fixtures.json`.
- `docker-compose.sim.yml`, `docker/sim/app-server/`: Sim Phase 2 "EC2 app-server" container (Dockerfile, entrypoint, health server, secret fixtures).
- `scripts/ec2/deploy-backend.sh`: EC2-local backend deploy script, run for real via SSM in production or via `docker exec` in the simulation; path-parameterized (release root, tenant base dir, OS user) so cutover is a config change.
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
- Ref resolution callers should use `resolveDeploymentRef(input)` from `src/core/refs.ts`. Core enforces environment ref policy and returns both `requestedRef` and immutable `resolvedCommit`; Git access stays behind the `RefResolver` adapter interface. `GitCliRefResolver` accepts a full commit SHA only when the configured repository advertises it (`git ls-remote`), and runs Git through an injectable `GitCommandRunner` seam so the adapter is tested offline (`test/git.test.ts`).
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
- Status and logs queries: status is implemented in `src/core/diagnostics.ts` and logs in `src/core/logs.ts` (the `LogQuery` seam); both have filesystem sim adapters, while the S3 history and CloudWatch Logs adapters are still pending.
- Rollback orchestration: implemented in `src/core/rollback.ts`; `deployctl rollback backend|frontend` CLI controllers validate offline and report the pending boundary; AWS adapters still pending.
- Cleanup and retention: decision logic implemented in `src/core/cleanup.ts`; `deployctl cleanup releases|artifacts` CLI controllers validate offline and report the pending boundary; the S3 history adapter and deletion executor still pending.
- Reconciliation: implemented in `src/core/reconcile.ts` (`reconcileBackend`) over the `SsmDeployExecutor` seam; `deployctl reconcile backend` runs it under `adapterMode: sim` (Docker) and reports the pending boundary otherwise. Real ASG reconciliation is Phase 10, blocked on Phase 0.

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
- `src/adapters/filesystem-history.ts`: filesystem-backed `DeployHistoryRepository` adapter used when `adapterMode: sim`.
- `src/adapters/docker-ssm.ts`: `SsmDeployExecutor` adapter used when `adapterMode: sim`; runs `scripts/ec2/deploy-backend.sh` via `docker exec`.
- `src/adapters/filesystem-frontend.ts`: `FrontendArtifactStore`/`FrontendSync` adapters used when `adapterMode: sim`.
- `src/adapters/fixture-frontend.ts`: `FrontendBuilder`/`FrontendSmokeCheck` adapters used when `adapterMode: sim`.
- `src/adapters/filesystem-logs.ts`: `LogQuery` adapter used when `adapterMode: sim`; reads `.deployctl-sim/logs/<env>/<tenant>/<service>.log`.
- `src/core/reconcile.ts`: `reconcileBackend` over the `SsmDeployExecutor` seam; used by `deployctl reconcile backend` under `adapterMode: sim`.
- `scripts/ec2/deploy-backend.sh`: EC2-local backend deploy script (real SSM target or the sim container); also emits sim-only api/worker log fixtures when `DEPLOYCTL_LOG_ROOT` is set.
- `docker-compose.sim.yml`, `docker/sim/app-server/`: Docker "EC2 app-server" lab; a `production` compose profile adds two independent-volume production containers for the Sim Phase 5 replacement demo.
- `src/shared.ts`: shared errors and IO formatting.
- `test/cli.test.ts`: public CLI behavior tests, including `deployctl status` reading simulated current state via `deployctl.sim.config.yml`.
- `test/config.test.ts`: config loading and validation behavior tests.
- `test/filesystem-history.test.ts`: `FileSystemDeployHistoryRepository` behavior tests (append-only events, current state, `inProgress` guardrail).
- `test/docker-ssm.test.ts`: `DockerSimSsmDeployExecutor` behavior tests (env vars passed to the container, per-instance success/failure, `asg` rejection) with a mocked `docker` runner.
- `test/filesystem-frontend.test.ts`: frontend artifact store/sync + `deployFrontend`/`rollbackFrontend` integration behavior (build/reuse/changed-variable/rollback-resync).
- `test/fixture-frontend.test.ts`: `FixtureFrontendBuilder` content/identity and `NoopFrontendSmokeCheck` behavior.
- `test/logs.test.ts`: `getTenantLogs`/`parseSinceDuration`/`parseLogService`/`formatLogEntries` behavior (fake `LogQuery` seam).
- `test/filesystem-logs.test.ts`: `FileSystemLogQuery` behavior tests (path selection, `since` filtering, missing file, malformed line).
- `test/reconcile.test.ts`: `reconcileBackend` behavior tests (current-version read, no-current-version, partial_failure, executor-throw guardrail clearing, in-progress conflict) with a fake executor.
- `test/tenants.test.ts`: tenant registry validation behavior tests.
- `test/refs.test.ts`: ref resolution policy behavior tests.
- `test/history.test.ts`: deploy history/current-state behavior tests.
- `test/rollback.test.ts`: rollback version-selection and backend/frontend rollback behavior tests.
- `test/diagnostics.test.ts`: status query and rendering behavior tests.
- `test/cleanup.test.ts`: retention decision, candidate derivation, and per-target plan behavior tests.
- `package.json`, `package-lock.json`, `tsconfig.json`: Node package metadata and TypeScript configuration.
- `deployctl.config.yml`: project-wide config for AWS region, app repository, build commands, deploy history/artifact locations, ref policies, retention, and `backendDeploy` (release root/OS user) settings. Some values are placeholders until Phase 0 discovery confirms them. Includes `adapterMode: aws | sim` (default `aws`); only `sim` selects the simulation adapters below.
- `tenants.yml`: tenant registry with environment/tenant resource mappings. Current values are starter references and should be confirmed before real deploy use.
- `tenants.sim.yml`: tenant registry for the Docker demo lane.
- `docs/phase-0-simulation-plan.md`: plan for a local Docker Compose lab using simulated adapters behind the same core seams.
- `docs/simulation-runbook.md`: operator runbook for the Docker demo lab (staging walkthrough + production replacement demo, reset instructions, secret-safety note).
- `docs/phase-0-real-cutover.md`: replacement checklist for moving from simulation to real AWS adapters and confirmed Phase 0 values.

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
node --import tsx src/cli.ts rollback backend --tenant client1 --env staging --version <commit>
node --import tsx src/cli.ts rollback frontend --tenant client1 --env staging
node --import tsx src/cli.ts cleanup releases --env staging --dry-run
node --import tsx src/cli.ts cleanup artifacts --env staging --dry-run
node --import tsx src/cli.ts status --tenant client1 --env staging --config deployctl.sim.config.yml
docker compose -f docker-compose.sim.yml up -d --build
node --import tsx src/cli.ts deploy backend --tenant client1 --env staging --ref main --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts deploy frontend --tenant client1 --env staging --ref main --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts rollback frontend --tenant client1 --env staging --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts logs --tenant client1 --env staging --service api --since 1h --config deployctl.sim.config.yml --tenants tenants.sim.yml
docker compose -f docker-compose.sim.yml down -v
# Sim Phase 5 replacement demo (two production containers):
docker compose -f docker-compose.sim.yml --profile production up -d --build
node --import tsx src/cli.ts deploy backend --tenant client1 --env production --ref <full-sha-or-tag> --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts reconcile backend --tenant client1 --env production --config deployctl.sim.config.yml --tenants tenants.sim.yml
docker compose -f docker-compose.sim.yml --profile production down -v
```

The `cleanup` commands (and, under the default `aws` mode, all deploy/rollback commands) validate inputs offline and then fail clearly that the work is still pending; they make no AWS or network calls until the S3/build adapters land. They validate tenant/env existence (and, for backend deploy/rollback, a configured SSM target selector); `rollback --version` is optional (omit to target the previous version); cleanup validates the environment against the tenant registry and defaults to dry-run.

With `--config deployctl.sim.config.yml` (`adapterMode: sim`), the deploy/rollback/status/logs commands run for real against the simulation instead of throwing the pending error: `status` reads current-state records from `FileSystemDeployHistoryRepository` under `.deployctl-sim/` (Sim Phase 1); `deploy backend`/`rollback backend` run the existing orchestration against the `docker-compose.sim.yml` app-server container via `DockerSimSsmDeployExecutor` (Sim Phase 2); `deploy frontend`/`rollback frontend` run through the filesystem artifact store/sync, `FixtureFrontendBuilder`, and `NoopFrontendSmokeCheck` (Sim Phase 3), resolving `--ref` through `GitCliRefResolver` pointed at this repo; `logs` reads `FileSystemLogQuery` entries the backend deploy wrote under `.deployctl-sim/logs/` (Sim Phase 4); `reconcile backend` re-prepares the recorded current release on every configured instance via `DockerSimSsmDeployExecutor`, recovering a replacement container with an empty `/opt/sherwood` (Sim Phase 5, `--profile production`). `cleanup` is not wired for sim yet. `DEPLOYCTL_SIM_ROOT` overrides the `.deployctl-sim` root, mainly for test isolation.

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
- Sim Phase 1 (local persistence: `adapterMode`, `FileSystemDeployHistoryRepository` wired into `status`), Sim Phase 2 (backend container: `docker-compose.sim.yml`, `scripts/ec2/deploy-backend.sh`, `DockerSimSsmDeployExecutor` wired into `deploy backend`), Sim Phase 3 (frontend artifacts + rollback: `FileSystemFrontendArtifactStore`/`FileSystemFrontendSync`, `FixtureFrontendBuilder`, `deploy frontend` and both `rollback` controllers wired for sim), Sim Phase 4 (logs: `LogQuery` core seam, `FileSystemLogQuery`, `deployctl logs` controller, container-written log fixtures), Sim Phase 5 (production replacement demo: two-container `production` compose profile, `reconcileBackend` core + `deployctl reconcile backend`), and Sim Phase 6 (operator runbook, `docs/simulation-runbook.md`) are implemented. The simulation lane (Sim Phases 1–6) is complete. Both the Sim Phase 2 backend release directory and the Sim Phase 3 frontend artifact are synthesized markers, not real builds (no fixture app repo/checkout yet). The Sim Phase 5 `reconcile` simulates the Phase 10 mechanism; real ASG reconciliation stays Phase-0-blocked.

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

Simulation note:

- Docker may be used as a temporary demo/development lab for Phase 0 assumptions, but it is not the production deployment architecture and does not confirm real infrastructure facts. Simulated values must remain clearly separated from `deployctl.config.yml` and `tenants.yml` until replaced through `docs/phase-0-real-cutover.md`.

## Security Notes

- `deployctl` should pass secret references, not secret values.
- EC2 should read secrets from AWS Secrets Manager using its instance role.
- Tenant env files should be protected with strict permissions.
- Deploy history should contain metadata only, not secrets.
- Operators should not need SSH keys for normal backend deploys.
- Logs should come from CloudWatch.
- IAM should be scoped to the minimum required actions.
- The web dashboard (Phase 15) needs basic auth or a shared secret from Secrets Manager, a network restriction, and audit logging of the authenticated identity into deploy history (`deployedBy`). It must not be reachable without restriction, since it can trigger production deploys.
