#!/usr/bin/env node
import { loadDeployctlConfig } from "./core/config.js";
import { getTenantConfig, listTenants, loadTenantRegistry } from "./core/tenants.js";
import { DeployctlError, formatError, type Io } from "./shared.js";

const usage = `deployctl

Usage:
  deployctl --help
  deployctl config check [--config <path>]
  deployctl tenants list --env <env> [--tenants <path>]
  deployctl status --tenant <tenant> --env <env>
  deployctl deploy backend|frontend --tenant <tenant> --env <env> --ref <ref>
  deployctl rollback backend|frontend --tenant <tenant> --env <env> [--version <version>]
  deployctl cleanup releases|artifacts --env <env> [--dry-run]
  deployctl logs --tenant <tenant> --env <env> --service <api|worker> --since <duration>

Options:
  --config <path>  Path to deployctl.config.yml
  --tenants <path> Path to tenants.yml
  -h, --help       Show this help
`;

export async function runCli(argv: string[], io: Io = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  try {
    const args = [...argv];

    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      io.stdout.write(usage);
      return 0;
    }

    if (args[0] === "config" && args[1] === "check") {
      const configPath = optionValue(args, "--config") ?? "deployctl.config.yml";
      await loadDeployctlConfig(configPath);
      io.stdout.write(`Config OK: ${configPath}\n`);
      return 0;
    }

    if (args[0] === "tenants" && args[1] === "list") {
      const environment = optionValue(args, "--env");
      if (environment === undefined) {
        throw new DeployctlError("--env requires a value");
      }

      const tenantsPath = optionValue(args, "--tenants") ?? "tenants.yml";
      const registry = await loadTenantRegistry(tenantsPath);
      for (const tenant of listTenants(registry, environment)) {
        io.stdout.write(`${tenant}\n`);
      }

      return 0;
    }

    if (args[0] === "status") {
      return await runStatus(args, io);
    }

    if (args[0] === "deploy" && args[1] === "backend") {
      return await runDeployBackend(args, io);
    }

    if (args[0] === "deploy" && args[1] === "frontend") {
      return await runDeployFrontend(args, io);
    }

    if (args[0] === "rollback" && args[1] === "backend") {
      return await runRollbackBackend(args, io);
    }

    if (args[0] === "rollback" && args[1] === "frontend") {
      return await runRollbackFrontend(args, io);
    }

    if (args[0] === "cleanup") {
      return await runCleanup(args, io);
    }

    throw new DeployctlError(`Command not implemented yet: ${args.join(" ")}`);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return error instanceof DeployctlError ? error.exitCode : 1;
  }
}

async function runStatus(args: string[], io: Io): Promise<number> {
  const tenant = requiredOption(args, "--tenant");
  const environment = requiredOption(args, "--env");

  const registry = await loadTenantRegistry(optionValue(args, "--tenants") ?? "tenants.yml");

  // Validate the tenant/env offline before reporting the pending boundary.
  getTenantConfig(registry, environment, tenant);

  io.stdout.write(`Validated status query for ${environment}/${tenant}.\n`);

  // getTenantStatus is implemented and unit-tested behind the DeployHistoryRepository
  // seam, but the S3-backed repository adapter that reads real current.json records is
  // still pending Phase 0 infra confirmation, so no live status can be read yet.
  throw new DeployctlError(
    `Status for ${environment}/${tenant} is not yet readable: the S3 deploy history adapter is pending (Phase 4/9).`,
  );
}

async function runDeployBackend(args: string[], io: Io): Promise<number> {
  const tenant = requiredOption(args, "--tenant");
  const environment = requiredOption(args, "--env");
  const requestedRef = requiredOption(args, "--ref");

  const config = await loadDeployctlConfig(optionValue(args, "--config") ?? "deployctl.config.yml");
  const registry = await loadTenantRegistry(optionValue(args, "--tenants") ?? "tenants.yml");

  // Validate everything resolvable without AWS or network before reporting the
  // pending boundary, so operators get input errors immediately.
  getTenantConfig(registry, environment, tenant);

  if (config.ssmTargets[environment] === undefined) {
    throw new DeployctlError(`No SSM target selector configured for environment: ${environment}`);
  }

  io.stdout.write(`Validated backend deploy for ${environment}/${tenant} (ref ${requestedRef}).\n`);

  // The orchestration module (deployBackend) is implemented and unit-tested
  // behind the SsmDeployExecutor seam, but the production SSM executor and the
  // S3-backed deploy history adapter are still pending Phase 0 infra
  // confirmation, so no real deploy runs yet.
  throw new DeployctlError(
    `Backend deploy for ${environment}/${tenant} is not yet executable: the SSM executor and S3 deploy history adapters are pending (Phase 6).`,
  );
}

