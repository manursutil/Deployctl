# Review Questions and Answers

This document lists likely questions a manager or technical reviewer may ask after reading the multi-tenant deployment architecture proposal. The answers are based on `docs/initial-architecture-proposal.md`.

## 1. Why use a separate deployment automation repository?

The deployment automation has a different responsibility from the application monorepo.

The application repository owns product code, backend code, frontend code, and application tests. The deployment repository owns tenant mappings, deployment permissions, deploy scripts, rollback logic, status commands, and operator documentation.

Keeping these separate makes access control cleaner, avoids exposing deployment configuration to every application contributor, and makes compliance review easier.

Answered by: `initial-architecture-proposal.md`, section 5.

## 2. Why is version 1 CLI-only instead of including a dashboard?

A dashboard would add a new production-facing control surface that can trigger deploys. That means authentication, authorization, network exposure, audit logging, and security review.

For version 1, the CLI gives the required deployment capability with less security and operational complexity. A dashboard can be added later on top of the same deploy logic after the CLI workflow is proven.

Answered by: `initial-architecture-proposal.md`, section 6.

## 3. Why build `deployctl` in TypeScript instead of shell scripts?

The tool needs to validate tenant configuration, parse command arguments, resolve Git refs, call AWS APIs, record deploy history, and present clear errors. TypeScript is better suited for this orchestration logic than shell.

Shell is still useful for small server-local scripts invoked through SSM, but the main validation and AWS orchestration should live in TypeScript.

Answered by: `initial-architecture-proposal.md`, section 7.

## 4. How do we make deployments reproducible?

Every deploy resolves the requested branch, tag, or commit to a full commit SHA before any deployment work begins.

Branches are moving pointers, so the CLI may accept a branch for staging convenience, but the actual deploy uses the resolved commit SHA. Production should require a tag or commit SHA.

Deploy history stores both the requested ref and the resolved commit.

Answered by: `initial-architecture-proposal.md`, section 9.

## 5. How can different tenants run different backend versions on shared EC2 instances?

Backend releases are stored in immutable release directories by commit SHA.

Example:

```text
/opt/sherwood/releases/abc123
/opt/sherwood/releases/def456
```

Each tenant points to the selected release through a `current` symlink.

Example:

```text
/opt/sherwood/tenants/client1/current -> /opt/sherwood/releases/abc123
/opt/sherwood/tenants/client2/current -> /opt/sherwood/releases/def456
```

This allows tenant-specific backend versions without duplicating the repository per tenant.

Answered by: `initial-architecture-proposal.md`, section 10.

## 6. Are we duplicating the whole repository for every tenant?

No.

The backend release directory is created once per commit. If five tenants run the same commit, they can all point to the same release directory.

The system duplicates releases by version, not by tenant.

Answered by: `initial-architecture-proposal.md`, section 10.

## 7. How does production deployment work across multiple ASG instances?

Production backend deploys run through AWS SSM across all healthy instances in the production ASG.

The deploy is considered successful only if every targeted instance succeeds. This avoids a situation where different users hit different backend versions depending on which load-balanced EC2 instance receives the request.

Answered by: `initial-architecture-proposal.md`, section 13.

## 8. What happens if a production deploy partially succeeds?

Version 1 should not automatically roll back.

Instead, `deployctl` should:

- mark the deploy as failed
- record which instances succeeded
- record which instances failed
- show the previous version
- show the explicit rollback command

Manual rollback is safer for version 1 because automatic rollback can hide the original failure or create another failure during an already unstable operation.

Answered by: `initial-architecture-proposal.md`, section 15.

## 9. What happens when the ASG replaces an instance?

This is a key assumption that must be verified before implementation.

When a new production ASG instance starts, it needs to know which backend version each tenant should run, which releases must exist, which PM2 processes should be active, and which secrets/configuration apply.

If the existing bootstrap process already restores tenant backend state, that behavior should be documented. If it does not, version 1 should include a minimal `deployctl reconcile backend --env production` command or a documented recovery procedure.

Partially answered by: `initial-architecture-proposal.md`, section 14.

Open item: confirm the current ASG bootstrap behavior.

## 10. How are tenant secrets handled?

`deployctl` passes secret references, not secret values.

The EC2 instance reads the actual secrets from AWS Secrets Manager using its instance role. The remote deploy script writes a protected per-tenant environment file and restarts the tenant's PM2 processes with that environment.

Secrets should not appear in Git, deploy history, Bitbucket logs, or terminal output.

