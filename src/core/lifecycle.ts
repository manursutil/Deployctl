import { DeployctlError } from "../shared.js";
import { clearDeploymentGuardrail, startDeploymentGuardrail } from "./guardrail.js";
import {
  applySuccessfulEventToCurrentState,
  type DeployHistoryEvent,
  type DeployHistoryRepository,
  type DeployTarget,
} from "./history.js";

type DeployLifecycleContext = {
  eventId: string;
  startedAt: Date;
};

type DeployLifecycleRecordContext = DeployLifecycleContext & {
  finishedAt: Date;
};

export type DeployLifecycleInput<WorkResult> = {
  target: DeployTarget;
  actor: string;
  history: DeployHistoryRepository;
  clock?: () => Date;
  generateEventId: (startedAt: Date) => string;
  work: (context: DeployLifecycleContext) => Promise<WorkResult>;
  record?: {
    success: (result: WorkResult, context: DeployLifecycleRecordContext) => DeployHistoryEvent;
    failure: (error: unknown, context: DeployLifecycleRecordContext) => DeployHistoryEvent;
    updateCurrentStateOnSuccess: boolean;
  };
  errorMessage: (error: unknown) => string;
};

export type DeployLifecycleResult<WorkResult> = {
  eventId: string;
  startedAt: Date;
  result: WorkResult;
};

export async function runDeployLifecycle<WorkResult>(
  input: DeployLifecycleInput<WorkResult>,
): Promise<DeployLifecycleResult<WorkResult>> {
  const clock = input.clock ?? (() => new Date());
  const startedAt = clock();
  const eventId = input.generateEventId(startedAt);

  await startDeploymentGuardrail(input.history, input.target, {
    eventId,
    since: startedAt.toISOString(),
    actor: input.actor,
  });

  try {
    const context = { eventId, startedAt };
    const result = await input.work(context);

    if (input.record !== undefined) {
      const event = input.record.success(result, { ...context, finishedAt: clock() });
      await input.history.appendEvent(event);

      if (input.record.updateCurrentStateOnSuccess && event.status === "success") {
        await input.history.updateCurrentState(applySuccessfulEventToCurrentState(event));
      }
    }

    return { eventId, startedAt, result };
  } catch (error) {
    if (input.record !== undefined) {
      await input.history.appendEvent(
        input.record.failure(error, {
          eventId,
          startedAt,
          finishedAt: clock(),
        }),
      );
    }

    throw error instanceof DeployctlError ? error : new DeployctlError(input.errorMessage(error));
  } finally {
    await clearDeploymentGuardrail(input.history, input.target, eventId);
  }
}
