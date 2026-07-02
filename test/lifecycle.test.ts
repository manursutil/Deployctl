import assert from "node:assert/strict";
import { test } from "node:test";
import { runDeployLifecycle } from "../src/core/lifecycle.js";
import {
  InMemoryDeployHistoryRepository,
  newDeployEvent,
  type DeployEventStatus,
  type DeployHistoryEvent,
  type DeployHistoryRepository,
  type DeployTarget,
  type InProgressState,
} from "../src/core/history.js";
import { DeployctlError, formatError } from "../src/shared.js";

const target: DeployTarget = {
  env: "staging",
  tenant: "client1",
  app: "backend",
};

const commit = "0123456789abcdef0123456789abcdef01234567";
const startedAt = new Date("2026-06-28T10:00:00Z");
const finishedAt = new Date("2026-06-28T10:01:00Z");

test("runDeployLifecycle starts the guardrail before work", async () => {
  const history = new InMemoryDeployHistoryRepository();
  let inProgress: InProgressState | undefined;

  await runDeployLifecycle({
    ...baseInput(history),
    work: async () => {
      inProgress = (await history.readCurrentState(target))?.inProgress;
      return "ok";
    },
  });

  assert.deepEqual(inProgress, {
    eventId: "dep_20260628_100000",
    since: "2026-06-28T10:00:00.000Z",
    actor: "manual",
  });
});

test("runDeployLifecycle clears the guardrail when work succeeds", async () => {
  const history = new InMemoryDeployHistoryRepository();

  await runDeployLifecycle({
    ...baseInput(history),
    work: async () => "ok",
  });

  assert.equal((await history.readCurrentState(target))?.inProgress, undefined);
});

test("runDeployLifecycle clears the guardrail when work throws", async () => {
  const history = new InMemoryDeployHistoryRepository();

  await assert.rejects(
    runDeployLifecycle({
      ...baseInput(history),
      work: async () => {
        throw new Error("boom");
      },
    }),
    /wrapped: boom/,
  );

  assert.equal((await history.readCurrentState(target))?.inProgress, undefined);
});

test("runDeployLifecycle appends a failure event before rethrowing guarded work errors", async () => {
  const history = new InMemoryDeployHistoryRepository();

  await assert.rejects(
    runDeployLifecycle({
      ...baseInput(history),
      work: async () => {
        throw new Error("SSM command timed out");
      },
      record: recordDeployEvents("success"),
    }),
    (error) => error instanceof DeployctlError && error.message === "wrapped: SSM command timed out",
  );

  const events = await history.listEvents(target);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "failure");
  assert.equal(events[0].errorMessage, "SSM command timed out");
  assert.equal((await history.readCurrentState(target))?.currentVersion, null);
});

test("runDeployLifecycle rethrows DeployctlError as-is after recording failure", async () => {
  const history = new InMemoryDeployHistoryRepository();

  await assert.rejects(
    runDeployLifecycle({
      ...baseInput(history),
      work: async () => {
        throw new DeployctlError("domain failure");
      },
      record: recordDeployEvents("success"),
    }),
    (error) => error instanceof DeployctlError && error.message === "domain failure",
  );

  assert.equal((await history.listEvents(target)).length, 1);
});

test("runDeployLifecycle appends a success event", async () => {
  const history = new InMemoryDeployHistoryRepository();

  await runDeployLifecycle({
    ...baseInput(history),
    work: async () => "ok",
    record: recordDeployEvents("success"),
  });

  const events = await history.listEvents(target);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "success");
});

test("runDeployLifecycle updates current state only when enabled and the event status is success", async () => {
  const history = new InMemoryDeployHistoryRepository();

  await runDeployLifecycle({
    ...baseInput(history),
    work: async () => "ok",
    record: recordDeployEvents("success", true),
  });

  const current = await history.readCurrentState(target);
  assert.equal(current?.currentVersion, commit);
  assert.equal(current?.lastSuccessfulEventId, "dep_20260628_100000");
  assert.equal(current?.inProgress, undefined);
});

test("runDeployLifecycle does not update current state for partial_failure or failure", async () => {
  for (const status of ["partial_failure", "failure"] as const) {
    const history = new InMemoryDeployHistoryRepository();

    await runDeployLifecycle({
      ...baseInput(history),
      work: async () => "ok",
      record: recordDeployEvents(status, true),
    });

    const current = await history.readCurrentState(target);
    assert.equal(current?.currentVersion, null);
    assert.equal(current?.lastSuccessfulEventId, null);
  }
});

test("runDeployLifecycle supports guarded work without history recording", async () => {
  const history = new InMemoryDeployHistoryRepository();

  const result = await runDeployLifecycle({
    ...baseInput(history),
    work: async () => ({ status: "success" as const }),
  });

  assert.deepEqual(result.result, { status: "success" });
  assert.deepEqual(await history.listEvents(target), []);
  const current = await history.readCurrentState(target);
  assert.equal(current?.currentVersion, null);
  assert.equal(current?.lastSuccessfulEventId, null);
  assert.equal(current?.inProgress, undefined);
});

function baseInput(history: DeployHistoryRepository) {
  let ticks = 0;
  return {
    target,
    actor: "manual",
    history,
    clock: () => (ticks++ === 0 ? startedAt : finishedAt),
    generateEventId: () => "dep_20260628_100000",
    errorMessage: (error: unknown) => `wrapped: ${formatError(error)}`,
  };
}

function recordDeployEvents(status: DeployEventStatus, updateCurrentStateOnSuccess = false) {
  return {
    updateCurrentStateOnSuccess,
    success: (_result: string, context: { eventId: string; startedAt: Date; finishedAt: Date }): DeployHistoryEvent =>
      newDeployEvent({
        target,
        eventId: context.eventId,
        requestedRef: "feature/foo",
        resolvedCommit: commit,
        actor: "manual",
        status,
        startedAt: context.startedAt,
        finishedAt: context.finishedAt,
      }),
    failure: (error: unknown, context: { eventId: string; startedAt: Date; finishedAt: Date }): DeployHistoryEvent =>
      newDeployEvent({
        target,
        eventId: context.eventId,
        requestedRef: "feature/foo",
        resolvedCommit: commit,
        actor: "manual",
        status: "failure",
        startedAt: context.startedAt,
        finishedAt: context.finishedAt,
        errorMessage: formatError(error),
      }),
  };
}
