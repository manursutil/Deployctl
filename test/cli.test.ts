import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("deployctl tenants list prints tenants for an environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deployctl-tenants-"));
  const tenantsPath = join(dir, "tenants.yml");

  await writeFile(
    tenantsPath,
    `staging:
  client1:
    frontendBucket: skincair-staging-frontend-client1
    dbSecret: skincair/staging/db/client1
    redisSecret: skincair/staging/redis
    apiProcess: sherwood-api-client1
    workerProcess: sherwood-worker-client1
    appBaseDir: /opt/sherwood/tenants/client1
    backendHealthUrl: https://client1.sherwood.science/health
    frontendUrl: https://client1.sherwood.science
  client2:
    frontendBucket: skincair-staging-frontend-client2
    dbSecret: skincair/staging/db/client2
    redisSecret: skincair/staging/redis
    apiProcess: sherwood-api-client2
    workerProcess: sherwood-worker-client2
    appBaseDir: /opt/sherwood/tenants/client2
    backendHealthUrl: https://client2.sherwood.science/health
    frontendUrl: https://client2.sherwood.science
`,
  );

  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "tenants", "list", "--env", "staging", "--tenants", tenantsPath], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "client1\nclient2\n");
  assert.equal(result.stderr, "");
});

test("deployctl tenants list exits non-zero with a clear message for missing tenants config", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "tenants", "list", "--env", "staging", "--tenants", "does-not-exist.yml"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not read tenants config at does-not-exist.yml/);
});

test("deployctl deploy backend requires --ref", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "deploy", "backend", "--tenant", "client1", "--env", "staging"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--ref requires a value/);
});

test("deployctl deploy backend rejects an unknown tenant before any AWS work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "deploy", "backend", "--tenant", "ghost", "--env", "staging", "--ref", "main"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tenant not found in staging: ghost/);
});

test("deployctl deploy backend validates inputs and reports that AWS execution is still pending", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "deploy", "backend", "--tenant", "client1", "--env", "staging", "--ref", "main"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet executable/);
});

test("deployctl deploy frontend rejects an unknown tenant before any AWS work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "deploy", "frontend", "--tenant", "ghost", "--env", "staging", "--ref", "main"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tenant not found in staging: ghost/);
});

test("deployctl deploy frontend validates inputs and reports that AWS execution is still pending", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "deploy", "frontend", "--tenant", "client1", "--env", "staging", "--ref", "main"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet executable/);
});
