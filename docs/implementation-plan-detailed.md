# Implementation Plan (Detailed, Beginner-Friendly Edition)

This document is a long-form companion to [`docs/implementation-plan.md`](implementation-plan.md).
It covers the same phases and the same decisions, but it explains *everything* from the
ground up: what each piece is, **why** we do it that way, and **why the phases run in the
order they do**. If you are new to deployments, AWS, or this project, start here.

The terse tracker in `implementation-plan.md` remains the source of truth for task lists
and status. This document never contradicts it; it explains it.

---

## Part 0: The Big Picture (Read This First)

### What problem are we actually solving?

We run one application (a backend API + worker, and a frontend website) for **multiple
customers**. In this project each customer is called a **tenant** (for example `client1`,
`client2`). Every tenant needs to run *their own* version of the software, and we must be
able to update one tenant without touching the others.

The naive way to do this would be to copy the whole application once per tenant, or to build
a separate server stack for each tenant. Both are expensive, slow, and hard to keep
consistent. We want something lighter: **deploy independent versions per tenant, on top of
the infrastructure we already have**, without duplicating everything.

`deployctl` is the tool that does this. It is a small command-line program (a "CLI" — you
type a command in a terminal and it does work). For example:

```bash
deployctl deploy backend --tenant client1 --env staging --ref feature/login
```

That single line means: *"Deploy the backend for customer `client1`, in the staging
environment, using the code from the `feature/login` branch."*

### The five ideas the whole system is built on

Before any phases, it helps to understand five recurring ideas. Everything later is an
application of these.

1. **A deploy is pinned to one exact commit.** In Git (the version-control system that
   stores our code), a "branch" like `main` is a moving label — today it points at one
   version of the code, tomorrow it might point at a newer version. A "commit" is one
   exact, frozen snapshot of the code, identified by a long code called a SHA (for example
   `abc123…`). We let people *type* a branch for convenience, but the very first thing the
   tool does is translate that branch into the exact commit it points to *right now*, and
   from then on it only uses the commit. This way a deploy can't silently change halfway
   through just because someone pushed new code.

2. **Build once, deploy many.** If five tenants all want the same version of the code, we
   prepare that version *once* and let all five point at it. We never rebuild the same code
   five times. This is faster and guarantees those tenants are truly running identical code.

3. **Tenants are isolated.** Each tenant has its own running processes and its own storage.
   Deploying `client1` restarts only `client1`'s processes; `client2` keeps serving traffic
   undisturbed.

4. **Everything is recorded.** Every deploy writes a permanent record: who did it, what
   version, when, and whether it succeeded. This record is what makes "show me the current
   status" and "roll back to the previous version" possible and trustworthy.

5. **Secrets never travel through the tool.** Passwords and API keys (we call them
   "secrets") live in AWS Secrets Manager. The tool only ever passes around the *name* of a
   secret, never the secret value itself. The server reads the actual value at the last
   moment using its own AWS permissions. Secrets never appear in our code, our logs, or an
   operator's screen.

### A note on the building blocks (AWS and friends)

You'll see these names repeatedly. Plain-English definitions:

- **EC2** — a virtual server (a computer) running in AWS. Our backend runs on EC2 servers.
- **ASG (Auto Scaling Group)** — a managed group of EC2 servers that AWS keeps at a target
  size. If one server dies, the ASG automatically replaces it with a fresh, empty one. (This
  fact causes real work later; remember it.)
- **SSM (AWS Systems Manager)** — a way to run a command *on* an EC2 server without logging
  in over SSH. We use it so operators never need SSH keys.
- **S3** — AWS's file storage in the cloud ("buckets" hold "objects"/files). We store the
  frontend's built files and our deploy history here.
- **Secrets Manager** — AWS's secure store for passwords and keys.
- **CloudWatch Logs** — AWS's central place where application logs are collected from all
  servers, so we can read them in one place instead of hunting across machines.
- **PM2** — a process manager that keeps our Node.js backend running. Each tenant runs as
  separate PM2 processes (an "api" process and a "worker" process).
- **Cloudflare** — sits in front of the frontend website, providing DNS and a CDN (a cache
  network that serves files quickly worldwide).
- **Bitbucket Pipelines** — automation that can run our tool on a server when code changes,
  instead of a person running it by hand.

Don't worry about memorizing these. Each phase that uses one re-explains it in context.

### How does `deployctl` actually connect to AWS?

