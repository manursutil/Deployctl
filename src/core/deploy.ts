import { DeployctlError, formatError } from "../shared.js";
import type { DeployctlConfig, SsmTargetSelector } from "./config.js";
import {
  formatDeployEventId,
  newDeployEvent,
  type DeployEvent,
  type DeployEventStatus,
  type DeployHistoryRepository,
  type DeployInstanceResult,
  type DeployTarget,
} from "./history.js";
import { runDeployLifecycle } from "./lifecycle.js";
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

  const lifecycle = await runDeployLifecycle({
    target,
    actor: input.actor,
    history: input.history,
    clock,
    generateEventId: input.generateEventId ?? formatDeployEventId,
    work: async () => {
      const outcome = await input.executor.runBackendDeploy({
        target,
        resolvedCommit: resolved.resolvedCommit,
        tenant,
        ssmTarget,
        build: input.config.build.backend,
        applicationRepositoryUrl: input.config.applicationRepository.url,
      });
      return { outcome, status: overallStatus(outcome.instances) };
    },
    record: {
      updateCurrentStateOnSuccess: true,
      success: ({ outcome, status }, context) =>
        newDeployEvent({
          target,
          eventId: context.eventId,
          requestedRef: resolved.requestedRef,
          resolvedCommit: resolved.resolvedCommit,
          actor: input.actor,
          status,
          startedAt: context.startedAt,
          finishedAt: context.finishedAt,
          ssmCommandId: outcome.ssmCommandId,
          instances: outcome.instances,
        }),
      failure: (error, context) =>
        newDeployEvent({
          target,
          eventId: context.eventId,
          requestedRef: resolved.requestedRef,
          resolvedCommit: resolved.resolvedCommit,
          actor: input.actor,
          status: "failure",
          startedAt: context.startedAt,
          finishedAt: context.finishedAt,
          errorMessage: formatError(error),
        }),
    },
    errorMessage: (error) => `Backend deploy failed for ${target.env}/${target.tenant}: ${formatError(error)}`,
  });

  return { status: lifecycle.result.status, event: lifecycle.event };
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
