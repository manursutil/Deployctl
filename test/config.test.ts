import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDeployctlConfig, parseDeployctlConfig } from "../src/core/config.js";
import { DeployctlError } from "../src/shared.js";

test("loadDeployctlConfig validates YAML into typed project config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deployctl-config-"));
  const configPath = join(dir, "deployctl.config.yml");

  await writeFile(
    configPath,
    `aws:
  region: eu-west-1
applicationRepository:
  url: ssh://git@bitbucket.org/example/application-monorepo.git
build:
  backend:
    packageManager: npm
    installCommand: npm ci
    buildCommand: npm run build
  frontend:
    packageManager: npm
    installCommand: npm ci
    buildCommand: npm run build
    buildConfigIdentityInputs:
      - VITE_TENANT
deployHistory:
  bucket: deploy-history
  prefix: deploys
frontendArtifacts:
  bucket: deploy-artifacts
  prefix: frontend
refPolicies:
  staging:
    allowMovingBranches: true
  production:
    allowMovingBranches: false
retention:
  successfulVersionsPerTarget: 10
  keepDays: 30
`,
  );

  const config = await loadDeployctlConfig(configPath);

  assert.equal(config.aws.region, "eu-west-1");
  assert.equal(config.build.frontend.buildConfigIdentityInputs[0], "VITE_TENANT");
  assert.equal(config.refPolicies.production.allowMovingBranches, false);
});

test("parseDeployctlConfig rejects missing required config", () => {
  assert.throws(
    () => parseDeployctlConfig({ aws: { region: "eu-west-1" } }),
    (error) => error instanceof DeployctlError && /applicationRepository must be an object/.test(error.message),
  );
});
