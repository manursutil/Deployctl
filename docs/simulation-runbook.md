# Simulation Demo Runbook

Operator runbook for demonstrating the `deployctl` deployment model against the local Docker simulation lab (Sim Phases 1–5). It walks through backend/frontend deploy, status, rollback, logs, and a production replacement-instance recovery — all through the public CLI, with no real AWS access.

Read `docs/phase-0-simulation-plan.md` first for context. **Everything here is simulated.** Names, paths, and secret values are demo fixtures, not confirmed infrastructure (see `docs/phase-0-real-cutover.md`).

## Prerequisites

- Docker (Desktop or Engine) running.
- Node.js ≥ 22 and `npm install` run once in the repo.
- All commands run from the repo root.
- The simulation is selected entirely by `--config deployctl.sim.config.yml` (which sets `adapterMode: sim`) and `--tenants tenants.sim.yml`. Without those flags the same commands validate offline and report a "pending" boundary — that is the default `aws` behavior, not a bug.

Sanity check (optional):

```bash
npm test
npm run typecheck
```

## Part A — Staging walkthrough (single instance)

### 1. Start the staging app-server

```bash
docker compose -f docker-compose.sim.yml up -d --build
```

Wait until the container is healthy:

```bash
docker inspect -f '{{.State.Health.Status}}' deployctl-sim-app-server-staging
# healthy
```

### 2. List tenants

```bash
node --import tsx src/cli.ts tenants list --env staging --tenants tenants.sim.yml
# client1
```

### 3. Deploy the backend

Staging allows a moving branch ref, so `--ref main` is fine.

```bash
node --import tsx src/cli.ts deploy backend --tenant client1 --env staging --ref main \
  --config deployctl.sim.config.yml --tenants tenants.sim.yml
```

```text
Validated backend deploy for staging/client1 (ref main).
Backend deploy succeeded for staging/client1 (commit d7d717c27975f6e5113fd807c3ebf786a21e0f13).
```

(The exact commit SHA is whatever `main` points at when you run it.)

### 4. Read status

```bash
node --import tsx src/cli.ts status --tenant client1 --env staging \
  --config deployctl.sim.config.yml --tenants tenants.sim.yml
```

```text
Validated status query for staging/client1.
staging/client1/backend: d7d717c27975f6e5113fd807c3ebf786a21e0f13 (updated 2026-07-02T15:07:01.278Z, last successful dep_20260702_150701)
staging/client1/frontend: not deployed
```

### 5. Show the secret boundary (Hop A / Hop B)

`deployctl` only ever passes secret *names*. The deploy history event it writes contains no secret keys or values:

```bash
cat .deployctl-sim/history/deploys/staging/client1/backend/events/*.json \
  | python3 -m json.tool | grep -iE "secret|password" || echo "(none)"
# (none)
```

The tenant env file is written *inside the container*, where the server-side script resolves values from its local fixture (standing in for Secrets Manager). `deployctl` never sees these values:

```bash
docker exec deployctl-sim-app-server-staging cat /opt/sherwood/tenants/client1/env.staging.json
```

```json
{
  "DB_SECRET_NAME": "skincair/staging/db/client1",
  "DB_SECRET_VALUE": "***",
  "REDIS_SECRET_NAME": "skincair/staging/redis",
  "REDIS_SECRET_VALUE": "***"
}
```

(The real file shows the fixture values; they are redacted here. The point is that the *name* travels through `deployctl` and the *value* is resolved only on the server.)

### 6. Deploy the frontend twice, then roll back

Artifacts are keyed by resolved commit plus tenant/env build variables, so different commits produce different artifacts. Deploy an older commit, then `main`:

```bash
node --import tsx src/cli.ts deploy frontend --tenant client1 --env staging \
  --ref 79677ebd968e907fca2b2b348ac61116d86fb5a3 \
  --config deployctl.sim.config.yml --tenants tenants.sim.yml
# Frontend deploy succeeded for staging/client1 (commit 79677ebd..., built artifact).

node --import tsx src/cli.ts deploy frontend --tenant client1 --env staging --ref main \
  --config deployctl.sim.config.yml --tenants tenants.sim.yml
# Frontend deploy succeeded for staging/client1 (commit d7d717c2..., built artifact).
```

Roll the frontend back to the previous version. Rollback re-syncs the *exact recorded artifact* — it never rebuilds:

```bash
node --import tsx src/cli.ts rollback frontend --tenant client1 --env staging \
  --config deployctl.sim.config.yml --tenants tenants.sim.yml
```

```text
Validated frontend rollback for staging/client1 (to the previous version).
Frontend rollback succeeded for staging/client1 (now at 79677ebd968e907fca2b2b348ac61116d86fb5a3).
```

> Note: `deploy`/`rollback` derive their event id from the wall-clock second. Running two deploys of the same target within one second collides on the append-only event id — type them a moment apart (never an issue at human speed).

### 7. Read logs

The backend deploy wrote api/worker startup lines. Query the api service within the last hour:

```bash
node --import tsx src/cli.ts logs --tenant client1 --env staging --service api --since 1h \
  --config deployctl.sim.config.yml --tenants tenants.sim.yml
```

