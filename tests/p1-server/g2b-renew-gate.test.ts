/** Rehearses the item G lane 2b release gate against the served local stack. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { AGENT_CREDENTIAL_MESSAGE } from "../../src/cloud/agent-credential-input.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let functionEnvDir: string | undefined;
let seedDir: string | undefined;

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  return parsed as LocalEnvironment;
}

async function createUser(): Promise<{ id: string; jwt: string }> {
  const email = `synth-g2b-renew-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session?.access_token);
  return { id: created.data.user.id, jwt: signedIn.data.session.access_token };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 3 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  functionEnvDir = mkdtempSync(join(tmpdir(), "cswarm-g2b-renew-edge-"));
  const envFile = join(functionEnvDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\n", { mode: 0o600 });
  functionProcess = spawn(
    "supabase",
    ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const capture = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
  };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  const bootDeadline = Date.now() + 60_000;
  while (!functionLogs.includes("Serving functions on")) {
    if (Date.now() > bootDeadline) throw new Error(`functions serve never booted:\n${functionLogs.slice(-3000)}`);
    await delay(250);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `command function logs:\n${functionLogs.slice(-4000)}`,
  });
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => functionProcess.once("close", () => resolve(true)));
    functionProcess.kill();
    if (!await Promise.race([exited, delay(2_000).then(() => false)]) && functionProcess.exitCode === null) {
      functionProcess.kill("SIGKILL");
    }
  }
  await sql?.end({ timeout: 5 });
  if (functionEnvDir) rmSync(functionEnvDir, { recursive: true, force: true });
  if (seedDir) rmSync(seedDir, { recursive: true, force: true });
});

test("box renew gate keeps every sample and leaves then releases its lease", { timeout: 90_000 }, async () => {
  const owner = await createUser();
  const workspaceId = randomUUID();
  const deviceId = randomUUID();
  const principalId = randomUUID();
  const runId = randomUUID();
  const tokenId = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'SynthG2bRenewOwner')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${deviceId}::uuid, ${owner.id}::uuid, 'synth-g2b-renew-device')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspaceId}::uuid, 'SynthG2bRenewWS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}::uuid, ${owner.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principalId}::uuid, ${workspaceId}::uuid, ${owner.id}::uuid, 'synth-g2b-renew-seat')`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${runId}::uuid, ${principalId}::uuid, ${deviceId}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens
      (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${tokenId}::uuid, ${principalId}::uuid, ${runId}::uuid,
        ${tx.json(["post_signal"])}::jsonb, ${createHash("sha256").update(token).digest()},
        ${expiresAt}::timestamptz, ${randomUUID()}::uuid)`;
  });

  seedDir = mkdtempSync(join(tmpdir(), "cswarm-g2b-renew-seed-"));
  chmodSync(seedDir, 0o700);
  const credential = {
    message: AGENT_CREDENTIAL_MESSAGE,
    status: "accepted",
    principal_id: principalId,
    token_id: tokenId,
    run_id: runId,
    agent_token: token,
    expires_at: expiresAt,
  };
  writeFileSync(join(seedDir, "credential.json"), JSON.stringify(credential), { mode: 0o600 });
  writeFileSync(join(seedDir, "principal.json"), JSON.stringify({
    message: "Agent identity created.", status: "accepted", principal_id: principalId,
  }), { mode: 0o600 });
  writeFileSync(join(seedDir, "anon-key.txt"), `${local.ANON_KEY}\n`, { mode: 0o600 });

  const wrapper = fileURLToPath(new URL(
    "../../deploy/release-proofs/item-g2b/g2b-renew-gate.sh",
    import.meta.url,
  ));
  const run = spawnSync("bash", [wrapper, process.cwd(), seedDir, local.API_URL, workspaceId], {
    encoding: "utf8",
    env: { ...process.env, G2B_RENEW_GATE_ROUNDS: "3" },
    timeout: 60_000,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, new RegExp(`G2B_PRINCIPAL_ID=${principalId}`));
  assert.match(run.stdout, /GATE PASS/);
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const report = JSON.parse(readFileSync(join(seedDir, "renew-gate.json"), "utf8")) as {
    status: string;
    thresholds: {
      renew_timeout_ms: number;
      renew_timeout_source: string;
      check_budget_ms: number;
      check_budget_source: string;
      check_budget_is_gate: boolean;
    };
    renew: { n: number; first_call_ms: number; succeeded: number; calls: Array<{ ok: boolean }> };
    check: { n: number; first_call_ms: number; calls: Array<{ ok: boolean }> };
  };
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.thresholds, {
    renew_timeout_ms: 15_000,
    renew_timeout_source: "src/cloud/wake-lease.ts:64",
    check_budget_ms: 3_900,
    check_budget_source: "src/cloud/agent-check-budget.ts:22",
    check_budget_is_gate: false,
  });
  assert.equal(report.renew.n, 3);
  assert.equal(typeof report.renew.first_call_ms, "number");
  assert.equal(report.renew.succeeded, 3);
  assert.equal(report.renew.calls.length, 3);
  assert.equal(report.renew.calls.every((call) => call.ok), true);
  assert.equal(report.check.n, 3);
  assert.equal(typeof report.check.first_call_ms, "number");
  assert.equal(report.check.calls.length, 3);
  assert.equal(report.check.calls.every((call) => call.ok), true);
  assert.equal(statSync(join(seedDir, "renew-gate.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(seedDir, "renew-gate.md")).mode & 0o777, 0o600);

  const held = await sql<{ watcher_id: string; generation: number }[]>`
    SELECT watcher_id::text, generation FROM swarm.agent_wake_leases
    WHERE workspace_id = ${workspaceId}::uuid AND principal_id = ${principalId}::uuid`;
  assert.equal(held.length, 1);
  assert.equal(held[0]?.generation, 1);

  const released = spawnSync("bash", [wrapper, process.cwd(), seedDir, local.API_URL, workspaceId, "--release"], {
    encoding: "utf8",
    env: { ...process.env, G2B_RENEW_GATE_ROUNDS: "3" },
    timeout: 30_000,
  });
  assert.ifError(released.error);
  assert.equal(released.status, 0, `${released.stdout}\n${released.stderr}`);
  assert.match(released.stdout, /LEASE RELEASED/);
  assert.doesNotMatch(`${released.stdout}${released.stderr}`, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const gone = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM swarm.agent_wake_leases
    WHERE workspace_id = ${workspaceId}::uuid AND principal_id = ${principalId}::uuid`;
  assert.equal(gone[0]?.count, 0);
});
