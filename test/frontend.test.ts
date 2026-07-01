import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployFrontend,
  frontendArtifactKey,
  frontendIdentityBuildVariables,
  frontendArtifactStorageKey,
  type FrontendArtifact,
  type FrontendArtifactStore,
  type FrontendBuilder,
  type FrontendSmokeCheck,
  type FrontendSync,
} from "../src/core/frontend.js";
import { InMemoryDeployHistoryRepository } from "../src/core/history.js";
import type { RefResolver } from "../src/core/refs.js";
import type { DeployctlConfig } from "../src/core/config.js";
import type { TenantRegistry } from "../src/core/tenants.js";
import { DeployctlError } from "../src/shared.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

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

const refResolver: RefResolver = {
  async resolve() {
    return { kind: "branch", commitSha: commit };
  },
};

type Fakes = {
  store: FrontendArtifactStore;
  builder: FrontendBuilder;
  sync: FrontendSync;
  smokeCheck: FrontendSmokeCheck;
  built: string[];
  buildRequests: { key: ReturnType<typeof frontendArtifactKey>; buildVariables: Record<string, string> }[];
  synced: { bucket: string; storageKey: string }[];
};

function fakes(options: { exists?: boolean; smokeOk?: boolean } = {}): Fakes {
  const built: string[] = [];
  const buildRequests: { key: ReturnType<typeof frontendArtifactKey>; buildVariables: Record<string, string> }[] = [];
  const synced: { bucket: string; storageKey: string }[] = [];
  return {
    built,
    buildRequests,
    synced,
    store: {
      async exists() {
        return options.exists ?? false;
      },
      async put() {},
    },
    builder: {
      async build(request): Promise<FrontendArtifact> {
        const storageKey = frontendArtifactStorageKey(config.frontendArtifacts.prefix, request.key);
        built.push(storageKey);
        buildRequests.push({ key: request.key, buildVariables: request.buildVariables });
        return { storageKey, byteSize: 1 };
      },
    },
    sync: {
      async sync(request) {
        synced.push({ bucket: request.bucket, storageKey: request.storageKey });
      },
    },
    smokeCheck: {
      async check() {
        return options.smokeOk ?? true;
      },
    },
  };
}

const baseInput = (f: Fakes, overrides: Partial<Parameters<typeof deployFrontend>[0]> = {}) => ({
  env: "staging",
  tenant: "client1",
  requestedRef: "feature/foo",
  actor: "manual",
  buildVariables: { VITE_TENANT: "client1", VITE_ENVIRONMENT: "staging" },
  config,
  registry,
  refResolver,
  history: new InMemoryDeployHistoryRepository(),
  artifacts: f.store,
  builder: f.builder,
  sync: f.sync,
  smokeCheck: f.smokeCheck,
  generateEventId: () => "dep_20260630_100000",
  clock: () => new Date("2026-06-30T10:00:00Z"),
  ...overrides,
});

test("deployFrontend builds a missing artifact, syncs it to the tenant bucket, and records success", async () => {
  const f = fakes({ exists: false });
  const history = new InMemoryDeployHistoryRepository();

  const result = await deployFrontend(baseInput(f, { history }));

  assert.equal(result.status, "success");
  assert.equal(result.reused, false);
  assert.equal(f.built.length, 1);
  assert.equal(f.synced[0].bucket, "skincair-staging-frontend-client1");

  const current = await history.readCurrentState({ env: "staging", tenant: "client1", app: "frontend" });
  assert.equal(current?.currentVersion, commit);
  assert.equal(current?.inProgress, undefined);
});

test("deployFrontend reuses an existing artifact instead of rebuilding", async () => {
  const f = fakes({ exists: true });

  const result = await deployFrontend(baseInput(f));

  assert.equal(result.reused, true);
  assert.equal(f.built.length, 0);
  assert.equal(f.synced.length, 1);
});

test("deployFrontend rejects missing configured frontend build identity inputs", async () => {
  const f = fakes();
  const strictConfig: DeployctlConfig = {
    ...config,
    build: {
      ...config.build,
      frontend: {
        ...config.build.frontend,
        buildConfigIdentityInputs: ["VITE_TENANT", "VITE_ENVIRONMENT"],
      },
    },
  };

  await assert.rejects(
    deployFrontend(
      baseInput(f, {
        config: strictConfig,
        buildVariables: { VITE_TENANT: "client1" },
      }),
    ),
    (error) => error instanceof DeployctlError && /VITE_ENVIRONMENT/.test(error.message),
  );

  assert.equal(f.built.length, 0);
  assert.equal(f.synced.length, 0);
});

