import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readFunctionUrl = new URL(
  "../supabase/functions/read/index.ts",
  import.meta.url,
);

test("read exports its handler and serves only when run as main", async () => {
  const source = await readFile(readFunctionUrl, "utf8");

  assert.match(
    source,
    /export async function handleRequest\(request: Request\): Promise<Response> \{/,
  );

  const serveCalls = source.match(/Deno\.serve\s*\(/g) ?? [];
  assert.equal(serveCalls.length, 1, "read must contain exactly one Deno.serve call");
  assert.match(
    source,
    /^if \(import\.meta\.main\) Deno\.serve\(handleRequest\);$/m,
  );
});

test("read refuses hosted transport before listener reads or renewal-use stamping", async () => {
  const source = await readFile(readFunctionUrl, "utf8");
  const transportLookup = source.indexOf(
    "SELECT swarm.agent_principal_transport(",
  );
  const transportRefusal = source.indexOf(
    'return json(403, { error: "transport_unavailable" });',
    transportLookup,
  );
  const renewalUse = source.indexOf("SELECT swarm.record_renewal_grant_use(");
  const wakeLease = source.indexOf('if (body.resource === "agent_wake_lease")');

  assert.notEqual(transportLookup, -1, "read must resolve the authenticated seat transport");
  assert.notEqual(transportRefusal, -1, "read must reject non-local transport");
  assert.ok(transportRefusal < renewalUse, "transport refusal must precede renewal-use stamping");
  assert.ok(transportRefusal < wakeLease, "transport refusal must precede listener resource reads");
});
