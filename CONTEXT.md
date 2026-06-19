# CONTEXT.md

This repository started documentation-first and now has the first safe Phase 1 CLI scaffold. There is no tenant registry, deploy implementation, migrations, remote script, or pipeline configuration yet.

Use this file as the short project context for future work. Treat architecture details below as the current proposed direction from `docs/initial-architecture-proposal.md`, not as verified runtime behavior.

When coding starts, update this file in the same change set with the actual source layout, commands, domain model, and conventions that are introduced.

## Project Purpose

`deployctl` is intended to be a CLI-first deployment automation tool for a multi-tenant application.

The goal is to deploy backend and frontend versions independently per tenant without duplicating the full repository or creating separate infrastructure stacks per tenant.

Version 1 is scoped to deployment automation on top of existing AWS infrastructure. It should not provision tenant infrastructure.

## Current Repository State

Implemented code: minimal Phase 1 TypeScript CLI scaffold.

Current files:

- `AGENTS.md`: agent guidance for working in this repo.
- `CONTEXT.md`: this file, optimized as quick context for coding agents.
- `docs/initial-architecture-proposal.md`: primary architecture proposal and decisions.
- `docs/implementation-plan.md`: phased implementation tracker and current phase status.
- `docs/multi-tenant-deployment-explainer.md`: beginner-friendly explanation of the no-Docker deployment model.
- `docs/review-questions.md`: reviewer Q&A and open implementation questions.
- `package.json`: Node package manifest with test and typecheck scripts.
- `package-lock.json`: npm lockfile.
- `tsconfig.json`: TypeScript configuration.
- `src/cli.ts`: minimal CLI entrypoint with help output and non-implemented command fallback.
- `test/cli-help.test.ts`: public CLI behavior test for help output.

Generated/local files currently present and not meaningful for project design:

- `.DS_Store`
- `docs/.DS_Store`

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
  -> build or reuse frontend artifact for that commit
  -> sync static files to tenant S3 frontend bucket
  -> optional tenant runtime config file
  -> Cloudflare serves tenant domain
  -> smoke check
  -> deploy history
