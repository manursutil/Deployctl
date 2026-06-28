import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryDeployHistoryRepository, applySuccessfulEventToCurrentState, type DeployEvent } from "../src/core/history.js";
import { clearDeploymentGuardrail, startDeploymentGuardrail } from "../src/core/guardrail.js";
import { DeployctlError } from "../src/shared.js";

const target = {
  env: "staging",
  tenant: "client1",
  app: "backend" as const,
};

const deployed: DeployEvent = {
  eventId: "dep_20260628_100000",
  type: "deploy",
  ...target,
  requestedRef: "feature/foo",
  resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
  status: "success",
  startedAt: "2026-06-28T10:00:00Z",
  finishedAt: "2026-06-28T10:02:00Z",
  actor: "manual",
};

test("startDeploymentGuardrail sets inProgress on current state", async () => {
  const repository = new InMemoryDeployHistoryRepository();
  await repository.updateCurrentState(applySuccessfulEventToCurrentState(deployed));

  await startDeploymentGuardrail(repository, target, {
    eventId: "dep_20260628_110000",
    since: "2026-06-28T11:00:00Z",
    actor: "manual",
  });

  assert.deepEqual((await repository.readCurrentState(target))?.inProgress, {
    eventId: "dep_20260628_110000",
    since: "2026-06-28T11:00:00Z",
    actor: "manual",
  });
});

test("startDeploymentGuardrail can initialize guardrail before the first successful deploy", async () => {
  const repository = new InMemoryDeployHistoryRepository();

  await startDeploymentGuardrail(repository, target, {
    eventId: "dep_20260628_110000",
    since: "2026-06-28T11:00:00Z",
    actor: "manual",
  });

  const current = await repository.readCurrentState(target);
  assert.equal(current?.currentVersion, null);
  assert.equal(current?.lastSuccessfulEventId, null);
  assert.equal(current?.inProgress?.eventId, "dep_20260628_110000");
});

test("startDeploymentGuardrail rejects a target that already has a deploy in progress", async () => {
  const repository = new InMemoryDeployHistoryRepository();
  await repository.updateCurrentState({
    ...applySuccessfulEventToCurrentState(deployed),
    inProgress: {
      eventId: "dep_20260628_110000",
      since: "2026-06-28T11:00:00Z",
      actor: "manual",
    },
  });

  await assert.rejects(
    () =>
      startDeploymentGuardrail(repository, target, {
        eventId: "dep_20260628_120000",
        since: "2026-06-28T12:00:00Z",
        actor: "manual",
      }),
    (error) => error instanceof DeployctlError && /deploy already in progress/.test(error.message),
  );
});

test("clearDeploymentGuardrail removes only the matching in-progress event", async () => {
  const repository = new InMemoryDeployHistoryRepository();
  await repository.updateCurrentState({
    ...applySuccessfulEventToCurrentState(deployed),
    inProgress: {
      eventId: "dep_20260628_110000",
      since: "2026-06-28T11:00:00Z",
      actor: "manual",
    },
  });

  await clearDeploymentGuardrail(repository, target, "dep_20260628_120000");
  assert.equal((await repository.readCurrentState(target))?.inProgress?.eventId, "dep_20260628_110000");

  await clearDeploymentGuardrail(repository, target, "dep_20260628_110000");
  assert.equal((await repository.readCurrentState(target))?.inProgress, undefined);
});
