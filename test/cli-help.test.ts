import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("deployctl shows the available command groups", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /deployctl/);
  assert.match(result.stdout, /tenants list/);
  assert.match(result.stdout, /deploy backend/);
  assert.match(result.stdout, /deploy frontend/);
  assert.match(result.stdout, /rollback backend/);
  assert.match(result.stdout, /logs/);
});
