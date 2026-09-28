/**
 * HM lanes 3+7 production-window control.
 *
 * This program is intentionally outside the release runtime graph. It imports
 * the selected release's reviewed entry points from --release-root, records a
 * private recovery journal before every mutation, emits one secret-free JSON
 * document, and always attempts revocation cleanup.
 */
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import postgres from "npm:postgres@3.4.9";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SUFFIX_RE = /^[0-9]{6}$/u;
const RESOURCE = "https://mcp.commonswarm.com/mcp";
const CLIENT_VERSION = "0.1.80";
const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
const PROVIDER_CLIENT_ID = "https://client.example/hm37-window-control.json";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Result = { status: number; body: Record<string, unknown> };
type Sql = postgres.Sql<Record<string, unknown>>;
type Tx = postgres.TransactionSql<Record<string, unknown>>;
type QueryResult = { rowCount: number; rows: Array<Record<string, unknown>> };

interface AdapterClient {
  query(text: string, parameters?: unknown[]): Promise<QueryResult>;
  release(): void;
  processID?: number;
}

interface AdapterPool {
  query(text: string, parameters?: unknown[]): Promise<QueryResult>;
  connect(): Promise<AdapterClient>;
}

interface Args {
  releaseRoot: string;
  journalDir?: string;
  workspaceId?: string;
  humanSessionFile: string;
  oauthDatabaseConfigFile: string;
  cleanupOnly?: string;
}

interface Journal {
  version: 1;
  workspaceId: string;
  ownerUserId: string;
  suffix: string;
  seatName: string;
  grantId: string;
  providerGrantId: string;
  interactionRef: string;
  commandIds: {
    begin: string; consent: string; activate: string; claim: string;
    signalA: string; signalB: string; revokeSeat: string; revokeGrant: string;
  };
  plannedMutations: string[];
  grantPlanned: boolean;
  grantCreated: boolean;
  providerFamilyPlanned: boolean;
  providerFamilyCreated: boolean;
  seatPlanned: boolean;
  seatId: string | null;
  principalId: string | null;
  seatHandle: string | null;
  signalAPlanned: boolean;
  signalAId: string | null;
  signalBPlanned: boolean;
  signalBId: string | null;
  batchAId: string | null;
  batchBId: string | null;
  cleanupStartedAt: string | null;
  cleanupCompletedAt: string | null;
}

interface HumanIdentity {
  userId: string;
  email: string | null;
  displayName: string;
  identityVerified: true;
  interactiveAuthAtSeconds: number | null;
}

interface Runtime {
  command: {
    db: Sql;
    handleHostedCommand(input: Record<string, unknown>, capability: unknown): Promise<Result>;
    handleHostedManagementCommand(input: Record<string, unknown>, identity: HumanIdentity): Promise<Result>;
    handleRequest(request: Request): Promise<Response>;
  };
  auth: {
    authenticateHostedGrantCapability(tx: Tx, input: Record<string, unknown>): Promise<unknown | null>;
    authenticateHostedSeatCapability(tx: Tx, input: Record<string, unknown>, use: "command" | "read"): Promise<unknown | null>;
  };
  withDatabaseTls<T extends Record<string, unknown>>(options: T, encodedCa: string | undefined): T;
  createPostgresAdapter(pool: AdapterPool): (model: string) => {
    upsert(id: string, payload: Record<string, unknown>, expiresIn: number): Promise<void>;
    revokeByGrantId(grantId: string): Promise<void>;
  };
  functionalSql: string;
}

interface CleanupFacts {
  seatRevoked: boolean;
  handleRevoked: boolean;
  principalRevoked: boolean;
  grantRevoked: boolean;
  activeAgentTokens: number;
  providerFamilyActive: boolean;
  activeProviderArtifacts: number;
  authorizationRefused: boolean;
  openRefused: boolean;
  ackRefused: boolean;
}

interface ErrorFacts {
  step: string;
  code: string;
  class: string;
  status?: number;
  response_code?: string;
  constraint?: string;
  table?: string;
}

class HarnessFailure extends Error {
  readonly code: string;
  readonly step?: string;
  readonly status?: number;
  readonly responseCode?: string;

  constructor(
    message: string,
    options: { step?: string; status?: number; responseCode?: string } = {},
  ) {
    super(message);
    this.name = "HarnessFailure";
    this.code = message.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 80) ||
      "harness_failure";
    this.step = options.step;
    this.status = options.status;
    this.responseCode = options.responseCode;
  }
}

function fail(message: string): never {
  throw new HarnessFailure(message);
}

function stableExternalCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(value) ? value : undefined;
}

function errorFacts(step: string, error: unknown): ErrorFacts {
  if (error instanceof HarnessFailure) {
    return {
      step: error.step ?? step,
      code: error.code,
      class: error.name,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.responseCode === undefined ? {} : { response_code: error.responseCode }),
    };
  }
  const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : null;
  const className = record?.constructor && typeof record.constructor === "function"
    ? stableExternalCode(record.constructor.name)
    : undefined;
  const constraint = stableExternalCode(record?.constraint_name);
  const table = stableExternalCode(record?.table_name);
  return {
    step,
    code: stableExternalCode(record?.code) ?? "unexpected_exception",
    class: className ?? "UnknownError",
    ...(constraint === undefined ? {} : { constraint }),
    ...(table === undefined ? {} : { table }),
  };
}

