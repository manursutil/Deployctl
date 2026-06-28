import assert from "node:assert/strict";
import { test } from "node:test";
import { listTenants, parseTenantRegistry } from "../src/core/tenants.js";
import { DeployctlError } from "../src/shared.js";

test("parseTenantRegistry validates tenant resource references", () => {
  const registry = parseTenantRegistry({
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
  });

  assert.equal(registry.staging.client1.apiProcess, "sherwood-api-client1");
  assert.deepEqual(listTenants(registry, "staging"), ["client1"]);
});

test("parseTenantRegistry rejects likely secret values", () => {
  assert.throws(
    () =>
      parseTenantRegistry({
        staging: {
          client1: {
            frontendBucket: "skincair-staging-frontend-client1",
            dbSecret: "password=super-secret",
            redisSecret: "skincair/staging/redis",
            apiProcess: "sherwood-api-client1",
            workerProcess: "sherwood-worker-client1",
            appBaseDir: "/opt/sherwood/tenants/client1",
            backendHealthUrl: "https://client1.sherwood.science/health",
            frontendUrl: "https://client1.sherwood.science",
          },
        },
      }),
    (error) => error instanceof DeployctlError && /looks like a secret value/.test(error.message),
  );
});

test("parseTenantRegistry rejects tenants missing required resource references", () => {
  assert.throws(
    () =>
      parseTenantRegistry({
        staging: {
          client1: {
            dbSecret: "skincair/staging/db/client1",
            redisSecret: "skincair/staging/redis",
            apiProcess: "sherwood-api-client1",
            workerProcess: "sherwood-worker-client1",
            appBaseDir: "/opt/sherwood/tenants/client1",
            backendHealthUrl: "https://client1.sherwood.science/health",
            frontendUrl: "https://client1.sherwood.science",
          },
        },
      }),
    (error) => error instanceof DeployctlError && /frontendBucket must be a non-empty string/.test(error.message),
  );
});
