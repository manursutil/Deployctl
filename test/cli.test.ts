import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileSystemDeployHistoryRepository } from "../src/adapters/filesystem-history.js";
import { applySuccessfulEventToCurrentState } from "../src/core/history.js";

const cliPath = join(process.cwd(), "src/cli.ts");

// Sim CLI deploys derive their event id from the wall-clock second
// (dep_YYYYMMDD_HHMMSS) and there is no id injection point through the public CLI.
// Two deploys to the same target within one second would collide on the append-only
// event id, so tests that deploy the same target twice must cross a second boundary
// first. Manual demo use never hits this; back-to-back automated deploys do.
async function waitForNextEventIdSecond(): Promise<void> {
  const startSecond = new Date().toISOString().slice(0, 19);
  while (new Date().toISOString().slice(0, 19) === startSecond) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const simTenantsYaml = `staging:
  client1:
    frontendBucket: skincair-staging-frontend-client1
    dbSecret: skincair/staging/db/client1
    redisSecret: skincair/staging/redis
    apiProcess: sherwood-api-client1
    workerProcess: sherwood-worker-client1
    appBaseDir: /opt/sherwood/tenants/client1
    backendHealthUrl: https://client1.sherwood.science/health
    frontendUrl: https://client1.sherwood.science
`;

async function writeSimConfig(dir: string): Promise<string> {
  const configPath = join(dir, "deployctl.sim.config.yml");
  await writeFile(
    configPath,
    `adapterMode: sim
aws:
  region: eu-west-1
applicationRepository:
  # Points at this repo, like deployctl.sim.config.yml, so git ls-remote resolves
  # real refs (e.g. "main") without a separate fixture repository.
  url: .
build:
  backend:
    packageManager: npm
    installCommand: npm ci
    buildCommand: npm run build
  frontend:
    packageManager: npm
    installCommand: npm ci
    buildCommand: npm run build
    buildConfigIdentityInputs:
      - VITE_TENANT
deployHistory:
  bucket: deploy-history
  prefix: deploys
frontendArtifacts:
  bucket: deploy-artifacts
  prefix: frontend
refPolicies:
  staging:
    allowMovingBranches: true
  production:
    allowMovingBranches: false
ssmTargets:
  staging:
    mode: instanceIds
    instanceIds:
      - i-0abc123staging
  production:
    mode: asg
    autoScalingGroupName: sherwood-prod-asg
backendDeploy:
  releaseRoot: /opt/sherwood/releases
  osUser: sherwood
retention:
  successfulVersionsPerTarget: 10
  keepDays: 30
`,
  );
  return configPath;
}

test("deployctl --help prints usage", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /deployctl deploy backend\|frontend/);
  assert.match(result.stdout, /deployctl rollback backend\|frontend/);
  assert.match(result.stdout, /deployctl cleanup releases\|artifacts/);
  assert.equal(result.stderr, "");
});

test("deployctl tenants list prints tenants for an environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deployctl-tenants-"));
  const tenantsPath = join(dir, "tenants.yml");

  await writeFile(
    tenantsPath,
    `staging:
  client1:
    frontendBucket: skincair-staging-frontend-client1
    dbSecret: skincair/staging/db/client1
    redisSecret: skincair/staging/redis
    apiProcess: sherwood-api-client1
    workerProcess: sherwood-worker-client1
    appBaseDir: /opt/sherwood/tenants/client1
    backendHealthUrl: https://client1.sherwood.science/health
    frontendUrl: https://client1.sherwood.science
  client2:
    frontendBucket: skincair-staging-frontend-client2
    dbSecret: skincair/staging/db/client2
    redisSecret: skincair/staging/redis
    apiProcess: sherwood-api-client2
    workerProcess: sherwood-worker-client2
    appBaseDir: /opt/sherwood/tenants/client2
    backendHealthUrl: https://client2.sherwood.science/health
    frontendUrl: https://client2.sherwood.science
`,
  );

  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "tenants", "list", "--env", "staging", "--tenants", tenantsPath], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "client1\nclient2\n");
  assert.equal(result.stderr, "");
});

test("deployctl tenants list exits non-zero with a clear message for missing tenants config", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "tenants", "list", "--env", "staging", "--tenants", "does-not-exist.yml"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not read tenants config at does-not-exist.yml/);
});

test("deployctl status rejects an unknown tenant before any AWS work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "status", "--tenant", "ghost", "--env", "staging"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tenant not found in staging: ghost/);
});

test("deployctl status validates inputs and reports that the history adapter is still pending", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "status", "--tenant", "client1", "--env", "staging"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet readable/);
});

