/** Hosted MCP contract golden (HezLead ruling 3; FOLLOW-UPS-C1 #34 gate for X2). The lock-order
 * lane must not change one byte of what a hosted MCP client sees. The golden file pins, through
 * the real protocol module: initialize, the tools/list bytes (names, descriptions, input
 * schemas, annotations), every claim_seat and whoami input refusal, every refusal rendering
 * those tools can return, and the claim_seat and whoami outputs from the real claim and read
 * backends. Backend outputs normalize only generated values: fixture UUIDs get fixed names,
 * server-generated UUIDs become <uuid_N> and seat handles <handle_N>.
 *
 * The backend part needs the verified stack binding (C1B_LOCK_ORDER_BINDING, or the CLI
 * project binding under GitHub Actions); it runs in the server suite only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error TS5097: this test imports the Deno source directly.
import { MCP_ISSUER, MCP_RESOURCE } from "../../supabase/functions/mcp/auth.ts";
// @ts-expect-error TS5097: this test imports the Deno source directly.
import { createMcpProtocolHandler } from "../../supabase/functions/mcp/protocol.ts";
// @ts-expect-error TS5097: this test imports the Deno source directly.
import { HostedToolFailure } from "../../supabase/functions/mcp/tool-errors.ts";
import { enableIssuanceForTest, measureIssuanceForTest, recordChecksumEvidenceForTest } from "../support/admin-schema-db.js";

type Execute =
  | { kind: "none" }
  | { kind: "throw"; code: string }
  | { kind: "throw_plain" }
  | { kind: "return"; value: Record<string, unknown> };
interface Rendered { label: string; http_status: number; text: string }
interface CatalogEntry extends Rendered { request: Record<string, unknown>; execute: Execute }
interface Golden { about: string; catalog: CatalogEntry[]; backend: Rendered[] }

const golden = JSON.parse(readFileSync(new URL("../support/hosted-mcp-contract-golden.json", import.meta.url), "utf8")) as Golden;

function executor(spec: Execute) {
  return async () => {
    if (spec.kind === "throw") throw new HostedToolFailure(spec.code);
    if (spec.kind === "throw_plain") throw new Error("backend failure");
    if (spec.kind === "return") return spec.value;
    throw new Error("this request must not execute a tool");
  };
}

async function render(request: Record<string, unknown>, spec: Execute): Promise<{ http_status: number; text: string }> {
  const serve = createMcpProtocolHandler({
    issuer: MCP_ISSUER, resource: MCP_RESOURCE, publicEnabled: true, allowedOrigins: new Set(),
    limits: { maxBodyBytes: 128 * 1024, maxResponseBytes: 64 * 1024, requestTimeoutMs: 25_000, maxConcurrentRequests: 4 },
    verifyToken: async () => ({ providerGrantId: "provider-golden", subject: "11111111-1111-4111-8111-111111111111", expiresAt: 1_900_000_000 }),
    executeTool: executor(spec),
  });
  const response = await serve(new Request(MCP_RESOURCE, {
    method: "POST", headers: { authorization: "Bearer golden.token.value", "content-type": "application/json" },
    body: JSON.stringify(request),
  }));
  return { http_status: response.status, text: await response.text() };
}

test("golden file pins the contract surface", () => {
  const labels = golden.catalog.map((entry) => entry.label);
  for (const label of ["initialize", "tools/list", "claim_seat internal failure", "whoami internal failure"]) {
    assert.ok(labels.includes(label), `golden catalog lacks ${label}`);
  }
  assert.deepEqual(golden.backend.map((entry) => entry.label), [
    "claim_seat success", "claim_seat replay", "claim_seat reuse", "claim_seat name taken",
    "claim_seat workspace not consented", "claim_seat request_id conflict", "whoami success", "whoami unknown seat",
  ]);
});

for (const entry of golden.catalog) {
  test(`golden catalog: ${entry.label}`, async () => {
    const rendered = await render(entry.request, entry.execute);
    assert.equal(rendered.http_status, entry.http_status, `${entry.label}: HTTP status`);
    assert.equal(rendered.text, entry.text, `${entry.label}: response bytes`);
  });
}

interface Target { url: string; mode: string; close(): Promise<void> }
interface GoldenRun { stage: string; error?: string; golden?: Rendered[]; http_refused?: number }
interface Harness {
  openLockOrderTarget(options: { connector: unknown }): Promise<Target>;
  lockOrderConnector(issuance: { record: string; measure: string; enable: string }): unknown;
  runScenario(target: Target, scenario: string): Promise<GoldenRun>;
}
const harness = await import(new URL("../support/admin-principal-lock-order-harness.mjs", import.meta.url).href) as Harness;

test("golden backend: claim_seat and whoami over the real claim and read paths", { timeout: 420_000 }, async () => {
  const target = await harness.openLockOrderTarget({ connector: harness.lockOrderConnector({
    record: recordChecksumEvidenceForTest, measure: measureIssuanceForTest, enable: enableIssuanceForTest,
  }) });
  try {
    const run = await harness.runScenario(target, "golden");
    assert.equal(run.stage, "complete", `golden run stopped at ${run.stage} (${run.error ?? "no code"})`);
    assert.equal(run.http_refused, 0, "the golden run made an HTTP call");
    assert.deepEqual(run.golden, golden.backend);
  } finally {
    await target.close();
  }
});