function randomBase64Url32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function parseArgs(values: string[]): Args {
  const found = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--") || found.has(name)) {
      fail("invalid arguments");
    }
    found.set(name, value);
  }
  const allowed = new Set([
    "--release-root", "--journal-dir", "--workspace-id", "--human-session-file",
    "--oauth-database-config-file", "--cleanup-only",
  ]);
  if ([...found.keys()].some((name) => !allowed.has(name))) fail("invalid arguments");
  const releaseRoot = found.get("--release-root");
  const humanSessionFile = found.get("--human-session-file");
  const oauthDatabaseConfigFile = found.get("--oauth-database-config-file");
  if (!releaseRoot || !humanSessionFile || !oauthDatabaseConfigFile) fail("missing protected input");
  const cleanupOnly = found.get("--cleanup-only");
  const journalDir = found.get("--journal-dir");
  const workspaceId = found.get("--workspace-id");
  if (cleanupOnly === undefined && (!journalDir || !workspaceId)) fail("missing control input");
  if (cleanupOnly !== undefined && (journalDir !== undefined || workspaceId !== undefined)) {
    fail("cleanup-only cannot create a journal");
  }
  if (workspaceId !== undefined && !UUID_RE.test(workspaceId)) fail("invalid workspace id");
  return {
    releaseRoot, humanSessionFile, oauthDatabaseConfigFile,
    ...(journalDir === undefined ? {} : { journalDir }),
    ...(workspaceId === undefined ? {} : { workspaceId: workspaceId.toLowerCase() }),
    ...(cleanupOnly === undefined ? {} : { cleanupOnly }),
  };
}

async function regularPrivateFile(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.mode === null || (info.mode & 0o777) !== 0o600) {
    fail("protected input must be a regular 0600 file");
  }
}

async function privateDirectory(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink || info.mode === null || (info.mode & 0o077) !== 0) {
    fail("journal directory must be private");
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  await regularPrivateFile(path);
  const value: unknown = JSON.parse(await Deno.readTextFile(path));
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid protected input");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

async function writeJournal(path: string, journal: Journal, create = false): Promise<void> {
  const file = await Deno.open(path, {
    write: true, createNew: create, create: !create, truncate: true, mode: 0o600,
  });
  try {
    await file.write(new TextEncoder().encode(`${JSON.stringify(journal)}\n`));
    await file.sync();
  } finally {
    file.close();
  }
  await regularPrivateFile(path);
}

async function journalBefore(path: string, journal: Journal, mutation: string): Promise<void> {
  journal.plannedMutations.push(mutation);
  await writeJournal(path, journal);
}

async function readJournal(path: string): Promise<Journal> {
  const value = await readJsonFile(path) as unknown as Journal;
  if (value.version !== 1 || !UUID_RE.test(value.workspaceId) || !UUID_RE.test(value.ownerUserId) ||
      !UUID_RE.test(value.grantId) || typeof value.providerGrantId !== "string" ||
      typeof value.seatName !== "string" || typeof value.commandIds !== "object") {
    fail("invalid cleanup journal");
  }
  return value;
}

function fileUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : fail("release root must be absolute");
  return new URL(`file://${normalized.endsWith("/") ? normalized : `${normalized}/`}`).href;
}

async function loadRuntime(releaseRoot: string): Promise<Runtime> {
  const root = await Deno.realPath(releaseRoot);
  const base = fileUrl(root);
  const commandPath = new URL("supabase/functions/command/index.ts", base);
  const authPath = new URL("supabase/functions/_shared/hosted-seat-auth.ts", base);
  const tlsPath = new URL("supabase/functions/_shared/database-options.ts", base);
  const adapterPath = new URL("services/mcp-auth/src/postgres-adapter.js", base);
  const functionalPath = new URL("deploy/release-proofs/item-hm/20260928000004-functional.sql", base);
  for (const url of [commandPath, authPath, tlsPath, adapterPath, functionalPath]) {
    const info = await Deno.stat(url);
    if (!info.isFile) fail("release input is not a file");
  }
  const [command, auth, tls, adapter, functionalSql] = await Promise.all([
    import(commandPath.href), import(authPath.href), import(tlsPath.href), import(adapterPath.href),
    Deno.readTextFile(functionalPath),
  ]);
  if (typeof command.handleHostedCommand !== "function" ||
      typeof command.handleHostedManagementCommand !== "function" ||
      typeof command.handleRequest !== "function" ||
      typeof auth.authenticateHostedGrantCapability !== "function" ||
      typeof auth.authenticateHostedSeatCapability !== "function" ||
      typeof adapter.createPostgresAdapter !== "function") fail("release entry point missing");
  return {
    command, auth,
    withDatabaseTls: tls.withDatabaseTls,
    createPostgresAdapter: adapter.createPostgresAdapter,
    functionalSql,
  } as Runtime;
}

function newestInteractiveAmrSeconds(claims: Record<string, unknown>): number | null {
  const interactive = new Set(["oauth", "password", "otp", "totp", "sso/saml", "magiclink", "email/signup"]);
  const entries = claims.amr;
  if (!Array.isArray(entries)) return null;
  let newest: number | null = null;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.method !== "string" || !interactive.has(value.method.toLowerCase()) ||
        typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) continue;
    newest = newest === null ? value.timestamp : Math.max(newest, value.timestamp);
  }
  return newest;
}

async function verifiedHuman(path: string): Promise<{ identity: HumanIdentity; token: string }> {
  const input = await readJsonFile(path);
  if (!exactKeys(input, ["access_token"]) || typeof input.access_token !== "string" ||
      input.access_token.length < 32) fail("invalid human session file");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) fail("edge authentication environment is unavailable");
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const [{ data, error }, { data: claimsData, error: claimsError }] = await Promise.all([
    client.auth.getUser(input.access_token), client.auth.getClaims(input.access_token),
  ]);
  const user = data.user;
  const claims = claimsData?.claims as Record<string, unknown> | undefined;
  if (error || claimsError || !user || !claims || user.email_confirmed_at == null) {
    fail("human session is not verified");
  }
  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const display = [metadata?.full_name, metadata?.name, metadata?.user_name, user.email?.split("@")[0]]
    .find((value) => typeof value === "string" && value.trim().length > 0);
  return {
    identity: {
      userId: user.id,
      email: typeof user.email === "string" ? user.email.toLowerCase() : null,
      displayName: typeof display === "string" ? display.trim().slice(0, 120) : "CommonSwarm user",
      identityVerified: true,
      interactiveAuthAtSeconds: newestInteractiveAmrSeconds(claims),
    },
    token: input.access_token,
  };
}