test("deployctl status reads simulated current state when adapterMode is sim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deployctl-sim-status-"));
  const configPath = await writeSimConfig(dir);
  const tenantsPath = join(dir, "tenants.yml");
  await writeFile(tenantsPath, simTenantsYaml);

  const simRoot = join(dir, ".deployctl-sim");
  const repository = new FileSystemDeployHistoryRepository(simRoot);
  const deployEvent = {
    eventId: "dep_20260701_100000",
    type: "deploy" as const,
    env: "staging",
    tenant: "client1",
    app: "backend" as const,
    requestedRef: "main",
    resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
    status: "success" as const,
    startedAt: "2026-07-01T10:00:00Z",
    finishedAt: "2026-07-01T10:02:00Z",
    actor: "manual",
  };
  await repository.appendEvent(deployEvent);
  await repository.updateCurrentState(applySuccessfulEventToCurrentState(deployEvent));

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "status", "--tenant", "client1", "--env", "staging", "--config", configPath, "--tenants", tenantsPath],
    { encoding: "utf8", env: { ...process.env, DEPLOYCTL_SIM_ROOT: simRoot } },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /staging\/client1\/backend: 0123456789abcdef0123456789abcdef01234567/);
});

test("deployctl status surfaces the inProgress guardrail from simulated current state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deployctl-sim-status-guardrail-"));
  const configPath = await writeSimConfig(dir);
  const tenantsPath = join(dir, "tenants.yml");
  await writeFile(tenantsPath, simTenantsYaml);

  const simRoot = join(dir, ".deployctl-sim");
  const repository = new FileSystemDeployHistoryRepository(simRoot);
  await repository.tryStartDeployment(
    { env: "staging", tenant: "client1", app: "backend" },
    { eventId: "dep_20260701_100000", since: "2026-07-01T10:00:00Z", actor: "manual" },
  );

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "status", "--tenant", "client1", "--env", "staging", "--config", configPath, "--tenants", tenantsPath],
    { encoding: "utf8", env: { ...process.env, DEPLOYCTL_SIM_ROOT: simRoot } },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /deploy in progress: dep_20260701_100000/);
});

test("deployctl logs reports the pending boundary under the default aws adapter mode", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "logs", "--tenant", "client1", "--env", "staging", "--service", "api", "--since", "1h"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet readable/);
});

test("deployctl logs rejects an unknown service before any query", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "logs", "--tenant", "client1", "--env", "staging", "--service", "db", "--since", "1h"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--service must be "api" or "worker"/);
});

test("deployctl logs reads simulated log entries filtered by service and since when adapterMode is sim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deployctl-sim-logs-"));
  const configPath = await writeSimConfig(dir);
  const tenantsPath = join(dir, "tenants.yml");
  await writeFile(tenantsPath, simTenantsYaml);

  const simRoot = join(dir, ".deployctl-sim");
  const apiDir = join(simRoot, "logs", "staging", "client1");
  await mkdir(apiDir, { recursive: true });
  const now = Date.now();
  const recent = new Date(now - 5 * 60 * 1000).toISOString();
  const old = new Date(now - 3 * 60 * 60 * 1000).toISOString();
  const entry = (timestamp: string, service: string, message: string) =>
    JSON.stringify({ timestamp, env: "staging", tenant: "client1", service, message });
  await writeFile(join(apiDir, "api.log"), `${entry(old, "api", "api too old")}\n${entry(recent, "api", "api recent")}\n`);
  await writeFile(join(apiDir, "worker.log"), `${entry(recent, "worker", "worker recent")}\n`);

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "logs", "--tenant", "client1", "--env", "staging", "--service", "api", "--since", "1h", "--config", configPath, "--tenants", tenantsPath],
    { encoding: "utf8", env: { ...process.env, DEPLOYCTL_SIM_ROOT: simRoot } },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /api recent/);
  assert.doesNotMatch(result.stdout, /api too old/);
  assert.doesNotMatch(result.stdout, /worker recent/);
});

test("deployctl reconcile backend rejects an unknown tenant before any AWS work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "reconcile", "backend", "--tenant", "ghost", "--env", "staging"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tenant not found in staging: ghost/);
});

test("deployctl reconcile backend reports the pending boundary under the default aws adapter mode", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "reconcile", "backend", "--tenant", "client1", "--env", "staging"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet executable/);
});

test("deployctl deploy frontend builds and stores an artifact when adapterMode is sim, then reuses it on repeat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deployctl-sim-deploy-frontend-"));
  const configPath = await writeSimConfig(dir);
  const tenantsPath = join(dir, "tenants.yml");
  await writeFile(tenantsPath, simTenantsYaml);
  const simRoot = join(dir, ".deployctl-sim");
  const env = { ...process.env, DEPLOYCTL_SIM_ROOT: simRoot };

  const first = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "deploy", "frontend", "--tenant", "client1", "--env", "staging", "--ref", "main", "--config", configPath, "--tenants", tenantsPath],
    { encoding: "utf8", env },
  );
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /built artifact/);

  const bucketFile = join(simRoot, "frontend-buckets", "skincair-staging-frontend-client1", "index.html");
  assert.match(await readFile(bucketFile, "utf8"), /client1/);

  await waitForNextEventIdSecond();
  const second = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "deploy", "frontend", "--tenant", "client1", "--env", "staging", "--ref", "main", "--config", configPath, "--tenants", tenantsPath],
    { encoding: "utf8", env },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /reused artifact/);
});

