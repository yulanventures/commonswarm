/**
 * Channel delivery sender condition (security review, 2026-11-10), against the local database: a queued delivery
 * whose sender is no longer admitted to the signal's workspace is terminalized as failed_terminal / sender_not_live
 * on claim and on hydration (which fresh claims, replays and H0 polls share), and never reaches the agent. The
 * signal stays. Credentials are never consulted. A channel listener re-takes its own outstanding lease.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import {
  claimAgentInbox,
  claimAgentInboxPersistsLedger,
  hydrateDeliveryRefs,
  type DeliveryClaimLedgerResponse,
} from "../../supabase/functions/command/durable-delivery.js";

let sql: postgres.Sql;
let admin: SupabaseClient;

before(() => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, string>;
  sql = postgres(status.DB_URL!, { max: 2, onnotice: () => {} });
  admin = createClient(status.API_URL!, status.SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
});
after(async () => { await sql.end(); });

async function user(label: string): Promise<string> {
  const created = await admin.auth.admin.createUser({ email: `synth-delivery-${randomUUID()}@example.test`, password: `T-${randomBytes(18).toString("base64url")}!`, email_confirm: true });
  assert.ifError(created.error);
  const id = created.data.user!.id;
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${id}::uuid, ${label})`;
  return id;
}
async function workspace(ownerId: string): Promise<string> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${id}::uuid, 'Sender live', ${ownerId}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${id}::uuid, ${ownerId}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${id}::uuid, 'workspace')`;
  });
  return id;
}
const join = (ws: string, userId: string) => sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${userId}::uuid, 'member')`;
async function agent(ws: string, ownerId: string, name: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name) VALUES (${id}::uuid, ${ws}::uuid, ${ownerId}::uuid, ${name})`;
  return id;
}
/** A signal addressed to `to`; the recipient and fan-out triggers create its delivery row. */
async function send(ws: string, from: string, fromKind: "user" | "agent", to: string, body: string): Promise<string> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, to_agent_principal_id, until)
      VALUES (${id}::uuid, ${ws}::uuid, ${from}::uuid, ${fromKind}, 'note', ${body}, ${to}::uuid, statement_timestamp() + interval '1 hour')`;
    await tx`INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_agent_principal_id, position)
      VALUES (${id}::uuid, ${ws}::uuid, ${to}::uuid, 0)`;
  });
  return id;
}
type Recipient = { ws: string; principal: string; owner: string };
const claim = (r: Recipient, listener = randomUUID(), reclaimOwnLeases = false) => sql.begin(async (tx) =>
  (await claimAgentInbox(tx as never, { workspaceId: r.ws, recipientPrincipalId: r.principal, receiverOwnerUserId: r.owner, listenerInstanceId: listener, limit: 10, reclaimOwnLeases }))!) as Promise<DeliveryClaimLedgerResponse>;
const hydrate = (r: Recipient, ledger: DeliveryClaimLedgerResponse) => sql.begin(async (tx) =>
  await hydrateDeliveryRefs(tx as never, { workspaceId: r.ws, recipientPrincipalId: r.principal, recipientOwnerUserId: r.owner, refs: ledger.delivery_refs }));
async function delivery(r: Recipient, signalId: string) {
  const [row] = await sql<{ acked_at: Date | null; ack_outcome: string | null; last_error_code: string | null; delivered_at: Date | null; lease_id: string | null; last_lease_id: string | null; attempt_count: number }[]>`
    SELECT acked_at, ack_outcome, last_error_code, delivered_at, lease_id, last_lease_id, attempt_count
    FROM swarm.signal_deliveries WHERE signal_id = ${signalId}::uuid AND recipient_agent_principal_id = ${r.principal}::uuid`;
  return row!;
}
const signalKept = async (id: string) => (await sql`SELECT 1 FROM swarm.signals WHERE id = ${id}::uuid`).length === 1;

async function recipient(): Promise<Recipient> {
  const owner = await user("Receiver owner");
  const ws = await workspace(owner);
  return { ws, owner, principal: await agent(ws, owner, "Receiver") };
}

test("a person removed before the claim: the delivery ends as sender_not_live, never delivered, and the signal stays", async () => {
  const r = await recipient();
  const person = await user("Leaving member");
  await join(r.ws, person);
  const signal = await send(r.ws, person, "user", r.principal, "queued before removal");
  await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${r.ws}::uuid AND user_id = ${person}::uuid`;
  const ledger = await claim(r);
  assert.deepEqual(ledger.delivery_refs, []);
  assert.equal(ledger.sender_not_live_count, 1);
  assert.equal(ledger.terminal_delivery_failure_count, 0, "not the attempts-exhausted alert");
  assert.equal(claimAgentInboxPersistsLedger(ledger), true, "a claim that terminalized a row is replayed, not re-run");
  const row = await delivery(r, signal);
  assert.equal(row.ack_outcome, "failed_terminal");
  assert.equal(row.last_error_code, "sender_not_live");
  assert.equal(row.delivered_at, null, "message status must not report it delivered");
  assert.equal(row.lease_id, null);
  assert.equal(await signalKept(signal), true);
  // A later claim neither retries it nor blocks the next message.
  const next = await send(r.ws, r.owner, "user", r.principal, "from the owner");
  assert.deepEqual((await claim(r)).delivery_refs.map((ref) => ref.signal_id), [next]);
});

