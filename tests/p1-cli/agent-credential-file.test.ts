import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
test("M3 agent continuity at the real command, secure-store and listener boundaries", {
  skip: process.env.CSWARM_AGENT_CLIENT_M3 !== "1",
  timeout: 180_000,
}, async (t) => {
  const { default: postgres } = await import("postgres");
  const { cloudTarget, readEndpoint } = await import("../../src/cloud/config.js");
  const { AgentCredentialSession, RenewalRetryError, newRenewalCommandId, requestSuccessor } = await import("../../src/cloud/renewal.js");
  const { agentCredentialStore, credentialLineageKey } = await import("../../src/cloud/agent-credential.js");
  const { ThinCommandClient } = await import("../../src/cloud/command-client.js");
  const { runListenerRuntime, NullListenerModel } = await import("../../src/listener/runtime.js");
  const { FileListenerEffectStore } = await import("../../src/listener/file-store.js");
  const { FilePendingMainQueue } = await import("../../src/listener/main-routing.js");
  const { openListenerDeliveryJournal } = await import("../../src/listener/delivery-journal.js");
  const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  })) as { API_URL: string; ANON_KEY: string; DB_URL: string };
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
    return { user, workspace, principal, run, grant, tokenId, token, presented, store };
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
        (rejected) => obsolete.recoverUnauthenticated(rejected)));
      assert.equal((await lost.read())?.token ?? null, null);
      assert.equal(await use(f.workspace, await session.bearer()), 200);
    });
    await t.test("idle >30d, outage across expiry, repeated dropped replies and expired unused child", async () => {
      const f = await fixture();
      let drop = 2, unavailable = true;
      const ids: string[] = [];
      const transport: typeof fetch = async (input, init) => {
        ids.push((JSON.parse(String(init?.body)) as { command_id: string }).command_id);
        if (unavailable) throw new TypeError("injected outage");
        const response = await fetch(input, init);
        if (drop-- > 0) { await response.arrayBuffer(); throw new TypeError("injected reply loss"); }
        return response;
      };
      const options = { target, workspaceId: f.workspace, presented: f.presented, store: f.store, fetcher: transport, warn: () => {} };
      let session = await AgentCredentialSession.open(options);
      await assert.rejects(() => session.bearer(), RenewalRetryError);
      unavailable = false;
      await assert.rejects(() => session.bearer(), RenewalRetryError);
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
      assert.equal(ids[2], ids[0], "old pending evidence is retained");
      assert.equal(ids[3], ids[0], "same-id replay precedes recovery");
      assert.notEqual(ids[4], ids[3], "only null replay permits one fresh id");
      assert.equal(ids.length, 5, "recovery is bounded");
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
      // The server has now observed the successor in real work: an obsolete root
      // must no longer recover that used child under either id form.
      for (const commandId of [ids[3]!, newRenewalCommandId()]) {
        let recovered = false;
        try { recovered = (await requestSuccessor({ target, workspaceId: f.workspace, predecessor: f.token, commandId })) !== null; }
        catch { /* A confirmed denial is also a correct negative. */ }
        assert.equal(recovered, false, "used winner cannot be replaced from obsolete proof");
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
          await assert.rejects(work);
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
