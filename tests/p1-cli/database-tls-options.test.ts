import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import postgres from "postgres";
import {
  EDGE_DATABASE_CONNECT_TIMEOUT_SECONDS,
  EDGE_DATABASE_IDLE_TIMEOUT_SECONDS,
  EDGE_DATABASE_KEEP_ALIVE_SECONDS,
  EDGE_DATABASE_MAX_LIFETIME_SECONDS,
  edgeDatabaseOptions,
  withDatabaseTls,
} from "../../supabase/functions/_shared/database-options.js";
import {
  classifyCommandFailure,
  dbCode,
  durableCommandFailure,
  finishCommandFailure,
  remainingFailureBudgetMs,
  runWithinFailureBudget,
  type DurableCommandFailure,
} from "../../supabase/functions/command/failures.js";
import {
  extractSafeDiagnostics,
  firstForbiddenDiagnosticKey,
  formatReadFailureLog,
  isRetryableErrorCode,
  publicReadErrorBody,
} from "../../supabase/functions/read/diagnostics.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MATCHING_HOST = "localhost";
const WRONG_DNS_HOST = "wrong.commonswarm.internal";

interface EdgeDatabaseHolderSnapshot {
  generation: number;
  max: number;
  maxRetainedSockets: number;
  currentPoolSockets: number;
  retiredSockets: number;
  retainedSockets: number;
  retiredPoolCount: number;
}

interface LoadedDatabaseModule {
  createEdgeDatabase: (
    databaseUrl: string,
    config: Record<string, unknown>,
    encodedCa?: string,
  ) => postgres.Sql;
  inspectEdgeDatabaseHolder: (sql: unknown) => EdgeDatabaseHolderSnapshot | null;
  EdgeDatabaseStalledError: new () => Error & { code: string };
  EDGE_DATABASE_STALLED_CODE: string;
  INVALID_DATABASE_CONFIGURATION_MESSAGE: string;
  EDGE_DATABASE_STALL_TIMEOUT_MS: number;
  EDGE_DATABASE_CALL_CEILING_MS: number;
  EDGE_DATABASE_REPLACE_COOLDOWN_MS: number;
  EDGE_DATABASE_MAX_RETAINED_SOCKETS: number;
  EDGE_DATABASE_RETIRED_SOCKET_TTL_MS: number;
}

let cachedDbModule: Promise<{ mod: LoadedDatabaseModule; dir: string }> | null = null;

/** Bundle supabase/functions/_shared/database.ts for Node 22 using the same esbuild mapping as mcp-auth. */
async function loadDatabaseModule(): Promise<LoadedDatabaseModule> {
  if (!cachedDbModule) {
    cachedDbModule = (async () => {
      const dir = await mkdtemp(join(tmpdir(), "edge-db-node-bundle-"));
      const outfile = join(dir, "database.mjs");
      const postgresHref = pathToFileURL(join(repoRoot, "node_modules/postgres/src/index.js")).href;
      await esbuild({
        absWorkingDir: repoRoot,
        entryPoints: ["supabase/functions/_shared/database.ts"],
        outfile,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        banner: { js: "const __denoEnvGet = () => undefined;" },
        define: { "Deno.env.get": "__denoEnvGet" },
        plugins: [{
          name: "deno-npm-postgres",
          setup(builder) {
            builder.onResolve({ filter: /^npm:postgres@/ }, () => ({
              path: postgresHref,
              external: true,
            }));
          },
        }],
      });
      const mod = await import(pathToFileURL(outfile).href) as LoadedDatabaseModule;
      return { mod, dir };
    })();
  }
  return (await cachedDbModule).mod;
}

test.after(async () => {
  if (cachedDbModule) {
    const { dir } = await cachedDbModule;
    await rm(dir, { recursive: true, force: true });
  }
});

test("database options decode and verify a configured private CA", () => {
  const pem = "-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----\n";
  assert.deepEqual(withDatabaseTls({ max: 1 }, btoa(pem)), {
    max: 1,
    ssl: { ca: pem, rejectUnauthorized: true },
  });
  assert.throws(() => withDatabaseTls({}, "%%%"), /valid base64/);
  assert.throws(() => withDatabaseTls({}, btoa("not a certificate")), /PEM certificate/);
});

