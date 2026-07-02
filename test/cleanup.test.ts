import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deploymentRetentionCandidates,
  planRetention,
  planTargetRetention,
  type RetentionCandidate,
  type RetentionPolicy,
} from "../src/core/cleanup.js";
import {
  applySuccessfulEventToCurrentState,
  InMemoryDeployHistoryRepository,
  newDeployEvent,
  type DeployHistoryRepository,
  type DeployTarget,
} from "../src/core/history.js";

const policy: RetentionPolicy = { successfulVersionsPerTarget: 3, keepDays: 30 };
const now = new Date("2026-07-01T00:00:00Z");

function candidate(version: string, daysAgo: number, isCurrent = false): RetentionCandidate {
  const at = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { version, lastSuccessfulAt: at, isCurrent };
}

test("planRetention keeps the newest N versions and deletes older ones beyond the window", () => {
  const plan = planRetention(
    [
      candidate("v1", 200),
      candidate("v2", 150),
      candidate("v3", 120),
      candidate("v4", 100),
      candidate("v5", 90),
    ],
    policy,
    now,
  );

  assert.deepEqual(plan.keep.map((d) => d.version), ["v5", "v4", "v3"]);
  assert.deepEqual(plan.delete.map((d) => d.version), ["v2", "v1"]);
  assert.ok(plan.keep[0].reasons.includes("within last 3 successful versions"));
});

test("planRetention keeps anything deployed within keepDays even beyond the count", () => {
  const plan = planRetention(
    [
      candidate("recent1", 1),
      candidate("recent2", 2),
      candidate("recent3", 3),
      candidate("recent4", 4),
      candidate("old", 200),
    ],
    policy,
    now,
  );

  // recent4 is beyond the newest-3 count but still within 30 days, so it survives.
  assert.ok(plan.keep.map((d) => d.version).includes("recent4"));
  assert.ok(plan.keep.find((d) => d.version === "recent4")?.reasons.includes("deployed within 30 days"));
  assert.deepEqual(plan.delete.map((d) => d.version), ["old"]);
});

test("planRetention always keeps the current version even if old and beyond the count", () => {
  const plan = planRetention(
    [
      candidate("new1", 1),
      candidate("new2", 2),
      candidate("new3", 3),
      candidate("pinned-old", 300, true),
    ],
    policy,
    now,
  );

  const pinned = plan.keep.find((d) => d.version === "pinned-old");
  assert.ok(pinned, "current version is kept");
  assert.deepEqual(pinned?.reasons, ["current"]);
  assert.equal(plan.delete.length, 0);
});

async function seedBackend(history: DeployHistoryRepository, target: DeployTarget, commit: string, at: string, makeCurrent = false): Promise<void> {
  const event = newDeployEvent({
    target,
    eventId: `dep_${commit.slice(0, 6)}_${Date.parse(at)}`,
    requestedRef: "main",
    resolvedCommit: commit,
    actor: "manual",
    status: "success",
    startedAt: new Date(at),
    finishedAt: new Date(at),
  });
  await history.appendEvent(event);
  if (makeCurrent) {
    await history.updateCurrentState(applySuccessfulEventToCurrentState(event));
  }
}

const backendTarget: DeployTarget = { env: "staging", tenant: "client1", app: "backend" };
const frontendTarget: DeployTarget = { env: "staging", tenant: "client1", app: "frontend" };

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

test("deploymentRetentionCandidates groups backend history by commit and marks the current one", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedBackend(history, backendTarget, commitA, "2026-06-01T10:00:00Z");
  await seedBackend(history, backendTarget, commitA, "2026-06-10T10:00:00Z"); // redeploy of same commit
  await seedBackend(history, backendTarget, commitB, "2026-06-20T10:00:00Z", true);

  const candidates = deploymentRetentionCandidates(backendTarget, await history.listEvents(backendTarget), await history.readCurrentState(backendTarget));

  assert.equal(candidates.length, 2);
  const a = candidates.find((c) => c.version === commitA);
  assert.equal(a?.lastSuccessfulAt, "2026-06-10T10:00:00.000Z", "uses the most recent successful deploy of the commit");
  assert.equal(a?.isCurrent, false);
  assert.equal(candidates.find((c) => c.version === commitB)?.isCurrent, true);
});

test("deploymentRetentionCandidates keys frontend history by artifact storage key", async () => {
  const history = new InMemoryDeployHistoryRepository();
  const oldEvent = newDeployEvent({
    target: frontendTarget,
    eventId: "dep_1",
    requestedRef: "main",
    resolvedCommit: commitA,
    actor: "manual",
    status: "success",
    startedAt: new Date("2026-06-01T10:00:00Z"),
    finishedAt: new Date("2026-06-01T10:00:00Z"),
    artifactStorageKey: "frontend/aaa/staging/client1-old.tar.gz",
  });
  const newEvent = newDeployEvent({
    target: frontendTarget,
    eventId: "dep_2",
    requestedRef: "main",
    resolvedCommit: commitB,
    actor: "manual",
    status: "success",
    startedAt: new Date("2026-06-20T10:00:00Z"),
    finishedAt: new Date("2026-06-20T10:00:00Z"),
    artifactStorageKey: "frontend/bbb/staging/client1-new.tar.gz",
  });
  await history.appendEvent(oldEvent);
  await history.appendEvent(newEvent);
  await history.updateCurrentState(applySuccessfulEventToCurrentState(newEvent));

  const candidates = deploymentRetentionCandidates(frontendTarget, await history.listEvents(frontendTarget), await history.readCurrentState(frontendTarget));

  assert.deepEqual(
    candidates.map((c) => c.version).sort(),
    ["frontend/aaa/staging/client1-old.tar.gz", "frontend/bbb/staging/client1-new.tar.gz"],
  );
  assert.equal(candidates.find((c) => c.version === "frontend/bbb/staging/client1-new.tar.gz")?.isCurrent, true);
});

test("planTargetRetention keeps the current backend release and prunes old ones beyond the policy", async () => {
  const history = new InMemoryDeployHistoryRepository();
  await seedBackend(history, backendTarget, "1".repeat(40), "2025-01-01T10:00:00Z"); // very old
  await seedBackend(history, backendTarget, "2".repeat(40), "2026-06-20T10:00:00Z", true); // current

  const plan = await planTargetRetention(history, backendTarget, { successfulVersionsPerTarget: 1, keepDays: 30 }, now);

  assert.deepEqual(plan.keep.map((d) => d.version), ["2".repeat(40)]);
  assert.deepEqual(plan.delete.map((d) => d.version), ["1".repeat(40)]);
});