```

Important architectural rules:

- `deployctl` should be a small TypeScript CLI running on Node.js.
- Version 1 is CLI-only. Do not add a dashboard unless explicitly requested.
- Deployment orchestration, validation, AWS SDK calls, history, and user-facing errors belong in TypeScript.
- Shell should be limited to small EC2-local scripts invoked through SSM.
- Backend deploys are commit-based release directories, not a single mutable Git checkout.
- Frontend deploys are commit-based static artifacts synced to tenant buckets.
- Backend and frontend deploy independently.
- Normal deploys should not change Terraform, DNS, Cloudflare routing, tenant onboarding, database provisioning, or migrations.

## Data Flow

Common deploy flow:

1. Operator or Bitbucket Pipeline invokes `deployctl` with tenant, environment, app, and ref.
2. `deployctl` validates inputs against tenant configuration.
3. `deployctl` resolves branch/tag/SHA input to a full commit SHA before doing deployment work.
4. `deployctl` acquires a deployment lock for `<env>/<tenant>/<app>`.
5. `deployctl` executes the backend or frontend deploy path.
6. `deployctl` runs a health or smoke check.
7. `deployctl` writes append-only deploy history and updates current desired state.
8. `deployctl` releases the deployment lock.

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

1. Check whether a frontend artifact exists for the resolved commit.
2. Build and store the artifact if needed.
3. Read the tenant frontend bucket from `tenants.yml`.
4. Sync artifact files to the tenant S3 bucket.
5. Write tenant-specific runtime config if needed.
6. Set explicit cache headers.
7. Smoke check the tenant frontend URL.

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
- Frontend artifact: static build output stored by commit SHA and reusable across tenants.
- Tenant frontend bucket: tenant-specific S3 bucket receiving the deployed frontend files.
- Deploy event: append-only JSON record of a deploy, rollback, failure, or partial failure.
- Current state: mutable JSON record describing the desired/current version for one tenant/app.
- Deployment lock: coordination record keyed by `<env>/<tenant>/<app>`.

No primary keys, foreign keys, or cascade rules exist yet because there is no persisted relational schema in this repo.

Proposed storage relationships:

- Tenant config maps `environment + tenant` to AWS resources and runtime names.
- Deploy history stores events under `environment + tenant + app`.
- Current state is one record per `environment + tenant + app`.
- Deployment locks are keyed by `environment + tenant + app`.
- Backend releases are keyed by commit SHA and may be shared by many tenants.
- Frontend artifacts are keyed by commit SHA and may be shared by many tenants.

Proposed cascade/retention behavior:

- Do not delete current backend releases or current frontend artifacts.
- Keep the last 10 successful versions per tenant/app.
- Keep anything deployed in the last 30 days.
- Cleanup should be explicit and dry-run first, not automatic during normal deploys.
- Rollback depends on old releases/artifacts and deploy history remaining available.

## Proposed Tenant Registry Shape

`tenants.yml` does not exist yet. The proposal expects it to store resource references, not secret values.

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

Confirmed implemented patterns:

- Use TypeScript with Node.js ESM.
- Use Node's built-in test runner via `node --import tsx --test`.
- CLI behavior tests should invoke the public CLI entrypoint with `spawnSync`, not private functions.
- Non-implemented commands should fail clearly without AWS side effects.

Expected implementation conventions from the proposal:

- CLI commands should be thin controllers over focused orchestration modules.
- Business rules should live in reusable deploy orchestration code, not inside command parsing.
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
- Tenant config loading and validation.
- Git/Bitbucket ref resolution.
- Deployment locking.
- Deploy history/current-state repository.
- Backend SSM deployment orchestration.
- Frontend artifact and S3 sync orchestration.
- Status and logs queries.
- Rollback orchestration.

## File Paths With Purpose

Current paths:

- `docs/initial-architecture-proposal.md`: authoritative proposal for version 1 behavior and decisions.
- `docs/implementation-plan.md`: phase tracker for implementation progress.
- `docs/multi-tenant-deployment-explainer.md`: explanatory companion for the same architecture.
- `docs/review-questions.md`: open questions and manager/reviewer-ready answers.
- `AGENTS.md`: local instructions for agents; points agents to the architecture proposal.
- `CONTEXT.md`: concise project context and implementation guardrails.
- `src/cli.ts`: CLI entrypoint.
- `test/cli-help.test.ts`: CLI help behavior test.
- `package.json`: npm scripts and package metadata.
- `tsconfig.json`: TypeScript compiler settings.

Proposed paths from the architecture, not yet created:

- `tenants.yml`: tenant registry with environment/tenant resource mappings.
- `bitbucket-pipelines.yml`: pipeline entry points for invoking the CLI.
- `scripts/`: small remote scripts, especially EC2-local commands invoked through SSM.
- `docs/`: operator docs for deploy, rollback, troubleshooting, and tenant config.

Proposed runtime paths, not repository paths:

- `/opt/sherwood/releases/<commit-sha>`: prepared backend release on EC2.
- `/opt/sherwood/tenants/<tenant>/current`: symlink to the selected backend release.
- `/opt/sherwood/tenants/<tenant>/env.production.json`: protected tenant env file on EC2.
- `s3://.../frontend/<commit-sha>.tar.gz`: proposed frontend artifact storage.
- `s3://skincair-<env>-deploy-history/deploys/<tenant>/<app>/events/<timestamp>-<deployId>.json`: proposed append-only deploy event storage.
- `s3://skincair-<env>-deploy-history/deploys/<tenant>/<app>/current.json`: proposed current desired state storage.

## Exact Commands

Verified local development commands:

```bash
npm test
npm run typecheck
node --import tsx src/cli.ts --help
```

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
deployctl locks list --env production
deployctl locks unlock production/client1/backend --force
```

When implementation begins, update this section with exact verified commands, such as install, lint, typecheck, unit tests, integration tests, and CLI smoke tests.

## Known Gaps And Open Questions

Repository gaps:

- Only the minimal TypeScript CLI scaffold exists.
- No tenant registry exists yet.
- No deploy scripts exist yet.
- No Bitbucket pipeline config exists yet.
- No deploy history schemas exist yet.
- No IAM policies exist yet.

Architecture and implementation open questions:

- Confirm existing production ASG bootstrap behavior for replacement instances.
- Decide whether deployment locks use DynamoDB conditional writes or S3 lock objects.
- Choose exact deploy history S3 bucket or prefix.
- Define final least-privilege IAM policies.
- Define the runbook for releases that require manual database migrations.
- Confirm CloudWatch log group and stream naming conventions for tenant/process filtering.
- Confirm whether frontend tenant config is runtime config or currently baked into the JS bundle.
- Define exact artifact retention and cleanup implementation.

Intentional version 1 non-goals:

- No Terraform changes.
- No tenant onboarding automation.
- No database provisioning.
- No DNS or broad Cloudflare infrastructure changes.
- No Docker, Kubernetes, ECS, or ECR-based deployment path.
- No web dashboard.
- No automatic rollback.
- No database migration automation.

## Security Notes

- `deployctl` should pass secret references, not secret values.
- EC2 should read secrets from AWS Secrets Manager using its instance role.
- Tenant env files should be protected with strict permissions.
- Deploy history should contain metadata only, not secrets.
- Operators should not need SSH keys for normal backend deploys.
- Logs should come from CloudWatch.
- IAM should be scoped to the minimum required actions.
