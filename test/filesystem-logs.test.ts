import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileSystemLogQuery } from "../src/adapters/filesystem-logs.js";
import { DeployctlError } from "../src/shared.js";

async function seedLog(rootDir: string, env: string, tenant: string, service: string, lines: string[]): Promise<void> {
  const dir = join(rootDir, "logs", env, tenant);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${service}.log`), lines.map((line) => `${line}\n`).join(""), "utf8");
}

function entryLine(timestamp: string, service: string, message: string): string {
  return JSON.stringify({ timestamp, env: "staging", tenant: "client1", service, message });
}

test("FileSystemLogQuery returns only entries at or after the since cutoff, from the service's file", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "deployctl-sim-logs-"));
  await seedLog(rootDir, "staging", "client1", "api", [
    entryLine("2026-07-02T10:00:00Z", "api", "too old"),
    entryLine("2026-07-02T11:30:00Z", "api", "in window"),
    entryLine("2026-07-02T11:59:00Z", "api", "also in window"),
  ]);
  await seedLog(rootDir, "staging", "client1", "worker", [entryLine("2026-07-02T11:45:00Z", "worker", "worker line")]);

  const entries = await new FileSystemLogQuery(rootDir).query({
    env: "staging",
    tenant: "client1",
    service: "api",
    since: new Date("2026-07-02T11:00:00Z"),
  });

  assert.deepEqual(
    entries.map((entry) => entry.message),
    ["in window", "also in window"],
  );
});

test("FileSystemLogQuery returns an empty list when the service log file is absent", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "deployctl-sim-logs-"));

  const entries = await new FileSystemLogQuery(rootDir).query({
    env: "staging",
    tenant: "client1",
    service: "worker",
    since: new Date("2026-07-02T00:00:00Z"),
  });

  assert.deepEqual(entries, []);
});

test("FileSystemLogQuery rejects a malformed log line", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "deployctl-sim-logs-"));
  await seedLog(rootDir, "staging", "client1", "api", ["not json"]);

  await assert.rejects(
    () => new FileSystemLogQuery(rootDir).query({ env: "staging", tenant: "client1", service: "api", since: new Date(0) }),
    (error) => error instanceof DeployctlError && /Malformed log line/.test(error.message),
  );
});
