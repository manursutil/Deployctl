import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { DeployctlError } from "../shared.js";

export type DeployctlConfig = {
  aws: {
    region: string;
  };
  applicationRepository: {
    url: string;
  };
  build: {
    backend: BuildConfig;
    frontend: BuildConfig & {
      buildConfigIdentityInputs: string[];
    };
  };
  deployHistory: StorageLocation;
  frontendArtifacts: StorageLocation;
  refPolicies: Record<string, RefPolicy>;
  retention: {
    successfulVersionsPerTarget: number;
    keepDays: number;
  };
};

type BuildConfig = {
  packageManager: string;
  installCommand: string;
  buildCommand: string;
};

type StorageLocation = {
  bucket: string;
  prefix: string;
};

type RefPolicy = {
  allowMovingBranches: boolean;
};

export async function loadDeployctlConfig(path = "deployctl.config.yml"): Promise<DeployctlConfig> {
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployctlError(`Could not read deployctl config at ${path}: ${message}`);
  }

  let parsed: unknown;

  try {
    parsed = parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployctlError(`Invalid YAML in deployctl config at ${path}: ${message}`);
  }

  return parseDeployctlConfig(parsed, path);
}

export function parseDeployctlConfig(value: unknown, sourceName = "deployctl.config.yml"): DeployctlConfig {
  const root = objectAt(value, sourceName);
  const aws = objectAt(root.aws, `${sourceName}.aws`);
  const applicationRepository = objectAt(root.applicationRepository, `${sourceName}.applicationRepository`);
  const build = objectAt(root.build, `${sourceName}.build`);
  const frontend = objectAt(build.frontend, `${sourceName}.build.frontend`);
  const retention = objectAt(root.retention, `${sourceName}.retention`);

  return {
    aws: {
      region: nonEmptyString(aws, `${sourceName}.aws.region`, "region"),
    },
    applicationRepository: {
      url: nonEmptyString(applicationRepository, `${sourceName}.applicationRepository.url`, "url"),
    },
    build: {
      backend: buildConfig(build.backend, `${sourceName}.build.backend`),
      frontend: {
        ...buildConfig(frontend, `${sourceName}.build.frontend`),
        buildConfigIdentityInputs: stringArray(frontend.buildConfigIdentityInputs, `${sourceName}.build.frontend.buildConfigIdentityInputs`),
      },
    },
    deployHistory: storageLocation(root.deployHistory, `${sourceName}.deployHistory`),
    frontendArtifacts: storageLocation(root.frontendArtifacts, `${sourceName}.frontendArtifacts`),
    refPolicies: refPolicies(root.refPolicies, `${sourceName}.refPolicies`),
    retention: {
      successfulVersionsPerTarget: positiveInteger(
        retention.successfulVersionsPerTarget,
        `${sourceName}.retention.successfulVersionsPerTarget`,
      ),
      keepDays: positiveInteger(retention.keepDays, `${sourceName}.retention.keepDays`),
    },
  };
}

function buildConfig(value: unknown, path: string): BuildConfig {
  const config = objectAt(value, path);

  return {
    packageManager: nonEmptyString(config, `${path}.packageManager`, "packageManager"),
    installCommand: nonEmptyString(config, `${path}.installCommand`, "installCommand"),
    buildCommand: nonEmptyString(config, `${path}.buildCommand`, "buildCommand"),
  };
}

function storageLocation(value: unknown, path: string): StorageLocation {
  const object = objectAt(value, path);

  return {
    bucket: nonEmptyString(object, `${path}.bucket`, "bucket"),
    prefix: nonEmptyString(object, `${path}.prefix`, "prefix"),
  };
}

function refPolicies(value: unknown, path: string): Record<string, RefPolicy> {
  const object = objectAt(value, path);
  const policies: Record<string, RefPolicy> = {};

  for (const [environment, policy] of Object.entries(object)) {
    policies[environment] = {
      allowMovingBranches: booleanAt(objectAt(policy, `${path}.${environment}`).allowMovingBranches, `${path}.${environment}.allowMovingBranches`),
    };
  }

  if (Object.keys(policies).length === 0) {
    throw new DeployctlError(`${path} must define at least one environment policy`);
  }

  return policies;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DeployctlError(`${path} must be a non-empty string array`);
  }

  return value.map((item, index) => stringAt(item, `${path}[${index}]`));
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new DeployctlError(`${path} must be a positive integer`);
  }

  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new DeployctlError(`${path} must be a boolean`);
  }

  return value;
}

function nonEmptyString(object: Record<string, unknown>, path: string, key: string): string {
  return stringAt(object[key], path);
}

function stringAt(value: unknown, path: string): string {
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
