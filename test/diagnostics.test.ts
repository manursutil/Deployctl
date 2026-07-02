import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTenantStatus, getTenantStatus } from "../src/core/diagnostics.js";
import { InMemoryDeployHistoryRepository } from "../src/core/history.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

test("getTenantStatus reports current state per app, marking apps with no record as not deployed", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await history.updateCurrentState({
    env: "staging",
    tenant: "client1",
    app: "backend",
    currentVersion: commit,
    lastSuccessfulEventId: "dep_20260701_100000",
    updatedAt: "2026-07-01T10:00:00Z",
  });

  const status = await getTenantStatus(history, { env: "staging", tenant: "client1" });

  assert.deepEqual(status.apps.map((app) => app.app), ["backend", "frontend"]);

  const backend = status.apps.find((app) => app.app === "backend");
  assert.equal(backend?.exists, true);
  assert.equal(backend?.currentVersion, commit);
  assert.equal(backend?.lastSuccessfulEventId, "dep_20260701_100000");

  const frontend = status.apps.find((app) => app.app === "frontend");
  assert.equal(frontend?.exists, false);
  assert.equal(frontend?.currentVersion, null);
});

test("getTenantStatus surfaces the inProgress guardrail", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await history.updateCurrentState({
    env: "staging",
    tenant: "client1",
    app: "backend",
    currentVersion: null,
    lastSuccessfulEventId: null,
    updatedAt: "2026-07-01T09:00:00Z",
    inProgress: { eventId: "dep_running", since: "2026-07-01T09:00:00Z", actor: "manual" },
  });

  const status = await getTenantStatus(history, { env: "staging", tenant: "client1", apps: ["backend"] });

  assert.equal(status.apps[0].inProgress?.eventId, "dep_running");
  assert.equal(status.apps[0].currentVersion, null);
});

test("getTenantStatus honors an explicit app filter", async () => {
  const history = new InMemoryDeployHistoryRepository();

  const status = await getTenantStatus(history, { env: "production", tenant: "client2", apps: ["frontend"] });

  assert.deepEqual(status.apps.map((app) => app.app), ["frontend"]);
});

test("formatTenantStatus renders one target per line with version, update time, and progress", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await history.updateCurrentState({
    env: "staging",
    tenant: "client1",
    app: "backend",
    currentVersion: commit,
    lastSuccessfulEventId: "dep_20260701_100000",
    updatedAt: "2026-07-01T10:00:00Z",
  });
  await history.updateCurrentState({
    env: "staging",
    tenant: "client1",
    app: "frontend",
    currentVersion: null,
    lastSuccessfulEventId: null,
    updatedAt: "2026-07-01T11:00:00Z",
    inProgress: { eventId: "dep_running", since: "2026-07-01T11:00:00Z", actor: "manual" },
  });

  const output = formatTenantStatus(await getTenantStatus(history, { env: "staging", tenant: "client1" }));

  assert.equal(
    output,
    [
      `staging/client1/backend: ${commit} (updated 2026-07-01T10:00:00Z, last successful dep_20260701_100000)`,
      "staging/client1/frontend: not deployed [deploy in progress: dep_running since 2026-07-01T11:00:00Z]",
      "",
    ].join("\n"),
  );
});