test("edgeDatabaseOptions sets plain postgres.js defaults, preserves pool size and TLS, and sets no custom socket", () => {
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
  assert.equal("socket" in opts, false, "edgeDatabaseOptions must never attach a custom socket factory");
  assert.deepEqual(opts.ssl, { ca: pem, rejectUnauthorized: true });

  const explicit = edgeDatabaseOptions({
    max: 2,
    ssl: { ca: pem, servername: "db.commonswarm.internal", rejectUnauthorized: true },
  }, btoa(pem));
  assert.equal("socket" in explicit, false);
  assert.deepEqual(explicit.ssl, {
    ca: pem,
    servername: "db.commonswarm.internal",
    rejectUnauthorized: true,
  });

  const noTls = edgeDatabaseOptions({ max: 1, idle_timeout: 10, connect_timeout: 4 }, undefined);
  assert.equal(noTls.max, 1);
  assert.equal(noTls.idle_timeout, 10);
  assert.equal(noTls.connect_timeout, 4);
  assert.equal("ssl" in noTls, false);
  assert.equal("socket" in noTls, false);
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

interface TlsTestPki {
  dir: string;
  trustedCa: string;
  matchingPair: { key: string; cert: string };
  wrongNamePair: { key: string; cert: string };
  untrustedCaPair: { key: string; cert: string };
  cleanup: () => Promise<void>;
}

function runOpenssl(args: string[]): void {
  const res = spawnSync("openssl", args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(res.status, 0, `openssl ${args[0]} failed: ${res.stderr}`);
}

async function createTestPki(): Promise<TlsTestPki> {
  const dir = await mkdtemp(join(tmpdir(), "edge-db-pki-"));
  try {
    const trustedCaKey = join(dir, "ca.key");
    const trustedCaCert = join(dir, "ca.crt");
    const untrustedCaKey = join(dir, "untrusted-ca.key");
    const untrustedCaCert = join(dir, "untrusted-ca.crt");

    runOpenssl([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", trustedCaKey, "-out", trustedCaCert,
      "-days", "1", "-subj", "/CN=CommonSwarm Test Internal CA",
    ]);
    runOpenssl([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", untrustedCaKey, "-out", untrustedCaCert,
      "-days", "1", "-subj", "/CN=CommonSwarm Untrusted CA",
    ]);

    const issueLeaf = async (
      name: string,
      dnsName: string,
      san: string,
      caCertPath: string,
      caKeyPath: string,
    ): Promise<{ key: string; cert: string }> => {
      const keyPath = join(dir, `${name}.key`);
      const csrPath = join(dir, `${name}.csr`);
      const extPath = join(dir, `${name}.ext`);
      const certPath = join(dir, `${name}.crt`);
      await writeFile(extPath, `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`, "utf8");
      runOpenssl([
        "req", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", csrPath,
        "-subj", `/CN=${dnsName}`,
      ]);
      runOpenssl([
        "x509", "-req", "-in", csrPath,
        "-CA", caCertPath, "-CAkey", caKeyPath, "-CAcreateserial",
        "-out", certPath, "-days", "1", "-extfile", extPath,
      ]);
      return {
        key: await readFile(keyPath, "utf8"),
        cert: await readFile(certPath, "utf8"),
      };
    };

    const matchingPair = await issueLeaf(
      "matching-leaf",
      MATCHING_HOST,
      `DNS:${MATCHING_HOST},IP:127.0.0.1`,
      trustedCaCert,
      trustedCaKey,
    );
    const wrongNamePair = await issueLeaf(
      "wrong-name-leaf",
      WRONG_DNS_HOST,
      `DNS:${WRONG_DNS_HOST}`,
      trustedCaCert,
      trustedCaKey,
    );
    const untrustedCaPair = await issueLeaf(
      "untrusted-leaf",
      MATCHING_HOST,
      `DNS:${MATCHING_HOST},IP:127.0.0.1`,
      untrustedCaCert,
      untrustedCaKey,
    );

    return {
      dir,
      trustedCa: await readFile(trustedCaCert, "utf8"),
      matchingPair,
      wrongNamePair,
      untrustedCaPair,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

interface FakePgQueryEvent {
  cid: number;
  text: string;
  isSimple: boolean;
  respond: (tag?: string, rows?: Array<Record<string, string>>) => void;
}

interface FakePgServer {
  server: net.Server;
  port: number;
  getConnCount: () => number;
  getOpenRawCount: () => number;
  getOpenTlsCount: () => number;
  getClosedRawCount: () => number;
  getClosedTlsCount: () => number;
  getDecryptedBytes: () => number;
  getSniNames: () => string[];
  destroyOldestSockets: (count?: number) => void;
  destroyConn: (cid: number) => void;
  closeAll: () => void;
}

function pgWireResponse(
  tagText: string,
  inTx: boolean,
  isSimple: boolean,
  rows?: Array<Record<string, string>>,
): Buffer {
  const parts: Buffer[] = [];
  if (!isSimple) {
    parts.push(Buffer.from([0x31, 0, 0, 0, 4])); // ParseComplete
  }
  if (rows && rows.length > 0) {
    const columns = Object.keys(rows[0]!);
    // RowDescription ('T')
    const colBufs: Buffer[] = [];
    for (const col of columns) {
      const nameBuf = Buffer.from(`${col}\0`, "utf8");
      const meta = Buffer.alloc(18);
      meta.writeUInt32BE(25, 6); // text oid
      meta.writeInt16BE(-1, 10);
      meta.writeInt32BE(-1, 12);
      colBufs.push(nameBuf, meta);
    }
    const rdBody = Buffer.concat([Buffer.from([(columns.length >> 8) & 0xff, columns.length & 0xff]), ...colBufs]);
    const rd = Buffer.alloc(5 + rdBody.length);
    rd[0] = 0x54;
    rd.writeUInt32BE(4 + rdBody.length, 1);
    rdBody.copy(rd, 5);
    parts.push(rd);
    if (!isSimple) parts.push(Buffer.from([0x32, 0, 0, 0, 4])); // BindComplete
    for (const row of rows) {
      const fieldBufs: Buffer[] = [];
      for (const col of columns) {
        const val = Buffer.from(String(row[col] ?? ""), "utf8");
        const len = Buffer.alloc(4);
        len.writeInt32BE(val.length, 0);
        fieldBufs.push(len, val);
      }
      const drBody = Buffer.concat([Buffer.from([(columns.length >> 8) & 0xff, columns.length & 0xff]), ...fieldBufs]);
      const dr = Buffer.alloc(5 + drBody.length);
      dr[0] = 0x44;
      dr.writeUInt32BE(4 + drBody.length, 1);
      drBody.copy(dr, 5);
      parts.push(dr);
    }
  } else if (!isSimple) {
    parts.push(Buffer.from([0x6e, 0, 0, 0, 4])); // NoData
    parts.push(Buffer.from([0x32, 0, 0, 0, 4])); // BindComplete
  }
  const tag = Buffer.from(`${tagText}\0`, "utf8");
  const cc = Buffer.alloc(5 + tag.length);
  cc[0] = 0x43;
  cc.writeUInt32BE(4 + tag.length, 1);
  tag.copy(cc, 5);
  parts.push(cc);
  parts.push(Buffer.from([0x5a, 0, 0, 0, 5, inTx ? 0x54 : 0x49])); // ReadyForQuery
  return Buffer.concat(parts);
}

async function startFakePgServer(options: {
  freezeConns?: ReadonlySet<number> | "all";
  freezeAfterFirstQuery?: ReadonlySet<number>;
  tlsPair?: { key: string; cert: string };
  queryDelayMs?: (text: string, cid: number) => number | "silent";
  onQuery?: (event: FakePgQueryEvent) => boolean | void;
  ignoreTerminate?: boolean;
  ignoreTerminateFor?: (cid: number) => boolean;
} = {}): Promise<FakePgServer> {
  const freezeConns = options.freezeConns ?? new Set<number>();
  const freezeAfterFirst = options.freezeAfterFirstQuery ?? new Set<number>();
  const ignoreTerminate = options.ignoreTerminate ?? true;
  const shouldIgnoreTerminate = (cid: number) =>
    options.ignoreTerminateFor ? options.ignoreTerminateFor(cid) : ignoreTerminate;
  let connCount = 0;
  let decryptedBytes = 0;
  let closedRaw = 0;
  let closedTls = 0;
  const sniNames: string[] = [];
  const openRaw = new Set<net.Socket>();
  const openTls = new Set<tls.TLSSocket>();
  const connSockets: Array<{ cid: number; raw: net.Socket; tls?: tls.TLSSocket }> = [];

  const isFrozenConn = (cid: number) =>
    freezeConns === "all" || freezeConns.has(cid);

  const attachWire = (sock: net.Socket | tls.TLSSocket, cid: number, isTls: boolean) => {
    let started = false;
    let frozen = false;
    let inTx = false;
    sock.on("data", (buf: Buffer) => {
      if (isTls) decryptedBytes += buf.length;
      if (buf[0] === 0x58) {
        if (!shouldIgnoreTerminate(cid)) sock.end();
        return;
      }
      if (frozen) return;
      if (!started) {
        started = true;
        sock.write(Buffer.concat([
          Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]), // AuthenticationOk
          Buffer.from([0x5a, 0, 0, 0, 5, 0x49]), // ReadyForQuery (Idle)
        ]));
        if (isFrozenConn(cid)) frozen = true;
        return;
      }
      const text = buf.toString("utf8");
      const isBegin = /\bbegin\b/i.test(text);
      const isCommit = /\bcommit\b/i.test(text);
      const isRollback = /\brollback\b/i.test(text);
      const isSimple = buf[0] === 0x51;
      if (isBegin) inTx = true;
      if (isCommit || isRollback) inTx = false;

      const defaultTag = isBegin ? "BEGIN" : isCommit ? "COMMIT" : isRollback ? "ROLLBACK" : "SELECT 1";
      const respond = (tag = defaultTag, rows?: Array<Record<string, string>>) => {
        if (!sock.destroyed && sock.writable) {
          sock.write(pgWireResponse(tag, inTx, isSimple, rows));
        }
        if ((isCommit || !inTx) && freezeAfterFirst.has(cid)) {
          frozen = true;
        }
      };

      if (options.onQuery) {
        const handled = options.onQuery({ cid, text, isSimple, respond });
        if (handled === true) return;
      }

      const delay = options.queryDelayMs ? options.queryDelayMs(text, cid) : 0;
      if (delay === "silent") return;
      if (delay > 0) {
        const t = setTimeout(() => respond(), delay);
        t.unref?.();
        return;
      }
      respond();
    });
  };

  // allowHalfOpen: true models a silently vanished peer that never answers TCP FIN / TLS close_notify.
  const server = net.createServer({ allowHalfOpen: true }, (raw) => {
    connCount += 1;
    const cid = connCount;
    openRaw.add(raw);
    const entry: { cid: number; raw: net.Socket; tls?: tls.TLSSocket } = { cid, raw };
    connSockets.push(entry);
    raw.on("error", () => {});
    raw.on("close", () => {
      openRaw.delete(raw);
      closedRaw += 1;
    });
    if (options.tlsPair) {
      const { key, cert } = options.tlsPair;
      raw.once("data", (first: Buffer) => {
        if (first.length === 8 && first.readInt32BE(4) === 80877103) {
          raw.write("S");
          const tlsSock = new tls.TLSSocket(raw, {
            isServer: true,
            key,
            cert,
            SNICallback(servername, cb) {
              sniNames.push(servername);
              cb(null);
            },
          });
          entry.tls = tlsSock;
          openTls.add(tlsSock);
          tlsSock.on("error", () => {});
          tlsSock.on("close", () => {
            openTls.delete(tlsSock);
            closedTls += 1;
          });
          attachWire(tlsSock, cid, true);
        } else {
          attachWire(raw, cid, false);
        }
      });
    } else {
      attachWire(raw, cid, false);
    }
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    server,
    port: address.port,
    getConnCount: () => connCount,
    getOpenRawCount: () => openRaw.size,
    getOpenTlsCount: () => openTls.size,
    getClosedRawCount: () => closedRaw,
    getClosedTlsCount: () => closedTls,
    getDecryptedBytes: () => decryptedBytes,
    getSniNames: () => [...sniNames],
    destroyOldestSockets: (count = 1) => {
      let destroyed = 0;
      for (const entry of connSockets) {
        if (destroyed >= count) break;
        if (entry.tls && !entry.tls.destroyed) {
          entry.tls.destroy();
          entry.raw.destroy();
          destroyed += 1;
        } else if (!entry.raw.destroyed) {
          entry.raw.destroy();
          destroyed += 1;
        }
      }
    },
    destroyConn: (cid: number) => {
      const entry = connSockets.find((e) => e.cid === cid);
      if (!entry) return;
      if (entry.tls && !entry.tls.destroyed) entry.tls.destroy();
      if (!entry.raw.destroyed) entry.raw.destroy();
    },
    closeAll: () => {
      for (const s of [...openTls]) s.destroy();
      for (const s of [...openRaw]) s.destroy();
      server.close();
    },
  };
}

test("stock postgres.js with edgeDatabaseOptions verifies TLS SNI and private CA before any Postgres byte", async () => {
  const pki = await createTestPki();
  const encodedCa = btoa(pki.trustedCa);
  try {
    // 1. Matching-name control: connects with DNS SNI and completes a query.
    const goodServer = await startFakePgServer({ tlsPair: pki.matchingPair, ignoreTerminate: false });
    try {
      const sql = postgres(
        `postgres://u:p@${MATCHING_HOST}:${goodServer.port}/db`,
        edgeDatabaseOptions({ max: 1, connect_timeout: 2, fetch_types: false }, encodedCa) as postgres.Options<Record<string, never>>,
      );
      try {
        await sql.begin(async (tx) => { await tx`SELECT 1`; });
        assert.deepEqual(goodServer.getSniNames(), [MATCHING_HOST]);
        assert.ok(goodServer.getDecryptedBytes() > 0, "matching-name control must send Postgres startup bytes");
      } finally {
        await sql.end({ timeout: 0 });
      }
    } finally {
      goodServer.closeAll();
    }

    // 2. Trusted CA, wrong DNS name: refused before any Postgres byte is sent.
    const wrongServer = await startFakePgServer({ tlsPair: pki.wrongNamePair });
    try {
      const sql = postgres(
        `postgres://u:p@${MATCHING_HOST}:${wrongServer.port}/db`,
        edgeDatabaseOptions({ max: 1, connect_timeout: 2, fetch_types: false }, encodedCa) as postgres.Options<Record<string, never>>,
      );
      try {
        await assert.rejects(() => sql`SELECT 1`);
        assert.deepEqual(wrongServer.getSniNames(), [MATCHING_HOST]);
        assert.equal(wrongServer.getDecryptedBytes(), 0, "wrong-name cert must be refused before any Postgres byte");
      } finally {
        await sql.end({ timeout: 0 });
      }
    } finally {
      wrongServer.closeAll();
    }

    // 3. Untrusted CA, matching DNS name: refused before any Postgres byte is sent.
    const untrustedServer = await startFakePgServer({ tlsPair: pki.untrustedCaPair });
    try {
      const sql = postgres(
        `postgres://u:p@${MATCHING_HOST}:${untrustedServer.port}/db`,
        edgeDatabaseOptions({ max: 1, connect_timeout: 2, fetch_types: false }, encodedCa) as postgres.Options<Record<string, never>>,
      );
      try {
        await assert.rejects(() => sql`SELECT 1`);
        assert.deepEqual(untrustedServer.getSniNames(), [MATCHING_HOST]);
        assert.equal(untrustedServer.getDecryptedBytes(), 0, "untrusted CA cert must be refused before any Postgres byte");
      } finally {
        await sql.end({ timeout: 0 });
      }
    } finally {
      untrustedServer.closeAll();
    }
  } finally {
    await pki.cleanup();
  }
});

test("edgeDatabaseOptions bounds connect_timeout on silent peer and disables reconnect backoff poisoning", async () => {
  const pki = await createTestPki();
  const silent = net.createServer((sock) => {
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const silentPort = (silent.address() as net.AddressInfo).port;

  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  try {
    for (const mode of ["plain", "tls"] as const) {
      const encodedCa = mode === "tls" ? btoa(pki.trustedCa) : undefined;
      const host = mode === "tls" ? MATCHING_HOST : "127.0.0.1";
      const sqlSilent = postgres(
        `postgres://u:p@${host}:${silentPort}/db`,
        edgeDatabaseOptions({ max: 1, connect_timeout: 1, fetch_types: false }, encodedCa) as postgres.Options<Record<string, never>>,
      );
      try {
        const t0 = Date.now();
        await assert.rejects(
          () => sqlSilent`SELECT 1`,
          (err: unknown) => (err as { code?: string })?.code === "CONNECT_TIMEOUT",
        );
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= 800 && elapsed < 3_000, `${mode}: expected ~1s CONNECT_TIMEOUT, got ${elapsed}ms`);
      } finally {
        await sqlSilent.end({ timeout: 0 });
      }

      const sqlDead = postgres(
        `postgres://u:p@${host}:${deadPort}/db`,
        edgeDatabaseOptions({ max: 1, connect_timeout: 2, fetch_types: false }, encodedCa) as postgres.Options<Record<string, never>>,
      );
      try {
        const start = Date.now();
        for (let i = 0; i < 10; i += 1) {
          await assert.rejects(() => sqlDead`SELECT 1`);
        }
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 3_000, `${mode}: 10 failed connects took ${elapsed}ms (backoff poisoned requests)`);
      } finally {
        await sqlDead.end({ timeout: 0 });
      }
    }
  } finally {
    silent.close();
    await pki.cleanup();
  }
});

test("holder: size-1 pool rejects silent TLS peer within stall bound, rotates, never replays, and recovers immediately", async () => {
  const { createEdgeDatabase, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const pki = await createTestPki();
  // Conn 1 goes silent after startup; conn 2 (replacement pool) is healthy!
  const server = await startFakePgServer({
    freezeConns: new Set([1]),
    tlsPair: pki.matchingPair,
    ignoreTerminate: false,
  });
  try {
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 1,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 350,
        call_ceiling_ms: 2_000,
        replace_cooldown_ms: 100,
      },
      btoa(pki.trustedCa),
    );
    try {
      let beginRuns = 0;
      const t0 = Date.now();
      await assert.rejects(
        () => db.begin(async (tx) => {
          beginRuns += 1;
          await tx`SELECT 1`;
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal((err as { code?: unknown }).code, EDGE_DATABASE_STALLED_CODE);
          assert.equal("cause" in err && err.cause !== undefined, false, "stall error must have no cause");
          assert.doesNotMatch(err.message, /postgres:|localhost|127\.0\.0\.1/);
          return true;
        },
      );
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 280 && elapsed < 1_500, `expected stall ~350ms, got ${elapsed}ms`);
      assert.equal(beginRuns, 0, "holder must never replay a stalled begin callback");

      // Next call immediately uses the fresh replacement pool (conn 2) and succeeds.
      const tNext = Date.now();
      await db.begin(async (tx) => {
        await tx`SELECT 2`;
      });
      assert.ok(Date.now() - tNext < 1_000, "recovery on fresh pool must be immediate");
      assert.equal(server.getConnCount(), 2);
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("holder: size-2 pool under healthy burst (total > N) and legitimate slow call (< N) triggers NO replacement", async () => {
  const { createEdgeDatabase } = await loadDatabaseModule();
  const pki = await createTestPki();
  const server = await startFakePgServer({
    tlsPair: pki.matchingPair,
    ignoreTerminate: false,
    queryDelayMs: (text) => {
      if (text.includes("SLOW_LEGIT")) return 220;
      if (text.includes("BURST")) return 45;
      return 0;
    },
  });
  try {
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 2,
        idle_timeout: 10,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 350,
        call_ceiling_ms: 3_000,
        replace_cooldown_ms: 100,
      },
      btoa(pki.trustedCa),
    );
    try {
      // Burst: 26 queued transactions x 45ms on size-2 pool => ~585ms total (> 350ms stall_timeout_ms).
      const tBurst = Date.now();
      await Promise.all(
        Array.from({ length: 26 }, (_, i) =>
          db.begin(async (tx) => {
            await tx`SELECT 'BURST_${i}'`;
          }),
        ),
      );
      const burstMs = Date.now() - tBurst;
      assert.ok(burstMs >= 400, `burst should exceed stall_timeout_ms (350ms), took ${burstMs}ms`);
      assert.ok(server.getConnCount() <= 2, `healthy burst must not replace pool; opened ${server.getConnCount()} conns`);

      // One legitimate slower call (220ms < 350ms) alongside fast sibling calls: no replacement.
      await Promise.all([
        db.begin(async (tx) => { await tx`SELECT 'SLOW_LEGIT'`; }),
        db.begin(async (tx) => { await tx`SELECT 'BURST_A'`; }),
        db.begin(async (tx) => { await tx`SELECT 'BURST_B'`; }),
      ]);
      assert.ok(server.getConnCount() <= 2, `legitimate slow call must not replace pool; opened ${server.getConnCount()} conns`);
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("holder: size-2 stall rejects a healthy sibling transaction (accepted cost) without replaying it", async () => {
  const { createEdgeDatabase, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const pki = await createTestPki();
  const server = await startFakePgServer({
    tlsPair: pki.matchingPair,
    queryDelayMs: (text) => {
      if (text.includes("SILENT_TX")) return "silent";
      if (text.includes("SIBLING_WAIT")) return 700;
      return 0;
    },
  });
  try {
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 2,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 300,
        call_ceiling_ms: 2_000,
        replace_cooldown_ms: 100,
      },
      btoa(pki.trustedCa),
    );
    try {
      let siblingStarts = 0;
      const [silentRes, siblingRes] = await Promise.all([
        db.begin(async (tx) => { await tx`SELECT 'SILENT_TX'`; }).then(
          () => ({ ok: true as const }),
          (err) => ({ ok: false as const, code: (err as { code?: string })?.code }),
        ),
        db.begin(async (tx) => {
          siblingStarts += 1;
          await tx`SELECT 'SIBLING_WAIT'`;
        }).then(
          () => ({ ok: true as const }),
          (err) => ({ ok: false as const, code: (err as { code?: string })?.code }),
        ),
      ]);
      assert.deepEqual(silentRes, { ok: false, code: EDGE_DATABASE_STALLED_CODE });
      assert.deepEqual(siblingRes, { ok: false, code: EDGE_DATABASE_STALLED_CODE });
      assert.equal(siblingStarts, 1, "sibling transaction must never be replayed");

      // Next call succeeds on fresh pool.
      await db`SELECT 1`;
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("holder: per-call ceiling catches a silent call masked by a progressing healthy sibling on a size-2 pool", async () => {
  const { createEdgeDatabase, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const pki = await createTestPki();
  const server = await startFakePgServer({
    tlsPair: pki.matchingPair,
    queryDelayMs: (text) => (text.includes("SILENT_FOREVER") ? "silent" : 0),
  });
  try {
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 2,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 300,
        call_ceiling_ms: 850,
        replace_cooldown_ms: 100,
      },
      btoa(pki.trustedCa),
    );
    try {
      const t0 = Date.now();
      const silentCall = db`SELECT 'SILENT_FOREVER'`.then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, code: (err as { code?: string })?.code, at: Date.now() - t0 }),
      );

      // Keep the sibling completing every 120ms so the 300ms no-progress rule NEVER fires!
      let siblingSuccesses = 0;
      let running = true;
      const siblingLoop = (async () => {
        while (running) {
          try {
            await db`SELECT 'HEALTHY_TICK'`;
            siblingSuccesses += 1;
          } catch {
            // One tick may coincide with the ceiling replacement.
          }
          await new Promise((r) => setTimeout(r, 120));
        }
      })();

      const silentOutcome = await silentCall;
      running = false;
      await siblingLoop;

      assert.equal(silentOutcome.ok, false);
      if (!silentOutcome.ok) {
        assert.equal(silentOutcome.code, EDGE_DATABASE_STALLED_CODE);
        assert.ok(
          silentOutcome.at >= 750 && silentOutcome.at < 2_000,
          `silent masked call must settle at ceiling (~850ms), settled at ${silentOutcome.at}ms`,
        );
      }
      assert.ok(siblingSuccesses >= 4, `healthy sibling should complete repeatedly before ceiling (got ${siblingSuccesses})`);

      // Post-ceiling recovery works immediately.
      await db`SELECT 'POST_CEILING_OK'`;
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("holder: two stalls inside cooldown perform only one replacement and discard late results from replaced pools", async () => {
  const { createEdgeDatabase, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const pki = await createTestPki();
  let delayedResponder: (() => void) | null = null;
  let lateResultDeliveredToServer = false;
  const server = await startFakePgServer({
    tlsPair: pki.matchingPair,
    onQuery: ({ cid, text, respond }) => {
      if (cid === 1 && text.includes("LATE_RESULT")) {
        delayedResponder = () => {
          lateResultDeliveredToServer = true;
          respond("SELECT 1");
        };
        return true;
      }
      if (cid === 2) {
        // Conn 2 stays silent so a second stall happens inside cooldown!
        return true;
      }
      return false;
    },
  });
  try {
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 1,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 250,
        call_ceiling_ms: 2_000,
        replace_cooldown_ms: 1_200,
      },
      btoa(pki.trustedCa),
    );
    try {
      // Stall 1 (outside cooldown) -> replaces pool 1 with pool 2.
      await assert.rejects(
        () => db`SELECT 'LATE_RESULT'`,
        (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
      );
      assert.equal(server.getConnCount(), 1);

      // Fire a late server reply for pool 1's already-rejected query: must be silently discarded (no unhandled rejection).
      assert.ok(delayedResponder !== null);
      (delayedResponder as () => void)();
      assert.equal(lateResultDeliveredToServer, true);

      // Stall 2 (inside 1200ms cooldown) -> opens conn 2 on pool 2, stalls, rejects waiters, REUSES pool 2 (no conn 3!).
      await assert.rejects(
        () => db`SELECT 'STALL_IN_COOLDOWN'`,
        (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
      );
      assert.equal(server.getConnCount(), 2, "second stall inside cooldown must reuse pool 2 (not open pool 3)");

      // Third call still inside cooldown also runs on reused pool 2 (still no conn 3!).
      await assert.rejects(
        () => db`SELECT 'STALL_STILL_IN_COOLDOWN'`,
        (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
      );
      assert.equal(server.getConnCount(), 2);

      // Wait past cooldown, stall once more -> now pool 2 IS replaced by pool 3 (conn 3 healthy!).
      await new Promise((r) => setTimeout(r, 850));
      await assert.rejects(
        () => db`SELECT 'STALL_AFTER_COOLDOWN'`,
        (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
      );
      await db`SELECT 'HEALTHY_ON_POOL_3'`;
      assert.equal(server.getConnCount(), 3);
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("holder: size-1 repeated half-open TLS rotations hit socket cap, fail fast with bounded sockets, and recover once sockets close", async () => {
  const { createEdgeDatabase, inspectEdgeDatabaseHolder, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const pki = await createTestPki();
  // Conns 1 and 2 freeze silently and never answer close_notify/FIN; conn 3 is healthy!
  const server = await startFakePgServer({
    freezeConns: new Set([1, 2]),
    tlsPair: pki.matchingPair,
    ignoreTerminate: true,
  });
  try {
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 1,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 200,
        call_ceiling_ms: 2_000,
        replace_cooldown_ms: 50,
        max_retained_sockets: 2,
      },
      btoa(pki.trustedCa),
    );
    try {
      // Rotation 1: pool 1 stalls -> retired (1/2 sockets), pool 2 swapped in (1 + 1 <= 2).
      await assert.rejects(
        () => db`SELECT 'ROT_1'`,
        (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
      );
      assert.equal(server.getConnCount(), 1);
      assert.equal(server.getOpenTlsCount(), 1, "half-open TLS socket from pool 1 remains open on silent peer");
      assert.ok(inspectEdgeDatabaseHolder(db)!.retainedSockets >= server.getOpenTlsCount());

      await new Promise((r) => setTimeout(r, 80));

      // Rotation 2: pool 2 stalls -> retired (2/2 sockets, CAP REACHED: 2 + 1 > 2), no pool 3 created!
      await assert.rejects(
        () => db`SELECT 'ROT_2'`,
        (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
      );
      assert.equal(server.getConnCount(), 2);
      assert.equal(server.getOpenTlsCount(), 2, "both retired half-open TLS sockets remain open");
      assert.equal(server.getClosedTlsCount(), 0);
      assert.equal(inspectEdgeDatabaseHolder(db)!.retiredSockets, 2);

      // At cap: 5 consecutive calls MUST fail fast (< 100ms total) with ZERO new sockets opened!
      const tCap = Date.now();
      for (let i = 0; i < 5; i += 1) {
        await assert.rejects(
          () => db`SELECT 'AT_CAP_${i}'`,
          (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
        );
      }
      const capElapsed = Date.now() - tCap;
      assert.ok(capElapsed < 100, `at-cap calls must fail fast without waiting, took ${capElapsed}ms`);
      assert.equal(server.getConnCount(), 2, "socket cap must strictly bound total opened sockets");

      // Recovery: peer/keepalive closes one retired pool's socket -> postgres.js onclose fires -> holder recovers!
      server.destroyOldestSockets(1);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(server.getClosedTlsCount(), 1, "server observed 1 retired TLS socket physically closed");
      assert.equal(server.getOpenTlsCount(), 1);
      assert.equal(inspectEdgeDatabaseHolder(db)!.retiredSockets, 1);

      const tRec = Date.now();
      await db`SELECT 'RECOVERED_AFTER_SOCKET_CLOSE'`;
      assert.ok(Date.now() - tRec < 1_000, "holder must recover immediately once a retired pool frees its socket");
      assert.equal(server.getConnCount(), 3);
      assert.ok(inspectEdgeDatabaseHolder(db)!.retainedSockets >= server.getOpenTlsCount());
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("holder C1: size-2 pool with mixed half-closed and normal closure never undercounts, bounds live allocations, and recovers on final close", async () => {
  const { createEdgeDatabase, inspectEdgeDatabaseHolder, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const pki = await createTestPki();
  // Conn 1 (pool 1 slot A): answers first query then goes silent & ignores Terminate (half-closed).
  // Conn 2 (pool 1 slot B): healthy, will be closed normally while pool 1 is still live.
  // Conn 3 (pool 1 slot B replacement): healthy, answers Terminate cleanly at pool 1 retirement.
  // Conns 4 & 5 (pool 2 slots A & B): freeze silently and ignore Terminate (half-closed).
  // Conn 6 (pool 3): healthy!
  let releaseGate: (() => void) | null = null;
  const server = await startFakePgServer({
    freezeAfterFirstQuery: new Set([1]),
    freezeConns: new Set([4, 5]),
    tlsPair: pki.matchingPair,
    ignoreTerminateFor: (cid) => cid === 1 || cid === 4 || cid === 5,
    onQuery: ({ cid, text, respond }) => {
      if (text.includes("HOLD_BOTH_OPEN") && cid === 1) {
        releaseGate = () => respond("SELECT 1");
        return true;
      }
      return false;
    },
  });
  try {
    const maxRetainedSockets = 4;
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 2,
        idle_timeout: 10,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 200,
        call_ceiling_ms: 2_000,
        replace_cooldown_ms: 50,
        max_retained_sockets: maxRetainedSockets,
      },
      btoa(pki.trustedCa),
    );
    try {
      const assertConservativeInvariant = (label: string) => {
        const snap = inspectEdgeDatabaseHolder(db)!;
        const serverOpen = server.getOpenTlsCount();
        assert.ok(
          snap.retainedSockets >= serverOpen,
          `${label}: holder count (${snap.retainedSockets}) fell below server open sockets (${serverOpen})`,
        );
        assert.ok(
          serverOpen <= maxRetainedSockets,
          `${label}: server open sockets (${serverOpen}) exceeded cap (${maxRetainedSockets})`,
        );
        assert.ok(
          snap.retainedSockets <= maxRetainedSockets,
          `${label}: holder reserved sockets (${snap.retainedSockets}) exceeded cap (${maxRetainedSockets})`,
        );
      };

      // Step 1: Open both sockets on pool 1 simultaneously (conn 1 held while conn 2 runs).
      const q1 = Promise.resolve(db`SELECT 'HOLD_BOTH_OPEN'`);
      const waitGate = Date.now() + 2_000;
      while (releaseGate === null && Date.now() < waitGate) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(releaseGate !== null, "conn 1 must hold HOLD_BOTH_OPEN");
      const q2 = Promise.resolve(db`SELECT 'OPEN_SECOND_SLOT'`);
      await q2;
      assert.equal(server.getConnCount(), 2, "pool 1 opened both sockets");
      assert.equal(server.getOpenTlsCount(), 2);
      assertConservativeInvariant("both sockets open on pool 1");
      (releaseGate as () => void)();
      await q1;
      // Conn 1 is now frozen (silent peer) after its first query.

      // Step 2: Conn 2 closes normally while pool 1 is still live; conn 1 stays open.
      server.destroyConn(2);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(server.getOpenTlsCount(), 1, "conn 1 still open while conn 2 closed");
      assert.equal(inspectEdgeDatabaseHolder(db)!.retainedSockets, 2, "live pool stays conservatively reserved at max=2");
      assertConservativeInvariant("after conn 2 normal close while live");

      // Step 3: A lone call on pool 1 opens replacement conn 3 (or hits silent conn 1).
      // Run two concurrent calls so one hits silent conn 1 and the other exercises slot B (conn 3),
      // ensuring conn 3 opens while conn 1 is still half-closed and then pool 1 stalls & retires!
      const results = await Promise.allSettled([
        db`SELECT 'TRIGGER_STALL_A'`,
        db`SELECT 'TRIGGER_STALL_B'`,
      ]);
      // At least one hit silent conn 1 and stalled pool 1!
      const stalledCount = results.filter(
        (r) => r.status === "rejected" && (r.reason as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
      ).length;
      assert.ok(stalledCount >= 1, "pool 1 must stall on silent conn 1");

      // Wait briefly so pool 1's end({ timeout: 0 }) finishes and healthy conn 3 closes normally (ignoreTerminateFor(3)=false).
      await new Promise((r) => setTimeout(r, 120));
      // Conn 1 is STILL open (half-closed); conn 3 closed normally after retirement -> pool 1 MUST remain in cap with 1 reserved socket!
      assert.equal(server.getOpenTlsCount(), 1, "pool 1's half-closed conn 1 remains open after conn 3 closed normally");
      const afterPool1Retire = inspectEdgeDatabaseHolder(db)!;
      assert.equal(afterPool1Retire.retiredPoolCount, 1, "pool 1 must NOT leave cap while conn 1 is still open");
      assert.ok(afterPool1Retire.retiredSockets >= 1, `pool 1 must retain >= 1 socket, got ${afterPool1Retire.retiredSockets}`);
      assertConservativeInvariant("after pool 1 retirement and conn 3 normal close");

      // Step 4: Pool 2 opens its two sockets (both silent half-closed conns 4 & 5) and stalls -> retires!
      await Promise.allSettled([
        db`SELECT 'POOL2_SILENT_A'`,
        db`SELECT 'POOL2_SILENT_B'`,
      ]);
      await new Promise((r) => setTimeout(r, 100));
      // Now pool 1 has >= 1 reserved socket (conn 1) + pool 2 has 2 reserved sockets (conns 4 & 5) => >= 3 retired sockets.
      // Opening pool 3 (max=2) would need >= 3 + 2 = 5 > 4 -> CAP REACHED!
      const atCap = inspectEdgeDatabaseHolder(db)!;
      assert.ok(atCap.retiredSockets >= 3, `expected >= 3 retired sockets at cap, got ${atCap.retiredSockets}`);
      assertConservativeInvariant("at cap after pool 2 retirement");
      const connsAtCap = server.getConnCount();

      // At cap: consecutive calls fail fast (< 100ms) with ZERO new sockets allocated!
      const tCap = Date.now();
      for (let i = 0; i < 4; i += 1) {
        await assert.rejects(
          () => db`SELECT 'SIZE2_AT_CAP_${i}'`,
          (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
        );
      }
      assert.ok(Date.now() - tCap < 100, "size-2 cap must fail fast");
      assert.equal(server.getConnCount(), connsAtCap, "size-2 cap must open zero new sockets");
      assertConservativeInvariant("during fail-fast cap");

      // Step 5: Confirmed closure of pool 1's last half-closed socket (conn 1) frees pool 1 -> retired drops to 2 -> 2 + 2 <= 4 -> recovers!
      server.destroyConn(1);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(inspectEdgeDatabaseHolder(db)!.retiredSockets, 2, "confirmed closure of conn 1 retires pool 1 from cap");
      assertConservativeInvariant("after confirmed closure of pool 1's last socket");

      await db`SELECT 'SIZE2_RECOVERED'`;
      assertConservativeInvariant("after pool 3 recovery");
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("holder C1: retired size-2 pool that only ever opened 1 socket releases its unproven reservation after retired_socket_ttl_ms", async () => {
  const { createEdgeDatabase, inspectEdgeDatabaseHolder, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const pki = await createTestPki();
  const server = await startFakePgServer({
    freezeConns: new Set([1]),
    tlsPair: pki.matchingPair,
    ignoreTerminate: false,
  });
  try {
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 2,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 150,
        call_ceiling_ms: 2_000,
        replace_cooldown_ms: 50,
        max_retained_sockets: 2,
        retired_socket_ttl_ms: 300,
      },
      btoa(pki.trustedCa),
    );
    try {
      // Only 1 query runs on pool 1 (max=2), so only 1 socket ever opened; pool 1 stalls & retires at cap (2 + 2 > 2).
      await assert.rejects(
        () => db`SELECT 'ONLY_ONE_SOCKET'`,
        (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
      );
      // Even after conn 1 closes normally, 1 unproven socket remains conservatively reserved (1 + 2 = 3 > 2 -> at cap).
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(inspectEdgeDatabaseHolder(db)!.retiredSockets, 1);
      await assert.rejects(
        () => db`SELECT 'STILL_CONSERVATIVELY_RESERVED'`,
        (err: unknown) => (err as { code?: string })?.code === EDGE_DATABASE_STALLED_CODE,
      );
      // After retired_socket_ttl_ms elapses, the unproven reservation expires and capacity is restored!
      await new Promise((r) => setTimeout(r, 260));
      assert.equal(inspectEdgeDatabaseHolder(db)!.retiredSockets, 0);
      await db`SELECT 'RECOVERED_AFTER_TTL'`;
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("holder small hardening: unsupported postgres.js features throw naming the property while then, symbols and inspection return undefined", async () => {
  const { createEdgeDatabase } = await loadDatabaseModule();
  const db = createEdgeDatabase("postgres://u:p@127.0.0.1:5432/db", { max: 1, fetch_types: false }, undefined);
  try {
    const unsupported = [
      "json",
      "unsafe",
      "array",
      "listen",
      "reserve",
      "file",
      "types",
      "typed",
      "notify",
      "subscribe",
      "largeObject",
      "close",
      "options",
      "parameters",
    ];
    for (const prop of unsupported) {
      assert.throws(
        () => (db as unknown as Record<string, unknown>)[prop],
        (err: unknown) => err instanceof Error && err.message.includes(prop),
        `accessing unsupported feature "${prop}" must throw naming it`,
      );
    }
    const raw = db as unknown as Record<PropertyKey, unknown>;
    assert.equal(raw.then, undefined, "holder must not look like a thenable");
    assert.equal(raw.catch, undefined);
    assert.equal(raw.finally, undefined);
    assert.equal(raw.toJSON, undefined);
    assert.equal(raw.inspect, undefined);
    assert.equal(raw[Symbol.toStringTag], undefined);
    assert.equal(raw[Symbol.for("nodejs.util.inspect.custom")], undefined);
    assert.equal(raw[Symbol.for("Deno.customInspect")], undefined);
    // Must resolve directly to the holder itself when awaited or wrapped in Promise.resolve.
    assert.equal(await Promise.resolve(db), db);
  } finally {
    await db.end({ timeout: 0 });
  }
});

test("C2: stall followed by a held diagnostic insert returns retryable 503 inside request budget; unheld diagnostic still writes", async () => {
  const { createEdgeDatabase, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const pki = await createTestPki();
  const server = await startFakePgServer({
    freezeConns: new Set([1]),
    tlsPair: pki.matchingPair,
    ignoreTerminate: true,
  });
  try {
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 1,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 200,
        call_ceiling_ms: 2_000,
        replace_cooldown_ms: 50,
      },
      btoa(pki.trustedCa),
    );
    try {
      // 1. Real holder stall followed by a held diagnostic insert (simulates second stall/hang on diagnostic pool).
      const requestDeadlineAt = Date.now() + 380; // 200ms stall + ~180ms remaining request budget
      let stalledError: unknown = null;
      try {
        await db`SELECT 'STALL_THEN_HELD_DIAGNOSTIC'`;
      } catch (err) {
        stalledError = err;
      }
      assert.equal(dbCode(stalledError), EDGE_DATABASE_STALLED_CODE);

      let releaseHeldInsert: ((err: Error) => void) | null = null;
      let insertFailureSeen = false;
      const failure = durableCommandFailure({
        commandKind: "post_signal",
        reason: classifyCommandFailure(false, dbCode(stalledError)),
        code: dbCode(stalledError),
        error: stalledError,
        requestId: "44444444-5555-4666-8777-888888888888",
      });
      const tCatch = Date.now();
      const response = await finishCommandFailure(
        failure,
        () => new Promise<void>((_resolve, reject) => { releaseHeldInsert = reject; }),
        () => { insertFailureSeen = true; },
        remainingFailureBudgetMs(requestDeadlineAt, 500),
      );
      const catchElapsed = Date.now() - tCatch;
      assert.deepEqual(response, { status: 503, body: { error: "temporarily_unavailable" } });
      assert.equal(insertFailureSeen, true, "abandoned diagnostic must report insertion failure");
      assert.ok(catchElapsed < 400, `held diagnostic must be abandoned within remaining budget (took ${catchElapsed}ms)`);
      // Rejecting the abandoned diagnostic promise later must NOT produce an unhandled rejection.
      (releaseHeldInsert as ((err: Error) => void) | null)?.(new Error("late diagnostic failure"));
      await new Promise((r) => setTimeout(r, 20));

      // 2. Exhausted budget (<= 0ms) skips persistence immediately and returns the safe fallback.
      let calledWhenExhausted = false;
      let exhaustedCallback = false;
      const tZero = Date.now();
      const zeroRes = await finishCommandFailure(
        failure,
        async () => { calledWhenExhausted = true; },
        () => { exhaustedCallback = true; },
        remainingFailureBudgetMs(Date.now() - 10),
      );
      assert.deepEqual(zeroRes, { status: 503, body: { error: "temporarily_unavailable" } });
      assert.equal(calledWhenExhausted, false);
      assert.equal(exhaustedCallback, true);
      assert.ok(Date.now() - tZero < 50);

      // 3. Unheld diagnostic insert still completes and persists the row.
      const persisted: DurableCommandFailure[] = [];
      const okRes = await finishCommandFailure(
        failure,
        async (row) => { persisted.push(row); },
        () => { assert.fail("unheld diagnostic should succeed"); },
        500,
      );
      assert.deepEqual(okRes, { status: 503, body: { error: "temporarily_unavailable" } });
      assert.equal(persisted.length, 1);

      // 4. runWithinFailureBudget bounds held admin/cleanup writes and honors AbortSignal.
      const heldBudget = await runWithinFailureBudget(80, () => new Promise<void>(() => {}));
      assert.equal(heldBudget.ok, false);
      const ac = new AbortController();
      ac.abort();
      const abortedBudget = await runWithinFailureBudget(500, async () => "ok", ac.signal);
      assert.equal(abortedBudget.ok, false);
      const fastBudget = await runWithinFailureBudget(500, async () => "saved");
      assert.deepEqual(fastBudget, { ok: true, value: "saved" });
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("storage calls in command/index.ts enforce AbortSignal.timeout(3_000) and map timeouts to storage errors", async () => {
  const source = await readFile(join(repoRoot, "supabase/functions/command/index.ts"), "utf8");
  const start = source.indexOf("function fileStorage(): FileStorage {");
  const end = source.indexOf("const authClient = createClient(", start);
  assert.ok(start > 0 && end > start, "fileStorage adapter must exist");
  const block = source.slice(start, end);
  assert.match(source, /const FILE_STORAGE_TIMEOUT_MS = 3_000;/);
  const timeoutSignals = block.match(/signal:\s*AbortSignal\.timeout\(FILE_STORAGE_TIMEOUT_MS\)/g) ?? [];
  assert.equal(timeoutSignals.length, 4, "all four fileStorage methods (signUpload, objectSize, removeObjects, signDownload) must carry AbortSignal.timeout(FILE_STORAGE_TIMEOUT_MS)");
  assert.match(block, /storage upload sign failed: timeout/);
  assert.match(block, /storage object info failed: timeout/);
  assert.match(block, /storage download sign failed: timeout/);
});

test("holder: idle pool and unawaited lazy tagged template leave zero timers running (process exits cleanly)", async () => {
  await loadDatabaseModule();
  const { dir } = await cachedDbModule!;
  const pki = await createTestPki();
  const server = await startFakePgServer({ tlsPair: pki.matchingPair, ignoreTerminate: false });
  const scriptDir = await mkdtemp(join(tmpdir(), "edge-db-idle-exit-"));
  const scriptPath = join(scriptDir, "idle-exit.mjs");
  try {
    await writeFile(scriptPath, `
      import { createEdgeDatabase } from ${JSON.stringify(pathToFileURL(join(dir, "database.mjs")).href)};
      const db = createEdgeDatabase(
        ${JSON.stringify(`postgres://u:p@${MATCHING_HOST}:${server.port}/db`)},
        { max: 1, idle_timeout: 1, connect_timeout: 2, fetch_types: false, stall_timeout_ms: 15000 },
        ${JSON.stringify(btoa(pki.trustedCa))},
      );
      // Unawaited lazy tagged template must not execute or start any timer.
      const _unused = db\`SELECT 'NEVER_AWAITED'\`;
      // Run one real query, then end cleanly.
      await db\`SELECT 1\`;
      await db.end({ timeout: 1 });
      console.log("IDLE_EXIT_READY");
    `, "utf8");

    const res = await new Promise<{ exitedOnOwn: boolean; status: number | null; out: string; err: string }>((resolveRun) => {
      const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += String(d); });
      child.stderr.on("data", (d) => { err += String(d); });
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveRun({ exitedOnOwn: false, status: null, out, err });
      }, 4_000);
      child.on("close", (status) => {
        clearTimeout(killer);
        resolveRun({ exitedOnOwn: true, status, out, err });
      });
    });

    assert.equal(res.exitedOnOwn, true, `idle holder kept event loop alive: ${res.out}${res.err}`);
    assert.equal(res.status, 0, res.err);
    assert.match(res.out, /IDLE_EXIT_READY/);
  } finally {
    server.closeAll();
    await pki.cleanup();
    await rm(scriptDir, { recursive: true, force: true });
  }
});

test("command and read HTTP mappings classify EDGE_DATABASE_STALLED as existing retryable 5xx with no new shape", async () => {
  const { EdgeDatabaseStalledError, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const stalled = new EdgeDatabaseStalledError();
  assert.equal(dbCode(stalled), EDGE_DATABASE_STALLED_CODE);

  // Command mapping: existing 503 { error: "temporarily_unavailable" }, db_code preserved, best-effort insert never masks it.
  const rows: DurableCommandFailure[] = [];
  const reason = classifyCommandFailure(false, dbCode(stalled));
  assert.equal(reason, "internal_error");
  const failure = durableCommandFailure({
    commandKind: "post_signal",
    reason,
    code: dbCode(stalled),
    error: stalled,
    requestId: "11111111-2222-4333-8444-555555555555",
  });
  assert.equal(failure.db_code, EDGE_DATABASE_STALLED_CODE);
  const cmdRes = await finishCommandFailure(failure, async (row) => { rows.push(row); });
  assert.deepEqual(cmdRes, { status: 503, body: { error: "temporarily_unavailable" } });
  assert.equal(rows.length, 1);

  // Best-effort diagnostic insert failure (e.g. second stall) must never mask the 503 response.
  let insertFailureSeen = false;
  const cmdResWhenAuditFails = await finishCommandFailure(
    failure,
    async () => { throw new EdgeDatabaseStalledError(); },
    () => { insertFailureSeen = true; },
  );
  assert.equal(insertFailureSeen, true);
  assert.deepEqual(cmdResWhenAuditFails, { status: 503, body: { error: "temporarily_unavailable" } });

  // Read mapping: existing retryable 500 { error: "internal_error", request_id, retryable: true }.
  assert.equal(isRetryableErrorCode(EDGE_DATABASE_STALLED_CODE), true);
  const diag = extractSafeDiagnostics(stalled, "query", "22222222-3333-4444-8555-666666666666");
  assert.equal(diag.code, EDGE_DATABASE_STALLED_CODE);
  assert.equal(diag.retryable, true);
  assert.equal(firstForbiddenDiagnosticKey(diag as unknown as Record<string, unknown>), null);
  assert.doesNotMatch(formatReadFailureLog(diag), /postgres:|127\.0\.0\.1/);
  assert.deepEqual(publicReadErrorBody(diag), {
    error: "internal_error",
    request_id: "22222222-3333-4444-8555-666666666666",
    retryable: true,
  });
});

test("lost reply after commit: stall error returns 503, retry with same command_id replays stored receipt with one row written", async () => {
  const { createEdgeDatabase, EDGE_DATABASE_STALLED_CODE } = await loadDatabaseModule();
  const pki = await createTestPki();

  // In-memory transactional store simulating swarm.signals + swarm.idempotency_keys.
  const committedSignals: Array<{ id: string; body: string }> = [];
  const committedReceipts = new Map<string, string>();
  let pendingSignal: { id: string; body: string } | null = null;
  let pendingReceipt: { commandId: string; receipt: string } | null = null;

  const server = await startFakePgServer({
    tlsPair: pki.matchingPair,
    onQuery: ({ cid, text, respond }) => {
      if (/\bbegin\b/i.test(text)) {
        pendingSignal = null;
        pendingReceipt = null;
        respond("BEGIN");
        return true;
      }
      if (text.includes("SELECT receipt FROM idempotency_keys")) {
        const match = /cmd_([a-z0-9-]+)/i.exec(text);
        const key = match ? match[0] : "";
        const existing = committedReceipts.get(key);
        respond("SELECT", existing ? [{ receipt: existing }] : []);
        return true;
      }
      if (text.includes("INSERT INTO signals")) {
        const id = `sig-${committedSignals.length + 1}`;
        pendingSignal = { id, body: "hello-once" };
        respond("INSERT 0 1", [{ id }]);
        return true;
      }
      if (text.includes("INSERT INTO idempotency_keys")) {
        const match = /cmd_([a-z0-9-]+)/i.exec(text);
        const key = match ? match[0] : "";
        const receipt = JSON.stringify({ status: 200, signal_id: pendingSignal?.id ?? "unknown" });
        pendingReceipt = { commandId: key, receipt };
        respond("INSERT 0 1");
        return true;
      }
      if (/\bcommit\b/i.test(text)) {
        // Commit succeeds durably in Postgres!
        if (pendingSignal) committedSignals.push(pendingSignal);
        if (pendingReceipt) committedReceipts.set(pendingReceipt.commandId, pendingReceipt.receipt);
        pendingSignal = null;
        pendingReceipt = null;
        if (cid === 1) {
          // Reply to COMMIT is LOST on conn 1 (half-open silent peer after commit)!
          return true;
        }
        respond("COMMIT");
        return true;
      }
      return false;
    },
  });

  try {
    const db = createEdgeDatabase(
      `postgres://u:p@${MATCHING_HOST}:${server.port}/db`,
      {
        max: 1,
        connect_timeout: 2,
        fetch_types: false,
        stall_timeout_ms: 250,
        call_ceiling_ms: 2_000,
        replace_cooldown_ms: 50,
      },
      btoa(pki.trustedCa),
    );
    try {
      const commandId = "cmd_723-lost-reply";
      const runCommand = async (cmdId: string): Promise<{ status: number; body: Record<string, unknown> }> => {
        try {
          return await db.begin("isolation level read committed", async (tx) => {
            const existing = await tx<{ receipt: string }[]>`
              SELECT receipt FROM idempotency_keys WHERE command_id = ${cmdId}
            `;
            if (existing.length > 0) {
              return { status: 200, body: JSON.parse(existing[0]!.receipt) as Record<string, unknown> };
            }
            const inserted = await tx<{ id: string }[]>`
              INSERT INTO signals (body) VALUES ('hello-once') RETURNING id
            `;
            const receipt = { status: 200, signal_id: inserted[0]!.id };
            await tx`
              INSERT INTO idempotency_keys (command_id, receipt) VALUES (${cmdId}, ${JSON.stringify(receipt)})
            `;
            return { status: 200, body: receipt };
          });
        } catch (error) {
          const code = dbCode(error);
          const failure = durableCommandFailure({
            commandKind: "post_signal",
            reason: classifyCommandFailure(false, code),
            code,
            error,
            requestId: "33333333-4444-4555-8666-777777777777",
          });
          return await finishCommandFailure(failure, async () => {});
        }
      };

      // Attempt 1: commit lands on Postgres, reply is lost to stall -> 503 temporarily_unavailable.
      const first = await runCommand(commandId);
      assert.deepEqual(first, { status: 503, body: { error: "temporarily_unavailable" } });
      assert.equal(committedSignals.length, 1, "first attempt committed one row before reply was lost");

      // Attempt 2: client retries with the SAME command_id on rotated fresh pool -> receives stored receipt, still ONE row!
      const retry = await runCommand(commandId);
      assert.deepEqual(retry, { status: 200, body: { status: 200, signal_id: "sig-1" } });
      assert.equal(committedSignals.length, 1, "retry with same command_id must write zero duplicate rows");
      assert.equal(server.getConnCount(), 2, "retry ran on fresh rotated pool");
      assert.equal(EDGE_DATABASE_STALLED_CODE, "EDGE_DATABASE_STALLED");
    } finally {
      await db.end({ timeout: 0 });
    }
  } finally {
    server.closeAll();
    await pki.cleanup();
  }
});

test("Deno createEdgeDatabase proves TLS verification, pool-holder stall recovery, retired-pool cap, and DSN sanitization", async (context) => {
  const denoCheck = spawnSync("deno", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (denoCheck.status !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      assert.fail("CI must run the Deno createEdgeDatabase proof (deno is missing)");
    }
    context.skip("deno is not installed");
    return;
  }

  const pki = await createTestPki();
  const tlsStall = await startFakePgServer({ freezeConns: new Set([1]), tlsPair: pki.matchingPair });
  const tlsCap = await startFakePgServer({ freezeConns: new Set([1, 2]), tlsPair: pki.matchingPair });
  const tlsWrongName = await startFakePgServer({ tlsPair: pki.wrongNamePair });
  const tlsUntrusted = await startFakePgServer({ tlsPair: pki.untrustedCaPair });
  const work = await mkdtemp(join(tmpdir(), "edge-db-deno-helper-"));

  try {
    const scriptPath = join(work, "probe.ts");
    const dbHelperUrl = new URL("../../supabase/functions/_shared/database.ts", import.meta.url).href;
    const sentinel = "EDGE_DB_SECRET_SENTINEL_723";
    await writeFile(scriptPath, `
      import {
        createEdgeDatabase,
        EDGE_DATABASE_STALLED_CODE,
        INVALID_DATABASE_CONFIGURATION_MESSAGE,
      } from ${JSON.stringify(dbHelperUrl)};

      const caB64 = Deno.env.get("TEST_CA_B64")!;
      const sentinel = ${JSON.stringify(sentinel)};

      // 1. Condition 3: malformed URLs carrying a credential sentinel must never leak it.
      const badUrls = [
        "postgres://u:" + sentinel + "@bad host:notaport/db",
        "not-a-url://" + sentinel + ":pass@[::bad",
        "postgres://u:" + sentinel + "@127.0.0.1:5432/db?target_session_attrs=" + sentinel,
        "",
      ];
      for (const bad of badUrls) {
        let caught: unknown;
        try {
          createEdgeDatabase(bad, { max: 1 }, undefined);
        } catch (err) {
          caught = err;
        }
        if (!(caught instanceof Error)) throw new Error("expected Error for malformed URL");
        if (caught.message !== INVALID_DATABASE_CONFIGURATION_MESSAGE) {
          throw new Error("unexpected sanitized message: " + caught.message);
        }
        if ("cause" in caught && caught.cause !== undefined) {
          throw new Error("sanitized error must not carry a cause");
        }
        const combined = [caught.message, caught.stack ?? "", String(caught), String(caught.cause ?? "")].join("\\n");
        if (combined.includes(sentinel)) {
          throw new Error("credential sentinel leaked in thrown error");
        }
      }

      // 2. TLS stall recovery under Deno: silent peer rejected with EDGE_DATABASE_STALLED, fresh pool succeeds.
      {
        const db = createEdgeDatabase(Deno.env.get("TEST_TLS_STALL_URL")!, {
          max: 1,
          connect_timeout: 2,
          fetch_types: false,
          stall_timeout_ms: 300,
          call_ceiling_ms: 2000,
          replace_cooldown_ms: 50,
        }, caB64);
        try {
          let stallCode = "";
          try {
            await db.begin(async (tx) => { await tx\`SELECT 1\`; });
            throw new Error("expected stalled TLS tx to fail");
          } catch (err) {
            stallCode = String((err as { code?: unknown })?.code ?? "");
          }
          if (stallCode !== EDGE_DATABASE_STALLED_CODE) {
            throw new Error("unexpected stall error code: " + stallCode);
          }
          await db.begin(async (tx) => { await tx\`SELECT 2\`; });
        } finally {
          await db.end({ timeout: 0 });
        }
      }

      // 3. Socket cap under Deno: 2 stalls hit cap, 3rd call fails fast, then recovers after peer closes socket.
      {
        const db = createEdgeDatabase(Deno.env.get("TEST_TLS_CAP_URL")!, {
          max: 1,
          connect_timeout: 2,
          fetch_types: false,
          stall_timeout_ms: 200,
          call_ceiling_ms: 2000,
          replace_cooldown_ms: 50,
          max_retained_sockets: 2,
        }, caB64);
        try {
          // Proxy hardening under Deno: unsupported features throw naming the property, then/symbols return undefined.
          for (const prop of ["json", "unsafe", "array", "listen", "reserve", "file", "types"]) {
            let threw = false;
            try {
              void (db as unknown as Record<string, unknown>)[prop];
            } catch (err) {
              threw = err instanceof Error && err.message.includes(prop);
            }
            if (!threw) throw new Error("Deno holder failed to throw for unsupported feature " + prop);
          }
          if ((db as unknown as Record<string, unknown>).then !== undefined) {
            throw new Error("Deno holder must not expose .then");
          }
          for (let i = 0; i < 2; i += 1) {
            let code = "";
            try {
              await db\`SELECT 1\`;
            } catch (err) {
              code = String((err as { code?: unknown })?.code ?? "");
            }
            if (code !== EDGE_DATABASE_STALLED_CODE) throw new Error("expected stall on rot " + i);
            await new Promise((r) => setTimeout(r, 80));
          }
          const tFast = Date.now();
          let capCode = "";
          try {
            await db\`SELECT 1\`;
          } catch (err) {
            capCode = String((err as { code?: unknown })?.code ?? "");
          }
          if (capCode !== EDGE_DATABASE_STALLED_CODE || Date.now() - tFast > 100) {
            throw new Error("cap did not fail fast: code=" + capCode);
          }
          console.log("DENO_CAP_REACHED");
          // Wait for parent harness to destroy one retired half-open socket, then recover on conn 3.
          await new Promise((r) => setTimeout(r, 350));
          await db\`SELECT 3\`;
        } finally {
          await db.end({ timeout: 0 });
        }
      }

      // 4. Stock TLS verification controls under Deno: wrong-name and untrusted-CA refused before Postgres startup.
      for (const envName of ["TEST_TLS_WRONG_URL", "TEST_TLS_UNTRUSTED_URL"]) {
        const db = createEdgeDatabase(Deno.env.get(envName)!, {
          max: 1,
          connect_timeout: 2,
          fetch_types: false,
        }, caB64);
        try {
          let failed = false;
          try {
            await db\`SELECT 1\`;
          } catch {
            failed = true;
          }
          if (!failed) throw new Error(envName + " must reject TLS connection");
        } finally {
          await db.end({ timeout: 0 });
        }
      }

      console.log("DENO_CREATE_EDGE_DB_POOL_HOLDER_OK");
    `, "utf8");

    const run = await new Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>((resolveRun) => {
      const child = spawn("deno", [
        "run", "--no-lock", "--no-prompt",
        "--config", join(repoRoot, "supabase/functions/command/deno.json"),
        "--allow-net", "--allow-env", "--allow-read",
        scriptPath,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TEST_CA_B64: btoa(pki.trustedCa),
          TEST_TLS_STALL_URL: `postgres://u:p@${MATCHING_HOST}:${tlsStall.port}/db`,
          TEST_TLS_CAP_URL: `postgres://u:p@${MATCHING_HOST}:${tlsCap.port}/db`,
          TEST_TLS_WRONG_URL: `postgres://u:p@${MATCHING_HOST}:${tlsWrongName.port}/db`,
          TEST_TLS_UNTRUSTED_URL: `postgres://u:p@${MATCHING_HOST}:${tlsUntrusted.port}/db`,
        },
      });
      let stdout = "";
      let stderr = "";
      let destroyedCapSocket = false;
      let closedRemainingHalfOpen = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!destroyedCapSocket && stdout.includes("DENO_CAP_REACHED")) {
          destroyedCapSocket = true;
          setTimeout(() => tlsCap.destroyOldestSockets(1), 50);
        }
        if (!closedRemainingHalfOpen && stdout.includes("DENO_CREATE_EDGE_DB_POOL_HOLDER_OK")) {
          closedRemainingHalfOpen = true;
          // Close remaining half-open peer sockets so Deno's event loop exits cleanly.
          tlsStall.destroyOldestSockets(10);
          tlsCap.destroyOldestSockets(10);
        }
      });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      child.on("error", (error) => { clearTimeout(timer); resolveRun({ status: null, stdout, stderr, error }); });
      child.on("close", (status) => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
    });

    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /DENO_CREATE_EDGE_DB_POOL_HOLDER_OK/);
    assert.equal(tlsStall.getConnCount(), 2);
    assert.deepEqual(tlsStall.getSniNames(), [MATCHING_HOST, MATCHING_HOST]);
    assert.equal(tlsCap.getConnCount(), 3);
    assert.ok(tlsCap.getClosedTlsCount() >= 1, "Deno cap recovery must observe at least 1 closed socket before opening conn 3");
    assert.deepEqual(tlsWrongName.getSniNames(), [MATCHING_HOST]);
    assert.equal(tlsWrongName.getDecryptedBytes(), 0, "Deno wrong-name cert must be refused before any Postgres byte");
    assert.deepEqual(tlsUntrusted.getSniNames(), [MATCHING_HOST]);
    assert.equal(tlsUntrusted.getDecryptedBytes(), 0, "Deno untrusted CA cert must be refused before any Postgres byte");
  } finally {
    tlsStall.closeAll();
    tlsCap.closeAll();
    tlsWrongName.closeAll();
    tlsUntrusted.closeAll();
    await pki.cleanup();
    await rm(work, { recursive: true, force: true });
  }
});
