import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryDeployHistoryRepository,
  applySuccessfulEventToCurrentState,
  previousSuccessfulVersion,
  validateCurrentState,
  validateDeployEvent,
  validateRollbackEvent,
  type DeployEvent,
  type RollbackEvent,
} from "../src/core/history.js";
import { DeployctlError } from "../src/shared.js";

const target = {
  env: "staging",
  tenant: "client1",
  app: "backend" as const,
};

const firstDeploy: DeployEvent = {
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

const secondDeploy: DeployEvent = {
  ...firstDeploy,
  eventId: "dep_20260628_110000",
  requestedRef: "v1.2.0",
  resolvedCommit: "fedcba9876543210fedcba9876543210fedcba98",
  startedAt: "2026-06-28T11:00:00Z",
  finishedAt: "2026-06-28T11:02:00Z",
};

test("deploy event schema accepts immutable deploy audit records", () => {
  assert.deepEqual(validateDeployEvent(firstDeploy), firstDeploy);
});

test("rollback event schema accepts previous and target versions", () => {
  const rollback: RollbackEvent = {
    eventId: "rb_20260628_120000",
    type: "rollback",
    ...target,
    targetVersion: firstDeploy.resolvedCommit,
    previousVersion: secondDeploy.resolvedCommit,
    status: "success",
    startedAt: "2026-06-28T12:00:00Z",
    finishedAt: "2026-06-28T12:01:00Z",
    actor: "manual",
  };

  assert.deepEqual(validateRollbackEvent(rollback), rollback);
});

test("current state schema includes the Phase 5 in-progress fields", () => {
  const current = applySuccessfulEventToCurrentState(firstDeploy, {
    inProgress: {
      eventId: "dep_20260628_100000",
      since: "2026-06-28T10:00:00Z",
      actor: "manual",
    },
  });

  assert.deepEqual(validateCurrentState(current), {
    ...target,
    currentVersion: firstDeploy.resolvedCommit,
    lastSuccessfulEventId: firstDeploy.eventId,
    updatedAt: firstDeploy.finishedAt,
    inProgress: {
      eventId: "dep_20260628_100000",
      since: "2026-06-28T10:00:00Z",
      actor: "manual",
    },
  });
});

test("history repository appends events, updates current state, and finds previous successful version", async () => {
  const repository = new InMemoryDeployHistoryRepository();

  await repository.appendEvent(firstDeploy);
  await repository.updateCurrentState(applySuccessfulEventToCurrentState(firstDeploy));
  await repository.appendEvent(secondDeploy);
  await repository.updateCurrentState(applySuccessfulEventToCurrentState(secondDeploy));

  assert.deepEqual(await repository.readCurrentState(target), {
    ...target,
    currentVersion: secondDeploy.resolvedCommit,
    lastSuccessfulEventId: secondDeploy.eventId,
    updatedAt: secondDeploy.finishedAt,
  });
  assert.equal(await previousSuccessfulVersion(repository, target), firstDeploy.resolvedCommit);
});

test("history repository rejects duplicate append-only event IDs for a target", async () => {
  const repository = new InMemoryDeployHistoryRepository();

  await repository.appendEvent(firstDeploy);

  await assert.rejects(
    () => repository.appendEvent(firstDeploy),
    (error) => error instanceof DeployctlError && /already exists/.test(error.message),
  );
});

test("successful rollback events update current state to the rollback target version", async () => {
  const repository = new InMemoryDeployHistoryRepository();
  const rollback: RollbackEvent = {
    eventId: "rb_20260628_120000",
    type: "rollback",
    ...target,
    targetVersion: firstDeploy.resolvedCommit,
    previousVersion: secondDeploy.resolvedCommit,
    status: "success",
    startedAt: "2026-06-28T12:00:00Z",
    finishedAt: "2026-06-28T12:01:00Z",
    actor: "manual",
  };

  await repository.appendEvent(firstDeploy);
  await repository.updateCurrentState(applySuccessfulEventToCurrentState(firstDeploy));
  await repository.appendEvent(secondDeploy);
  await repository.updateCurrentState(applySuccessfulEventToCurrentState(secondDeploy));
  await repository.appendEvent(rollback);
  await repository.updateCurrentState(applySuccessfulEventToCurrentState(rollback));

  assert.equal((await repository.readCurrentState(target))?.currentVersion, firstDeploy.resolvedCommit);
  assert.equal(await previousSuccessfulVersion(repository, target), secondDeploy.resolvedCommit);
});
