/** Local-edge comparison of the real check path and CLI inbox --since. No migrations are applied. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { checkAgentMessages, type AgentCheckResult } from "../../src/cloud/agent-check.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

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
  root = mkdtempSync(join(tmpdir(), "cswarm-item-k-server-"));
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
  functionProcess.stdout?.on("data", () => {});
  functionProcess.stderr?.on("data", () => {});
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
}, { timeout: 90_000 });

after(async () => {
  if (functionProcess?.pid && functionProcess.exitCode === null) {
    try { process.kill(-functionProcess.pid, "SIGTERM"); } catch { /* already stopped */ }
    await Promise.race([new Promise(resolve => functionProcess!.once("close", resolve)), delay(2_000)]);
    if (functionProcess.exitCode === null) {
      try { process.kill(-functionProcess.pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  }
  await sql?.end({ timeout: 5 });
  if (root) rmSync(root, { recursive: true, force: true });
}, { timeout: 10_000 });

test("check and inbox --since return the same directed ask across timestamps, filters, and default paging", { timeout: 120_000 }, async () => {
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
  // Fifty newer directed asks used to push this ask out of inbox's newest-50 default.
  for (let index = 0; index < 50; index += 1) await postAsk(`item-k newer ${index}`);
  assert.ok(inbox(milli).some(row => row.id === ask), "--since must drain past the first page");
  assert.equal(inbox(milli).length, 51);
  assert.equal(inbox(milli, ["--limit", "50"]).some(row => row.id === ask), false,
    "an explicit limit still bounds the result");
  assert.match(inboxPayload(milli, ["--limit", "50"]).notice ?? "", /may omit older matching inbox messages/);
});
