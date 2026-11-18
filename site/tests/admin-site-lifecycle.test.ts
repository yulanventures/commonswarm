import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { parseAdminRecoveryPage } from "../../src/cloud/admin-delegations-contract.js";
import { readAdminIssuanceGate } from "../../src/cloud/admin-delegations-gate.js";
import { fixture, policy, owner, foreign, at } from "../src/components/app/admin-delegations.fixture.js";
import {
  adminApprovalLines, adminApprovalParts, adminClientAction, adminGateNotice, adminGrantLines, adminGrantSummary, adminRenewalDiff,
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
  assert.ok(diff.added.includes("Create workspaces")); assert.ok(!diff.added.includes("Archive workspaces"));
  assert.equal(diff.added.filter(label => label === "Create seats").length, 1);
  assert.deepEqual(diff.removed, []);
  const granular = { ...grant, mode: "granular" as const, registry_version: policy.version,
    availability_digest: policy.digest, capability_names: ["admin_read_metadata"], scope_names: ["admin:read"] };
  assert.equal(adminRenewalDiff(granular, policy).changed, false);
  const changed = adminRenewalDiff({ ...granular, capability_names: ["admin_archive_workspace"], availability_digest: "b".repeat(64) }, policy);
  assert.deepEqual(changed.added, ["Read-only"]); assert.deepEqual(changed.removed, ["Archive workspaces"]);
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
  const permitted = { ...fixture, grants: [], clients: [], workers: [], coverage: [], actions: [{ ...fixture.actions[0]!, workspace_id: owner, owner_user_id: null, provider_grant_id: null }] };
  assert.doesNotThrow(() => assertAdminPageOwner(permitted, owner, owner));
  assert.throws(() => assertAdminPageOwner(permitted, owner, null));
  assert.throws(() => assertAdminPageOwner(permitted, owner, foreign));
});

test("admin-site-lifecycle dependencies require an owned parent, including later grant pages", async () => {
  for (const collection of ["workers", "coverage"] as const) {
    const page = { ...fixture, grants: [], clients: [], actions: [], workers: [], coverage: [], [collection]: fixture[collection] };
    assert.doesNotThrow(() => assertAdminPageOwner(page, owner, null, [grant]));
    assert.throws(() => assertAdminPageOwner(page, owner, null, [{ ...grant, owner_user_id: foreign }]));
    assert.throws(() => assertAdminPageOwner(page, owner, null));
    assert.throws(() => assertAdminPageOwner(page, owner, foreign, [grant]));
    const cursor = `${at}|${foreign}`, calls: Record<string, any>[] = [];
    const api = await transport(async (_url, options) => {
      const body = JSON.parse(String(options?.body)); calls.push(body);
      if (body.resource !== "admin_grants") return Response.json(page);
      return Response.json({ ...page, [collection]: [], grants: body.before ? [grant] : [], next_before: body.before ? null : cursor });
    });
    const result = await api.loadAdminRecovery(session as never, collection === "workers" ? "admin_workers" : "admin_coverage", owner);
    assert.equal(result[collection].length, 1);
    assert.equal(calls[0]!.workspace_id, owner);
    assert.ok(calls.slice(1).every(call => call.workspace_id === null));
    assert.deepEqual(calls.map(call => [call.resource, call.before]), [
      [collection === "workers" ? "admin_workers" : "admin_coverage", null], ["admin_grants", null], ["admin_grants", cursor],
    ]);
  }
});

