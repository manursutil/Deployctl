import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rollbackBackend,
  rollbackFrontend,
  selectRollbackTarget,
} from "../src/core/rollback.js";
import type { SsmDeployExecutor } from "../src/core/deploy.js";
import type { FrontendSmokeCheck, FrontendSync } from "../src/core/frontend.js";
import {
  applySuccessfulEventToCurrentState,
  InMemoryDeployHistoryRepository,
  newDeployEvent,
  type DeployTarget,
  type DeployHistoryRepository,
} from "../src/core/history.js";
import type { DeployctlConfig } from "../src/core/config.js";
import type { TenantRegistry } from "../src/core/tenants.js";
import { DeployctlError } from "../src/shared.js";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const commitC = "c".repeat(40);

const config: DeployctlConfig = {
  aws: { region: "eu-west-1" },
  applicationRepository: { url: "ssh://git@bitbucket.org/example/app.git" },
  build: {
    backend: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build" },
    frontend: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build", buildConfigIdentityInputs: ["VITE_TENANT"] },
  },
  deployHistory: { bucket: "deploy-history", prefix: "deploys" },
  frontendArtifacts: { bucket: "deploy-artifacts", prefix: "frontend" },
  refPolicies: { staging: { allowMovingBranches: true } },
  ssmTargets: { staging: { mode: "instanceIds", instanceIds: ["i-0abc"] } },
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

/** Append a successful deploy event and (optionally) make it the current version. */
async function seedDeploy(
  history: DeployHistoryRepository,
  target: DeployTarget,
  options: { commit: string; eventId: string; at: string; artifactStorageKey?: string; makeCurrent?: boolean },
): Promise<void> {
  const event = newDeployEvent({
    target,
    eventId: options.eventId,
    requestedRef: "feature/foo",
    resolvedCommit: options.commit,
    actor: "manual",
    status: "success",
    startedAt: new Date(options.at),
    finishedAt: new Date(options.at),
    artifactStorageKey: options.artifactStorageKey,
  });
  await history.appendEvent(event);

  if (options.makeCurrent) {
    await history.updateCurrentState(applySuccessfulEventToCurrentState(event));
  }
}

function backendExecutor(instances: { instanceId: string; status: "success" | "failure" }[]): {
  executor: SsmDeployExecutor;
  requests: { resolvedCommit: string }[];
} {
  const requests: { resolvedCommit: string }[] = [];
  return {
    requests,
    executor: {
      async runBackendDeploy(request) {
        requests.push({ resolvedCommit: request.resolvedCommit });
        return { ssmCommandId: "ssm-rbk-1", instances: instances.map((i) => ({ instanceId: i.instanceId, status: i.status, version: request.resolvedCommit })) };
      },
    },
  };
}

const backendTarget: DeployTarget = { env: "staging", tenant: "client1", app: "backend" };
const frontendTarget: DeployTarget = { env: "staging", tenant: "client1", app: "frontend" };

const backendInput = (overrides: Partial<Parameters<typeof rollbackBackend>[0]> = {}) => ({
  env: "staging",
  tenant: "client1",
  actor: "manual",
  config,
  registry,
  history: new InMemoryDeployHistoryRepository(),
  executor: backendExecutor([{ instanceId: "i-0abc", status: "success" }]).executor,
  generateEventId: () => "rbk_20260702_100000",
  clock: () => new Date("2026-07-02T10:00:00Z"),
  ...overrides,
});

const frontendSync = (): { sync: FrontendSync; synced: { bucket: string; storageKey: string }[] } => {
  const synced: { bucket: string; storageKey: string }[] = [];
  return {
    synced,
    sync: {
      async sync(request) {
        synced.push(request);
      },
    },
  };
};

const smokeCheck = (ok: boolean): FrontendSmokeCheck => ({ async check() { return ok; } });

const frontendInput = (overrides: Partial<Parameters<typeof rollbackFrontend>[0]> = {}) => ({
  env: "staging",
  tenant: "client1",
  actor: "manual",
  registry,
  history: new InMemoryDeployHistoryRepository(),
  sync: frontendSync().sync,
  smokeCheck: smokeCheck(true),
  generateEventId: () => "rbk_20260702_100000",
  clock: () => new Date("2026-07-02T10:00:00Z"),
  ...overrides,
});

test("selectRollbackTarget defaults to the version before the current one", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, backendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T09:00:00Z" });
  await seedDeploy(history, backendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T10:00:00Z", makeCurrent: true });

  const selection = await selectRollbackTarget(history, backendTarget);

  assert.equal(selection.targetVersion, commitA);
  assert.equal(selection.previousVersion, commitB);
  assert.equal(selection.targetEvent.eventId, "dep_1");
});

test("selectRollbackTarget honors an explicit toVersion", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, backendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T08:00:00Z" });
  await seedDeploy(history, backendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T09:00:00Z" });
  await seedDeploy(history, backendTarget, { commit: commitC, eventId: "dep_3", at: "2026-07-01T10:00:00Z", makeCurrent: true });

  const selection = await selectRollbackTarget(history, backendTarget, commitA.toUpperCase());

  assert.equal(selection.targetVersion, commitA);
  assert.equal(selection.previousVersion, commitC);
});

test("selectRollbackTarget rejects when nothing is deployed", async () => {
  const history = new InMemoryDeployHistoryRepository();

  await assert.rejects(selectRollbackTarget(history, backendTarget), (error) => error instanceof DeployctlError && /No current version/.test(error.message));
});

test("selectRollbackTarget rejects when there is no earlier successful version", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, backendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T10:00:00Z", makeCurrent: true });

  await assert.rejects(selectRollbackTarget(history, backendTarget), (error) => error instanceof DeployctlError && /No previous successful version/.test(error.message));
});

