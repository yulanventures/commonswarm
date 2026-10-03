import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { parseAdminRecoveryPage } from "../../src/cloud/admin-delegations-contract.js";
import { readAdminIssuanceGate } from "../../src/cloud/admin-delegations-gate.js";
import { fixture, policy, owner, foreign, at } from "../src/components/app/admin-delegations.fixture.js";
import {
  adminApprovalLines, adminClientAction, adminGateNotice, adminGrantLines, adminRenewalDiff,
  assertAdminPageOwner, ADMIN_SITE_RENEWAL_GUIDANCE,
} from "../src/lib/admin-delegations-view.js";

const grant = fixture.grants[0]!, client = fixture.clients[0]!;
const session = { access_token: "synthetic-human", user: { id: owner } };
/** Exercise the real browser helper and postCommand; only HTTP and build config are replaced. */
async function transport(fetcher: typeof fetch) {
  const bundle = await build({ entryPoints: [new URL("../src/lib/admin-delegations.ts", import.meta.url).pathname],
    bundle: true, write: false, platform: "browser", format: "cjs", define: {
      "import.meta.env": JSON.stringify({ PUBLIC_SUPABASE_URL: "https://api.test.invalid", PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key" }),
    } });
  const context = createContext({ module: { exports: {} }, fetch: fetcher, AbortSignal, AbortController,
    setTimeout, clearTimeout, console, Error, URL, Headers, Request, Response, TextEncoder, TextDecoder, document: { querySelector: () => null } });
  runInContext(bundle.outputFiles[0]!.text, context);
  return context.module.exports as typeof import("../src/lib/admin-delegations.js");
}

test("admin-site-lifecycle normal list includes plain capabilities, approval, deadlines and dependencies", () => {
  assertAdminPageOwner(fixture, owner, null);
  const lines = adminGrantLines(grant, policy, Date.parse(at)).join("\n");
  for (const value of ["Read-only", "Full account", "Refresh deadline", "public-family", "Worker dependencies: 1",
    "Effective coverage: 1", "Account-owner approval", "human-approval", "recipient user ids", "hosted_mcp", "Last retained successful operation"]) {
    assert.ok(lines.includes(value), value);
  }
  assert.equal(adminClientAction(client, owner), "withdraw");
  assert.ok(adminGrantLines({ ...grant, issuance_status: "unknown" }, policy).join("\n").includes("does not establish a usable admin connection"));
  assert.ok(adminGrantLines({ ...grant, expires_at: at }, policy, Date.parse(at)).join("\n").includes("expired"));
  const replaced = adminGrantLines({ ...grant, replaces_grant_id: foreign }, policy).join("\n");
  assert.ok(replaced.includes(`Replaces grant ${foreign}`)); assert.ok(replaced.includes("not revived"));
});

test("admin-site-lifecycle renewal version and capability diff is a read-only comparison", () => {
  const diff = adminRenewalDiff(grant, policy);
  assert.equal(diff.changed, true); assert.equal(diff.priorVersion, 1); assert.equal(diff.currentVersion, 2);
  assert.ok(diff.added.includes("admin_create_workspace")); assert.ok(!diff.added.includes("admin_archive_workspace"));
  assert.deepEqual(diff.removed, []);
  const granular = { ...grant, mode: "granular" as const, registry_version: policy.version,
    availability_digest: policy.digest, capability_names: ["admin_read_metadata"], scope_names: ["admin:read"] };
  assert.equal(adminRenewalDiff(granular, policy).changed, false);
  const changed = adminRenewalDiff({ ...granular, capability_names: ["admin_archive_workspace"], availability_digest: "b".repeat(64) }, policy);
  assert.deepEqual(changed.added, ["admin_read_metadata"]); assert.deepEqual(changed.removed, ["admin_archive_workspace"]);
  assert.equal(ADMIN_SITE_RENEWAL_GUIDANCE, "To renew, reconnect from your assistant; you will be asked to approve again.");
  assert.deepEqual(grant.capability_names, ["admin_read_metadata"]);
});

test("admin-site-lifecycle gate comes only from AS and failed reads never appear open", async () => {
  for (const state of ["closed", "open", "unavailable"] as const) {
    const result = await readAdminIssuanceGate(async (url, options) => {
      assert.equal(String(url), "https://mcp.commonswarm.com/admin/gate");
      assert.equal(options?.method, "GET"); assert.equal(options?.credentials, "omit");
      assert.equal(options?.headers, undefined); assert.equal(options?.cache, "no-store");
      return Response.json({ state });
    });
    assert.equal(result.state, state);
    assert.equal(adminGateNotice(result.state).includes("No admin client can connect yet"), state !== "open");
  }
  for (const response of [Response.json({ state: "open" }, { status: 503 }), Response.json({ state: "open", gate: true }), new Response("private unreadable response")]) {
    assert.equal((await readAdminIssuanceGate(async () => response)).state, "unavailable");
  }
});

test("admin-site-lifecycle foreign projection refusal protects account pages and permits relevant workspace history", async () => {
  const api = await transport(async () => Response.json({ ...fixture, grants: [{ ...grant, owner_user_id: foreign }] }));
  await assert.rejects(api.loadAdminRecovery(session as never, "admin_grants"));
  assert.throws(() => assertAdminPageOwner({ ...fixture, clients: [{ ...client, approval: { ...client.approval!, owner_user_id: foreign } }] }, owner, null));
  assert.throws(() => assertAdminPageOwner({ ...fixture, actions: [{ ...fixture.actions[0]!, owner_user_id: foreign }] }, owner, null));
  const permitted = { ...fixture, grants: [], clients: [], actions: [{ ...fixture.actions[0]!, workspace_id: owner, owner_user_id: null, provider_grant_id: null }] };
  assert.doesNotThrow(() => assertAdminPageOwner(permitted, owner, owner));
  assert.throws(() => assertAdminPageOwner(permitted, owner, null));
  assert.throws(() => assertAdminPageOwner(permitted, owner, foreign));
});

test("admin-site-lifecycle no-secret presentation selects safe nested fields", () => {
  const secret = "PRIVATE_SENTINEL_NOT_FOR_DISPLAY";
  const page = parseAdminRecoveryPage({ ...fixture, access_token: secret, clients: [{ ...client, session_binding: secret }],
    grants: [{ ...grant, refresh_token: secret, jkt: secret, client: { ...client, approval: { ...client.approval!, csrf_binding: secret } },
      family: { ...grant.family, access_token_digest: secret }, target_rules: { ...grant.target_rules, proof_jwt: secret } }] });
  const presentation = [adminGrantLines(page.grants[0]!, policy), adminApprovalLines(page.clients[0]!)];
  assert.ok(!JSON.stringify(presentation).includes(secret));
  assert.ok(JSON.stringify(presentation).includes("Reviewed publisher"));
});

test("admin-site-lifecycle accepted account revoke acknowledges only the committed command", async () => {
  const calls: Record<string, any>[] = [];
  const api = await transport(async (url, options) => {
    assert.equal(String(url), "https://api.test.invalid/functions/v1/command");
    calls.push(JSON.parse(String(options?.body)));
    return Response.json({ status: "accepted", events: [] });
  });
  await api.revokeAdminGrant(session as never, owner, foreign);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0]!.stream, { kind: "account" });
  assert.equal(calls[0]!.resource, "https://api.commonswarm.com/admin");
  assert.equal(calls[0]!.command.kind, "revoke_admin_delegation"); assert.equal(Object.hasOwn(calls[0]!, "workspace_id"), false);
  // Atomic family writes are the server lane's proof; the site trusts only its accepted receipt.
  const refused = await transport(async () => Response.json({ status: "refused", error: "private" }, { status: 403 }));
  await assert.rejects(refused.revokeAdminGrant(session as never, owner, foreign), refused.AdminGrantRevokeRefused);
});

