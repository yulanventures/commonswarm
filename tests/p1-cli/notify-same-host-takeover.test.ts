import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

/* Two real `inbox --notify` processes for one seat against a loopback edge that keeps the
 * wake lease the way swarm.claim_agent_wake_lease does: a fresh holder on another host_id
 * refuses without take_over, a same-host claim supersedes with generation + 1, and a renewal
 * of a superseded generation answers wake_lease_superseded. */

const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const seats = {
  first: { principal: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", token: `swm_agt_${"A".repeat(43)}` },
  second: { principal: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", token: `swm_agt_${"C".repeat(43)}` },
} as const;
type SeatName = keyof typeof seats;
const STALE_MS = 180_000;
const RENEW_MS = 150;

interface Lease { watcher: string; hostId: string; hostLabel: string; generation: number; renewedAt: number }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cswarm-notify-takeover-"));
  const credentials: Record<SeatName, string> = { first: join(root, "first.json"), second: join(root, "second.json") };
  for (const name of Object.keys(seats) as SeatName[]) {
    await writeFile(credentials[name], JSON.stringify({ message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.",
      status: "accepted", principal_id: seats[name].principal, token_id: randomUUID(), run_id: randomUUID(),
      agent_token: seats[name].token, expires_at: "2030-01-01T00:00:00Z" }), { mode: 0o600 });
  }
  const leases = new Map<string, Lease>();
  const seen: Array<{ principal: string; command: Record<string, unknown>; status: number }> = [];
  const principalOf = (authorization: string | undefined) =>
    Object.values(seats).find(seat => authorization === `Bearer ${seat.token}`)?.principal ?? null;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => raw += chunk);
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const principal = principalOf(request.headers.authorization);
      const reply = (status: number, value: unknown) =>
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (principal === null) { reply(401, { error: "unauthenticated" }); return; }
      if (request.url === "/functions/v1/command") {
        const command = body.command as Record<string, unknown>;
        const lease = leases.get(principal) ?? null;
        const answer = (status: number, value: Record<string, unknown>) => {
          seen.push({ principal, command, status });
          reply(status, status === 200 ? { ok: true, status: "accepted", event_ids: [], ...value } : value);
        };
        if (command.kind === "claim_wake_lease") {
          if (lease !== null && lease.watcher !== command.watcher_id && Date.now() - lease.renewedAt < STALE_MS &&
              command.take_over !== true && lease.hostId !== command.host_id) {
            answer(409, { error: "notify_held_elsewhere", surface: "watcher", host_label: lease.hostLabel,
              lease_age_ms: Date.now() - lease.renewedAt });
            return;
          }
          const stolen = lease !== null && lease.watcher !== command.watcher_id;
          const generation = lease === null ? 1 : stolen ? lease.generation + 1 : lease.generation;
          leases.set(principal, { watcher: String(command.watcher_id), hostId: String(command.host_id),
            hostLabel: String(command.host_label), generation, renewedAt: Date.now() });
          answer(200, { generation, stolen });
          return;
        }
        if (command.kind === "renew_wake_lease") {
          if (lease !== null && lease.watcher === command.watcher_id && lease.generation === command.generation) {
            lease.renewedAt = Date.now();
            answer(200, { renewed: true });
          } else {
            answer(409, { error: "wake_lease_superseded", surface: "watcher", host_label: lease?.hostLabel ?? null });
          }
          return;
        }
        if (command.kind === "release_wake_lease") {
          const released = lease !== null && lease.watcher === command.watcher_id && lease.generation === command.generation;
          if (released) leases.delete(principal);
          answer(200, { released });
          return;
        }
        answer(200, {});
        return;
      }
      if (body.resource === "agent_wake_lease") {
        const lease = leases.get(principal);
        reply(200, { lease: lease === undefined ? null : { watcher_id: lease.watcher, host_label: lease.hostLabel,
          generation: lease.generation, renewed_age_ms: Date.now() - lease.renewedAt } });
        return;
      }
      if (body.resource === "members") {
        reply(200, { members: [], agents: [{ principal_id: principal, owner_user_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          name: "Fixture seat" }], identity: { credential_valid: true, owner_user_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          principal_id: principal, workspace_id: workspace } });
        return;
      }
      if (body.resource === "files") { reply(200, { files: [] }); return; }
      reply(200, { signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 } });
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const children: ChildProcess[] = [];

  interface Watcher {
    child: ChildProcess;
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
    stderr(): string;
  }
  const commandLine = (seat: SeatName) => [process.execPath, "--import", "tsx", resolve("src/cli.ts"),
    "inbox", "--notify", "--agent-token-file", credentials[seat], "--url", url, "--anon-key", "public-test-key",
    "--workspace-id", workspace] as const;
  const environment = (stateHome: string, takeoverMs: number) => ({ ...process.env, HOME: root,
    XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: stateHome, NODE_ENV: "test",
    CSWARM_TEST_WAKE_RENEW_MS: String(RENEW_MS), CSWARM_TEST_NOTIFY_TAKEOVER_MS: String(takeoverMs) });
  const start = (options: { seat?: SeatName; stateHome?: string; takeoverMs?: number } = {}): Watcher => {
    const [command, ...rest] = commandLine(options.seat ?? "first");
    const child = spawn(command, rest, { env: environment(options.stateHome ?? join(root, "state"), options.takeoverMs ?? 8_000),
      stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => stderr += chunk.toString());
    child.stdout?.resume();
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((done, reject) => {
      child.once("exit", (code, signal) => done({ code, signal, stderr }));
      child.once("error", reject);
    });
    return { child, exit, stderr: () => stderr };
  };
  const leaseOf = (seat: SeatName = "first") => leases.get(seats[seat].principal) ?? null;
  const lockPath = (seat: SeatName = "first", stateHome = join(root, "state")) =>
    join(stateHome, "cswarm", "arrival-cursors", `${workspace}-${seats[seat].principal}.lock`);
  const lockOwner = async (seat: SeatName = "first") => {
    try {
      return JSON.parse(await readFile(lockPath(seat), "utf8")) as { pid: number; watcher_id: string };
    } catch { return null; }
  };
  /** Wait until this watcher holds the seat: the lease is its own and has been renewed since. */
  const holding = async (watcher: Watcher, seat: SeatName = "first", within = 10_000) => {
    const deadline = Date.now() + within;
    for (;;) {
      const owner = await lockOwner(seat);
      const lease = leaseOf(seat);
      if (owner !== null && owner.pid === watcher.child.pid && lease?.watcher === owner.watcher_id &&
          seen.some(row => row.command.kind === "renew_wake_lease" && row.status === 200 &&
            row.command.watcher_id === owner.watcher_id)) return owner.watcher_id;
      if (watcher.child.exitCode !== null || watcher.child.signalCode !== null) {
        throw new Error(`watcher exited before holding the seat: ${watcher.stderr()}`);
      }
      if (Date.now() > deadline) throw new Error(`watcher did not hold the seat: ${watcher.stderr()}`);
      await new Promise(done => setTimeout(done, 25));
    }
  };
  const cleanup = async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  };
  /** A tiny launchd KeepAlive { SuccessfulExit = false }: restart, same command line, only on a non-zero stop. */
  const supervise = (limit = 3) => {
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> = [];
    let current = start();
    let stopped = false;
    const loop = (async () => {
      for (;;) {
        const result = await current.exit;
        exits.push(result);
        if (stopped || result.code === 0 || exits.length > limit) return;
        current = start();
      }
    })();
    return { exits, loop, current: () => current,
      stop: () => { stopped = true; current.child.kill("SIGKILL"); } };
  };
  return { start, leaseOf, lockPath, lockOwner, holding, cleanup, supervise, seen, root, credentials,
    stealFromAnotherHost(seat: SeatName = "first") {
      const lease = leaseOf(seat);
      leases.set(seats[seat].principal, { watcher: randomUUID(), hostId: randomUUID(), hostLabel: "other-host",
        generation: (lease?.generation ?? 0) + 1, renewedAt: Date.now() });
    } };
}

