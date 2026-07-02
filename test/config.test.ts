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
ssmTargets:
  staging:
    mode: instanceIds
    instanceIds:
      - i-0abc123staging
  production:
    mode: asg
    autoScalingGroupName: sherwood-prod-asg
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

const baseConfigObject = () => ({
  aws: { region: "eu-west-1" },
  applicationRepository: { url: "ssh://git@bitbucket.org/example/app.git" },
  build: {
    backend: { packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build" },
    frontend: {
      packageManager: "npm",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      buildConfigIdentityInputs: ["VITE_TENANT"],
    },
  },
  deployHistory: { bucket: "deploy-history", prefix: "deploys" },
  frontendArtifacts: { bucket: "deploy-artifacts", prefix: "frontend" },
  refPolicies: { staging: { allowMovingBranches: true } },
  ssmTargets: {
    staging: { mode: "instanceIds", instanceIds: ["i-0abc123staging"] },
    production: { mode: "asg", autoScalingGroupName: "sherwood-prod-asg" },
  },
  retention: { successfulVersionsPerTarget: 10, keepDays: 30 },
});

test("parseDeployctlConfig reads per-environment SSM target selectors by mode", () => {
  const config = parseDeployctlConfig(baseConfigObject());

  assert.deepEqual(config.ssmTargets.staging, { mode: "instanceIds", instanceIds: ["i-0abc123staging"] });
  assert.deepEqual(config.ssmTargets.production, { mode: "asg", autoScalingGroupName: "sherwood-prod-asg" });
});

test("parseDeployctlConfig rejects an unknown SSM target mode", () => {
  const value = baseConfigObject();
  value.ssmTargets.staging = { mode: "ssh", instanceIds: ["i-0abc123staging"] } as never;

  assert.throws(
    () => parseDeployctlConfig(value),
    (error) => error instanceof DeployctlError && /ssmTargets\.staging\.mode/.test(error.message),
  );
});

test("parseDeployctlConfig rejects an instanceIds selector with no instances", () => {
  const value = baseConfigObject();
  value.ssmTargets.staging = { mode: "instanceIds", instanceIds: [] } as never;

  assert.throws(
    () => parseDeployctlConfig(value),
    (error) => error instanceof DeployctlError && /ssmTargets\.staging\.instanceIds/.test(error.message),
  );
});

test("parseDeployctlConfig rejects missing required config", () => {
  assert.throws(
    () => parseDeployctlConfig({ aws: { region: "eu-west-1" } }),
    (error) => error instanceof DeployctlError && /applicationRepository must be an object/.test(error.message),
  );
});

test("parseDeployctlConfig defaults adapterMode to aws when omitted", () => {
  const config = parseDeployctlConfig(baseConfigObject());

  assert.equal(config.adapterMode, "aws");
});

test("parseDeployctlConfig accepts an explicit sim adapterMode", () => {
  const value = { ...baseConfigObject(), adapterMode: "sim" };

  assert.equal(parseDeployctlConfig(value).adapterMode, "sim");
});

test("parseDeployctlConfig rejects an unknown adapterMode", () => {
  const value = { ...baseConfigObject(), adapterMode: "gcp" };

  assert.throws(
    () => parseDeployctlConfig(value),
    (error) => error instanceof DeployctlError && /adapterMode must be "aws" or "sim"/.test(error.message),
  );
});
