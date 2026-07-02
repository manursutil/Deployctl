# Phase 0 Simulation Plan

Plan to build a Docker-based simulation of the Phase 0 infrastructure facts so `deployctl` can be demonstrated and developed end to end before the real AWS/EC2 answers are available.

This plan does not replace Phase 0 discovery. It creates a controlled demo environment that mirrors the expected contracts from `docs/phase-0-checklist.md`. Every simulated value must be easy to swap for the confirmed real value later.

## Goal

Provide a local environment where the project can demonstrate:

- Backend deploy by tenant and environment.
- Frontend artifact build/reuse and tenant sync.
- Deploy history and current state.
- Rollback.
- Status.
- Logs through a CloudWatch-like adapter boundary.
- Production replacement-instance behavior through a clean container/reconcile scenario.

The demo should prove the deployment model and adapter contracts without requiring real AWS access, real EC2 hosts, or final Phase 0 answers.

## Non-Goals

- Do not make Docker the production deployment path.
- Do not introduce ECS, ECR, Kubernetes, or container image deploys for v1.
- Do not treat simulated names, paths, IAM policies, or log group patterns as confirmed infrastructure.
- Do not store real secrets in the repo or in demo fixtures.
- Do not bypass the existing TypeScript orchestration modules. The simulation must call the same core seams that AWS adapters will call later.

## Simulation Architecture

Use Docker Compose as a local "mini AWS + EC2" lab:

```text
deployctl on host
  -> local adapter mode
  -> simulated SSM executor
  -> app-server container
  -> /opt/sherwood/releases/<commit>
  -> /opt/sherwood/tenants/<tenant>/current
  -> PM2-like process supervisor or lightweight process mock
  -> health endpoint

deployctl on host
  -> local history/artifact/log adapters
  -> mounted volumes or LocalStack
```

Prefer filesystem-backed adapters first because they are simpler for a demo and deterministic in tests. Use LocalStack only where the AWS API behavior itself matters.

Recommended first pass:

- `docker-compose.sim.yml`
- `docker/sim/app-server/Dockerfile`
- `docker/sim/app-server/entrypoint.sh`
- `scripts/ec2/deploy-backend.sh`
- `.deployctl-sim/` runtime directory ignored by Git
- `deployctl.sim.config.yml`
- `tenants.sim.yml`

## Adapter Strategy

The core modules already depend on seams. The simulation should implement local adapters behind those seams, then wire them through the CLI controllers.

### Adapter selection (decide before Sim Phase 1)

This is the load-bearing decision for the whole simulation. The current CLI controllers do not inject adapters — they validate offline and then unconditionally throw a "pending" error (`runDeployBackend`, `runDeployFrontend`, `runStatus` in `src/cli.ts`). The simulation is not "wire adapters behind existing seams"; it is "give the controllers a way to select an adapter set, then replace the hardcoded throw with real execution when the simulation set is selected."

Decision: add an explicit `adapterMode: aws | sim` field to `deployctl.config.yml` (default `aws`). `deployctl.sim.config.yml` sets `adapterMode: sim`. The controller reads the mode and constructs either the pending-throw path (`aws`, until real adapters land) or the filesystem/Docker simulation adapters (`sim`).

Constraints:

- Production must keep defaulting to the pending-throw. Simulation adapters must never be reachable without `adapterMode: sim`, so a real deploy cannot accidentally run against local filesystem state.
- Adapter construction stays in the controller (or a small factory it calls); `core/` orchestration modules keep receiving seams as arguments and must not learn about the mode.

| Real adapter | Simulation adapter | Purpose |
| --- | --- | --- |
| `SsmDeployExecutor` | Docker exec/local command executor | Run the same EC2-local deploy script inside the app-server container. |
| S3 deploy history | Filesystem history repository | Persist events and `current.json` under `.deployctl-sim/history`. |
| S3 frontend artifact store | Filesystem artifact store | Store tarballs or expanded artifacts under `.deployctl-sim/artifacts`. |
| S3 frontend sync | Filesystem bucket sync | Sync to `.deployctl-sim/frontend-buckets/<env>/<tenant>`. |
| CloudWatch Logs | Filesystem or LocalStack logs adapter | Query logs by env, tenant, service, and time. |
| Secrets Manager on EC2 | Local secret fixture read by app-server script | Keep the Hop B shape: `deployctl` passes names only; the server-side script resolves values. |
| Git/Bitbucket | Local fixture repository or existing `GitCliRefResolver` | Resolve refs to immutable commits without changing the core contract. |
| ASG target selection | One or more app-server containers | Show single-instance staging and multi-instance production behavior. |

