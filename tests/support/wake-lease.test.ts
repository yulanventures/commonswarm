import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { readAgentWakeLease, sendWakeLeaseCommand, startWakeLeaseRenewal, WakeLeaseLostError, WakeLeaseTransientError } from "../../src/cloud/wake-lease.js";
import { EXIT_NOTIFY_LEASE_LOST, NOTIFY_LEASE_EXITS, NOTIFY_LEASE_RULES, NOTIFY_NO_RESTART_CLAUSE, WAKE_LEASE_RENEW_MS, WAKE_LEASE_STALE_LABEL, WAKE_LEASE_STALE_MS, wakeLeaseExitSentence, wakeLeaseRule } from "../../src/cloud/wake-lease-constants.js";

const target = cloudTarget("http://127.0.0.1:54321", "public-test-key");
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const watcher = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("wake and name advisory locks use separate classes and independently keyed subjects", { timeout: 1000 }, () => {
  const migration = readFileSync(new URL("../../supabase/migrations/20260926000001_agent_wake_leases.sql", import.meta.url), "utf8");
  const edge = readFileSync(new URL("../../supabase/functions/command/index.ts", import.meta.url), "utf8");
  const wake = /pg_advisory_xact_lock\((\d+),\s*hashtext\(([^\n]+)\)\)/.exec(migration);
  const name = /pg_advisory_xact_lock\(\s*(\d+),\s*hashtext\(([^\n]+)\)/.exec(edge);
  assert.ok(wake && name);
  assert.notEqual(wake[1], name[1]);
  assert.match(wake[2], /p_workspace.*p_principal/);
  assert.match(name[2], /route\.workspaceId.*command\.name/);
  assert.notEqual(wake[2], name[2]);
});

test("lease command names the holder and exits with one non-restartable code", { timeout: 1000 }, async () => {
  let sent: Record<string, unknown> | null = null;
  const fetcher = (async (_url: URL | RequestInfo, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ error: "notify_held_elsewhere", surface: "watcher",
      host_label: "other-host", lease_age_ms: 10 }), { status: 409 });
  }) as typeof fetch;
  await assert.rejects(sendWakeLeaseCommand({ target, workspaceId, token: "synthetic",
    command: { kind: "claim_wake_lease", watcher_id: watcher },
    restartCommand: "cswarm inbox --notify", fetcher }), (error: unknown) => {
      assert.ok(error instanceof WakeLeaseLostError);
      assert.equal(error.exitCode, EXIT_NOTIFY_LEASE_LOST);
      assert.equal(error.code, "notify_held_elsewhere");
      assert.match(error.message, /other-host.*--take-over/);
      assert.match(error.message, /must not be restarted/);
      return true;
    });
  assert.ok(sent);
  const wire = sent as unknown as Record<string, unknown>;
  assert.equal(wire.workspace_id, workspaceId);
  assert.equal((wire.stream as Record<string, unknown>).kind, "workspace");
  assert.equal(NOTIFY_LEASE_EXITS.wake_lease_superseded, EXIT_NOTIFY_LEASE_LOST);
  assert.match(wakeLeaseExitSentence("wake_lease_superseded", "watcher", "new-host", "cswarm inbox --notify"),
    /must not be restarted.*new-host/);
});

test("renew transport errors retry with backoff and only typed supersession stops timer", { timeout: 1000 }, async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let calls = 0;
  let lost = 0;
  const stop = startWakeLeaseRenewal({
    intervalMs: WAKE_LEASE_RENEW_MS,
    renew: async () => {
      calls += 1;
      if (calls < 3) throw new WakeLeaseTransientError(null);
      throw new WakeLeaseLostError("wake_lease_superseded", "watcher", "new-host", "cswarm inbox --notify");
    },
    lost: () => { lost += 1; },
    setTimer: ((callback: () => void, delay: number) => {
      scheduled.push({ callback, delay });
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: (() => undefined) as typeof clearTimeout,
  });
  assert.equal(scheduled[0]?.delay, WAKE_LEASE_RENEW_MS);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = scheduled.shift();
    assert.ok(next);
    await next.callback();
    await Promise.resolve();
    if (attempt < 2) {
      assert.equal(lost, 0);
      assert.equal(scheduled[0]?.delay, 1000 * 2 ** (attempt + 1));
    }
  }
  assert.equal(calls, 3);
  assert.equal(lost, 1);
  assert.equal(scheduled.length, 0);
  assert.equal(WAKE_LEASE_STALE_MS, 3 * WAKE_LEASE_RENEW_MS);
  assert.equal(WAKE_LEASE_STALE_LABEL, `${WAKE_LEASE_STALE_MS / 60_000} minutes`);
  stop();
});

