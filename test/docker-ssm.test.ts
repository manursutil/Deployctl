import assert from "node:assert/strict";
import { test } from "node:test";
import { DockerSimSsmDeployExecutor, type DockerCommandRunner } from "../src/adapters/docker-ssm.js";
import type { SsmBackendDeployRequest } from "../src/core/deploy.js";
import { DeployctlError } from "../src/shared.js";

const baseRequest: SsmBackendDeployRequest = {
  target: { env: "staging", tenant: "client1", app: "backend" },
  resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
  tenant: {
    frontendBucket: "skincair-staging-frontend-client1",
    dbSecret: "skincair/staging/db/client1",
    redisSecret: "skincair/staging/redis",
    apiProcess: "sherwood-api-client1",
    workerProcess: "sherwood-worker-client1",
    appBaseDir: "/opt/sherwood/tenants/client1",
    backendHealthUrl: "https://client1.sherwood.science/health",
    frontendUrl: "https://client1.sherwood.science",
  },
  ssmTarget: { mode: "instanceIds", instanceIds: ["deployctl-sim-app-server-staging"] },
  build: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build" },
  applicationRepositoryUrl: ".",
};

function fakeRunner(behavior: (args: string[]) => Promise<void>): { runner: DockerCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: DockerCommandRunner = async (args) => {
    calls.push(args);
    await behavior(args);
  };
  return { runner, calls };
}

test("runBackendDeploy execs the deploy script in the target container with the expected env", async () => {
  const { runner, calls } = fakeRunner(async () => {});
  const executor = new DockerSimSsmDeployExecutor({ releaseRoot: "/opt/sherwood/releases", osUser: "sherwood" }, runner);

  const outcome = await executor.runBackendDeploy(baseRequest);

  assert.equal(outcome.instances.length, 1);
  assert.deepEqual(outcome.instances[0], {
    instanceId: "deployctl-sim-app-server-staging",
    status: "success",
    version: baseRequest.resolvedCommit,
  });
  assert.match(outcome.ssmCommandId, /^sim-0123456789ab-\d+$/);

  const args = calls[0];
  assert.equal(args.at(-2), "deployctl-sim-app-server-staging");
  assert.equal(args.at(-1), "/opt/deployctl/scripts/deploy-backend.sh");
  assert.equal(args[0], "exec");

  const env = Object.fromEntries(
    args
      .filter((_, index) => args[index - 1] === "-e")
      .map((pair) => pair.split(/=(.*)/s).slice(0, 2) as [string, string]),
  );
  assert.deepEqual(env, {
    DEPLOYCTL_RELEASE_ROOT: "/opt/sherwood/releases",
    DEPLOYCTL_TENANT_BASE_DIR: "/opt/sherwood/tenants/client1",
    DEPLOYCTL_OS_USER: "sherwood",
    DEPLOYCTL_COMMIT: baseRequest.resolvedCommit,
    DEPLOYCTL_ENV: "staging",
    DEPLOYCTL_TENANT: "client1",
    DEPLOYCTL_API_PROCESS: "sherwood-api-client1",
    DEPLOYCTL_WORKER_PROCESS: "sherwood-worker-client1",
    DEPLOYCTL_DB_SECRET_NAME: "skincair/staging/db/client1",
    DEPLOYCTL_REDIS_SECRET_NAME: "skincair/staging/redis",
    DEPLOYCTL_LOG_ROOT: "/opt/deployctl/logs",
  });
});

test("runBackendDeploy reports per-instance failure without throwing when docker exec fails", async () => {
  const { runner } = fakeRunner(async () => {
    throw new Error("No such container: deployctl-sim-app-server-staging");
  });
  const executor = new DockerSimSsmDeployExecutor({ releaseRoot: "/opt/sherwood/releases", osUser: "sherwood" }, runner);

  const outcome = await executor.runBackendDeploy(baseRequest);

  assert.equal(outcome.instances[0].status, "failure");
  assert.match(outcome.instances[0].errorMessage ?? "", /No such container/);
});

test("runBackendDeploy runs the script on every configured instanceId", async () => {
  const { runner, calls } = fakeRunner(async () => {});
  const executor = new DockerSimSsmDeployExecutor({ releaseRoot: "/opt/sherwood/releases", osUser: "sherwood" }, runner);
  const request: SsmBackendDeployRequest = {
    ...baseRequest,
    ssmTarget: { mode: "instanceIds", instanceIds: ["app-server-a", "app-server-b"] },
  };

  const outcome = await executor.runBackendDeploy(request);

  assert.equal(calls.length, 2);
  assert.deepEqual(
    outcome.instances.map((instance) => instance.instanceId),
    ["app-server-a", "app-server-b"],
  );
});

test("runBackendDeploy rejects an asg target selector", async () => {
  const { runner } = fakeRunner(async () => {});
  const executor = new DockerSimSsmDeployExecutor({ releaseRoot: "/opt/sherwood/releases", osUser: "sherwood" }, runner);
  const request: SsmBackendDeployRequest = {
    ...baseRequest,
    ssmTarget: { mode: "asg", autoScalingGroupName: "sherwood-production-asg" },
  };

  await assert.rejects(
    executor.runBackendDeploy(request),
    (error) => error instanceof DeployctlError && /only supports "instanceIds"/.test(error.message),
  );
});
