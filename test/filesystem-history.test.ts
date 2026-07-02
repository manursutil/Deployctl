import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileSystemDeployHistoryRepository } from "../src/adapters/filesystem-history.js";
import { applySuccessfulEventToCurrentState, previousSuccessfulVersion, type DeployEvent } from "../src/core/history.js";
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

async function newRepository(): Promise<FileSystemDeployHistoryRepository> {
  const rootDir = await mkdtemp(join(tmpdir(), "deployctl-sim-history-"));
  return new FileSystemDeployHistoryRepository(rootDir);
}

test("filesystem history repository appends events, updates current state, and finds previous successful version", async () => {
  const repository = await newRepository();

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
  assert.deepEqual(await repository.listEvents(target), [firstDeploy, secondDeploy]);
  assert.equal(await previousSuccessfulVersion(repository, target), firstDeploy.resolvedCommit);
});

test("filesystem history repository rejects duplicate append-only event IDs for a target", async () => {
  const repository = await newRepository();

  await repository.appendEvent(firstDeploy);

  await assert.rejects(
    () => repository.appendEvent(firstDeploy),
    (error) => error instanceof DeployctlError && /already exists/.test(error.message),
  );
});

test("filesystem history repository returns undefined current state and empty events for an unknown target", async () => {
  const repository = await newRepository();

  assert.equal(await repository.readCurrentState(target), undefined);
  assert.deepEqual(await repository.listEvents(target), []);
});

test("filesystem history repository persists current state as readable JSON matching the S3 contract shape", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "deployctl-sim-history-"));
  const repository = new FileSystemDeployHistoryRepository(rootDir);

  await repository.appendEvent(firstDeploy);
  await repository.updateCurrentState(applySuccessfulEventToCurrentState(firstDeploy));

  const eventPath = join(rootDir, "history", "deploys", target.env, target.tenant, target.app, "events", `${firstDeploy.eventId}.json`);
  const currentPath = join(rootDir, "history", "deploys", target.env, target.tenant, target.app, "current.json");

  assert.deepEqual(JSON.parse(await readFile(eventPath, "utf8")), firstDeploy);
  assert.equal(JSON.parse(await readFile(currentPath, "utf8")).currentVersion, firstDeploy.resolvedCommit);
});

test("filesystem history repository guardrail rejects a target that already has a deploy in progress", async () => {
  const repository = await newRepository();

  await repository.tryStartDeployment(target, { eventId: firstDeploy.eventId, since: firstDeploy.startedAt, actor: "manual" });

  await assert.rejects(
    () => repository.tryStartDeployment(target, { eventId: secondDeploy.eventId, since: secondDeploy.startedAt, actor: "manual" }),
    (error) => error instanceof DeployctlError && /already in progress/.test(error.message),
  );
});

test("filesystem history repository clears the guardrail by updating current state without inProgress", async () => {
  const repository = await newRepository();

  await repository.tryStartDeployment(target, { eventId: firstDeploy.eventId, since: firstDeploy.startedAt, actor: "manual" });
  await repository.updateCurrentState(applySuccessfulEventToCurrentState(firstDeploy));

  assert.equal((await repository.readCurrentState(target))?.inProgress, undefined);
});
