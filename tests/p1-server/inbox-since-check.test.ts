/** Local-edge comparison of the real check path and CLI inbox --since. No migrations are applied. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { checkAgentMessages, type AgentCheckResult } from "../../src/cloud/agent-check.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { readSignals } from "../../src/cloud/signals.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";
import { createLaneTempHome, removeLaneTempHome } from "../support/lane-temp-home.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let root: string;
let workspace: string;
let owner: { id: string; jwt: string };
let principal: string;
let token: string;
let tokenId: string;
let runId: string;
let profilePath: string;
let credentialFile: string;
let functionReady = false;

function localEnvironment(): Local {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  })) as Partial<Local>;
  assert.ok(parsed.API_URL?.startsWith("http://127.0.0.1:"));
  assert.ok(parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  assert.equal(new URL(parsed.DB_URL).hostname, "127.0.0.1");
  return parsed as Local;
}

async function createUser(): Promise<{ id: string; jwt: string }> {
  const email = `synth-inbox-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signed.error);
  assert.ok(signed.data.session?.access_token);
  return { id: created.data.user.id, jwt: signed.data.session.access_token };
}

async function postAsk(body: string, untilMs?: number): Promise<string> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${owner.jwt}`, "content-type": "application/json" },
    body: JSON.stringify({ command_id: randomUUID(), client_version: "0.1.0",
      workspace_id: workspace, stream: { kind: "workspace" },
      command: { kind: "post_signal", signal_kind: "ask", body,
        to_user_id: null, about: "item-k", to_agent_principal_id: principal,
        in_reply_to: null, ...(untilMs ? { until_ms: untilMs } : {}) } }),
  });
  const result = await response.json() as { signal?: { id?: string }; error?: string };
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(typeof result.signal?.id, "string");
  return result.signal!.id!;
}

function inboxPayload(since: string, extra: string[] = []): { signals: { id: string }[]; notice?: string } {
  const result = spawnSync(process.execPath, ["dist/cli.js", "inbox", "--url", local.API_URL,
    "--anon-key", local.ANON_KEY, "--workspace-id", workspace,
    "--agent-token-file", credentialFile, "--since", since, ...extra, "--json"], {
    cwd: resolve("."), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"),
      SWARM_AGENT_STATE_DIR: join(root, "state") },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { signals: { id: string }[]; notice?: string };
}

function inbox(since: string, extra: string[] = []): { id: string }[] {
  return inboxPayload(since, extra).signals;
}

before(async () => {
  local = localEnvironment();
  root = createLaneTempHome("item-k-server-");
  const envFile = join(root, "edge.env");
  writeFileSync(envFile, "SWARM_ENV=test\n", { mode: 0o600 });
  sql = postgres(local.DB_URL, { prepare: false, max: 3 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(), env: { ...process.env, SWARM_ENV: "test" },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let startupOutput = "";
  let startupSeen = false;
  const observeStartup = (chunk: Buffer) => {
    startupOutput = (startupOutput + chunk.toString("utf8")).slice(-1_000);
    startupSeen ||= startupOutput.includes("Serving functions on");
  };
  functionProcess.stdout?.on("data", observeStartup);
  functionProcess.stderr?.on("data", observeStartup);
  const bootDeadline = Date.now() + 60_000;
  while (!startupSeen) {
    if (Date.now() >= bootDeadline || functionProcess.exitCode !== null) {
      throw new Error("local functions serve did not start");
    }
    await delay(250);
  }
  await awaitFunctionRunning({ url: `${local.API_URL}/functions/v1/command`, fetcher: fetch,
    timeoutMs: 30_000, sleep: ms => delay(ms), now: () => Date.now(),
    diagnostics: () => "local command function was not ready" });
  functionReady = true;
  owner = await createUser();
  workspace = randomUUID();
  const device = randomUUID();
  principal = randomUUID();
  runId = randomUUID();
  tokenId = randomUUID();
  token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async tx => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner.id}::uuid, 'SynthInboxOwner')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner.id}::uuid, 'synth-inbox-device')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'SynthInboxWorkspace', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'SynthInboxAgent')`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${runId}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${tokenId}::uuid, ${principal}::uuid, ${runId}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  const dir = join(root, "profile");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  credentialFile = join(dir, "credential.json");
  profilePath = join(dir, "profile.json");
  writeFileSync(credentialFile, JSON.stringify({ message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted", principal_id: principal, token_id: tokenId, run_id: runId,
    agent_token: token, expires_at: "2099-01-01T00:00:00.000Z" }), { mode: 0o600 });
  writeFileSync(profilePath, JSON.stringify({ version: 1, url: local.API_URL,
    anon_key: local.ANON_KEY, workspace_id: workspace, principal_id: principal,
    credential_file: credentialFile }), { mode: 0o600 });
}, { timeout: 120_000 });

after(async () => {
  if (functionProcess?.pid && functionProcess.exitCode === null) {
    try { process.kill(-functionProcess.pid, "SIGTERM"); } catch { /* already stopped */ }
    await Promise.race([new Promise(resolve => functionProcess!.once("close", resolve)), delay(2_000)]);
    if (functionProcess.exitCode === null) {
      try { process.kill(-functionProcess.pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  }
  await sql?.end({ timeout: 5 });
  if (root) removeLaneTempHome(root);
}, { timeout: 10_000 });

