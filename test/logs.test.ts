import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatLogEntries,
  getTenantLogs,
  parseLogService,
  parseSinceDuration,
  type LogEntry,
  type LogQuery,
} from "../src/core/logs.js";
import { DeployctlError } from "../src/shared.js";

const now = new Date("2026-07-02T12:00:00Z");

test("parseSinceDuration handles second, minute, hour, and day units", () => {
  assert.equal(parseSinceDuration("45s", now).toISOString(), "2026-07-02T11:59:15.000Z");
  assert.equal(parseSinceDuration("30m", now).toISOString(), "2026-07-02T11:30:00.000Z");
  assert.equal(parseSinceDuration("1h", now).toISOString(), "2026-07-02T11:00:00.000Z");
  assert.equal(parseSinceDuration("2d", now).toISOString(), "2026-06-30T12:00:00.000Z");
});

test("parseSinceDuration rejects a malformed duration", () => {
  assert.throws(
    () => parseSinceDuration("1 hour", now),
    (error) => error instanceof DeployctlError && /Invalid --since duration/.test(error.message),
  );
});

test("parseLogService rejects an unknown service", () => {
  assert.equal(parseLogService("api"), "api");
  assert.equal(parseLogService("worker"), "worker");
  assert.throws(
    () => parseLogService("db"),
    (error) => error instanceof DeployctlError && /--service must be/.test(error.message),
  );
});

test("getTenantLogs passes the parsed cutoff to the seam and returns entries oldest-first", async () => {
  const filters: { env: string; tenant: string; service: string; since: Date }[] = [];
  const unsorted: LogEntry[] = [
    { timestamp: "2026-07-02T11:59:00Z", env: "staging", tenant: "client1", service: "api", message: "second" },
    { timestamp: "2026-07-02T11:30:00Z", env: "staging", tenant: "client1", service: "api", message: "first" },
  ];
  const logs: LogQuery = {
    async query(filter) {
      filters.push(filter);
      return unsorted;
    },
  };

  const entries = await getTenantLogs(logs, { env: "staging", tenant: "client1", service: "api", since: "1h", now });

  assert.deepEqual(filters[0], { env: "staging", tenant: "client1", service: "api", since: new Date("2026-07-02T11:00:00Z") });
  assert.deepEqual(
    entries.map((entry) => entry.message),
    ["first", "second"],
  );
});

test("formatLogEntries renders one line per entry and a clear empty message", () => {
  assert.equal(formatLogEntries([]), "no matching log entries\n");
  assert.equal(
    formatLogEntries([{ timestamp: "2026-07-02T11:30:00Z", env: "staging", tenant: "client1", service: "api", message: "api started" }]),
    "2026-07-02T11:30:00Z [staging/client1/api] api started\n",
  );
});
