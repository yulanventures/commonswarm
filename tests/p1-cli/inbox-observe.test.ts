/**
 * Real-CLI proof that an agent's `cswarm inbox` observes what it printed: after the output is
 * written, one batched unclaimed observation names the asks and notes that reach the agent, and
 * a failed observation changes neither the output nor the exit status.
 *
 * ★ Reached by `npm run test:p1-cli` through tests/p1-cli/**\/*.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_AGENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DIRECTED = "11111111-1111-4111-8111-111111111111";
const MENTIONED = "22222222-2222-4222-8222-222222222222";
const ELSEWHERE = "33333333-3333-4333-8333-333333333333";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

function signal(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, workspace_id: WORKSPACE, from: OWNER, from_kind: "user", to: null, to_agent: null,
    in_reply_to: null, about: null, kind: "note", body: `message ${id.slice(0, 4)}`,
    until: "2099-01-01T00:00:00.000Z", created_at: `2026-11-17T00:00:0${id[0]}.000Z`,
    sender_owner_relation: "same_owner", ...extra,
  };
}

/** Enough directed messages that their output cannot fit in the pipe and its reader's buffer. */
const LARGE = Array.from({ length: 80 }, (_, index) =>
  signal(`${(index % 9) + 1}${String(index).padStart(7, "0")}-6666-4666-8666-666666666666`,
    { to_agent: PRINCIPAL, kind: "ask", body: "x".repeat(7_500) }));

/**
 * stdout: "flow" reads the child's output as it comes; "hold" leaves it unread until the child is
 * writing and the pipe is full, then reads it; "fail" closes the pipe at that point instead.
 */
async function runInbox(ackStatus: number, json: boolean, options: { stdout?: "flow" | "hold" | "fail"; large?: boolean } = {}) {
  const mode = options.stdout ?? "flow";
  const root = await mkdtemp(join(tmpdir(), "cswarm-inbox-observe-"));
  let acksWhileWriting = -1;
  const commands: Array<Record<string, unknown>> = [];
  let readsBeforeAck = -1;
  let reads = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      const body = raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
      const reply = (status: number, value: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (req.url === "/functions/v1/read") {
        reads += 1;
        if (body.resource === "members") {
          return reply(200, {
            members: [{ user_id: OWNER, display_name: "Owner" }],
            agents: [{ principal_id: PRINCIPAL, name: "Rivet", owner_user_id: OWNER }],
            identity: { credential_valid: true, principal_id: PRINCIPAL, workspace_id: WORKSPACE,
              workspace_name: "Test", owner_user_id: OWNER },
          });
        }
        return reply(200, {
          signals: options.large ? LARGE : [
            signal(DIRECTED, { to_agent: PRINCIPAL, kind: "ask" }),
            signal(MENTIONED, { mentions: [{ position: 0, kind: "agent", id: PRINCIPAL, source: "author" }] }),
            signal(ELSEWHERE, { to_agent: OTHER_AGENT }),
          ],
          capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        });
      }
      const command = body.command as Record<string, unknown> | undefined;
      if (command !== undefined) commands.push(command);
      if (command?.kind === "ack_agent_delivery") {
        readsBeforeAck = reads;
        const ids = command.signal_ids as string[];
        return reply(ackStatus, ackStatus === 200
          ? { status: "accepted", ok: true, event_ids: [], outcome: "observed", signal_ids: ids,
            observed_signal_ids: ids, refused: [] }
          : { error: "temporarily_unavailable" });
      }
      return reply(200, { status: "accepted", ok: true, event_ids: [] });
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const credential = JSON.stringify({
    message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.",
    status: "accepted", principal_id: PRINCIPAL, token_id: "44444444-4444-4444-8444-444444444444",
    run_id: "55555555-5555-4555-8555-555555555555", agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z",
  });
  try {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "inbox",
      "--agent-token-stdin", "--url", url, "--anon-key", "anon-inbox-observe", "--workspace-id", WORKSPACE,
      ...(json ? ["--json"] : [])], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
        SWARM_AGENT_STATE_DIR: join(root, "agent-state") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(credential);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr += chunk);
    const exited = new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`inbox timed out; stderr=${stderr}`)); }, 30_000);
      child.once("exit", (exitCode) => { clearTimeout(timer); resolveExit(exitCode); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    const read = () => child.stdout.on("data", (chunk: string) => stdout += chunk);
    if (mode === "flow") {
      read();
    } else {
      // Unread, the child's stdout fills this side's buffer and then the pipe: the child is now
      // mid-write. Give it time to observe early if it were going to.
      const started = Date.now();
      while (child.stdout.readableLength === 0 && child.exitCode === null && Date.now() - started < 20_000) {
        await delay(20);
      }
      assert.ok(child.stdout.readableLength > 0, `the child never started writing; stderr=${stderr}`);
      await delay(1_500);
      acksWhileWriting = commands.filter((command) => command.kind === "ack_agent_delivery").length;
      if (mode === "hold") read();
      else child.stdout.destroy();
    }
    const code = await exited;
    return { code, stdout, stderr, commands, readsBeforeAck, reads, acksWhileWriting };
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
}

for (const json of [false, true]) {
  test(`an agent's inbox${json ? " --json" : ""} observes what it printed, after printing`, { timeout: 30_000 }, async () => {
    const result = await runInbox(200, json);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(DIRECTED));
    const acks = result.commands.filter((command) => command.kind === "ack_agent_delivery");
    assert.equal(acks.length, 1, "one batched observation");
    const ack = acks[0]!;
    assert.deepEqual({ ...ack, signal_ids: [...ack.signal_ids as string[]].sort() }, { kind: "ack_agent_delivery",
      signal_ids: [DIRECTED, MENTIONED], lease_id: null, listener_instance_id: null, outcome: "observed",
      last_error_code: null, surfaced: true, unclaimed: true },
    "the addressed and the mentioned message, not one that reaches another agent");
    assert.equal(result.readsBeforeAck, result.reads, "the observation is the last request, after every read");
  });
}