## What To Simulate From Phase 0

### A. Backend SSM Deploy

Simulate the assumed EC2 layout:

- `/opt/sherwood/releases/<commit-sha>`
- `/opt/sherwood/tenants/<tenant>/current`
- `/opt/sherwood/tenants/<tenant>/env.production.json`

Implementation tasks:

- Create an app-server image with Node.js and shell tooling needed by the backend deploy script.
- Add a mounted `/opt/sherwood` volume so release state survives container restarts during the demo.
- Implement `scripts/ec2/deploy-backend.sh` against the simulated paths.
- Use tenant config for `apiProcess`, `workerProcess`, `appBaseDir`, and health URL.
- Restart only the selected tenant's simulated API/worker processes.
- Generate the tenant env file from secret names passed into the script.
- Make permissions visible in the demo, even if the local container user is simplified.

Demo acceptance:

- `deployctl deploy backend --tenant client1 --env staging --ref <ref>` creates a release directory, updates the tenant symlink, restarts that tenant's processes, records history, and passes health check.

### B. Frontend Artifact And Sync

Simulate tenant-specific frontend builds:

- Use a tiny fixture frontend if the real app repository is unavailable.
- Build output must include tenant/env values so the demo proves artifact identity matters.
- Store artifacts by resolved commit plus build-config fingerprint.
- Sync the selected artifact into the tenant's simulated frontend bucket directory.

Demo acceptance:

- First frontend deploy builds and stores an artifact.
- Repeating the same deploy reuses the artifact.
- Changing a build variable creates a different artifact key.
- Rollback syncs the exact recorded artifact instead of rebuilding.

### C. Deploy History And Current State

Use a filesystem-backed repository with the same logical layout as the proposed S3 layout:

```text
.deployctl-sim/history/deploys/<env>/<tenant>/<app>/events/<event-id>.json
.deployctl-sim/history/deploys/<env>/<tenant>/<app>/current.json
```

Implementation tasks:

- Implement a local `DeployHistoryRepository` adapter.
- Preserve append-only event behavior.
- Preserve the `current.json.inProgress` guardrail behavior.
- Add a demo reset command or documented cleanup step for `.deployctl-sim/`.

Demo acceptance:

- `deployctl status --tenant client1 --env staging` reads the simulated current state.
- Guardrail conflict can be demonstrated by seeding or holding `inProgress`.

### D. Logs

Logs can be simulated, but the real Phase 0 answer still needs CloudWatch naming.

Recommended simulation:

- API and worker processes write JSON-ish lines with `timestamp`, `env`, `tenant`, `service`, and `message`.
- The logs adapter reads from `.deployctl-sim/logs/<env>/<tenant>/<service>.log`.
- `deployctl logs` filters by env, tenant, service, and time range.

Optional stronger simulation:

- Use LocalStack CloudWatch Logs and write streams named after the assumed production pattern.

Demo acceptance:

- `deployctl logs --tenant client1 --env staging --service api --since 1h` returns only matching API entries.

### E. Production ASG Bootstrap

Simulate replacement production instances by starting a fresh app-server container with an empty `/opt/sherwood` volume.

Implementation tasks:

- Run two production app-server containers in Compose.
- Deploy backend to both.
- Remove one container volume or start a third clean container.
- Demonstrate whether the clean instance can reconcile from `current.json`.

Demo acceptance:

- The demo can show the problem Phase 10 solves: a replacement instance may not have the current release.
- If `deployctl reconcile backend` is implemented for the simulation, it prepares missing releases to match current state.

Implemented in Sim Phase 5 (see below): the `production` compose profile runs two app-servers with independent volumes; recreating one with a fresh volume shows the missing-release problem; `deployctl reconcile backend` re-prepares the current release from `current.json`. Reconcile also surfaced the production ref policy (a branch ref like `main` is rejected for production; deploy with a full SHA or tag).

### F. Repository Access

Use a local fixture Git repository for demo ref resolution if the real application repo is not available.

Implementation tasks:

- Create or document a fixture app repository with backend and frontend subdirectories.
- Ensure refs resolve through the same `RefResolver` contract.
- Keep production ref policy behavior visible: moving branch refs are rejected for production.

Demo acceptance:

