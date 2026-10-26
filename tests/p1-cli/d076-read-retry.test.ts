import assert from "node:assert/strict";
import { test } from "node:test";
import { readAgentSignalDirectory } from "../../src/cloud/signals.js";

/* D-076. `postgres@3.4.9` crashes the read isolate outside the handler's promise catch — a
 * `nextWrite` firing after `closed()` has nulled the socket — and the platform answers 503.
 * Measured by Plumb against production: 8 crashes in a day, 8/8 joining a `POST 503 /read`.
 * Upstream PR #1168 adds the null guard and is still OPEN, so there is no version to upgrade to.
 *
 * A retry works here for a specific reason: it reaches a FRESH ISOLATE. That is not true of
 * server errors in general, which is why the scope below is narrow and each boundary is tested.
 *
 * The measured user-visible symptom was `member read could not reach the cloud service` at
 * roughly 1 in 12 — this exact function. */

const TARGET = { url: "https://example.supabase.co", anonKey: "anon" } as never;
const WORKSPACE = "00000000-0000-4000-8000-000000000001";

/** A fetcher that replays a fixed script and counts calls. */

const PRINCIPAL = "00000000-0000-4000-8000-000000000002";
const OWNER = "00000000-0000-4000-8000-000000000003";
const RUN = "00000000-0000-4000-8000-000000000004";
function projectionBody(agent: Record<string, unknown> = {}, identity: Record<string, unknown> = {}) {
  return { members: [], agents: [{ principal_id: PRINCIPAL, name: "fixture", ...agent }],
    identity: { credential_valid: true, principal_id: PRINCIPAL, owner_user_id: OWNER,
      workspace_id: WORKSPACE, ...identity } };
}
async function directoryOf(body: unknown) {
  return readAgentSignalDirectory(TARGET, "swm_agt_fixture", WORKSPACE,
    (async () => new Response(JSON.stringify(body))) as typeof fetch);
}
test("read projections: preserve authenticated run, stored model and own safe generation", async () => {
  for (const model of ["synthetic", null]) {
    const d = await directoryOf(projectionBody({ model, generation: 7 }, { run_id: RUN }));
    assert.equal(d.identity?.run_id, RUN);
    assert.equal(d.agents[0]?.model, model);
    assert.equal(d.agents[0]?.generation, 7);
  }
  assert.equal((await directoryOf(projectionBody({ generation: null }))).agents[0]?.generation, null);
});
test("read projections: legacy absence is not stored null or invented run/generation", async () => {
  const d = await directoryOf(projectionBody());
  assert.equal(Object.hasOwn(d.agents[0]!, "model"), false);
  assert.equal(Object.hasOwn(d.agents[0]!, "generation"), false);
  assert.equal(Object.hasOwn(d.identity!, "run_id"), false);
});
test("read projections: reject malformed present model, run and unsafe generations", async () => {
  for (const model of [false, 1, {}, []]) await assert.rejects(directoryOf(projectionBody({ model })));
  for (const run_id of [null, false, 1, "other"]) await assert.rejects(directoryOf(projectionBody({}, { run_id })));
  for (const generation of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, {}, false]) {
    await assert.rejects(directoryOf(projectionBody({ generation })));
  }
});
