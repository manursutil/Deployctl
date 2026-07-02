# Phase 0 Real Cutover Checklist

Checklist of what must change once the real Phase 0 answers are available. Use this after the Docker simulation is accepted, before running `deployctl` against real AWS infrastructure.

The simulation proves the workflow. The real cutover replaces simulated adapters, paths, names, and credentials with confirmed infrastructure facts from `docs/phase-0-checklist.md`.

## Cutover Rule

Do not mark a Phase 0 item complete because it worked in Docker. Mark it complete only when the real answer is recorded in its durable location:

- `deployctl.config.yml`
- `tenants.yml`
- `CONTEXT.md`
- `scripts/ec2/`
- IAM policy docs
- `docs/initial-architecture-proposal.md` when an assumption changes

## Files To Replace Or Promote

| Simulation artifact | Real target |
| --- | --- |
| `deployctl.sim.config.yml` | Confirmed values in `deployctl.config.yml`. |
| `tenants.sim.yml` | Confirmed values in `tenants.yml`. |
| Filesystem history adapter | S3-backed `DeployHistoryRepository`. |
| Filesystem artifact store | S3-backed frontend artifact store. |
| Filesystem frontend bucket sync | S3 sync to tenant frontend buckets. |
| Docker/local SSM executor | AWS SSM Run Command executor. |
| Local secret fixtures | Secrets Manager reads from the EC2 instance role. |
| Local logs adapter or LocalStack | CloudWatch Logs adapter. |
| Docker app-server container | Existing EC2/ASG instances. |
| Fixture app repository | Real Bitbucket application repository. |

## Backend Changes

Replace simulated backend assumptions with real EC2 facts:

- Confirm release root and tenant base paths.
- Confirm env file path, owner, and permissions.
- Confirm OS user that owns releases and runs the deploy script.
- Confirm PM2 API/worker process names and whether there are more than two processes per tenant.
- Confirm the PM2 user, ecosystem file, and restart command.
- Confirm backend install/build commands and Node.js version on EC2.
- Confirm native dependency behavior: build on each EC2 instance or prepare elsewhere.
- Confirm backend health endpoint, success criteria, timeout, and retry policy.

Code/docs to update:

- `scripts/ec2/deploy-backend.sh`
- `tenants.yml`
- `deployctl.config.yml`
- `CONTEXT.md`

## SSM And ASG Changes

Replace Docker command execution with AWS SSM:

- Implement `src/adapters/ssm.ts`.
- Use the confirmed SSM document: `AWS-RunShellScript` or a custom document.
- Replace simulated targets with real staging instance IDs, tag selectors, or production ASG name.
- Resolve production ASG targets to healthy instances at deploy time.
- Record SSM command IDs and per-instance results in deploy events/status if useful.

Code/docs to update:

- `src/adapters/ssm.ts`
- `deployctl.config.yml`
- `CONTEXT.md`
- IAM policy docs

## Secrets Changes

Replace local secret fixtures with Secrets Manager:

- Confirm secret names per env/tenant.
- Confirm which values map into the tenant env file.
- Ensure `deployctl` passes only secret names.
- Ensure the EC2 instance role, not operator credentials, reads secret values.
- Verify secrets do not appear in CLI output, deploy history, SSM command text, or pipeline logs.

Code/docs to update:

- `tenants.yml`
- `scripts/ec2/deploy-backend.sh`
- IAM policy docs
- `CONTEXT.md`

## Frontend Changes

Replace filesystem artifacts and buckets with S3:

- Implement S3 artifact store and tenant bucket sync.
- Confirm artifact bucket/prefix.
- Confirm tenant frontend buckets.
- Confirm build output directory.
- Confirm frontend package manager, install command, and build command.
- Confirm exact build-time variable names.
- Confirm build-variable value source per tenant/env.
- Confirm cache-control policy for immutable assets and `index.html`.
- Confirm frontend smoke-check URL and success criteria.

Code/docs to update:

- `src/adapters/s3.ts`
- `deployctl.config.yml`
- `tenants.yml`
- `CONTEXT.md`

## History And Guardrail Changes

Replace filesystem history with S3:

- Implement S3-backed `DeployHistoryRepository`.
- Confirm bucket/prefix and key layout.
- Confirm current-state conditional write/versioning strategy for the `inProgress` guardrail.
- Keep append-only event writes and mutable `current.json` separate.
- Run concurrency tests against mocked S3 behavior and, if possible, a non-production bucket.

Code/docs to update:

- S3 history adapter file
- `deployctl.config.yml`
- `CONTEXT.md`
- IAM policy docs

## Logs Changes

Replace local log reads with CloudWatch Logs:

- Implement CloudWatch Logs adapter.
- Confirm log group names.
- Confirm stream naming.
- Confirm whether tenant/service filtering comes from stream names, JSON fields, or message patterns.
- Confirm retention and any formatting/subscription behavior that affects queries.

Code/docs to update:

- `src/adapters/cloudwatch.ts`
- `deployctl.config.yml`
- `CONTEXT.md`
- IAM policy docs

## Repository Access Changes

Replace fixture Git repository with the real application repo:

- Confirm Bitbucket repository URL.
- Confirm authentication method for `git ls-remote`.
- Confirm authentication method for fetching source to build.
- Confirm staging and production ref policies.
- Verify production rejects moving branch refs.

Code/docs to update:

- `deployctl.config.yml`
- `CONTEXT.md`
- Bitbucket pipeline docs/config when added

## IAM Changes

Replace simulated permission notes with least-privilege policies:

- Hop A: `deployctl` can run SSM commands on target instances/ASGs.
- Hop A: `deployctl` can read/write deploy history and artifacts.
- Hop A: `deployctl` can sync to tenant frontend buckets.
- Hop A: `deployctl` can read relevant CloudWatch Logs.
- Hop B: EC2 can read only required tenant secrets.
- Confirm credential source for Bitbucket Pipelines and operator machines.

Docs to update:

- IAM policy docs
- `CONTEXT.md`
- `docs/phase-0-checklist.md`

## ASG Reconciliation Changes

After real ASG bootstrap behavior is known:

- If replacement instances self-restore from current state, document the mechanism and required permissions.
- If they do not self-restore, implement or document `deployctl reconcile backend --env production`.
- Verify a replacement instance can be brought to the desired backend version without manual SSH.

Code/docs to update:

- Phase 10 in `docs/implementation-plan.md`
- `CONTEXT.md`
- `docs/initial-architecture-proposal.md` if the architecture assumption changes

## Final Verification Before Real Deploy

Run these checks before the first non-demo AWS deploy:

- `npm test`
- `npm run typecheck`
- Config validation against real `deployctl.config.yml`
- Tenant validation against real `tenants.yml`
- Dry-run or non-mutating AWS identity/permission checks where available
- Staging backend deploy
- Staging frontend deploy
- Staging status
- Staging logs
- Staging rollback for backend and frontend

Do not run production deploys until staging has exercised the same adapter path with real AWS resources.