- Staging accepts a branch ref.
- Production accepts a tag or full SHA and rejects a branch.

### G. IAM

IAM cannot be truly simulated with Docker, but the demo can prove the permission boundary shape.

Implementation tasks:

- Document simulated Hop A permissions: run command, read/write history/artifacts, sync frontend bucket, read logs.
- Document simulated Hop B permissions: app-server may read only named secret fixtures.
- Add negative tests or demo checks showing `deployctl` never receives secret values.

Demo acceptance:

- Deploy history and CLI output contain secret names at most, never secret values.

## Demo Flow

Sim Phases 1–5 are implemented, so this flow runs today through public CLI commands. The full operator walkthrough — with expected output, the production replacement demo, reset instructions, and a secret-safety note — lives in `docs/simulation-runbook.md` (Sim Phase 6). The staging happy path in one terminal session:

```bash
docker compose -f docker-compose.sim.yml up -d --build
node --import tsx src/cli.ts tenants list --env staging --tenants tenants.sim.yml
node --import tsx src/cli.ts deploy backend --tenant client1 --env staging --ref main --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts status --tenant client1 --env staging --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts deploy frontend --tenant client1 --env staging --ref main --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts rollback frontend --tenant client1 --env staging --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts logs --tenant client1 --env staging --service api --since 1h --config deployctl.sim.config.yml --tenants tenants.sim.yml
docker compose -f docker-compose.sim.yml down -v && rm -rf .deployctl-sim
```

The demo uses public CLI commands rather than test-only entrypoints. See the runbook for the production replacement demo (`--profile production` + `deployctl reconcile backend`).

## Implementation Phases

### Sim Phase 1: Local Persistence

Status: `Done`

- [x] Add the `adapterMode: aws | sim` config field and `deployctl.sim.config.yml` (see "Adapter selection").
- [x] Add `.deployctl-sim/` to `.gitignore` (it is not currently ignored).
- [x] Add filesystem-backed history repository behind the `DeployHistoryRepository` seam.
- [x] Wire `status` to read simulated current state when `adapterMode: sim`.
- [x] Add tests for append-only events, current state, and guardrail behavior through the adapter.

Completed: `src/adapters/filesystem-history.ts` (`FileSystemDeployHistoryRepository`) persists events and `current.json` under `.deployctl-sim/history/deploys/<env>/<tenant>/<app>/`, reusing the existing `validateHistoryEvent`/`validateCurrentState` guards. `deployctl status --config deployctl.sim.config.yml` reads through it (`src/cli.ts`); `DEPLOYCTL_SIM_ROOT` overrides the root directory for test isolation. Covered by `test/filesystem-history.test.ts` and the sim-mode cases in `test/cli.test.ts`.

Note: no deploy command populates state until Sim Phase 2/3, so `status` here is demonstrated against hand-seeded `current.json` records (also used to demo the `inProgress` guardrail conflict).

### Sim Phase 2: Backend Container

Status: `Done`

- [x] Add Docker Compose app-server.
- [x] Add EC2-local backend deploy script.
- [x] Add simulated SSM executor that runs the script in the container.
- [x] Keep `scripts/ec2/deploy-backend.sh` path-parameterized: read the release root, tenant base dir, and OS user from config/env rather than hardcoding `/opt/sherwood/...`, so real cutover is a value change, not a rewrite (non-goal: simulated paths must not become production defaults).
- [x] Wire the backend deploy CLI controller to the simulated executor (replaces the current pending-throw when `adapterMode: sim`).

Completed: `docker-compose.sim.yml` + `docker/sim/app-server/` build one staging "EC2" container (Node health server, `/opt/sherwood` named volume, `scripts/ec2/` bind-mounted read-only). `scripts/ec2/deploy-backend.sh` reads `DEPLOYCTL_RELEASE_ROOT`/`DEPLOYCTL_TENANT_BASE_DIR`/`DEPLOYCTL_OS_USER` from its environment (never hardcoded), prepares the release directory, updates the tenant symlink, resolves secret values from `docker/sim/app-server/secret-fixtures.json` inside the container (deployctl only ever passes secret names — `DockerSimSsmDeployExecutor`, `src/adapters/docker-ssm.ts` — keeping the Hop B shape), writes a process-status marker standing in for a PM2 restart, and gates on a real HTTP health check. `deployctl deploy backend --config deployctl.sim.config.yml` (`src/cli.ts`) runs this through the existing `deployBackend` orchestration and `GitCliRefResolver` pointed at this repo (`applicationRepository.url: .`, no fixture repo needed). Scope: staging only, single container, no real app build (release directories are metadata markers) — multi-instance/production and a real fixture app repo are later phases. Covered by `test/docker-ssm.test.ts` (mocked); the full path was verified manually against a real container (see PR).

