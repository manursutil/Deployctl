import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FixtureFrontendBuilder, NoopFrontendSmokeCheck } from "../src/adapters/fixture-frontend.js";
import { FileSystemFrontendArtifactStore, FileSystemFrontendSync } from "../src/adapters/filesystem-frontend.js";
import { deployFrontend, frontendArtifactStorageKey, frontendArtifactKey } from "../src/core/frontend.js";
import { InMemoryDeployHistoryRepository } from "../src/core/history.js";
import { rollbackFrontend, selectRollbackTarget } from "../src/core/rollback.js";
import type { RefResolver } from "../src/core/refs.js";
import type { DeployctlConfig } from "../src/core/config.js";
import type { TenantRegistry } from "../src/core/tenants.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

async function newRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "deployctl-sim-frontend-"));
}

test("FileSystemFrontendArtifactStore reports missing keys and persists put() content under the storage key", async () => {
  const root = await newRoot();
  const store = new FileSystemFrontendArtifactStore(root);
  const key = frontendArtifactKey({ env: "staging", tenant: "client1", resolvedCommit: commit, buildVariables: { VITE_TENANT: "client1" } });
  const storageKey = frontendArtifactStorageKey("frontend", key);

  assert.equal(await store.exists(storageKey), false);

  const builder = new FixtureFrontendBuilder();
  const artifact = await builder.build({
    key,
    buildVariables: { VITE_TENANT: "client1" },
    build: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build", buildConfigIdentityInputs: ["VITE_TENANT"] },
    applicationRepositoryUrl: ".",
  });
  await store.put(storageKey, artifact);

  assert.equal(await store.exists(storageKey), true);
  assert.equal(await readFile(join(root, "artifacts", storageKey), "utf8"), await readFile(artifact.storageKey, "utf8"));
});

test("FileSystemFrontendSync copies the stored artifact into the tenant bucket as index.html", async () => {
  const root = await newRoot();
  const store = new FileSystemFrontendArtifactStore(root);
  const sync = new FileSystemFrontendSync(root);
  const key = frontendArtifactKey({ env: "staging", tenant: "client1", resolvedCommit: commit, buildVariables: {} });
  const storageKey = frontendArtifactStorageKey("frontend", key);

  await store.put(storageKey, { storageKey: await writeTempFile("<html>hello</html>"), byteSize: 20 });
  await sync.sync({ bucket: "skincair-staging-frontend-client1", storageKey });

  const synced = await readFile(join(root, "frontend-buckets", "skincair-staging-frontend-client1", "index.html"), "utf8");
  assert.equal(synced, "<html>hello</html>");
});

const config: DeployctlConfig = {
  adapterMode: "sim",
  aws: { region: "eu-west-1" },
  applicationRepository: { url: "." },
  build: {
    backend: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build" },
    frontend: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build", buildConfigIdentityInputs: ["VITE_TENANT", "VITE_ENVIRONMENT"] },
  },
  deployHistory: { bucket: "deploy-history", prefix: "deploys" },
  frontendArtifacts: { bucket: "deploy-artifacts", prefix: "frontend" },
  refPolicies: { staging: { allowMovingBranches: true } },
  ssmTargets: { staging: { mode: "instanceIds", instanceIds: ["i-0abc"] } },
  backendDeploy: { releaseRoot: "/opt/sherwood/releases", osUser: "sherwood" },
  retention: { successfulVersionsPerTarget: 10, keepDays: 30 },
};

const registry: TenantRegistry = {
  staging: {
    client1: {
      frontendBucket: "skincair-staging-frontend-client1",
      dbSecret: "skincair/staging/db/client1",
      redisSecret: "skincair/staging/redis",
      apiProcess: "sherwood-api-client1",
      workerProcess: "sherwood-worker-client1",
      appBaseDir: "/opt/sherwood/tenants/client1",
      backendHealthUrl: "https://client1.sherwood.science/health",
      frontendUrl: "https://client1.sherwood.science",
    },
  },
};

function refResolverFor(commitSha: string): RefResolver {
  return {
    async resolve() {
      return { kind: "branch", commitSha };
    },
  };
}

function countingBuilder(counter: { count: number }) {
  return {
    async build(request: Parameters<FixtureFrontendBuilder["build"]>[0]) {
      counter.count += 1;
      return new FixtureFrontendBuilder().build(request);
    },
  };
}

/** Monotonic clock/eventId pair so successive calls in one test never collide on the same second. */
function sequentialEventIds(): { clock: () => Date; generateEventId: (startedAt: Date) => string } {
  let seconds = 0;
  return {
    clock: () => new Date(2026, 6, 1, 10, 0, seconds++),
    generateEventId: (startedAt) => `dep_test_${startedAt.getSeconds()}`,
  };
}

