import assert from "node:assert/strict";
import { test } from "node:test";
import { atomicDiagnostic, eventDiagnostic, responseDiagnostic, restoreCutoverState, safeRole }
  from "./fixtures/admin-atomic-diagnostics.js";

test("atomic fixture restores the digit-bearing lane8 column with parameterized values and refuses unsafe identifiers", async () => {
  const original = { admin_issuance_enabled: false, lane8_evidence_digest: null, release_generation: "0" };
  const statements = [];
  const client = { query: async (...args) => { statements.push(args); return { command: "UPDATE" }; } };
  assert.equal((await restoreCutoverState(client, original)).command, "UPDATE");
  assert.deepEqual(statements, [["UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=$1,lane8_evidence_digest=$2,release_generation=$3",
    [false, null, "0"]]]);
  for (const name of ["unsafe;SELECT", "column-name", "1column", "name\"", "name space"]) {
    await assert.rejects(restoreCutoverState(client, { [name]: "private-value" }), { code: "ERR_ASSERTION" });
  }
  assert.equal(statements.length, 1, "unsafe names must fail before querying");
});

test("atomic refusal diagnostics retain OAuth response/event causes while removing artifacts and dynamic locations", () => {
  const privateValue = "sensitive-artifact-value";
  const cause = Object.assign(new Error(privateValue), { code: "42501", error_description: privateValue });
  const error = Object.assign(new Error(privateValue), { error: "invalid_scope",
    error_description: "requested scope is not allowed", cause });
  const events = [eventDiagnostic("authorization.error", error), eventDiagnostic("grant.error", cause)];
  assert.deepEqual(events[0].causes, [
    { code: "invalid_scope", error_description: "requested scope is not allowed" },
    { code: "42501", error_description: "[redacted]" },
  ]);
  const providerResponse = responseDiagnostic(400, { error: "invalid_scope",
    error_description: error.error_description, code: privateValue, access_token: privateValue,
    id_token: privateValue, refresh_token: privateValue },
  `https://mcp.commonswarm.com/interaction/${privateValue}?code=${privateValue}#${privateValue}`);
  assert.equal(providerResponse.location, "mcp.commonswarm.com/interaction/[redacted]");
  const httpResponse = responseDiagnostic(503, JSON.stringify({ error: "temporarily_unavailable", request_id: privateValue }), null);
  const trace = { phase: "authorize", failure: "admin_provider_refused", events,
    providerResponse, httpResponse, lastStatementIdentity: { current_user: "commonswarm_oauth_runtime", role: "commonswarm_oauth_runtime" },
    gate: { state: "open", cause: null }, gateInputs: { envValuePresent: "yes", coordinatorPresent: "yes",
      cutoverOpen: "yes", measuredReleasePass: "yes" }, outcome: "refused", cookies: privateValue, sql: privateValue };
  const printed = atomicDiagnostic(trace);
  assert.equal(printed.includes(privateValue), false);
  assert.equal(JSON.parse(printed).provider_response.status, 400);
  assert.equal(JSON.parse(printed).http_response.status, 503);
  assert.equal(JSON.parse(printed).gate.state, "open");
  assert.equal(safeRole(privateValue), "other_role");
  assert.deepEqual(responseDiagnostic(303, null, `https://client.example/callback?error=invalid_scope&error_description=requested+scope+is+not+allowed&code=${privateValue}`),
    { status: 303, error: "invalid_scope", error_description: "requested scope is not allowed", location: "client.example/callback" });
  for (const location of [`https://${privateValue}@client.example/${privateValue}?code=${privateValue}`,
    `https://${privateValue}.example/${privateValue}`]) {
    assert.equal(JSON.stringify(responseDiagnostic(303, { error: privateValue, error_description: privateValue }, location)).includes(privateValue), false);
  }
});
