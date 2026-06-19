#!/usr/bin/env node

const helpText = `deployctl

Usage:
  deployctl tenants list --env <env>
  deployctl status --tenant <tenant> --env <env>
  deployctl deploy backend --tenant <tenant> --env <env> --ref <ref>
  deployctl deploy frontend --tenant <tenant> --env <env> --ref <ref>
  deployctl rollback backend --tenant <tenant> --env <env> --version <commit>
  deployctl rollback frontend --tenant <tenant> --env <env> --version <commit>
  deployctl logs --tenant <tenant> --env <env> --service <api|worker> [--since <duration>]
  deployctl locks list --env <env>
  deployctl locks unlock <env>/<tenant>/<app> --force

Options:
  -h, --help  Show this help message
`;

function main(args: string[]): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(helpText);
    return 0;
  }

  process.stderr.write("deployctl: command not implemented yet\n");
  return 1;
}

process.exitCode = main(process.argv.slice(2));
