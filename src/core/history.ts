import { DeployctlError } from "../shared.js";

export type DeployableApp = "backend" | "frontend";
export type DeployEventStatus = "success" | "failure" | "partial_failure";
export type RollbackEventStatus = "success" | "failure" | "partial_failure";

export type DeployTarget = {
  env: string;
  tenant: string;
  app: DeployableApp;
};

export type DeployEvent = DeployTarget & {
  eventId: string;
  type: "deploy";
  requestedRef: string;
  resolvedCommit: string;
  status: DeployEventStatus;
  startedAt: string;
  finishedAt: string;
  actor: string;
  ssmCommandId?: string;
  instances?: DeployInstanceResult[];
  errorMessage?: string;
};

export type RollbackEvent = DeployTarget & {
  eventId: string;
  type: "rollback";
  targetVersion: string;
  previousVersion: string;
  status: RollbackEventStatus;
  startedAt: string;
  finishedAt: string;
  actor: string;
  ssmCommandId?: string;
  instances?: DeployInstanceResult[];
  errorMessage?: string;
};

export type DeployHistoryEvent = DeployEvent | RollbackEvent;

export type DeployInstanceResult = {
  instanceId: string;
  status: DeployEventStatus;
  version?: string;
  errorMessage?: string;
};

export type CurrentState = DeployTarget & {
  currentVersion: string;
  lastSuccessfulEventId: string;
  updatedAt: string;
  inProgress?: InProgressState;
};

export type InProgressState = {
  eventId: string;
  since: string;
  actor: string;
};

export type DeployHistoryRepository = {
  appendEvent(event: DeployHistoryEvent): Promise<void>;
  listEvents(target: DeployTarget): Promise<DeployHistoryEvent[]>;
  readCurrentState(target: DeployTarget): Promise<CurrentState | undefined>;
  updateCurrentState(state: CurrentState): Promise<void>;
};

const fullCommitShaPattern = /^[0-9a-f]{40}$/i;
const configKeyPattern = /^[a-z][a-z0-9-]*$/;

export function validateDeployEvent(value: unknown): DeployEvent {
  const object = eventBase(value, "deploy event");
  literal(object.type, "deploy event.type", "deploy");

  const event: DeployEvent = {
    ...targetFrom(object, "deploy event"),
    eventId: nonEmptyString(object.eventId, "deploy event.eventId"),
    type: "deploy",
    requestedRef: nonEmptyString(object.requestedRef, "deploy event.requestedRef"),
    resolvedCommit: commitSha(object.resolvedCommit, "deploy event.resolvedCommit"),
    status: deployStatus(object.status, "deploy event.status"),
    startedAt: isoTimestamp(object.startedAt, "deploy event.startedAt"),
    finishedAt: isoTimestamp(object.finishedAt, "deploy event.finishedAt"),
    actor: nonEmptyString(object.actor, "deploy event.actor"),
  };

  optionalString(object.ssmCommandId, "deploy event.ssmCommandId", (value) => {
    event.ssmCommandId = value;
  });
  optionalString(object.errorMessage, "deploy event.errorMessage", (value) => {
    event.errorMessage = value;
  });
  optionalInstances(object.instances, "deploy event.instances", (instances) => {
    event.instances = instances;
  });

  return event;
}

export function validateRollbackEvent(value: unknown): RollbackEvent {
  const object = eventBase(value, "rollback event");
  literal(object.type, "rollback event.type", "rollback");

  const event: RollbackEvent = {
    ...targetFrom(object, "rollback event"),
    eventId: nonEmptyString(object.eventId, "rollback event.eventId"),
    type: "rollback",
    targetVersion: commitSha(object.targetVersion, "rollback event.targetVersion"),
    previousVersion: commitSha(object.previousVersion, "rollback event.previousVersion"),
    status: rollbackStatus(object.status, "rollback event.status"),
    startedAt: isoTimestamp(object.startedAt, "rollback event.startedAt"),
    finishedAt: isoTimestamp(object.finishedAt, "rollback event.finishedAt"),
    actor: nonEmptyString(object.actor, "rollback event.actor"),
  };

  optionalString(object.ssmCommandId, "rollback event.ssmCommandId", (value) => {
    event.ssmCommandId = value;
  });
  optionalString(object.errorMessage, "rollback event.errorMessage", (value) => {
    event.errorMessage = value;
  });
  optionalInstances(object.instances, "rollback event.instances", (instances) => {
    event.instances = instances;
  });

  return event;
}

export function validateHistoryEvent(value: unknown): DeployHistoryEvent {
  const object = objectAt(value, "history event");

  if (object.type === "deploy") {
    return validateDeployEvent(value);
  }

  if (object.type === "rollback") {
    return validateRollbackEvent(value);
  }

  throw new DeployctlError("history event.type must be deploy or rollback");
}

export function validateCurrentState(value: unknown): CurrentState {
  const object = objectAt(value, "current state");
  const state: CurrentState = {
    ...targetFrom(object, "current state"),
    currentVersion: commitSha(object.currentVersion, "current state.currentVersion"),
    lastSuccessfulEventId: nonEmptyString(object.lastSuccessfulEventId, "current state.lastSuccessfulEventId"),
    updatedAt: isoTimestamp(object.updatedAt, "current state.updatedAt"),
  };

  if (object.inProgress !== undefined) {
    state.inProgress = inProgressState(object.inProgress, "current state.inProgress");
  }

  return state;
}

