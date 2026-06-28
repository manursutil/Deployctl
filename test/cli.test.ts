import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("deployctl --help prints usage", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /deployctl deploy backend\|frontend/);
  assert.equal(result.stderr, "");
});