test("check and inbox --since return the same directed ask across timestamps, filters, and default paging", { timeout: 240_000 }, async () => {
  assert.equal(functionReady, true);
  const ask = await postAsk("item-k directed ask");
  const [created] = await sql<{ created_at: string }[]>`SELECT created_at::text FROM swarm.signals WHERE id = ${ask}::uuid`;
  assert.ok(created);
  const micro = created.created_at.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const milli = new Date(micro).toISOString();
  let checked: AgentCheckResult | undefined;
  await checkAgentMessages({ profilePath, present: async result => { checked = result; } });
  assert.ok(checked?.messages.some(message => message.id === ask));
  for (const since of [milli, micro, new Date(Date.parse(micro) + 2 * 3600_000).toISOString().replace("Z", "+02:00")]) {
    assert.ok(inbox(since).some(row => row.id === ask), `inbox omitted ask at ${since}`);
  }
  assert.ok(inbox(milli, ["--about", "item-k"]).some(row => row.id === ask));
  assert.ok(inbox(milli, ["--kind", "ask"]).some(row => row.id === ask));
  // Both default paths hide an expired ask; explicit include-stale changes only inbox.
  const stale = await postAsk("item-k stale ask", 1000);
  await delay(1200);
  const staleSince = new Date(Date.now() - 60_000).toISOString();
  let staleCheck: AgentCheckResult | undefined;
  await checkAgentMessages({ profilePath, present: async result => { staleCheck = result; } });
  assert.equal(staleCheck?.messages.some(message => message.id === stale), false);
  assert.equal(inbox(staleSince).some(row => row.id === stale), false);
  assert.ok(inbox(staleSince, ["--include-stale"]).some(row => row.id === stale));
  // One hundred newer asks cross both the former newest-50 default and a 100-row cursor page.
  for (let index = 0; index < 100; index += 1) await postAsk(`item-k newer ${index}`);
  const formerDefault = await readSignals(cloudTarget(local.API_URL, local.ANON_KEY),
    { kind: "agent", token }, { workspaceId: workspace, inbox: true, since: milli, limit: 50 });
  assert.equal(formerDefault.length, 50);
  assert.equal(formerDefault.some(row => row.id === ask), false,
    "the former newest-50 read must reproduce the mismatch");
  assert.ok(inbox(milli).some(row => row.id === ask), "--since must drain past the first page");
  assert.ok(inbox(milli, ["--wait", "1"]).some(row => row.id === ask), "--wait must use the same complete read");
  assert.equal(inbox(milli).length, 101);
  assert.equal(inbox(milli, ["--limit", "50"]).some(row => row.id === ask), false,
    "an explicit limit still bounds the result");
  assert.match(inboxPayload(milli, ["--limit", "50"]).notice ?? "", /may omit older matching inbox messages/);
  const naive = spawnSync(process.execPath, ["dist/cli.js", "inbox", "--url", local.API_URL,
    "--anon-key", local.ANON_KEY, "--workspace-id", workspace, "--agent-token-file", credentialFile,
    "--since", "2026-09-25T12:00:00", "--json"], {
    cwd: resolve("."), encoding: "utf8", timeout: 20_000, env: { ...process.env, HOME: root },
  });
  assert.equal(naive.status, 0, naive.stderr);
  const naiveRows = (JSON.parse(naive.stdout) as { signals: { id: string }[] }).signals;
  const offsetRows = inbox("2026-09-25T12:00:00+00:00");
  process.stdout.write(`${JSON.stringify({ case: "naive_since_compared_with_offset", naiveCount: naiveRows.length,
    offsetCount: offsetRows.length, naiveContainsAsk: naiveRows.some(row => row.id === ask),
    offsetContainsAsk: offsetRows.some(row => row.id === ask) })}\n`);
  const wrong = spawnSync(process.execPath, ["dist/cli.js", "inbox", "--url", local.API_URL,
    "--anon-key", local.ANON_KEY, "--workspace-id", randomUUID(), "--agent-token-file", credentialFile,
    "--since", milli, "--json"], {
    cwd: resolve("."), encoding: "utf8", timeout: 20_000, env: { ...process.env, HOME: root },
  });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /workspace/i);
});