function oauthPoolConfig(value: Record<string, unknown>): Record<string, unknown> {
  const requiredStrings = ["host", "database", "user", "password"] as const;
  if (!exactKeys(value, ["host", "port", "database", "user", "password", "ssl_ca"]) ||
      requiredStrings.some((key) => typeof value[key] !== "string" || value[key] === "") ||
      !Number.isSafeInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535 ||
      typeof value.ssl_ca !== "string") fail("invalid OAuth database config");
  return {
    host: value.host, port: value.port, database: value.database,
    username: value.user, password: value.password,
    ...(value.ssl_ca === "" ? {} : { ssl: { ca: value.ssl_ca, rejectUnauthorized: true } }),
    application_name: "commonswarm-hm37-control", max: 2,
    statement_timeout: 10_000, query_timeout: 10_000,
  };
}

function queryResult(value: unknown): QueryResult {
  if (!Array.isArray(value)) fail("OAuth storage returned an invalid result");
  const rows = value as Array<Record<string, unknown>> & { count?: number };
  return { rowCount: typeof rows.count === "number" ? rows.count : rows.length, rows: [...rows] };
}

/** pg-compatible facade so the exact OAuth adapter can run on the edge's pinned postgres.js. */
function adapterPool(sql: Sql): AdapterPool {
  return {
    async query(text, parameters = []) {
      return queryResult(await sql.unsafe(text, parameters));
    },
    async connect() {
      const reserved = await sql.reserve();
      let released = false;
      return {
        async query(text, parameters = []) {
          if (released) fail("OAuth storage connection was released");
          return queryResult(await reserved.unsafe(text, parameters));
        },
        release() {
          if (!released) {
            released = true;
            reserved.release();
          }
        },
      };
    },
  };
}

async function setRole(tx: Tx, role: "swarm_command" | "swarm_read"): Promise<void> {
  await tx`
    SELECT set_config('role', ${role}, true),
      set_config('search_path', 'swarm, commonswarm_oauth, pg_catalog', true),
      set_config('lock_timeout', '5s', true),
      set_config('statement_timeout', '10s', true)
  `;
}

function managedInput(workspaceId: string, commandId: string, command: Record<string, unknown>) {
  return { command_id: commandId, client_version: CLIENT_VERSION, workspace_id: workspaceId,
    stream: { kind: "workspace" }, command };
}

async function requireStatus(result: Result, expected: number, label: string): Promise<Result> {
  if (result.status !== expected) {
    throw new HarnessFailure("unexpected status", {
      step: label,
      status: result.status,
      responseCode: stableExternalCode(result.body.error),
    });
  }
  return result;
}

function uuidField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !UUID_RE.test(value)) fail(`missing ${name}`);
  return value.toLowerCase();
}

function signalsIn(result: Result): Array<Record<string, unknown>> {
  const value = result.body.signals;
  if (!Array.isArray(value) || value.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) {
    fail("invalid check signals");
  }
  return value as Array<Record<string, unknown>>;
}

function cursorIn(result: Result): { created_at: string; signal_id: string } | null {
  const value = result.body.cursor;
  if (value === null) return null;
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) fail("invalid cursor");
  const row = value as Record<string, unknown>;
  if (typeof row.created_at !== "string" || typeof row.signal_id !== "string" || !UUID_RE.test(row.signal_id)) {
    fail("invalid cursor");
  }
  return { created_at: row.created_at, signal_id: row.signal_id.toLowerCase() };
}

function batchIdIn(result: Result): string | null {
  const value = result.body.batch_id;
  if (value === null) return null;
  if (typeof value !== "string" || !UUID_RE.test(value)) fail("invalid batch id");
  return value.toLowerCase();
}

async function publicCommand(runtime: Runtime, token: string | null, input: Record<string, unknown>): Promise<Result> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await runtime.command.handleRequest(new Request("http://hm37/functions/v1/command", {
    method: "POST", headers, body: JSON.stringify(input),
  }));
  return { status: response.status, body: await response.json() };
}

async function providerActive(statusDb: Sql, providerGrantId: string): Promise<{ active: boolean }> {
  return await statusDb.begin("isolation level read committed", async (tx) => {
    await setRole(tx, "swarm_read");
    const rows = await tx<{ active: boolean }[]>`
      SELECT commonswarm_oauth.provider_family_active(${providerGrantId}) AS active
    `;
    return { active: rows[0]?.active === true };
  }) as unknown as { active: boolean };
}

async function grantCapability(runtime: Runtime, journal: Journal, statusDb: Sql): Promise<unknown | null> {
  return await runtime.command.db.begin("isolation level read committed", async (tx) => {
    await setRole(tx, "swarm_command");
    return await runtime.auth.authenticateHostedGrantCapability(tx, {
      grantId: journal.grantId, ownerUserId: journal.ownerUserId,
      providerGrantId: journal.providerGrantId, workspaceId: journal.workspaceId,
      tool: "claim_hosted_seat", providerStatus: () => providerActive(statusDb, journal.providerGrantId),
    });
  }) as unknown;
}

async function seatCapability(runtime: Runtime, journal: Journal, statusDb: Sql): Promise<unknown | null> {
  if (journal.seatHandle === null) return null;
  return await runtime.command.db.begin("isolation level read committed", async (tx) => {
    await setRole(tx, "swarm_command");
    return await runtime.auth.authenticateHostedSeatCapability(tx, {
      grantId: journal.grantId, providerGrantId: journal.providerGrantId,
      handle: journal.seatHandle, tool: "check",
      providerStatus: () => providerActive(statusDb, journal.providerGrantId),
    }, "command");
  }) as unknown;
}

