/**
 * Heavy simulated workspace for the mobile audit (CS-MOBILE-AUDIT-20261103). LOCAL STACK ONLY:
 * it refuses any API or database URL that is not loopback. It never touches production.
 *
 * Real commands build what has a command (workspace, invitations, roles, agents, lead, Lists &
 * docs, definitions, to-dos), so the data obeys the same invariants as production. SQL is used
 * only where there is no command and volume or time matters: group chats and 200+ backdated
 * messages, DMs and threads. Every step records a note instead of aborting, so a partial seed
 * still produces an audit.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { auditPng } from "./picture-check.js";
import * as core from "../../supabase/functions/_shared/protocol.js";
import { applyAdminRoutine, prepareAdminRoutine } from "../../supabase/functions/command/admin-routine.js";

export interface SeedEnvironment { apiUrl: string; anonKey: string; serviceRoleKey: string; dbUrl: string }
export interface SeedResult {
  owner: { email: string; password: string };
  /** A second viewer, a member of {workspace} holding one delegated invitation to {inviteWorkspace}. */
  invitee: { email: string; password: string } | null;
  ids: Record<string, string>;
  notes: string[];
  steps: string[];
}

const LOCAL_SEAT = "seat_0000000000000000000000";
const loopback = (value: string) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);

const PEOPLE = [
  "Dana Rivera",
  "Kenji Ito",
  "Priya Ramanathan-Whitfield",
  "Sam O'Connor",
  "Alexandria Montgomery-Featherstonehaugh",
];
const AGENTS = [
  "Orbit", "River", "Lumen", "Atlas Research & Long-Running Investigations Agent",
  "Muse", "Grok-Overnight-Batch-Summarizer-Extremely-Long-Name-v2", "Pixel", "Ledger",
  "Scout", "Harbor (household logistics)", "Quill", "Relay-0x7f3a9c2e5b1d8f4a6c0e2b9d7f1a3c5e",
];
const LONG_URL = "https://example.test/really/long/path/" + "segment-".repeat(18) + "end?query=" + "x".repeat(60);
const UNBROKEN = "sk_test_" + "A1b2C3d4E5f6G7h8".repeat(8);
const BODIES = [
  "Picked up the grocery list; I'll check the pantry before ordering.",
  "Can someone verify the narrow-screen agent rail before we ship?",
  "The signup copy is ready for the dashboard handoff.",
  "Refining the workspace-first dashboard states.",
  `Build log is here: ${LONG_URL}`,
  `Rotated the test key ${UNBROKEN} — this is a fake value for layout testing.`,
  "Short.",
  "Monthly spend so far: $1,284.17 across 23 card transactions. Groceries are 41% of it, dining out 18%, and utilities 12%. I flagged two duplicate charges for review.",
  "Working on the school pickup schedule for next week. Tuesday and Thursday are covered; Wednesday still needs someone.",
  "Done — the dentist appointment moved to 3:30pm on the 14th.",
  "Can you look at the boiler service quote? It's attached in Files.",
  "Heads up: the plumber is coming between 8 and 10am tomorrow.",
];

/**
 * A real refresh for a witness: a note in #general, already seen by the viewer (so its receipt never changes), that the
 * app's own polling shows, rebuilding the feed. It lives long enough for any poll interval; the returned function
 * removes it at once, so no later page ever opens with it showing.
 */