test("deployFrontend ignores non-identity build variables for artifact identity but passes them to the builder", async () => {
  const base = fakes({ exists: false });
  await deployFrontend(baseInput(base, { buildVariables: { VITE_TENANT: "client1", IGNORED: "first" } }));

  const withExtra = fakes({ exists: false });
  await deployFrontend(baseInput(withExtra, { buildVariables: { VITE_TENANT: "client1", IGNORED: "second" } }));

  assert.equal(base.buildRequests[0].key.fingerprint, withExtra.buildRequests[0].key.fingerprint);
  assert.deepEqual(base.buildRequests[0].buildVariables, { VITE_TENANT: "client1", IGNORED: "first" });
  assert.deepEqual(withExtra.buildRequests[0].buildVariables, { VITE_TENANT: "client1", IGNORED: "second" });
});

test("deployFrontend reports failure and clears the guardrail when the smoke check fails", async () => {
  const f = fakes({ exists: true, smokeOk: false });
  const history = new InMemoryDeployHistoryRepository();
  const target = { env: "staging", tenant: "client1", app: "frontend" as const };

  const result = await deployFrontend(baseInput(f, { history }));

  assert.equal(result.status, "failure");
  const current = await history.readCurrentState(target);
  assert.equal(current?.currentVersion ?? null, null);
  assert.equal(current?.inProgress, undefined);
  const events = await history.listEvents(target);
  assert.equal(events[0].status, "failure");
});

test("deployFrontend records a failure event and clears the guardrail when the smoke check throws", async () => {
  const f = fakes({ exists: true });
  const history = new InMemoryDeployHistoryRepository();
  const target = { env: "staging", tenant: "client1", app: "frontend" as const };

  await assert.rejects(
    deployFrontend(
      baseInput(f, {
        history,
        smokeCheck: {
          async check() {
            throw new Error("smoke timed out");
          },
        },
      }),
    ),
    (error) => error instanceof DeployctlError && /smoke timed out/.test(error.message),
  );

  const current = await history.readCurrentState(target);
  assert.equal(current?.currentVersion ?? null, null);
  assert.equal(current?.inProgress, undefined);

  const events = await history.listEvents(target);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "failure");
  assert.match(events[0].errorMessage ?? "", /smoke timed out/);
});

test("deployFrontend rejects a target that already has a deploy in progress", async () => {
  const f = fakes();
  const history = new InMemoryDeployHistoryRepository();
  await history.updateCurrentState({
    env: "staging",
    tenant: "client1",
    app: "frontend",
    currentVersion: null,
    lastSuccessfulEventId: null,
    updatedAt: "2026-06-30T09:00:00Z",
    inProgress: { eventId: "dep_other", since: "2026-06-30T09:00:00Z", actor: "someone" },
  });

  await assert.rejects(deployFrontend(baseInput(f, { history })), (error) => error instanceof DeployctlError && /already in progress/.test(error.message));
});

test("frontendArtifactKey is deterministic for the same commit and build variables", () => {
  const a = frontendArtifactKey({ env: "staging", tenant: "client1", resolvedCommit: commit, buildVariables: { VITE_TENANT: "client1", VITE_ENVIRONMENT: "staging" } });
  const b = frontendArtifactKey({ env: "staging", tenant: "client1", resolvedCommit: commit, buildVariables: { VITE_ENVIRONMENT: "staging", VITE_TENANT: "client1" } });

  assert.equal(a.fingerprint, b.fingerprint);
});

test("frontendArtifactKey changes when any build variable value differs", () => {
  const base = frontendArtifactKey({ env: "staging", tenant: "client1", resolvedCommit: commit, buildVariables: { VITE_TENANT: "client1", VITE_ENVIRONMENT: "staging" } });
  const otherTenant = frontendArtifactKey({ env: "staging", tenant: "client2", resolvedCommit: commit, buildVariables: { VITE_TENANT: "client2", VITE_ENVIRONMENT: "staging" } });

  assert.notEqual(base.fingerprint, otherTenant.fingerprint);
});

test("frontendIdentityBuildVariables returns only configured identity inputs", () => {
  assert.deepEqual(
    frontendIdentityBuildVariables(
      { VITE_TENANT: "client1", VITE_ENVIRONMENT: "staging", EXTRA: "ignored" },
      ["VITE_TENANT", "VITE_ENVIRONMENT"],
    ),
    { VITE_TENANT: "client1", VITE_ENVIRONMENT: "staging" },
  );
});

test("frontendArtifactStorageKey embeds commit, env, tenant and fingerprint under the prefix", () => {
  const key = frontendArtifactKey({ env: "staging", tenant: "client1", resolvedCommit: commit, buildVariables: { VITE_TENANT: "client1" } });
  const path = frontendArtifactStorageKey("frontend", key);

  assert.match(path, new RegExp(`^frontend/${commit}/staging/client1-[0-9a-f]+\\.tar\\.gz$`));
});
