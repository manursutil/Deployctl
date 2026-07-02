# Dashboard Design Direction

This document records the **visual and UX direction** locked in for the Phase 15 web
dashboard (`docs/implementation-plan.md` Phase 15, `docs/initial-architecture-proposal.md`
section 6a). It is a design artifact, not implementation. Phase 15 is still `Not started`
and blocked on Phases 2–9; this only fixes the look and interaction model so that when the
dashboard is built the visual language does not have to be re-litigated.

## Status

- Style direction: **locked** — "Operations Ledger" (2026-07-02).
- Implementation: not started (Phase 15, blocked on Phases 2–9).

## Chosen direction: Operations Ledger

Mockup: [`dashboard-mockups/mockup-operations-ledger.html`](../dashboard-mockups/mockup-operations-ledger.html)
(self-contained HTML/CSS/JS, openable directly in a browser).

Personality: calm, deliberate, audit-first. A cool-grey institutional surface (not the
generic cream/serif look), with a restrained clinical **teal** for normal signals and a
deep **oxblood** reserved for production and destructive weight. It is the closest of the
three explorations to the documented tech stack (a small server-rendered app), and it puts
safety and auditability ahead of speed — the right emphasis for a tool that can trigger
production deploys for a healthcare platform.

Signature elements to preserve when porting:

- **Append-only event ledger as the spine.** The deploy-history event stream runs down the
  right of the status view and is the backbone of the page — it mirrors the real
  append-only `events/*.json` history, so the UI foregrounds "what happened" the way the
  data model does.
- **Prominent target-environment switch.** The staging/production toggle is one of the
  loudest controls on the page: the active environment is a solid filled pill (white on
  green for staging, white on oxblood for production), under a clear "Target environment"
  label, separated from the operator/adapter metadata. A persistent 5px accent bar pinned
  to the top of the page restates the environment ambiently (green/oxblood) so the operator
  can never lose track of which environment is selected.
- **Type-the-commit production gate.** Production deploys are armed by typing the resolved
  commit SHA to confirm; staging enables directly. This is the deliberate, low-adrenaline
  safety gesture that fits the "confirmation over speed" brief.
- **Guardrail surfaced live.** The `inProgress` guardrail for the in-flight target shows as
  a dedicated strip, stating that only that `env/tenant/app` is locked and all other targets
  remain deployable — matching the per-`<env>/<tenant>/<app>` guardrail scope.

## Scope shown (matches Phase 15 v1)

- **Primary (v1):** status overview (current state per `env/tenant/app`) and backend/frontend
  deploy actions, plus the `inProgress` guardrail state.
- **Secondary / visibly deferred:** history, logs, and rollback are present in the nav but
  marked read-only / deferred, to show where the surface is heading without implying they
  ship in the first dashboard phase. Rollback and logs already exist in the CLI.

## Alternatives explored (parked, not deleted)

Kept in `dashboard-mockups/` in case we want to revisit or borrow an element:

- **Flight Deck** (`mockup-flight-deck.html`): deep-slate cockpit; fleet as annunciator
  tiles; production deploy behind a physical arm → hold-to-confirm switch with a flip-up
  safety cover. Most tactile. Parked because its density and adrenaline read further from
  the calm/audit emphasis we chose; the arming switch is a candidate element to borrow.
- **Blueprint Console** (`mockup-blueprint-console.html`): the dashboard rendered as the
  live two-hop deploy schematic (`deployctl → SSM → ASG → symlink → pm2 → health`) with a
  pulse travelling the path during a deploy. Strong mental model of "where the deploy is."
  Parked as the primary surface, but the schematic is a candidate for a deploy-detail view.

## Implementation caveat: port the look, not the client JS

The mockups are self-contained HTML with vanilla JS for interactivity (tab switching, the
env toggle, the type-to-confirm gate). Phase 15's decided stack is a **small server-rendered
TypeScript app (Express/Fastify with EJS or htmx), not a SPA**. When the dashboard is built:

- Reproduce the visual language (palette, type, layout, the four signature elements above)
  in server-rendered templates.
- Drive real behavior through the shared orchestration modules via the `src/composition.ts`
  composition root — the dashboard is a second thin controller over `core/`, exactly as the
  CLI is. Do not reimplement deploy logic in the browser.
- The env toggle, guardrail strip, and status table must reflect real `current.json` state;
  the type-to-confirm gate is a client-side affordance in front of the same guarded
  `runDeployLifecycle(...)` path the CLI uses.
