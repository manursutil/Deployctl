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

type DeployLifecycleBaseInput<WorkResult> = {
  target: DeployTarget;
  actor: string;
  history: DeployHistoryRepository;
  clock?: () => Date;
  generateEventId: (startedAt: Date) => string;
  work: (context: DeployLifecycleContext) => Promise<WorkResult>;
  errorMessage: (error: unknown) => string;
};

export type DeployLifecycleInput<WorkResult, RecordedEvent extends DeployHistoryEvent = DeployHistoryEvent> =
  DeployLifecycleBaseInput<WorkResult> & {
  record?: {
    success: (result: WorkResult, context: DeployLifecycleRecordContext) => RecordedEvent;
    failure: (error: unknown, context: DeployLifecycleRecordContext) => RecordedEvent;
    // Keep explicit so a caller can record an audit event without changing desired/current state.
    updateCurrentStateOnSuccess: boolean;
  };
};

export type RecordingDeployLifecycleInput<WorkResult, RecordedEvent extends DeployHistoryEvent> =
  DeployLifecycleBaseInput<WorkResult> & {
    record: {
      success: (result: WorkResult, context: DeployLifecycleRecordContext) => RecordedEvent;
      failure: (error: unknown, context: DeployLifecycleRecordContext) => RecordedEvent;
      // Keep explicit so a caller can record an audit event without changing desired/current state.
      updateCurrentStateOnSuccess: boolean;
    };
  };

export type DeployLifecycleResult<WorkResult, RecordedEvent extends DeployHistoryEvent = DeployHistoryEvent> = {
  eventId: string;
  startedAt: Date;
  result: WorkResult;
  event?: RecordedEvent;
};

export type RecordingDeployLifecycleResult<WorkResult, RecordedEvent extends DeployHistoryEvent> = {
  eventId: string;
  startedAt: Date;
  result: WorkResult;
  event: RecordedEvent;
};

export async function runDeployLifecycle<WorkResult, RecordedEvent extends DeployHistoryEvent>(
  input: RecordingDeployLifecycleInput<WorkResult, RecordedEvent>,
): Promise<RecordingDeployLifecycleResult<WorkResult, RecordedEvent>>;
export async function runDeployLifecycle<WorkResult>(
  input: DeployLifecycleBaseInput<WorkResult>,
): Promise<DeployLifecycleResult<WorkResult>>;
export async function runDeployLifecycle<WorkResult, RecordedEvent extends DeployHistoryEvent = DeployHistoryEvent>(
  input: DeployLifecycleInput<WorkResult, RecordedEvent>,
): Promise<DeployLifecycleResult<WorkResult, RecordedEvent>> {
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
      return { eventId, startedAt, result, event };
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