test("an agent sender is not live when its principal, its workspace membership, or its owner's membership is revoked", async () => {
  for (const removal of ["principal", "seat", "owner"] as const) {
    const r = await recipient();
    const otherOwner = await user(`Agent owner ${removal}`);
    await join(r.ws, otherOwner);
    const sender = await agent(r.ws, otherOwner, `Sender ${removal}`);
    const signal = await send(r.ws, sender, "agent", r.principal, `before ${removal} removal`);
    if (removal === "principal") await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${sender}::uuid`;
    if (removal === "seat") await sql`UPDATE swarm.agent_workspace_memberships SET revoked_at = statement_timestamp() WHERE principal_id = ${sender}::uuid AND workspace_id = ${r.ws}::uuid`;
    if (removal === "owner") await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${r.ws}::uuid AND user_id = ${otherOwner}::uuid`;
    const ledger = await claim(r);
    assert.deepEqual(ledger.delivery_refs, [], removal);
    const row = await delivery(r, signal);
    assert.equal(row.last_error_code, "sender_not_live", removal);
    assert.equal(await signalKept(signal), true, removal);
  }
});

test("an agent admitted to this workspace from another one is live, labelled by its owner, and needs no live credential", async () => {
  const r = await recipient();
  const home = await workspace(r.owner);
  const sender = await agent(home, r.owner, "Visiting agent");
  await sql`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${sender}::uuid, ${r.ws}::uuid, ${r.owner}::uuid, ${r.owner}::uuid)`;
  // The sender holds no agent token at all: rotation or expiry is never removal.
  const signal = await send(r.ws, sender, "agent", r.principal, "from my other workspace");
  const ledger = await claim(r);
  assert.deepEqual(ledger.delivery_refs.map((ref) => [ref.signal_id, ref.sender_owner_relation]), [[signal, "same_owner"]]);
  const hydrated = await hydrate(r, ledger);
  assert.equal(hydrated?.[0]?.signal.body, "from my other workspace");
});

test("a sender removed after the lease: hydration (claim, replay and H0) omits it and terminalizes the row", async () => {
  const r = await recipient();
  const person = await user("Leaving after lease");
  await join(r.ws, person);
  const gone = await send(r.ws, person, "user", r.principal, "leased, then removed");
  const kept = await send(r.ws, r.owner, "user", r.principal, "still here");
  const ledger = await claim(r);
  assert.equal(ledger.delivery_refs.length, 2);
  await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${r.ws}::uuid AND user_id = ${person}::uuid`;
  const hydrated = await hydrate(r, ledger);
  assert.deepEqual(hydrated?.map((d) => d.signal.id), [kept], "the rest of the batch still hydrates");
  const row = await delivery(r, gone);
  assert.equal(row.last_error_code, "sender_not_live");
  assert.equal(row.lease_id, null);
  assert.notEqual(row.last_lease_id, null, "the lease it held is recorded");
  assert.equal(await signalKept(gone), true);
});

test("a cancelled delivery stays cancelled on replay after the sender is re-added", async () => {
  const r = await recipient();
  const person = await user("Removed then re-added");
  await join(r.ws, person);
  const gone = await send(r.ws, person, "user", r.principal, "cancelled before replay");
  const kept = await send(r.ws, r.owner, "user", r.principal, "replays normally");
  const ledger = await claim(r);
  assert.equal(ledger.delivery_refs.length, 2);
  await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${r.ws}::uuid AND user_id = ${person}::uuid`;
  assert.deepEqual((await hydrate(r, ledger))?.map((d) => d.signal.id), [kept]);
  const ended = await delivery(r, gone);
  assert.equal(ended.last_error_code, "sender_not_live");
  await sql`UPDATE swarm.memberships SET revoked_at = NULL WHERE workspace_id = ${r.ws}::uuid AND user_id = ${person}::uuid`;
  // Replaying the same stored refs: the re-added sender's cancelled message never comes back; the other still does.
  assert.deepEqual((await hydrate(r, ledger))?.map((d) => d.signal.id), [kept]);
  assert.deepEqual(await delivery(r, gone), ended, "the terminal row is unchanged");
  assert.deepEqual((await claim(r)).delivery_refs.map((ref) => ref.signal_id), [], "and no fresh claim resumes it");
});

test("a channel listener re-takes its own outstanding lease without a new attempt; other routes do not", async () => {
  const r = await recipient();
  const signal = await send(r.ws, r.owner, "user", r.principal, "re-check after restart");
  const listener = randomUUID();
  const first = await claim(r, listener, true);
  assert.deepEqual(first.delivery_refs.map((ref) => ref.signal_id), [signal]);
  assert.equal((await delivery(r, signal)).attempt_count, 1);
  assert.deepEqual((await claim(r, listener, false)).delivery_refs, [], "a listener route never sees a row it holds");
  assert.deepEqual((await claim(r, randomUUID(), true)).delivery_refs, [], "another listener cannot take it");
  const again = await claim(r, listener, true);
  assert.deepEqual(again.delivery_refs.map((ref) => ref.signal_id), [signal]);
  assert.notEqual(again.delivery_refs[0]!.lease_id, first.delivery_refs[0]!.lease_id);
  assert.equal((await delivery(r, signal)).attempt_count, 1, "the same attempt");
});