export async function postRefreshNote(env: SeedEnvironment, ids: Record<string, string>): Promise<() => Promise<void>> {
  assert.ok(loopback(env.dbUrl), "local stack only");
  const sql = postgres(env.dbUrl, { prepare: false, max: 1 });
  const id = randomUUID();
  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at, channel_id, broadcast_to_channel)
        VALUES (${id}::uuid, ${ids.workspace!}::uuid, ${ids.agent!}::uuid, 'agent', 'note', 'Audit refresh note.',
          statement_timestamp() + interval '120 seconds', statement_timestamp(), ${ids["channel.general"]!}::uuid, false)`;
      await tx`INSERT INTO swarm.signal_human_receipts (workspace_id, signal_id, user_id)
        SELECT ${ids.workspace!}::uuid, ${id}::uuid, m.user_id FROM swarm.memberships m
        WHERE m.workspace_id = ${ids.workspace!}::uuid AND m.role = 'owner' AND m.revoked_at IS NULL ON CONFLICT DO NOTHING`;
    });
  } finally { await sql.end({ timeout: 5 }); }
  return async () => {
    // Signals are append-only (prevent_append_only_mutation), so the CI-only note is removed with triggers bypassed for
    // this one transaction on the local test stack: its receipt rows, then the note itself.
    const done = postgres(env.dbUrl, { prepare: false, max: 1 });
    try {
      await done.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`DELETE FROM swarm.signal_human_receipts WHERE signal_id = ${id}::uuid`;
        const removed = await tx`DELETE FROM swarm.signals WHERE id = ${id}::uuid`;
        if (removed.count !== 1) throw new Error(`refresh note ${id} was not removed`);
      });
    } finally { await done.end({ timeout: 5 }); }
  };
}

/** The save-conflict doc's two fixed texts: every capture opens it at the base and meets the current one, so the comparison is
 *  the same at every size and theme. */
export const CONFLICT_DOC = {
  base: "# Boiler visit\n\nThe engineer comes on Friday morning. Keep the hallway clear and leave the meter cupboard open.",
  current: "# Boiler visit\n\nThe engineer comes on Friday at 9am. Keep the hallway clear and leave the meter cupboard open.",
} as const;

/**
 * Save a doc's content as the owner from outside any page (app.list-conflict): back to the base before a capture opens it,
 * then to the current text behind the open page's back, so the page's next save meets a newer revision. Nothing is saved when
 * the doc already holds that text. It signs in afresh on every call: a token from seeding has expired by the time a late
 * capture runs.
 */
export async function setHouseholdDoc(env: SeedEnvironment, owner: SeedResult["owner"], workspaceId: string, objectId: string, markdown: string): Promise<void> {
  assert.ok(loopback(env.apiUrl), "local stack only");
  const client = createClient(env.apiUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword(owner);
  if (signedIn.error || !signedIn.data.session) throw new Error(`doc sign-in: ${signedIn.error?.message}`);
  const token = signedIn.data.session.access_token;
  const tool = async (name: string, args: Record<string, unknown>, write: boolean) => {
    const commandId = `audit_${randomBytes(9).toString("base64url")}`;
    const response = await fetch(`${env.apiUrl}/functions/v1/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, apikey: env.anonKey, "content-type": "application/json" },
      body: JSON.stringify({ command_id: commandId, client_version: "0.1.0", workspace_id: workspaceId, stream: { kind: "workspace" },
        command: { kind: "household_tool", tool: name, arguments: { seat: LOCAL_SEAT, ...(write ? { request_id: commandId } : {}), ...args } } }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const read = await tool("object_read", { object_id: objectId }, false);
  const before = read.body.content?.markdown, base = read.body.revision?.revision;
  if (read.status !== 200 || read.body.status !== "ok" || typeof before !== "string" || !base) {
    throw new Error(`doc read: HTTP ${read.status} ${JSON.stringify(read.body).slice(0, 200)}`);
  }
  if (before === markdown) return;
  const saved = await tool("object_update", { object_id: objectId, base, patch: { kind: "doc", splices: [{ start: 0, before, after: markdown }] } }, true);
  if (saved.status !== 200 || saved.body.status !== "committed") throw new Error(`doc save: HTTP ${saved.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
}

/**
 * One delegated member invitation from `inviter` (owner of `workspaceId`) to `recipient`, made as the Deno fixture
 * tests/support/household-human-invites-server.mjs makes it: the protocol core decides the inviter's admin consent and grant,
 * and the real routine decision and adapter issue the invitation, so its preview passes like a real one.
 */
async function issueDelegatedInvitation(sql: postgres.Sql, inviter: string, workspaceId: string, recipient: string): Promise<void> {
  const c = core as any;
  const now = Date.now() - 60_000, session = "audit-inviter-session", grantId = randomUUID(), receipt = randomUUID();
  let state = c.emptyAdminAccount(), accountSeq = 0;
  const manifest = { admin_identity_id: randomUUID(), connection_id: randomUUID(), client_id: "https://audit-client.example.test", resource: c.ADMIN_RESOURCE,
    mode: "granular", registry_version: c.ADMIN_REGISTRY_VERSION, scope_names: ["admin:read", "invites:create"],
    capability_names: c.adminAvailableCapabilities(["admin:read", "invites:create"]), availability_digest: c.adminAvailabilityDigest(c.ADMIN_REGISTRY_VERSION),
    workspace_selector: "selected", workspace_ids: [workspaceId], created_workspace_policy: { scope_names: [] },
    target_rules: { seat_ids: [], own_seats: false, grant_created_seats: false, recipient_user_ids: [recipient], recipient_connection_ids: [], transports: [] },
    worker_scope_ceiling: [], role_ceiling: "member", renewal_limits: { ...c.ADMIN_RENEWAL_CEILINGS, grant_kinds: [], principal_ids: [] },
    issuance_limits: { ...c.ADMIN_ISSUANCE_CEILINGS }, expires_at: now + 86_400_000, refresh_deadline: now + 86_400_000 };
  const digest = createHash("sha256").update(c.canonicalAdminJson(manifest)).digest("hex");
  const ctx = { now, owner_user_id: inviter, actor: { kind: "human", user_id: inviter, session_binding: session }, command_id: randomUUID(), stream_id: randomUUID(),
    request_digest: "a".repeat(64), nextSeq: () => ++accountSeq, nextEventId: randomUUID, current_workspace_rights: true, withdrawing_workspace_owner: false,
    target_workspace_owned_by_grantor: false, presenting_refresh_generation: null, presenting_refresh_lineage_id: null };
  const runCore = (command: unknown) => {
    ctx.command_id = randomUUID();
    const decision = c.decideAdminAuthority(command, state, ctx);
    if (!decision.ok) throw new Error(`admin authority refused: ${JSON.stringify(decision).slice(0, 200)}`);
    state = decision.events.reduce(c.reduceAdminAuthority, state);
    for (const consent of Object.values(state.consents) as { session_binding: string }[]) consent.session_binding = session;
    return decision.events as { seq: number; event_id: string; command_id: string }[];
  };
  const granted = [...runCore({ kind: "prepare_admin_consent", consent: { consent_receipt_id: receipt, owner_user_id: inviter, session_binding: session, manifest,
    manifest_digest: digest, full_account_selected: false, expires_at: now + 300_000, consumed_at: null } }),
    ...runCore({ kind: "grant_admin_delegation", grant_id: grantId, consent_receipt_id: receipt, replaces_grant_id: null })];
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.admin_accounts (owner_user_id, stream_id, seq, projection) VALUES (${inviter}::uuid, ${ctx.stream_id}::uuid, ${accountSeq}, ${tx.json(state)})`;
    for (const e of granted) await tx`INSERT INTO swarm.admin_events (owner_user_id, seq, event_id, command_id, event) VALUES (${inviter}::uuid, ${e.seq}, ${e.event_id}::uuid, ${e.command_id}, ${tx.json(e as any)})`;
    const g = state.grants[grantId];
    await tx`INSERT INTO swarm.admin_grants (grant_id, owner_user_id, admin_identity_id, connection_id, client_id, resource, mode, registry_version, scope_names, workspace_selector,
        workspace_ids, created_workspace_policy, target_rules, worker_scope_ceiling, role_ceiling, renewal_limits, issuance_limits, expires_at, refresh_deadline, state,
        consent_receipt_id, manifest_digest, created_at)
      VALUES (${grantId}::uuid, ${inviter}::uuid, ${g.admin_identity_id}::uuid, ${g.connection_id}::uuid, ${g.client_id}, ${g.resource}, ${g.mode}, ${g.registry_version},
        ${g.scope_names}, ${g.workspace_selector}, ${g.workspace_ids}::uuid[], ${tx.json(g.created_workspace_policy)}, ${tx.json(g.target_rules)}, ${g.worker_scope_ceiling},
        ${g.role_ceiling}, ${tx.json(g.renewal_limits)}, ${tx.json(g.issuance_limits)}, ${new Date(g.expires_at)}, ${new Date(g.refresh_deadline)}, 'active', ${receipt}::uuid,
        ${g.manifest_digest}, ${new Date(g.created_at)})`;
  });
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE swarm_command`;
    const [account] = await tx<{ projection: any; seq: number | string }[]>`SELECT projection, seq FROM swarm.admin_accounts WHERE owner_user_id = ${inviter}::uuid FOR UPDATE`;
    let seq = Number(account!.seq);
    const routineCtx = { ...ctx, command_id: randomUUID(), actor: { kind: "delegated_admin", grant_id: grantId, admin_identity_id: manifest.admin_identity_id,
      connection_id: manifest.connection_id, resource: c.ADMIN_RESOURCE, scope_names: manifest.scope_names, access_expires_at: Date.now() + 300_000 }, nextSeq: () => ++seq };
    const invite = { kind: "admin_invite_member", grant_id: grantId, workspace_id: workspaceId, recipient_user_id: recipient, role: "member", ttl_seconds: 86_400 };
    const facts = await prepareAdminRoutine(tx as any, invite as any, account!.projection, routineCtx as any, null);
    const decision = c.decideAdminRoutine(invite, account!.projection, facts);
    if (!decision.ok) throw new Error(`admin routine refused: ${JSON.stringify(decision).slice(0, 200)}`);
    await applyAdminRoutine(tx as any, invite as any, facts, decision);
    const next = decision.events.reduce(c.reduceAdminAuthority, account!.projection);
    for (const e of decision.events) await tx`INSERT INTO swarm.admin_events (owner_user_id, seq, event_id, command_id, event) VALUES (${inviter}::uuid, ${e.seq}, ${e.event_id}::uuid, ${e.command_id}, ${tx.json(e)})`;
    await tx`UPDATE swarm.admin_accounts SET seq = ${seq}, projection = ${tx.json(next)} WHERE owner_user_id = ${inviter}::uuid`;
  });
}

export async function seedHeavyWorkspace(env: SeedEnvironment): Promise<SeedResult> {
  for (const url of [env.apiUrl, env.dbUrl]) assert.ok(loopback(url), `seed refuses non-local target ${new URL(url).hostname}`);
  const notes: string[] = [];
  /** Seed steps that were positively accepted; a manifest entry's requiresSeed names these. */
  const steps: string[] = [];
  const ids: Record<string, string> = {};
  const note = (step: string, detail: unknown) => { notes.push(`${step}: ${String(detail).slice(0, 400)}`); };
  const sql = postgres(env.dbUrl, { prepare: false, max: 4 });
  const admin = createClient(env.apiUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    // People: confirmed GoTrue users with passwords (local fixtures only) and swarm.users rows.
    const people: { id: string; name: string; email: string; password: string; token: string }[] = [];
    for (const [index, name] of PEOPLE.entries()) {
      const email = `audit-${index}-${randomUUID().slice(0, 8)}@example.test`;
      const password = `Audit-${randomBytes(18).toString("base64url")}!`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data.user) throw new Error(`createUser ${index}: ${created.error?.message}`);
      const id = created.data.user.id;
      await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${id}::uuid, ${name})
        ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name`;
      const client = createClient(env.apiUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const signedIn = await client.auth.signInWithPassword({ email, password });
      if (signedIn.error || !signedIn.data.session) throw new Error(`sign-in ${index}: ${signedIn.error?.message}`);
      people.push({ id, name, email, password, token: signedIn.data.session.access_token });
    }
    const [owner, adminPerson] = people as [typeof people[number], typeof people[number]];
    // The signed-in viewer's own person row (#pd-person-{owner}), for the own-role lowering confirmation.
    ids.owner = owner.id;
    ids.person = people[2]!.id;
    ids["person.long"] = people[4]!.id;

    const command = async (token: string, body: Record<string, unknown>, workspaceId: string | null, commandId = `audit_${randomBytes(9).toString("base64url")}`) => {
      const response = await fetch(`${env.apiUrl}/functions/v1/command`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, apikey: env.anonKey, "content-type": "application/json" },
        body: JSON.stringify({ command_id: commandId, client_version: "0.1.0",
          ...(workspaceId ? { workspace_id: workspaceId, stream: { kind: "workspace" } } : {}), command: body }),
      });
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
      return { status: response.status, body: parsed, commandId };
    };
    const ok = (step: string, result: { status: number; body: Record<string, unknown> }) => {
      const accepted = result.status === 200 && ["accepted", "committed", "ok"].includes(String(result.body.status));
      if (!accepted) note(step, `HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
      else steps.push(step);
      return accepted;
    };

    // Workspaces: one dense, one empty (in the same org so existing-agent onboarding lists the owner's agents).
    const workspace = randomUUID();
    const emptyWorkspace = randomUUID();
    ok("create_workspace", await command(owner.token, { kind: "create_workspace", workspace_id: workspace, name: "Rivera household & studio — shared with everyone, including the agents" }, null));
    ok("create_workspace empty", await command(owner.token, { kind: "create_workspace", workspace_id: emptyWorkspace, name: "Empty", org_id: workspace }, null));
    ids.workspace = workspace;
    ids.emptyWorkspace = emptyWorkspace;

    // Members: invite and accept as each person; one admin; one invitation left pending.
    for (const person of people.slice(1)) {
      const invited = await command(owner.token, { kind: "invite_member", email: person.email, ttl_ms: 7 * 24 * 3_600_000 }, workspace);
      const token = String(invited.body.invitation_token ?? "");
      if (!ok(`invite ${person.name}`, invited) || !token) continue;
      ok(`accept ${person.name}`, await command(person.token, { kind: "accept_invitation", token }, null));
    }
    ok("pending invite", await command(owner.token, { kind: "invite_member", email: "pending.invitee.with.a.long.address@example.test", ttl_ms: 7 * 24 * 3_600_000 }, workspace));
    ok("change_role admin", await command(owner.token, { kind: "change_role", user_id: adminPerson.id, role: "admin" }, workspace));

    // Agents: twelve, mostly the owner's, two the admin's.
    for (const [index, name] of AGENTS.entries()) {
      const by = index >= 10 ? adminPerson : owner;
      ok(`create_agent_principal ${name}`, await command(by.token, { kind: "create_agent_principal", name, model: "claude-opus-5-5" }, workspace));
    }
    const agentRows = await sql<{ principal_id: string; name: string }[]>`
      SELECT principal_id, name FROM swarm.agent_principals WHERE workspace_id = ${workspace}::uuid ORDER BY name`;
    const agents = agentRows.map(row => row.principal_id);
    if (agents.length) {
      ids.agent = agentRows.find(row => row.name.startsWith("Atlas"))?.principal_id ?? agents[0]!;
      ids["agent.long"] = agentRows.find(row => row.name.startsWith("Relay"))?.principal_id ?? agents[0]!;
      ok("set_workspace_lead", await command(owner.token, { kind: "set_workspace_lead", principal_id: agents[0] }, workspace));
    } else note("agents", "no agent principals were created");

    // Group chats (no channel-create command in this path): SQL rows, as the p1-local chat tests do.
    const channels = { general: randomUUID(), group: randomUUID(), long: randomUUID() };
    try {
      await sql`INSERT INTO swarm.channels (channel_id, workspace_id, slug, purpose, created_by_principal, created_by_kind) VALUES
        (${channels.general}::uuid, ${workspace}::uuid, 'household', 'Everything for the household', ${owner.id}::uuid, 'user'),
        (${channels.group}::uuid, ${workspace}::uuid, 'design-studio', 'Studio work', ${owner.id}::uuid, 'user'),
        (${channels.long}::uuid, ${workspace}::uuid, 'household-logistics-long-channel', NULL, ${owner.id}::uuid, 'user')`;
      ids["channel.general"] = channels.general;
      ids["channel.group"] = channels.group;
      ids["channel.long"] = channels.long;
      steps.push("seed_channels");
      /* The viewer's own settings, through the command a click sends: one starred channel, one muted. */
      ok("star_channel", await command(owner.token, { kind: "channel_preference_set", channel_id: channels.group, starred: true }, workspace));
      ok("mute_channel", await command(owner.token, { kind: "channel_preference_set", channel_id: channels.long, involvement: "muted" }, workspace));
      /* A second star, so Starred has an order to change; and a shared order an owner chose (CM-2b). */
      ok("star_general", await command(owner.token, { kind: "channel_preference_set", channel_id: null, starred: true }, workspace));
      ok("order_channels", await command(owner.token, { kind: "channel_reorder", channel_ids: [channels.long, channels.general] }, workspace));
      /* The policy that is not the default, so the settings capture shows a choice the page had to read.
         After every channel above exists: from here only an owner or admin may create one. */
      ok("channel_policy", await command(owner.token, { kind: "workspace_channel_policy_set", channel_creation_policy: "admins" }, workspace));
    } catch (error) { note("channels", error); }

    // 240 messages over three days: workspace feed, group chats, DMs both ways and thread replies.
    const senders = [...people.map(p => ({ id: p.id, kind: "user" })), ...agents.map(id => ({ id, kind: "agent" }))];
    const channelChoices = [null, channels.general, channels.group, channels.long];
    let inserted = 0;
    const roots: { id: string; channel: string | null }[] = [];
    for (let i = 0; i < 240; i += 1) {
      const from = senders[i % senders.length]!;
      const minutesAgo = (240 - i) * 17;
      const id = randomUUID();
      const dmToAgent = from.kind === "user" && i % 9 === 0 && agents.length ? agents[i % agents.length]! : null;
      const dmToUser = from.kind === "agent" && i % 7 === 0 ? owner.id : null;
      const channel = dmToAgent || dmToUser ? null : channelChoices[i % channelChoices.length]!;
      const root = !dmToAgent && !dmToUser && i % 11 === 5 ? roots.filter(r => r.channel === channel).at(-1) : undefined;
      const kind = i % 13 === 0 ? "ask" : i % 17 === 0 ? "working-on" : "note";
      try {
        await sql`INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to,
            about, kind, body, until, created_at, channel_id, thread_root_id, broadcast_to_channel
          ) VALUES (
            ${id}::uuid, ${workspace}::uuid, ${from.id}::uuid, ${from.kind}, ${dmToUser}::uuid, ${dmToAgent}::uuid,
            ${root?.id ?? null}::uuid, ${i % 5 === 0 ? "site/src/components/app" : null}, ${kind}, ${BODIES[i % BODIES.length]!},
            statement_timestamp() - (${minutesAgo} * interval '1 minute') + interval '25 days', statement_timestamp() - (${minutesAgo} * interval '1 minute'),
            ${channel}::uuid, ${root?.id ?? null}::uuid, false)`;
        inserted += 1;
        if (!root && !dmToAgent && !dmToUser) roots.push({ id, channel });
        if (root) ids["message.thread"] ??= root.id;
      } catch (error) { if (notes.filter(n => n.startsWith("signals")).length < 3) note("signals", error); }
    }
    note("signals inserted", inserted);

    // Ensure a recent #general thread and a recent DM with ids.agent sit inside the initial 25-signal page.
    try {
      const recentRootId = randomUUID();
      const recentReplyId = randomUUID();
      await sql`INSERT INTO swarm.signals (
          id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to,
          about, kind, body, until, created_at, channel_id, thread_root_id, broadcast_to_channel
        ) VALUES
        (
          ${recentRootId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, NULL, NULL,
          NULL, 'note', 'Can someone confirm the boiler service quote before Friday?',
          statement_timestamp() + interval '25 days', statement_timestamp() - interval '2 minutes',
          NULL, NULL, false
        ),
        (
          ${recentReplyId}::uuid, ${workspace}::uuid, ${adminPerson.id}::uuid, 'user', NULL, NULL, ${recentRootId}::uuid,
          NULL, 'note', 'Checked the quote in Files — $240 includes the expansion vessel check.',
          statement_timestamp() + interval '25 days', statement_timestamp() - interval '1 minute',
          NULL, ${recentRootId}::uuid, false
        )`;
      ids["message.thread"] = recentRootId;
      steps.push("seed_thread");
    } catch (error) { note("seed_thread", error); }

    if (ids.agent) {
      try {
        const dmId = randomUUID();
        await sql`INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to,
            about, kind, body, until, created_at, channel_id, thread_root_id, broadcast_to_channel
          ) VALUES (
            ${dmId}::uuid, ${workspace}::uuid, ${ids.agent}::uuid, 'agent', ${owner.id}::uuid, NULL, NULL,
            NULL, 'note', 'Direct update: I compared three boiler service quotes and saved the summary in Wiki.',
            statement_timestamp() + interval '25 days', statement_timestamp() - interval '30 seconds',
            NULL, NULL, false
          )`;
        steps.push("seed_dm");
      } catch (error) { note("seed_dm", error); }
      // The owner's hover report (Nov 10), newest in the general channel: an agent's long message addressed to the
      // viewer, the viewer's own long message addressed to an agent, and a second one that groups under it.
      try {
        const addressedAgent = randomUUID(), addressedOwn = randomUUID(), groupedOwn = randomUUID();
        await sql`INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to,
            about, kind, body, until, created_at, channel_id, thread_root_id, broadcast_to_channel
          ) VALUES (
            ${addressedAgent}::uuid, ${workspace}::uuid, ${ids.agent}::uuid, 'agent', ${owner.id}::uuid, NULL, NULL,
            NULL, 'note', ${"Security advisory: the boiler controller firmware has an update that fixes the pressure sensor reading. Please install it this week, one unit at a time, and reply with each unit's version once it is done."},
            statement_timestamp() + interval '25 days', statement_timestamp() - interval '25 seconds',
            ${channels.general}::uuid, NULL, false
          ), (
            ${addressedOwn}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, ${ids.agent}::uuid, NULL,
            NULL, 'note', ${"Please compare the three boiler service quotes, check which ones include the expansion vessel and the flue test, and post a short summary with the price difference before Friday so we can book the visit."},
            statement_timestamp() + interval '25 days', statement_timestamp() - interval '20 seconds',
            ${channels.general}::uuid, NULL, false
          ), (
            ${groupedOwn}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, ${ids.agent}::uuid, NULL,
            NULL, 'note', ${"Also include whether the quotes cover a return visit if the pressure drops again within a month."},
            statement_timestamp() + interval '25 days', statement_timestamp() - interval '10 seconds',
            ${channels.general}::uuid, NULL, false
          )`;
        Object.assign(ids, { "message.addressedAgent": addressedAgent, "message.addressedOwn": addressedOwn, "message.groupedOwn": groupedOwn });
        steps.push("seed_addressed");
      } catch (error) { note("seed_addressed", error); }
      // Two of the viewer's messages to the agent whose delivery ended in a terminal failure, seconds apart in the group
      // channel: a problem receipt is never quiet, so each row carries its status badge (the second one grouped, with
      // no avatar). They also show in the direct message with the agent.
      try {
        const failedOwn = randomUUID(), failedGrouped = randomUUID();
        await sql.begin(async (tx) => {
          await tx`INSERT INTO swarm.signals (
              id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to,
              about, kind, body, until, created_at, channel_id, thread_root_id, broadcast_to_channel
            ) VALUES (
              ${failedOwn}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, ${ids.agent}::uuid, NULL,
              NULL, 'note', 'Can you check whether the engineer confirmed Friday?',
              statement_timestamp() + interval '25 days', statement_timestamp() - interval '8 seconds',
              ${channels.group}::uuid, NULL, false
            ), (
              ${failedGrouped}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, ${ids.agent}::uuid, NULL,
              NULL, 'note', 'No rush if not.',
              statement_timestamp() + interval '25 days', statement_timestamp() - interval '6 seconds',
              ${channels.group}::uuid, NULL, false
            )`;
          const failed = await tx`UPDATE swarm.signal_deliveries
            SET delivered_at = statement_timestamp(), acked_at = statement_timestamp(), ack_outcome = 'failed_terminal',
                last_error_code = 'delivery_attempts_exhausted', updated_at = statement_timestamp()
            WHERE signal_id IN (${failedOwn}::uuid, ${failedGrouped}::uuid)
            RETURNING signal_id`;
          if (failed.length !== 2) throw new Error(`expected 2 delivery rows to fail, updated ${failed.length}`);
        });
        Object.assign(ids, { "message.failedOwn": failedOwn, "message.failedGrouped": failedGrouped });
        steps.push("seed_failed_delivery");
      } catch (error) { note("seed_failed_delivery", error); }
      // Two of the viewer's messages to everyone, seconds apart: the second groups under the first with no recipient, so
      // its author is the focus-revealed label (an addressed message keeps its header).
      try {
        const lead = randomUUID(), groupedBroadcast = randomUUID();
        await sql`INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to,
            about, kind, body, until, created_at, channel_id, thread_root_id, broadcast_to_channel
          ) VALUES (
            ${lead}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, NULL, NULL,
            NULL, 'note', 'Reminder for everyone: the boiler service visit is on Friday morning.',
            statement_timestamp() + interval '25 days', statement_timestamp() - interval '8 seconds', ${channels.general}::uuid, NULL, false
          ), (
            ${groupedBroadcast}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, NULL, NULL,
            NULL, 'note', 'Please keep the hallway clear for the engineer.',
            statement_timestamp() + interval '25 days', statement_timestamp() - interval '6 seconds', ${channels.general}::uuid, NULL, false
          )`;
        ids["message.groupedBroadcast"] = groupedBroadcast;
        steps.push("seed_grouped_broadcast");
      } catch (error) { note("seed_grouped_broadcast", error); }

      // Mentions: two recent public notes in the long-named channel with stored mention rows. The owner mentions two
      // agents; the admin mentions the owner, who is the signed-in viewer.
      try {
        const lumen = agentRows.find(row => row.name === "Lumen")?.principal_id;
        if (!lumen) throw new Error("no agent named Lumen");
        const mention = randomUUID(), mentionViewer = randomUUID();
        const viewerName = owner.email.split("@")[0]!;
        // A mention row is accepted only in the transaction that creates its message.
        await sql.begin(async (tx) => {
          await tx`INSERT INTO swarm.signals (
              id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to,
              about, kind, body, until, created_at, channel_id, thread_root_id, broadcast_to_channel
            ) VALUES (
              ${mention}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, NULL, NULL,
              NULL, 'note', ${"@Atlas Research & Long-Running Investigations Agent can you check the boiler quote? Then hand the invoice to @Lumen, and keep `@Lumen` in the file name."},
              statement_timestamp() + interval '25 days', statement_timestamp() - interval '20 seconds', ${channels.long}::uuid, NULL, false
            ), (
              ${mentionViewer}::uuid, ${workspace}::uuid, ${adminPerson.id}::uuid, 'user', NULL, NULL, NULL,
              NULL, 'note', ${`@${viewerName} the quote is in Files.`},
              statement_timestamp() + interval '25 days', statement_timestamp() - interval '18 seconds', ${channels.long}::uuid, NULL, false
            )`;
          await tx`INSERT INTO swarm.signal_mentions (signal_id, workspace_id, mentioned_user_id, mentioned_agent_principal_id, position, source) VALUES
            (${mention}::uuid, ${workspace}::uuid, NULL, ${ids.agent}::uuid, 0, 'author'),
            (${mention}::uuid, ${workspace}::uuid, NULL, ${lumen}::uuid, 1, 'author'),
            (${mentionViewer}::uuid, ${workspace}::uuid, ${owner.id}::uuid, NULL, 0, 'author')`;
        });
        ids["message.mention"] = mention;
        ids["message.mentionViewer"] = mentionViewer;
        steps.push("seed_mentions");
      } catch (error) { note("seed_mentions", error); }
      // A message long enough to collapse behind Show more, for the witness that keeps that control focused across a
      // real feed rebuild.
      try {
        const long = randomUUID();
        // More than MESSAGE_COLLAPSE_LINES (60 line boxes, site/src/lib/message-markdown.ts) at every audited width.
        const body = Array.from({ length: 75 }, (_, i) => `Step ${i + 1}: check the boiler pressure gauge, note the reading, and compare it with the service sheet.`).join("\n\n");
        await sql`INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to,
            about, kind, body, until, created_at, channel_id, thread_root_id, broadcast_to_channel
          ) VALUES (
            ${long}::uuid, ${workspace}::uuid, ${ids.agent}::uuid, 'agent', NULL, NULL, NULL,
            NULL, 'note', ${body}, statement_timestamp() + interval '25 days', statement_timestamp() - interval '40 seconds',
            ${channels.general}::uuid, NULL, false
          )`;
        ids["message.long"] = long;
        steps.push("seed_long_message");
      } catch (error) { note("seed_long_message", error); }

      // History: four recent messages in the long-named channel whose `until` has already passed. The two that are
      // conversation (a note to everyone, a note addressed to an agent) stay in the feed; a working-on status and an
      // agent's note to itself do not.
      try {
        const ended = randomUUID(), endedAddressed = randomUUID(), endedStatus = randomUUID(), endedSelf = randomUUID();
        await sql`INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to,
            about, kind, body, until, created_at, channel_id, thread_root_id, broadcast_to_channel
          ) VALUES (
            ${ended}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, NULL, NULL,
            NULL, 'note', 'The plumber came on Tuesday and replaced the pressure valve.',
            statement_timestamp() - interval '5 seconds', statement_timestamp() - interval '30 seconds', ${channels.long}::uuid, NULL, false
          ), (
            ${endedAddressed}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', NULL, ${ids.agent}::uuid, NULL,
            NULL, 'note', 'Please file the invoice under Boiler.',
            statement_timestamp() - interval '5 seconds', statement_timestamp() - interval '28 seconds', ${channels.long}::uuid, NULL, false
          ), (
            ${endedStatus}::uuid, ${workspace}::uuid, ${ids.agent}::uuid, 'agent', NULL, NULL, NULL,
            NULL, 'working-on', 'Filing the boiler invoice.',
            statement_timestamp() - interval '5 seconds', statement_timestamp() - interval '26 seconds', ${channels.long}::uuid, NULL, false
          ), (
            ${endedSelf}::uuid, ${workspace}::uuid, ${ids.agent}::uuid, 'agent', NULL, ${ids.agent}::uuid, NULL,
            NULL, 'note', 'CommonSwarm wake test. Confirm receipt in this session.',
            statement_timestamp() - interval '5 seconds', statement_timestamp() - interval '24 seconds', ${channels.long}::uuid, NULL, false
          )`;
        ids["message.ended"] = ended;
        ids["message.endedAddressed"] = endedAddressed;
        ids["message.endedStatus"] = endedStatus;
        ids["message.endedSelf"] = endedSelf;
        steps.push("seed_history");
      } catch (error) { note("seed_history", error); }
      // Every message the viewer can see starts already seen by them. Otherwise the first capture of the run marks
      // them seen, and the next receipt poll turns "Sent" into "Seen" in the middle of a hover measurement.
      try {
        await sql`INSERT INTO swarm.signal_human_receipts (workspace_id, signal_id, user_id)
          SELECT workspace_id, id, ${owner.id}::uuid FROM swarm.signals
          WHERE workspace_id = ${workspace}::uuid AND from_principal <> ${owner.id}::uuid
          ON CONFLICT DO NOTHING`;
        steps.push("seed_viewer_seen");
      } catch (error) { note("seed_viewer_seen", error); }
    }

    // Seed workspace Files and Wiki (brain--overview.md with 2 versions) through the real create -> PUT -> commit flow.
    const seedFile = async (stepName: string, name: string, contentType: string, text: string | Uint8Array, existingFileId?: string): Promise<string | null> => {
      try {
        const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
        const requestedFileId = existingFileId ?? randomUUID();
        const requestedVersionId = randomUUID();
        const created = await command(owner.token, {
          kind: "file_version_create",
          file_id: requestedFileId,
          version_id: requestedVersionId,
          name,
          declared_size_bytes: bytes.length,
          content_type: contentType,
        }, workspace);
        if (created.status !== 200 || created.body.status !== "accepted" || typeof created.body.upload_path !== "string") {
          note(stepName, `create HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
          return null;
        }
        const fileId = String(created.body.file_id ?? requestedFileId);
        const versionId = String(created.body.version_id ?? requestedVersionId);
        const put = await fetch(new URL(created.body.upload_path, `${env.apiUrl.replace(/\/+$/, "")}/`).href, {
          method: "PUT",
          headers: { "content-type": contentType },
          body: bytes as Uint8Array<ArrayBuffer>,
        });
        if (!put.ok) {
          note(stepName, `PUT HTTP ${put.status}`);
          return null;
        }
        const committed = await command(owner.token, {
          kind: "file_version_commit",
          file_id: fileId,
          version_id: versionId,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }, workspace);
        return ok(stepName, committed) ? fileId : null;
      } catch (error) {
        note(stepName, error);
        return null;
      }
    };
    const quoteFileId = await seedFile(
      "seed_file boiler-service-quote-2026-11.txt",
      "boiler-service-quote-2026-11.txt",
      "text/plain",
      "Boiler service quote — $240 including filter check and expansion vessel inspection.\nValid until 2026-11-30.\n",
    );
    // A real PNG and the text quote on one message in the general channel: one picture beside one file card.
    const pictureFileId = await seedFile("seed_file boiler-label.png", "boiler-label.png", "image/png", auditPng());
    if (pictureFileId && quoteFileId) {
      ok("seed_picture", await command(owner.token, {
        kind: "post_signal", signal_kind: "note", body: "Photo of the boiler label, with the service quote.",
        to_user_id: null, to_agent_principal_id: null, in_reply_to: null, about: null,
        attachments: [{ file_id: pictureFileId, version_n: 1 }, { file_id: quoteFileId, version_n: 1 }],
        channel: "household",
      }, workspace));
    }
    const wikiFileId = await seedFile(
      "seed_wiki overview v1",
      "brain--overview.md",
      "text/markdown",
      "# Household overview\n\nShared notes for household schedules, school pickup, and appliance maintenance.\n",
    );
    if (wikiFileId) {
      await seedFile(
        "seed_wiki overview",
        "brain--overview.md",
        "text/markdown",
        "# Household overview\n\nShared notes for household schedules, school pickup, and appliance maintenance.\n\n## Weekly rhythm\n\n- Monday: groceries & meal plan\n- Wednesday: school pickup cover\n- Friday: bills & receipts review\n",
        wikiFileId,
      );
    }

    // Lists & docs, definitions and to-dos through household_tool, as the owner.
    ok("household_permissions", await command(owner.token, { kind: "household_permissions", purpose: "shared", content_role: "editor" }, workspace));
    // The same owner grant on the empty workspace, so its Lists and to-do empty states are captured without consent clicks.
    ok("household_permissions empty", await command(owner.token, { kind: "household_permissions", purpose: "shared", content_role: "editor" }, emptyWorkspace));
    const toolAs = async (token: string, workspaceId: string, name: string, args: Record<string, unknown>, write = true) => {
      const commandId = `audit_${randomBytes(9).toString("base64url")}`;
      return await command(token, { kind: "household_tool", tool: name,
        arguments: { seat: LOCAL_SEAT, ...(write ? { request_id: commandId } : {}), ...args } }, workspaceId, commandId);
    };
    const tool = (name: string, args: Record<string, unknown>, write = true) => toolAs(owner.token, workspace, name, args, write);
    const items = Array.from({ length: 36 }, (_, n) => ({ item_id: `item-${n}`, text: n % 9 === 4 ? `Order replacement filter ${UNBROKEN.slice(0, 40)}` : `Grocery item ${n + 1}: ${["oat milk", "sourdough", "eggs", "basil", "limes", "rice"][n % 6]}`, order: n, checked: n % 4 === 0 }));
    ok("object_create list", await tool("object_create", { object_id: "groceries", title: "Weekly groceries", content: { kind: "list", items } }));
    ok("object_create doc", await tool("object_create", { object_id: "house-notes", title: "House notes", content: { kind: "doc", markdown: "# House notes\n\n" + BODIES.join("\n\n") } }));
    // A doc of its own for the save-conflict capture (app.list-conflict), which saves a revision behind the page's back on
    // every capture; house-notes stays as app.lists shows it.
    if (ok("seed_conflict_doc", await tool("object_create", { object_id: "boiler-visit", title: "Boiler visit", content: { kind: "doc",
      markdown: CONFLICT_DOC.base } }))) ids.conflictDoc = "boiler-visit";
    const definition = async (object_id: string, term: string, meaning: string, source: string) =>
      ok(`definition_create ${term}`, await tool("definition_create", { object_id, term, meaning, source }));
    await definition("def-monthly-spend", "Monthly spend", "Sum of card and cash spending in a calendar month.", "Card statements plus the cash log in Lists.");
    await definition("def-due-date", "Due date", "The last day a bill can be paid without a fee.", "");
    await definition("def-active-member", "Active member", "A person who posted or completed a to-do in the last 30 days.", "Workspace activity.");
    const definitionRevision = async (object_id: string) => {
      const read = await tool("definition_read", { object_id }, false);
      return (read.body.current as { revision?: Record<string, unknown> } | undefined)?.revision;
    };
    for (const id of ["def-monthly-spend", "def-due-date"]) {
      const revision = await definitionRevision(id);
      if (revision) ok(`certify ${id}`, await command(owner.token, { kind: "household_definition_certify", object_id: id, revision }, workspace));
    }
    const spend = await tool("definition_read", { object_id: "def-monthly-spend" }, false);
    const current = spend.body.current as { revision?: unknown; term?: string; meaning?: string; source?: string } | undefined;
    if (current?.revision) {
      ok("definition_update pending", await tool("definition_update", { object_id: "def-monthly-spend", base: current.revision,
        before: { term: current.term, meaning: current.meaning, source: current.source },
        after: { term: current.term, meaning: "Sum of card, cash and transfer spending in a calendar month, excluding savings.", source: current.source } }));
    }
    for (const [n, title] of ["Book the boiler service", "Renew car insurance before the 30th", "Plan the school pickup rota for next week with a much longer title that wraps on phones",
      "Order replacement water filter", "Sort the receipts folder", "Call the dentist", "Return the library books", "Fix the squeaky hinge"].entries()) {
      const created = await tool("todo_create", { title, ...(n % 2 === 0 ? { due_on: "2026-11-20" } : {}),
        ...(agents.length && n % 3 === 0 ? { assign: { to: { kind: "agent", id: agents[n % agents.length] }, start: "queue", gate: { kind: "none" } } } : {}) });
      ok(`todo_create ${n}`, created);
      const todo = (created.body.value as { todo_id?: string; version?: number } | undefined);
      if (todo?.todo_id) {
        ids.todo ??= todo.todo_id;
        if (n === 4 && todo.version) ok("todo done", await tool("todo_set_state", { todo_id: todo.todo_id, base_version: todo.version, state: "done" }));
        if (n === 5) ok("todo start", await tool("todo_start", { todo_id: todo.todo_id }));
      }
    }

    // A dense queue on {agent}'s own page (app.agent.queue): three more queued to-dos under Up next, and two held under
    // Not yet (a hold with a note, and one waiting on another to-do; an "at" gate would sit under At a set time instead).
    // Each queued one also posts its "added" note to the agent, so the owner's DM with it gains three rows.
    if (ids.agent) {
      const queued: string[] = [];
      for (const title of ["Compare the three boiler service quotes", "Check which quotes include the flue test",
        "Summarise the insurance renewal options with the price difference for each provider"]) {
        const created = await tool("todo_create", { title, assign: { to: { kind: "agent", id: ids.agent }, start: "queue", gate: { kind: "none" } } });
        const todoId = (created.body.value as { todo_id?: string } | undefined)?.todo_id;
        if (ok(`agent queue ${title}`, created) && todoId) queued.push(todoId);
      }
      const held = queued[0] ? [
        await tool("todo_create", { title: "Book the boiler service visit",
          assign: { to: { kind: "agent", id: ids.agent }, start: "queue", gate: { kind: "after", todo_id: queued[0] } } }),
        await tool("todo_create", { title: "Order the expansion vessel part",
          assign: { to: { kind: "agent", id: ids.agent }, start: "queue", gate: { kind: "hold", note: "Waiting for the engineer to confirm the size" } } }),
      ] : [];
      const heldOk = held.map((result, n) => ok(`agent not yet ${n}`, result));
      if (queued.length === 3 && heldOk.length === 2 && heldOk.every(Boolean)) steps.push("seed_agent_queue");
    }

    // A pending to-do offer to the viewer (app.todo-offer), in a workspace of its own: an offer the viewer decides on is
    // drawn atop every feed in its workspace. A member offers the to-do; both need Lists consent (the owner's first, which
    // sets the workspace's boundary). The feed needs an agent and messages, or it shows a setup or empty state instead.
    try {
      const offerWorkspace = randomUUID();
      const offerer = people[3]!;
      ok("create_workspace offer", await command(owner.token, { kind: "create_workspace", workspace_id: offerWorkspace, name: "Weekend errands", org_id: workspace }, null));
      ids.offerWorkspace = offerWorkspace;
      const invited = await command(owner.token, { kind: "invite_member", email: offerer.email, ttl_ms: 7 * 24 * 3_600_000 }, offerWorkspace);
      const token = String(invited.body.invitation_token ?? "");
      const joined = ok(`invite offer ${offerer.name}`, invited) && !!token
        && ok(`accept offer ${offerer.name}`, await command(offerer.token, { kind: "accept_invitation", token }, null));
      // With no agent the workspace opens on its no-agents setup view instead of the feed.
      const consented = joined
        && ok("create_agent_principal offer", await command(owner.token, { kind: "create_agent_principal", name: "Errands", model: "claude-opus-5-5" }, offerWorkspace))
        && ok("household_permissions offer", await command(owner.token, { kind: "household_permissions", purpose: "shared", content_role: "editor" }, offerWorkspace))
        && ok("household_permissions offer member", await command(offerer.token, { kind: "household_permissions", purpose: "shared", content_role: "editor" }, offerWorkspace));
      if (consented) {
        await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at, broadcast_to_channel) VALUES
          (${randomUUID()}::uuid, ${offerWorkspace}::uuid, ${offerer.id}::uuid, 'user', 'note', 'I can do the dry cleaning run, but Saturday is tight for me.',
            statement_timestamp() + interval '25 days', statement_timestamp() - interval '3 minutes', false),
          (${randomUUID()}::uuid, ${offerWorkspace}::uuid, ${owner.id}::uuid, 'user', 'note', 'Send it my way and I will pick it up with the groceries.',
            statement_timestamp() + interval '25 days', statement_timestamp() - interval '2 minutes', false)`;
        const offered = await toolAs(offerer.token, offerWorkspace, "todo_create", { title: "Pick up the dry cleaning on Saturday morning",
          assign: { to: { kind: "user", id: owner.id }, start: "queue", gate: { kind: "none" } } });
        const value = offered.body.value as { todo_id?: string; offer?: { decider_user_id?: string } | null } | undefined;
        if (ok("todo_create offer", offered) && value?.todo_id && value.offer?.decider_user_id === owner.id) {
          ids["todo.offer"] = value.todo_id;
          // The offer's notice and the member's note start already seen by the viewer, as in the main workspace.
          await sql`INSERT INTO swarm.signal_human_receipts (workspace_id, signal_id, user_id)
            SELECT workspace_id, id, ${owner.id}::uuid FROM swarm.signals
            WHERE workspace_id = ${offerWorkspace}::uuid AND from_principal <> ${owner.id}::uuid
            ON CONFLICT DO NOTHING`;
          steps.push("seed_todo_offer");
        } else if (value?.todo_id) note("todo_create offer", `no pending offer to the viewer: ${JSON.stringify(value).slice(0, 200)}`);
      }
    } catch (error) { note("seed_todo_offer", error); }
    // The Lists & docs agent approval (app.lists-approval), in a workspace of its own so no other capture changes: one own local
    // agent with a live connection (device, run, renewal grant and token rows, as the p1-server household fixtures build) and
    // no Lists approval yet, so the People dialog offers Allow and the approvals list shows its card.
    try {
      const approvalWorkspace = randomUUID();
      const ready = ok("create_workspace approval", await command(owner.token, { kind: "create_workspace", workspace_id: approvalWorkspace, name: "Garden projects", org_id: workspace }, null))
        && ok("create_agent_principal approval", await command(owner.token, { kind: "create_agent_principal", name: "Sprout", model: "claude-opus-5-5" }, approvalWorkspace))
        && ok("household_permissions approval", await command(owner.token, { kind: "household_permissions", purpose: "shared", content_role: "editor" }, approvalWorkspace));
      const [agent] = ready ? await sql<{ principal_id: string }[]>`SELECT principal_id FROM swarm.agent_principals
        WHERE workspace_id = ${approvalWorkspace}::uuid AND name = 'Sprout' AND transport = 'local'` : [];
      if (agent) {
        const device = randomUUID(), run = randomUUID(), family = randomUUID(), token = randomUUID();
        await sql.begin(async (tx) => {
          await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner.id}::uuid, 'Audit laptop')`;
          await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${agent.principal_id}::uuid, ${device}::uuid)`;
          await tx`INSERT INTO swarm.renewal_grants (renewal_grant_id, workspace_id, principal_id, run_id, created_by, horizon_expires_at, max_successors)
            VALUES (${family}::uuid, ${approvalWorkspace}::uuid, ${agent.principal_id}::uuid, ${run}::uuid, ${owner.id}::uuid, clock_timestamp() + interval '30 days', 800)`;
          await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id, renewal_grant_id)
            VALUES (${token}::uuid, ${agent.principal_id}::uuid, ${run}::uuid, '["post_signal"]', ${createHash("sha256").update(randomBytes(32)).digest()},
              clock_timestamp() + interval '1 day', ${randomUUID()}::uuid, ${family}::uuid)`;
        });
        Object.assign(ids, { approvalWorkspace, approvalAgent: agent.principal_id });
        steps.push("seed_lists_approval");
      } else if (ready) note("seed_lists_approval", "the Sprout agent principal was not found as a local agent");
    } catch (error) { note("seed_lists_approval", error); }
    // A second viewer with a delegated invitation (app.invitation-inbox, dialog.invitation-review). The invitee already belongs
    // to {workspace}, so the inbox shows as the corner card above the composer rather than atop the create-workspace screen.
    // The admin person invites them to a workspace the admin owns, so nothing appears in the owner's captures.
    let invitee: SeedResult["invitee"] = null;
    try {
      const inviter = adminPerson, recipient = people[2]!, inviteWorkspace = randomUUID();
      const ready = ok("create_workspace invite", await command(inviter.token, { kind: "create_workspace", workspace_id: inviteWorkspace, name: "Allotment group" }, null))
        && ok("household_permissions invite", await command(inviter.token, { kind: "household_permissions", purpose: "shared", content_role: "editor" }, inviteWorkspace));
      if (ready) {
        await issueDelegatedInvitation(sql, inviter.id, inviteWorkspace, recipient.id);
        const [listed] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.admin_routine_invitations
          WHERE workspace_id = ${inviteWorkspace}::uuid AND recipient_user_id = ${recipient.id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL`;
        if (listed?.n === 1) {
          ids.inviteWorkspace = inviteWorkspace;
          invitee = { email: recipient.email, password: recipient.password };
          steps.push("seed_delegated_invitation");
        } else note("seed_delegated_invitation", `expected one pending invitation, found ${listed?.n}`);
      }
    } catch (error) { note("seed_delegated_invitation", error); }
    return { owner: { email: owner.email, password: owner.password }, invitee, ids, notes, steps };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
