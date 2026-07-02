#!/usr/bin/env bash
# EC2-local backend deploy script (docs/initial-architecture-proposal.md §7).
# Runs on the target instance via SSM Run Command in production, or via
# `docker exec` against the Sim Phase 2 app-server container
# (src/adapters/docker-ssm.ts). All paths and the OS user come from the
# environment below so real cutover only needs a value change, not a rewrite
# (docs/phase-0-simulation-plan.md, Sim Phase 2).
set -euo pipefail

: "${DEPLOYCTL_RELEASE_ROOT:?DEPLOYCTL_RELEASE_ROOT is required}"
: "${DEPLOYCTL_TENANT_BASE_DIR:?DEPLOYCTL_TENANT_BASE_DIR is required}"
: "${DEPLOYCTL_OS_USER:?DEPLOYCTL_OS_USER is required}"
: "${DEPLOYCTL_COMMIT:?DEPLOYCTL_COMMIT is required}"
: "${DEPLOYCTL_ENV:?DEPLOYCTL_ENV is required}"
: "${DEPLOYCTL_TENANT:?DEPLOYCTL_TENANT is required}"
: "${DEPLOYCTL_API_PROCESS:?DEPLOYCTL_API_PROCESS is required}"
: "${DEPLOYCTL_WORKER_PROCESS:?DEPLOYCTL_WORKER_PROCESS is required}"
: "${DEPLOYCTL_DB_SECRET_NAME:?DEPLOYCTL_DB_SECRET_NAME is required}"
: "${DEPLOYCTL_REDIS_SECRET_NAME:?DEPLOYCTL_REDIS_SECRET_NAME is required}"

secret_fixtures="/opt/deployctl/secret-fixtures.json"
release_dir="$DEPLOYCTL_RELEASE_ROOT/$DEPLOYCTL_COMMIT"

# 1. Prepare the immutable release directory (commit-keyed, per tenant symlinks
# point at one of these). No real build here yet: fixture app repo checkout
# and install/build are out of scope for Sim Phase 2 (docs section F).
mkdir -p "$release_dir"
cat > "$release_dir/release.json" <<JSON
{
  "commit": "$DEPLOYCTL_COMMIT",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployedBy": "$DEPLOYCTL_OS_USER"
}
JSON

# 2. Point the tenant's current release at it.
mkdir -p "$DEPLOYCTL_TENANT_BASE_DIR"
ln -sfn "$release_dir" "$DEPLOYCTL_TENANT_BASE_DIR/current"

# 3. Generate the protected tenant env file. deployctl only ever passed secret
# *names* (DEPLOYCTL_DB_SECRET_NAME, DEPLOYCTL_REDIS_SECRET_NAME); this script
# resolves values locally (Hop B). In production this reads Secrets Manager
# via the EC2 instance role instead of this fixture file.
resolve_secret() {
  node -e "
    const fixtures = require('$secret_fixtures');
    const name = process.argv[1];
    if (!(name in fixtures)) {
      process.stderr.write('Unknown secret fixture: ' + name + '\n');
      process.exit(1);
    }
    process.stdout.write(fixtures[name]);
  " "$1"
}

db_secret_value=$(resolve_secret "$DEPLOYCTL_DB_SECRET_NAME")
redis_secret_value=$(resolve_secret "$DEPLOYCTL_REDIS_SECRET_NAME")

env_file="$DEPLOYCTL_TENANT_BASE_DIR/env.$DEPLOYCTL_ENV.json"
cat > "$env_file" <<JSON
{
  "DB_SECRET_NAME": "$DEPLOYCTL_DB_SECRET_NAME",
  "DB_SECRET_VALUE": "$db_secret_value",
  "REDIS_SECRET_NAME": "$DEPLOYCTL_REDIS_SECRET_NAME",
  "REDIS_SECRET_VALUE": "$redis_secret_value"
}
JSON
chmod 600 "$env_file"

# 4. Restart only this tenant's processes. No real PM2 here: a status marker
# stands in for the process supervisor (docs/phase-0-simulation-plan.md
# describes this as an acceptable "lightweight process mock").
cat > "$DEPLOYCTL_TENANT_BASE_DIR/process-status.json" <<JSON
{
  "apiProcess": "$DEPLOYCTL_API_PROCESS",
  "workerProcess": "$DEPLOYCTL_WORKER_PROCESS",
  "status": "online",
  "version": "$DEPLOYCTL_COMMIT",
  "restartedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

# 5. Health check before declaring success.
curl -fsS http://localhost:8080/health > /dev/null

# 6. Simulation-only: emit a startup log line per service so `deployctl logs` has
# something to read (Sim Phase 4). Guarded by DEPLOYCTL_LOG_ROOT, which only the sim
# executor sets — the real script logs to the process's stdout (captured by
# CloudWatch), not to a file, so production never takes this branch.
if [ -n "${DEPLOYCTL_LOG_ROOT:-}" ]; then
  log_dir="$DEPLOYCTL_LOG_ROOT/$DEPLOYCTL_ENV/$DEPLOYCTL_TENANT"
  mkdir -p "$log_dir"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for service in api worker; do
    printf '{"timestamp":"%s","env":"%s","tenant":"%s","service":"%s","message":"%s process started at %s"}\n' \
      "$now" "$DEPLOYCTL_ENV" "$DEPLOYCTL_TENANT" "$service" "$service" "$DEPLOYCTL_COMMIT" \
      >> "$log_dir/$service.log"
  done
fi

echo "deploy-backend: tenant=$DEPLOYCTL_TENANT env=$DEPLOYCTL_ENV commit=$DEPLOYCTL_COMMIT ok"