```text
Validated logs query for staging/client1/api (since 1h).
2026-07-02T15:07:01Z [staging/client1/api] api process started at d7d717c27975f6e5113fd807c3ebf786a21e0f13
```

`--since` accepts `s`/`m`/`h`/`d` (e.g. `--since 30m`); `--service` is `api` or `worker`.

### 8. Tear down staging

```bash
docker compose -f docker-compose.sim.yml down -v
rm -rf .deployctl-sim
```

## Part B — Production replacement demo (two instances)

This shows the problem Phase 10 solves: a replacement production instance can come up without the current release, and `deployctl reconcile backend` restores it from recorded state.

### 1. Start the production profile

```bash
docker compose -f docker-compose.sim.yml --profile production up -d --build
```

This adds `deployctl-sim-app-server-production-1` and `-2`, each with its own volume. Wait until both are healthy.

### 2. Deploy the backend to production

Production rejects moving branch refs, so `--ref main` is refused:

```bash
node --import tsx src/cli.ts deploy backend --tenant client1 --env production --ref main \
  --config deployctl.sim.config.yml --tenants tenants.sim.yml
# production does not allow moving branch refs: main
```

Deploy with a full commit SHA (or tag). Both instances get the release:

```bash
node --import tsx src/cli.ts deploy backend --tenant client1 --env production \
  --ref 79677ebd968e907fca2b2b348ac61116d86fb5a3 \
  --config deployctl.sim.config.yml --tenants tenants.sim.yml
# Backend deploy succeeded for production/client1 (commit 79677ebd...).

for c in production-1 production-2; do
  echo "$c -> $(docker exec deployctl-sim-app-server-$c readlink /opt/sherwood/tenants/client1/current)"
done
# production-1 -> /opt/sherwood/releases/79677ebd968e907fca2b2b348ac61116d86fb5a3
# production-2 -> /opt/sherwood/releases/79677ebd968e907fca2b2b348ac61116d86fb5a3
```

### 3. Simulate a replacement instance

Recreate `production-2` with a fresh, empty volume:

```bash
docker compose -f docker-compose.sim.yml --profile production rm -sf app-server-production-2
docker volume rm deployctl_sherwood-production-2
docker compose -f docker-compose.sim.yml --profile production up -d app-server-production-2
```

The replacement lacks the current release — this is the Phase 10 problem:

```bash
for c in production-1 production-2; do
  echo -n "$c -> "; docker exec deployctl-sim-app-server-$c readlink /opt/sherwood/tenants/client1/current 2>/dev/null || echo "(no current symlink)"
done
# production-1 -> /opt/sherwood/releases/79677ebd968e907fca2b2b348ac61116d86fb5a3
# production-2 -> (no current symlink)
```

### 4. Reconcile

`reconcile` reads the desired version from `current.json` and re-prepares that release on every instance (the server script is idempotent, so `production-1` is unaffected):

```bash
node --import tsx src/cli.ts reconcile backend --tenant client1 --env production \
  --config deployctl.sim.config.yml --tenants tenants.sim.yml
# Backend reconcile succeeded for production/client1: 2 instance(s) at 79677ebd968e907fca2b2b348ac61116d86fb5a3.

for c in production-1 production-2; do
  echo "$c -> $(docker exec deployctl-sim-app-server-$c readlink /opt/sherwood/tenants/client1/current)"
done
# production-1 -> /opt/sherwood/releases/79677ebd968e907fca2b2b348ac61116d86fb5a3
# production-2 -> /opt/sherwood/releases/79677ebd968e907fca2b2b348ac61116d86fb5a3
```

### 5. Tear down

```bash
docker compose -f docker-compose.sim.yml --profile production down -v
rm -rf .deployctl-sim
```

## Reset

The simulation keeps all state in two places, both safe to delete between runs:

- Containers and their volumes: `docker compose -f docker-compose.sim.yml [--profile production] down -v`.
- Host-side history/artifacts/logs: `rm -rf .deployctl-sim` (git-ignored). `DEPLOYCTL_SIM_ROOT` can point this elsewhere for isolation.

Order matters: bring the stack **down before** deleting `.deployctl-sim`. The container bind-mounts `.deployctl-sim/logs`, so removing that directory while the stack is up leaves a stale mount. Then bring the stack back up (Docker recreates the directory) before deploying again.

## What the demo proves (and does not)

Proves:

- Backend and frontend deploy independently per tenant/env through the same orchestration the real AWS path will use.
- Deploy history and current state follow the intended S3 record shape.
- Rollback restores a recorded artifact/version without rebuilding or re-resolving a ref.
- Secret *values* never pass through `deployctl` (Hop B).
- Production rejects moving branch refs.
- A replacement instance's missing-release problem, and reconcile as the recovery path.

Does not prove (still Phase 0 / later work):

- Real EC2 paths, PM2 process model, CloudWatch naming, Secrets Manager, or IAM.
- Real ASG instance resolution and bootstrap behavior (Phase 10 stays blocked).
- A real application build — release directories and frontend artifacts are synthesized markers, not built from a real app repo.
