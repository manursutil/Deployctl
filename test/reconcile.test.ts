import assert from "node:assert/strict";
import { test } from "node:test";
import type { SsmBackendDeployRequest, SsmDeployExecutor } from "../src/core/deploy.js";
import { InMemoryDeployHistoryRepository, type DeployEvent } from "../src/core/history.js";
import { reconcileBackend } from "../src/core/reconcile.js";
import type { DeployctlConfig } from "../src/core/config.js";
import type { TenantRegistry } from "../src/core/tenants.js";
import { DeployctlError } from "../src/shared.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

const config: DeployctlConfig = {
  adapterMode: "sim",
  aws: { region: "eu-west-1" },
  applicationRepository: { url: "." },
  build: {
    backend: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build" },
    frontend: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build", buildConfigIdentityInputs: ["VITE_TENANT"] },
  },
  deployHistory: { bucket: "deploy-history", prefix: "deploys" },
  frontendArtifacts: { bucket: "deploy-artifacts", prefix: "frontend" },
  refPolicies: { production: { allowMovingBranches: false } },
  ssmTargets: { production: { mode: "instanceIds", instanceIds: ["prod-1", "prod-2"] } },
  backendDeploy: { releaseRoot: "/opt/sherwood/releases", osUser: "sherwood" },
  retention: { successfulVersionsPerTarget: 10, keepDays: 30 },
};

const registry: TenantRegistry = {
  production: {
    client1: {
      frontendBucket: "skincair-production-frontend-client1",
      dbSecret: "skincair/production/db/client1",
      redisSecret: "skincair/production/redis",
      apiProcess: "sherwood-api-client1",
      workerProcess: "sherwood-worker-client1",
      appBaseDir: "/opt/sherwood/tenants/client1",
      backendHealthUrl: "https://client1.sherwood.science/health",
      frontendUrl: "https://client1.sherwood.science",
    },
  },
};

const target = { env: "production", tenant: "client1", app: "backend" as const };

function executorReturning(instances: { instanceId: string; status: "success" | "failure" }[]): {
  executor: SsmDeployExecutor;
  requests: SsmBackendDeployRequest[];
} {
  const requests: SsmBackendDeployRequest[] = [];
  const executor: SsmDeployExecutor = {
    async runBackendDeploy(request) {
      requests.push(request);
      return {
        ssmCommandId: "ssm-cmd-1",
        instances: instances.map((i) => ({ instanceId: i.instanceId, status: i.status, version: request.resolvedCommit })),
      };
    },
  };
  return { executor, requests };
}

async function seedCurrentVersion(history: InMemoryDeployHistoryRepository): Promise<void> {
  const event: DeployEvent = {
    eventId: "dep_20260701_100000",
    type: "deploy",
    ...target,
    requestedRef: commit,
    resolvedCommit: commit,
    status: "success",
    startedAt: "2026-07-01T10:00:00Z",
    finishedAt: "2026-07-01T10:02:00Z",
    actor: "manual",
  };
  await history.appendEvent(event);
  await history.updateCurrentState({
    ...target,
    currentVersion: commit,
    lastSuccessfulEventId: event.eventId,
    updatedAt: event.finishedAt,
  });
}

const baseInput = (overrides: Partial<Parameters<typeof reconcileBackend>[0]> = {}) => ({
  env: "production",
  tenant: "client1",
  actor: "cli",
  config,
  registry,
  history: new InMemoryDeployHistoryRepository(),
  executor: executorReturning([{ instanceId: "prod-1", status: "success" }]).executor,
  clock: () => new Date("2026-07-02T10:00:00Z"),
  ...overrides,
});

test("reconcileBackend re-runs the recorded current version across instances without changing current state", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedCurrentVersion(history);
  const { executor, requests } = executorReturning([
    { instanceId: "prod-1", status: "success" },
    { instanceId: "prod-2", status: "success" },
  ]);

  const result = await reconcileBackend(baseInput({ history, executor }));

  assert.equal(result.status, "success");
  assert.equal(result.currentVersion, commit);
  // The executor is asked for the recorded current commit, on every configured instance.
  assert.equal(requests[0].resolvedCommit, commit);
  assert.deepEqual(requests[0].ssmTarget, { mode: "instanceIds", instanceIds: ["prod-1", "prod-2"] });

  // Current state is unchanged (same version, no new event) and the guardrail is cleared.
  const current = await history.readCurrentState(target);
  assert.equal(current?.currentVersion, commit);
  assert.equal(current?.lastSuccessfulEventId, "dep_20260701_100000");
  assert.equal(current?.inProgress, undefined);
  assert.equal((await history.listEvents(target)).length, 1);
});

test("reconcileBackend rejects when there is no recorded current version", async () => {
  const history = new InMemoryDeployHistoryRepository();

  await assert.rejects(
    reconcileBackend(baseInput({ history })),
    (error) => error instanceof DeployctlError && /Nothing to reconcile/.test(error.message),
  );
});

test("reconcileBackend reports partial_failure when only some instances reconcile", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedCurrentVersion(history);
  const { executor } = executorReturning([
    { instanceId: "prod-1", status: "success" },
    { instanceId: "prod-2", status: "failure" },
  ]);

  const result = await reconcileBackend(baseInput({ history, executor }));

  assert.equal(result.status, "partial_failure");
  assert.equal((await history.readCurrentState(target))?.inProgress, undefined);
});

test("reconcileBackend clears the guardrail when the executor throws", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedCurrentVersion(history);
  const executor: SsmDeployExecutor = {
    async runBackendDeploy() {
      throw new Error("docker exec failed");
    },
  };

  await assert.rejects(
    reconcileBackend(baseInput({ history, executor })),
    (error) => error instanceof DeployctlError && /docker exec failed/.test(error.message),
  );
  assert.equal((await history.readCurrentState(target))?.inProgress, undefined);
});

test("reconcileBackend rejects a target that already has a deploy in progress", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedCurrentVersion(history);
  await history.updateCurrentState({
    ...target,
    currentVersion: commit,
    lastSuccessfulEventId: "dep_20260701_100000",
    updatedAt: "2026-07-02T09:00:00Z",
    inProgress: { eventId: "dep_other", since: "2026-07-02T09:00:00Z", actor: "someone" },
  });

  await assert.rejects(
    reconcileBackend(baseInput({ history })),
    (error) => error instanceof DeployctlError && /already in progress/.test(error.message),
  );
});