test("each session refusal has its own accurate sentence and phase-specific exit", { timeout: 2000 }, async () => {
  const cases = [
    ["session_conflict", 409, /another live session owns this seat.*moved elsewhere/i],
    ["session_expired", 401, /host session ended.*resume output/i],
    ["session_retired", 403, /host session was retired.*new live session/i],
    ["session_proof_invalid", 401, /proof became invalid.*resume output/i],
    ["session_proof_missing", 401, /proof became missing.*resume output/i],
  ] as const;
  for (const [code, status, sentence] of cases) {
    const fetcher = (async () => new Response(JSON.stringify({ error: code }), { status })) as typeof fetch;
    await assert.rejects(sendWakeLeaseCommand({ target, workspaceId, token: "synthetic",
      command: { kind: "renew_wake_lease", watcher_id: watcher, generation: 1 },
      restartCommand: "cswarm inbox --notify", fetcher }), (error: unknown) => {
      assert.ok(error instanceof WakeLeaseLostError);
      assert.equal(error.exitCode, 76);
      assert.match(error.message, sentence);
      assert.match(error.message, /must not be restarted by a supervisor/);
      for (const [other, , otherSentence] of cases) if (other !== code) {
        assert.doesNotMatch(error.message, otherSentence, `${code} borrowed ${other}'s sentence`);
      }
      return true;
    });
  }
  for (const code of ["session_proof_missing", "session_proof_invalid"] as const) {
    const fetcher = (async () => new Response(JSON.stringify({ error: code }), { status: 401 })) as typeof fetch;
    await assert.rejects(sendWakeLeaseCommand({ target, workspaceId, token: "synthetic",
      command: { kind: "claim_wake_lease", watcher_id: watcher },
      restartCommand: "cswarm inbox --notify --url http://127.0.0.1:54321", fetcher }), (error: unknown) => {
      assert.ok(error instanceof WakeLeaseLostError);
      assert.equal(error.exitCode, 76);
      assert.match(error.message, /managed seat's watcher needs.*profile's host session/i);
      assert.match(error.message, /resume output.*verified live context/i);
      assert.doesNotMatch(error.message, /cswarm session start/i);
      assert.match(error.message, /must not be restarted by a supervisor/);
      assert.doesNotMatch(error.message, /<path>|moved elsewhere/i);
      return true;
    });
  }
  assert.match(wakeLeaseExitSentence("session_proof_invalid", "watcher", null,
    "cswarm inbox --notify --session-context /tmp/expired", "start", "/tmp/expired"),
    /operator's --session-context path \/tmp\/expired was refused/);
  const knownPath = "/tmp/live-session.json";
  const invalid = (async () => new Response(JSON.stringify({ error: "session_proof_invalid" }), { status: 401 })) as typeof fetch;
  await assert.rejects(sendWakeLeaseCommand({ target, workspaceId, token: "synthetic",
    command: { kind: "claim_wake_lease", watcher_id: watcher },
    restartCommand: "cswarm inbox --notify", sessionContextPath: knownPath, fetcher: invalid }), (error: unknown) => {
      assert.ok(error instanceof WakeLeaseLostError);
      assert.equal(error.exitCode, 76);
      assert.match(error.message, /operator's --session-context path \/tmp\/live-session\.json was refused/);
      assert.doesNotMatch(error.message, /<path>|<valid-path>/);
      return true;
    });
});

test("every exit-76 lease sentence carries the one supervisor stop clause", { timeout: 1000 }, () => {
  for (const code of Object.keys(NOTIFY_LEASE_RULES) as Array<keyof typeof NOTIFY_LEASE_RULES>) {
    for (const phase of ["start", "renew"] as const) {
      if (wakeLeaseRule(code, phase).exit !== 76) continue;
      const line = wakeLeaseExitSentence(code, "watcher", "other-host", "cswarm inbox --notify", phase);
      assert.equal(line.split(NOTIFY_NO_RESTART_CLAUSE).length - 1, 1, `${code}/${phase}: ${line}`);
      assert.match(line.split("\n")[0]!, /; exit 76\.$/);
      assert.doesNotMatch(line, /\.; exit /);
    }
  }
});

test("stdin retry is stated once and supersession shares one remedy", { timeout: 1000 }, () => {
  const stdin = wakeLeaseExitSentence("session_expired", "watcher", null, null, "start",
    undefined, undefined, undefined, "retry from the live host session");
  assert.equal(stdin.split("agent token on stdin").length - 1, 1);
  const file = wakeLeaseExitSentence("wake_lease_superseded", "watcher", "holder", "cswarm inbox --notify");
  const pipe = wakeLeaseExitSentence("wake_lease_superseded", "watcher", "holder", null);
  assert.match(file, /stop this watcher and use that surface there; start it again with the same credential source/);
  assert.match(pipe, /stop this watcher and use that surface there; start it again with the same credential source/);
  assert.equal(pipe.split("start it again").length - 1, 1);
});

test("server host label is bounded and has no terminal controls", { timeout: 1000 }, () => {
  const line = wakeLeaseExitSentence("notify_held_elsewhere", "watcher", `\u001b[31m\n${"x".repeat(500)}\u202e`, null);
  assert.doesNotMatch(line, /\u001b|\u202e|\n/);
  assert.ok(line.length < 500);
  assert.doesNotMatch(line, /\.; exit /);
});

test("a server-supplied host label is sanitized in the lease error", { timeout: 1000 }, async () => {
  const fetcher = (async () => new Response(JSON.stringify({ error: "notify_held_elsewhere", surface: "watcher",
    host_label: `\u001b[31m\n${"x".repeat(500)}\u202e` }), { status: 409 })) as typeof fetch;
  await assert.rejects(sendWakeLeaseCommand({ target, workspaceId, token: "synthetic",
    command: { kind: "claim_wake_lease", watcher_id: watcher },
    restartCommand: null, fetcher }), (error: unknown) => {
      assert.ok(error instanceof WakeLeaseLostError);
      assert.doesNotMatch(error.message, /\u001b|\u202e|\n/);
      assert.ok(error.message.length < 500);
      return true;
    });
});

test("transport, 429 and 5xx retry while ordinary refusal stops", { timeout: 2000 }, async () => {
  for (const status of [429, 500, 503]) {
    const fetcher = (async () => new Response("unavailable", { status })) as typeof fetch;
    await assert.rejects(sendWakeLeaseCommand({ target, workspaceId, token: "synthetic",
      command: { kind: "renew_wake_lease", watcher_id: watcher, generation: 1 },
      restartCommand: "cswarm inbox --notify", fetcher }), WakeLeaseTransientError);
  }
  const transport = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(sendWakeLeaseCommand({ target, workspaceId, token: "synthetic",
    command: { kind: "renew_wake_lease", watcher_id: watcher, generation: 1 },
    restartCommand: "cswarm inbox --notify", fetcher: transport }), WakeLeaseTransientError);
  const synchronousTransport = (() => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(sendWakeLeaseCommand({ target, workspaceId, token: "synthetic",
    command: { kind: "renew_wake_lease", watcher_id: watcher, generation: 1 },
    restartCommand: "cswarm inbox --notify", fetcher: synchronousTransport }), WakeLeaseTransientError);
  const refused = (async () => new Response(JSON.stringify({ error: "notify_unavailable" }), { status: 403 })) as typeof fetch;
  await assert.rejects(sendWakeLeaseCommand({ target, workspaceId, token: "synthetic",
    command: { kind: "renew_wake_lease", watcher_id: watcher, generation: 1 },
    restartCommand: "cswarm inbox --notify", fetcher: refused }), /HTTP 403/);
});

test("agent lease read returns generation and holder identity", { timeout: 1000 }, async () => {
  const fetcher = (async () => new Response(JSON.stringify({ lease: {
    watcher_id: watcher, host_label: "host-a", generation: "7", renewed_age_ms: "1000",
  } }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await readAgentWakeLease(target, workspaceId, "synthetic", fetcher), {
    watcher_id: watcher, host_label: "host-a", generation: 7, renewed_age_ms: 1000,
  });
});
