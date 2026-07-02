# Phase 0 Discovery Checklist

Working checklist for the Phase 0 infrastructure confirmations in `docs/implementation-plan.md`. Every orchestration module (deploy, frontend, rollback, status, cleanup) is already implemented and unit-tested behind a seam; what remains before any of them can run end to end is the real infrastructure facts and the AWS adapters that use them. This document collects the concrete questions, grouped by the adapter each answer unblocks, so they can be gathered in one pass.

## How to use this

- Answer the questions inline (replace the `> _Answer:_` placeholders).
- A task is only "confirmed" once its answer is recorded in the durable location named in **Record in** — this file is a staging area, not the source of truth.
- When an answer changes a documented assumption, update `docs/initial-architecture-proposal.md` too.
- Check the box when the answer is both decided and recorded in its durable location.

Legend for **Record in**: `config` = `deployctl.config.yml`, `tenants` = `tenants.yml`, `CONTEXT` = `CONTEXT.md`, `script` = the `scripts/ec2/` deploy script, `IAM` = IAM policy docs.

---

## A. Backend SSM deploy — `SsmDeployExecutor` + `scripts/ec2/`

Unblocks: `src/core/deploy.ts` (backend deploy), `src/core/rollback.ts` (backend rollback), and Phase 6 end to end.

### A1. EC2 filesystem layout
- [ ] Confirm the release directory root (assumed `/opt/sherwood/releases/<commit-sha>`).
- [ ] Confirm the per-tenant base dir and `current` symlink path (assumed `/opt/sherwood/tenants/<tenant>/current`).
- [ ] Confirm the protected per-tenant env file path (assumed `/opt/sherwood/tenants/<tenant>/env.production.json`) and its required owner/permissions.
- [ ] Confirm the OS user that owns releases and runs the deploy script.

> _Answer:_
>
> **Record in:** script, CONTEXT (Domain Model / runtime paths), tenants (`appBaseDir` per tenant)
>
> _Simulation answer (not confirmed real infra):_ Sim Phase 2 uses `releaseRoot: /opt/sherwood/releases` and `osUser: sherwood` (`deployctl.config.yml`/`deployctl.sim.config.yml`, `backendDeploy`), matching the assumed layout above, inside the Docker app-server container. This proves the config-driven path shape works; it does not confirm the real EC2 values.

### A2. PM2 process model
- [ ] Confirm PM2 process naming for API and worker (current `tenants.yml` assumes `sherwood-api-<tenant>` / `sherwood-worker-<tenant>`).
- [ ] Confirm there is exactly one API and one worker process per tenant (or list the real set).
- [ ] Confirm the restart command and whether it must be scoped to only the tenant's processes.
- [ ] Confirm whether PM2 runs under a specific user / ecosystem file.

> _Answer:_
>
> **Record in:** tenants (`apiProcess`, `workerProcess`), script

### A3. Backend build on EC2
- [ ] Confirm the authoritative backend package manager and install command (config currently `npm` / `npm ci`).
- [ ] Confirm the backend build command (config currently `npm run build`).
- [ ] Confirm whether native dependencies must be compiled on EC2 (affects whether build runs per-instance or once).
- [ ] Confirm the Node.js version / toolchain available on the instances.

> _Answer:_
>
> **Record in:** config (`build.backend`), script

### A4. SSM target selection
- [ ] Confirm staging target selection (config currently `instanceIds: [i-0abc]` placeholder) — real instance IDs or a tag selector.
- [ ] Confirm production ASG name for `mode: asg` and how healthy instances are enumerated at deploy time.
- [ ] Confirm the SSM document to use (AWS-RunShellScript vs a custom document) and any required parameters.

> _Answer:_
>
> **Record in:** config (`ssmTargets.<env>`), CONTEXT

### A5. Secrets Manager
- [ ] Confirm the Secrets Manager naming convention (tenants assume `skincair/<env>/db/<tenant>`, `skincair/<env>/redis`).
- [ ] Confirm which secrets each tenant process needs and how they map into the env file.
- [ ] Confirm the read happens on EC2 via the instance role (Hop B) — `deployctl` only ever passes the secret name.

> _Answer:_
>
> **Record in:** tenants (`dbSecret`, `redisSecret`, …), script, IAM (EC2 instance role)

### A6. Backend health check
- [ ] Confirm the health endpoint per tenant (tenants assume `https://<tenant>.sherwood.science/health`).
- [ ] Confirm expected success signal (HTTP status, body) and timeout/retry policy.

> _Answer:_
>
> **Record in:** tenants (`backendHealthUrl`), script

---

## B. Frontend artifact + sync — S3 adapters and build

Unblocks: `src/core/frontend.ts` (frontend deploy), `src/core/rollback.ts` (frontend rollback), and Phase 7 end to end.

### B1. Frontend build
- [ ] Confirm the frontend package manager, install command, and build command (config currently `npm` / `npm ci` / `npm run build`).
- [ ] Confirm the build output directory to package into the artifact.

> _Answer:_
>
> **Record in:** config (`build.frontend`)

### B2. Build-time variables and artifact identity
- [ ] Confirm the exact frontend build-time variable names (e.g. `VITE_TENANT`, `VITE_ENVIRONMENT`, API URLs).
- [ ] Confirm which of those variables are identity inputs for the artifact fingerprint (config `build.frontend.buildConfigIdentityInputs`).
- [ ] Confirm the source of each variable's value per tenant/env (this is passed into `deployFrontend` as input; the source stays out of core).

> _Answer:_
>
> **Record in:** config (`build.frontend.buildConfigIdentityInputs`), CONTEXT (how values are sourced)