test("deployFrontend builds once, reuses on repeat, and rebuilds when a build variable changes", async () => {
  const root = await newRoot();
  const history = new InMemoryDeployHistoryRepository();
  const artifacts = new FileSystemFrontendArtifactStore(root);
  const sync = new FileSystemFrontendSync(root);
  const smokeCheck = new NoopFrontendSmokeCheck();
  const counter = { count: 0 };
  const builder = countingBuilder(counter);
  const { clock, generateEventId } = sequentialEventIds();
  const bucketFile = join(root, "frontend-buckets", "skincair-staging-frontend-client1", "index.html");

  const deployOnce = (buildVariables: Record<string, string>) =>
    deployFrontend({
      env: "staging",
      tenant: "client1",
      requestedRef: "main",
      actor: "test",
      buildVariables,
      config,
      registry,
      refResolver: refResolverFor(commit),
      history,
      artifacts,
      builder,
      sync,
      smokeCheck,
      clock,
      generateEventId,
    });

  // 1. First deploy builds and stores an artifact.
  const first = await deployOnce({ VITE_TENANT: "client1", VITE_ENVIRONMENT: "staging" });
  assert.equal(first.status, "success");
  assert.equal(first.reused, false);
  assert.equal(counter.count, 1);
  assert.match(await readFile(bucketFile, "utf8"), /VITE_ENVIRONMENT=staging/);

  // 2. Repeating the same deploy reuses the artifact (no rebuild).
  const second = await deployOnce({ VITE_TENANT: "client1", VITE_ENVIRONMENT: "staging" });
  assert.equal(second.reused, true);
  assert.equal(counter.count, 1);

  // 3. Changing a build variable creates a different artifact key (rebuild).
  const third = await deployOnce({ VITE_TENANT: "client1", VITE_ENVIRONMENT: "production" });
  assert.equal(third.reused, false);
  assert.equal(counter.count, 2);
  assert.notEqual(third.event.artifactStorageKey, first.event.artifactStorageKey);
  assert.match(await readFile(bucketFile, "utf8"), /VITE_ENVIRONMENT=production/);
});

test("rollbackFrontend re-syncs the exact recorded artifact for an earlier commit without rebuilding", async () => {
  const root = await newRoot();
  const history = new InMemoryDeployHistoryRepository();
  const artifacts = new FileSystemFrontendArtifactStore(root);
  const sync = new FileSystemFrontendSync(root);
  const smokeCheck = new NoopFrontendSmokeCheck();
  const counter = { count: 0 };
  const builder = countingBuilder(counter);
  const { clock, generateEventId } = sequentialEventIds();
  const bucketFile = join(root, "frontend-buckets", "skincair-staging-frontend-client1", "index.html");
  const commitA = commit;
  const commitB = "fedcba9876543210fedcba9876543210fedcba98";
  const buildVariables = { VITE_TENANT: "client1", VITE_ENVIRONMENT: "staging" };

  const deployRef = (resolvedCommit: string) =>
    deployFrontend({
      env: "staging",
      tenant: "client1",
      requestedRef: "main",
      actor: "test",
      buildVariables,
      config,
      registry,
      refResolver: refResolverFor(resolvedCommit),
      history,
      artifacts,
      builder,
      sync,
      smokeCheck,
      clock,
      generateEventId,
    });

  const first = await deployRef(commitA);
  await deployRef(commitB);
  assert.match(await readFile(bucketFile, "utf8"), new RegExp(commitB));
  assert.equal(counter.count, 2);

  const selection = await selectRollbackTarget(history, { env: "staging", tenant: "client1", app: "frontend" });
  assert.equal(selection.targetVersion, commitA);
  assert.equal(selection.targetEvent.artifactStorageKey, first.event.artifactStorageKey);

  const rollback = await rollbackFrontend({
    env: "staging",
    tenant: "client1",
    actor: "test",
    registry,
    history,
    sync,
    smokeCheck,
    clock,
    generateEventId,
  });

  assert.equal(rollback.status, "success");
  assert.equal(rollback.event.targetVersion, commitA);
  assert.equal(counter.count, 2, "rollback must not call the builder");
  assert.match(await readFile(bucketFile, "utf8"), new RegExp(commitA));
});

async function writeTempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deployctl-sim-frontend-tmp-"));
  const path = join(dir, "artifact.tar.gz");
  await writeFile(path, content, "utf8");
  return path;
}
