#!/usr/bin/env node
import { loadDeployctlConfig } from "./core/config.js";
import { DeployctlError, formatError, type Io } from "./shared.js";

const usage = `deployctl

Usage:
  deployctl --help
  deployctl config check [--config <path>]
  deployctl tenants list --env <env>
  deployctl status --tenant <tenant> --env <env>
  deployctl deploy backend|frontend --tenant <tenant> --env <env> --ref <ref>
  deployctl rollback backend|frontend --tenant <tenant> --env <env> --version <version>
  deployctl logs --tenant <tenant> --env <env> --service <api|worker> --since <duration>

Options:
  --config <path>  Path to deployctl.config.yml
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

    throw new DeployctlError(`Command not implemented yet: ${args.join(" ")}`);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return error instanceof DeployctlError ? error.exitCode : 1;
  }
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