test("admin-site-lifecycle unknown responses preserve and display the retry ID", async () => {
  const ids: string[] = [];
  let reply = Response.json({ error: "internal_error" }, { status: 502 });
  const api = await transport(async (_url, options) => {
    ids.push(JSON.parse(String(options?.body)).command_id); return reply;
  });
  await assert.rejects(api.revokeAdminGrant(session as never, owner, foreign), error => error instanceof Error && error.message.includes(foreign));
  reply = Response.json({ status: "accepted" });
  await api.revokeAdminGrant(session as never, owner, foreign);
  assert.deepEqual(ids, [foreign, foreign]);
  for (const response of [new Response("private invalid JSON"), Response.json({ status: "pending" }), Response.json({ status: "refused" })]) {
    const unreadable = await transport(async () => response);
    await assert.rejects(unreadable.revokeAdminGrant(session as never, owner, foreign), error =>
      error instanceof Error && error.message.includes(foreign) && !error.message.includes("private"));
  }
});

test("admin-site-lifecycle explicit owner approval, withdrawal and metadata reapproval never happen on read", async () => {
  const calls: Record<string, any>[] = [];
  let refused = false;
  const api = await transport(async (url, options) => {
    const body = JSON.parse(String(options?.body));
    if (String(url).endsWith("/read")) return Response.json(fixture);
    calls.push(body);
    return refused ? Response.json({ status: "refused" }, { status: 403 }) : Response.json({ status: "accepted" });
  });
  await api.loadAdminRecovery(session as never, "admin_clients"); assert.equal(calls.length, 0);
  const changed = { ...client, verification_version: 3, reapproval_required: true, approval: null };
  assert.equal(adminClientAction(changed, owner), "approve");
  assert.ok(adminApprovalLines(changed).join("\n").includes("explicit approval"));
  await api.changeAdminClientApproval(session as never, changed, "approve", foreign);
  assert.deepEqual(calls[0]!.command, { kind: "approve_admin_client", client_id: client.client_id, verification_version: 3 });
  await api.changeAdminClientApproval(session as never, client, "withdraw", owner);
  assert.equal(calls[1]!.command.kind, "withdraw_admin_client_approval");
  assert.equal(calls[1]!.command.verification_version, 2);
  await assert.rejects(api.changeAdminClientApproval({ ...session, user: { id: foreign } } as never, client, "withdraw", owner), api.AdminGrantRevokeRefused);
  assert.equal(calls.length, 2);
  refused = true;
  await assert.rejects(api.changeAdminClientApproval(session as never, changed, "approve", foreign), api.AdminGrantRevokeRefused);
  assert.equal(calls.length, 3); // server refusal is retained, never translated into approval
  assert.equal(adminClientAction({ ...client, active: false, approval: null }, owner), null);
});
