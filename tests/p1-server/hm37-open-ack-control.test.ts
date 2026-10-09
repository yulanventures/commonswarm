/** End-to-end coverage for the production-window HM37 control harness. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

const harness = resolve("deploy/release-proofs/item-hm/hm37-open-ack-control.ts");
const denoConfig = resolve("deploy/release-proofs/item-hm/hm37-open-ack-deno.json");
const releaseRoot = resolve(".");

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Fixture {
  ownerId: string;
  accessToken: string;
  workspaceId: string;
  root: string;
  sessionFile: string;
  oauthFile: string;
  journalDir: string;
}

interface HarnessOutput {
  ok: boolean;
  mode?: string;
  grant_id?: string;
  seat_id?: string;
  principal_id?: string;
  observations?: Record<string, unknown>;
  cleanup?: Record<string, unknown>;
  assertions?: Record<string, unknown>;
  error?: {
    assertion_id: string;
    step: string;
    code: string;
    class: string;
    status?: number;
    response_code?: string;
    constraint?: string;
    table?: string;
  };
}

function failureMessage(result: { stderr: string; output: HarnessOutput }): string {
  return `harness error: ${JSON.stringify(result.output.error ?? { missing: true })}\n${result.stderr}`;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
const oauthRuntimePassword = randomUUID();
const roots: string[] = [];
let priorAllocationGate: postgres.Row | undefined;
let fixtureReleaseRoot: string;

// The reviewed HM37 harness measures legacy handles/checks. Phase 3 changes
// those resolvers. Keep its production bytes intact and use this CI-only facade
// beside the existing hosted-authority test bridge during phase-1 integration.
function legacyFixtureRelease(root: string): string {
  const facade = join(root, 'release');
  const command = join(facade, 'supabase/functions/command');
  mkdirSync(command, { recursive: true });
  // Deno keys modules by URL, even through symlinks. Forward runtime imports to
  // the original URLs so opaque capabilities retain the command's WeakMap binding.
  for (const path of [
    'supabase/functions/_shared/hosted-seat-auth.ts',
    'supabase/functions/_shared/database-options.ts',
    'services/mcp-auth/src/postgres-adapter.js',
  ]) {
    const target = join(facade, path);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, `export * from ${JSON.stringify(pathToFileURL(join(releaseRoot, path)).href)};\n`);
  }
  // The harness reads SQL through this path; it never imports a module from it.
  symlinkSync(join(releaseRoot, 'deploy'), join(facade, 'deploy'));
  const module = pathToFileURL(join(releaseRoot, 'supabase/functions/command/index.ts')).href;
  writeFileSync(join(command, 'index.ts'), `
export * from ${JSON.stringify(module)};
import {db,handleHostedCommand as claim} from ${JSON.stringify(module)};
export async function handleHostedCommand(input, capability) {
  const body = input?.command?.kind === 'claim_hosted_seat'
    ? {...input,command:{...input.command,intent:'new',lifetime:'durable'}} : input;
  const result = await claim(body,capability);
  if (result.status===200 && result.body.outcome==='created') {
    const r=result.body;
    await db.begin(async tx=>{
      await tx\`SELECT set_config('role','swarm_command',true)\`;
      await tx\`INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at)
        VALUES(\${r.handle},\${r.seat_id}::uuid,\${r.grant_id}::uuid,\${r.workspace_id}::uuid,\${r.principal_id}::uuid,\${new Date(r.created_at)})\`;
    });
  }
  return result;
}
`);
  return facade;
}

function assertSharedCapabilityRegistry(facade: string): void {
  const commandUrl = pathToFileURL(join(releaseRoot, 'supabase/functions/command/index.ts'));
  // Resolve exactly the auth URL used by the original command's relative import.
  const commandAuthUrl = new URL('../_shared/hosted-seat-auth.ts', commandUrl).href;
  const harnessAuthUrl = pathToFileURL(join(facade, 'supabase/functions/_shared/hosted-seat-auth.ts')).href;
  const source = `
    import assert from 'node:assert/strict';
    import * as harnessAuth from ${JSON.stringify(harnessAuthUrl)};
    import * as commandAuth from ${JSON.stringify(commandAuthUrl)};
    const providerGrantId = 'hm37-registry-probe';
    const capability = await harnessAuth.authenticateHostedGrantCapability(
      async () => [{provider_grant_id: providerGrantId}],
      {grantId: '00000000-0000-4000-8000-000000000001',
       ownerUserId: '00000000-0000-4000-8000-000000000002',
       workspaceId: '00000000-0000-4000-8000-000000000003',
       providerGrantId, tool: 'claim_hosted_seat', providerStatus: async () => ({active: true})},
    );
    assert.ok(capability, 'HM37 registry probe could not construct its control capability');
    const result = {
      constructorRecognizes: harnessAuth.hostedCapabilityTool(capability),
      commandModuleRecognizes: commandAuth.hostedCapabilityTool(capability),
      sameGrantConstructor: harnessAuth.authenticateHostedGrantCapability === commandAuth.authenticateHostedGrantCapability,
      sameSeatConstructor: harnessAuth.authenticateHostedSeatCapability === commandAuth.authenticateHostedSeatCapability,
      forgedCapabilityRecognized: commandAuth.hostedCapabilityTool({kind: 'hosted_grant'}),
    };
    console.log(JSON.stringify(result));
    assert.equal(result.commandModuleRecognizes, 'claim_hosted_seat',
      'HM37 facade capability registry split: command auth does not recognize the harness capability');
    assert.ok(result.sameGrantConstructor && result.sameSeatConstructor,
      'HM37 facade must share the command auth constructors');
    assert.equal(result.forgedCapabilityRecognized, null);
  `;
  execFileSync('deno', ['eval', '--no-lock', '--config', denoConfig, source], {
    cwd: releaseRoot, encoding: 'utf8', timeout: 30_000,
  });
}

before(async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'hm37-release-'));
  roots.push(fixtureRoot);
  fixtureReleaseRoot = legacyFixtureRelease(fixtureRoot);
  assertSharedCapabilityRegistry(fixtureReleaseRoot);
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  })) as Partial<LocalEnvironment>;
  assert.ok(status.API_URL && status.ANON_KEY && status.DB_URL && status.SERVICE_ROLE_KEY);
  local = status as LocalEnvironment;
  const target = new URL(local.DB_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  sql = postgres(local.DB_URL, { prepare: false, max: 4 });
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(1936142700, hashtext('hosted-context-allocation'))`;
    [priorAllocationGate] = await tx`SELECT value FROM swarm.config WHERE key='hosted_context_allocation_enabled'`;
    assert.ok(priorAllocationGate, 'phase-1 allocation reserve exists');
    await tx`UPDATE swarm.config SET value='true'::jsonb WHERE key='hosted_context_allocation_enabled'`;
  });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await sql.unsafe(
    `ALTER ROLE commonswarm_oauth_runtime PASSWORD '${oauthRuntimePassword}'`,
  );
});

after(async () => {
  if (!sql) {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    return;
  }
  await sql`ALTER ROLE commonswarm_oauth_runtime PASSWORD NULL`;
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(1936142700, hashtext('hosted-context-allocation'))`;
    if (priorAllocationGate) await tx`UPDATE swarm.config SET value=${tx.json(priorAllocationGate.value as postgres.JSONValue)} WHERE key='hosted_context_allocation_enabled'`;
  });
  await sql.end();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "hm37-control-"));
  roots.push(root);
  const journalDir = join(root, "journal");
  const sessionFile = join(root, "human-session.json");
  const oauthFile = join(root, "oauth-database.json");
  const email = `hm37-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const human = createClient(local.API_URL, local.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await human.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session?.access_token);
  const ownerId = created.data.user.id;
  const workspaceId = randomUUID();
  const streamId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name, email)
      VALUES (${ownerId}::uuid, 'HM37 owner', ${email})`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspaceId}::uuid, 'HM37 control', ${ownerId}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}::uuid, ${ownerId}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${streamId}::uuid, ${workspaceId}::uuid, 'workspace')`;
  });
  writeFileSync(sessionFile, `${JSON.stringify({ access_token: signedIn.data.session.access_token })}\n`, {
    mode: 0o600,
  });
  chmodSync(sessionFile, 0o600);
  const database = new URL(local.DB_URL);
  writeFileSync(oauthFile, `${JSON.stringify({
    host: database.hostname,
    port: Number(database.port),
    database: decodeURIComponent(database.pathname.slice(1)),
    user: "commonswarm_oauth_runtime",
    password: oauthRuntimePassword,
    ssl_ca: "",
  })}\n`, { mode: 0o600 });
  chmodSync(oauthFile, 0o600);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(journalDir, { mode: 0o700 }));
  chmodSync(journalDir, 0o700);
  return { ownerId, accessToken: signedIn.data.session.access_token, workspaceId,
    root, sessionFile, oauthFile, journalDir };
}

function suffix(): string {
  return String(randomInt(100_000, 1_000_000));
}

function assertionsForPassedSteps(steps: string[]): Record<string, unknown> {
  const source = `
    import { assertionsForPassedSteps } from ${JSON.stringify(pathToFileURL(harness).href)};
    console.log(JSON.stringify(assertionsForPassedSteps(${JSON.stringify(steps)})));
  `;
  return JSON.parse(execFileSync("deno", [
    "eval", "--no-lock", "--config", denoConfig, source,
  ], { cwd: releaseRoot, encoding: "utf8" })) as Record<string, unknown>;
}

function invoke(
  value: Fixture,
  windowSuffix: string,
  options: { cleanupOnly?: string; failAfter?: string; omitSession?: boolean } = {},
): { status: number | null; stdout: string; stderr: string; output: HarnessOutput } {
  const args = [
    "run", "--no-lock", "--config", denoConfig,
    "--allow-env", "--allow-net", `--allow-read=${releaseRoot},${fixtureReleaseRoot},${value.root}`,
    `--allow-write=${value.journalDir}`, harness,
    "--release-root", fixtureReleaseRoot,
    "--oauth-database-config-file", value.oauthFile,
  ];
  if (!options.omitSession) args.push("--human-session-file", value.sessionFile);
  if (options.cleanupOnly) {
    args.push("--cleanup-only", options.cleanupOnly);
  } else {
    args.push("--journal-dir", value.journalDir, "--workspace-id", value.workspaceId);
  }
  const result = spawnSync("deno", args, {
    cwd: releaseRoot, encoding: "utf8", timeout: 180_000,
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: "test",
      SWARM_DATABASE_URL: local.DB_URL,
      SUPABASE_DB_URL: local.DB_URL,
      SUPABASE_URL: local.API_URL,
      SUPABASE_ANON_KEY: local.ANON_KEY,
      WINDOW_PRINCIPAL_SUFFIX: windowSuffix,
      ...(options.failAfter ? { HM37_TEST_FAIL_AFTER: options.failAfter } : {}),
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, result.stderr);
  const output = JSON.parse(lines.at(-1)!) as HarnessOutput;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output };
}

async function cleanupFacts(output: HarnessOutput, diagnostic?: string): Promise<void> {
  assert.ok(output.principal_id, diagnostic);
  assert.ok(output.grant_id, diagnostic);
  const principalId = output.principal_id;
  const grantId = output.grant_id;
  assert.deepEqual(output.cleanup, {
    seat_revoked: true,
    handle_revoked: true,
    principal_revoked: true,
    grant_revoked: true,
    active_agent_tokens: 0,
    provider_family_active: false,
    active_provider_artifacts: 0,
    authorization_refused: true,
    open_refused: true,
    ack_refused: true,
    completed_at: output.cleanup?.completed_at,
  }, diagnostic);
  assert.equal(typeof output.cleanup?.completed_at, "string", diagnostic);
  const [row] = await sql<{
    active_tokens: number; active_provider_artifacts: number; provider_active: boolean;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM swarm.agent_tokens
        WHERE principal_id = ${principalId}::uuid AND revoked_at IS NULL
          AND expires_at > statement_timestamp()) AS active_tokens,
      (SELECT count(*)::int FROM commonswarm_oauth.provider_artifacts a
        JOIN swarm.hosted_mcp_grants g ON g.provider_grant_id = a.grant_id
        WHERE g.grant_id = ${grantId}::uuid
          AND (a.expires_at IS NULL OR a.expires_at > statement_timestamp())) AS active_provider_artifacts,
      (SELECT commonswarm_oauth.provider_family_active(provider_grant_id)
        FROM swarm.hosted_mcp_grants WHERE grant_id = ${grantId}::uuid) AS provider_active
  `;
  assert.deepEqual(row, { active_tokens: 0, active_provider_artifacts: 0, provider_active: false }, diagnostic);
}

test("HM37 harness proves all eleven observations and complete revocation", { timeout: 240_000 }, async () => {
  const value = await fixture();
  const windowSuffix = suffix();
  const result = invoke(value, windowSuffix);
  assert.equal(result.status, 0, failureMessage(result));
  assert.equal(result.output.ok, true);
  assert.equal(result.output.mode, "control");
  const observed = result.output.observations!;
  assert.deepEqual(observed.concurrent_opens_status, [200, 200]);
  assert.equal(observed.active_batches_after_open, 1);
  assert.equal(observed.committed_cursor_after_open, null);
  assert.equal(observed.fresh_open_same_batch, true);
  assert.equal(observed.public_open_status, 403);
  assert.equal(observed.public_ack_status, 403);
  assert.equal(observed.human_open_status, 403);
  assert.equal(observed.human_ack_status, 403);
  assert.equal(observed.request_user_agent, "commonswarm-release-probe/1.0");
  assert.equal(result.output.assertions?.["hosted.seat-handle-alone-refusal"], true,
    "seat-handle-alone-refusal step did not pass");
  for (const assertionId of [
    "hosted.concurrent-open-single-batch",
    "hosted.ack-a-commits-cursor",
    "hosted.repeat-ack-idempotent",
    "hosted.ack-b-empty-open",
    "hosted.public-unauthenticated-refusal",
    "hosted.public-human-bearer-refusal",
    "hosted.visibility-confined",
    "hosted.migration-functional-proof",
    "hosted.cleanup-complete",
  ]) assert.equal(result.output.assertions?.[assertionId], true, assertionId);
  assert.equal(observed.public_refusal_snapshot_unchanged, true);
  assert.equal(observed.repeat_ack_unchanged, true);
  assert.equal(observed.empty_batch_id, null);
  assert.equal(observed.active_batches_after_empty_open, 0);
  assert.equal(observed.migration_04_functional, "t");
  assert.equal(Array.isArray(observed.concurrent_ordered_ids), true);
  assert.equal((observed.concurrent_ordered_ids as string[]).includes(observed.signal_a_id as string), true);
  assert.deepEqual(observed.cursor_after_a, observed.batch_a_terminal);
  assert.equal(typeof observed.cursor_after_b, "object");
  assert.doesNotMatch(result.stdout, /"access_token"|@example\.test|"password"|"seat_[A-Za-z0-9_-]{22}/u);
  await cleanupFacts(result.output, failureMessage(result));

  const journal = join(value.journalDir, `hm37-open-ack-${windowSuffix}.journal.json`);
  const recovered = invoke(value, windowSuffix, { cleanupOnly: journal });
  assert.equal(recovered.status, 0, `${recovered.stderr}\n${recovered.stdout}`);
  assert.equal(recovered.output.ok, true);
  assert.equal(recovered.output.mode, "cleanup-only");
  await cleanupFacts(recovered.output);
});

test("assertion output includes only assertions whose steps passed", () => {
  const assertions = assertionsForPassedSteps(["public-open-ack-refusal"]);
  assert.deepEqual(assertions, { "hosted.public-unauthenticated-refusal": true });
  assert.equal(Object.hasOwn(assertions, "hosted.seat-handle-alone-refusal"), false);
});

test("missing protected input fails before creating authority or OAuth rows", async () => {
  const value = await fixture();
  const before = await sql<{ grants: number; artifacts: number }[]>`
    SELECT (SELECT count(*)::int FROM swarm.hosted_mcp_grants) AS grants,
      (SELECT count(*)::int FROM commonswarm_oauth.provider_artifacts) AS artifacts
  `;
  const result = invoke(value, suffix(), { omitSession: true });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.output, {
    ok: false,
    assertions: { failed_closed_before_creation: true },
    error: {
      assertion_id: "control.startup",
      step: "startup", code: "missing_protected_input", class: "HarnessFailure",
    },
  });
  const afterRows = await sql<{ grants: number; artifacts: number }[]>`
    SELECT (SELECT count(*)::int FROM swarm.hosted_mcp_grants) AS grants,
      (SELECT count(*)::int FROM commonswarm_oauth.provider_artifacts) AS artifacts
  `;
  assert.deepEqual(afterRows, before);
});

test("forced failure after seat creation still runs the full finally cleanup", { timeout: 180_000 }, async () => {
  const value = await fixture();
  const result = invoke(value, suffix(), { failAfter: "seat" });
  assert.notEqual(result.status, 0, failureMessage(result));
  assert.equal(result.output.ok, false, failureMessage(result));
  assert.equal(result.output.mode, "control", failureMessage(result));
  assert.deepEqual(result.output.error, {
    assertion_id: "control.forced-after-seat",
    step: "forced-after-seat", code: "forced_test_failure", class: "HarnessFailure",
  }, failureMessage(result));
  assert.equal(Object.keys(result.output.observations ?? {}).length, 0);
  await cleanupFacts(result.output, failureMessage(result));
  assert.ok(result.output.seat_id, failureMessage(result));
  const seatId = result.output.seat_id;
  const [authority] = await sql<{
    seat_revoked: boolean; handle_revoked: boolean; principal_revoked: boolean; grant_revoked: boolean;
  }[]>`
    SELECT s.revoked_at IS NOT NULL AS seat_revoked,
      h.revoked_at IS NOT NULL AS handle_revoked,
      p.revoked_at IS NOT NULL AS principal_revoked,
      g.revoked_at IS NOT NULL AND g.state = 'revoked' AS grant_revoked
    FROM swarm.hosted_mcp_seats s
    JOIN swarm.hosted_mcp_seat_handles h ON h.seat_id = s.seat_id
    JOIN swarm.agent_principals p ON p.principal_id = s.principal_id
    JOIN swarm.hosted_mcp_grants g ON g.grant_id = s.grant_id
    WHERE s.seat_id = ${seatId}::uuid
  `;
  assert.deepEqual(authority, {
    seat_revoked: true, handle_revoked: true, principal_revoked: true, grant_revoked: true,
  });
});

test("forced seat-handle-alone failure reports S5 id and runs full cleanup", { timeout: 180_000 }, async () => {
  const value = await fixture();
  const result = invoke(value, suffix(), { failAfter: "seat-handle-alone-refusal" });
  assert.notEqual(result.status, 0, failureMessage(result));
  assert.equal(result.output.ok, false, failureMessage(result));
  assert.equal(result.output.mode, "control", failureMessage(result));
  assert.deepEqual(result.output.error, {
    assertion_id: "hosted.seat-handle-alone-refusal",
    step: "seat-handle-alone-refusal", code: "forced_test_failure", class: "HarnessFailure",
  }, failureMessage(result));
  assert.equal(result.output.assertions?.["hosted.seat-handle-alone-refusal"], undefined);
  assert.equal(result.output.assertions?.["hosted.cleanup-complete"], true);
  await cleanupFacts(result.output, failureMessage(result));
});