test("admin-site-lifecycle a grant's row carries the decision: state, reach, permissions and the exact local end", () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = Date.parse(at);
  const end = `${new Date(grant.expires_at).toLocaleString()} (${zone})`;
  const selected = { ...grant, mode: "granular" as const, workspace_selector: "selected" as const, workspace_ids: [owner, foreign] };
  const active = adminGrantSummary(selected, policy, new Map([[owner, "Rivera household"]]), now);
  assert.equal(active.past, false);
  assert.equal(active.lines[0], "Active · Selected workspaces");
  // A known workspace is named; an unknown one keeps its id, so rows stay distinguishable.
  assert.ok(active.lines.includes(`Workspaces: Rivera household, ${foreign}`));
  assert.ok(active.lines.some(line => line.startsWith("Can: ") && !line.includes("no capability snapshot")));
  assert.equal(active.lines.at(-1), `Ends ${end}`);
  // Full-account reach and future coverage are said outright.
  const full = adminGrantSummary({ ...grant, mode: "full_account", workspace_selector: "owned_and_selected" }, policy, new Map(), now);
  assert.equal(full.lines[0], "Active · Full account");
  assert.ok(full.lines.some(line => line.startsWith("Existing and future owned workspaces, plus selected shared workspaces: ")));
  // A grant whose issuance is unknown, or whose connection is not active, never reads as plainly usable.
  assert.ok(adminGrantSummary({ ...grant, issuance_status: "unknown" }, policy, new Map(), now).lines.includes("Issuance result unknown. This grant does not establish a usable admin connection."));
  assert.ok(adminGrantSummary({ ...grant, family: { provider_grant_id: "f", state: "suspended" } }, policy, new Map(), now).lines.includes("Its connection is suspended."));
  // Revoked and expired grants are history: marked past, with when and why.
  const revoked = adminGrantSummary({ ...grant, state: "revoked", reason_code: "owner_revoked" }, policy, new Map(), now);
  assert.equal(revoked.past, true);
  assert.equal(revoked.lines[0]!.split(" · ")[0], "Revoked");
  assert.ok(revoked.lines.includes(`It was set to end ${end}`)); assert.equal(revoked.lines.at(-1), "Revoked by the owner");
  // The site's own revoke and withdraw reasons read in plain words; an unknown or missing one says so. The code stays behind More.
  const reason = (reason_code: string | null) => adminGrantSummary({ ...grant, state: "revoked", reason_code }, policy, new Map(), now).lines.at(-1);
  assert.equal(reason("human_revoked"), "Revoked by the owner"); assert.equal(reason("human_withdrawn"), "The owner withdrew this client's approval");
  assert.equal(reason("something_new"), "Reason unavailable"); assert.equal(reason(null), "Reason unavailable");
  assert.ok(adminGrantLines({ ...grant, state: "revoked", reason_code: "something_new" }, policy, now).includes("Reason: something_new."));
  const expired = adminGrantSummary({ ...grant, state: "expired", expires_at: at, refresh_deadline: at }, policy, new Map(), now);
  assert.equal(expired.past, true); assert.equal(expired.lines[0]!.split(" · ")[0], "Expired"); assert.ok(expired.lines.some(line => line.startsWith("Ended ")));
  // This device's clock never takes the action away: a grant the server calls active stays current and says the clock disagrees.
  const clockEnd = `${new Date(at).toLocaleString()} (${zone})`;
  const clock = adminGrantSummary({ ...grant, state: "active", expires_at: at, refresh_deadline: at }, policy, new Map(), now);
  assert.equal(clock.past, false); assert.equal(clock.lines[0]!.split(" · ")[0], "Active");
  assert.ok(clock.lines.includes(`Its end time, ${clockEnd}, has passed on this device`));
  // Access ends at the earlier server deadline, so that is the end time shown.
  const early = "2030-01-02T03:04:00.000Z";
  assert.equal(adminGrantSummary({ ...grant, refresh_deadline: early }, policy, new Map(), now).lines.at(-1), `Ends ${new Date(early).toLocaleString()} (${zone})`);
  assert.equal(adminGrantSummary({ ...grant, refresh_deadline: null }, policy, new Map(), now).lines.at(-1), `Ends ${end}`);
  // A workspace whose access was withdrawn is not counted in the reach; it is named apart.
  const part = adminGrantSummary({ ...selected, withdrawn_workspace_ids: [foreign] }, policy, new Map([[owner, "Rivera household"]]), now);
  assert.ok(part.lines.includes("Workspaces: Rivera household")); assert.ok(part.lines.includes(`Access withdrawn: ${foreign}`));
  // Two grants for the same client are told apart by their connection before the action; a lone grant carries no id.
  assert.ok(adminGrantSummary(grant, policy, new Map(), now, true).lines[1]!.startsWith(`Connection ${grant.connection_id.slice(0, 8)} · granted `));
  assert.ok(!adminGrantSummary(grant, policy, new Map(), now).lines.some(line => line.startsWith("Connection ")));
  // Suspended is not past: it can resume, so it stays in the opening list with its action.
  assert.equal(adminGrantSummary({ ...grant, state: "suspended" }, policy, new Map(), now).past, false);
  // A client's approval: who verified it and whether it is approved up front; ids and events behind More, none lost.
  const parts = adminApprovalParts(client);
  assert.deepEqual([...parts.lines, ...parts.more], adminApprovalLines(client));
  assert.ok(parts.lines[0]!.startsWith("Verified publisher: ")); assert.ok(parts.lines[1]!.startsWith("Account-owner approval: "));
  assert.ok(parts.more.length >= 1 && parts.more.every(line => /^(Approval owner|Withdrawal event) /.test(line)));
  assert.deepEqual(adminApprovalParts({ ...client, approval: null }).more, []);
  // Nothing the full card prints is lost: the detail lines are unchanged.
  assert.ok(adminGrantLines(grant, policy, now).some(line => line.startsWith(`Grant ${grant.grant_id}.`)));
});

