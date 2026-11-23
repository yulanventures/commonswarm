/**
 * Edge database recovery witness against this stack's real Postgres image in Docker.
 *
 * Reproduces the 2026-11-23 incident where restarting/recreating Postgres left warm
 * edge isolates unable to write until the edge container was restarted:
 * - Case A: `docker restart` of Postgres while the Deno edge client stays alive.
 * - Down window + backoff-poison check: writes while Postgres is stopped fail within
 *   `connect_timeout` (not 30s) and repeated failures do not poison the first write
 *   after Postgres returns.
 * - Case B: force-removing Postgres (half-open TCP socket with no FIN/RST) and
 *   starting a replacement container on the same user-defined Docker network with
 *   the same network alias (`db.commonswarm.internal`) and data volume, at a new IP:
 *   both an immediate write on the dead socket and an idle-timeout half-close recover
 *   and re-resolve the alias to the new IP without restarting the Deno process.
 *
 * Reached by `npm run test:p1-cli` (glob). Skips with an explicit reason when Docker
 * is absent or when the host Deno binary cannot execute inside the Linux container.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pullDockerImage } from "../support/docker-image-pull.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.147";
const DB_ALIAS = "db.commonswarm.internal";
const CONNECT_TIMEOUT_SECONDS = 5;
const SOCKET_TIMEOUT_MS = 15_000;
const RECOVERY_BOUND_MS = 10_000;
const DOWN_CONNECT_BOUND_MS = (CONNECT_TIMEOUT_SECONDS + 3) * 1_000;
const HALF_OPEN_WRITE_BOUND_MS = SOCKET_TIMEOUT_MS + 3_000;

function run(command: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    encoding: "utf8",
    input: input ?? "",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function findDenoBinary(): string | null {
  const probe = run("which", ["deno"]);
  if (probe.status !== 0) return null;
  const raw = probe.stdout.trim().split("\n")[0]?.trim();
  if (!raw) return null;
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

function inspectContainerIp(container: string): string {
  const inspected = run("docker", [
    "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container,
  ]);
  assert.equal(inspected.status, 0, inspected.stderr);
  const ip = inspected.stdout.trim();
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, `unexpected container IP for ${container}: ${ip}`);
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
  throw new Error(`could not pick a distinct IP near ${ip}`);
}

async function waitForPostgresReady(container: string, password: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const probe = run("docker", [
      "exec", "-e", `PGPASSWORD=${password}`, container,
      "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres",
      "-q", "-t", "-A", "-c", "SELECT 1",
    ]);
    if (probe.status === 0 && probe.stdout.trim() === "1") return;
    await new Promise((r) => setTimeout(r, 300));
  }
  const logs = run("docker", ["logs", "--tail", "40", container]);
  assert.fail(`Postgres container ${container} did not become ready:\n${logs.stdout}\n${logs.stderr}`);
}

interface ClientReply {
  id: number;
  ok: boolean;
  elapsedMs: number;
  value?: unknown;
  code?: string;
  message?: string;
}

class ContainerDenoClient {
  #proc: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, {
    resolve: (reply: ClientReply) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  #stderr = "";

  constructor(proc: ChildProcessWithoutNullStreams) {
    this.#proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    let buffer = "";
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("REPLY:")) {
          const reply = JSON.parse(line.slice("REPLY:".length)) as ClientReply;
          const slot = this.#pending.get(reply.id);
          if (slot) {
            this.#pending.delete(reply.id);
            clearTimeout(slot.timer);
            slot.resolve(reply);
          }
        }
        nl = buffer.indexOf("\n");
      }
    });
    proc.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    proc.on("close", (code, signal) => {
      for (const [id, slot] of this.#pending) {
        this.#pending.delete(id);
        clearTimeout(slot.timer);
        slot.reject(new Error(`deno client exited (${code}/${signal}) while awaiting request ${id}\n${this.#stderr}`));
      }
    });
  }

  request(op: Record<string, unknown>, timeoutMs = 25_000): Promise<ClientReply> {
    const id = this.#nextId++;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectReq(new Error(`deno client request ${id} (${String(op.op)}) timed out after ${timeoutMs}ms\n${this.#stderr}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      this.#proc.stdin.write(`${JSON.stringify({ id, ...op })}\n`);
    });
  }

  async close(): Promise<void> {
    try {
      await this.request({ op: "close" }, 5_000);
    } catch {
      // Fall through to process cleanup.
    }
    this.#proc.stdin.end();
    if (this.#proc.exitCode === null && this.#proc.signalCode === null) {
      this.#proc.kill("SIGKILL");
    }
  }
}

test("edge database client recovers from Postgres restart and recreate with a new IP without process restart", { timeout: 300_000 }, async (context) => {
  if (run("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    context.skip("Docker is absent; this witness requires a throwaway Postgres container");
    return;
  }
  const denoBin = findDenoBinary();
  if (denoBin === null) {
    context.skip("deno is absent; this witness runs the real Deno edge helper");
    return;
  }
  const image = await pullDockerImage(IMAGE);
  if (!image.ready) {
    context.skip(image.reason);
    return;
  }
  // Confirm the host Deno binary can execute inside this stack's Linux Postgres container
  // (succeeds on Linux CI where Deno's glibc binary runs directly on Debian 12; skips on macOS).
  const denoInContainer = run("docker", [
    "run", "--rm",
    "--entrypoint", "/usr/local/bin/deno",
    "-v", `${denoBin}:/usr/local/bin/deno:ro`,
    IMAGE, "--version",
  ]);
  if (denoInContainer.status !== 0) {
    context.skip(`host deno binary cannot run inside Linux container (${denoInContainer.stderr.trim().split("\n")[0] ?? "exec error"})`);
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
  const clientContainer = `edge-db-cli-${id}`;
  const work = await mkdtemp(join(tmpdir(), "edge-db-recovery-"));
  const denoDir = join(work, "deno-dir");
  await mkdir(denoDir, { mode: 0o700 });

  let client: ContainerDenoClient | null = null;
  try {
    // Pre-cache npm:postgres@3.4.9 on the host into denoDir so the container starts offline-safe.
    const cached = spawnSync(denoBin, [
      "cache", "--no-lock",
      "--config", join(repoRoot, "supabase/functions/command/deno.json"),
      join(repoRoot, "supabase/functions/_shared/database.ts"),
    ], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, DENO_DIR: denoDir },
    });
    assert.equal(cached.status, 0, cached.stdout + cached.stderr);

    await writeFile(join(work, "client.ts"), `
import { createEdgeDatabase } from "/work/supabase/functions/_shared/database.ts";

const db = createEdgeDatabase(Deno.env.get("SWARM_DATABASE_URL")!, {
  max: 1,
  idle_timeout: 3,
  connect_timeout: ${CONNECT_TIMEOUT_SECONDS},
}, undefined);

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl = buffer.indexOf("\\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.length > 0) {
      const req = JSON.parse(line) as { id: number; op: string; label?: string };
      const t0 = Date.now();
      try {
        if (req.op === "init") {
          await db.begin(async (tx) => {
            await tx\`CREATE TABLE IF NOT EXISTS public.edge_recovery_witness (
              id serial PRIMARY KEY,
              label text NOT NULL
            )\`;
          });
          console.log("REPLY:" + JSON.stringify({ id: req.id, ok: true, elapsedMs: Date.now() - t0 }));
        } else if (req.op === "write") {
          const rows = await db.begin(async (tx) => {
            return await tx<{ id: number; addr: string }[]>\`
              INSERT INTO public.edge_recovery_witness (label)
              VALUES (\${req.label ?? ""})
              RETURNING id, inet_server_addr()::text AS addr
            \`;
          });
          console.log("REPLY:" + JSON.stringify({
            id: req.id, ok: true, elapsedMs: Date.now() - t0, value: rows[0] ?? null,
          }));
        } else if (req.op === "list") {
          const rows = await db<{ label: string }[]>\`
            SELECT label FROM public.edge_recovery_witness ORDER BY id ASC
          \`;
          console.log("REPLY:" + JSON.stringify({
            id: req.id, ok: true, elapsedMs: Date.now() - t0, value: rows.map((r) => r.label),
          }));
        } else if (req.op === "close") {
          await db.end({ timeout: 1 });
          console.log("REPLY:" + JSON.stringify({ id: req.id, ok: true, elapsedMs: Date.now() - t0 }));
          Deno.exit(0);
        }
      } catch (err) {
        const record = err && typeof err === "object" ? err as { code?: unknown; message?: unknown } : {};
        console.log("REPLY:" + JSON.stringify({
          id: req.id,
          ok: false,
          elapsedMs: Date.now() - t0,
          code: typeof record.code === "string" ? record.code : "",
          message: typeof record.message === "string" ? record.message : String(err),
        }));
      }
    }
    nl = buffer.indexOf("\\n");
  }
}
`, "utf8");

    assert.equal(run("docker", ["network", "create", network]).status, 0);
    assert.equal(run("docker", ["volume", "create", volume]).status, 0);

    const startPg = (name: string, ip?: string) => {
      const args = [
        "run", "-d", "--name", name,
        "--network", network,
        ...(ip ? ["--ip", ip] : []),
        "--network-alias", DB_ALIAS,
        "-v", `${volume}:/var/lib/postgresql/data`,
        "-e", `POSTGRES_PASSWORD=${password}`,
        "-e", `JWT_SECRET=${jwtSecret}`,
        "-e", "JWT_EXP=3600",
        IMAGE,
      ];
      const started = run("docker", args);
      assert.equal(started.status, 0, started.stderr);
    };

    startPg(pg1);
    await waitForPostgresReady(pg1, password);
    const ip1 = inspectContainerIp(pg1);

    const netGateway = run("docker", [
      "network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", network,
    ]).stdout.trim();
    const usedIps = new Set([netGateway, ip1]);

    // Start the single long-lived Deno edge client container on the same Docker network.
    const dbUrl = `postgres://supabase_admin:${encodeURIComponent(password)}@${DB_ALIAS}:5432/postgres?sslmode=disable`;
    const child = spawn("docker", [
      "run", "--rm", "-i",
      "--name", clientContainer,
      "--network", network,
      "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "-e", `SWARM_DATABASE_URL=${dbUrl}`,
      "-e", "DENO_DIR=/run/witness/deno-dir",
      "-v", `${denoBin}:/usr/local/bin/deno:ro`,
      "-v", `${repoRoot}:/work:ro`,
      "-v", `${work}:/run/witness`,
      "--entrypoint", "/usr/local/bin/deno",
      IMAGE,
      "run", "--no-lock", "--no-prompt", "--cached-only",
      "--config", "/work/supabase/functions/command/deno.json",
      "--allow-net", "--allow-env", "--allow-read",
      "/run/witness/client.ts",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    client = new ContainerDenoClient(child);
    usedIps.add(inspectContainerIp(clientContainer));

    // Baseline: schema + first write succeed through the shared helper.
    const initReply = await client.request({ op: "init" });
    assert.equal(initReply.ok, true, initReply.message);
    const w1 = await client.request({ op: "write", label: "before-restart" });
    assert.equal(w1.ok, true, w1.message);

    // Case A: docker restart of Postgres; same Deno process recovers within RECOVERY_BOUND_MS.
    assert.equal(run("docker", ["restart", pg1]).status, 0);
    await waitForPostgresReady(pg1, password);
    const w2 = await client.request({ op: "write", label: "after-restart" });
    assert.equal(w2.ok, true, `case A write failed: ${w2.code} ${w2.message}`);
    assert.ok(w2.elapsedMs < RECOVERY_BOUND_MS, `case A took ${w2.elapsedMs}ms (bound ${RECOVERY_BOUND_MS}ms)`);

    // Down-window + backoff-poison check: while Postgres is stopped, writes fail within
    // connect_timeout (not 30s), and repeated failures do not poison the first write after return.
    assert.equal(run("docker", ["stop", pg1]).status, 0);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const downWrite = await client.request({ op: "write", label: `while-down-${attempt}` }, DOWN_CONNECT_BOUND_MS + 5_000);
      assert.equal(downWrite.ok, false, "write must fail while Postgres is stopped");
      assert.ok(
        downWrite.elapsedMs < DOWN_CONNECT_BOUND_MS,
        `down write #${attempt} took ${downWrite.elapsedMs}ms (bound ${DOWN_CONNECT_BOUND_MS}ms)`,
      );
    }
    assert.equal(run("docker", ["start", pg1]).status, 0);
    await waitForPostgresReady(pg1, password);
    const w3 = await client.request({ op: "write", label: "after-down-window" });
    assert.equal(w3.ok, true, `first write after restart failed: ${w3.code} ${w3.message}`);
    assert.ok(
      w3.elapsedMs < RECOVERY_BOUND_MS,
      `first write after down window took ${w3.elapsedMs}ms (backoff poisoned recovery; bound ${RECOVERY_BOUND_MS}ms)`,
    );

    // Case B1: force-remove pg1 while the pool holds an open connection to ip1 (half-open TCP,
    // no FIN/RST). An immediate write while down must fail within the bounded socket timeout
    // (well under 30s), and the first write after pg2 comes up at a NEW IP must succeed.
    const w4 = await client.request({ op: "write", label: "before-recreate" });
    assert.equal(w4.ok, true, w4.message);
    assert.equal(run("docker", ["rm", "-f", pg1]).status, 0);

    const halfOpenFail = await client.request({ op: "write", label: "while-recreate-down" }, HALF_OPEN_WRITE_BOUND_MS + 5_000);
    assert.equal(halfOpenFail.ok, false, "write on half-open dead socket must fail");
    assert.ok(
      halfOpenFail.elapsedMs < HALF_OPEN_WRITE_BOUND_MS,
      `half-open dead-socket write took ${halfOpenFail.elapsedMs}ms (bound ${HALF_OPEN_WRITE_BOUND_MS}ms)`,
    );

    const ip2 = nextDifferentIp(ip1, usedIps);
    usedIps.add(ip2);
    startPg(pg2, ip2);
    await waitForPostgresReady(pg2, password);
    const actualIp2 = inspectContainerIp(pg2);
    assert.equal(actualIp2, ip2);
    assert.notEqual(actualIp2, ip1, "recreated Postgres must have a new IP address");

    const w5 = await client.request({ op: "write", label: "after-recreate-new-ip" });
    assert.equal(w5.ok, true, `case B1 write after recreate failed: ${w5.code} ${w5.message}`);
    assert.ok(w5.elapsedMs < RECOVERY_BOUND_MS, `case B1 took ${w5.elapsedMs}ms (bound ${RECOVERY_BOUND_MS}ms)`);
    assert.equal((w5.value as { addr?: string } | null)?.addr, ip2, "client must connect to the new container IP");

    // Case B2: force-remove pg2 while the connection to ip2 is idle, wait past idle_timeout (3s)
    // + close_grace_ms (1s) so postgres.js calls terminate() -> socket.end() on the half-open
    // socket, then start pg3 at a third IP. Today's code wedges the slot in queues.ended forever.
    assert.equal(run("docker", ["rm", "-f", pg2]).status, 0);
    const ip3 = nextDifferentIp(ip2, usedIps);
    usedIps.add(ip3);
    startPg(pg3, ip3);
    await waitForPostgresReady(pg3, password);
    const actualIp3 = inspectContainerIp(pg3);
    assert.equal(actualIp3, ip3);
    assert.notEqual(actualIp3, ip2);
    // Ensure idle_timeout (3s) + close_grace_ms (1s) has elapsed on the dead ip2 socket.
    await new Promise((r) => setTimeout(r, 4_500));

    const w6 = await client.request({ op: "write", label: "after-idle-recreate" });
    assert.equal(w6.ok, true, `case B2 write after idle recreate failed: ${w6.code} ${w6.message}`);
    assert.ok(w6.elapsedMs < RECOVERY_BOUND_MS, `case B2 took ${w6.elapsedMs}ms (bound ${RECOVERY_BOUND_MS}ms)`);
    assert.equal((w6.value as { addr?: string } | null)?.addr, ip3, "client must resolve alias to third IP");

    // Verify data persisted across all restarts/recreates and no failed write duplicated.
    const listed = await client.request({ op: "list" });
    assert.equal(listed.ok, true, listed.message);
    assert.deepEqual(listed.value, [
      "before-restart",
      "after-restart",
      "after-down-window",
      "before-recreate",
      "after-recreate-new-ip",
      "after-idle-recreate",
    ]);
  } finally {
    if (client) await client.close();
    run("docker", ["rm", "-f", clientContainer, pg1, pg2, pg3]);
    run("docker", ["volume", "rm", "-f", volume]);
    run("docker", ["network", "rm", network]);
    await rm(work, { recursive: true, force: true });
  }
});