export function applySuccessfulEventToCurrentState(event: DeployHistoryEvent, options: { inProgress?: InProgressState } = {}): CurrentState {
  if (event.status !== "success") {
    throw new DeployctlError(`Cannot update current state from unsuccessful event: ${event.eventId}`);
  }

  return validateCurrentState({
    env: event.env,
    tenant: event.tenant,
    app: event.app,
    currentVersion: event.type === "deploy" ? event.resolvedCommit : event.targetVersion,
    lastSuccessfulEventId: event.eventId,
    updatedAt: event.finishedAt,
    inProgress: options.inProgress,
  });
}

export async function previousSuccessfulVersion(repository: DeployHistoryRepository, target: DeployTarget): Promise<string | undefined> {
  const current = await repository.readCurrentState(target);
  const events = await repository.listEvents(target);
  const successfulVersions = events
    .filter((event) => event.status === "success")
    .map((event) => ({
      eventId: event.eventId,
      version: event.type === "deploy" ? event.resolvedCommit : event.targetVersion,
    }))
    .filter((event) => event.eventId !== current?.lastSuccessfulEventId);

  return successfulVersions.at(-1)?.version;
}

export class InMemoryDeployHistoryRepository implements DeployHistoryRepository {
  private readonly events = new Map<string, DeployHistoryEvent[]>();
  private readonly currentStates = new Map<string, CurrentState>();

  async appendEvent(event: DeployHistoryEvent): Promise<void> {
    const validated = validateHistoryEvent(event);
    const key = targetKey(validated);
    const events = this.events.get(key) ?? [];

    if (events.some((storedEvent) => storedEvent.eventId === validated.eventId)) {
      throw new DeployctlError(`History event already exists for ${key}: ${validated.eventId}`);
    }

    this.events.set(key, [...events, validated]);
  }

  async listEvents(target: DeployTarget): Promise<DeployHistoryEvent[]> {
    return [...(this.events.get(targetKey(target)) ?? [])];
  }

  async readCurrentState(target: DeployTarget): Promise<CurrentState | undefined> {
    const state = this.currentStates.get(targetKey(target));
    return state === undefined ? undefined : { ...state };
  }

  async updateCurrentState(state: CurrentState): Promise<void> {
    const validated = validateCurrentState(state);
    this.currentStates.set(targetKey(validated), validated);
  }
}

function targetKey(target: DeployTarget): string {
  return `${target.env}/${target.tenant}/${target.app}`;
}

function eventBase(value: unknown, path: string): Record<string, unknown> {
  const object = objectAt(value, path);
  targetFrom(object, path);
  return object;
}

function targetFrom(object: Record<string, unknown>, path: string): DeployTarget {
  return {
    env: configKey(object.env, `${path}.env`),
    tenant: configKey(object.tenant, `${path}.tenant`),
    app: deployableApp(object.app, `${path}.app`),
  };
}

function inProgressState(value: unknown, path: string): InProgressState {
  const object = objectAt(value, path);
  return {
    eventId: nonEmptyString(object.eventId, `${path}.eventId`),
    since: isoTimestamp(object.since, `${path}.since`),
    actor: nonEmptyString(object.actor, `${path}.actor`),
  };
}

function optionalInstances(value: unknown, path: string, assign: (value: DeployInstanceResult[]) => void): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new DeployctlError(`${path} must be an array`);
  }

  assign(value.map((item, index) => deployInstanceResult(item, `${path}[${index}]`)));
}

function deployInstanceResult(value: unknown, path: string): DeployInstanceResult {
  const object = objectAt(value, path);
  const result: DeployInstanceResult = {
    instanceId: nonEmptyString(object.instanceId, `${path}.instanceId`),
    status: deployStatus(object.status, `${path}.status`),
  };

  optionalString(object.version, `${path}.version`, (value) => {
    result.version = commitSha(value, `${path}.version`);
  });
  optionalString(object.errorMessage, `${path}.errorMessage`, (value) => {
    result.errorMessage = value;
  });

  return result;
}

function optionalString(value: unknown, path: string, assign: (value: string) => void): void {
  if (value === undefined) {
    return;
  }

  assign(nonEmptyString(value, path));
}

function literal<T extends string>(value: unknown, path: string, expected: T): T {
  if (value !== expected) {
    throw new DeployctlError(`${path} must be ${expected}`);
  }

  return expected;
}

function deployableApp(value: unknown, path: string): DeployableApp {
  if (value !== "backend" && value !== "frontend") {
    throw new DeployctlError(`${path} must be backend or frontend`);
  }

  return value;
}

function deployStatus(value: unknown, path: string): DeployEventStatus {
  if (value !== "success" && value !== "failure" && value !== "partial_failure") {
    throw new DeployctlError(`${path} must be success, failure, or partial_failure`);
  }

  return value;
}

function rollbackStatus(value: unknown, path: string): RollbackEventStatus {
  return deployStatus(value, path);
}

function commitSha(value: unknown, path: string): string {
  const string = nonEmptyString(value, path);

  if (!fullCommitShaPattern.test(string)) {
    throw new DeployctlError(`${path} must be a full commit SHA`);
  }

  return string.toLowerCase();
}

function configKey(value: unknown, path: string): string {
  const string = nonEmptyString(value, path);

  if (!configKeyPattern.test(string)) {
    throw new DeployctlError(`${path} must be a lowercase config key`);
  }

  return string;
}

function isoTimestamp(value: unknown, path: string): string {
  const string = nonEmptyString(value, path);
  const timestamp = Date.parse(string);

  if (Number.isNaN(timestamp) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(string)) {
    throw new DeployctlError(`${path} must be an ISO timestamp`);
  }

  return string;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DeployctlError(`${path} must be a non-empty string`);
  }

  return value;
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeployctlError(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}