### Sim Phase 3: Frontend Artifacts

Status: `Done`

- [x] Add filesystem artifact store and sync adapters behind the frontend seams.
- [x] Add fixture frontend build behind the `FrontendBuilder` seam.
- [x] Wire frontend deploy and both rollback controllers to the simulated adapters (replaces the pending-throw when `adapterMode: sim`).

Correction: an earlier draft of this phase said the `deployctl rollback backend|frontend` CLI controllers "do not exist yet ... not dispatched in `src/cli.ts`." That was stale — they were added with real (pending-throw) implementations in Phase 8 and are dispatched (`runRollbackBackend`/`runRollbackFrontend`); this phase only added their `adapterMode: sim` wiring.

Completed: `src/adapters/filesystem-frontend.ts` provides `FileSystemFrontendArtifactStore` (stores artifacts under `<rootDir>/artifacts/<storageKey>`, where `storageKey` already carries commit + env + tenant + build-config fingerprint) and `FileSystemFrontendSync` (copies the stored artifact to `<rootDir>/frontend-buckets/<bucket>/index.html`). `src/adapters/fixture-frontend.ts` provides `FixtureFrontendBuilder` (no real git checkout/npm build — synthesizes an `index.html` embedding the commit, env, tenant, and exact build variables, so identity-sensitive builds are visible, not just an opaque hash) and `NoopFrontendSmokeCheck`. `deployctl deploy frontend --config deployctl.sim.config.yml` runs the existing `deployFrontend` orchestration through these plus `GitCliRefResolver` and `FileSystemDeployHistoryRepository`, synthesizing `buildVariables` `{ VITE_TENANT, VITE_ENVIRONMENT }` (a simulation assumption; the real per-tenant/env build-variable source is a Phase 0 confirmation). `rollback backend` reuses the Sim Phase 2 executor unchanged; `rollback frontend` re-syncs the exact recorded artifact via `FileSystemFrontendSync` with no builder in scope, so it structurally cannot rebuild.

Path deviation from this plan's earlier suggestion (`.deployctl-sim/frontend-buckets/<env>/<tenant>`): the `FrontendSync` seam only receives the tenant's bucket name, so the adapter keys the bucket directory by `tenant.frontendBucket` instead of env/tenant, avoiding a core seam-signature change for no functional gain.

Covered by `test/filesystem-frontend.test.ts`, `test/fixture-frontend.test.ts`, and sim-mode CLI tests in `test/cli.test.ts` (first deploy builds, repeat reuses, a changed build variable produces a different key, rollback re-syncs the earlier artifact). `rollback backend` in sim mode shells out to Docker, so per the Sim Phase 2 precedent it is verified manually against the running container, not via an automated docker-dependent test.

### Sim Phase 4: Logs And Diagnostics

Status: `Done`

Note: this was more than an adapter. `deployctl logs` had no core and no seam — this phase added net-new Phase 9 core work.

- [x] Define the logs query seam in `core/` (env/tenant/service/time-range filter) and the `deployctl logs` controller.
- [x] Add a filesystem logs adapter behind that seam, reading `.deployctl-sim/logs/<env>/<tenant>/<service>.log`.
- [x] Add API/worker log fixtures written by the app-server container.

Completed: `src/core/logs.ts` defines the `LogQuery` seam (given an absolute `since` cutoff, mirroring CloudWatch `startTime`) plus `getTenantLogs` (parses the `--since` duration, queries, returns oldest-first), `parseSinceDuration`, `parseLogService`, and `formatLogEntries`. `src/adapters/filesystem-logs.ts` (`FileSystemLogQuery`) reads newline-delimited JSON entries from `.deployctl-sim/logs/<env>/<tenant>/<service>.log`, selecting env/tenant/service by path and filtering by the cutoff. `deployctl logs --tenant <t> --env <e> --service <api|worker> --since <dur>` (`src/cli.ts`) runs the query when `adapterMode: sim`, else reports the pending CloudWatch boundary. Log fixtures are written by the container: `scripts/ec2/deploy-backend.sh` appends a startup line per service to `$DEPLOYCTL_LOG_ROOT/<env>/<tenant>/<service>.log` (guarded so only the sim executor triggers it — production logs to stdout for CloudWatch), `DockerSimSsmDeployExecutor` passes that root, and `docker-compose.sim.yml` bind-mounts it to the host `.deployctl-sim/logs` so the CLI reads what the deploy wrote.

