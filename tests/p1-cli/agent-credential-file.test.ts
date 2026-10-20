import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT_CREDENTIAL_OPTIONAL_FIELDS,
  AGENT_CREDENTIAL_REQUIRED_FIELDS,
  parseAgentCredentialInput,
} from "../../src/cloud/agent-credential-input.js";

/* Reached by `npm run test:p1-cli` through its tests/p1-cli glob. */

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "11111111-1111-4111-8111-111111111111";
const TOKEN_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = `swm_agt_${"S".repeat(43)}`;
const MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: MESSAGE,
    status: "accepted",
    principal_id: PRINCIPAL,
    token_id: TOKEN_ID,
    run_id: RUN_ID,
    agent_token: TOKEN,
    expires_at: "2099-09-02T22:00:00.000Z",
    ...overrides,
  };
}

async function runCli(credentialPath: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "whoami",
    "--agent-token-file",
    credentialPath,
    "--url",
    "http://127.0.0.1:9",
    "--anon-key",
    "public-anon",
    "--workspace-id",
    WORKSPACE,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

const faults = [
  {
    code: "agent_credential_invalid_json",
    content: `{"leak":"${TOKEN}"`,
    found: /contains text that is not valid JSON/,
  },
  {
    code: "agent_credential_not_object",
    content: JSON.stringify([TOKEN]),
    found: /contains a JSON array instead of a JSON object/,
  },
  {
    code: "agent_credential_missing_agent_token",
    content: JSON.stringify({ principal_id: TOKEN }),
    found: /is missing "agent_token"/,
  },
  {
    code: "agent_credential_invalid_agent_token",
    content: JSON.stringify(artifact({ agent_token: `wrong-${TOKEN}` })),
    found: /has "agent_token" as a string that is not a swm_agt_ credential/,
  },
  {
    code: "agent_credential_fields_invalid",
    content: JSON.stringify({
      workspace_id: WORKSPACE,
      agent_id: PRINCIPAL,
      agent_name: "Invented schema",
      agent_token: TOKEN,
    }),
    found: /has 3 unrecognized fields and is missing required fields/,
  },
] as const;

for (const fault of faults) {
  test(`agent credential file reports ${fault.code} without the credential`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cswarm-credential-fault-"));
    const credentialPath = join(directory, "agent.json");
    try {
      await writeFile(credentialPath, fault.content, { mode: 0o600 });
      const result = await runCli(credentialPath);

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(`\\[${fault.code}\\]`));
      assert.ok(
        result.stderr.includes(`agent credential file ${credentialPath}`),
        result.stderr,
      );
      assert.match(result.stderr, fault.found);
      assert.match(
        result.stderr,
        /It must be the JSON line CommonSwarm minted, copied unchanged: message, status, principal_id, token_id, run_id, agent_token \(expires_at is optional\)\./,
      );
      assert.ok(
        result.stderr.includes(
          `Next step: copy the minted JSON line again and replace ${credentialPath}.`,
        ),
        result.stderr,
      );
      assert.doesNotMatch(result.stderr, new RegExp(TOKEN));
      assert.doesNotMatch(result.stderr, /Invented schema/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("credential contract keeps every minted required field and one optional field", () => {
  assert.deepEqual(AGENT_CREDENTIAL_REQUIRED_FIELDS, [
    "message",
    "status",
    "principal_id",
    "token_id",
    "run_id",
    "agent_token",
  ]);
  assert.deepEqual(AGENT_CREDENTIAL_OPTIONAL_FIELDS, ["expires_at"]);
});

test("agent-token-only error copy names every field reported missing", () => {
  assert.throws(
    () => parseAgentCredentialInput(
      JSON.stringify({ agent_token: TOKEN }),
      { kind: "file", path: "/synthetic/agent.json" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const missingClause = error.message.match(
        /is missing required fields (?<fields>[^.]+)\. It must/,
      );
      const contractClause = error.message.match(
        /copied unchanged: (?<fields>[^()]+) \(expires_at is optional\)\./,
      );
      assert.ok(missingClause?.groups, error.message);
      assert.ok(contractClause?.groups, error.message);

      const missingFields = [...missingClause.groups.fields.matchAll(/"([^"]+)"/g)]
        .map((match) => match[1]);
      const namedFields = contractClause.groups.fields.split(", ");
      assert.deepEqual(
        missingFields,
        AGENT_CREDENTIAL_REQUIRED_FIELDS.filter((field) => field !== "agent_token"),
      );
      for (const field of missingFields) {
        assert.ok(namedFields.includes(field), `error copy omits missing field ${field}`);
      }
      return true;
    },
  );
});

test("full synthetic minted shape passes the credential parser", () => {
  const parsed = parseAgentCredentialInput(
    JSON.stringify(artifact()),
    { kind: "file", path: "/synthetic/agent.json" },
  );

  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.principalId, PRINCIPAL);
  assert.equal(parsed.tokenId, TOKEN_ID);
  assert.equal(parsed.runId, RUN_ID);
  assert.equal(parsed.expiresAt, Date.parse("2099-09-02T22:00:00.000Z"));
  assert.equal(parsed.durable, true);
});


// Opt-in real M3 boundary gate. Root runs this only in its assigned local-stack
// slot after integrating the backend. No server authority is replaced by mocks.
// Requires M3 to remove technical-expiry/idle preflights for eligible permanent
// families and recover an exact expired unused child under a fresh request id.
// The registered Linux/server gate must execute this; its default skip is no proof.
test("M3 agent continuity at the real command, secure-store and listener boundaries", {
  skip: process.env.CSWARM_AGENT_CLIENT_M3 !== "1",
  timeout: 180_000,
}, async (t) => {
  const { default: postgres } = await import("postgres");
  const { cloudTarget, readEndpoint } = await import("../../src/cloud/config.js");
  const { AgentCredentialSession, RenewalCredentialCheckError, RenewalReauthorisationRequired,
    RenewalRevoked, RenewalSuspended, RenewalSuperseded, RenewalRefused, RenewalRetryError, newRenewalCommandId, requestSuccessor } = await import("../../src/cloud/renewal.js");
  const { agentCredentialStore, credentialLineageKey } = await import("../../src/cloud/agent-credential.js");
  const { ThinCommandClient } = await import("../../src/cloud/command-client.js");
  const { runListenerRuntime, NullListenerModel } = await import("../../src/listener/runtime.js");
  const { FileListenerEffectStore } = await import("../../src/listener/file-store.js");
  const { FilePendingMainQueue } = await import("../../src/listener/main-routing.js");
  const { openListenerDeliveryJournal } = await import("../../src/listener/delivery-journal.js");
  const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  })) as { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
  for (const url of [local.API_URL, local.DB_URL]) {
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname), "local stack required");
  }
  const target = cloudTarget(local.API_URL, local.ANON_KEY);
  const sql = postgres(local.DB_URL, { prepare: false, max: 1, connect_timeout: 5 });
  const directory = await mkdtemp(join(tmpdir(), "cswarm-client-m3-"));
  async function fixture(policy: "permanent" | "elapsed" | "revoked" | "security" = "permanent") {
    const user = randomUUID(), device = randomUUID(), workspace = randomUUID();
    const principal = randomUUID(), run = randomUUID(), grant = randomUUID(), tokenId = randomUUID();
    const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
    await sql`INSERT INTO auth.users (id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES (${user}::uuid, 'authenticated', 'authenticated', ${`client-${user}@example.test`}, '',
        clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp())`;
    await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${user}::uuid, 'Client continuity')`;
    await sql`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${user}::uuid, 'client-test')`;
    await sql`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'Client continuity', ${user}::uuid)`;
    await sql`INSERT INTO swarm.streams (stream_id, workspace_id, kind, repo_mapping_id)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace', NULL)`;
    await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${user}::uuid, 'owner')`;
    await sql`INSERT INTO swarm.agent_principals (principal_id, workspace_id, name, owner_user_id)
      VALUES (${principal}::uuid, ${workspace}::uuid, 'client-test', ${user}::uuid)`;
    await sql`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    // Age both technical expiry and measured idle past 30d; the canonical policy
    // is NULL unless this case deliberately selects an elapsed owner deadline.
    await sql`INSERT INTO swarm.renewal_grants (renewal_grant_id, workspace_id, principal_id, run_id,
      kind, max_successors, successors_used, horizon_expires_at, bound_device_id, created_by, created_at,
      last_used_at, connection_expires_at)
      VALUES (${grant}::uuid, ${workspace}::uuid, ${principal}::uuid, ${run}::uuid, 'standing', NULL, 0, NULL,
        ${device}::uuid, ${user}::uuid, clock_timestamp() - interval '32 days', clock_timestamp() - interval '31 days',
        ${policy === "elapsed" ? new Date(Date.now() - 86_400_000) : null}::timestamptz)`;
    const expiresAt = Date.now() - 31 * 86_400_000;
    await sql`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, task_id, epoch, scopes,
      token_hash, issued_at, expires_at, lineage_id, renewal_grant_id)
      VALUES (${tokenId}::uuid, ${principal}::uuid, ${run}::uuid, ${randomUUID()}::uuid, 1, '["post_signal","create"]'::jsonb,
        ${createHash("sha256").update(token).digest()}, ${new Date(expiresAt - 3_600_000)}, ${new Date(expiresAt)},
        ${randomUUID()}::uuid, ${grant}::uuid)`;
    if (policy === "revoked") await sql`UPDATE swarm.renewal_grants SET revoked_at = clock_timestamp(), revoked_by = ${user}::uuid WHERE renewal_grant_id = ${grant}::uuid`;
    if (policy === "security") await sql`UPDATE swarm.renewal_grants SET suspended_at = clock_timestamp() WHERE renewal_grant_id = ${grant}::uuid`;
    const presented = { token, tokenId, principalId: principal, runId: run, expiresAt };
    const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(token), stateDirectory: directory });
    return { user, device, workspace, principal, run, grant, tokenId, token, presented, store };
  }
  async function use(workspace: string, bearer: string): Promise<number> {
    const response = await fetch(readEndpoint(target), {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, apikey: target.anonKey, "content-type": "application/json" },
      body: JSON.stringify({ resource: "members", workspace_id: workspace }), signal: AbortSignal.timeout(15_000),
    });
    await response.arrayBuffer();
    return response.status;
  }
  try {
    await t.test("real mint and MCP connect commit first use before export/completion and survive idle", async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const { createServer } = await import("node:http");
      const { credentialStore } = await import("../../src/cloud/storage.js");
      const { connectMcp } = await import("../../src/cloud/mcp-connect.js");
      const { readAgentProfile, openProfileCredential } = await import("../../src/cloud/agent-profile.js");
      const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const f = await fixture();
      const foreign = await fixture(); // W2 has a real owner and agent to protect.
      assert.notEqual(foreign.workspace, f.workspace);
      async function confirmOwner(bearer: string, principal: string) {
        const response = await fetch(readEndpoint(target), {
          method: "POST", headers: { authorization: `Bearer ${bearer}`, apikey: target.anonKey, "content-type": "application/json" },
          body: JSON.stringify({ resource: "members", workspace_id: f.workspace }), signal: AbortSignal.timeout(15_000),
        });
        assert.equal(response.status, 200, "same valid token must read its own W1");
        const payload = await response.json();
        assert.equal(payload.identity?.credential_valid, true);
        assert.equal(payload.identity?.workspace_id, f.workspace);
        assert.equal(payload.identity?.principal_id, principal);
        assert.equal(payload.identity?.owner_user_id, f.user);
        assert.ok(payload.agents.some((agent: { principal_id: string; owner_user_id: string }) =>
          agent.principal_id === principal && agent.owner_user_id === f.user));
        assert.ok(!payload.agents.some((agent: { principal_id: string }) => agent.principal_id === foreign.principal));
      }
      const password = `T-${randomBytes(24).toString("base64url")}!`;
      const changed = await admin.auth.admin.updateUserById(f.user, { password, email_confirm: true });
      assert.ifError(changed.error);
      const login = await admin.auth.signInWithPassword({ email: `client-${f.user}@example.test`, password });
      assert.ifError(login.error);
      assert.ok(login.data.session);
      const minted: Array<{ tokenId: string; unused: boolean }> = [];
      const proofBearers: string[] = [];
      const mintReads: Array<{ status: number; error: unknown }> = [];
      let mintPolicy: "live" | "revoked" | "elapsed" | "membership" | "foreign" = "live";
      // Only fixture state changes between real issuance and real completion read.
      // Each refusal is paired below with a fresh live issuance/read, in this run.
      async function fence(tokenId: string, policy: typeof mintPolicy) {
        if (policy === "revoked") await sql`UPDATE swarm.renewal_grants SET revoked_at = clock_timestamp(), revoked_by = ${f.user}::uuid
          WHERE renewal_grant_id = (SELECT renewal_grant_id FROM swarm.agent_tokens WHERE token_id = ${tokenId}::uuid)`;
        if (policy === "elapsed") await sql`UPDATE swarm.renewal_grants SET connection_expires_at = clock_timestamp() - interval '1 second'
          WHERE renewal_grant_id = (SELECT renewal_grant_id FROM swarm.agent_tokens WHERE token_id = ${tokenId}::uuid)`;
        if (policy === "membership") await sql`UPDATE swarm.memberships SET revoked_at = clock_timestamp()
          WHERE workspace_id = ${f.workspace}::uuid AND user_id = ${f.user}::uuid`;
      }
      // Forward to real M3 unchanged. Inspect its database before forwarding the
      // mint reply; no mock decides identity, first-use or renewal eligibility.
      const proxy = createServer(async (request, response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = JSON.parse(raw);
          // Change only the requested workspace after issuance; preserve the real bearer.
          const forwarded = body.resource === "members" && mintPolicy === "foreign"
            ? JSON.stringify({ ...body, workspace_id: foreign.workspace }) : raw;
          const upstream = await fetch(`${target.url}${request.url}`, { method: "POST",
            headers: { "content-type": "application/json", apikey: target.anonKey,
              ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) },
            body: forwarded, signal: AbortSignal.timeout(15_000) });
          const payload = await upstream.json() as Record<string, unknown>;
          if (body.command?.kind === "mint_agent_token" && typeof payload.token_id === "string") {
            const [row] = await sql<{ first_used_at: Date | null }[]>`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id = ${payload.token_id}::uuid`;
            minted.push({ tokenId: payload.token_id, unused: row?.first_used_at === null });
            await fence(payload.token_id, mintPolicy);
          }
          if (body.resource === "members") {
            const readError = payload.error;
            if (mintPolicy === "foreign") {
              assert.equal(JSON.parse(forwarded).workspace_id, foreign.workspace);
              assert.equal(upstream.status, 200);
              assert.deepEqual(payload, { members: [], agents: [] }, "no W2 rows, content or valid foreign identity");
            }
            proofBearers.push(request.headers.authorization ?? "");
            mintReads.push({ status: upstream.status, error: readError });
          }
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        } catch { response.writeHead(502).end(); }
      });
      await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
      const address = proxy.address();
      assert.ok(address && typeof address === "object");
      const mintTarget = cloudTarget(`http://127.0.0.1:${address.port}`, local.ANON_KEY);
      // Root runs this only in its isolated Linux lane. Never replace an
      // existing human record, and never alter HOME to isolate the test.
      const humanStore = await credentialStore({ target: mintTarget, forceFile: true, platform: "linux", warn: () => undefined });
      assert.equal(await humanStore.read(), null, "fresh local proxy must have no existing human state");
      await humanStore.write({ version: 1, refreshToken: login.data.session.refresh_token,
        generation: 0, userId: f.user, deviceId: f.device });
      try {
        async function mint() {
          const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "token", "mint",
            "--url", mintTarget.url, "--anon-key", mintTarget.anonKey, "--force-file-store",
            "--workspace-id", f.workspace, "--principal-id", f.principal, "--run-id", randomUUID(),
            "--task-id", randomUUID(), "--epoch", "1", "--ttl-ms", "3600000"], {
            env: { ...process.env, SWARM_CLOUD_URL: "", SWARM_CLOUD_ANON_KEY: "", SWARM_CLOUD_WORKSPACE_ID: "" },
            stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
          });
          const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
          let output = "", error = "";
          child.stderr.on("data", chunk => { error += chunk; });
          for await (const chunk of child.stdout) output += chunk;
          return { code: await exited, output, error };
        }
        const initial = await mint();
        assert.equal(initial.code, 0, "real mint must authenticate before exporting");
        const artifact = JSON.parse(initial.output) as { token_id: string; agent_token: string; expires_at: string };
        assert.deepEqual(minted, [{ tokenId: artifact.token_id, unused: true }]);
        assert.deepEqual(proofBearers, [`Bearer ${artifact.agent_token}`]);
        assert.deepEqual(mintReads, [{ status: 200, error: undefined }]);
        const [used] = await sql<{ first_used_at: Date | null }[]>`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id = ${artifact.token_id}::uuid`;
        assert.ok(used.first_used_at, "CLI export follows committed first use");
        // Real exported mint artifact, idle >1h: age technical dates only.
        // first_used_at remains the actual committed read, never a synthetic stamp.
        await sql`UPDATE swarm.agent_tokens SET issued_at = issued_at - interval '2 hours', expires_at = expires_at - interval '2 hours'
          WHERE token_id = ${artifact.token_id}::uuid`;
        await sql`UPDATE swarm.renewal_grants SET last_used_at = clock_timestamp() - interval '2 hours'
          WHERE renewal_grant_id = (SELECT renewal_grant_id FROM swarm.agent_tokens WHERE token_id = ${artifact.token_id}::uuid)`;
        const aged = { ...artifact, expires_at: new Date(Date.parse(artifact.expires_at) - 7_200_000).toISOString() };
        const artifactPath = join(directory, "idle-minted.json");
        await writeFile(artifactPath, JSON.stringify(aged), { mode: 0o600 });
        const presented = parseAgentCredentialInput(await readFile(artifactPath, "utf8"), { kind: "file", path: artifactPath });
        const store = await agentCredentialStore({ target: mintTarget, lineageKey: credentialLineageKey(presented.token), stateDirectory: directory });
        const session = await AgentCredentialSession.open({ target: mintTarget, workspaceId: f.workspace, presented, store });
        const successor = await session.bearer();
        assert.notEqual(successor, artifact.agent_token);
        assert.equal((await store.read())?.generation, 1);
        assert.equal(await use(f.workspace, successor), 200);
        for (const policy of ["revoked", "elapsed", "membership", "foreign"] as const) {
          mintPolicy = policy;
          const beforeMint: number = minted.length;
          const beforeRead: number = mintReads.length;
          try {
            const denied = await mint();
            assert.equal(denied.code, 1, `${policy}: completion must fail`);
            assert.equal(denied.output, "", "no credential export on refused real read");
            assert.equal(minted.length, beforeMint + 1, "failed verification never remints");
            assert.deepEqual(mintReads.slice(beforeRead), [{ status: policy === "foreign" ? 200 : policy === "membership" ? 403 : 401,
              error: policy === "foreign" ? undefined : policy === "membership" ? "forbidden" : "unauthenticated" }]);
            if (policy === "foreign") {
              assert.match(denied.error, /did not confirm the issued agent and workspace/);
              const authorization = proofBearers.at(-1)!;
              assert.ok(authorization.startsWith("Bearer swm_agt_"));
              await confirmOwner(authorization.slice("Bearer ".length), f.principal);
            }
            assert.match(denied.error, /setup is incomplete/);
            assert.match(denied.error, /fresh-response-only; replay cannot recover it/);
            assert.doesNotMatch(denied.error, /swm_agt_|issued and authenticated/);
          } finally {
            if (policy === "membership") await sql`UPDATE swarm.memberships SET revoked_at = NULL
              WHERE workspace_id = ${f.workspace}::uuid AND user_id = ${f.user}::uuid`;
            mintPolicy = "live";
          }
          const control = await mint();
          assert.equal(control.code, 0, `${policy}: paired real mint control`);
          const live = JSON.parse(control.output) as { agent_token: string };
          assert.equal(mintReads.at(-1)?.status, 200);
          assert.equal(await use(f.workspace, live.agent_token), 200);
        }
      } finally { await humanStore.delete(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }

      const joinResult = await new ThinCommandClient(target).sendConnect({ workspaceId: f.workspace,
        command: { kind: "mint_agent_join_credential", seat_cap: 1, ttl_hours: 1 }, credential: login.data.session.access_token });
      assert.equal(joinResult.response.status, "accepted");
      assert.equal(typeof joinResult.response.join_credential, "string");
      const code = joinResult.response.join_credential!;
      const profilePath = join(directory, "first-use-connect", "profile.json");
      const reads: Array<{ bearer: string; unused: boolean; saved: boolean }> = [];
      let registerCalls = 0;
      const transport: typeof fetch = async (input, init) => {
        const endpoint = new URL(String(input)).pathname;
        if (endpoint === "/functions/v1/h0/register") registerCalls++;
        if (endpoint !== "/functions/v1/read") return fetch(input, init);
        const profile = await readAgentProfile(profilePath);
        const saved = JSON.parse(await readFile(profile.credential_file, "utf8"));
        const [before] = await sql<{ first_used_at: Date | null }[]>`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id = ${saved.token_id}::uuid`;
        reads.push({ bearer: new Headers(init?.headers).get("authorization")!, unused: before.first_used_at === null,
          saved: new Headers(init?.headers).get("authorization") === `Bearer ${saved.agent_token}` });
        const response = await fetch(input, init);
        if (reads.length === 1) { await response.arrayBuffer(); throw new Error("lost reply after real read commit"); }
        return response;
      };
      await assert.rejects(connectMcp({ target, profilePath, readCode: async () => code, fetcher: transport,
        writeCompletion: async () => { throw new Error("crash before completion"); } }), { code: "connect_complete_write_failed" });
      assert.equal(registerCalls, 1);
      assert.deepEqual(reads.map(row => row.unused), [true, false]);
      assert.ok(reads.every(row => row.saved));
      assert.equal(reads[0].bearer, reads[1].bearer);
      const savedProfile = await readAgentProfile(profilePath);
      const root = JSON.parse(await readFile(savedProfile.credential_file, "utf8"));
      const [used] = await sql<{ first_used_at: Date | null }[]>`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id = ${root.token_id}::uuid`;
      assert.ok(used.first_used_at);
      await sql`UPDATE swarm.agent_tokens SET issued_at = issued_at - interval '32 days', expires_at = expires_at - interval '32 days' WHERE token_id = ${root.token_id}::uuid`;
      const { writeSecureJsonFile } = await import("../../src/cloud/storage.js");
      await writeSecureJsonFile(savedProfile.credential_file, JSON.stringify({ ...root,
        expires_at: new Date(Date.parse(root.expires_at) - 32 * 86_400_000).toISOString() }));
      await sql`UPDATE swarm.renewal_grants SET last_used_at = clock_timestamp() - interval '31 days'
        WHERE renewal_grant_id = (SELECT renewal_grant_id FROM swarm.agent_tokens WHERE token_id = ${root.token_id}::uuid)`;
      // Another process/session saves the actual M3 winner before pending rerun.
      const rootBytes = await readFile(savedProfile.credential_file);
      const firstReopen = await openProfileCredential(savedProfile);
      const winnerBearer = await firstReopen.bearer();
      const winnerStore = await agentCredentialStore({ target, lineageKey: credentialLineageKey(root.agent_token) });
      const winner = await winnerStore.read();
      assert.ok(winner && winner.tokenId && winner.generation === 1);
      assert.equal(winner.token, winnerBearer);
      assert.notEqual(winnerBearer, root.agent_token);
      const [beforeResume] = await sql<{ successors: number }[]>`SELECT count(*)::integer AS successors FROM swarm.agent_tokens WHERE predecessor_token_id = ${root.token_id}::uuid`;
      assert.equal(beforeResume.successors, 1);
      const resumeRequests: Array<{ path: string; bearer: string | null; status: number }> = [];
      // Resume the same pending profile after >30d using that saved real winner.
      const resumed = await connectMcp({ target, profilePath, readCode: async () => code,
        fetcher: async (input, init) => {
          const response = await fetch(input, init);
          resumeRequests.push({ path: new URL(String(input)).pathname,
            bearer: new Headers(init?.headers).get("authorization"), status: response.status });
          return response;
        } });
      assert.deepEqual(resumeRequests, [{ path: "/functions/v1/read", bearer: `Bearer ${winnerBearer}`, status: 200 }]);
      assert.deepEqual(await readFile(savedProfile.credential_file), rootBytes);
      assert.deepEqual(await winnerStore.read(), winner);
      const [afterResume] = await sql<{ successors: number; first_used_at: Date | null }[]>`SELECT first_used_at,
        (SELECT count(*)::integer FROM swarm.agent_tokens WHERE predecessor_token_id = ${root.token_id}::uuid) AS successors
        FROM swarm.agent_tokens WHERE token_id = ${winner.tokenId}::uuid`;
      assert.equal(afterResume.successors, beforeResume.successors);
      assert.ok(afterResume.first_used_at, "pending completion really authenticated the saved M3 winner");
      assert.equal(resumed.profile, profilePath);
      assert.equal(JSON.parse(await readFile(savedProfile.credential_file, "utf8")).agent_token, root.agent_token);
      const reopened = await openProfileCredential(await readAgentProfile(profilePath));
      assert.equal(await use(f.workspace, await reopened.bearer()), 200);
      const { CONNECT_PROFILE_FILES } = await import("../../src/cloud/connect-profile-files.js");
      // Distinct from saved-winner adoption above: no session renews this root
      // before connect. Every case starts with real committed first use.
      for (const scenario of ["direct", "membership", "superseded"] as const) {
        const issued = await new ThinCommandClient(target).sendConnect({ workspaceId: f.workspace,
          command: { kind: "mint_agent_join_credential", seat_cap: 1, ttl_hours: 1 }, credential: login.data.session.access_token });
        assert.equal(issued.response.status, "accepted");
        const joinCode = issued.response.join_credential!;
        const path = join(directory, `in-connect-${scenario}`, "profile.json");
        let registrations = 0;
        const registerFetch: typeof fetch = async (input, init) => {
          if (new URL(String(input)).pathname === "/functions/v1/h0/register") registrations++;
          return fetch(input, init);
        };
        await assert.rejects(connectMcp({ target, profilePath: path, readCode: async () => joinCode, fetcher: registerFetch,
          writeCompletion: async () => { throw new Error("interrupted after actual first use"); } }), { code: "connect_complete_write_failed" });
        const profile = await readAgentProfile(path);
        const original = JSON.parse(await readFile(profile.credential_file, "utf8"));
        const [usedRoot] = await sql<{ first_used_at: Date | null }[]>`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id = ${original.token_id}::uuid`;
        assert.ok(usedRoot.first_used_at, "actual read, never fabricated first use");
        await sql`UPDATE swarm.agent_tokens SET issued_at = issued_at - interval '32 days', expires_at = expires_at - interval '32 days'
          WHERE token_id = ${original.token_id}::uuid`;
        await sql`UPDATE swarm.renewal_grants SET last_used_at = clock_timestamp() - interval '31 days'
          WHERE renewal_grant_id = (SELECT renewal_grant_id FROM swarm.agent_tokens WHERE token_id = ${original.token_id}::uuid)`;
        await writeSecureJsonFile(profile.credential_file, JSON.stringify({ ...original,
          expires_at: new Date(Date.parse(original.expires_at) - 32 * 86_400_000).toISOString() }));
        const rootBytes = await readFile(profile.credential_file);
        const pending = join(path, "..", CONNECT_PROFILE_FILES.pending);
        const pendingBytes = await readFile(pending);
        const savedStore = await agentCredentialStore({ target, lineageKey: credentialLineageKey(original.agent_token) });
        assert.equal(await savedStore.read(), null, "no saved successor before direct connect");
        const [zero] = await sql<{ successors: number }[]>`SELECT count(*)::integer AS successors FROM swarm.agent_tokens WHERE predecessor_token_id = ${original.token_id}::uuid`;
        assert.equal(zero.successors, 0);
        let otherBearer: string | null = null;
        if (scenario === "superseded") {
          const parsed = parseAgentCredentialInput(rootBytes.toString(), { kind: "file", path: profile.credential_file });
          const isolated = await agentCredentialStore({ target, lineageKey: credentialLineageKey(original.agent_token), stateDirectory: directory });
          const other = await AgentCredentialSession.open({ target, workspaceId: f.workspace, presented: parsed, store: isolated });
          otherBearer = await other.bearer();
          assert.equal(await use(f.workspace, otherBearer), 200, "paired real winner authenticates");
          assert.equal(await savedStore.read(), null, "losing connection cannot see other store's winner");
        }
        if (scenario === "membership") await fence(original.token_id, "membership");
        const requests: Array<{ path: string; status: number }> = [];
        let completions = 0;
        const options = { target, profilePath: path, readCode: async () => joinCode,
          writeCompletion: async (file: string, value: string) => { completions++; await writeSecureJsonFile(file, value); },
          fetcher: (async (input, init) => {
            assert.ok(init?.signal, "in-connect renewal and read are deadline-bound");
            if (new URL(String(input)).pathname === "/functions/v1/read") {
              const saved = await savedStore.read();
              assert.ok(saved && saved.generation === 1, "winner persisted inside connect before authenticated read");
              assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${saved.token}`);
            }
            const response = await fetch(input, init);
            requests.push({ path: new URL(String(input)).pathname, status: response.status });
            return response;
          }) as typeof fetch };
        try {
          if (scenario === "direct") assert.equal((await connectMcp(options)).profile, path);
          else {
            await assert.rejects(connectMcp(options), error => {
              assert.equal((error as { code: string }).code, scenario === "membership" ? "connect_authentication_refused" : "connect_renewal_refused");
              assert.match(String(error), scenario === "membership" ? /refused; the cause is unconfirmed/ : /Another process renewed.*no usable saved successor/);
              assert.doesNotMatch(String(error), /Rerun the same|token mint|mcp add|mcp_servers/);
              return true;
            });
            assert.equal(completions, 0);
            assert.deepEqual(await readFile(pending), pendingBytes);
            assert.deepEqual(requests, [{ path: "/functions/v1/command", status: scenario === "membership" ? 403 : 200 }]);
          }
        } finally {
          if (scenario === "membership") await sql`UPDATE swarm.memberships SET revoked_at = NULL
            WHERE workspace_id = ${f.workspace}::uuid AND user_id = ${f.user}::uuid`;
        }
        if (scenario === "membership") {
          requests.length = 0;
          assert.equal((await connectMcp(options)).profile, path, "paired real renewal/read after restoring membership");
        }
        if (scenario !== "superseded") {
          assert.deepEqual(requests, [{ path: "/functions/v1/command", status: 200 }, { path: "/functions/v1/read", status: 200 }]);
          assert.equal(completions, 1);
          const winner = await savedStore.read();
          assert.ok(winner && winner.tokenId && winner.token && winner.generation === 1);
          const [after] = await sql<{ successors: number; first_used_at: Date | null }[]>`SELECT first_used_at,
            (SELECT count(*)::integer FROM swarm.agent_tokens WHERE predecessor_token_id = ${original.token_id}::uuid) AS successors
            FROM swarm.agent_tokens WHERE token_id = ${winner.tokenId}::uuid`;
          assert.equal(after.successors, 1);
          assert.ok(after.first_used_at, "renewed successor really authenticated before completion");
          assert.equal(await use(f.workspace, winner.token), 200);
        } else {
          const [after] = await sql<{ successors: number }[]>`SELECT count(*)::integer AS successors FROM swarm.agent_tokens WHERE predecessor_token_id = ${original.token_id}::uuid`;
          assert.equal(after.successors, 1, "losing copy never issues an extra successor");
          assert.equal(await use(f.workspace, otherBearer!), 200);
        }
        assert.deepEqual(await readFile(profile.credential_file), rootBytes);
        assert.equal(registrations, 1);
      }
      // Completion fences run after real registration, before its first real read.
      for (const policy of ["revoked", "elapsed", "membership", "foreign"] as const) {
        for (const live of [false, true]) {
          const issued = await new ThinCommandClient(target).sendConnect({ workspaceId: f.workspace,
            command: { kind: "mint_agent_join_credential", seat_cap: 1, ttl_hours: 1 }, credential: login.data.session.access_token });
          assert.equal(issued.response.status, "accepted");
          const joinCode = issued.response.join_credential!;
          const path = join(directory, `completion-${policy}-${live}`, "profile.json");
          const name = `C6 ${policy} ${live}`;
          let registrations = 0, completions = 0;
          const replies: Array<{ status: number; error: unknown }> = [];
          const fetcher: typeof fetch = async (input, init) => {
            const endpoint = new URL(String(input)).pathname;
            const foreignRead = endpoint === "/functions/v1/read" && policy === "foreign" && !live;
            let forwarded = init;
            if (foreignRead) {
              const body = JSON.parse(String(init?.body));
              assert.equal(body.resource, "members");
              assert.equal(body.workspace_id, f.workspace, "valid saved W1 profile reaches HTTP");
              const profile = await readAgentProfile(path);
              const credential = JSON.parse(await readFile(profile.credential_file, "utf8"));
              assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${credential.agent_token}`);
              forwarded = { ...init, body: JSON.stringify({ ...body, workspace_id: foreign.workspace }) };
            }
            const response = await fetch(input, forwarded);
            if (endpoint === "/functions/v1/h0/register") {
              registrations++;
              const payload = await response.clone().json();
              assert.equal(response.status, 200, "must reach real successful registration");
              assert.equal(typeof payload.token_id, "string");
              await fence(payload.token_id, live ? "live" : policy);
            }
            if (endpoint === "/functions/v1/read") {
              const payload = await response.clone().json();
              if (foreignRead) {
                assert.equal(response.status, 200);
                assert.deepEqual(payload, { members: [], agents: [] }, "no W2 rows, content or valid foreign identity");
              }
              replies.push({ status: response.status, error: payload.error });
            }
            return response;
          };
          const options = { target, profilePath: path, name, readCode: async () => joinCode, fetcher,
            writeCompletion: async (file: string, value: string) => { completions++; await writeSecureJsonFile(file, value); } };
          try {
            if (live) {
              assert.equal((await connectMcp(options)).profile, path, `${policy}: paired real connect control`);
              assert.deepEqual(replies, [{ status: 200, error: undefined }]);
              assert.equal(completions, 1);
              const connected = await openProfileCredential(await readAgentProfile(path));
              assert.equal(await use(f.workspace, await connected.bearer()), 200);
            } else {
              await assert.rejects(connectMcp(options), { code: policy === "foreign" ? "connect_identity_mismatch" : "connect_authentication_refused" });
              assert.deepEqual(replies, [{ status: policy === "foreign" ? 200 : policy === "membership" ? 403 : 401,
                error: policy === "foreign" ? undefined : policy === "membership" ? "forbidden" : "unauthenticated" }]);
              assert.equal(completions, 0);
              const saved = await readAgentProfile(path);
              const credentialBefore = await readFile(saved.credential_file);
              const pendingPath = join(directory, `completion-${policy}-${live}`, CONNECT_PROFILE_FILES.pending);
              const pendingBefore = await readFile(pendingPath);
              await assert.rejects(readFile(join(directory, `completion-${policy}-${live}`, CONNECT_PROFILE_FILES.complete)), { code: "ENOENT" });
              await assert.rejects(connectMcp(options), { code: policy === "foreign" ? "connect_identity_mismatch" : "connect_authentication_refused" });
              assert.deepEqual(await readFile(saved.credential_file), credentialBefore);
              assert.deepEqual(await readFile(pendingPath), pendingBefore);
              assert.equal((await readAgentProfile(path)).workspace_id, f.workspace, "no foreign profile is saved");
              await assert.rejects(readFile(join(directory, `completion-${policy}-${live}`, CONNECT_PROFILE_FILES.complete)), { code: "ENOENT" });
              if (policy === "foreign") {
                const credential = JSON.parse(credentialBefore.toString("utf8"));
                await confirmOwner(credential.agent_token, saved.principal_id);
              }
              assert.equal(completions, 0);
              assert.equal(replies.length, 2);
              assert.deepEqual(replies[1], replies[0]);
            }
            assert.equal(registrations, 1, "pending failures never consume another seat");
          } finally {
            if (policy === "membership" && !live) await sql`UPDATE swarm.memberships SET revoked_at = NULL
              WHERE workspace_id = ${f.workspace}::uuid AND user_id = ${f.user}::uuid`;
          }
        }
      }
      // An unused expired root gets no renewal authority; a live control still works.
      const unused = await fixture();
      const session = await AgentCredentialSession.open({ target, workspaceId: unused.workspace, presented: unused.presented, store: unused.store });
      await assert.rejects(session.bearer(), RenewalCredentialCheckError);
      const [refused] = await sql<{ first_used_at: Date | null; successors: number }[]>`
        SELECT first_used_at, (SELECT count(*)::integer FROM swarm.agent_tokens WHERE predecessor_token_id = ${unused.tokenId}::uuid) AS successors
        FROM swarm.agent_tokens WHERE token_id = ${unused.tokenId}::uuid`;
      assert.equal(refused.first_used_at, null);
      assert.equal(refused.successors, 0);
      assert.equal(await use(f.workspace, await reopened.bearer()), 200);
    });
    await t.test("unknown-expiry bare and artifact CLI inputs recover only after real authentication refusal", async () => {
      for (const bare of [false, true]) {
        const f = await fixture();
        const path = join(directory, `${f.tokenId}.json`);
        await writeFile(path, bare ? f.token : JSON.stringify({ message: "Agent credential minted.", status: "accepted",
          principal_id: f.principal, token_id: f.tokenId, run_id: f.run, agent_token: f.token }), { mode: 0o600 });
        const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "command", "create",
          "--task-id", randomUUID(), "--slug", "unknown-cli", "--agent-token-file", path,
          "--url", target.url, "--anon-key", target.anonKey, "--workspace-id", f.workspace], {
          env: { ...process.env, SWARM_AGENT_STATE_DIR: directory, SWARM_CLOUD_URL: "", SWARM_CLOUD_ANON_KEY: "", SWARM_CLOUD_WORKSPACE_ID: "" },
          stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
        });
        const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        let output = "";
        child.stderr.resume();
        for await (const part of child.stdout) output += part;
        assert.equal(await exited, 0, "real CLI unknown-expiry command must complete");
        assert.match(output, /"status": "accepted"/);
        const saved = await f.store.read();
        assert.equal(saved?.generation, 1);
        assert.equal(saved?.rootTokenId, bare ? null : f.tokenId, "only actual artifact metadata supplies the root id");
        assert.equal(await use(f.workspace, saved!.token!), 200);
      }
    });
    await t.test("live unknown proof does not renew; expired eligible proof replays exactly once with its original body", async () => {
      const f = await fixture();
      await sql`UPDATE swarm.agent_tokens SET expires_at = clock_timestamp() + interval '1 hour'
        WHERE token_id = ${f.tokenId}::uuid`;
      const session = await AgentCredentialSession.open({ target, workspaceId: f.workspace, store: f.store,
        presented: { token: f.token, tokenId: null, principalId: null, runId: null, expiresAt: null } });
      const bodies: string[] = [];
      const transport: typeof fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { command: { kind: string }; command_id: string };
        if (body.command.kind !== "renew_agent_token") bodies.push(String(init?.body));
        return await fetch(input, init);
      };
      const client = new ThinCommandClient(target, transport);
      const work = async () => await client.send({ workspaceId: f.workspace, stream: { kind: "workspace" },
        command: { kind: "create", task_id: randomUUID(), slug: `unknown-${randomUUID()}` },
        credential: await session.bearer() }, (rejected) => session.recoverUnauthenticated(rejected));
      assert.equal((await work()).response.status, "accepted");
      assert.equal(await f.store.read(), null, "live unknown proof never creates renewal state");
      await sql`UPDATE swarm.agent_tokens SET expires_at = clock_timestamp() - interval '1 hour' WHERE token_id = ${f.tokenId}::uuid`;
      assert.equal((await work()).response.status, "accepted");
      assert.equal(bodies.length, 3);
      assert.equal(bodies[1], bodies[2], "real server replay keeps original command id/body");
      assert.equal((await f.store.read())?.generation, 1);
      // A fresh machine lost its successor. An already-used child cannot be
      // resurrected from the obsolete root. Current stored proof is the control.
      const lost = await agentCredentialStore({ target, lineageKey: credentialLineageKey(f.token), stateDirectory: join(directory, "lost") });
      const obsolete = await AgentCredentialSession.open({ target, workspaceId: f.workspace, store: lost,
        presented: { token: f.token, tokenId: null, principalId: null, runId: null, expiresAt: null } });
      await assert.rejects(() => client.send({ workspaceId: f.workspace, stream: { kind: "workspace" },
        command: { kind: "create", task_id: randomUUID(), slug: "obsolete" }, credential: f.token },
        (rejected) => obsolete.recoverUnauthenticated(rejected)), (error: unknown) =>
        (error instanceof RenewalCredentialCheckError && error.status === 401 && error.code === "unauthenticated") ||
        error instanceof RenewalSuperseded, "obsolete proof must meet the server's used-winner fence");
      assert.equal((await lost.read())?.token ?? null, null);
      assert.equal(await use(f.workspace, await session.bearer()), 200);
    });
    await t.test("idle >30d, lost replies across pre-ledger upgrade refusal and expired unused child", async () => {
      const f = await fixture();
      let drop = 2, unavailable = true, upgradeRequired = false;
      const ids: string[] = [];
      const transport: typeof fetch = async (input, init) => {
        ids.push((JSON.parse(String(init?.body)) as { command_id: string }).command_id);
        if (unavailable) throw new TypeError("injected outage");
        // Inject only the pre-ledger HTTP gate. Renewal decisions still use M3.
        if (upgradeRequired) return Response.json({ error: "upgrade_required", min_client_version: "999.0.0" }, { status: 426 });
        const response = await fetch(input, init);
        if (drop-- > 0) { await response.arrayBuffer(); throw new TypeError("injected reply loss"); }
        return response;
      };
      const options = { target, workspaceId: f.workspace, presented: f.presented, store: f.store, fetcher: transport, warn: () => {} };
      let session = await AgentCredentialSession.open(options);
      await assert.rejects(() => session.bearer(), RenewalRetryError);
      unavailable = false;
      await assert.rejects(() => session.bearer(), RenewalRetryError);
      const committed = await f.store.read();
      assert.ok(committed?.pendingRenewal);
      const [child] = await sql<{ token_id: string; first_used_at: Date | null; revoked_at: Date | null }[]>`
        SELECT token_id, first_used_at, revoked_at FROM swarm.agent_tokens
        WHERE predecessor_token_id = ${f.tokenId}::uuid`;
      assert.ok(child?.token_id, "real M3 committed a child before the reply was dropped");
      assert.equal(child.first_used_at, null);
      assert.equal(child.revoked_at, null);
      upgradeRequired = true;
      session = await AgentCredentialSession.open(options);
      await assert.rejects(() => session.bearer(), (error: unknown) =>
        error instanceof RenewalRefused && error.status === 426 && error.code === "upgrade_required");
      assert.deepEqual(await f.store.read(), committed, "pre-ledger 426 retains committed lost-reply evidence");
      upgradeRequired = false;
      // A process can be offline longer than the old one-hour pending deadline.
      await f.store.withLock(async () => {
        const saved = await f.store.read();
        assert.ok(saved?.pendingRenewal);
        await f.store.write({ ...saved, pendingRenewal: { ...saved.pendingRenewal, startedAt: Date.now() - 2 * 3_600_000 } });
      });
      session = await AgentCredentialSession.open(options);
      await assert.rejects(() => session.bearer(), RenewalRetryError);
      // Expire the exact unused child. M3, not a fixture response, decides whether
      // a fresh command may replace it after its same-id replay has no secret.
      await sql`UPDATE swarm.agent_tokens SET expires_at = clock_timestamp() - interval '1 millisecond'
        WHERE predecessor_token_id = ${f.tokenId}::uuid AND first_used_at IS NULL AND revoked_at IS NULL`;
      const bearer = await session.bearer();
      assert.ok(bearer !== f.token, "a stored live successor is required");
      assert.equal(await use(f.workspace, bearer), 200);
      assert.equal(ids[1], ids[0], "outage retains id");
      assert.equal(ids[2], ids[0], "pre-ledger upgrade refusal retains the lost-reply id");
      assert.equal(ids[3], ids[0], "old pending evidence is retained after reopen/upgrade");
      assert.equal(ids[4], ids[0], "same-id replay precedes recovery");
      assert.notEqual(ids[5], ids[4], "only null replay permits one fresh id");
      assert.equal(ids.length, 6, "recovery is bounded");
      const recovered = await f.store.read();
      assert.ok(recovered?.token === bearer, "recovery is durable before the bearer is used again");
      assert.equal(recovered.pendingRenewal, null);
      assert.equal(recovered.generation, 1);
      const reopened = await AgentCredentialSession.open({ ...options, fetcher: fetch });
      assert.ok(await reopened.bearer() === bearer, "reopen adopts durable successor");
      // Bare and artifact forms use the identical root-derived secure store.
      const bare = await AgentCredentialSession.open({ ...options, fetcher: fetch,
        presented: { token: f.token, tokenId: null, principalId: null, runId: null, expiresAt: null } });
      assert.ok(await bare.bearer() === bearer, "bare form adopts same-root winner");
      const foreign = await agentCredentialStore({ target, lineageKey: credentialLineageKey(`swm_agt_${"F".repeat(43)}`), stateDirectory: directory });
      assert.equal(await foreign.read(), null, "another root cannot find the winner");
      const otherOrigin = cloudTarget(local.API_URL.includes("127.0.0.1") ? local.API_URL.replace("127.0.0.1", "localhost") : local.API_URL.replace("localhost", "127.0.0.1"), local.ANON_KEY);
      assert.notEqual(otherOrigin.profileId, target.profileId, "fixture requires distinct origins");
      const isolated = await agentCredentialStore({ target: otherOrigin, lineageKey: credentialLineageKey(f.token), stateDirectory: directory });
      assert.equal(await isolated.read(), null, "another origin cannot find the winner");
      // ids[5] issued the CURRENT winner. ids[4] names the expired, replaced
      // child and cannot exercise the used-winner self-heal fence.
      const winner = await f.store.read();
      assert.ok(winner?.tokenId);
      const [before] = await sql<{ first_used_at: Date | null; tokens: number }[]>`
        SELECT t.first_used_at, (SELECT count(*)::integer FROM swarm.agent_tokens
          WHERE predecessor_token_id = ${f.tokenId}::uuid) AS tokens
        FROM swarm.agent_tokens t WHERE token_id = ${winner.tokenId}::uuid`;
      assert.ok(before?.first_used_at, "the current winner really authenticated");
      type UsedWinnerState = { first_used_at: Date | null; revoked_at: Date | null; tokens: number };
      for (const commandId of [ids[5]!, newRenewalCommandId()]) {
        try {
          const recovered = await requestSuccessor({ target, workspaceId: f.workspace, predecessor: f.token, commandId });
          assert.equal(commandId, ids[5], "a new id must be refused for a used winner");
          assert.equal(recovered, null, "the actual issuance replay cannot return another secret");
        } catch (error) {
          assert.ok((error instanceof RenewalCredentialCheckError && error.status === 401 && error.code === "unauthenticated") ||
            error instanceof RenewalSuperseded, "only a recognized server refusal satisfies this negative");
        }
        const after: UsedWinnerState | undefined = (await sql<UsedWinnerState[]>`
          SELECT t.first_used_at, t.revoked_at, (SELECT count(*)::integer FROM swarm.agent_tokens
            WHERE predecessor_token_id = ${f.tokenId}::uuid) AS tokens
          FROM swarm.agent_tokens t WHERE token_id = ${winner.tokenId}::uuid`)[0];
        assert.equal(after?.tokens, before.tokens, "neither id may replace the used winner");
        assert.equal(after?.first_used_at?.getTime(), before.first_used_at.getTime());
        assert.equal(after?.revoked_at, null);
        assert.equal(await use(f.workspace, bearer), 200, "the used winner remains usable");
      }
    });
    await t.test("interrupted save never exposes an unpersisted successor; reopen recovers", async () => {
      for (const afterWrite of [false, true]) {
        const f = await fixture();
        let failed = false, unreadable = false;
        const broken = { ...f.store,
          write: async (record: Parameters<typeof f.store.write>[0]) => {
            if (record.token !== null && !failed) {
              failed = true;
              if (afterWrite) { await f.store.write(record); unreadable = true; }
              else throw new Error("injected interrupted save");
            } else await f.store.write(record);
          },
          read: async () => { if (unreadable) { unreadable = false; throw new Error("injected read-back loss"); } return await f.store.read(); },
        };
        const session = await AgentCredentialSession.open({ target, workspaceId: f.workspace, presented: f.presented, store: broken, warn: () => {} });
        await assert.rejects(() => session.bearer(), RenewalRetryError);
        assert.equal(session.expiry, f.presented.expiresAt, "in-memory credential is not published before read-back");
        const reopened = await AgentCredentialSession.open({ target, workspaceId: f.workspace, presented: f.presented, store: f.store });
        assert.equal(await use(f.workspace, await reopened.bearer()), 200);
      }
    });
    await t.test("two independent processes adopt one locked durable winner", async () => {
      const f = await fixture();
      const program = `
        import { AgentCredentialSession } from './src/cloud/renewal.ts';
        import { agentCredentialStore, credentialLineageKey } from './src/cloud/agent-credential.ts';
        import { ThinCommandClient } from './src/cloud/command-client.ts';
        import { randomUUID } from 'node:crypto';
        let raw = ''; for await (const chunk of process.stdin) raw += chunk;
        const input = JSON.parse(raw);
        const store = await agentCredentialStore({ target: input.target, lineageKey: credentialLineageKey(input.presented.token), stateDirectory: input.directory });
        const session = await AgentCredentialSession.open({ target: input.target, workspaceId: input.workspace, presented: input.presented, store });
        const client = new ThinCommandClient(input.target);
        const result = await client.send({ workspaceId: input.workspace, stream: { kind: 'workspace' },
          command: { kind: 'create', task_id: randomUUID(), slug: 'race-' + randomUUID() },
          credential: await session.bearer() }, (rejected) => session.recoverUnauthenticated(rejected));
        if (result.response.status !== 'accepted') throw new Error('ordinary work refused');
        process.stdout.write('ready');
      `;
      const run = async () => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: ["pipe", "pipe", "ignore"], timeout: 30_000 });
        const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        child.stdin.end(JSON.stringify({ target, directory, workspace: f.workspace,
          presented: { token: f.token, tokenId: null, principalId: null, runId: null, expiresAt: null } }));
        let output = ""; for await (const part of child.stdout) output += part;
        const code = await exited;
        assert.equal(code, 0); assert.equal(output, "ready");
      };
      await Promise.all([run(), run()]);
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::integer AS n FROM swarm.agent_tokens WHERE predecessor_token_id = ${f.tokenId}::uuid AND revoked_at IS NULL`;
      assert.equal(row?.n, 1, "one unused successor across processes");
      assert.equal((await f.store.read())?.generation, 1);
    });
    await t.test("listener keeps its confirmation window across cached expiry and clears it after actual recovery", async () => {
      const f = await fixture();
      const session = await AgentCredentialSession.open({ target, workspaceId: f.workspace, presented: f.presented, store: f.store, listenerMode: true });
      const effects = new FileListenerEffectStore({ profileId: target.profileId, workspaceId: f.workspace, principalId: f.principal, stateDirectory: directory });
      const durable = await openListenerDeliveryJournal({ profileId: target.profileId, workspaceId: f.workspace,
        principalId: f.principal, proposedListenerInstanceId: randomUUID(), stateDirectory: directory });
      const abort = new AbortController();
      const events: string[] = [];
      let first = true;
      const stop = await runListenerRuntime({ target, workspaceId: f.workspace, principalId: f.principal,
        // Exercise a real read racing technical expiry before the scheduler can
        // exchange. Only the first bearer selection is delayed; authority stays real.
        credentialSession: { get expiry() { return session.expiry; }, get renewalDue() { return session.renewalDue; },
          bearer: async () => { if (first) { first = false; return f.token; } return await session.bearer(); } },
        store: effects, model: new NullListenerModel(), pendingMainQueue: new FilePendingMainQueue(effects.instanceDirectory),
        listenerInstanceId: durable.listenerInstanceId, deliveryJournal: durable.journal,
        signal: abort.signal, sleep: async (ms) => { assert.ok(ms >= 1000, "no hot loop"); },
        onEvent: (event) => { events.push(event.type); if (event.type === "ready") abort.abort(); },
      });
      assert.equal(stop.reason, "cancelled");
      assert.ok(events.includes("credential_check"), "actual expired read opens confirmation window");
      assert.ok(events.includes("credential_check_cleared"), "actual successful renewal/read clears it");
      assert.ok(events.includes("ready"));
    });
    await t.test("selected elapsed expiry, revocation and security suspension deny while permanent control succeeds", async () => {
      for (const policy of ["elapsed", "revoked", "security", "permanent"] as const) {
        const f = await fixture(policy);
        const session = await AgentCredentialSession.open({ target, workspaceId: f.workspace,
          presented: { ...f.presented, expiresAt: null }, store: f.store, warn: () => {} });
        const work = async () => await new ThinCommandClient(target).send({ workspaceId: f.workspace,
          stream: { kind: "workspace" }, command: { kind: "create", task_id: randomUUID(), slug: "policy" },
          credential: await session.bearer() }, (rejected) => session.recoverUnauthenticated(rejected));
        if (policy === "permanent") assert.equal((await work()).response.status, "accepted");
        else {
          await assert.rejects(work, (error: unknown) => {
            // M3 can refuse at admission (the exact 401 sample) or at the
            // renewal command's named policy fence. Transport/parse/storage
            // failures and unrelated domain reasons must fail this negative.
            if (error instanceof RenewalCredentialCheckError) {
              return error.status === 401 && error.code === "unauthenticated";
            }
            if (policy === "elapsed") return error instanceof RenewalReauthorisationRequired && error.reason === "horizon_reached";
            if (policy === "revoked") return error instanceof RenewalRevoked &&
              ["renewal_grant_revoked", "renewal_lineage_revoked", "predecessor_revoked"].includes(error.code);
            return error instanceof RenewalSuspended && error.code === "renewal_grant_suspended";
          }, `${policy} must reach its server authentication/policy fence`);
          assert.equal((await f.store.read())?.token ?? null, null, "no replacement is stored after denial");
        }
      }
    });
  } finally {
    // Like the server-suite fixtures, these isolated rows belong to Root's
    // disposable local stack. Do not weaken FKs or truncate shared tables.
    await sql.end({ timeout: 5 });
    await rm(directory, { recursive: true, force: true });
  }
});
