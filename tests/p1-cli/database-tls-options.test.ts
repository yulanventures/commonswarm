import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  EDGE_DATABASE_CONNECT_TIMEOUT_SECONDS,
  EDGE_DATABASE_IDLE_TIMEOUT_SECONDS,
  EDGE_DATABASE_KEEP_ALIVE_SECONDS,
  EDGE_DATABASE_MAX_LIFETIME_SECONDS,
  edgeDatabaseOptions,
  withDatabaseTls,
} from "../../supabase/functions/_shared/database-options.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("database options decode and verify a configured private CA", () => {
  const pem = "-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----\n";
  assert.deepEqual(withDatabaseTls({ max: 1 }, btoa(pem)), {
    max: 1,
    ssl: { ca: pem, rejectUnauthorized: true },
  });
  assert.throws(() => withDatabaseTls({}, "%%%"), /valid base64/);
  assert.throws(() => withDatabaseTls({}, btoa("not a certificate")), /PEM certificate/);
});

test("edgeDatabaseOptions sets bounded recovery defaults and preserves pool size", () => {
  const pem = "-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----\n";
  const opts = edgeDatabaseOptions({ max: 2 }, btoa(pem));
  assert.equal(opts.max, 2);
  assert.equal(opts.prepare, false);
  assert.equal(opts.idle_timeout, EDGE_DATABASE_IDLE_TIMEOUT_SECONDS);
  assert.equal(opts.connect_timeout, EDGE_DATABASE_CONNECT_TIMEOUT_SECONDS);
  assert.equal(opts.max_lifetime, EDGE_DATABASE_MAX_LIFETIME_SECONDS);
  assert.equal(opts.keep_alive, EDGE_DATABASE_KEEP_ALIVE_SECONDS);
  assert.equal(opts.backoff(0), 0);
  assert.equal(opts.backoff(10), 0);
  assert.equal(typeof opts.socket, "function");
  assert.deepEqual(opts.ssl, { ca: pem, rejectUnauthorized: true });

  const noTls = edgeDatabaseOptions({ max: 1, idle_timeout: 10, connect_timeout: 4 }, undefined);
  assert.equal(noTls.max, 1);
  assert.equal(noTls.idle_timeout, 10);
  assert.equal(noTls.connect_timeout, 4);
  assert.equal("ssl" in noTls, false);
});

