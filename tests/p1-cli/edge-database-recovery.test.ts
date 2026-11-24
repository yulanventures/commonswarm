/**
 * Edge database TLS verification and pool-holder recovery witness against this stack's real
 * Postgres image and pinned Supabase edge-runtime image in Docker.
 *
 * Reproduces the 2026-11-23 incident with stock postgres.js TLS verification enabled (no custom socket):
 * - TLS verification controls inside the pinned edge-runtime image:
 *   1. Matching DNS/SNI certificate (`db.commonswarm.internal`) from the private CA connects
 *      and confirms `pg_stat_ssl.ssl = true`.
 *   2. Wrong-name certificate (`wrong.commonswarm.internal` served on `wrong-target.commonswarm.internal`)
 *      from the trusted CA is refused before any Postgres startup or authentication byte reaches the server.
 *   3. Untrusted-CA certificate for `untrusted.commonswarm.internal` is refused before any Postgres
 *      startup or authentication byte reaches the server.
 * - Case A: `docker restart` of TLS Postgres while the edge-runtime user worker stays warm; first write
 *   after recovery completes within N (15s) + connect_timeout (5s).
 * - Down window + backoff-poison check: writes while Postgres is stopped fail within `connect_timeout`
 *   (not 30s), and repeated failures do not poison the first write after return.
 * - Case B1: force-removing TLS Postgres while a connection is open (half-open TCP, no FIN/RST)
 *   and starting a replacement container on the same Docker network with the same alias and
 *   volume at a new IP: stalled write settles with `EDGE_DATABASE_STALLED` within N + margin and
 *   rotates the pool; the first write after recovery resolves the alias to the new IP with TLS verified.
 * - Case B2: force-removing TLS Postgres while idle, letting `idle_timeout` half-close against the
 *   vanished peer, then starting a third container at a third IP: first write recovers within
 *   N + connect_timeout with TLS verified.
 *
 * Reached by `npm run test:p1-cli` (glob). Fails (never skips) under GitHub Actions if Docker,
 * Deno, OpenSSL, or the pinned images are unavailable.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pullDockerImage } from "../support/docker-image-pull.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PG_IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.147";
const EDGE_IMAGE = "public.ecr.aws/supabase/edge-runtime:v1.73.13";
const DB_ALIAS = "db.commonswarm.internal";
const WRONG_TARGET_ALIAS = "wrong-target.commonswarm.internal";
const WRONG_CERT_CN = "wrong.commonswarm.internal";
const UNTRUSTED_ALIAS = "untrusted.commonswarm.internal";
const CONNECT_TIMEOUT_SECONDS = 5;
const STALL_TIMEOUT_MS = 15_000;
const DOWN_CONNECT_BOUND_MS = (CONNECT_TIMEOUT_SECONDS + 3) * 1_000;
const RECOVERY_BOUND_MS = STALL_TIMEOUT_MS + CONNECT_TIMEOUT_SECONDS * 1_000 + 2_000;
const IN_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === "true";

function run(
  command: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    encoding: "utf8",
    input: options.input ?? "",
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function skipOrFail(context: { skip: (message?: string) => void }, reason: string): void {
  if (IN_GITHUB_ACTIONS) {
    assert.fail(`CI must run the edge database recovery witness without skipping: ${reason}`);
  }
  context.skip(reason);
}

function inspectContainerIp(container: string): string {
  const inspected = run("docker", [
    "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container,
  ]);
  assert.equal(inspected.status, 0, "failed to inspect container IP");
  const ip = inspected.stdout.trim();
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, `unexpected container IP for ${container}`);
  return ip;
}

function nextDifferentIp(ip: string, avoid: ReadonlySet<string>): string {
  const parts = ip.split(".").map(Number);
  assert.equal(parts.length, 4);
  for (let delta = 1; delta <= 20; delta += 1) {
    const last = ((parts[3]! - 2 + delta) % 240) + 2;
    const candidate = `${parts[0]}.${parts[1]}.${parts[2]}.${last}`;
    if (!avoid.has(candidate)) return candidate;
  }
  throw new Error("could not pick a distinct container IP");
}

async function waitForPostgresReady(container: string, password: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  // Pass PGPASSWORD through environment inheritance (-e PGPASSWORD without =value), never argv.
  const env = { ...process.env, PGPASSWORD: password };
  while (Date.now() < deadline) {
    const probe = run("docker", [
      "exec", "-e", "PGPASSWORD", container,
      "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres",
      "-q", "-t", "-A", "-c", "SELECT 1",
    ], { env });
    if (probe.status === 0 && probe.stdout.trim() === "1") return;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail(`Postgres container ${container} did not become ready within 90s`);
}

function runOpenssl(args: string[]): void {
  const res = run("openssl", args);
  assert.equal(res.status, 0, `openssl ${args[0]} failed`);
}

async function generateTlsFixtures(work: string): Promise<{
  trustedCaPem: string;
  goodDir: string;
  wrongDir: string;
  untrustedDir: string;
}> {
  const pkiDir = join(work, "pki");
  const goodDir = join(pkiDir, "good");
  const wrongDir = join(pkiDir, "wrong");
  const untrustedDir = join(pkiDir, "untrusted");
  await mkdir(goodDir, { recursive: true, mode: 0o755 });
  await mkdir(wrongDir, { recursive: true, mode: 0o755 });
  await mkdir(untrustedDir, { recursive: true, mode: 0o755 });

  const caKey = join(pkiDir, "ca.key");
  const caCert = join(pkiDir, "ca.crt");
  const badCaKey = join(pkiDir, "bad-ca.key");
  const badCaCert = join(pkiDir, "bad-ca.crt");

  runOpenssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", caKey, "-out", caCert,
    "-days", "1", "-subj", "/CN=CommonSwarm Witness CA",
  ]);
  runOpenssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", badCaKey, "-out", badCaCert,
    "-days", "1", "-subj", "/CN=CommonSwarm Witness Untrusted CA",
  ]);

  const issue = async (outDir: string, dnsName: string, issuerCert: string, issuerKey: string) => {
    const keyPath = join(outDir, "server.key");
    const csrPath = join(outDir, "server.csr");
    const extPath = join(outDir, "server.ext");
    const certPath = join(outDir, "server.crt");
    await writeFile(extPath, `subjectAltName=DNS:${dnsName}\nbasicConstraints=CA:FALSE\n`, "utf8");
    runOpenssl([
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", csrPath,
      "-subj", `/CN=${dnsName}`,
    ]);
    runOpenssl([
      "x509", "-req", "-in", csrPath,
      "-CA", issuerCert, "-CAkey", issuerKey, "-CAcreateserial",
      "-out", certPath, "-days", "1", "-extfile", extPath,
    ]);
    await chmod(certPath, 0o644);
    await chmod(keyPath, 0o644);
  };

  await issue(goodDir, DB_ALIAS, caCert, caKey);
  await issue(wrongDir, WRONG_CERT_CN, caCert, caKey);
  await issue(untrustedDir, UNTRUSTED_ALIAS, badCaCert, badCaKey);

  return {
    trustedCaPem: await readFile(caCert, "utf8"),
    goodDir,
    wrongDir,
    untrustedDir,
  };
}

interface EdgeOpReply {
  ok: boolean;
  elapsedMs: number;
  value?: unknown;
  code?: string;
  diagnostic?: string;
}

async function waitForEdgeReady(edgePort: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${edgePort}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.status === 200) return;
    } catch {
      // Retry until ready.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail("pinned edge-runtime container did not become healthy within 90s");
}

async function edgeOp(
  edgePort: number,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<EdgeOpReply> {
  const response = await fetch(`http://127.0.0.1:${edgePort}/op`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (response.status !== 200) {
    assert.fail(`edge witness returned unexpected HTTP status ${response.status} for op=${String(body.op)}`);
  }
  try {
    return JSON.parse(text) as EdgeOpReply;
  } catch {
    assert.fail(`edge witness returned non-JSON body for op=${String(body.op)}`);
  }
}

/** Write with a single caller-side retry if the first attempt trips a stall or stale socket close. */
async function writeWithCallerRetry(
  edgePort: number,
  label: string,
): Promise<{ reply: EdgeOpReply; totalMs: number; retriedCode: string | null }> {
  const t0 = Date.now();
  const first = await edgeOp(edgePort, { op: "write", label }, RECOVERY_BOUND_MS + 5_000);
  if (first.ok) {
    return { reply: first, totalMs: Date.now() - t0, retriedCode: null };
  }
  const second = await edgeOp(edgePort, { op: "write", label }, DOWN_CONNECT_BOUND_MS + 5_000);
  return { reply: second, totalMs: Date.now() - t0, retriedCode: first.code ?? "UNKNOWN" };
}