/** The replaced watcher must be the one that stops: on the old code the new start is the one that exits. */
async function replacedExit(a: { exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> },
  b: { exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> }) {
  const first = await Promise.race([a.exit.then(result => ({ who: "replaced", result })),
    b.exit.then(result => ({ who: "new start", result }))]);
  assert.equal(first.who, "replaced", `the new start exited first: ${first.result.stderr}`);
  return first.result;
}

const replaced = /\[notify_replaced\] inbox --notify was replaced by a newer watcher on this host \(pid \d+\)/;

test("a second start for the same seat replaces the first, which stops by itself with exit 0", { timeout: 30_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  {
    const a = f.start();
    const aWatcher = await f.holding(a);
    const b = f.start();
    const ended = await replacedExit(a, b);
    // A stopped from the lease path: no signal reached it, it said why, and it exited 0.
    assert.equal(ended.signal, null, ended.stderr);
    assert.equal(ended.code, 0, ended.stderr);
    assert.match(ended.stderr, replaced);
    assert.match(ended.stderr, new RegExp(`pid ${b.child.pid}\\)`));
    assert.doesNotMatch(ended.stderr, /SIGTERM|SIGINT|already running/);
    const bWatcher = await f.holding(b);
    assert.notEqual(bWatcher, aWatcher);
    assert.match(b.stderr(), new RegExp(`replacing inbox --notify pid ${a.child.pid}`));
    assert.doesNotMatch(b.stderr(), /already running/);
    assert.equal(f.leaseOf()?.watcher, bWatcher);
    assert.equal(f.leaseOf()?.generation, 2);
    assert.equal(b.child.exitCode, null);
  }
});

