import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { FixtureFrontendBuilder, NoopFrontendSmokeCheck } from "../src/adapters/fixture-frontend.js";
import { frontendArtifactKey } from "../src/core/frontend.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

test("FixtureFrontendBuilder embeds commit, env, tenant, and build variables in the output", async () => {
  const builder = new FixtureFrontendBuilder();
  const key = frontendArtifactKey({ env: "staging", tenant: "client1", resolvedCommit: commit, buildVariables: { VITE_TENANT: "client1" } });

  const artifact = await builder.build({
    key,
    buildVariables: { VITE_TENANT: "client1", VITE_ENVIRONMENT: "staging" },
    build: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build", buildConfigIdentityInputs: ["VITE_TENANT"] },
    applicationRepositoryUrl: ".",
  });

  const content = await readFile(artifact.storageKey, "utf8");

  assert.match(content, /client1/);
  assert.match(content, /staging/);
  assert.match(content, new RegExp(commit));
  assert.match(content, /VITE_TENANT=client1/);
  assert.match(content, /VITE_ENVIRONMENT=staging/);
  assert.equal(artifact.byteSize, Buffer.byteLength(content, "utf8"));
});

test("FixtureFrontendBuilder produces different content for different build variables", async () => {
  const builder = new FixtureFrontendBuilder();
  const baseRequest = {
    build: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build", buildConfigIdentityInputs: ["VITE_TENANT"] },
    applicationRepositoryUrl: ".",
  };

  const a = await builder.build({
    ...baseRequest,
    key: frontendArtifactKey({ env: "staging", tenant: "client1", resolvedCommit: commit, buildVariables: { VITE_TENANT: "client1" } }),
    buildVariables: { VITE_TENANT: "client1" },
  });
  const b = await builder.build({
    ...baseRequest,
    key: frontendArtifactKey({ env: "staging", tenant: "client2", resolvedCommit: commit, buildVariables: { VITE_TENANT: "client2" } }),
    buildVariables: { VITE_TENANT: "client2" },
  });

  assert.notEqual(await readFile(a.storageKey, "utf8"), await readFile(b.storageKey, "utf8"));
});

test("NoopFrontendSmokeCheck always reports healthy", async () => {
  const smokeCheck = new NoopFrontendSmokeCheck();

  assert.equal(await smokeCheck.check("https://client1.sherwood.science"), true);
  assert.equal(await smokeCheck.check("https://anything.example"), true);
});