### B3. S3 buckets and keys
- [ ] Confirm the frontend artifact store bucket/prefix (config currently `deploy-artifacts` / `frontend`).
- [ ] Confirm the per-tenant frontend serving bucket (tenants assume `skincair-<env>-frontend-<tenant>`).
- [ ] Confirm the cache-control headers policy for synced files (immutable hashed assets vs `index.html`).

> _Answer:_
>
> **Record in:** config (`frontendArtifacts`), tenants (`frontendBucket`), CONTEXT

### B4. Frontend smoke check
- [ ] Confirm the tenant frontend URL (tenants assume `https://<tenant>.sherwood.science`).
- [ ] Confirm the smoke-check success signal and that Cloudflare caching does not mask a bad deploy.

> _Answer:_
>
> **Record in:** tenants (`frontendUrl`), script/CONTEXT

---

## C. Deploy history + current state — S3 `DeployHistoryRepository`

Unblocks: the S3-backed history repository used by **every** command (deploy, rollback, status, cleanup) — this is the single most cross-cutting adapter.

### C1. History storage
- [ ] Confirm the deploy-history bucket/prefix (config currently `deploy-history` / `deploys`; CONTEXT proposes `skincair-<env>-deploy-history` with `deploys/<tenant>/<app>/…`).
- [ ] Confirm the key layout for append-only events and for `current.json`.
- [ ] Confirm how concurrent `current.json` writes are made safe (the `inProgress` guardrail is the mechanism; confirm S3 conditional writes / versioning back it).

> _Answer:_
>
> **Record in:** config (`deployHistory`), CONTEXT

---

## D. Logs — CloudWatch adapter

Unblocks: the real CloudWatch adapter behind the `LogQuery` seam (`src/core/logs.ts`). The seam, `getTenantLogs`, the `deployctl logs` controller, and a filesystem sim adapter already exist (Sim Phase 4); only the CloudWatch-specific naming/adapter remains.

### D1. CloudWatch log groups/streams
- [ ] Confirm the log group naming per environment/service.
- [ ] Confirm the log stream naming and how to filter by tenant and by service (`api` vs `worker`).
- [ ] Confirm log retention and any subscription/formatting that affects querying.

> _Answer:_
>
> **Record in:** config (log group/stream patterns), CONTEXT
>
> _Simulation answer (not confirmed real infra):_ Sim Phase 4 selects env/tenant/service by file path (`.deployctl-sim/logs/<env>/<tenant>/<service>.log`) and filters by an absolute `since` cutoff, standing in for a CloudWatch log group/stream + `startTime`. This proves the `LogQuery` seam and the `--service`/`--since` filter shape; it does not confirm the real log group/stream naming.

---

## E. Production ASG bootstrap — Phase 10

Unblocks: Phase 10 (`reconcile`), currently `Blocked`.

### E1. Replacement instance behavior
- [ ] Confirm whether a replacement production ASG instance restores tenant backend state automatically (user data / bootstrap) or comes up empty.
- [ ] If it does not self-restore, confirm the expected recovery path (`deployctl reconcile backend` vs a manual procedure).
- [ ] Confirm how a bootstrapping instance learns each tenant's desired version (reads `current.json`?).

> _Answer:_
>
> **Record in:** CONTEXT, `docs/initial-architecture-proposal.md`, plan (Phase 10)

---

## F. Repository access for ref resolution and builds

Unblocks: real ref resolution (`src/adapters/git.ts`) and both build steps against the real repo.

### F1. Application repository
- [ ] Confirm the application repository URL/path (config `applicationRepository.url` currently a placeholder).
- [ ] Confirm how `deployctl` authenticates to Bitbucket for `git ls-remote` and for fetching source to build (pipeline credentials, deploy key, token).
- [ ] Confirm production ref policy (moving branches rejected in production is already an invariant; confirm staging policy in `refPolicies`).

> _Answer:_
>
> **Record in:** config (`applicationRepository`, `refPolicies`), CONTEXT

---

## G. IAM — least privilege for both hops

Unblocks: safe execution of all adapters above; needed before anything runs against real AWS.

### G1. Hop A — `deployctl` credentials
- [ ] Define the least-privilege policy for SSM Run Command on the target instances/ASG.
- [ ] Define S3 read/write scoped to the history and artifact buckets/prefixes, and S3 write to the per-tenant frontend buckets.
- [ ] Define CloudWatch Logs read for the relevant log groups.
- [ ] Confirm where these credentials come from in a Bitbucket pipeline vs an operator machine.

> _Answer:_
>
> **Record in:** IAM, CONTEXT (Security Notes)

### G2. Hop B — EC2 instance role
- [ ] Define Secrets Manager read scoped to the tenant secrets the instances need.
- [ ] Confirm the instance role has no broader access than required for the deploy script.

> _Answer:_
>
> **Record in:** IAM, CONTEXT (Security Notes)

---

## Dependency summary

Which adapters each section unblocks, so answers can be sequenced by payoff:

| Section | Unblocks | Modules already waiting |
| --- | --- | --- |
| C (history S3) | S3 `DeployHistoryRepository` | deploy, rollback, status, cleanup (all) |
| A (SSM + EC2 script) | `SsmDeployExecutor`, `scripts/ec2/` | backend deploy, backend rollback |
| B (frontend S3 + build) | artifact store, sync, builder, smoke | frontend deploy, frontend rollback |
| F (repo access) | real `git` adapter + builds | ref resolution, both builds |
| D (CloudWatch) | logs adapter | `deployctl logs` |
| E (ASG bootstrap) | reconcile | Phase 10 (`Blocked`) |
| G (IAM) | all of the above running safely | everything against real AWS |

Section **C** is the highest-leverage single answer: it is the one adapter every command depends on. Section **A** and **B** unblock the two deploy paths independently of each other.
