import type { DeployctlConfig } from "./core/config.js";
import type { SsmDeployExecutor } from "./core/deploy.js";
import type { FrontendArtifactStore, FrontendBuilder, FrontendSmokeCheck, FrontendSync } from "./core/frontend.js";
import type { DeployHistoryRepository } from "./core/history.js";
import type { LogQuery } from "./core/logs.js";
import type { RefResolver } from "./core/refs.js";
import { DeployctlError } from "./shared.js";

/**
 * Ambient runtime inputs the composition root needs but that are not part of the
 * declarative config: currently just the sim state root. Reading `process.env`
 * happens once here (`runtimeFromEnv`) instead of being smeared across controllers.
 */
export type Runtime = {
  /** Root dir for sim filesystem state; when undefined each adapter falls back to its own default (`.deployctl-sim`). */
  simRoot?: string;
};

/**
 * Composition root: the single place that constructs adapter (port) implementations
 * for a given `adapterMode`. Both the CLI and the future dashboard (Phase 15) call
 * `createAdapterProvider` so the dashboard is a second thin caller of the same
 * orchestration modules rather than a fork of the wiring.
 *
 * Every method is async so the concrete adapter module is loaded lazily via dynamic
 * `import()` at call time. A sim run never loads AWS adapters and an AWS run never
 * loads the Docker/filesystem adapters, keeping each invocation's infrastructure
 * footprint to only what it actually uses.
 */
export type AdapterProvider = {
  refResolver(): Promise<RefResolver>;
  history(): Promise<DeployHistoryRepository>;
  ssmExecutor(): Promise<SsmDeployExecutor>;
  frontendArtifacts(): Promise<FrontendArtifactStore>;
  frontendBuilder(): Promise<FrontendBuilder>;
  frontendSync(): Promise<FrontendSync>;
  frontendSmokeCheck(): Promise<FrontendSmokeCheck>;
  logQuery(): Promise<LogQuery>;
};

export function runtimeFromEnv(): Runtime {
  // DEPLOYCTL_SIM_ROOT lets tests and demo scripts isolate simulation state; when
  // unset the adapters default to .deployctl-sim in the current working directory.
  return { simRoot: process.env.DEPLOYCTL_SIM_ROOT };
}

export function createAdapterProvider(config: DeployctlConfig, runtime: Runtime = {}): AdapterProvider {
  switch (config.adapterMode) {
    case "sim":
      return createSimProvider(config, runtime);
    case "aws":
      return createAwsProvider();
  }
}

/**
 * Sim provider (docs/phase-0-simulation-plan.md): the filesystem/Docker/fixture
 * adapters that let the deploy model be demonstrated without real AWS. Each adapter
 * module is imported lazily so requiring this module loads no infrastructure.
 */
function createSimProvider(config: DeployctlConfig, runtime: Runtime): AdapterProvider {
  const { simRoot } = runtime;

  return {
    async refResolver() {
      const { GitCliRefResolver } = await import("./adapters/git.js");
      return new GitCliRefResolver();
    },
    async history() {
      const { FileSystemDeployHistoryRepository } = await import("./adapters/filesystem-history.js");
      return new FileSystemDeployHistoryRepository(simRoot);
    },
    async ssmExecutor() {
      const { DockerSimSsmDeployExecutor } = await import("./adapters/docker-ssm.js");
      return new DockerSimSsmDeployExecutor({
        releaseRoot: config.backendDeploy.releaseRoot,
        osUser: config.backendDeploy.osUser,
      });
    },
    async frontendArtifacts() {
      const { FileSystemFrontendArtifactStore } = await import("./adapters/filesystem-frontend.js");
      return new FileSystemFrontendArtifactStore(simRoot);
    },
    async frontendBuilder() {
      const { FixtureFrontendBuilder } = await import("./adapters/fixture-frontend.js");
      return new FixtureFrontendBuilder();
    },
    async frontendSync() {
      const { FileSystemFrontendSync } = await import("./adapters/filesystem-frontend.js");
      return new FileSystemFrontendSync(simRoot);
    },
    async frontendSmokeCheck() {
      const { NoopFrontendSmokeCheck } = await import("./adapters/fixture-frontend.js");
      return new NoopFrontendSmokeCheck();
    },
    async logQuery() {
      const { FileSystemLogQuery } = await import("./adapters/filesystem-logs.js");
      return new FileSystemLogQuery(simRoot);
    },
  };
}

/**
 * AWS provider: the real SSM/S3/CloudWatch adapters are still pending Phase 0
 * infrastructure confirmation, so every port throws until they land. Controllers
 * report their own command-specific pending boundary before reaching these, so
 * this is the future home for the real adapters, not the current user-facing error.
 */
function createAwsProvider(): AdapterProvider {
  const pending = (): never => {
    throw new DeployctlError("AWS adapters are not wired yet; they are pending Phase 0 cutover.");
  };

  return {
    refResolver: async () => pending(),
    history: async () => pending(),
    ssmExecutor: async () => pending(),
    frontendArtifacts: async () => pending(),
    frontendBuilder: async () => pending(),
    frontendSync: async () => pending(),
    frontendSmokeCheck: async () => pending(),
    logQuery: async () => pending(),
  };
}
