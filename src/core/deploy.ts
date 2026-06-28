import { DeployctlError, formatError } from "../shared.js";
import type { DeployctlConfig, SsmTargetSelector } from "./config.js";
import {
  applySuccessfulEventToCurrentState,
  type DeployEvent,
  type DeployEventStatus,
  type DeployHistoryRepository,
  type DeployInstanceResult,
  type DeployTarget,
} from "./history.js";
import { clearDeploymentGuardrail, startDeploymentGuardrail } from "./guardrail.js";
import { resolveDeploymentRef, type RefResolver } from "./refs.js";
import { getTenantConfig, type TenantConfig, type TenantRegistry } from "./tenants.js";

/**
 * Request handed to the SSM executor seam. It carries only resolved facts and
 * resource references — never a secret value. The executor reads secret values
 * on EC2 (Hop B) from the secret names in `tenant`.
 */
export type SsmBackendDeployRequest = {
  target: DeployTarget;
  resolvedCommit: string;
  tenant: TenantConfig;
  ssmTarget: SsmTargetSelector;
  build: DeployctlConfig["build"]["backend"];
  applicationRepositoryUrl: string;
};

export type SsmBackendDeployOutcome = {
  ssmCommandId: string;
  instances: DeployInstanceResult[];
};

/**
 * The seam over AWS SSM Run Command. The real adapter (Phase 6 server work)
 * runs `scripts/ec2/` on the selected instances; tests pass a fake.
 */
export type SsmDeployExecutor = {
  runBackendDeploy(request: SsmBackendDeployRequest): Promise<SsmBackendDeployOutcome>;
};

export type DeployBackendInput = {
  env: string;
  tenant: string;
  requestedRef: string;
  actor: string;
  config: DeployctlConfig;
  registry: TenantRegistry;
  refResolver: RefResolver;
  history: DeployHistoryRepository;
  executor: SsmDeployExecutor;
  clock?: () => Date;
  generateEventId?: (startedAt: Date) => string;
};

export type DeployBackendResult = {
  status: DeployEventStatus;
  event: DeployEvent;
};

/**
 * Orchestrate one backend deploy for `<env>/<tenant>/backend`: validate the
 * tenant, resolve the ref to an immutable commit, take the `inProgress`
 * guardrail, run the deploy through the SSM executor seam, then record an
 * append-only event and update current state. The guardrail is always cleared,
 * so a failure leaves no in-progress state behind.
 */
export async function deployBackend(input: DeployBackendInput): Promise<DeployBackendResult> {
  const clock = input.clock ?? (() => new Date());
  const target: DeployTarget = { env: input.env, tenant: input.tenant, app: "backend" };

  const tenant = getTenantConfig(input.registry, input.env, input.tenant);
  const ssmTarget = input.config.ssmTargets[input.env];

  if (ssmTarget === undefined) {
    throw new DeployctlError(`No SSM target selector configured for environment: ${input.env}`);
  }

  const resolved = await resolveDeploymentRef({
    environment: input.env,
    requestedRef: input.requestedRef,
    applicationRepositoryUrl: input.config.applicationRepository.url,
    refPolicies: input.config.refPolicies,
    resolver: input.refResolver,
  });

  const startedAt = clock();
  const eventId = (input.generateEventId ?? defaultEventId)(startedAt);

  await startDeploymentGuardrail(input.history, target, {
    eventId,
    since: startedAt.toISOString(),
    actor: input.actor,
  });

  try {
    let outcome: SsmBackendDeployOutcome;

    try {
      outcome = await input.executor.runBackendDeploy({
        target,
        resolvedCommit: resolved.resolvedCommit,
        tenant,
        ssmTarget,
        build: input.config.build.backend,
        applicationRepositoryUrl: input.config.applicationRepository.url,
      });
    } catch (error) {
      const event = buildEvent(target, resolved.requestedRef, resolved.resolvedCommit, input.actor, eventId, startedAt, clock(), {
        status: "failure",
        errorMessage: formatError(error),
      });
      await input.history.appendEvent(event);
      throw error instanceof DeployctlError
        ? error
        : new DeployctlError(`Backend deploy failed for ${target.env}/${target.tenant}: ${formatError(error)}`);
    }

    const status = overallStatus(outcome.instances);
    const event = buildEvent(target, resolved.requestedRef, resolved.resolvedCommit, input.actor, eventId, startedAt, clock(), {
      status,
      ssmCommandId: outcome.ssmCommandId,
      instances: outcome.instances,
    });

    await input.history.appendEvent(event);

    if (status === "success") {
      await input.history.updateCurrentState(applySuccessfulEventToCurrentState(event));
    }

    return { status, event };
  } finally {
    await clearDeploymentGuardrail(input.history, target, eventId);
  }
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

function buildEvent(
  target: DeployTarget,
  requestedRef: string,
  resolvedCommit: string,
  actor: string,
  eventId: string,
  startedAt: Date,
  finishedAt: Date,
  extra: { status: DeployEventStatus; ssmCommandId?: string; instances?: DeployInstanceResult[]; errorMessage?: string },
): DeployEvent {
  const event: DeployEvent = {
    ...target,
    eventId,
    type: "deploy",
    requestedRef,
    resolvedCommit,
    status: extra.status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    actor,
  };

  if (extra.ssmCommandId !== undefined) {
    event.ssmCommandId = extra.ssmCommandId;
  }
  if (extra.instances !== undefined) {
    event.instances = extra.instances;
  }
  if (extra.errorMessage !== undefined) {
    event.errorMessage = extra.errorMessage;
  }

  return event;
}

function defaultEventId(startedAt: Date): string {
  const iso = startedAt.toISOString();
  return `dep_${iso.slice(0, 10).replace(/-/g, "")}_${iso.slice(11, 19).replace(/:/g, "")}`;
}