async function runDeployFrontend(args: string[], io: Io): Promise<number> {
  const tenant = requiredOption(args, "--tenant");
  const environment = requiredOption(args, "--env");
  const requestedRef = requiredOption(args, "--ref");

  await loadDeployctlConfig(optionValue(args, "--config") ?? "deployctl.config.yml");
  const registry = await loadTenantRegistry(optionValue(args, "--tenants") ?? "tenants.yml");

  // Validate the tenant/env (and that it has a frontend bucket/URL) offline
  // before reporting the pending boundary.
  getTenantConfig(registry, environment, tenant);

  io.stdout.write(`Validated frontend deploy for ${environment}/${tenant} (ref ${requestedRef}).\n`);

  // The orchestration module (deployFrontend) is implemented and unit-tested
  // behind the artifact-store, builder, sync, and smoke-check seams, but the
  // production S3/build adapters and the build-variable source are still pending
  // Phase 0 confirmation, so no real deploy runs yet.
  throw new DeployctlError(
    `Frontend deploy for ${environment}/${tenant} is not yet executable: the S3 artifact/sync and build adapters are pending (Phase 7).`,
  );
}

async function runRollbackBackend(args: string[], io: Io): Promise<number> {
  const tenant = requiredOption(args, "--tenant");
  const environment = requiredOption(args, "--env");
  const toVersion = optionValue(args, "--version");

  const config = await loadDeployctlConfig(optionValue(args, "--config") ?? "deployctl.config.yml");
  const registry = await loadTenantRegistry(optionValue(args, "--tenants") ?? "tenants.yml");

  // Validate everything resolvable without AWS or network before reporting the
  // pending boundary, so operators get input errors immediately.
  getTenantConfig(registry, environment, tenant);

  if (config.ssmTargets[environment] === undefined) {
    throw new DeployctlError(`No SSM target selector configured for environment: ${environment}`);
  }

  const target = toVersion === undefined ? "the previous version" : toVersion;
  io.stdout.write(`Validated backend rollback for ${environment}/${tenant} (to ${target}).\n`);

  // The orchestration module (rollbackBackend) is implemented and unit-tested
  // behind the SsmDeployExecutor seam, but the production SSM executor and the
  // S3-backed deploy history adapter (which supplies the version to restore) are
  // still pending Phase 0 infra confirmation, so no real rollback runs yet.
  throw new DeployctlError(
    `Backend rollback for ${environment}/${tenant} is not yet executable: the SSM executor and S3 deploy history adapters are pending (Phase 8).`,
  );
}

async function runRollbackFrontend(args: string[], io: Io): Promise<number> {
  const tenant = requiredOption(args, "--tenant");
  const environment = requiredOption(args, "--env");
  const toVersion = optionValue(args, "--version");

  const registry = await loadTenantRegistry(optionValue(args, "--tenants") ?? "tenants.yml");

  // Validate the tenant/env offline before reporting the pending boundary.
  getTenantConfig(registry, environment, tenant);

  const target = toVersion === undefined ? "the previous version" : toVersion;
  io.stdout.write(`Validated frontend rollback for ${environment}/${tenant} (to ${target}).\n`);

  // The orchestration module (rollbackFrontend) is implemented and unit-tested
  // behind the frontend sync/smoke-check seams, but the production S3 sync adapter
  // and the S3-backed deploy history adapter (which supplies the artifact to
  // re-sync) are still pending Phase 0 confirmation, so no real rollback runs yet.
  throw new DeployctlError(
    `Frontend rollback for ${environment}/${tenant} is not yet executable: the S3 sync and deploy history adapters are pending (Phase 8).`,
  );
}

async function runCleanup(args: string[], io: Io): Promise<number> {
  const resource = args[1];

  if (resource !== "releases" && resource !== "artifacts") {
    throw new DeployctlError(`cleanup expects "releases" or "artifacts": ${args.slice(1).join(" ") || "(missing)"}`);
  }

  const environment = requiredOption(args, "--env");
  const app = resource === "releases" ? "backend" : "frontend";

  // Load config (retention policy) and registry, and validate the environment
  // offline before reporting the pending boundary. Cleanup is always dry-run.
  await loadDeployctlConfig(optionValue(args, "--config") ?? "deployctl.config.yml");
  const registry = await loadTenantRegistry(optionValue(args, "--tenants") ?? "tenants.yml");
  listTenants(registry, environment);

  io.stdout.write(`Validated ${app} cleanup (dry-run) for environment ${environment}.\n`);

  // The retention decision logic (planTargetRetention) is implemented and
  // unit-tested behind the DeployHistoryRepository seam, but the S3-backed
  // history adapter it reads and the CleanupExecutor that deletes the plan's
  // `delete` set are still pending Phase 0 confirmation, so no plan can be
  // computed against real state yet.
  throw new DeployctlError(
    `Cleanup of ${app} for ${environment} is not yet available: the S3 deploy history adapter and cleanup executor are pending (Phase 11).`,
  );
}

function requiredOption(args: string[], name: string): string {
  const value = optionValue(args, name);

  if (value === undefined) {
    throw new DeployctlError(`${name} requires a value`);
  }

  return value;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new DeployctlError(`${name} requires a value`);
  }

  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli(process.argv.slice(2));
}
