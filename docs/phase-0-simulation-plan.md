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

The core modules already depend on seams. The simulation should implement local adapters behind those seams, then wire them through a demo command path or config profile.

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

The target demo should fit in one terminal session:

```bash
docker compose -f docker-compose.sim.yml up -d
npm test
npm run typecheck
node --import tsx src/cli.ts tenants list --env staging --tenants tenants.sim.yml
node --import tsx src/cli.ts deploy backend --tenant client1 --env staging --ref main --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts status --tenant client1 --env staging --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts deploy frontend --tenant client1 --env staging --ref main --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts rollback frontend --tenant client1 --env staging --config deployctl.sim.config.yml --tenants tenants.sim.yml
node --import tsx src/cli.ts logs --tenant client1 --env staging --service api --since 1h --config deployctl.sim.config.yml --tenants tenants.sim.yml
```

The exact flags may change as the CLI controllers are wired, but the demo must use public CLI commands rather than test-only entrypoints.

## Implementation Phases

### Sim Phase 1: Local Persistence

- Add filesystem-backed history repository.
- Wire `status` to read simulated current state when using `deployctl.sim.config.yml`.
- Add tests for append-only events, current state, and guardrail behavior through the adapter.

### Sim Phase 2: Backend Container

- Add Docker Compose app-server.
- Add EC2-local backend deploy script.
- Add simulated SSM executor that runs the script in the container.
- Wire backend deploy/rollback CLI to the simulated executor.

### Sim Phase 3: Frontend Artifacts

- Add filesystem artifact store and sync adapters.
- Add fixture frontend build.
- Wire frontend deploy/rollback CLI to simulated adapters.

### Sim Phase 4: Logs And Diagnostics

- Add local logs adapter.
- Implement `deployctl logs` against the adapter seam.
- Add API/worker log fixtures in the app-server container.

### Sim Phase 5: Production Replacement Demo

- Add multi-container production profile.
- Demonstrate clean replacement instance behavior.
- Implement or document simulated reconciliation.

### Sim Phase 6: Demo Runbook

- Add a short operator demo script or runbook.
- Include reset instructions for `.deployctl-sim/`.
- Include expected output snippets without secrets.

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