test("every edge function constructs its Postgres client via the shared createEdgeDatabase helper", async () => {
  const files = [
    "supabase/functions/command/index.ts",
    "supabase/functions/command/admin-admission.ts",
    "supabase/functions/read/index.ts",
    "supabase/functions/activity/index.ts",
    "supabase/functions/capability/index.ts",
    "supabase/functions/h0/poll-ack.ts",
    "supabase/functions/mcp/index.ts",
  ];
  for (const rel of files) {
    const source = await readFile(join(repoRoot, rel), "utf8");
    assert.match(source, /\bcreateEdgeDatabase\s*\(/, `${rel} must use createEdgeDatabase`);
    assert.doesNotMatch(source, /\bpostgres\s*\(/, `${rel} must not call postgres(...) directly`);
  }
});

interface FakePgServer {
  server: net.Server;
  port: number;
  getConnCount: () => number;
  closeAll: () => void;
}

async function startFakePgServer(options: {
  freezeConns?: ReadonlySet<number>;
  tlsPair?: { key: string; cert: string };
} = {}): Promise<FakePgServer> {
  const freezeConns = options.freezeConns ?? new Set<number>();
  let connCount = 0;
  const sockets: Array<net.Socket | tls.TLSSocket> = [];

  const attachWire = (sock: net.Socket | tls.TLSSocket, cid: number) => {
    let started = false;
    let frozen = false;
    let inTx = false;
    sock.on("data", (buf: Buffer) => {
      if (frozen) return;
      if (!started) {
        started = true;
        sock.write(Buffer.concat([
          Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]), // AuthenticationOk
          Buffer.from([0x5a, 0, 0, 0, 5, 0x49]), // ReadyForQuery (Idle)
        ]));
        return;
      }
      if (buf[0] === 0x58) return; // Terminate
      const text = buf.toString("utf8");
      const isBegin = /\bbegin\b/i.test(text);
      const isCommit = /\bcommit\b/i.test(text);
      const isSimple = buf[0] === 0x51;
      if (isBegin) inTx = true;
      if (isCommit) inTx = false;
      const cmd = isBegin ? "BEGIN" : isCommit ? "COMMIT" : "SELECT 1";
      const tag = Buffer.from(`${cmd}\0`);
      const cc = Buffer.alloc(5 + tag.length);
      cc[0] = 0x43;
      cc.writeUInt32BE(4 + tag.length, 1);
      tag.copy(cc, 5);
      const rfq = Buffer.from([0x5a, 0, 0, 0, 5, inTx ? 0x54 : 0x49]);
      if (isSimple) {
        sock.write(Buffer.concat([cc, rfq]));
      } else {
        const prefix = Buffer.from([
          0x31, 0, 0, 0, 4, // ParseComplete
          0x6e, 0, 0, 0, 4, // NoData
          0x32, 0, 0, 0, 4, // BindComplete
        ]);
        sock.write(Buffer.concat([prefix, cc, rfq]));
      }
      if ((isCommit || !inTx) && freezeConns.has(cid)) {
        frozen = true;
      }
    });
  };

  // allowHalfOpen: true models a silently vanished peer that never answers TCP FIN.
  const server = net.createServer({ allowHalfOpen: true }, (raw) => {
    connCount += 1;
    const cid = connCount;
    sockets.push(raw);
    raw.on("error", () => {});
    if (options.tlsPair) {
      const { key, cert } = options.tlsPair;
      raw.once("data", (first: Buffer) => {
        if (first.length === 8 && first.readInt32BE(4) === 80877103) {
          raw.write("S");
          const tlsSock = new tls.TLSSocket(raw, { isServer: true, key, cert });
          sockets.push(tlsSock);
          tlsSock.on("error", () => {});
          attachWire(tlsSock, cid);
        } else {
          attachWire(raw, cid);
        }
      });
    } else {
      attachWire(raw, cid);
    }
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    server,
    port: address.port,
    getConnCount: () => connCount,
    closeAll: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

test("edgeDatabaseOptions recovers from half-open peers after idle_timeout and during active transactions (plain and TLS)", async () => {
  const work = await mkdtemp(join(tmpdir(), "edge-db-opts-tls-"));
  const certPath = join(work, "server.crt");
  const keyPath = join(work, "server.key");
  let tlsPair: { key: string; cert: string } | undefined;
  const openssl = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { encoding: "utf8", timeout: 30_000 });
  if (openssl.status === 0) {
    tlsPair = {
      cert: await readFile(certPath, "utf8"),
      key: await readFile(keyPath, "utf8"),
    };
  }

  try {
    for (const mode of tlsPair ? (["plain", "tls"] as const) : (["plain"] as const)) {
      const fake = await startFakePgServer({
        freezeConns: new Set([1, 2]),
        tlsPair: mode === "tls" ? tlsPair : undefined,
      });
      try {
        const host = mode === "tls" ? "localhost" : "127.0.0.1";
        const encodedCa = mode === "tls" ? btoa(tlsPair!.cert) : undefined;
        const resolved = {
          ...edgeDatabaseOptions({
            max: 1,
            idle_timeout: 1,
            connect_timeout: 2,
            close_grace_ms: 250,
            socket_timeout_ms: 600,
          }, encodedCa),
          fetch_types: false,
        };
        const sql = postgres(
          `postgres://u:p@${host}:${fake.port}/db`,
          resolved as postgres.Options<Record<string, never>>,
        );
        try {
          // 1. Initial transaction succeeds; conn 1 then freezes (silently dead peer).
          await sql.begin(async (tx) => {
            await tx`SELECT 1`;
          });
          assert.equal(fake.getConnCount(), 1);

          // 2. Wait past idle_timeout (1s) + close_grace_ms (0.25s). Without our
          //    socket.end grace timer, postgres.js wedges slot 1 in queues.ended forever.
          await new Promise((r) => setTimeout(r, 1_500));
          const tIdle = Date.now();
          await sql.begin(async (tx) => {
            await tx`SELECT 2`;
          });
          assert.ok(Date.now() - tIdle < 2_000, `${mode}: post-idle recovery took too long`);
          assert.equal(fake.getConnCount(), 2);

          // 3. Immediately send a transaction on frozen conn 2 (before idle_timeout).
          //    It must fail cleanly within socket_timeout_ms (never hang or retry-duplicate).
          const tActive = Date.now();
          await assert.rejects(
            () => sql.begin(async (tx) => { await tx`SELECT 3`; }),
            (err: unknown) => (err as { code?: string })?.code === "CONNECTION_CLOSED",
          );
          const activeElapsed = Date.now() - tActive;
          assert.ok(activeElapsed < 2_000, `${mode}: active frozen tx took ${activeElapsed}ms`);

          // 4. Immediately after the dead socket is evicted, the very next transaction
          //    opens conn 3 and succeeds with zero backoff delay.
          const tNext = Date.now();
          await sql.begin(async (tx) => {
            await tx`SELECT 4`;
          });
          assert.ok(Date.now() - tNext < 2_000, `${mode}: post-eviction tx took too long`);
          assert.equal(fake.getConnCount(), 3);
        } finally {
          await sql.end({ timeout: 0 });
        }
      } finally {
        fake.closeAll();
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("edgeDatabaseOptions bounds connect_timeout on silent peer and never poisons later requests via backoff", async () => {
  // 1. Silent TCP acceptor: accepts TCP then never replies -> CONNECT_TIMEOUT within connect_timeout.
  const silent = net.createServer((sock) => {
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const silentAddress = silent.address();
  assert.ok(silentAddress && typeof silentAddress === "object");
  try {
    const sql = postgres(
      `postgres://u:p@127.0.0.1:${silentAddress.port}/db`,
      {
        ...edgeDatabaseOptions({ max: 1, connect_timeout: 1, socket_timeout_ms: 5_000 }, undefined),
        fetch_types: false,
      } as postgres.Options<Record<string, never>>,
    );
    try {
      const t0 = Date.now();
      await assert.rejects(
        () => sql`SELECT 1`,
        (err: unknown) => (err as { code?: string })?.code === "CONNECT_TIMEOUT",
      );
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 800 && elapsed < 3_000, `expected ~1s CONNECT_TIMEOUT, got ${elapsed}ms`);
    } finally {
      await sql.end({ timeout: 0 });
    }
  } finally {
    silent.close();
  }

  // 2. Repeated ECONNREFUSED failures must NOT escalate backoff (default postgres.js hits 10-20s).
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const sql = postgres(
    `postgres://u:p@127.0.0.1:${deadPort}/db`,
    {
      ...edgeDatabaseOptions({ max: 1, connect_timeout: 2 }, undefined),
      fetch_types: false,
    } as postgres.Options<Record<string, never>>,
  );
  try {
    const start = Date.now();
    for (let i = 0; i < 10; i += 1) {
      await assert.rejects(() => sql`SELECT 1`);
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3_000, `10 failed connects took ${elapsed}ms (backoff poisoned requests)`);
  } finally {
    await sql.end({ timeout: 0 });
  }
});

test("Deno createEdgeDatabase helper recovers from half-open peer without Docker", async (context) => {
  const denoCheck = spawnSync("deno", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (denoCheck.status !== 0) {
    context.skip("deno is not installed");
    return;
  }
  const fake = await startFakePgServer({ freezeConns: new Set([1, 2]) });
  const work = await mkdtemp(join(tmpdir(), "edge-db-deno-helper-"));
  try {
    const scriptPath = join(work, "probe.ts");
    const dbHelperUrl = new URL("../../supabase/functions/_shared/database.ts", import.meta.url).href;
    await writeFile(scriptPath, `
      import { createEdgeDatabase } from ${JSON.stringify(dbHelperUrl)};
      const db = createEdgeDatabase(Deno.env.get("TEST_DB_URL")!, {
        max: 1,
        idle_timeout: 1,
        connect_timeout: 2,
        close_grace_ms: 250,
        socket_timeout_ms: 600,
      }, undefined);
      // Disable type fetch only for the minimal fake wire server by running simple begin/commit queries.
      (db.options as Record<string, unknown>).fetch_types = false;
      try {
        await db.begin(async (tx) => { await tx\`SELECT 1\`; });
        await new Promise((r) => setTimeout(r, 1500));
        await db.begin(async (tx) => { await tx\`SELECT 2\`; });
        let closedCode = "";
        try {
          await db.begin(async (tx) => { await tx\`SELECT 3\`; });
          throw new Error("expected frozen tx to fail");
        } catch (err) {
          closedCode = String((err as { code?: unknown })?.code ?? "");
        }
        if (closedCode !== "CONNECTION_CLOSED") {
          throw new Error("unexpected error code: " + closedCode);
        }
        await db.begin(async (tx) => { await tx\`SELECT 4\`; });
        console.log("DENO_CREATE_EDGE_DB_OK");
      } finally {
        await db.end({ timeout: 0 });
      }
    `, "utf8");
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>((resolveRun) => {
      const child = spawn("deno", [
        "run", "--no-lock", "--no-prompt",
        "--config", join(repoRoot, "supabase/functions/command/deno.json"),
        "--allow-net", "--allow-env", "--allow-read",
        scriptPath,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TEST_DB_URL: `postgres://u:p@127.0.0.1:${fake.port}/db` },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("error", (error) => { clearTimeout(timer); resolveRun({ status: null, stdout, stderr, error }); });
      child.on("close", (status) => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
    });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /DENO_CREATE_EDGE_DB_OK/);
    assert.equal(fake.getConnCount(), 3);
  } finally {
    fake.closeAll();
    await rm(work, { recursive: true, force: true });
  }
});
