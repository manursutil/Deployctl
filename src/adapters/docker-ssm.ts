import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SsmBackendDeployRequest, SsmBackendDeployOutcome, SsmDeployExecutor } from "../core/deploy.js";
import type { DeployInstanceResult } from "../core/history.js";
import { DeployctlError, formatError } from "../shared.js";

const execFileAsync = promisify(execFile);

/**
 * Internal seam over the `docker` CLI: given argument vector, run it.
 * The default runs the real binary; adapter tests inject a fake so they never
 * touch a real container. Not part of the `SsmDeployExecutor` interface.
 */
export type DockerCommandRunner = (args: string[]) => Promise<void>;

const defaultRunDocker: DockerCommandRunner = async (args) => {
  await execFileAsync("docker", args);
};

export type DockerSimSsmDeployExecutorOptions = {
  releaseRoot: string;
  osUser: string;
};

/**
 * Sim Phase 2 stand-in for the real SSM Run Command executor
 * (docs/phase-0-simulation-plan.md). Runs `scripts/ec2/deploy-backend.sh`
 * inside a Docker "app-server" container via `docker exec`, using the
 * `instanceIds` SSM target selector entries as container names — no new
 * config shape. `releaseRoot`/`osUser` are executor-level constants (not part
 * of the per-request seam), matching how they're the same regardless of which
 * tenant or commit is being deployed.
 */
export class DockerSimSsmDeployExecutor implements SsmDeployExecutor {
  constructor(
    private readonly options: DockerSimSsmDeployExecutorOptions,
    private readonly runDocker: DockerCommandRunner = defaultRunDocker,
  ) {}

  async runBackendDeploy(request: SsmBackendDeployRequest): Promise<SsmBackendDeployOutcome> {
    if (request.ssmTarget.mode !== "instanceIds") {
      throw new DeployctlError(
        `Sim SSM executor only supports "instanceIds" targets (Docker container names); got: ${request.ssmTarget.mode}`,
      );
    }

    const ssmCommandId = `sim-${request.resolvedCommit.slice(0, 12)}-${Date.now()}`;
    const instances = await Promise.all(
      request.ssmTarget.instanceIds.map((containerName) => this.runOnContainer(containerName, request)),
    );

    return { ssmCommandId, instances };
  }

  private async runOnContainer(containerName: string, request: SsmBackendDeployRequest): Promise<DeployInstanceResult> {
    const args = ["exec", ...envFlags(this.buildEnv(request)), containerName, "/opt/deployctl/scripts/deploy-backend.sh"];

    try {
      await this.runDocker(args);
      return { instanceId: containerName, status: "success", version: request.resolvedCommit };
    } catch (error) {
      return { instanceId: containerName, status: "failure", errorMessage: formatError(error) };
    }
  }

  private buildEnv(request: SsmBackendDeployRequest): Record<string, string> {
    return {
      DEPLOYCTL_RELEASE_ROOT: this.options.releaseRoot,
      DEPLOYCTL_TENANT_BASE_DIR: request.tenant.appBaseDir,
      DEPLOYCTL_OS_USER: this.options.osUser,
      DEPLOYCTL_COMMIT: request.resolvedCommit,
      DEPLOYCTL_ENV: request.target.env,
      DEPLOYCTL_TENANT: request.target.tenant,
      DEPLOYCTL_API_PROCESS: request.tenant.apiProcess,
      DEPLOYCTL_WORKER_PROCESS: request.tenant.workerProcess,
      DEPLOYCTL_DB_SECRET_NAME: request.tenant.dbSecret,
      DEPLOYCTL_REDIS_SECRET_NAME: request.tenant.redisSecret,
    };
  }
}

function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}