test("a different seat's watcher is untouched by a replacement", { timeout: 30_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  {
    const other = f.start({ seat: "second" });
    const otherWatcher = await f.holding(other, "second");
    const a = f.start();
    await f.holding(a);
    const b = f.start();
    assert.equal((await replacedExit(a, b)).code, 0);
    await f.holding(b);
    await new Promise(done => setTimeout(done, 4 * RENEW_MS));
    assert.equal(other.child.exitCode, null, other.stderr());
    assert.equal(f.leaseOf("second")?.watcher, otherWatcher);
    assert.equal(f.leaseOf("second")?.generation, 1);
    assert.equal((await f.lockOwner("second"))?.pid, other.child.pid);
    assert.doesNotMatch(other.stderr(), /replac|superseded/);
  }
});

test("a holder on another host is still refused without --take-over", { timeout: 30_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  {
    const a = f.start();
    const aWatcher = await f.holding(a);
    // A separate state directory has its own host-id file: to the service it is another host.
    const remote = f.start({ stateHome: join(f.root, "other-host-state") });
    const refused = await remote.exit;
    assert.equal(refused.code, 76, refused.stderr);
    assert.match(refused.stderr, /notify_held_elsewhere/);
    assert.doesNotMatch(refused.stderr, /replacing/);
    await new Promise(done => setTimeout(done, 4 * RENEW_MS));
    assert.equal(a.child.exitCode, null, a.stderr());
    assert.equal(f.leaseOf()?.watcher, aWatcher);
    assert.equal(f.leaseOf()?.generation, 1);
  }
});

