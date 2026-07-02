import { DeployctlError, formatError } from "../shared.js";
import type { DeployctlConfig } from "./config.js";
import type { SsmDeployExecutor } from "./deploy.js";
import { clearDeploymentGuardrail, startDeploymentGuardrail } from "./guardrail.js";
import {
  type DeployEventStatus,
  type DeployHistoryRepository,
  type DeployInstanceResult,
  type DeployTarget,
} from "./history.js";
import { getTenantConfig, type TenantRegistry } from "./tenants.js";

export type ReconcileBackendInput = {
  env: string;
  tenant: string;
  actor: string;
  config: DeployctlConfig;
  registry: TenantRegistry;
  history: DeployHistoryRepository;
  executor: SsmDeployExecutor;
  clock?: () => Date;
  generateEventId?: (startedAt: Date) => string;
};

export type ReconcileBackendResult = {
  status: DeployEventStatus;
  /** The recorded current version the instances were reconciled to. */
  currentVersion: string;
  ssmCommandId: string;
  instances: DeployInstanceResult[];
};

/**
 * Reconcile backend instances to the recorded desired state for `<env>/<tenant>/backend`.
 *
 * Unlike a deploy, reconcile resolves no git ref and records no new version: it reads the
 * current version from `current.json` and re-runs the same `SsmDeployExecutor` deploy for
 * that commit, which prepares the release on any instance missing it (the server script is
 * idempotent — `mkdir -p`, `ln -sfn`). This is the Phase 10 mechanism: a replacement ASG
 * instance that came up with an empty release root is brought to the current version without
 * a new deploy. Guardrail-protected like a deploy, but it never appends a history event or
 * changes the current version, since the desired version is unchanged by definition.
 */
export async function reconcileBackend(input: ReconcileBackendInput): Promise<ReconcileBackendResult> {
  const clock = input.clock ?? (() => new Date());
  const target: DeployTarget = { env: input.env, tenant: input.tenant, app: "backend" };

  const tenant = getTenantConfig(input.registry, input.env, input.tenant);
  const ssmTarget = input.config.ssmTargets[input.env];

  if (ssmTarget === undefined) {
    throw new DeployctlError(`No SSM target selector configured for environment: ${input.env}`);
  }

  const current = await input.history.readCurrentState(target);

  if (current === undefined || current.currentVersion === null) {
    throw new DeployctlError(`Nothing to reconcile for ${target.env}/${target.tenant}/backend: no recorded current version`);
  }

  const currentVersion = current.currentVersion;
  const startedAt = clock();
  const eventId = (input.generateEventId ?? formatReconcileEventId)(startedAt);

  await startDeploymentGuardrail(input.history, target, { eventId, since: startedAt.toISOString(), actor: input.actor });

  try {
    const outcome = await input.executor.runBackendDeploy({
      target,
      resolvedCommit: currentVersion,
      tenant,
      ssmTarget,
      build: input.config.build.backend,
      applicationRepositoryUrl: input.config.applicationRepository.url,
    });

    return {
      status: overallStatus(outcome.instances),
      currentVersion,
      ssmCommandId: outcome.ssmCommandId,
      instances: outcome.instances,
    };
  } catch (error) {
    throw error instanceof DeployctlError
      ? error
      : new DeployctlError(`Backend reconcile failed for ${target.env}/${target.tenant}: ${formatError(error)}`);
  } finally {
    await clearDeploymentGuardrail(input.history, target, eventId);
  }
}

/** Deterministic `rec_YYYYMMDD_HHMMSS` guardrail id for a reconcile run. */
export function formatReconcileEventId(startedAt: Date): string {
  const iso = startedAt.toISOString();
  return `rec_${iso.slice(0, 10).replace(/-/g, "")}_${iso.slice(11, 19).replace(/:/g, "")}`;
}

function overallStatus(instances: DeployInstanceResult[]): DeployEventStatus {
  if (instances.length === 0 || instances.every((instance) => instance.status === "failure")) {
    return "failure";
  }

  if (instances.every((instance) => instance.status === "success")) {
    return "success";
  }

  return "partial_failure";
}
