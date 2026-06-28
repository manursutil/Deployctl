import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { DeployctlError } from "../shared.js";

export type TenantRegistry = Record<string, Record<string, TenantConfig>>;

export type TenantConfig = {
  frontendBucket: string;
  dbSecret: string;
  redisSecret: string;
  apiProcess: string;
  workerProcess: string;
  appBaseDir: string;
  backendHealthUrl: string;
  frontendUrl: string;
};

const requiredTenantFields = [
  "frontendBucket",
  "dbSecret",
  "redisSecret",
  "apiProcess",
  "workerProcess",
  "appBaseDir",
  "backendHealthUrl",
  "frontendUrl",
] as const;

const secretValuePatterns = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\b(password|token|secret|private[_-]?key)\s*[:=]/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
];

export async function loadTenantRegistry(path = "tenants.yml"): Promise<TenantRegistry> {
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployctlError(`Could not read tenants config at ${path}: ${message}`);
  }

  try {
    return parseTenantRegistry(parse(source), path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployctlError(`Invalid YAML in tenants config at ${path}: ${message}`);
  }
}

export function parseTenantRegistry(value: unknown, sourceName = "tenants.yml"): TenantRegistry {
  const root = objectAt(value, sourceName);
  const registry: TenantRegistry = {};

  for (const [environment, tenants] of Object.entries(root)) {
    if (!isConfigKey(environment)) {
      throw new DeployctlError(`${sourceName}.${environment} must use a lowercase environment key`);
    }

    const tenantMap = objectAt(tenants, `${sourceName}.${environment}`);
    const parsedTenants: Record<string, TenantConfig> = {};

    for (const [tenant, config] of Object.entries(tenantMap)) {
      if (!isConfigKey(tenant)) {
        throw new DeployctlError(`${sourceName}.${environment}.${tenant} must use a lowercase tenant key`);
      }

      parsedTenants[tenant] = tenantConfig(config, `${sourceName}.${environment}.${tenant}`);
    }

    if (Object.keys(parsedTenants).length === 0) {
      throw new DeployctlError(`${sourceName}.${environment} must define at least one tenant`);
    }

    registry[environment] = parsedTenants;
  }

  if (Object.keys(registry).length === 0) {
    throw new DeployctlError(`${sourceName} must define at least one environment`);
  }

  return registry;
}

export function listTenants(registry: TenantRegistry, environment: string): string[] {
  const tenants = registry[environment];

  if (tenants === undefined) {
    throw new DeployctlError(`Environment not found in tenants config: ${environment}`);
  }

  return Object.keys(tenants).sort();
}

function tenantConfig(value: unknown, path: string): TenantConfig {
  const object = objectAt(value, path);
  const config = {} as Record<(typeof requiredTenantFields)[number], string>;

  for (const field of requiredTenantFields) {
    config[field] = safeTenantString(object[field], `${path}.${field}`);
  }

  return config;
}

function safeTenantString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DeployctlError(`${path} must be a non-empty string`);
  }

  for (const pattern of secretValuePatterns) {
    if (pattern.test(value)) {
      throw new DeployctlError(`${path} looks like a secret value; store only resource references in tenants.yml`);
    }
  }

  return value;
}

function isConfigKey(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeployctlError(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}
