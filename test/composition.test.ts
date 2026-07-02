import assert from "node:assert/strict";
import { test } from "node:test";
import { DockerSimSsmDeployExecutor } from "../src/adapters/docker-ssm.js";
import { FileSystemDeployHistoryRepository } from "../src/adapters/filesystem-history.js";
import { FileSystemFrontendArtifactStore, FileSystemFrontendSync } from "../src/adapters/filesystem-frontend.js";
import { FileSystemLogQuery } from "../src/adapters/filesystem-logs.js";
import { FixtureFrontendBuilder, NoopFrontendSmokeCheck } from "../src/adapters/fixture-frontend.js";
import { GitCliRefResolver } from "../src/adapters/git.js";
import { createAdapterProvider } from "../src/composition.js";
import type { DeployctlConfig } from "../src/core/config.js";
import { DeployctlError } from "../src/shared.js";

const baseConfig: DeployctlConfig = {
  adapterMode: "sim",
  aws: { region: "eu-west-1" },
  applicationRepository: { url: "." },
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
  ssmTargets: { staging: { mode: "instanceIds", instanceIds: ["i-0abc"] } },
  backendDeploy: { releaseRoot: "/opt/sherwood/releases", osUser: "sherwood" },
  retention: { successfulVersionsPerTarget: 10, keepDays: 30 },
};

test("createAdapterProvider wires the sim adapters for adapterMode: sim", async () => {
  const provider = createAdapterProvider({ ...baseConfig, adapterMode: "sim" }, { simRoot: ".deployctl-sim" });

  assert.ok((await provider.refResolver()) instanceof GitCliRefResolver);
  assert.ok((await provider.history()) instanceof FileSystemDeployHistoryRepository);
  assert.ok((await provider.ssmExecutor()) instanceof DockerSimSsmDeployExecutor);
  assert.ok((await provider.frontendArtifacts()) instanceof FileSystemFrontendArtifactStore);
  assert.ok((await provider.frontendBuilder()) instanceof FixtureFrontendBuilder);
  assert.ok((await provider.frontendSync()) instanceof FileSystemFrontendSync);
  assert.ok((await provider.frontendSmokeCheck()) instanceof NoopFrontendSmokeCheck);
  assert.ok((await provider.logQuery()) instanceof FileSystemLogQuery);
});

test("createAdapterProvider rejects every port for adapterMode: aws until real adapters land", async () => {
  const provider = createAdapterProvider({ ...baseConfig, adapterMode: "aws" });

  await assert.rejects(provider.refResolver(), DeployctlError);
  await assert.rejects(provider.history(), DeployctlError);
  await assert.rejects(provider.ssmExecutor(), DeployctlError);
  await assert.rejects(provider.frontendArtifacts(), DeployctlError);
  await assert.rejects(provider.frontendBuilder(), DeployctlError);
  await assert.rejects(provider.frontendSync(), DeployctlError);
  await assert.rejects(provider.frontendSmokeCheck(), DeployctlError);
  await assert.rejects(provider.logQuery(), DeployctlError);
});