async function checkCall(runtime: Runtime, journal: Journal, statusDb: Sql, ack?: string): Promise<Result> {
  const capability = await seatCapability(runtime, journal, statusDb);
  if (capability === null) return { status: 403, body: { error: "forbidden" } };
  return await runtime.command.handleHostedCommand(managedInput(
    journal.workspaceId, crypto.randomUUID(), ack === undefined
      ? { kind: "open_hosted_mcp_check_batch", seat: journal.seatHandle }
      : { kind: "ack_hosted_mcp_check_batch", seat: journal.seatHandle, ack },
  ), capability);
}

async function snapshot(proofDb: Sql, journal: Journal): Promise<Record<string, Json>> {
  if (journal.seatId === null) return { active_batches: 0, total_batches: 0, cursor: null };
  return await proofDb.begin(async (tx) => {
    await setRole(tx, "swarm_command");
    const [row] = await tx<{
      active_batches: number; total_batches: number;
      cursor_created_at: Date | null; cursor_signal_id: string | null;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM swarm.hosted_mcp_check_batches
          WHERE seat_id = ${journal.seatId}::uuid AND acknowledged_at IS NULL) AS active_batches,
        (SELECT count(*)::int FROM swarm.hosted_mcp_check_batches
          WHERE seat_id = ${journal.seatId}::uuid) AS total_batches,
        c.cursor_created_at, c.cursor_signal_id
      FROM (SELECT 1) AS one
      LEFT JOIN swarm.hosted_mcp_check_cursors AS c ON c.seat_id = ${journal.seatId}::uuid
    `;
    return {
      active_batches: row?.active_batches ?? 0,
      total_batches: row?.total_batches ?? 0,
      cursor: row?.cursor_created_at === null || row?.cursor_created_at === undefined || row.cursor_signal_id === null
        ? null
        : { created_at: row.cursor_created_at.toISOString(), signal_id: row.cursor_signal_id },
    };
  }) as unknown as Record<string, Json>;
}

async function batchFacts(proofDb: Sql, journal: Journal, batchId: string): Promise<{
  active: number; acknowledgedAt: string | null; terminal: { created_at: string; signal_id: string };
}> {
  return await proofDb.begin(async (tx) => {
    await setRole(tx, "swarm_command");
    const [row] = await tx<{
      active: number; acknowledged_at: Date | null; terminal_created_at: Date; terminal_signal_id: string;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM swarm.hosted_mcp_check_batches
          WHERE seat_id = ${journal.seatId}::uuid AND acknowledged_at IS NULL) AS active,
        acknowledged_at, terminal_created_at, terminal_signal_id
      FROM swarm.hosted_mcp_check_batches
      WHERE batch_id = ${batchId}::uuid AND seat_id = ${journal.seatId}::uuid
    `;
    if (!row) fail("batch proof missing");
    return { active: row.active, acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
      terminal: { created_at: row.terminal_created_at.toISOString(), signal_id: row.terminal_signal_id } };
  }) as unknown as {
    active: number; acknowledgedAt: string | null; terminal: { created_at: string; signal_id: string };
  };
}

async function runFunctionalProof(proofDb: Sql, source: string): Promise<boolean> {
  const marker = source.indexOf("\\gset");
  if (marker < 0) fail("functional proof marker missing");
  const query = source.slice(0, marker).trim().replace(/;\s*$/u, "");
  return await proofDb.begin(async (tx) => {
    await setRole(tx, "swarm_command");
    const rows = await tx.unsafe<{ functional_ok: boolean }[]>(query);
    return rows.length === 1 && rows[0]?.functional_ok === true;
  }) as unknown as boolean;
}

