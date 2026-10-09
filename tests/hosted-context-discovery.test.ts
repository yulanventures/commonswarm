import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error TS5097: exercise the Deno assembler through tsx.
import { assembleDiscovery, type DiscoveryData } from "../supabase/functions/mcp/discovery.ts";
// @ts-expect-error TS5097: exercise stable errors through tsx.
import { HostedToolFailure, hostedToolError } from "../supabase/functions/mcp/tool-errors.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const grant = "22222222-2222-4222-8222-222222222222";
const home = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
function fixture(): DiscoveryData {
  return {
    grant: { id: grant, owner_user_id: owner, client_id: "registered-app", home_workspace_id: home, active: true },
    subject: owner, provider_active: true,
    owner: { user_id: owner, display_name: "Owner" },
    registered_app: { client_id: "registered-app", display_name: "Registered app", suggested_name: "Claude" },
    workspaces: [],
  };
}
const workspace = (id: string, name: string) => ({ id, name, consented: true, member: true, live: true, permitted: true });

test("zero-state discovery returns only authorized connection data without selecting an identity", () => {
  const data = fixture();
  const snapshot = structuredClone(data);
  assert.deepEqual(assembleDiscovery(data), {
    context_status: "unselected", grant_id: grant,
    owner: { user_id: owner, display_name: "Owner" },
    app: { client_id: "registered-app", display_name: "Registered app" },
    workspaces: [], home_workspace_id: null, suggested_name: "Claude", next_action: "claim_seat",
  });
  assert.deepEqual(data, snapshot, "assembly leaves injected resolver data unchanged");
});

test("discovery filters each current workspace fence and exposes only usable home and public names", () => {
  const data = fixture();
  data.workspaces = [workspace(home, "Home"), workspace(other, "Other")];
  const expected = [{ id: home, name: "Home" }, { id: other, name: "Other" }];
  assert.deepEqual(assembleDiscovery(data).workspaces, expected, "authorized positive control");
  for (const fence of ["consented", "member", "live", "permitted"] as const) {
    data.workspaces = [{ ...workspace(home, "Home"), [fence]: false }, workspace(other, "Other")];
    const result = assembleDiscovery(data);
    assert.deepEqual(result.workspaces, [expected[1]], fence);
    assert.equal(result.home_workspace_id, null, fence);
  }
  data.workspaces = [workspace(home, "Home")];
  assert.equal(assembleDiscovery(data).home_workspace_id, home);
  data.grant.home_workspace_id = other;
  assert.equal(assembleDiscovery(data).home_workspace_id, null, "never choose another home silently");
});

test("discovery labels require registered app metadata and the existing Unicode name validator", () => {
  const data = fixture();
  assert.equal(assembleDiscovery(data).suggested_name, "Claude", "reliable mapping control");
  for (const suggested_name of [null, "", " bad", "bad ", "bad\u0000", "😀".repeat(81)]) {
    data.registered_app = { client_id: "registered-app", display_name: "App", suggested_name };
    assert.equal(assembleDiscovery(data).suggested_name, "Agent");
  }
  data.registered_app = { client_id: "registered-app", display_name: "App", suggested_name: "😀".repeat(80) };
  assert.equal(assembleDiscovery(data).suggested_name, "😀".repeat(80));
  data.registered_app = null;
  // Client-supplied brand assertions and private resolver fields must not escape.
  const untrusted = { ...data, clientInfo: { name: "Claude" }, seat: "private-seat", members: [owner] };
  const result = assembleDiscovery(untrusted);
  assert.deepEqual(result.app, { client_id: "registered-app", display_name: "Agent" });
  assert.equal(result.suggested_name, "Agent");
  assert.equal("seat" in result, false);
  assert.equal("members" in result, false);
  assert.equal("clientInfo" in result, false);
});

test("discovery refuses invalid grant, owner, provider and exact registered-app bindings without disclosure", () => {
  assert.equal(assembleDiscovery(fixture()).grant_id, grant, "valid binding control");
  const cases = [
    { ...fixture(), grant: { ...fixture().grant, active: false } },
    { ...fixture(), provider_active: false },
    { ...fixture(), subject: other },
    { ...fixture(), owner: { user_id: other, display_name: "Foreign" } },
    { ...fixture(), registered_app: { client_id: "REGISTERED-app", display_name: "App", suggested_name: "Claude" } },
  ];
  for (const data of cases) {
    assert.throws(() => assembleDiscovery(data), (error: unknown) => {
      assert.ok(error instanceof HostedToolFailure);
      assert.deepEqual(hostedToolError(error, "whoami"), {
        error: "identity_resume_unavailable",
        message: "This connection cannot resume that identity. Reconnect and approve workspace access.",
        can_start_new: false,
      });
      return true;
    });
  }
});