Covered by `test/logs.test.ts` (duration parsing, service validation, query orchestration, formatting), `test/filesystem-logs.test.ts` (path selection, `since` filtering, missing-file, malformed-line), and sim-mode CLI tests in `test/cli.test.ts`. The container-written fixtures were verified manually (a sim backend deploy then `deployctl logs --service api --since 1h` returns the entry; `--since 1s` returns none). CloudWatch log group/stream naming remains a Phase 0 confirmation; the optional LocalStack CloudWatch variant was not built.

### Sim Phase 5: Production Replacement Demo

Status: `Done`

- [x] Add multi-container production profile.
- [x] Demonstrate clean replacement instance behavior.
- [x] Implement simulated reconciliation.

Completed: `docker-compose.sim.yml` gains two production app-servers behind a `production` compose profile (default `up` stays staging-only), each with its own `/opt/sherwood` volume so one can be recreated clean to stand in for a replacement ASG instance. `deployctl.sim.config.yml`'s production target is `instanceIds` listing the two container names (real infra is an ASG); `tenants.sim.yml` gains a `production/client1` tenant and the container secret fixtures gain the production secret names. `src/core/reconcile.ts` (`reconcileBackend`) reads the recorded current version from `current.json` and re-runs the same `SsmDeployExecutor` deploy for that commit on every configured instance — resolving no ref, recording no new version, changing no current state — so a replacement container with an empty release root is brought back to the desired version. `deployctl reconcile backend --tenant <t> --env <e>` (`src/cli.ts`) runs it under `adapterMode: sim`, else reports the pending Phase 10 boundary.

Covered by `test/reconcile.test.ts` (current-version read, no-current-version, partial_failure, executor-throw guardrail clearing, in-progress conflict) and CLI tests in `test/cli.test.ts`. The full replacement demo was verified manually: deploy backend to production (both containers get the release), recreate `production-2` with a fresh volume (it lacks the current release — the Phase 10 problem), then `reconcile backend` re-prepares it so both instances match `current.json`. The manual demo commands are captured in the Sim Phase 6 runbook.

Scope: this simulates the Phase 10 mechanism; real ASG reconciliation (resolving healthy ASG instances, real bootstrap behavior) stays blocked on Phase 0 discovery. Reconcile re-runs the deploy on all configured instances rather than diffing per instance first — the server script is idempotent, so an instance already at the current release is unaffected.

### Sim Phase 6: Demo Runbook

Status: `Done`

- [x] Add a short operator demo script or runbook.
- [x] Include reset instructions for `.deployctl-sim/`.
- [x] Include expected output snippets without secrets.

Completed: `docs/simulation-runbook.md` is the operator runbook — a staging walkthrough (backend/frontend deploy, status, the secret-name-only boundary, frontend rollback, logs) and the production replacement demo (two-instance deploy, replacement recreation, `reconcile backend`), all through public CLI commands. It includes reset instructions for the containers/volumes and `.deployctl-sim/`, and a "what this proves / does not prove" section. Output snippets were captured from real runs with secret values redacted. This completes the simulation lane (Sim Phases 1–6).

## Documentation Updates Required During Implementation

Update these files in the same change set as the simulation work:

- `docs/implementation-plan.md`: mark simulation progress and any phase unblocked for demo.
- `CONTEXT.md`: record new simulated config files, commands, paths, and the rule that simulation values are not production facts.
- `docs/phase-0-checklist.md`: optionally add simulated answers in a clearly labeled "Simulation answer" note, without checking them as confirmed real answers.
- `docs/phase-0-real-cutover.md`: keep the replacement list current as adapters land.

## Done Criteria

The simulation is ready for a stakeholder demo when:

- Docker Compose starts from a clean checkout.
- Backend deploy, frontend deploy, rollback, status, and logs run through public CLI commands.
- The demo proves secret values stay out of `deployctl`.
- The demo produces deploy history and current state records that match the real S3 contract shape.
- A clean replacement-instance scenario can be shown or explained from the simulation.
- The docs clearly separate simulated assumptions from real Phase 0 confirmations.