test("a failed observation changes neither an agent's inbox output nor its exit status", { timeout: 30_000 }, async () => {
  const ok = await runInbox(200, true);
  const failed = await runInbox(503, true);
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(failed.stderr, ok.stderr);
  assert.deepEqual(JSON.parse(failed.stdout), JSON.parse(ok.stdout));
  assert.equal(failed.commands.filter((command) => command.kind === "ack_agent_delivery").length, 1, "tried once, not retried");
});

const acks = (commands: Array<Record<string, unknown>>) => commands.filter((command) => command.kind === "ack_agent_delivery");

for (const json of [false, true]) {
  test(`an agent's inbox${json ? " --json" : ""} observes nothing while its output is held, then observes once it is written`, { timeout: 60_000 }, async () => {
    const result = await runInbox(200, json, { stdout: "hold", large: true });
    assert.equal(result.acksWhileWriting, 0, "no observation while the write is pending");
    assert.equal(result.code, 0, result.stderr);
    const printed = LARGE.filter((row) => result.stdout.includes(row.id)).length;
    assert.equal(printed, LARGE.length, `printed ${printed} of ${LARGE.length}: ${result.stdout.slice(0, 600)}`);
    // Observed after the write completed: every id once, in batches of at most fifty.
    assert.deepEqual(acks(result.commands).flatMap((command) => command.signal_ids as string[]).sort(),
      LARGE.map((row) => row.id).sort());
  });

  test(`an agent's inbox${json ? " --json" : ""} whose output fails observes nothing`, { timeout: 60_000 }, async () => {
    const result = await runInbox(200, json, { stdout: "fail", large: true });
    assert.equal(result.acksWhileWriting, 0, "no observation while the write is pending");
    assert.notEqual(result.code, 0, "a failed write is the command's failure");
    assert.equal(acks(result.commands).length, 0, "and no delivery is observed");
  });
}
