import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrontendArtifact, FrontendBuildRequest, FrontendBuilder, FrontendSmokeCheck } from "../core/frontend.js";

/**
 * Sim Phase 3 stand-in for the real frontend build (docs/phase-0-simulation-plan.md,
 * section B). No git checkout or npm install/build runs here — same "no real build"
 * simplification as the Sim Phase 2 backend release marker. Instead it synthesizes a
 * static page whose content embeds the resolved commit, env, tenant, and the exact
 * build variables, so identity-sensitive builds (the whole point of
 * frontendArtifactKey) are visible in the output, not just an opaque hash.
 */
export class FixtureFrontendBuilder implements FrontendBuilder {
  async build(request: FrontendBuildRequest): Promise<FrontendArtifact> {
    const html = renderFixtureSite(request);
    const dir = await mkdtemp(join(tmpdir(), "deployctl-sim-frontend-build-"));
    const path = join(dir, "index.html");

    await writeFile(path, html, "utf8");

    return { storageKey: path, byteSize: Buffer.byteLength(html, "utf8") };
  }
}

/**
 * Sim Phase 3 stand-in for the post-deploy frontend smoke check. The simulation does
 * not stand up a real HTTP server for tenant frontend URLs (Cloudflare/serving is out
 * of scope, per CONTEXT.md's connectivity notes), so this always reports healthy.
 */
export class NoopFrontendSmokeCheck implements FrontendSmokeCheck {
  async check(_url: string): Promise<boolean> {
    return true;
  }
}

function renderFixtureSite(request: FrontendBuildRequest): string {
  const variables = Object.keys(request.buildVariables)
    .sort()
    .map((name) => `    <li>${name}=${request.buildVariables[name]}</li>`)
    .join("\n");

  return `<!doctype html>
<html>
  <head><title>${request.key.tenant} (${request.key.env})</title></head>
  <body>
    <h1>${request.key.tenant} — ${request.key.env}</h1>
    <p>commit: ${request.key.resolvedCommit}</p>
    <p>fingerprint: ${request.key.fingerprint}</p>
    <ul>
${variables}
    </ul>
  </body>
</html>
`;
}
