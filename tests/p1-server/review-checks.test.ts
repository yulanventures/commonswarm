/**
 * Revision-bound review checks (C3) against real Postgres and served command/read functions:
 * open/update-head, per-seat own-row stamp enforcement, head invalidation & 409 stale_head,
 * once-only satisfied thread note (including concurrent final-stamp serialization), and
 * private conversation uniform-404 isolation.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import {
  openReviewCheck,
  readReviewChecks,
  ReviewCheckError,
  stampReviewCheck,
} from "../../src/cloud/review-checks.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Agent = { principal: string; token: string; name: string };
type Row = Record<string, unknown>;

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let workspace: string;
let owner: Person;
let seatLead: Agent;
let seatSec: Agent;
let outsider: Agent;

function localEnvironment(): Local {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  })) as Partial<Local>;
  assert.ok(parsed.API_URL?.startsWith("http://127.0.0.1:"));
  assert.ok(parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  return parsed as Local;
}

async function createUser(label: string): Promise<Person> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signed.error);
  return { id: created.data.user!.id, jwt: signed.data.session!.access_token };
}

async function agentOf(ownerId: string, prefix: string): Promise<Agent> {
  const principal = randomUUID();
  const name = `${prefix}-${principal.slice(0, 6)}`;
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    const device = randomUUID();
    const run = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${ownerId}::uuid, 'review-check-tests')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${ownerId}::uuid, ${name})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  return { principal, token, name };
}

async function send(bearer: string, command: Row): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: workspace,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return { status: response.status, body: await response.json() as Row };
}

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cs-review-checks-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\n", { mode: 0o600 });
  sql = postgres(local.DB_URL, { prepare: false, max: 8 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_ENV: "test" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cliState = observeFunctionCli(functionProcess);
  let startupSeen = false;
  const observe = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-30_000);
    startupSeen ||= functionLogs.includes("Serving functions on");
  };
  functionProcess.stdout?.on("data", observe);
  functionProcess.stderr?.on("data", observe);
  const bootDeadline = Date.now() + 60_000;
  while (!startupSeen) {
    if (cliState.exited) {
      throw new Error(`supabase functions serve exited early: ${functionLogs.slice(-2000)}`);
    }
    if (Date.now() > bootDeadline) {
      throw new Error(`supabase functions serve timed out: ${functionLogs.slice(-2000)}`);
    }
    await delay(200);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `local command function was not ready: ${functionLogs.slice(-2000)}`,
    cliState,
  });

  workspace = randomUUID();
  owner = await createUser("rc-owner");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner.id}::uuid, 'Owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'review-checks-ws', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
  });
  seatLead = await agentOf(owner.id, "lead");
  seatSec = await agentOf(owner.id, "sec");
  outsider = await agentOf(owner.id, "outsider");
});

after(async () => {
  if (functionProcess?.pid) {
    try { process.kill(-functionProcess.pid, "SIGTERM"); } catch { /* already stopped */ }
  }
  if (envDir) rmSync(envDir, { recursive: true, force: true });
  await sql?.end({ timeout: 5 });
});