test("selectRollbackTarget rejects an unknown or already-current toVersion", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, backendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T09:00:00Z" });
  await seedDeploy(history, backendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T10:00:00Z", makeCurrent: true });

  await assert.rejects(selectRollbackTarget(history, backendTarget, commitC), (error) => error instanceof DeployctlError && /No successful deploy/.test(error.message));
  await assert.rejects(selectRollbackTarget(history, backendTarget, commitB), (error) => error instanceof DeployctlError && /already at version/.test(error.message));
});

test("rollbackBackend redeploys the previous version and updates current state", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, backendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T09:00:00Z" });
  await seedDeploy(history, backendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T10:00:00Z", makeCurrent: true });
  const { executor, requests } = backendExecutor([{ instanceId: "i-0abc", status: "success" }]);

  const result = await rollbackBackend(backendInput({ history, executor }));

  assert.equal(result.status, "success");
  assert.equal(result.event.type, "rollback");
  assert.equal(result.event.targetVersion, commitA);
  assert.equal(result.event.previousVersion, commitB);
  assert.equal(requests[0].resolvedCommit, commitA);

  const current = await history.readCurrentState(backendTarget);
  assert.equal(current?.currentVersion, commitA);
  assert.equal(current?.lastSuccessfulEventId, "rbk_20260702_100000");
  assert.equal(current?.inProgress, undefined);
});

test("rollbackBackend records failure and clears the guardrail when the executor throws", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, backendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T09:00:00Z" });
  await seedDeploy(history, backendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T10:00:00Z", makeCurrent: true });
  const executor: SsmDeployExecutor = {
    async runBackendDeploy() {
      throw new Error("SSM command timed out");
    },
  };

  await assert.rejects(rollbackBackend(backendInput({ history, executor })), (error) => error instanceof DeployctlError && /SSM command timed out/.test(error.message));

  const events = await history.listEvents(backendTarget);
  assert.equal(events.at(-1)?.status, "failure");
  assert.equal(events.at(-1)?.type, "rollback");

  const current = await history.readCurrentState(backendTarget);
  assert.equal(current?.currentVersion, commitB, "current version is unchanged after a failed rollback");
  assert.equal(current?.inProgress, undefined);
});

test("rollbackBackend reports partial_failure without changing current state", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, backendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T09:00:00Z" });
  await seedDeploy(history, backendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T10:00:00Z", makeCurrent: true });
  const { executor } = backendExecutor([
    { instanceId: "i-0abc", status: "success" },
    { instanceId: "i-0def", status: "failure" },
  ]);

  const result = await rollbackBackend(backendInput({ history, executor }));

  assert.equal(result.status, "partial_failure");
  const current = await history.readCurrentState(backendTarget);
  assert.equal(current?.currentVersion, commitB);
  assert.equal(current?.inProgress, undefined);
});

test("rollbackBackend rejects a target that already has a deploy in progress", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, backendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T09:00:00Z" });
  await seedDeploy(history, backendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T10:00:00Z", makeCurrent: true });
  const withProgress = await history.readCurrentState(backendTarget);
  await history.updateCurrentState({ ...withProgress!, inProgress: { eventId: "dep_other", since: "2026-07-02T09:00:00Z", actor: "someone" } });

  await assert.rejects(rollbackBackend(backendInput({ history })), (error) => error instanceof DeployctlError && /already in progress/.test(error.message));
});

test("rollbackFrontend re-syncs the recorded artifact without rebuilding and records success", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, frontendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T09:00:00Z", artifactStorageKey: "frontend/aaa/staging/client1-old.tar.gz" });
  await seedDeploy(history, frontendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T10:00:00Z", artifactStorageKey: "frontend/bbb/staging/client1-new.tar.gz", makeCurrent: true });
  const { sync, synced } = frontendSync();

  const result = await rollbackFrontend(frontendInput({ history, sync }));

  assert.equal(result.status, "success");
  assert.equal(result.event.targetVersion, commitA);
  assert.equal(result.event.artifactStorageKey, "frontend/aaa/staging/client1-old.tar.gz");
  assert.deepEqual(synced, [{ bucket: "skincair-staging-frontend-client1", storageKey: "frontend/aaa/staging/client1-old.tar.gz" }]);

  const current = await history.readCurrentState(frontendTarget);
  assert.equal(current?.currentVersion, commitA);
  assert.equal(current?.inProgress, undefined);
});

test("rollbackFrontend rejects when the target version has no recorded artifact", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, frontendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T09:00:00Z" });
  await seedDeploy(history, frontendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T10:00:00Z", artifactStorageKey: "frontend/bbb/staging/client1-new.tar.gz", makeCurrent: true });

  await assert.rejects(rollbackFrontend(frontendInput({ history })), (error) => error instanceof DeployctlError && /No recorded frontend artifact/.test(error.message));
});

test("rollbackFrontend reports failure and clears the guardrail when the smoke check fails", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedDeploy(history, frontendTarget, { commit: commitA, eventId: "dep_1", at: "2026-07-01T09:00:00Z", artifactStorageKey: "frontend/aaa/staging/client1-old.tar.gz" });
  await seedDeploy(history, frontendTarget, { commit: commitB, eventId: "dep_2", at: "2026-07-01T10:00:00Z", artifactStorageKey: "frontend/bbb/staging/client1-new.tar.gz", makeCurrent: true });

  const result = await rollbackFrontend(frontendInput({ history, smokeCheck: smokeCheck(false) }));

  assert.equal(result.status, "failure");
  const current = await history.readCurrentState(frontendTarget);
  assert.equal(current?.currentVersion, commitB, "current version is unchanged after a failed rollback");
  assert.equal(current?.inProgress, undefined);
});
