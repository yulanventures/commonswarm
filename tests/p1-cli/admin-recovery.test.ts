import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { agentToolsForTransport } from "../../src/cli.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { ADMIN_PAGE_MAX, ADMIN_RECOVERY_RESOURCE, adminReadRequest, parseAdminRecoveryPage } from "../../src/cloud/admin-delegations-contract.js";
import { AdminRevokeUncertain, readAdminDelegations, revokeAdminDelegation } from "../../src/cloud/admin-delegations.js";
import { CLI_BUILD_VERSION } from "../../src/cloud/client-build.js";
import { ADMIN_RESOURCE } from "../../src/protocol/admin-policy.js";
import { AdminHarnessAssertion, AdminServerDiagnostics } from "../support/admin-server-diagnostics.js";

const id = randomUUID(), time = "2026-10-01T00:00:00.000Z";
const active = { grant_count: 1, full_account_count: 0, expires_at: time, full_account_expires_at: null };
const grant = { grant_id: id, admin_identity_id: id, connection_id: id, client_id: "<img src=x>\u001b[2J\u202e",
  mode: "granular", scope_names: ["admin:read"], workspace_selector: "selected", workspace_ids: [], withdrawn_workspace_ids: [],
  created_at: time, expires_at: time, state: "expired", reason_code: null };
const page = { grants: [grant], actions: [], next_before: null, active };

test("the deployed read contract is generated from the client contract inside the functions mount", () => {
  const root = new URL("../../", import.meta.url);
  const source = readFileSync(new URL("src/cloud/admin-delegations-contract.ts", root), "utf8");
  const generated = readFileSync(new URL("supabase/functions/read/admin-recovery-contract.ts", root), "utf8");
  assert.equal(generated.split("\n").slice(1).join("\n"), source);
});

test("admin read requests bound pagination and reject account substitution and malformed cursors", () => {
  const good = { resource: "admin_grants", workspace_id: null, limit: 1, before: null };
  assert.deepEqual(adminReadRequest(good), good);
  for (const input of [{ ...good, limit: 0 }, { ...good, limit: ADMIN_PAGE_MAX + 1 }, { ...good, limit: 1.5 },
    { ...good, owner_user_id: id }, { ...good, before: "unbounded" }, { ...good, before: `2026-02-31T00:00:00.000Z|${id}` }, { ...good, workspace_id: "foreign" }]) assert.equal(adminReadRequest(input), null);
  assert.ok(adminReadRequest({ ...good, resource: "admin_history", before: `${time}|${id}` }));
});
test("admin views strip extra private fields, inert terminal controls, and reject unbounded or malformed responses", () => {
  const parsed = parseAdminRecoveryPage({ ...page, projection: { credential: "must not display" }, grants: [{ ...grant, access_hash: "must not display" }] });
  assert.equal(parsed.grants[0]?.client_id, "<img src=x> [2J ");
  assert.ok(!JSON.stringify(parsed).includes("must not display"));
  assert.throws(() => parseAdminRecoveryPage({ ...page, grants: Array(ADMIN_PAGE_MAX + 1).fill(grant) }), /oversized/);
  assert.throws(() => parseAdminRecoveryPage({ ...page, grants: [{ ...grant, state: "connected" }] }), /state/);
  assert.throws(() => parseAdminRecoveryPage({ ...page, next_before: "unexpected" }), /cursor/);
});
test("human admin recovery uses bounded read pages and the existing account revoke command without a workspace", async () => {
  assert.equal(ADMIN_RECOVERY_RESOURCE, ADMIN_RESOURCE);
  const target = cloudTarget("https://api.example.test", "public-test-key");
  const captured: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; captured.push(body);
    return Response.json(body.resource === "admin_history" ? { ...page, grants: [] } : { status: "accepted", events: [] });
  };
  const history = await readAdminDelegations(target, "synthetic-human", { resource: "admin_history", limit: 1 }, fetcher);
  assert.equal(history.grants.length, 0);
  const receipt = await revokeAdminDelegation(target, "synthetic-human", id, id, fetcher);
  assert.equal(receipt.state, "revoked");
  assert.deepEqual(captured[0], { resource: "admin_history", workspace_id: null, limit: 1, before: null });
  assert.deepEqual(captured[1]?.stream, { kind: "account" });
  assert.equal(captured[1]?.client_build, CLI_BUILD_VERSION);
  assert.equal(Object.hasOwn(captured[1]!, "workspace_id"), false);
  assert.deepEqual(captured[1]?.command, { kind: "revoke_admin_delegation", grant_id: id, reason_code: "human_revoked" });
  for (const fetchFailure of [async () => { throw new TypeError("transport"); }, async () => new Response("unreadable", { status: 502 })]) {
    await assert.rejects(revokeAdminDelegation(target, "synthetic-human", id, id, fetchFailure), error => error instanceof AdminRevokeUncertain && error.requestId === id);
  }
});
test("built CLI exposes human recovery help and refuses worker/profile options before credential access", () => {
  const help = spawnSync(process.execPath, ["dist/cli.js", "admin", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /cswarm admin revoke --grant-id/);
  for (const args of [["admin", "grants", "--agent-token-stdin"], ["admin", "history", "--profile", "/does-not-exist"],
    ["admin", "revoke", "--grant-id", "bad"], ["admin", "history", "--limit", "101"]]) {
    const result = spawnSync(process.execPath, ["dist/cli.js", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /unsupported option|does not accept|unknown option|is supported by|full grant ID|integer in/);
  }
  for (const transport of ["http", "stdio"] as const) assert.ok(!agentToolsForTransport(transport).some(tool => tool.name.startsWith("admin")));
});

test("server failure diagnostics retain observed status and summary while excluding credentials and raw errors", () => {
  const diagnostics = new AdminServerDiagnostics();
  const secret = "swm_adm_" + "a".repeat(43);
  diagnostics.count("account_events", 3);
  diagnostics.count("account_events", secret);
  diagnostics.response("admin_grants", 500, { error: "internal_error", status: "refused",
    grants: [grant], actions: [], next_before: `${time}|${id}`, active,
    access_credential: secret, projection: { secret } });
  assert.throws(() => diagnostics.check(false, { stored_count: 3, secret, secret_count: secret }), AdminHarnessAssertion);
  const failure = diagnostics.failure({ code: "42501", message: secret, detail: secret, query: secret });
  const responses = failure.responses as Array<Record<string, unknown>>;
  assert.equal(responses[0]?.status, 500);
  assert.equal(responses[0]?.error_code, "internal_error");
  assert.equal(responses[0]?.grant_page_size, 1);
  assert.equal(responses[0]?.action_page_size, 0);
  assert.deepEqual(responses[0]?.active, active);
  assert.equal(failure.sqlstate, "42501");
  assert.deepEqual(failure.counts, [{ operation: "account_events", value: 3 }, { operation: "account_events", value: null }]);
  assert.deepEqual(failure.assertion, { condition: false, stored_count: 3 });
  assert.ok(!JSON.stringify(failure).includes(secret));
  diagnostics.response("admin_grants", 403, { error: secret, grants: secret, active: { grant_count: secret } });
  assert.ok(!JSON.stringify(diagnostics.failure(null)).includes(secret));
});