A natural question: when the tool "deploys to a server" or "stores a file," how does it
*reach* AWS? The answer is simple and consistent: **it calls AWS's web APIs over HTTPS.**
There is no SSH, no VPN, and no special tunnel. Every AWS service (S3, SSM, Secrets Manager,
CloudWatch) is just a web service with an HTTPS API, and `deployctl` talks to those APIs using
the **AWS SDK** — a ready-made library that turns a normal function call in our code into a
properly signed HTTPS request to AWS.

Two things make this work:

- **The SDK** does the talking. In our codebase, *only* the `adapters/` files (`s3.ts`,
  `ssm.ts`, `secrets.ts`, `cloudwatch.ts`) ever call the SDK. Everything else stays away from
  AWS, which is what keeps the rest of the code testable.
- **IAM credentials** prove who we are. Every API request must be cryptographically signed
  with AWS **IAM** credentials (AWS's identity-and-permissions system). Those credentials come
  from wherever the tool runs — a Bitbucket Pipeline or an operator's laptop — and they are
  scoped to *least privilege*: only the exact actions the tool needs.

The important subtlety is that there are really **two different connections to AWS**, not one.
This "two-hop" model is the key idea:

```text
        ┌──────────────────────────────────────────────────────────────────┐
        │  Where deployctl runs (operator laptop OR Bitbucket Pipeline)      │
        │                                                                    │
        │     deployctl  ──uses──▶  AWS SDK  ──signs with──▶  IAM creds      │
        └───────────────┬───────────────────────────────────────────────────┘
                        │  HOP A: HTTPS API calls (the "control plane")
                        │
          ┌─────────────┼───────────────┬──────────────┬───────────────┐
          ▼             ▼               ▼              ▼               ▼
     ┌─────────┐  ┌──────────┐    ┌──────────┐   ┌────────────┐  ┌────────────┐
     │  S3 API │  │ SSM API  │    │  S3 API  │   │ CloudWatch │  │  (history) │
     │ history │  │"run this │    │ frontend │   │  Logs API  │  │   in S3    │
     │ + state │  │ on those │    │  bucket  │   │  (read)    │  │            │
     └─────────┘  │ servers" │    └──────────┘   └────────────┘  └────────────┘
                  └────┬─────┘
                       │  SSM Agent delivers the command
                       ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │  EC2 server (staging) or ASG servers (production)                  │
        │                                                                    │
        │   deploy script runs here, then makes ITS OWN AWS calls           │
        │                                                                    │
        │     server  ──uses its EC2 instance role──▶  Secrets Manager API  │
        │       "give me the value of skincair/staging/db/client1"          │
        └──────────────────────────────────────────────────────────────────┘
                        ▲
                        │  HOP B: the server's own HTTPS API calls
                        │  (using the EC2 instance role, NOT the operator's creds)
```

**Hop A — `deployctl` → AWS APIs (the control plane).** The tool itself only ever calls AWS
*APIs*. To deploy the backend it does **not** connect to the server directly. Instead it calls
the **SSM** API and effectively says, *"run this deploy script on these EC2 instances."* SSM is
the bridge that delivers and runs the command on each server. This is exactly why operators
never need SSH keys or network access to the servers — the only thing they need is permission
to call the SSM API.

**Hop B — the server → AWS APIs.** Once the deploy script is running *on* the EC2 server, the
server makes its *own* AWS API calls, signed with the **EC2 instance role** (a set of
permissions attached to the server itself, separate from the operator's credentials). The
clearest example is secrets: `deployctl` only ever passes the secret's *name*
(`skincair/staging/db/client1`). The server then calls the **Secrets Manager** API itself to
fetch the real value, at the last moment, on the machine that actually needs it. The real
secret never passes through the tool, the pipeline logs, or the operator's screen.

Which API does which job:

| What needs to happen | AWS service / API | Who makes the call |
|----------------------|-------------------|--------------------|
| Run the backend deploy on servers | **SSM** Run Command | `deployctl` (Hop A) |
| Read a tenant's secrets | **Secrets Manager** | the **EC2 server** (Hop B) |
| Sync frontend files to the tenant bucket | **S3** | `deployctl` (Hop A) |
| Store deploy history & current state | **S3** | `deployctl` (Hop A) |
| Read application logs | **CloudWatch Logs** | `deployctl` (Hop A) |

Two connections in this picture are **not** AWS APIs: resolving a branch to a commit talks to
**Git/Bitbucket**, and the frontend is served through **Cloudflare** (which a normal deploy
doesn't change). Everything else is "AWS SDK → AWS HTTPS API, signed with IAM credentials."

One-sentence version: **`deployctl` connects to AWS purely through HTTPS APIs via the AWS SDK,
authenticated with scoped IAM credentials — using SSM as the bridge onto servers so we never
need SSH, and letting each server read its own secrets through its instance role.**

---

## Part 1: The Foundational Decisions (and Why)

These are the choices that shape the whole project. The phases later are just the careful,
ordered *implementation* of these decisions. Understanding the "why" here makes every phase
obvious.

### Decision 1 — A separate repository for deployment tooling

**What:** `deployctl`, the tenant configuration, the pipeline config, and the docs live in
their *own* Git repository, separate from the application's code repository.

**Why:** Deploying is a different job from building features. The people and systems that
deploy need powerful permissions (they can change production!). The people who write
application features mostly don't. Keeping deployment tooling in its own repo means we can
grant production-deploy access narrowly, review deployment changes on their own, and avoid
exposing deploy internals to every application developer. The tradeoff is a small amount of
extra setup: the deploy repo needs read access to the application repo so it can fetch and
build a chosen commit. That's a fair price for cleaner security boundaries.

### Decision 2 — CLI first, dashboard later (but the dashboard is coming)

**What:** Version 1 is a command-line tool. A web dashboard (a website with buttons to
deploy and see status) is a *confirmed* requirement, but it is built in a later phase.

**Why this order:** A dashboard is itself a small web application that can trigger
**production** deploys. That means it needs login, access control, network protection, and
audit logging — a lot of security surface. None of that can be done correctly until the
underlying deploy/rollback/history logic exists and is reliable, because the dashboard
doesn't reinvent that logic — **it calls it**. So we make the engine correct first, with the
CLI as the only entry point (where security is mostly just AWS permissions), and then add the
dashboard as a thin layer on top. Building the UI first would be building a control panel for
an engine that doesn't exist yet.

**The crucial structural consequence:** because the dashboard will *call the same code* the
CLI calls, we must write that code as a reusable **library**, not bury it inside the
command-line plumbing. This is why the repository is split into thin "commands" and a shared
"core" (see Part 2). Keep this in mind — it explains a lot of the structure.

### Decision 3 — Written in TypeScript, not shell scripts

**What:** The tool is a small TypeScript program running on Node.js. Shell scripts are used
only for tiny tasks that must run *on* the server (like restarting a process).

**Why:** Before doing anything risky, the tool must *check* a lot of things: Does this tenant
exist? Is this environment valid? Is this code reference allowed in production? Which storage
bucket and which processes belong to this tenant? That kind of validation, plus calling AWS
APIs and producing clear error messages, is painful and error-prone in shell scripts.
TypeScript lets us model these shapes as types and catch mistakes before a deploy runs. Shell
still has a place — for the few commands that genuinely run on the server's filesystem — but
the decision-making lives in TypeScript.

### Decision 4 — Deploys are pinned to an exact commit

(Already introduced in Part 0, idea #1.) **Why it's a foundational decision and not just a
detail:** so much of the system depends on "what exactly is deployed" being a precise,
unchanging answer — history, rollback, and keeping a multi-server production fleet consistent
all require it. We also make production *stricter* than staging: staging accepts a branch,
tag, or commit for convenience, but **production accepts only a tag or an exact commit**,
never a moving branch. Production changes should be deliberate.

### Decision 5 — Backend uses immutable "release directories" + symlinks

**What:** On each server, every deployed commit gets its own folder, prepared once:

```text
/opt/sherwood/releases/abc123      <- code for commit abc123, deps installed, built
/opt/sherwood/releases/def456      <- code for commit def456
```

Each tenant has a small pointer (a "symlink", basically a shortcut) called `current` that
points at whichever release that tenant should run:

```text
/opt/sherwood/tenants/client1/current -> /opt/sherwood/releases/abc123
/opt/sherwood/tenants/client2/current -> /opt/sherwood/releases/def456
```

**Why:** Without Docker (which we're deliberately not using in v1), the code must sit
directly on the server's disk. The simplest approach — one folder that you `git pull` into —
*can only hold one version at a time*. That breaks the moment `client1` needs one version and
`client2` needs another. Release directories fix this: each version exists once, and tenants
are switched by repointing their `current` shortcut and restarting only their processes.
Crucially this is **not** "a copy per tenant" — it's a copy per *commit*. Five tenants on the
same commit share one release directory. This also makes rollback trivial: point `current`
back at the old release.

### Decision 6 — Frontend uses reusable build artifacts per commit

**What:** The frontend (a React website) builds into a bundle of static files. We build that
bundle once per commit, store it (keyed by the commit), and copy it to each tenant's storage
bucket. Tenants on the same commit reuse the same bundle. Anything tenant-specific (like a
different API URL) is handled as small *runtime configuration*, not by building different code
per tenant.

**Why:** If the code is identical, the build is identical, so building per tenant would be
wasteful and could introduce subtle differences. Storing the exact built artifact also makes
frontend rollback easy: we re-deploy the old artifact instead of rebuilding old code.

### Decision 7 — Concurrency guardrail via an "in-progress" flag (not a separate lock database)

**What:** To stop two deploys from changing the same target at the same time, we use a
lightweight `inProgress` flag stored on the small current-state record (see Decision 8). The
tool sets it before starting and clears it when done.

**Why this and not something heavier:** The classic solution is a dedicated lock store
(DynamoDB or special S3 lock files). For a tool whose main user is a single person (the
project owner, via the dashboard later), standing up that extra infrastructure is
disproportionate. The `inProgress` flag solves the real problem — *don't let a second deploy
start against the same `environment/tenant/app` while one is running* — without new moving
parts. It's scoped per target, so an in-progress deploy for `client1` never blocks `client2`.

### Decision 8 — History as append-only events + a small "current state" file

**What:** Two kinds of record, both stored as JSON files in encrypted S3:

- **Event log (append-only):** one file per deploy/rollback, never edited afterward. This is
  the permanent audit trail — it includes successes, failures, and partial failures.
- **Current-state file:** one small file per `tenant/app` saying "the version that *should*
  be running now." This is the quick answer for status, rollback, and production recovery.

**Why two separate things:** They answer two different questions. "What happened over time?"
(history) and "What should be running right now?" (current state). Mixing them into one
mutable file risks losing history every time you overwrite it. Keeping the event log
append-only means we never lose the story of how we got here, while the tiny current-state
file keeps everyday operations fast.

### Decision 9 — Logs come from CloudWatch, not SSH

**What:** `deployctl logs` reads centralized logs from CloudWatch, filtered by environment,
tenant, service, and time.

**Why:** In production there are several servers behind a load balancer. If logs only lived
as files on each server, you'd have to guess which server handled a request and log in to it.
CloudWatch collects logs from all servers in one place, so the tool can fetch exactly the
slice you want without SSH.

### Decision 10 — Deliberate non-goals for version 1

We explicitly **exclude** these from v1 to keep it safe and shippable: no Terraform changes,
no tenant onboarding automation, no database provisioning, no DNS/Cloudflare infrastructure
changes, no Docker/Kubernetes/containers, **no automatic rollback**, and **no database
migration automation**. These aren't oversights — each is a deliberate scope boundary,
recorded so nobody mistakes them for forgotten work. Automatic rollback and database
migrations in particular are risky enough to deserve their own future design.

---

## Part 2: The Repository Structure (and Why It's Shaped That Way)

The internal layout is a direct consequence of Decision 2 (a dashboard will later call the
same code) and Decision 3 (validation-heavy logic in TypeScript). The target layout:

```text
src/
  cli.ts                # entry point: read the typed command, hand off to a command handler
  commands/             # THIN handlers, one per command — they just parse + delegate
    tenants.ts  deploy.ts  rollback.ts  status.ts  logs.ts  reconcile.ts  cleanup.ts
  core/                 # the SHARED LIBRARY — all real deployment logic lives here
    tenants.ts          #   load + validate the tenant registry
    refs.ts             #   turn a branch/tag into an exact commit
    history.ts          #   read/write deploy events + current state
    guardrail.ts        #   the inProgress concurrency check
    deploy.ts           #   backend + frontend deploy orchestration
    rollback.ts         #   choose a previous version + redeploy it
    diagnostics.ts      #   status + logs queries
    cleanup.ts          #   retention logic
  adapters/             # thin, swappable wrappers over external systems
    ssm.ts  s3.ts  secrets.ts  cloudwatch.ts  git.ts
  shared.ts             # output formatting, error types, shared config types
scripts/
  ec2/                  # tiny shell scripts that run ON the server, invoked via SSM
dashboard/              # LATER phase: a second thin caller over core/
test/                   # mirrors src/, tests real observable behavior first
tenants.yml             # the tenant registry (names + references, never secret values)
```

**The three layers and why they exist:**

- **`commands/` (thin controllers).** These only translate "what the user typed" into a call
  into `core/`. They contain no business rules. Why thin? Because the dashboard will later be
  a *second* set of thin controllers over the same `core/`. If logic leaked into the command
  handlers, the dashboard would have to duplicate it — exactly the fork we're avoiding.

- **`core/` (the shared library).** Every real decision lives here: validation, commit
  resolution, history, the guardrail, the deploy/rollback flows. This is the part that must
  be importable and testable on its own, independent of the command line. It's the "engine."

- **`adapters/` (the outside world).** Thin wrappers around AWS (SSM, S3, Secrets Manager,
  CloudWatch) and Git. Isolating these means `core/` can be tested without touching real
  infrastructure — in tests we substitute fake adapters. This is what keeps the project
  unit-testable and fast.

If you remember one thing: **CLI and dashboard are both thin callers; the engine is `core/`;
AWS is quarantined in `adapters/`.**

---

## Part 3: Why the Phases Run in This Order

The single most important ordering principle: **build the shared foundations before the
things that depend on them, and build risk-reducing/visibility tools before the risky actions
that need them.**

Concretely:

1. **You can't act safely without knowing the ground truth** → discovery first (Phase 0).
2. **You can't deploy without a tool to run** → CLI scaffold (Phase 1).
3. **You can't deploy a tenant without knowing what a tenant *is*** → tenant registry
   (Phase 2).
4. **You can't deploy safely without pinning the exact code** → ref resolution (Phase 3).
5. **You can't roll back, show status, or recover a replaced server without records** →
   history + current state (Phase 4).
6. **You can't safely allow deploys without preventing two-at-once** → guardrail (Phase 5).
7. *Only now* do the actual deploys make sense → backend (Phase 6), frontend (Phase 7).
8. **Rollback needs history + both deploy paths to exist** → rollback (Phase 8).
9. **Operating the system needs visibility** → status & logs (Phase 9).
10. **Production servers can be replaced, so recovery must exist** → reconciliation
    (Phase 10).
11. **Storage grows forever unless trimmed** → cleanup (Phase 11).
12. **Automating the tool needs the tool to be stable** → pipelines (Phase 12).
13. **Tests grow alongside features, not as a big bang** → testing (Phase 13).
14. **Docs track reality as it solidifies** → documentation (Phase 14).
15. **The dashboard has nothing to call until 2–9 exist** → dashboard last (Phase 15).

Phases 2–5 are collectively the **"Deploy Prerequisites."** Backend/frontend deploy
(Phases 6–7) must not ship until all four exist and are wired in, because a deploy that
skips validation, commit-pinning, history, or the guardrail is exactly the kind of unsafe
deploy this whole project exists to prevent.

> Note: Phase 0 is included here because this document explains the work end to end. The
> company-facing Word summary omits Phase 0 because it is internal discovery rather than a
> delivered milestone — but the work itself still happens.

---

## Part 4: The Phases in Detail

Each phase below has: **What it is**, **Why it matters**, **Why it sits here in the order**,
and **What "done" looks like** where the plan defines it. The task lists themselves live in
`implementation-plan.md`; here we explain the intent behind them.

### Phase 0 — Discovery & Decisions

**What it is.** Before writing any code that touches AWS, we confirm the assumptions the
design rests on, and we *write the answers down* (in `CONTEXT.md` and the architecture
proposal). Things to confirm include: the exact server filesystem layout, how tenant
processes are named in PM2, how CloudWatch log groups/streams are named, how secrets are
named in Secrets Manager, how a *replaced* production server bootstraps itself, how the tool
gets access to the application's source code, and the exact build commands for backend and
frontend. We also decide which S3 buckets/prefixes hold history and artifacts, and define the
least-privilege AWS permissions.

**Why it matters.** Every later phase encodes assumptions about these facts. If we guess the
PM2 process names wrong, the deploy restarts the wrong thing. If we guess the bootstrap
behavior wrong, a replaced production server could silently serve stale code. Discovery turns
guesses into confirmed facts so later code is built on solid ground.

**Why it's first.** It's pure information-gathering with no risk, and it removes the biggest
source of rework: discovering a wrong assumption *after* building on it. A confirmed fact is
cheap now and expensive later.

### Phase 1 — CLI Foundation

**What it is.** Create the TypeScript project skeleton: the package setup, the type-checking
and test configuration, a minimal command entry point, and the shared conventions for output
and error messages. Commands that aren't implemented yet should fail with a clear message —
never do something half-done or risky. We also add the first real test (for example, that
`deployctl --help` prints usage).

**Why it matters.** This establishes the *quality bar* every later phase is held to: a phase
is only "done" when its behavior has a passing test and the project type-checks cleanly.
Putting that bar in place first means quality is built in from commit one, not bolted on
later.

**Why it sits here.** You need a runnable tool before you can add any behavior to it, but it
must have **no AWS side effects** yet — we're building the safe container that later, riskier
phases will fill in.

**Done when.** `npm test` and `npm run typecheck` pass and `deployctl --help` prints usage,
covered by a test.

### Phase 2 — Tenant Registry

**What it is.** A configuration file, `tenants.yml`, maps each tenant in each environment to
the real resources it uses: its frontend storage bucket, the *names* of its secrets, its PM2
process names, its app directory, and its health/URL endpoints. This phase loads that file,
validates it, rejects anything that looks like a real secret accidentally pasted in, and adds
a command to list the configured tenants.

**Why it matters.** A tenant *name* like `client1` isn't enough to deploy safely — the tool
must translate it into "use *this* bucket, restart *these* processes, read *these* secrets,
check *this* health URL." That translation table is the registry. Storing only references
(like `skincair/staging/db/client1`), never actual passwords, keeps secrets out of Git while
keeping deploys reviewable: if someone repoints a tenant at a different bucket, it shows up in
a pull request before it can affect a real deploy.

**Why it sits here.** It's the first true "deploy prerequisite." Every deploy action needs to
look a tenant up, so the registry must exist before deploys.

**Done when.** `deployctl tenants list --env staging` prints the configured tenants for a
valid config, and exits with a clear error on an invalid or missing config — both tested.

### Phase 3 — Git Ref Resolution

**What it is.** Turn whatever the operator typed (a branch, a tag, or a commit) into one
exact, full commit SHA *before any deploy work begins*, and record both the original input
and the resolved commit. Enforce the rule that production accepts only tags or exact commits,
not moving branches.

**Why it matters.** This is Decision 4 made real. A branch is a moving pointer; pinning to a
commit means a deploy can't change underneath you, history is exact, and rollback can target a
precise version. Storing *both* the requested ref and the resolved commit means the records
show both "what the human asked for" and "what actually shipped."

**Why it sits here.** It must run at the very start of every deploy, before anything else
touches a server — so it's built before the deploy phases that call it.

### Phase 4 — Deploy History & Current State

**What it is.** Define and implement the two record types from Decision 8: append-only
**event** records (one per deploy/rollback, immutable) and a small **current-state** file per
`tenant/app`. Implement writing events, reading and updating current state, and looking up the
previous version (needed for rollback).

**Why it matters.** This is the system's memory. Without it, "what's running?" and "roll back
to the last good version" are unanswerable, and a replaced production server has no way to
learn what it should run. The append-only event log is also the audit trail — important for a
healthcare platform.

**Why it sits here.** Both deploy and rollback *write* to history, and the guardrail (next
phase) lives *on* the current-state record — so history must be defined before either.

### Phase 5 — Deployment Guardrail

**What it is.** Add the `inProgress`/`since` fields to the current-state record (from
Phase 4). At the start of a deploy or rollback, check whether that exact
`environment/tenant/app` target is already in progress; if so, refuse with a clear "deploy
already in progress" message. Set the flag at the start and clear it on completion *or*
failure.

**Why it matters.** Without this, two pipelines or two people could deploy the same target at
once and corrupt the records — one updates the server while the other overwrites history,
leaving the system genuinely unsure what's running. The guardrail protects exactly the risky
window.

**Why it sits here.** It builds directly on the Phase 4 current-state record, and it must
exist before deploys are allowed, since deploys are precisely what it guards. It is the last
of the four "deploy prerequisites."

### — Deploy Prerequisites Checkpoint —

Backend and frontend deploy (next) must not ship until Phases 2–5 are all implemented and
wired into the deploy flow, and the flow must fail cleanly — leaving no half-finished state —
on any of: bad config, a guardrail conflict, a failed deploy, or a failed history update.
This checkpoint is the safety gate between "scaffolding" and "actually changing servers."

### Phase 6 — Backend Deploy

**What it is.** Deploy a backend release to the target servers (the single staging EC2, or
*all* healthy production ASG servers) using SSM (no SSH). On each server: prepare the release
directory for the commit, install dependencies and build *once* per release, read the
tenant's secrets from Secrets Manager and write a protected per-tenant environment file,
repoint the tenant's `current` symlink, restart **only** that tenant's PM2 processes, and run
a health check. Record success, failure, or partial production failure.

**Why it matters.** This is the core action the whole tool exists for, and it embodies
Decisions 5 (release directories), 7 (guardrail), and the secrets rule. In production, all
healthy servers must succeed or the deploy is reported as **failed** — because if only some
servers update, users randomly hit old and new versions. On partial failure we do **not**
auto-rollback (a deliberate non-goal); instead we clearly report which servers changed, which
didn't, the previous version, and the exact rollback command to run.

**Why it sits here.** It is only safe *after* the four prerequisites exist: it looks up the
tenant (Phase 2), pins the commit (Phase 3), records the result (Phase 4), and holds the
guardrail (Phase 5).

### Phase 7 — Frontend Artifact & Deploy

**What it is.** Build (or reuse) the frontend bundle for the resolved commit, store it keyed
by commit, and sync it to the tenant's S3 bucket with **explicit cache headers**: long-lived
caching for fingerprinted asset files, but no-cache for `index.html` and any runtime config
file. Optionally write a small tenant runtime-config file. Run a smoke check.

**Why it matters.** This is Decision 6 in action. The cache headers are the subtle, important
part: fingerprinted files (like `app.abc123.js`) change name when their content changes, so
they're safe to cache forever — but `index.html` keeps its name and points to the current
files, so if it's cached too aggressively, users keep loading the *old* site after a deploy.
Setting headers deliberately prevents stale or mixed-version pages without changing any DNS or
Cloudflare infrastructure.

**Why it sits here.** Same reason as backend deploy — it needs all four prerequisites. It's a
sibling of Phase 6 (backend and frontend deploy independently), placed right after it.

### Phase 8 — Rollback

**What it is.** Return a single tenant's backend or frontend to a previous known-good
version. Backend: find the previous commit in history, make sure that release still exists on
the servers (re-prepare it if it was cleaned up), repoint the symlink, restart the tenant, and
health-check. Frontend: re-sync the previous stored artifact. Record the rollback as its own
event and update current state.

**Why it matters.** Things go wrong; a fast, exact way back to a working version is essential.
Because every version was recorded (Phase 4) and artifacts/releases are retained (Phase 11's
policy), rollback is quick and precise rather than a rebuild-from-scratch scramble. Note:
rollback returns the *code*, not the *database* — database rollback is intentionally out of
scope and riskier.

**Why it sits here.** Rollback literally needs history (Phase 4) plus both deploy paths
(Phases 6–7) to exist — it reuses their machinery in reverse. So it can only come after them.

### Phase 9 — Logs & Diagnostics

**What it is.** A `status` command that reports the current deployed version per tenant/app
(and per-server results where relevant in production), and a `logs` command that reads
CloudWatch Logs filtered by environment, tenant, service, and time range.

**Why it matters.** Operating the system requires seeing it. Status answers "what's running?"
from the current-state file; logs answer "what's it doing / why did it fail?" from CloudWatch
— without anyone needing SSH. This is Decision 9 realized.

**Why it sits here.** It reads the records and deploy results produced by earlier phases, so
those must exist first. It's also a prerequisite for the dashboard (which shows status), so it
comes before Phase 15.

### Phase 10 — ASG Replacement & Reconciliation

**What it is.** Handle the fact that a production ASG can replace a server at any time, giving
you a fresh, empty machine. First, confirm (from Phase 0) whether existing bootstrap already
restores tenant state. If it does, document that. If it doesn't, provide a `reconcile` command
that reads the recorded desired state and brings each healthy production server into line.

**Why it matters.** A user's request in production might land on the replaced server. If that
server doesn't know which version each tenant should run, production becomes quietly
inconsistent — some requests get the right version, some don't. Reconciliation closes that
gap. It depends entirely on history/current-state (Phase 4) being accurate.

**Why it sits here.** It needs the records (Phase 4) and the deploy machinery (Phase 6) to
exist, and it's gated on the Phase 0 discovery about how replacement servers currently boot.
Hence it comes after the core deploy work, not before.

### Phase 11 — Cleanup & Retention

**What it is.** A retention policy and explicit cleanup commands for old backend releases and
old frontend artifacts. The baseline keeps: every currently deployed version, the last 10
successful versions per tenant/app, and anything deployed in the last 30 days. Cleanup always
offers a `--dry-run` preview and never deletes silently during a normal deploy.

**Why it matters.** Disk and storage grow without bound if nothing is ever deleted — but
deleting too eagerly breaks rollback, which depends on old versions still existing. The policy
threads that needle: keep enough to roll back comfortably, delete only genuinely unused old
versions, and always let a human preview deletions first.

**Why it sits here.** You can only safely define "keep the current and recent versions" once
deploy history and the deploy/rollback flows exist to define what "current" and "recent"
mean.

### Phase 12 — Bitbucket Pipeline Integration

**What it is.** Wire the tool into CI pipelines: staging deploy pipelines, production deploy
pipelines (with the stricter tag/commit-only rule), and manual rollback pipelines. Configure
AWS authentication safely so credentials aren't embedded.

**Why it matters.** It gives the team a controlled, repeatable way to deploy without each
operator needing a fully configured laptop, and it centralizes where production deploys happen
(easier to audit). Pipelines become *another caller* of the same tool — they don't reinvent
anything.

**Why it sits here.** Automating a tool is only worthwhile once the tool is stable and its
commands are settled. Automating too early just means re-doing the automation as commands
change.

### Phase 13 — Testing & Validation

**What it is.** Grow automated tests *alongside* features rather than writing a giant
speculative suite up front. Focus on real behavior: tenant-config rules, ref-resolution
rules, history behavior, the guardrail, backend deploy failure handling, frontend cache
behavior, and rollback version selection. Live AWS calls are mocked (via the `adapters/`
layer) so tests are fast and safe.

**Why it matters.** Tests are what let us change the system later without fear. Writing them
*with* each feature keeps them grounded in actual behavior; writing a huge suite up front
tends to test guesses that later change.

**Why it sits here as a "phase."** Testing actually happens continuously from Phase 1 (every
phase is "done" only with a passing test). This phase is a placeholder to *track* the growing
set of validation areas, not a single moment where testing begins.

### Phase 14 — Documentation & Handoff

**What it is.** Keep operator- and developer-facing docs current as the tool solidifies:
deploy and rollback runbooks, a troubleshooting guide, a tenant-config update guide, and
security/IAM notes — alongside the architecture and context docs that already exist.

**Why it matters.** The tool is only as usable as it is understandable. Good runbooks mean the
team can operate and extend it without depending on one person's memory.

**Why it sits here.** Docs track reality, so they firm up as the behavior firms up. Like
testing, documentation is ongoing, but it's tracked as a phase so it isn't forgotten.

### Phase 15 — Web Dashboard

**What it is.** A small, server-rendered web app (think a lightweight server with simple
pages, not a heavy single-page framework) that lets the project owner deploy and see status
from a browser. It **imports the same `core/` modules** the CLI uses — it is a second thin
caller, not a separate deploy path. Version 1 of the dashboard covers backend deploy, frontend
deploy, and status (rollback and logs come later). It reuses the Phase 5 guardrail, requires
authentication (basic auth or a shared secret) plus a network restriction (since it can
trigger production deploys), and records the authenticated person against every action in
deploy history.

**Why it matters.** It's the confirmed end-goal interface for the project owner — easier than
the terminal for everyday use. Building it on the shared core means it inherits all the
correctness (commit pinning, guardrail, history, audit) the CLI already has, for free.

**Why it's last.** This is the clearest ordering decision in the whole plan: the dashboard
*calls* the orchestration modules, so it has literally nothing to call until Phases 2–9 exist
and are stable. Building it earlier would mean either reimplementing that logic (the fork we
designed the whole structure to avoid) or building a UI for an engine that isn't there yet.

---

## Part 5: A One-Paragraph Recap

We're building a small, careful command-line tool that deploys a multi-tenant app per tenant,
on top of existing AWS, by pinning every deploy to an exact commit, preparing each version
once and pointing tenants at it, syncing reusable frontend bundles with deliberate caching,
and recording everything so status and rollback are trustworthy. We build the shared
foundations (knowing the ground truth, a safe tool shell, the tenant registry, commit pinning,
history, and the concurrency guardrail) *before* the deploy actions that depend on them, then
add rollback, visibility, production recovery, cleanup, automation, tests, and docs, and
finally a web dashboard that reuses the exact same engine. Every ordering choice comes back to
one rule: **don't build a thing before the things it depends on, and put safety and visibility
in front of risky actions.**