/** Minimal DOM for the real component script; no browser launch or rendering mock. */
class ViewElement {
  children: ViewElement[] = [];
  dataset: Record<string, string> = {};
  hidden = false; disabled = false; open = false;
  private content = "";
  private listeners = new Map<string, () => void>();
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.content = value; this.children = []; }
  // The shared agent list builds its rows through the container's own document.
  ownerDocument = { createElement: () => new ViewElement() };
  querySelector(): null { return null; }
  querySelectorAll(): ViewElement[] { return []; }
  append(...children: ViewElement[]): void { this.children.push(...children); }
  replaceChildren(...children: ViewElement[]): void { this.content = ""; this.children = children; }
  setAttribute(): void {}
  addEventListener(event: string, callback: () => void): void { this.listeners.set(event, callback); }
  click(): void { this.listeners.get("click")?.(); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
}

async function componentView(fetcher: typeof fetch) {
  const component = new URL("../src/components/app/AdminDelegations.astro", import.meta.url);
  const script = (await readFile(component, "utf8")).split("<script>")[1]!.split("</script>")[0]!;
  const bundle = await build({ stdin: { contents: script, loader: "ts", resolveDir: new URL(".", component).pathname },
    bundle: true, write: false, format: "iife", platform: "browser", plugins: [{ name: "human-session", setup(builder) {
      builder.onResolve({ filter: /\/commonswarm$/ }, () => ({ path: "session", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export class CommandOutcomeUnknown extends Error {}
        export const deployment = () => ({ url: "https://api.test.invalid", anonKey: "synthetic-public-key" });
        export const currentSession = async () => globalThis.humanSession;
        export const client = () => ({ auth: { onAuthStateChange() {} } });
        export const uuid = () => "unused";
        export const postCommand = () => { throw new Error("Unexpected command"); };
        export const myOrganizations = async () => [];
        export const myWorkspaces = async () => [];
      ` }));
    } }] });
  const elements = new Map<string, ViewElement>();
  const one = (selector: string): ViewElement => {
    if (!elements.has(selector)) elements.set(selector, new ViewElement());
    return elements.get(selector)!;
  };
  const root = Object.assign(new ViewElement(), {
    querySelector: one,
    querySelectorAll: (selectors: string) => selectors === "[data-admin-view]" ? [] : selectors.split(", ").map(one),
  });
  root.dataset.adminPolicy = JSON.stringify(policy);
  const context = createContext({ humanSession: session, fetch: fetcher, Element: ViewElement, AbortSignal, AbortController,
    setTimeout, clearTimeout, console, Error, URL, Headers, Request, Response, TextEncoder, TextDecoder,
    document: { querySelector: (selector: string) => selector === "admin-delegations" ? root : null,
      createElement: () => new ViewElement(), addEventListener() {} },
    window: { addEventListener() {}, setTimeout, setInterval() {} },
  });
  runInContext(bundle.outputFiles[0]!.text, context);
  // Wait for the actual read lifecycle; no delay or timeout is mocked in the loader.
  const settle = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100; ++attempt) {
      if (predicate()) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail("Admin component did not finish its read");
  };
  await settle(() => one("[data-admin-indicator-title]").textContent.length > 0);
  one("[data-admin-indicator]").click();
  // The dialog carries its read state for tools: a finished read says nothing in the status line.
  await settle(() => ["ready", "refused"].includes(one("dialog").dataset.adminState ?? ""));
  return one;
}

test("admin-site-lifecycle agent rows follow the server's state, and a refused read clears them and drops a read still on its way", async () => {
  const agent = "55555555-5555-4555-8555-555555555555";
  let refuse = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const one = await componentView(async (url, options) => {
    if (String(url).endsWith("/admin/gate")) return Response.json({ state: "closed" });
    if (String(url).includes("/rpc/my_seat_admin_grants")) {
      // After the refusal, the agent read is still on its way when the main read is refused.
      if (refuse) await held;
      // The server calls this grant active; its end time is long past on any device clock.
      return Response.json({ grants: [{ grant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", principal_id: agent, level: "workspace", organization_id: null,
        scope_names: ["role:workspace_admin"], workspace_ids: [owner], expires_at: "2020-01-01T00:00:00.000Z", state: "active", created_at: at, ended_at: null }] });
    }
    const body = JSON.parse(String(options?.body));
    if (body.resource === "seat_admin_status") return Response.json({ enabled: true, registry_version: 3,
      agents: [{ principal_id: agent, name: "Atlas", eligible: { workspace: [owner], organization: [] }, active_grant_ids: [] }] });
    return Response.json({ ...fixture, grants: refuse ? [{ ...grant, owner_user_id: foreign }] : [grant], clients: [], workers: [], coverage: [], actions: [] });
  });
  const turn = async (until: () => boolean) => { for (let i = 0; i < 200 && !until(); ++i) await new Promise<void>(resolve => setImmediate(resolve)); };
  const current = one("[data-admin-seat-grants]"), past = one("[data-admin-past-seat-grants]");
  await turn(() => current.children.length > 0 || past.children.length > 0);
  // A fast device clock does not file a server-active grant under Past grants or take its action away.
  assert.equal(current.children.length, 1); assert.equal(past.children.length, 0);
  assert.equal(current.children[0]!.dataset.adminSeatState, "expired", "the row still records what this device computed");
  assert.ok(current.children[0]!.children.some(child => child.textContent === "Remove admin access"));
  assert.ok(current.children[0]!.textContent.includes("has passed on this device"));

  refuse = true;
  one("[data-admin-refresh]").click();
  await turn(() => one("dialog").dataset.adminState === "refused");
  assert.equal(one("dialog").dataset.adminState, "refused");
  assert.equal(current.children.length, 0, "a refused read clears the agent rows too");
  assert.equal(one("[data-admin-seat-section]").hidden, true);
  // The agent read that was already on its way now answers. It must not draw anything.
  release();
  for (let i = 0; i < 50; ++i) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(current.children.length, 0, "a late agent read does not repopulate cleared rows");
  assert.equal(past.children.length, 0);
  // Nothing claims "none" after a refusal.
  assert.equal(one("[data-admin-empty]").hidden, true); assert.equal(one("[data-admin-clients]").children.length, 0);
});

test("admin-site-lifecycle renders owned dependencies and plain renewal labels, then clears foreign rows", async () => {
  for (const collection of ["workers", "coverage"] as const) {
    let foreignRow = false;
    const one = await componentView(async (url, options) => {
      if (String(url).endsWith("/admin/gate")) return Response.json({ state: "closed" });
      const body = JSON.parse(String(options?.body));
      if (body.resource === "seat_admin_status") return Response.json({ enabled: false });
      const page: typeof fixture = { ...fixture, grants: [], clients: [], workers: [], coverage: [], actions: [] };
      if (body.resource === "admin_grants") page.grants = [{ ...grant, capability_names: ["admin_archive_workspace"] }];
      if (body.resource === "admin_workers") page.workers = fixture.workers.map(row => ({ ...row, grant_id: foreignRow && collection === "workers" ? foreign : owner }));
      if (body.resource === "admin_coverage") page.coverage = fixture.coverage.map(row => ({ ...row, grant_id: foreignRow && collection === "coverage" ? foreign : owner }));
      return Response.json(page);
    });
    const dependencies = one("[data-admin-dependencies]");
    assert.ok(dependencies.textContent.includes(`Worker ${owner}`));
    assert.ok(dependencies.textContent.includes(`Workspace ${owner}`));

    foreignRow = true;
    one("[data-admin-refresh]").click();
    for (let attempt = 0; attempt < 100 && !one("[data-admin-status]").textContent.includes("could not be verified"); ++attempt) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(one("[data-admin-status]").textContent.includes("could not be verified"));
    assert.ok(!dependencies.textContent.includes(`Worker ${owner}`));
    assert.ok(!dependencies.textContent.includes(`Workspace ${owner}`));
    assert.ok(!dependencies.textContent.includes(foreign));
  }
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
