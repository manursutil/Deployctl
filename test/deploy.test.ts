import assert from "node:assert/strict";
import { test } from "node:test";
import { deployBackend, type SsmBackendDeployRequest, type SsmDeployExecutor } from "../src/core/deploy.js";
import { InMemoryDeployHistoryRepository } from "../src/core/history.js";
import type { RefResolver } from "../src/core/refs.js";
import type { DeployctlConfig } from "../src/core/config.js";
import type { TenantRegistry } from "../src/core/tenants.js";
import { DeployctlError } from "../src/shared.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

const config: DeployctlConfig = {
  adapterMode: "aws",
  aws: { region: "eu-west-1" },
  applicationRepository: { url: "ssh://git@bitbucket.org/example/app.git" },
  build: {
    backend: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build" },
    frontend: {
      packageManager: "npm",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      buildConfigIdentityInputs: ["VITE_TENANT"],
    },
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

const refResolver: RefResolver = {
  async resolve() {
    return { kind: "branch", commitSha: commit };
  },
};

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
        instances: instances.map((i) => ({ instanceId: i.instanceId, status: i.status, version: commit })),
      };
    },
  };
  return { executor, requests };
}

const baseInput = (overrides: Partial<Parameters<typeof deployBackend>[0]> = {}) => ({
  env: "staging",
  tenant: "client1",
  requestedRef: "feature/foo",
  actor: "manual",
  config,
  registry,
  refResolver,
  history: new InMemoryDeployHistoryRepository(),
  executor: executorReturning([{ instanceId: "i-0abc", status: "success" }]).executor,
  generateEventId: () => "dep_20260628_100000",
  clock: () => new Date("2026-06-28T10:00:00Z"),
  ...overrides,
});

test("deployBackend records a success event and updates current state through the SSM executor", async () => {
  const { executor, requests } = executorReturning([{ instanceId: "i-0abc", status: "success" }]);
  const history = new InMemoryDeployHistoryRepository();

  const result = await deployBackend(baseInput({ history, executor }));

  assert.equal(result.status, "success");
  assert.equal(result.event.resolvedCommit, commit);
  assert.equal(result.event.ssmCommandId, "ssm-cmd-1");

  // The executor receives the resolved commit and tenant process targets, never a secret value.
  assert.equal(requests[0].resolvedCommit, commit);
  assert.equal(requests[0].tenant.apiProcess, "sherwood-api-client1");
  assert.deepEqual(requests[0].ssmTarget, { mode: "instanceIds", instanceIds: ["i-0abc"] });

  const current = await history.readCurrentState({ env: "staging", tenant: "client1", app: "backend" });
  assert.equal(current?.currentVersion, commit);
  assert.equal(current?.inProgress, undefined);
});

test("deployBackend rejects a target that already has a deploy in progress", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await history.updateCurrentState({
    env: "staging",
    tenant: "client1",
    app: "backend",
    currentVersion: null,
    lastSuccessfulEventId: null,
    updatedAt: "2026-06-28T09:00:00Z",
    inProgress: { eventId: "dep_other", since: "2026-06-28T09:00:00Z", actor: "someone" },
  });
  const { executor } = executorReturning([{ instanceId: "i-0abc", status: "success" }]);

  await assert.rejects(deployBackend(baseInput({ history, executor })), (error) => error instanceof DeployctlError && /already in progress/.test(error.message));
});

test("deployBackend records a failure event and clears the guardrail when the executor throws", async () => {
  const history = new InMemoryDeployHistoryRepository();
  const executor: SsmDeployExecutor = {
    async runBackendDeploy() {
      throw new Error("SSM command timed out");
    },
  };
  const target = { env: "staging", tenant: "client1", app: "backend" as const };

  await assert.rejects(deployBackend(baseInput({ history, executor })), (error) => error instanceof DeployctlError && /SSM command timed out/.test(error.message));

  const events = await history.listEvents(target);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "failure");

  const current = await history.readCurrentState(target);
  assert.equal(current?.inProgress, undefined);
  assert.equal(current?.currentVersion ?? null, null);
});

test("deployBackend reports partial_failure when only some instances succeed", async () => {
  const history = new InMemoryDeployHistoryRepository();
  const { executor } = executorReturning([
    { instanceId: "i-0abc", status: "success" },
    { instanceId: "i-0def", status: "failure" },
  ]);

  const result = await deployBackend(baseInput({ history, executor }));

  assert.equal(result.status, "partial_failure");
  const current = await history.readCurrentState({ env: "staging", tenant: "client1", app: "backend" });
  assert.equal(current?.currentVersion ?? null, null);
  assert.equal(current?.inProgress, undefined);
});