async function cleanup(
  runtime: Runtime,
  journalPath: string,
  journal: Journal,
  identity: HumanIdentity,
  statusDb: Sql,
  proofDb: Sql,
  oauthDb: Sql,
): Promise<CleanupFacts> {
  journal.cleanupStartedAt ??= new Date().toISOString();
  await writeJournal(journalPath, journal);
  if (journal.seatPlanned && journal.seatId === null) {
    const recovered = await proofDb.begin(async (tx) => {
      await setRole(tx, "swarm_command");
      return await tx<{
        seat_id: string; principal_id: string; handle: string;
      }[]>`
        SELECT s.seat_id, s.principal_id, h.handle
        FROM swarm.hosted_mcp_seats AS s
        JOIN swarm.hosted_mcp_seat_handles AS h ON h.seat_id = s.seat_id
        WHERE s.grant_id = ${journal.grantId}::uuid
          AND s.workspace_id = ${journal.workspaceId}::uuid
          AND s.name = ${journal.seatName}
        LIMIT 2
      `;
    }) as unknown as Array<{ seat_id: string; principal_id: string; handle: string }>;
    if (recovered.length > 1) fail("cleanup seat binding is ambiguous");
    const row = recovered[0];
    if (row) {
      journal.seatId = row.seat_id;
      journal.principalId = row.principal_id;
      journal.seatHandle = row.handle;
      await writeJournal(journalPath, journal);
    }
  }
  const retainedCapability = await seatCapability(runtime, journal, statusDb);
  if (journal.seatId !== null) {
    const result = await runtime.command.handleHostedManagementCommand(managedInput(
      journal.workspaceId, journal.commandIds.revokeSeat,
      { kind: "revoke_hosted_mcp_seat", grant_id: journal.grantId, seat_id: journal.seatId },
    ), identity);
    if (result.status !== 200) fail("seat cleanup failed");
  }
  if (journal.grantPlanned) {
    const result = await runtime.command.handleHostedManagementCommand(managedInput(
      journal.workspaceId, journal.commandIds.revokeGrant,
      { kind: "revoke_hosted_mcp_grant", grant_id: journal.grantId },
    ), identity);
    if (result.status !== 200 && journal.grantCreated) fail("grant cleanup failed");
  }
  if (journal.providerFamilyPlanned) {
    const adapter = runtime.createPostgresAdapter(adapterPool(oauthDb))("AccessToken");
    await adapter.revokeByGrantId(journal.providerGrantId);
  }

  const authority = await proofDb.begin(async (tx) => {
    await setRole(tx, "swarm_command");
    const [row] = await tx<{
      seat_revoked: boolean; handle_revoked: boolean; principal_revoked: boolean;
      grant_revoked: boolean; active_agent_tokens: number;
    }[]>`
      SELECT
        COALESCE((SELECT revoked_at IS NOT NULL FROM swarm.hosted_mcp_seats
          WHERE seat_id = ${journal.seatId}::uuid), ${journal.seatId === null}) AS seat_revoked,
        COALESCE((SELECT revoked_at IS NOT NULL FROM swarm.hosted_mcp_seat_handles
          WHERE seat_id = ${journal.seatId}::uuid), ${journal.seatId === null}) AS handle_revoked,
        COALESCE((SELECT revoked_at IS NOT NULL FROM swarm.agent_principals
          WHERE principal_id = ${journal.principalId}::uuid), ${journal.principalId === null}) AS principal_revoked,
        COALESCE((SELECT state = 'revoked' AND revoked_at IS NOT NULL FROM swarm.hosted_mcp_grants
          WHERE grant_id = ${journal.grantId}::uuid), ${!journal.grantCreated}) AS grant_revoked,
        (SELECT count(*)::int FROM swarm.agent_tokens
          WHERE principal_id = ${journal.principalId}::uuid AND revoked_at IS NULL
            AND expires_at > statement_timestamp()) AS active_agent_tokens
    `;
    if (!row) fail("cleanup authority proof missing");
    return row;
  }) as unknown as {
    seat_revoked: boolean; handle_revoked: boolean; principal_revoked: boolean;
    grant_revoked: boolean; active_agent_tokens: number;
  };
  const family = await providerActive(statusDb, journal.providerGrantId);
  const artifactRows = await oauthDb.unsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM commonswarm_oauth.provider_artifacts
      WHERE grant_id = $1 AND (expires_at IS NULL OR expires_at > statement_timestamp())`,
    [journal.providerGrantId],
  );
  const authorizationRefused = await seatCapability(runtime, journal, statusDb) === null;
  let openRefused = authorizationRefused;
  let ackRefused = authorizationRefused;
  if (retainedCapability !== null && journal.seatHandle !== null) {
    const opened = await runtime.command.handleHostedCommand(managedInput(
      journal.workspaceId, crypto.randomUUID(),
      { kind: "open_hosted_mcp_check_batch", seat: journal.seatHandle },
    ), retainedCapability);
    const acked = await runtime.command.handleHostedCommand(managedInput(
      journal.workspaceId, crypto.randomUUID(), {
        kind: "ack_hosted_mcp_check_batch", seat: journal.seatHandle,
        ack: journal.batchAId ?? crypto.randomUUID(),
      },
    ), retainedCapability);
    openRefused = opened.status === 403;
    ackRefused = acked.status === 403;
  }
  const facts: CleanupFacts = {
    seatRevoked: authority.seat_revoked,
    handleRevoked: authority.handle_revoked,
    principalRevoked: authority.principal_revoked,
    grantRevoked: authority.grant_revoked,
    activeAgentTokens: authority.active_agent_tokens,
    providerFamilyActive: family.active,
    activeProviderArtifacts: Number(artifactRows[0]?.count ?? -1),
    authorizationRefused,
    openRefused,
    ackRefused,
  };
  if (!facts.seatRevoked || !facts.handleRevoked || !facts.principalRevoked || !facts.grantRevoked ||
      facts.activeAgentTokens !== 0 || facts.providerFamilyActive || facts.activeProviderArtifacts !== 0 ||
      !facts.authorizationRefused || !facts.openRefused || !facts.ackRefused) fail("cleanup proof failed");
  journal.cleanupCompletedAt = new Date().toISOString();
  await writeJournal(journalPath, journal);
  return facts;
}

async function execute(): Promise<Record<string, Json>> {
  const args = parseArgs(Deno.args);
  await regularPrivateFile(args.humanSessionFile);
  await regularPrivateFile(args.oauthDatabaseConfigFile);
  const suffix = Deno.env.get("WINDOW_PRINCIPAL_SUFFIX");
  if (!suffix || !SUFFIX_RE.test(suffix)) fail("WINDOW_PRINCIPAL_SUFFIX is invalid");
  const { identity, token } = await verifiedHuman(args.humanSessionFile);
  const oauthConfig = oauthPoolConfig(await readJsonFile(args.oauthDatabaseConfigFile));
  const runtime = await loadRuntime(args.releaseRoot);
  const databaseUrl = Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
  if (!databaseUrl) fail("edge database environment is unavailable");
  const tlsOptions = runtime.withDatabaseTls({ prepare: false, max: 1, idle_timeout: 3, connect_timeout: 5 },
    Deno.env.get("SWARM_DATABASE_TLS_CA_B64"));
  const statusDb = postgres(databaseUrl, tlsOptions);
  const proofDb = postgres(databaseUrl, { ...tlsOptions, max: 1 });
  const oauthDb = postgres(oauthConfig);

  let journalPath: string;
  let journal: Journal;
  let step = "control-initialize";
  let runError: ErrorFacts | null = null;
  let observations: Record<string, Json> = {};
  let cleanupFacts: CleanupFacts | null = null;
  try {
    if (args.cleanupOnly !== undefined) {
      step = "cleanup-journal-read";
      journalPath = await Deno.realPath(args.cleanupOnly);
      journal = await readJournal(journalPath);
      if (journal.ownerUserId !== identity.userId) fail("cleanup identity does not own journal");
    } else {
      step = "control-journal-create";
      await privateDirectory(args.journalDir!);
      const journalDir = await Deno.realPath(args.journalDir!);
      journalPath = `${journalDir}/hm37-open-ack-${suffix}.journal.json`;
      const commandIds = {
        begin: crypto.randomUUID(), consent: crypto.randomUUID(), activate: crypto.randomUUID(),
        claim: crypto.randomUUID(), signalA: crypto.randomUUID(), signalB: crypto.randomUUID(),
        revokeSeat: crypto.randomUUID(), revokeGrant: crypto.randomUUID(),
      };
      journal = {
        version: 1, workspaceId: args.workspaceId!, ownerUserId: identity.userId,
        suffix, seatName: `hm37-hosted-${suffix}`,
        grantId: crypto.randomUUID(), providerGrantId: randomBase64Url32(),
        interactionRef: `hm37-${crypto.randomUUID()}`, commandIds,
        plannedMutations: [],
        grantPlanned: false, grantCreated: false,
        providerFamilyPlanned: false, providerFamilyCreated: false,
        seatPlanned: false, seatId: null, principalId: null, seatHandle: null,
        signalAPlanned: false, signalAId: null, signalBPlanned: false, signalBId: null,
        batchAId: null, batchBId: null, cleanupStartedAt: null, cleanupCompletedAt: null,
      };
      await writeJournal(journalPath, journal, true);

      step = "owner-access-check";
      const access = await proofDb.begin(async (tx) => {
        await setRole(tx, "swarm_command");
        const [row] = await tx<{ allowed: boolean; live_principals: number }[]>`
          SELECT EXISTS (
            SELECT 1 FROM swarm.workspaces w
            JOIN swarm.memberships m ON m.workspace_id = w.workspace_id
            WHERE w.workspace_id = ${journal.workspaceId}::uuid AND w.archived_at IS NULL
              AND m.user_id = ${journal.ownerUserId}::uuid AND m.revoked_at IS NULL
          ) AS allowed,
          (SELECT count(*)::int FROM swarm.agent_principals
            WHERE workspace_id = ${journal.workspaceId}::uuid AND revoked_at IS NULL) AS live_principals
        `;
        return row;
      }) as unknown as { allowed: boolean; live_principals: number } | undefined;
      if (!access?.allowed || access.live_principals >= 50) fail("owner access or capacity refused");

      const manifest = Array.from(new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(JSON.stringify([journal.workspaceId])),
      ))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      journal.grantPlanned = true;
      await journalBefore(journalPath, journal, "begin_hosted_mcp_grant");
      await journalBefore(journalPath, journal, "consent_hosted_mcp_workspace");
      step = "grant-begin";
      await requireStatus(await runtime.command.handleHostedManagementCommand(managedInput(
        journal.workspaceId, journal.commandIds.begin, {
          kind: "begin_hosted_mcp_grant", grant_id: journal.grantId,
          provider_grant_id: journal.providerGrantId, owner_user_id: journal.ownerUserId,
          home_workspace_id: journal.workspaceId, client_id: PROVIDER_CLIENT_ID,
          resource: RESOURCE, selected_workspace_ids: [journal.workspaceId],
          manifest_digest: manifest, interaction_ref: journal.interactionRef,
        }), identity), 200, "grant begin");
      step = "grant-consent";
      await requireStatus(await runtime.command.handleHostedManagementCommand(managedInput(
        journal.workspaceId, journal.commandIds.consent, {
          kind: "consent_hosted_mcp_workspace", grant_id: journal.grantId,
          workspace_id: journal.workspaceId, owner_user_id: journal.ownerUserId,
          manifest_digest: manifest, consent_receipt_id: crypto.randomUUID(),
        }), identity), 200, "grant consent");
      step = "grant-activation";
      await requireStatus(await runtime.command.handleHostedManagementCommand(managedInput(
        journal.workspaceId, journal.commandIds.activate,
        { kind: "activate_hosted_mcp_grant", grant_id: journal.grantId },
      ), identity), 200, "grant activation");
      journal.grantCreated = true;
      await writeJournal(journalPath, journal);

      journal.providerFamilyPlanned = true;
      await journalBefore(journalPath, journal, "oauth_access_token_artifact");
      const providerArtifactId = randomBase64Url32();
      step = "provider-artifact-create";
      await runtime.createPostgresAdapter(adapterPool(oauthDb))("AccessToken").upsert(providerArtifactId, {
        grantId: journal.providerGrantId, accountId: journal.ownerUserId,
        clientId: PROVIDER_CLIENT_ID, kind: "AccessToken",
      }, ACCESS_TOKEN_TTL_SECONDS);
      journal.providerFamilyCreated = true;
      await writeJournal(journalPath, journal);
      step = "provider-family-check";
      if (!(await providerActive(statusDb, journal.providerGrantId)).active) fail("provider family inactive");

      journal.seatPlanned = true;
      await journalBefore(journalPath, journal, "claim_hosted_seat");
      step = "grant-capability";
      const grantCap = await grantCapability(runtime, journal, statusDb);
      if (grantCap === null) fail("grant capability refused");
      step = "seat-claim";
      const claimed = await requireStatus(await runtime.command.handleHostedCommand(managedInput(
        journal.workspaceId, journal.commandIds.claim,
        { kind: "claim_hosted_seat", name: journal.seatName },
      ), grantCap), 200, "seat claim");
      step = "seat-result-journal";
      journal.seatId = uuidField(claimed.body, "seat_id");
      journal.principalId = uuidField(claimed.body, "principal_id");
      if (typeof claimed.body.handle !== "string") fail("seat handle missing");
      journal.seatHandle = claimed.body.handle;
      await writeJournal(journalPath, journal);
      step = "forced-after-seat";
      if (Deno.env.get("SWARM_ENV") === "test" && Deno.env.get("HM37_TEST_FAIL_AFTER") === "seat") {
        fail("forced test failure");
      }

      journal.signalAPlanned = true;
      await journalBefore(journalPath, journal, "post_signal_a");
      step = "signal-a-post";
      const sentA = await requireStatus(await publicCommand(runtime, token, managedInput(
        journal.workspaceId, journal.commandIds.signalA, {
          kind: "post_signal", signal_kind: "note", body: "HM37 hosted control A",
          to_user_id: null, to_agent_principal_id: journal.principalId,
          in_reply_to: null, about: null, until_ms: 900_000,
        })), 200, "signal A");
      const signalA = sentA.body.signal as Record<string, unknown> | undefined;
      if (!signalA) fail("signal A missing");
      journal.signalAId = uuidField(signalA, "id");
      await writeJournal(journalPath, journal);

      await journalBefore(journalPath, journal, "open_batch_a");
      step = "batch-a-concurrent-open";
      const [openOne, openTwo] = await Promise.all([
        checkCall(runtime, journal, statusDb), checkCall(runtime, journal, statusDb),
      ]);
      await requireStatus(openOne, 200, "concurrent open one");
      await requireStatus(openTwo, 200, "concurrent open two");
      const batchA = batchIdIn(openOne);
      if (batchA === null || batchIdIn(openTwo) !== batchA) fail("concurrent open batch mismatch");
      journal.batchAId = batchA;
      await writeJournal(journalPath, journal);
      const idsOne = signalsIn(openOne).map((row) => uuidField(row, "id"));
      const idsTwo = signalsIn(openTwo).map((row) => uuidField(row, "id"));
      if (JSON.stringify(idsOne) !== JSON.stringify(idsTwo) || !idsOne.includes(journal.signalAId)) {
        fail("concurrent open ordering mismatch");
      }
      const afterOpen = await snapshot(proofDb, journal);
      if (afterOpen.active_batches !== 1 || afterOpen.cursor !== null) fail("open persistence proof failed");
      const freshOpen = await requireStatus(await checkCall(runtime, journal, statusDb), 200, "fresh open");
      if (batchIdIn(freshOpen) !== batchA ||
          JSON.stringify(signalsIn(freshOpen).map((row) => uuidField(row, "id"))) !== JSON.stringify(idsOne)) {
        fail("fresh open replay mismatch");
      }

      const factsA = await batchFacts(proofDb, journal, batchA);
      for (;;) {
        const [clock] = await proofDb<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (clock && clock.now.getTime() > Date.parse(factsA.terminal.created_at)) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      journal.signalBPlanned = true;
      await journalBefore(journalPath, journal, "post_signal_b");
      step = "signal-b-post";
      const sentB = await requireStatus(await publicCommand(runtime, token, managedInput(
        journal.workspaceId, journal.commandIds.signalB, {
          kind: "post_signal", signal_kind: "note", body: "HM37 hosted control B",
          to_user_id: null, to_agent_principal_id: journal.principalId,
          in_reply_to: null, about: null, until_ms: 900_000,
        })), 200, "signal B");
      const signalB = sentB.body.signal as Record<string, unknown> | undefined;
      if (!signalB) fail("signal B missing");
      journal.signalBId = uuidField(signalB, "id");
      await writeJournal(journalPath, journal);
      const [signalBOrdering] = await proofDb.begin(async (tx) => {
        await setRole(tx, "swarm_command");
        return await tx<{ created_at: Date; signal_id: string }[]>`
          SELECT date_trunc('milliseconds', created_at) AS created_at, id AS signal_id
          FROM swarm.signals WHERE id = ${journal.signalBId}::uuid
        `;
      }) as unknown as Array<{ created_at: Date; signal_id: string }>;
      if (!signalBOrdering || (signalBOrdering.created_at.getTime() < Date.parse(factsA.terminal.created_at)) ||
          (signalBOrdering.created_at.getTime() === Date.parse(factsA.terminal.created_at) &&
            signalBOrdering.signal_id.localeCompare(factsA.terminal.signal_id) <= 0)) fail("signal B ordering proof failed");

      const beforePublic = await snapshot(proofDb, journal);
      step = "public-open-ack-refusal";
      const publicOpen = await publicCommand(runtime, null, managedInput(
        journal.workspaceId, crypto.randomUUID(),
        { kind: "open_hosted_mcp_check_batch", seat: journal.seatHandle },
      ));
      const publicAck = await publicCommand(runtime, null, managedInput(
        journal.workspaceId, crypto.randomUUID(),
        { kind: "ack_hosted_mcp_check_batch", seat: journal.seatHandle, ack: batchA },
      ));
      const afterPublic = await snapshot(proofDb, journal);
      if (publicOpen.status !== 403 || publicAck.status !== 403 ||
          JSON.stringify(beforePublic) !== JSON.stringify(afterPublic)) fail("public refusal proof failed");

      await journalBefore(journalPath, journal, "ack_batch_a_and_open_batch_b");
      step = "batch-a-ack";
      const ackA = await requireStatus(await checkCall(runtime, journal, statusDb, batchA.toUpperCase()), 200, "ACK A");
      const batchB = batchIdIn(ackA);
      if (batchB === null || !signalsIn(ackA).some((row) => uuidField(row, "id") === journal.signalBId)) {
        fail("ACK A did not open B");
      }
      if (ackA.body.acknowledged_batch_id !== batchA) fail("ACK A id proof failed");
      journal.batchBId = batchB;
      await writeJournal(journalPath, journal);
      const afterAckA = await snapshot(proofDb, journal);
      const factsAfterAckA = await batchFacts(proofDb, journal, batchA);
      if (JSON.stringify(afterAckA.cursor) !== JSON.stringify(factsA.terminal) ||
          factsAfterAckA.acknowledgedAt === null || factsAfterAckA.active !== 1) fail("ACK A proof failed");

      step = "batch-a-repeat-ack";
      const repeatAckA = await requireStatus(await checkCall(runtime, journal, statusDb, batchA), 200, "repeat ACK A");
      const afterRepeat = await snapshot(proofDb, journal);
      const factsAfterRepeat = await batchFacts(proofDb, journal, batchA);
      if (batchIdIn(repeatAckA) !== batchB || JSON.stringify(afterRepeat) !== JSON.stringify(afterAckA) ||
          factsAfterRepeat.acknowledgedAt !== factsAfterAckA.acknowledgedAt) fail("repeat ACK changed state");

      step = "batch-b-ack";
      const ackB = await requireStatus(await checkCall(runtime, journal, statusDb, batchB), 200, "ACK B");
      if (batchIdIn(ackB) !== null || signalsIn(ackB).length !== 0) fail("ACK B was not empty");
      const emptyOpen = await requireStatus(await checkCall(runtime, journal, statusDb), 200, "empty open");
      if (batchIdIn(emptyOpen) !== null || signalsIn(emptyOpen).length !== 0) fail("empty batch persisted");
      const afterAckB = await snapshot(proofDb, journal);
      const factsB = await batchFacts(proofDb, journal, batchB);
      if (JSON.stringify(afterAckB.cursor) !== JSON.stringify(factsB.terminal) ||
          afterAckB.active_batches !== 0 || afterAckB.total_batches !== 2) {
        fail("ACK B cursor proof failed");
      }
      step = "migration-functional-proof";
      if (!await runFunctionalProof(proofDb, runtime.functionalSql)) fail("migration functional proof failed");
      step = "forced-after-observations";
      if (Deno.env.get("SWARM_ENV") === "test" && Deno.env.get("HM37_TEST_FAIL_AFTER") === "observations") {
        fail("forced test failure");
      }
      observations = {
        signal_a_id: journal.signalAId, signal_b_id: journal.signalBId,
        batch_a_id: batchA, batch_b_id: batchB,
        concurrent_opens_status: [openOne.status, openTwo.status],
        concurrent_ordered_ids: idsOne,
        active_batches_after_open: 1,
        committed_cursor_after_open: null,
        fresh_open_same_batch: true,
        signal_b_ordering: { created_at: signalBOrdering.created_at.toISOString(), signal_id: signalBOrdering.signal_id },
        batch_a_terminal: factsA.terminal,
        public_open_status: publicOpen.status, public_ack_status: publicAck.status,
        public_refusal_snapshot_unchanged: true,
        batch_a_acknowledged_at: factsAfterAckA.acknowledgedAt,
        cursor_after_a: afterAckA.cursor ?? null,
        repeat_ack_unchanged: true,
        cursor_after_b: afterAckB.cursor ?? null,
        empty_batch_id: null,
        active_batches_after_empty_open: 0,
        migration_04_functional: "t",
      };
    }
  } catch (error) {
    runError = errorFacts(step, error);
  } finally {
    try {
      if (typeof journalPath! === "string" && typeof journal! === "object") {
        cleanupFacts = await cleanup(runtime, journalPath, journal, identity, statusDb, proofDb, oauthDb);
      }
    } catch (error) {
      runError ??= errorFacts("cleanup", error);
    }
    await Promise.allSettled([
      runtime.command.db.end({ timeout: 2 }), statusDb.end({ timeout: 2 }),
      proofDb.end({ timeout: 2 }), oauthDb.end({ timeout: 2 }),
    ]);
  }
  if (cleanupFacts === null) {
    Deno.exitCode = 1;
    return {
      ok: false,
      mode: args.cleanupOnly === undefined ? "control" : "cleanup-only",
      workspace_id: journal!.workspaceId,
      grant_id: journal!.grantId,
      seat_id: journal!.seatId,
      principal_id: journal!.principalId,
      observations,
      error: (runError ?? {
        step: "cleanup",
        code: "cleanup_did_not_run",
        class: "HarnessFailure",
      }) as unknown as Record<string, Json>,
    };
  }
  const output: Record<string, Json> = {
    ok: runError === null,
    mode: args.cleanupOnly === undefined ? "control" : "cleanup-only",
    workspace_id: journal!.workspaceId,
    grant_id: journal!.grantId,
    seat_id: journal!.seatId,
    principal_id: journal!.principalId,
    observations,
    cleanup: {
      seat_revoked: cleanupFacts.seatRevoked,
      handle_revoked: cleanupFacts.handleRevoked,
      principal_revoked: cleanupFacts.principalRevoked,
      grant_revoked: cleanupFacts.grantRevoked,
      active_agent_tokens: cleanupFacts.activeAgentTokens,
      provider_family_active: cleanupFacts.providerFamilyActive,
      active_provider_artifacts: cleanupFacts.activeProviderArtifacts,
      authorization_refused: cleanupFacts.authorizationRefused,
      open_refused: cleanupFacts.openRefused,
      ack_refused: cleanupFacts.ackRefused,
      completed_at: journal!.cleanupCompletedAt,
    },
    ...(runError === null ? {} : { error: runError as unknown as Record<string, Json> }),
  };
  if (runError !== null) Deno.exitCode = 1;
  return output;
}

try {
  console.log(JSON.stringify(await execute()));
} catch (error) {
  Deno.exitCode = 1;
  console.log(JSON.stringify({
    ok: false,
    assertions: { failed_closed_before_creation: true },
    error: errorFacts("startup", error),
  }));
}