test("C3 lifecycle: open, own-seat stamp, once-only satisfied thread note, head invalidation, and stale_head refusal", async () => {
  const target = { url: local.API_URL, anonKey: local.ANON_KEY };
  const head1 = "1111111aaaaaaa11111111111111111111111111";
  const head2 = "2222222bbbbbbb22222222222222222222222222";

  // Create a public channel and thread root signal.
  const ch = await send(owner.jwt, {
    kind: "channel_create",
    slug: `rc-${randomBytes(4).toString("hex")}`,
    purpose: "Review checks",
  });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const channelId = String((ch.body.channel as Row).channel_id);
  const rootPost = await send(seatLead.token, {
    kind: "post_signal",
    signal_kind: "note",
    conversation_id: channelId,
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    body: "PR #700 review thread",
    about: "yulanventures/commonswarm#700",
  });
  assert.equal(rootPost.status, 200, JSON.stringify(rootPost.body));
  const rootId = String((rootPost.body.signal as Row).id);

  // Open check attached to that thread root.
  const opened = await openReviewCheck(target, seatLead.token, workspace, {
    repo: "yulanventures/commonswarm",
    ref: "700",
    headSha: head1,
    requiredSeats: [
      { kind: "agent", id: seatLead.principal },
      { kind: "agent", id: seatSec.principal },
    ],
    threadRootId: rootId,
  });
  assert.equal(opened.created, true);
  assert.equal(opened.head_changed, true);
  assert.equal(opened.review_check.status, "pending");
  assert.equal(opened.review_check.thread_root_id, rootId);
  assert.ok(opened.review_check.conversation_id);
  const checkId = opened.review_check.check_id;

  // Non-required seat cannot stamp.
  await assert.rejects(
    stampReviewCheck(target, outsider.token, workspace, {
      checkId,
      headSha: head1,
      verdict: "pass",
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "not_required_seat" && error.status === 403,
  );

  // First seat passes -> still pending, no thread note posted yet.
  const s1 = await stampReviewCheck(target, seatLead.token, workspace, {
    checkId,
    headSha: head1,
    verdict: "pass",
    note: "Source review pass",
  });
  assert.equal(s1.satisfied_now, false);
  assert.equal(s1.satisfied_signal_id, null);
  assert.equal(s1.review_check.status, "pending");

  // Second seat holds -> status becomes hold.
  const s2Hold = await stampReviewCheck(target, seatSec.token, workspace, {
    checkId,
    headSha: head1,
    verdict: "hold",
    note: "Need lock-order check",
  });
  assert.equal(s2Hold.satisfied_now, false);
  assert.equal(s2Hold.review_check.status, "hold");

  // Second seat updates to pass -> satisfied once, posts ONE thread note!
  const s2Pass = await stampReviewCheck(target, seatSec.token, workspace, {
    checkId,
    headSha: head1,
    verdict: "pass",
    note: "Lock order verified",
  });
  assert.equal(s2Pass.satisfied_now, true);
  assert.ok(s2Pass.satisfied_signal_id);
  assert.equal(s2Pass.review_check.status, "satisfied");
  assert.equal(s2Pass.review_check.satisfied_head_sha, head1);

  const threadNotesAfterHead1 = await sql<{ id: string; body: string }[]>`
    SELECT id, body FROM swarm.signals
    WHERE workspace_id = ${workspace}::uuid AND thread_root_id = ${rootId}::uuid
  `;
  assert.equal(threadNotesAfterHead1.length, 1);
  assert.match(threadNotesAfterHead1[0]!.body, /Review check satisfied for yulanventures\/commonswarm#700 @ 1111111aa/);

  // Re-stamping pass on the same head never posts a duplicate note.
  const repeatPass = await stampReviewCheck(target, seatSec.token, workspace, {
    checkId,
    headSha: head1,
    verdict: "pass",
  });
  assert.equal(repeatPass.satisfied_now, false);
  assert.equal(repeatPass.satisfied_signal_id, null);

  // Advancing head_sha to head2 invalidates earlier stamps (opener passes checkId or same placement).
  const advanced = await openReviewCheck(target, seatLead.token, workspace, {
    checkId,
    repo: "yulanventures/commonswarm",
    ref: "700",
    headSha: head2,
    requiredSeats: [
      { kind: "agent", id: seatLead.principal },
      { kind: "agent", id: seatSec.principal },
    ],
  });
  assert.equal(advanced.created, false);
  assert.equal(advanced.head_changed, true);
  assert.equal(advanced.review_check.status, "pending");
  assert.equal(advanced.review_check.satisfied, false);
  assert.equal(advanced.review_check.stamps.every((s) => s.stale && s.effective_verdict === "pending"), true);

  // Condition 1: unauthorized viewer (even a bystander or non-opener required reviewer) CANNOT
  // replace head_sha or required_seats on an existing check -> 403 forbidden!
  await assert.rejects(
    openReviewCheck(target, outsider.token, workspace, {
      checkId,
      repo: "yulanventures/commonswarm",
      ref: "700",
      headSha: head2,
      requiredSeats: [{ kind: "agent", id: outsider.principal }],
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "forbidden" && error.status === 403,
  );
  await assert.rejects(
    openReviewCheck(target, seatSec.token, workspace, {
      repo: "yulanventures/commonswarm",
      ref: "700",
      headSha: head2,
      requiredSeats: [{ kind: "agent", id: seatSec.principal }],
      threadRootId: rootId,
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "forbidden" && error.status === 403,
  );

  // Condition 1 delegated update: channel lead or workspace admin CAN update, and updated_by records who did it.
  const adminUpdate = await openReviewCheck(target, owner.jwt, workspace, {
    checkId,
    repo: "yulanventures/commonswarm",
    ref: "700",
    headSha: head2,
    requiredSeats: [
      { kind: "agent", id: seatLead.principal },
      { kind: "agent", id: seatSec.principal },
    ],
  });
  assert.equal(adminUpdate.created, false);
  assert.deepEqual(adminUpdate.review_check.updated_by, { kind: "user", id: owner.id });

  // Condition 2 placement immutability: moving an existing check to another conversation returns 409.
  const otherCh = await send(owner.jwt, {
    kind: "channel_create",
    slug: `rc-other-${randomBytes(4).toString("hex")}`,
    purpose: "Other channel",
  });
  assert.equal(otherCh.status, 200);
  const otherChId = String((otherCh.body.channel as Row).channel_id);
  await assert.rejects(
    openReviewCheck(target, seatLead.token, workspace, {
      checkId,
      repo: "yulanventures/commonswarm",
      ref: "700",
      headSha: head2,
      requiredSeats: [{ kind: "agent", id: seatLead.principal }],
      conversationId: otherChId,
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "placement_immutable" && error.status === 409,
  );

  // Stamping old head1 is refused with 409 stale_head carrying head2.
  await assert.rejects(
    stampReviewCheck(target, seatLead.token, workspace, {
      checkId,
      headSha: head1,
      verdict: "pass",
    }),
    (error: unknown) =>
      error instanceof ReviewCheckError &&
      error.code === "stale_head" &&
      error.status === 409 &&
      error.currentHeadSha === head2,
  );

  // Concurrent final stamps on head2 serialize and post EXACTLY ONE new thread note.
  const [c1, c2] = await Promise.all([
    stampReviewCheck(target, seatLead.token, workspace, { checkId, headSha: head2, verdict: "pass" }),
    stampReviewCheck(target, seatSec.token, workspace, { checkId, headSha: head2, verdict: "pass" }),
  ]);
  assert.equal([c1.satisfied_now, c2.satisfied_now].filter(Boolean).length, 1);
  const threadNotesAfterHead2 = await sql<{ id: string; body: string }[]>`
    SELECT id, body FROM swarm.signals
    WHERE workspace_id = ${workspace}::uuid AND thread_root_id = ${rootId}::uuid
  `;
  assert.equal(threadNotesAfterHead2.length, 2);

  // Read API returns the canonical satisfied check by check_id and by repo+ref for both human and agent.
  const readByAgent = await readReviewChecks(target, seatLead.token, workspace, { checkId });
  assert.equal(readByAgent.review_check?.status, "satisfied");
  const readByHuman = await readReviewChecks(target, owner.jwt, workspace, {
    repo: "yulanventures/commonswarm",
    ref: "700",
  });
  assert.equal(readByHuman.review_check?.check_id, checkId);
});

test("C3 private conversation isolation: outsider receives uniform 404 on read and stamp", async () => {
  const target = { url: local.API_URL, anonKey: local.ANON_KEY };
  const head = "3333333ccccccc33333333333333333333333333";

  // Open a 1:1 DM between owner and seatLead (outsider is not a member).
  const dm = await send(owner.jwt, {
    kind: "conversation_open",
    members: [{ kind: "agent", id: seatLead.principal }],
    new_group: false,
  });
  assert.equal(dm.status, 200, JSON.stringify(dm.body));
  const dmId = String((dm.body.conversation as Row).conversation_id);

  const opened = await openReviewCheck(target, owner.jwt, workspace, {
    repo: "yulanventures/private-repo",
    ref: "42",
    headSha: head,
    requiredSeats: [{ kind: "agent", id: seatLead.principal }],
    conversationId: dmId,
  });
  const checkId = opened.review_check.check_id;

  // Outsider gets uniform 404 by check_id, by repo+ref, and on stamp; list omits it.
  await assert.rejects(
    readReviewChecks(target, outsider.token, workspace, { checkId }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "not_found" && error.status === 404,
  );
  await assert.rejects(
    readReviewChecks(target, outsider.token, workspace, { repo: "yulanventures/private-repo", ref: "42" }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "not_found" && error.status === 404,
  );
  await assert.rejects(
    stampReviewCheck(target, outsider.token, workspace, { checkId, headSha: head, verdict: "pass" }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "not_found" && error.status === 404,
  );
  const outsiderList = await readReviewChecks(target, outsider.token, workspace);
  assert.equal(outsiderList.review_checks?.some((c) => c.check_id === checkId), false);

  // seatLead stamps pass in the DM -> posts one satisfied DM note cleanly!
  const stamped = await stampReviewCheck(target, seatLead.token, workspace, {
    checkId,
    headSha: head,
    verdict: "pass",
  });
  assert.equal(stamped.satisfied_now, true);
  assert.ok(stamped.satisfied_signal_id);

  // Condition 2 no hidden-subject existence oracle: outsider opening the SAME repo+ref in workspace
  // scope succeeds independently and never probes the hidden DM check!
  const publicSameSubject = await openReviewCheck(target, outsider.token, workspace, {
    repo: "yulanventures/private-repo",
    ref: "42",
    headSha: head,
    requiredSeats: [{ kind: "agent", id: outsider.principal }],
  });
  assert.equal(publicSameSubject.created, true);
  assert.notEqual(publicSameSubject.review_check.check_id, checkId);
});

test("C3 Conditions 2 & 3: narrow addressed thread root audience, unmapped root fail-closed, replay reauth, and private channel audit isolation", async () => {
  const target = { url: local.API_URL, anonKey: local.ANON_KEY };
  const head = "4444444ddddddd44444444444444444444444444";

  // Create a second human workspace administrator who is NOT a member of the private channel.
  const outsideAdmin = await createUser("rc-outside-admin");
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${outsideAdmin.id}::uuid, 'OutsideAdmin')`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${outsideAdmin.id}::uuid, 'admin')`;

  // 1. Narrow addressed root inside a PUBLIC channel: owner -> seatSec ONLY (outsider is in workspace
  //    and can open the public channel, but CANNOT read the addressed root!).
  const pubChSlug = `rc-addr-${randomBytes(4).toString("hex")}`;
  const pubCh = await send(owner.jwt, {
    kind: "channel_create",
    slug: pubChSlug,
    purpose: "Addressed root test",
  });
  assert.equal(pubCh.status, 200);
  const pubChId = String((pubCh.body.channel as Row).channel_id);
  const addrRootPost = await send(owner.jwt, {
    kind: "post_signal",
    signal_kind: "ask",
    channel: pubChSlug,
    to_user_id: null,
    to_agent_principal_id: seatSec.principal,
    in_reply_to: null,
    body: "Narrow addressed thread root",
    about: "yulanventures/commonswarm#710",
  });
  assert.equal(addrRootPost.status, 200, JSON.stringify(addrRootPost.body));
  const addrRootId = String((addrRootPost.body.signal as Row).id);

  // Bystander who can open pubCh but cannot read addrRootId gets uniform 404 trying to open on it.
  await assert.rejects(
    openReviewCheck(target, outsider.token, workspace, {
      repo: "yulanventures/commonswarm",
      ref: "710-narrow",
      headSha: head,
      requiredSeats: [{ kind: "agent", id: outsider.principal }],
      threadRootId: addrRootId,
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "not_found" && error.status === 404,
  );

  // Authorized owner opens check on the narrow addressed root with seatSec; non-recipient outsider is rejected as invalid_seat.
  await assert.rejects(
    openReviewCheck(target, owner.jwt, workspace, {
      repo: "yulanventures/commonswarm",
      ref: "710-narrow",
      headSha: head,
      requiredSeats: [{ kind: "agent", id: outsider.principal }],
      threadRootId: addrRootId,
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "invalid_seat" && error.status === 400,
  );
  const narrowOpen = await openReviewCheck(target, owner.jwt, workspace, {
    repo: "yulanventures/commonswarm",
    ref: "710-narrow",
    headSha: head,
    requiredSeats: [{ kind: "agent", id: seatSec.principal }],
    threadRootId: addrRootId,
  });
  assert.equal(narrowOpen.review_check.root_audience, "addressed");
  const narrowCheckId = narrowOpen.review_check.check_id;

  // Bystander in pubCh gets 404 on read & stamp, and list omits it.
  await assert.rejects(
    readReviewChecks(target, outsider.token, workspace, { checkId: narrowCheckId }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "not_found" && error.status === 404,
  );
  const bystanderList = await readReviewChecks(target, outsider.token, workspace, { conversationId: pubChId });
  assert.equal(bystanderList.review_checks?.some((c) => c.check_id === narrowCheckId), false);

  // seatSec stamps pass -> satisfaction note MUST remain addressed (audience='addressed'), never public channel-wide!
  const narrowStamp = await stampReviewCheck(target, seatSec.token, workspace, {
    checkId: narrowCheckId,
    headSha: head,
    verdict: "pass",
  });
  assert.equal(narrowStamp.satisfied_now, true);
  assert.ok(narrowStamp.satisfied_signal_id);
  const [satFiling] = await sql<{ audience: string; conversation_id: string }[]>`
    SELECT audience, conversation_id FROM swarm.conversation_signals
    WHERE workspace_id = ${workspace}::uuid AND signal_id = ${narrowStamp.satisfied_signal_id!}::uuid
  `;
  assert.equal(satFiling!.audience, "addressed", "satisfaction note on addressed root MUST preserve addressed audience");
  assert.equal(satFiling!.conversation_id, pubChId);

  // 2. Unmapped root fails closed (404, never treated as workspace-scoped).
  const unmappedRootId = randomUUID();
  await sql`
    INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, until, created_at)
    VALUES (${unmappedRootId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', ${seatSec.principal}::uuid, 'ask', 'legacy unmapped', statement_timestamp() + interval '1 day', statement_timestamp())
  `;
  // Remove conversation_signals row to simulate legacy unmapped addressed root.
  await sql.begin(async (tx) => {
    await tx`ALTER TABLE swarm.conversation_signals DISABLE TRIGGER conversation_signals_append_only`;
    try {
      await tx`DELETE FROM swarm.conversation_signals WHERE workspace_id = ${workspace}::uuid AND signal_id = ${unmappedRootId}::uuid`;
    } finally {
      await tx`ALTER TABLE swarm.conversation_signals ENABLE TRIGGER conversation_signals_append_only`;
    }
  });
  await assert.rejects(
    openReviewCheck(target, owner.jwt, workspace, {
      repo: "yulanventures/commonswarm",
      ref: "710-unmapped",
      headSha: head,
      requiredSeats: [{ kind: "agent", id: seatSec.principal }],
      threadRootId: unmappedRootId,
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "not_found" && error.status === 404,
  );

  // 3. Condition 3: Private channel audit tagging (accepted, replayed, conflicting, post-removal) +
  //    outside workspace administrator sees ZERO private check audit rows and indistinguishable 404 probes!
  const privCh = await send(owner.jwt, {
    kind: "channel_create",
    slug: `rc-priv-audit-${randomBytes(4).toString("hex")}`,
    visibility: "private",
    members: [{ kind: "agent", id: seatLead.principal }],
  });
  assert.equal(privCh.status, 200, JSON.stringify(privCh.body));
  const privChId = String((privCh.body.channel as Row).channel_id);

  const auditRowsFor = async (viewerId: string, mark: string) =>
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: viewerId, role: "authenticated" })}, true)`;
      await tx.unsafe("SET LOCAL ROLE authenticated");
      const rows = await tx<{ command_kind: string; outcome: string; reason: string | null }[]>`
        SELECT command_kind, outcome, reason FROM swarm_read.audit_log
        WHERE workspace_id = ${workspace}::uuid
          AND command_kind IN ('review_check_open', 'review_check_stamp')
          AND audit_id > ${mark}::bigint
        ORDER BY audit_id
      `;
      return rows.map((r) => ({ ...r }));
    }) as Array<{ command_kind: string; outcome: string; reason: string | null }>;

  const mark1 = (await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`)[0]!.mark;
  const openCmdId = randomUUID();
  const stampCmdId = randomUUID();

  // Accepted private open + replay + conflict on same command_id
  const privOpen = await openReviewCheck(target, owner.jwt, workspace, {
    repo: "yulanventures/private-audit",
    ref: "99",
    headSha: head,
    requiredSeats: [{ kind: "agent", id: seatLead.principal }],
    conversationId: privChId,
    commandId: openCmdId,
  });
  const privCheckId = privOpen.review_check.check_id;
  assert.equal(privOpen.review_check.channel_id, privChId);
  // Replay open
  await openReviewCheck(target, owner.jwt, workspace, {
    repo: "yulanventures/private-audit",
    ref: "99",
    headSha: head,
    requiredSeats: [{ kind: "agent", id: seatLead.principal }],
    conversationId: privChId,
    commandId: openCmdId,
  });
  // Conflicting payload on same command_id
  await assert.rejects(
    openReviewCheck(target, owner.jwt, workspace, {
      repo: "yulanventures/private-audit",
      ref: "99-conflict",
      headSha: head,
      requiredSeats: [{ kind: "agent", id: seatLead.principal }],
      conversationId: privChId,
      commandId: openCmdId,
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.status === 409,
  );
  // Accepted private stamp + replay + conflict + post-removal replay refusal
  await stampReviewCheck(target, seatLead.token, workspace, {
    checkId: privCheckId,
    headSha: head,
    verdict: "pass",
    commandId: stampCmdId,
  });
  await stampReviewCheck(target, seatLead.token, workspace, {
    checkId: privCheckId,
    headSha: head,
    verdict: "pass",
    commandId: stampCmdId,
  });
  await assert.rejects(
    stampReviewCheck(target, seatLead.token, workspace, {
      checkId: privCheckId,
      headSha: head,
      verdict: "hold",
      commandId: stampCmdId,
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.status === 409,
  );
  // Remove seatLead from private channel -> replay must refuse 404 AND keep private channel audit tag!
  assert.equal((await send(owner.jwt, {
    kind: "channel_member_remove",
    channel_id: privChId,
    member: { kind: "agent", id: seatLead.principal },
  })).status, 200);
  await assert.rejects(
    stampReviewCheck(target, seatLead.token, workspace, {
      checkId: privCheckId,
      headSha: head,
      verdict: "pass",
      commandId: stampCmdId,
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.status === 404,
  );

  // Outside workspace administrator sees ZERO of those private channel audit rows; private-channel member owner sees all 7!
  assert.equal((await auditRowsFor(outsideAdmin.id, mark1)).length, 0, "outside workspace admin must see ZERO private review_check open/stamp/replay/conflict audit rows");
  assert.equal((await auditRowsFor(owner.id, mark1)).length, 7, "private channel member owner must see all 7 tagged audit rows");

  // Unknown vs hidden private check probe by outsideAdmin -> identical 404 and identical audit_log visibility!
  const markUnknown = (await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`)[0]!.mark;
  const probeUnknown = await send(outsideAdmin.jwt, {
    kind: "review_check_stamp", check_id: randomUUID(), head_sha: head, verdict: "pass",
  });
  const auditUnknown = await auditRowsFor(outsideAdmin.id, markUnknown);

  const markHidden = (await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`)[0]!.mark;
  const probeHidden = await send(outsideAdmin.jwt, {
    kind: "review_check_stamp", check_id: privCheckId, head_sha: head, verdict: "pass",
  });
  const auditHidden = await auditRowsFor(outsideAdmin.id, markHidden);

  assert.equal(probeUnknown.status, 404);
  assert.equal(probeHidden.status, 404);
  assert.deepEqual(probeHidden.body, probeUnknown.body);
  assert.deepEqual(auditHidden, auditUnknown, "hidden vs unknown review_check probes must leave identical audit_log visibility");

  // 4. Step 2b narrow addressed group-DM root:
  //    (a) Admission check refuses opening on a narrow group-DM root hidden from a live member.
  //    (b) If eligibility is lost after open (a new member joins the group DM), final pass stamp
  //        still succeeds cleanly without aborting on the deferred trigger or leaking a DM note.
  const narrowGdm = await send(owner.jwt, {
    kind: "conversation_open",
    members: [{ kind: "agent", id: seatSec.principal }, { kind: "agent", id: outsider.principal }],
    new_group: true,
  });
  assert.equal(narrowGdm.status, 200, JSON.stringify(narrowGdm.body));
  const narrowGdmId = String((narrowGdm.body.conversation as Row).conversation_id);
  const narrowGdmRootId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, until, created_at)
      VALUES (${narrowGdmRootId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', ${seatSec.principal}::uuid, 'ask', 'Narrow group DM root', statement_timestamp() + interval '1 day', statement_timestamp())
    `;
    await tx`
      INSERT INTO swarm.conversation_signals (workspace_id, conversation_id, signal_id, audience, created_at)
      VALUES (${workspace}::uuid, ${narrowGdmId}::uuid, ${narrowGdmRootId}::uuid, 'addressed', statement_timestamp())
    `;
  });
  await assert.rejects(
    openReviewCheck(target, owner.jwt, workspace, {
      repo: "yulanventures/commonswarm",
      ref: "710-gdm-narrow-refuse",
      headSha: head,
      requiredSeats: [{ kind: "agent", id: seatSec.principal }],
      threadRootId: narrowGdmRootId,
    }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "not_found" && error.status === 404,
  );

  // Now model an addressed group-DM root initially visible to all live members (owner, seatSec, seatLead),
  // then add outsider after open (losing Step 2b DM-thread eligibility) before seatSec casts the final pass!
  const eligibleGdm = await send(owner.jwt, {
    kind: "conversation_open",
    members: [{ kind: "agent", id: seatSec.principal }, { kind: "agent", id: seatLead.principal }],
    new_group: true,
  });
  assert.equal(eligibleGdm.status, 200, JSON.stringify(eligibleGdm.body));
  const eligibleGdmId = String((eligibleGdm.body.conversation as Row).conversation_id);
  const eligibleGdmRootId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, until, created_at)
      VALUES (${eligibleGdmRootId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'user', ${seatSec.principal}::uuid, 'ask', 'Addressed group DM root initially visible to all live members', statement_timestamp() + interval '1 day', statement_timestamp())
    `;
    await tx`
      INSERT INTO swarm.signal_recipients (signal_id, workspace_id, position, recipient_agent_principal_id, created_at)
      VALUES
        (${eligibleGdmRootId}::uuid, ${workspace}::uuid, 0, ${seatSec.principal}::uuid, statement_timestamp()),
        (${eligibleGdmRootId}::uuid, ${workspace}::uuid, 1, ${seatLead.principal}::uuid, statement_timestamp())
    `;
    await tx`
      INSERT INTO swarm.conversation_signals (workspace_id, conversation_id, signal_id, audience, created_at)
      VALUES (${workspace}::uuid, ${eligibleGdmId}::uuid, ${eligibleGdmRootId}::uuid, 'addressed', statement_timestamp())
    `;
  });
  const gdmOpened = await openReviewCheck(target, owner.jwt, workspace, {
    repo: "yulanventures/commonswarm",
    ref: "710-gdm-loss",
    headSha: head,
    requiredSeats: [{ kind: "agent", id: seatSec.principal }],
    threadRootId: eligibleGdmRootId,
  });
  assert.equal(gdmOpened.review_check.root_audience, "addressed");

  // Add outsider to eligibleGdm after open so a live member can no longer read eligibleGdmRootId.
  await sql`
    INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_agent_principal_id, joined_at)
    VALUES (${eligibleGdmId}::uuid, ${workspace}::uuid, ${outsider.principal}::uuid, statement_timestamp())
    ON CONFLICT DO NOTHING
  `;

  // Final pass stamp must STILL succeed cleanly (no deferred-trigger abort) and skip the DM-wide fulfillment note!
  const gdmFinalStamp = await stampReviewCheck(target, seatSec.token, workspace, {
    checkId: gdmOpened.review_check.check_id,
    headSha: head,
    verdict: "pass",
  });
  assert.equal(gdmFinalStamp.satisfied_now, true);
  assert.equal(gdmFinalStamp.review_check.satisfied_head_sha, head);
  assert.equal(gdmFinalStamp.satisfied_signal_id, null, "loss of Step 2b DM-thread eligibility must skip the DM-wide fulfillment note without aborting the stamp");
  await assert.rejects(
    readReviewChecks(target, outsider.token, workspace, { checkId: gdmOpened.review_check.check_id }),
    (error: unknown) => error instanceof ReviewCheckError && error.code === "not_found" && error.status === 404,
  );
});