function assertPostgresSawNoStartupOrAuth(container: string, label: string): void {
  const logs = run("docker", ["logs", container]);
  const combined = `${logs.stdout}\n${logs.stderr}`;
  assert.doesNotMatch(
    combined,
    /connection authenticated:|connection authorized:|password authentication failed/i,
    `${label}: Postgres must never receive startup or authentication bytes on a refused TLS handshake`,
  );
}

test("pinned edge-runtime verifies stock TLS and recovers via pool holder from Postgres restart and recreate with a new IP", { timeout: 300_000 }, async (context) => {
  // Confirm the pinned edge image tag matches deploy/edge-runtime/compose.yaml.
  const composeEdge = (await readFile(join(repoRoot, "deploy/edge-runtime/compose.yaml"), "utf8"))
    .match(/^\s+image:\s+(\S+)$/m)?.[1];
  assert.equal(composeEdge, EDGE_IMAGE, "EDGE_IMAGE must match deploy/edge-runtime/compose.yaml");

  if (run("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    skipOrFail(context, "Docker is absent; this witness requires throwaway Postgres and edge-runtime containers");
    return;
  }
  if (run("deno", ["--version"]).status !== 0) {
    skipOrFail(context, "deno is absent");
    return;
  }
  if (run("openssl", ["version"]).status !== 0) {
    skipOrFail(context, "openssl is absent; TLS witness requires ephemeral CA and server certificates");
    return;
  }

  const pgImage = await pullDockerImage(PG_IMAGE);
  if (!pgImage.ready) {
    skipOrFail(context, pgImage.reason);
    return;
  }
  const edgeImage = await pullDockerImage(EDGE_IMAGE);
  if (!edgeImage.ready) {
    skipOrFail(context, edgeImage.reason);
    return;
  }

  const id = randomUUID().slice(0, 8);
  const password = `edge-${randomUUID()}`;
  const jwtSecret = `${randomUUID()}${randomUUID()}`;
  const network = `edge-db-rec-${id}`;
  const volume = `edge-db-vol-${id}`;
  const pg1 = `edge-db-pg1-${id}`;
  const pg2 = `edge-db-pg2-${id}`;
  const pg3 = `edge-db-pg3-${id}`;
  const pgWrong = `edge-db-wrong-${id}`;
  const pgUntrusted = `edge-db-untrusted-${id}`;
  const edgeContainer = `edge-db-rt-${id}`;
  const work = await mkdtemp(join(tmpdir(), "edge-db-recovery-"));
  await chmod(work, 0o755);

  try {
    const pki = await generateTlsFixtures(work);
    const pgEnvFile = join(work, "pg.env");
    await writeFile(pgEnvFile, [
      `POSTGRES_PASSWORD=${password}`,
      `JWT_SECRET=${jwtSecret}`,
      "JWT_EXP=3600",
      "",
    ].join("\n"), { mode: 0o600 });
    await chmod(pgEnvFile, 0o600);

    const edgeEnvFile = join(work, "edge.env");
    const dbUrlForHost = (host: string) =>
      `postgres://supabase_admin:${encodeURIComponent(password)}@${host}:5432/postgres`;
    const caB64 = Buffer.from(pki.trustedCaPem, "utf8").toString("base64");
    await writeFile(edgeEnvFile, [
      `SWARM_DATABASE_URL=${dbUrlForHost(DB_ALIAS)}`,
      `WITNESS_WRONG_NAME_URL=${dbUrlForHost(WRONG_TARGET_ALIAS)}`,
      `WITNESS_UNTRUSTED_CA_URL=${dbUrlForHost(UNTRUSTED_ALIAS)}`,
      `SWARM_DATABASE_TLS_CA_B64=${caB64}`,
      "",
    ].join("\n"), { mode: 0o600 });
    await chmod(edgeEnvFile, 0o600);

    const mainDir = join(work, "main");
    const workerDir = join(work, "worker");
    await mkdir(mainDir, { recursive: true, mode: 0o755 });
    await mkdir(workerDir, { recursive: true, mode: 0o755 });

    await writeFile(join(workerDir, "deno.json"), JSON.stringify({
      imports: { postgres: "npm:postgres@3.4.9" },
    }, null, 2), { mode: 0o644 });

    // Main service keeps a single warm user-worker isolate alive across all requests.
    await writeFile(join(mainDir, "index.ts"), `
declare const EdgeRuntime: {
  userWorkers: {
    create(options: {
      servicePath: string;
      memoryLimitMb: number;
      workerTimeoutMs: number;
      noModuleCache: boolean;
      envVars: Array<[string, string]>;
    }): Promise<{ fetch(request: Request): Promise<Response> }>;
  };
};

let workerPromise: Promise<{ fetch(request: Request): Promise<Response> }> | null = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = EdgeRuntime.userWorkers.create({
      servicePath: "/run/witness/worker",
      memoryLimitMb: 128,
      workerTimeoutMs: 300_000,
      noModuleCache: false,
      envVars: [
        ["SWARM_DATABASE_URL", Deno.env.get("SWARM_DATABASE_URL") ?? ""],
        ["WITNESS_WRONG_NAME_URL", Deno.env.get("WITNESS_WRONG_NAME_URL") ?? ""],
        ["WITNESS_UNTRUSTED_CA_URL", Deno.env.get("WITNESS_UNTRUSTED_CA_URL") ?? ""],
        ["SWARM_DATABASE_TLS_CA_B64", Deno.env.get("SWARM_DATABASE_TLS_CA_B64") ?? ""],
      ],
    });
  }
  return workerPromise;
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }
  try {
    const worker = await getWorker();
    return await worker.fetch(request);
  } catch {
    return Response.json({ ok: false, elapsedMs: 0, code: "WORKER_ERROR", diagnostic: "edge_worker_invocation_failed" }, { status: 200 });
  }
});
`, { mode: 0o644 });

    // User worker runs the actual shared createEdgeDatabase pool holder and returns fixed diagnostics only.
    await writeFile(join(workerDir, "index.ts"), `
import { createEdgeDatabase } from "/work/supabase/functions/_shared/database.ts";

const dbUrl = Deno.env.get("SWARM_DATABASE_URL")!;
const wrongNameUrl = Deno.env.get("WITNESS_WRONG_NAME_URL")!;
const untrustedCaUrl = Deno.env.get("WITNESS_UNTRUSTED_CA_URL")!;
const caB64 = Deno.env.get("SWARM_DATABASE_TLS_CA_B64")!;

const db = createEdgeDatabase(dbUrl, {
  max: 1,
  idle_timeout: 3,
  connect_timeout: ${CONNECT_TIMEOUT_SECONDS},
}, caB64);

function safeCode(err: unknown): string {
  const raw = err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : "";
  return /^[A-Z0-9_]{1,48}$/.test(raw) ? raw : "DATABASE_ERROR";
}

function fixedDiagnostic(code: string): string {
  if (code === "EDGE_DATABASE_STALLED") return "database_stalled";
  if (code === "CONNECT_TIMEOUT") return "connect_timeout";
  if (code === "CONNECTION_CLOSED") return "connection_closed";
  if (code.includes("TLS") || code.includes("CERT") || code.includes("SIGNATURE") || code.includes("VERIFY")) {
    return "tls_verification_failed";
  }
  return "database_operation_failed";
}

Deno.serve(async (request) => {
  const req = await request.json() as { op: string; label?: string; target?: "good" | "wrong" | "untrusted" };
  const t0 = Date.now();
  try {
    if (req.op === "init") {
      await db.begin(async (tx) => {
        await tx\`CREATE TABLE IF NOT EXISTS public.edge_recovery_witness (
          id serial PRIMARY KEY,
          label text NOT NULL
        )\`;
      });
      return Response.json({ ok: true, elapsedMs: Date.now() - t0 });
    }
    if (req.op === "write") {
      const rows = await db.begin(async (tx) => {
        return await tx<{ id: number; addr: string; ssl: boolean }[]>\`
          INSERT INTO public.edge_recovery_witness (label)
          VALUES (\${req.label ?? ""})
          RETURNING id, inet_server_addr()::text AS addr,
            (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl
        \`;
      });
      return Response.json({ ok: true, elapsedMs: Date.now() - t0, value: rows[0] ?? null });
    }
    if (req.op === "list") {
      const rows = await db<{ label: string }[]>\`
        SELECT label FROM public.edge_recovery_witness ORDER BY id ASC
      \`;
      return Response.json({ ok: true, elapsedMs: Date.now() - t0, value: rows.map((r) => r.label) });
    }
    if (req.op === "probe_tls") {
      const targetUrl = req.target === "wrong"
        ? wrongNameUrl
        : req.target === "untrusted"
        ? untrustedCaUrl
        : dbUrl;
      const probe = createEdgeDatabase(targetUrl, {
        max: 1,
        connect_timeout: ${CONNECT_TIMEOUT_SECONDS},
      }, caB64);
      try {
        const rows = await probe<{ ssl: boolean }[]>\`
          SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()
        \`;
        return Response.json({ ok: true, elapsedMs: Date.now() - t0, value: rows[0] ?? null });
      } finally {
        await probe.end({ timeout: 0 });
      }
    }
    if (req.op === "close") {
      await db.end({ timeout: 1 });
      return Response.json({ ok: true, elapsedMs: Date.now() - t0 });
    }
    return Response.json({ ok: false, elapsedMs: Date.now() - t0, code: "UNKNOWN_OP", diagnostic: "unknown_operation" });
  } catch (err) {
    const code = safeCode(err);
    return Response.json({
      ok: false,
      elapsedMs: Date.now() - t0,
      code,
      diagnostic: fixedDiagnostic(code),
    });
  }
});
`, { mode: 0o644 });

    assert.equal(run("docker", ["network", "create", network]).status, 0, "failed to create Docker network");
    assert.equal(run("docker", ["volume", "create", volume]).status, 0, "failed to create Docker volume");

    // Start a throwaway Postgres container with TLS enabled and credentials passed only via 0600 env-file.
    const startPg = (opts: {
      name: string;
      tlsDir: string;
      alias?: string;
      ip?: string;
      useSharedVolume?: boolean;
    }) => {
      const args = [
        "run", "-d", "--name", opts.name,
        "--network", network,
        ...(opts.ip ? ["--ip", opts.ip] : []),
        ...(opts.alias ? ["--network-alias", opts.alias] : []),
        ...(opts.useSharedVolume ? ["-v", `${volume}:/var/lib/postgresql/data`] : []),
        "-v", `${opts.tlsDir}:/run/tls-src:ro`,
        "--env-file", pgEnvFile,
        "--entrypoint", "/bin/bash",
        PG_IMAGE,
        "-c",
        "mkdir -p /tmp/pg-tls && cp /run/tls-src/server.crt /run/tls-src/server.key /tmp/pg-tls/ && chown postgres:postgres /tmp/pg-tls/server.crt /tmp/pg-tls/server.key && chmod 600 /tmp/pg-tls/server.key && exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/pg-tls/server.crt -c ssl_key_file=/tmp/pg-tls/server.key -c log_connections=on",
      ];
      const started = run("docker", args);
      assert.equal(started.status, 0, `failed to start Postgres container ${opts.name}`);
    };

    startPg({ name: pg1, tlsDir: pki.goodDir, alias: DB_ALIAS, useSharedVolume: true });
    startPg({ name: pgWrong, tlsDir: pki.wrongDir, alias: WRONG_TARGET_ALIAS });
    startPg({ name: pgUntrusted, tlsDir: pki.untrustedDir, alias: UNTRUSTED_ALIAS });
    await Promise.all([
      waitForPostgresReady(pg1, password),
      waitForPostgresReady(pgWrong, password),
      waitForPostgresReady(pgUntrusted, password),
    ]);

    const ip1 = inspectContainerIp(pg1);
    const wrongIp = inspectContainerIp(pgWrong);
    const untrustedIp = inspectContainerIp(pgUntrusted);
    const netGateway = run("docker", [
      "network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", network,
    ]).stdout.trim();
    const usedIps = new Set([netGateway, ip1, wrongIp, untrustedIp]);

    // Start the pinned edge-runtime container with credentials passed only via 0600 env-file.
    const edgeStart = run("docker", [
      "run", "-d", "--name", edgeContainer,
      "--network", network,
      "-p", "127.0.0.1::9000",
      "--env-file", edgeEnvFile,
      "-v", `${repoRoot}:/work:ro`,
      "-v", `${work}:/run/witness:ro`,
      EDGE_IMAGE,
      "start",
      "--main-service", "/run/witness/main",
      "--port", "9000",
      "--policy", "per_worker",
      "--max-parallelism", "2",
    ]);
    assert.equal(edgeStart.status, 0, "failed to start pinned edge-runtime container");
    usedIps.add(inspectContainerIp(edgeContainer));

    const portInfo = run("docker", ["port", edgeContainer, "9000/tcp"]);
    assert.equal(portInfo.status, 0, "failed to inspect edge-runtime published port");
    const edgePort = Number(portInfo.stdout.trim().split(":").pop());
    assert.ok(Number.isInteger(edgePort) && edgePort > 0, "invalid published edge-runtime port");
    await waitForEdgeReady(edgePort);

    const timings: Record<string, unknown> = {};

    // TLS verification controls inside the pinned edge-runtime image (stock postgres.js TLS):
    // 1. Matching-name control (DNS db.commonswarm.internal, trusted CA) succeeds with ssl=true.
    const goodProbe = await edgeOp(edgePort, { op: "probe_tls", target: "good" });
    assert.equal(goodProbe.ok, true, `matching TLS control failed (${goodProbe.code}/${goodProbe.diagnostic})`);
    assert.equal((goodProbe.value as { ssl?: boolean } | null)?.ssl, true, "matching TLS control must report ssl=true");

    // 2. Wrong-name cert (trusted CA, cert for wrong.commonswarm.internal) refused before startup/auth.
    const wrongProbe = await edgeOp(edgePort, { op: "probe_tls", target: "wrong" });
    assert.equal(wrongProbe.ok, false, "wrong-name certificate must be refused by edge-runtime");
    assertPostgresSawNoStartupOrAuth(pgWrong, "wrong-name cert");

    // 3. Untrusted-CA cert refused before startup/auth.
    const untrustedProbe = await edgeOp(edgePort, { op: "probe_tls", target: "untrusted" });
    assert.equal(untrustedProbe.ok, false, "untrusted CA certificate must be refused by edge-runtime");
    assertPostgresSawNoStartupOrAuth(pgUntrusted, "untrusted CA cert");

    // Baseline: schema + first write succeed through the warm TLS pool.
    const initReply = await edgeOp(edgePort, { op: "init" });
    assert.equal(initReply.ok, true, `init failed (${initReply.code}/${initReply.diagnostic})`);
    const w1 = await edgeOp(edgePort, { op: "write", label: "before-restart" });
    assert.equal(w1.ok, true, `baseline write failed (${w1.code}/${w1.diagnostic})`);
    assert.equal((w1.value as { ssl?: boolean } | null)?.ssl, true, "baseline write must use TLS");
    timings.baselineMs = w1.elapsedMs;

    // Case A: docker restart of TLS Postgres; same warm edge-runtime worker recovers within N + connect_timeout.
    assert.equal(run("docker", ["restart", pg1]).status, 0, "failed to restart pg1");
    await waitForPostgresReady(pg1, password);
    const caseA = await writeWithCallerRetry(edgePort, "after-restart");
    assert.equal(caseA.reply.ok, true, `case A write failed (${caseA.reply.code}/${caseA.reply.diagnostic})`);
    assert.equal((caseA.reply.value as { ssl?: boolean } | null)?.ssl, true, "case A write must use TLS");
    assert.ok(caseA.totalMs < RECOVERY_BOUND_MS, `case A took ${caseA.totalMs}ms (bound ${RECOVERY_BOUND_MS}ms)`);
    timings.afterRestartMs = caseA.totalMs;
    timings.afterRestartRetriedCode = caseA.retriedCode;

    // Down-window + backoff-poison check: while TLS Postgres is stopped, writes fail within
    // connect_timeout (not 30s), and repeated failures do not poison the first write after return.
    assert.equal(run("docker", ["stop", pg1]).status, 0, "failed to stop pg1");
    const downWriteTimes: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const downWrite = await edgeOp(edgePort, { op: "write", label: `while-down-${attempt}` }, DOWN_CONNECT_BOUND_MS + 5_000);
      assert.equal(downWrite.ok, false, "write must fail while Postgres is stopped");
      assert.ok(
        downWrite.elapsedMs < DOWN_CONNECT_BOUND_MS,
        `down write #${attempt} took ${downWrite.elapsedMs}ms (bound ${DOWN_CONNECT_BOUND_MS}ms)`,
      );
      downWriteTimes.push(downWrite.elapsedMs);
    }
    timings.downWindowWriteMs = downWriteTimes;

    assert.equal(run("docker", ["start", pg1]).status, 0, "failed to start pg1");
    await waitForPostgresReady(pg1, password);
    const afterDown = await writeWithCallerRetry(edgePort, "after-down-window");
    assert.equal(afterDown.reply.ok, true, `first write after restart failed (${afterDown.reply.code}/${afterDown.reply.diagnostic})`);
    assert.equal((afterDown.reply.value as { ssl?: boolean } | null)?.ssl, true, "post-down-window write must use TLS");
    assert.ok(
      afterDown.totalMs < RECOVERY_BOUND_MS,
      `first write after down window took ${afterDown.totalMs}ms (bound ${RECOVERY_BOUND_MS}ms)`,
    );
    timings.afterDownWindowMs = afterDown.totalMs;

    // Case B1: force-remove pg1 while the pool holds an open TLS connection to ip1 (half-open TCP,
    // no FIN/RST) and recreate pg2 at a NEW IP on the same alias.
    const w4 = await edgeOp(edgePort, { op: "write", label: "before-recreate" });
    assert.equal(w4.ok, true, `pre-recreate write failed (${w4.code}/${w4.diagnostic})`);
    assert.equal(run("docker", ["rm", "-f", pg1]).status, 0, "failed to remove pg1");

    const ip2 = nextDifferentIp(ip1, usedIps);
    usedIps.add(ip2);
    startPg({ name: pg2, tlsDir: pki.goodDir, alias: DB_ALIAS, ip: ip2, useSharedVolume: true });
    await waitForPostgresReady(pg2, password);
    const actualIp2 = inspectContainerIp(pg2);
    assert.equal(actualIp2, ip2);
    assert.notEqual(actualIp2, ip1, "recreated Postgres must have a new IP address");

    const caseB1 = await writeWithCallerRetry(edgePort, "after-recreate-new-ip");
    assert.equal(caseB1.reply.ok, true, `case B1 write after recreate failed (${caseB1.reply.code}/${caseB1.reply.diagnostic})`);
    assert.ok(caseB1.totalMs < RECOVERY_BOUND_MS, `case B1 took ${caseB1.totalMs}ms (bound ${RECOVERY_BOUND_MS}ms)`);
    assert.equal((caseB1.reply.value as { addr?: string; ssl?: boolean } | null)?.addr, ip2, "client must connect to the new container IP");
    assert.equal((caseB1.reply.value as { addr?: string; ssl?: boolean } | null)?.ssl, true, "case B1 write must use TLS");
    timings.afterActiveRecreateMs = caseB1.totalMs;
    timings.afterActiveRecreateRetriedCode = caseB1.retriedCode;

    // Case B2: force-remove pg2 while the TLS connection to ip2 is idle, wait past idle_timeout (3s)
    // so postgres.js half-closes against the vanished peer, then recreate pg3 at a third IP.
    assert.equal(run("docker", ["rm", "-f", pg2]).status, 0, "failed to remove pg2");
    await new Promise((r) => setTimeout(r, 4_000));
    const ip3 = nextDifferentIp(ip2, usedIps);
    usedIps.add(ip3);
    startPg({ name: pg3, tlsDir: pki.goodDir, alias: DB_ALIAS, ip: ip3, useSharedVolume: true });
    await waitForPostgresReady(pg3, password);
    const actualIp3 = inspectContainerIp(pg3);
    assert.equal(actualIp3, ip3);
    assert.notEqual(actualIp3, ip2);

    const caseB2 = await writeWithCallerRetry(edgePort, "after-idle-recreate");
    assert.equal(caseB2.reply.ok, true, `case B2 write after idle recreate failed (${caseB2.reply.code}/${caseB2.reply.diagnostic})`);
    assert.ok(caseB2.totalMs < RECOVERY_BOUND_MS, `case B2 took ${caseB2.totalMs}ms (bound ${RECOVERY_BOUND_MS}ms)`);
    assert.equal((caseB2.reply.value as { addr?: string; ssl?: boolean } | null)?.addr, ip3, "client must resolve alias to third IP");
    assert.equal((caseB2.reply.value as { addr?: string; ssl?: boolean } | null)?.ssl, true, "case B2 write must use TLS");
    timings.afterIdleRecreateMs = caseB2.totalMs;
    timings.afterIdleRecreateRetriedCode = caseB2.retriedCode;

    console.log(JSON.stringify({ event: "edge_db_recovery_witness_timings", ...timings }));

    // Verify data persisted across all restarts/recreates and no failed write duplicated.
    const listed = await edgeOp(edgePort, { op: "list" });
    assert.equal(listed.ok, true, `list failed (${listed.code}/${listed.diagnostic})`);
    assert.deepEqual(listed.value, [
      "before-restart",
      "after-restart",
      "after-down-window",
      "before-recreate",
      "after-recreate-new-ip",
      "after-idle-recreate",
    ]);

    await edgeOp(edgePort, { op: "close" });
  } finally {
    run("docker", ["rm", "-f", edgeContainer, pg1, pg2, pg3, pgWrong, pgUntrusted]);
    run("docker", ["volume", "rm", "-f", volume]);
    run("docker", ["network", "rm", network]);
    await rm(work, { recursive: true, force: true });
  }
});