test("deployctl rollback frontend re-syncs the previous artifact without rebuilding when adapterMode is sim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deployctl-sim-rollback-frontend-"));
  const configPath = await writeSimConfig(dir);
  const tenantsPath = join(dir, "tenants.yml");
  await writeFile(tenantsPath, simTenantsYaml);
  const simRoot = join(dir, ".deployctl-sim");
  const env = { ...process.env, DEPLOYCTL_SIM_ROOT: simRoot };
  const bucketFile = join(simRoot, "frontend-buckets", "skincair-staging-frontend-client1", "index.html");

  // A stable advertised commit (the phase-1-cli-foundation milestone branch tip)
  // stands in for an "older release"; main's current tip stands in for the newer one
  // being rolled back. GitCliRefResolver only accepts a full SHA the repo advertises,
  // so this must be an advertised ref tip, not an arbitrary/unreachable commit.
  const olderCommit = "79677ebd968e907fca2b2b348ac61116d86fb5a3";

  const older = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "deploy", "frontend", "--tenant", "client1", "--env", "staging", "--ref", olderCommit, "--config", configPath, "--tenants", tenantsPath],
    { encoding: "utf8", env },
  );
  assert.equal(older.status, 0, older.stderr);

  await waitForNextEventIdSecond();
  const newer = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "deploy", "frontend", "--tenant", "client1", "--env", "staging", "--ref", "main", "--config", configPath, "--tenants", tenantsPath],
    { encoding: "utf8", env },
  );
  assert.equal(newer.status, 0, newer.stderr);
  assert.match(await readFile(bucketFile, "utf8"), /VITE_TENANT=client1/);

  const rollback = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, "rollback", "frontend", "--tenant", "client1", "--env", "staging", "--config", configPath, "--tenants", tenantsPath],
    { encoding: "utf8", env },
  );

  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(rollback.stdout, new RegExp(`now at ${olderCommit}`));
  assert.match(await readFile(bucketFile, "utf8"), new RegExp(olderCommit));
});

test("deployctl deploy backend requires --ref", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "deploy", "backend", "--tenant", "client1", "--env", "staging"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--ref requires a value/);
});

test("deployctl deploy backend rejects an unknown tenant before any AWS work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "deploy", "backend", "--tenant", "ghost", "--env", "staging", "--ref", "main"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tenant not found in staging: ghost/);
});

test("deployctl deploy backend validates inputs and reports that AWS execution is still pending", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "deploy", "backend", "--tenant", "client1", "--env", "staging", "--ref", "main"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet executable/);
});

test("deployctl deploy frontend rejects an unknown tenant before any AWS work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "deploy", "frontend", "--tenant", "ghost", "--env", "staging", "--ref", "main"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tenant not found in staging: ghost/);
});

test("deployctl deploy frontend validates inputs and reports that AWS execution is still pending", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "deploy", "frontend", "--tenant", "client1", "--env", "staging", "--ref", "main"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet executable/);
});

test("deployctl rollback frontend rejects an unknown tenant before any AWS work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "rollback", "frontend", "--tenant", "ghost", "--env", "staging"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tenant not found in staging: ghost/);
});

test("deployctl rollback frontend validates inputs and reports that AWS execution is still pending", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "rollback", "frontend", "--tenant", "client1", "--env", "staging"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet executable/);
});

test("deployctl cleanup releases rejects an unknown environment before any AWS work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "cleanup", "releases", "--env", "ghost"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Environment not found in tenants config: ghost/);
});

test("deployctl cleanup releases validates inputs and reports that the cleanup adapter is still pending", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "cleanup", "releases", "--env", "staging", "--dry-run"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet available/);
});

test("deployctl cleanup artifacts validates inputs and reports that the cleanup adapter is still pending", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "cleanup", "artifacts", "--env", "staging", "--dry-run"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet available/);
});

test("deployctl rollback backend rejects an unknown tenant before any AWS work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "rollback", "backend", "--tenant", "ghost", "--env", "staging"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tenant not found in staging: ghost/);
});

test("deployctl rollback backend validates inputs and reports that AWS execution is still pending", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "rollback", "backend", "--tenant", "client1", "--env", "staging", "--version", "abc123"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet executable/);
});