test("two simultaneous starts leave exactly one watcher", { timeout: 45_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  {
    const a = f.start();
    await f.holding(a);
    const starts = [f.start(), f.start()];
    const all = [a, ...starts];
    const deadline = Date.now() + 25_000;
    let alive = all;
    for (;;) {
      alive = all.filter(watcher => watcher.child.exitCode === null && watcher.child.signalCode === null);
      const owner = await f.lockOwner();
      if (alive.length === 1 && owner !== null && owner.pid === alive[0]!.child.pid &&
          f.leaseOf()?.watcher === owner.watcher_id) break;
      assert.ok(Date.now() < deadline, `expected one watcher, ${alive.length} alive`);
      await new Promise(done => setTimeout(done, 50));
    }
    const survivor = alive[0]!;
    await f.holding(survivor);
    for (const watcher of all.filter(each => each !== survivor)) {
      const ended = await watcher.exit;
      assert.equal(ended.signal, null, ended.stderr);
      assert.equal(ended.code, 0, ended.stderr);
      assert.match(ended.stderr, replaced);
    }
    await new Promise(done => setTimeout(done, 4 * RENEW_MS));
    assert.equal(survivor.child.exitCode, null, survivor.stderr());
  }
});

test("a replaced holder that never lets go ends the new start with its pid and a released lease", { timeout: 30_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  // A live, idle process that holds the seat lock and never renews: a hung or orphaned watcher.
  const hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.ok(hung.pid);
    await mkdir(join(f.root, "state", "cswarm", "arrival-cursors"), { recursive: true, mode: 0o700 });
    await writeFile(f.lockPath(), `${JSON.stringify({ version: 1, pid: hung.pid, owner_id: randomUUID(),
      watcher_id: randomUUID() })}\n`, { mode: 0o600 });
    const b = f.start({ takeoverMs: 1_500 });
    const ended = await b.exit;
    assert.equal(ended.code, 1, ended.stderr);
    assert.match(ended.stderr, new RegExp(`\\[notify_replace_timeout\\].*pid ${hung.pid} did not stop.*stop only that pid, then start it again`));
    assert.doesNotMatch(ended.stderr, /pkill|killall/);
    // The claim this start made is given back, so no phantom holder outlives it.
    assert.equal(f.leaseOf(), null);
    assert.ok(f.seen.some(row => row.command.kind === "release_wake_lease" && row.status === 200));
    assert.equal(hung.exitCode, null);
    assert.equal(hung.signalCode, null);
    assert.equal((await f.lockOwner())?.pid, hung.pid);
  } finally {
    hung.kill("SIGKILL");
  }
});

test("under a restart-on-failure supervisor, a replaced watcher stays down and a lost one comes back", { timeout: 45_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  {
    const supervised = f.supervise();
    await f.holding(supervised.current());
    const b = f.start();
    await replacedExit({ exit: supervised.loop.then(() => supervised.exits[0]!) }, b);
    assert.equal(supervised.exits.length, 1, "the supervisor did not restart a watcher that was replaced");
    assert.equal(supervised.exits[0]!.code, 0, supervised.exits[0]!.stderr);
    assert.equal(supervised.exits[0]!.signal, null);
    assert.match(supervised.exits[0]!.stderr, replaced);
    const bWatcher = await f.holding(b);
    const generation = f.leaseOf()?.generation;
    // Longer than several renewal periods: B is not superseded again and nothing restarted.
    await new Promise(done => setTimeout(done, 10 * RENEW_MS));
    assert.equal(b.child.exitCode, null, b.stderr());
    assert.equal(f.leaseOf()?.watcher, bWatcher);
    assert.equal(f.leaseOf()?.generation, generation);
    assert.equal(supervised.exits.length, 1);
    b.child.kill("SIGKILL");
    await b.exit;

    // Control: a takeover from another host is not a replacement. It exits 76 and is restarted.
    const control = f.supervise(1);
    await f.holding(control.current());
    f.stealFromAnotherHost();
    const deadline = Date.now() + 15_000;
    while (control.exits.length < 1 && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
    assert.equal(control.exits[0]?.code, 76, control.exits[0]?.stderr);
    assert.match(control.exits[0]!.stderr, /wake_lease_superseded/);
    assert.doesNotMatch(control.exits[0]!.stderr, /notify_replaced/);
    while (control.exits.length < 2 && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
    assert.equal(control.exits.length, 2, "the supervisor restarted the watcher after its non-zero stop");
    control.stop();
    await control.loop;
  }
});