Answered by: `initial-architecture-proposal.md`, section 17.

## 11. How are frontend builds shared across tenants?

Frontend builds are stored as reusable artifacts by commit SHA.

If two tenants run the same frontend commit, they should usually use the same static build artifact. Tenant-specific differences should preferably live in runtime config, such as `config.json`, rather than being baked into the JavaScript bundle.

Answered by: `initial-architecture-proposal.md`, section 18.

## 12. How do we avoid stale frontend files through Cloudflare or browser cache?

Frontend deploys must set cache headers deliberately.

The recommended baseline is:

- hashed JS, CSS, and assets use long-lived caching
- `index.html` uses no-cache or short-cache headers
- tenant runtime config, such as `config.json`, uses no-cache or short-cache headers
- old hashed assets are not deleted immediately during deploy
- Cloudflare purge for `index.html` and config is recommended if API access is available

Answered by: `initial-architecture-proposal.md`, section 20.

## 13. How does rollback work?

Backend rollback repoints the tenant's `current` symlink to an older release directory, restarts only that tenant's PM2 processes, runs a health check, and records the rollback.

Frontend rollback syncs an older stored frontend artifact back to the tenant's S3 bucket, restores tenant config if needed, runs a smoke check, and records the rollback.

Rollback depends on deploy history and retention rules, so old releases and artifacts must not be cleaned up too aggressively.

Answered by: `initial-architecture-proposal.md`, section 21.

## 14. How do we prevent two deploys from changing the same target at the same time?

Version 1 should use deployment locks keyed by:

```text
<env>/<tenant>/<app>
```

Example:

```text
production/client1/backend
```

The recommended lock store is DynamoDB using conditional writes. If adding DynamoDB is not acceptable, S3 lock objects can be used as a fallback, but they must be implemented carefully.

Answered by: `initial-architecture-proposal.md`, section 22.

Open item: decide whether DynamoDB is acceptable for locks or whether the project must use the S3 fallback.

## 15. Where is deploy history stored?

Deploy history should be stored as append-only JSON event records plus a small `current.json` state file.

The proposal recommends encrypted S3 storage.

Event records preserve the audit trail. `current.json` answers the operational question: what version should this tenant/app currently be running?

Answered by: `initial-architecture-proposal.md`, section 23.

Open item: choose the exact S3 bucket or prefix.

## 16. How do operators view logs and status?

`deployctl status` should read deploy history/current state.

`deployctl logs` should read from CloudWatch Logs, filtered by tenant, environment, service, time range, and instance where needed.

This avoids routine SSH and works better for production ASG instances.

Answered by: `initial-architecture-proposal.md`, section 24.

## 17. What is explicitly out of scope for version 1?

Version 1 does not include:

- Terraform changes
- tenant onboarding automation
- database provisioning
- database migration automation
- DNS or broad Cloudflare infrastructure changes
- Docker, Kubernetes, ECS, or ECR-based deploys
- a web dashboard
- automatic rollback

Answered by: `initial-architecture-proposal.md`, sections 2 and 26.

## 18. How will database migrations be handled?

Database migration automation is intentionally out of scope for version 1.

This is because code rollback is relatively simple, but database rollback can be risky, especially in a healthcare environment. Releases that require database changes need manual handling or a separate migration design with tenant-safe guardrails.

Answered by: `initial-architecture-proposal.md`, section 26.

Open item: define the runbook for releases that require manual migration steps.

## 19. What IAM permissions are required?

The proposal lists minimum capabilities rather than final IAM policy JSON.

The deploy pipeline or operator needs permissions to:

- resolve/read application source
- run SSM commands against allowed instances
- read SSM command status
- acquire and release deployment locks
- sync to allowed tenant frontend buckets
- read and write deploy history
- read CloudWatch logs

The EC2 instance role needs permission to read the required Secrets Manager paths.

Answered by: `initial-architecture-proposal.md`, section 27.

Open item: create final least-privilege IAM policies during implementation.

## 20. What should the freelancer or implementer deliver?

The proposed version 1 deliverables are:

- final architecture and operating model documentation
- TypeScript `deployctl` CLI
- `tenants.yml` format and validation
- Bitbucket pipeline configuration
- backend deploy script invoked through SSM
- frontend build, artifact, and S3 sync flow
- deployment lock implementation
- ASG replacement bootstrap assumption or reconcile procedure
- deploy history JSON format
- rollback commands
- status and CloudWatch logs commands
- operator documentation

Answered by: `initial-architecture-proposal.md`, section 29.
