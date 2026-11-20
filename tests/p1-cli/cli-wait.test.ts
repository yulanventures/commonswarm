import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { encodeConversationCursor, WAIT_TIMED_OUT_EXIT_CODE } from "../../src/cli/wait.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import type { ConversationSummaryWire } from "../../src/cloud/conversations.js";

const execFileAsync = promisify(execFile);

const WS = "11111111-1111-4111-8111-111111111111";
const AGENT_A = "44444444-4444-4444-8444-444444444444";
const GEN_CONV = "55555555-5555-4555-8555-555555555555";
const DESIGN_CONV = "66666666-6666-4666-8666-666666666666";
const ROOT_1 = "77777777-7777-4777-8777-777777777777";
const SIG_1 = "88888888-8888-4888-8888-888888888881";
const SIG_2 = "88888888-8888-4888-8888-888888888882";
const SIG_3 = "88888888-8888-4888-8888-888888888883";
const SIG_4 = "88888888-8888-4888-8888-888888888884";
const TOKEN = `swm_agt_${"W".repeat(43)}`;

function summary(
  overrides: Partial<ConversationSummaryWire> & Pick<ConversationSummaryWire, "conversation_id" | "kind">,
): ConversationSummaryWire {
  return {
    channel_id: null,
    slug: null,
    description: null,
    archived_at: null,
    joined: true,
    generation: 1,
    lead_mode: "workspace",
    lead_agent_principal_id: null,
    members: [],
    notify_level: "everything",
    starred: false,
    star_rank: null,
    read_through_at: null,
    read_through_id: null,
    unread_count: 0,
    mention_count: 0,
    last_message_at: null,
    last_message_id: null,
    ...overrides,
  };
}

function makeCredFixture(): { dir: string; tokenFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-wait-p1-"));
  const tokenFile = join(dir, "agent-token.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({
      message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted",
      principal_id: AGENT_A,
      token_id: "99999999-9999-4999-8999-999999999991",
      run_id: "99999999-9999-4999-8999-999999999992",
      agent_token: TOKEN,
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  return {
    dir,
    tokenFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("cswarm wait end-to-end: channel match, cursor chaining, fail-closed channel, timeout 124, 404 access loss, and SIGINT/SIGTERM", { timeout: 30_000 }, async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let mode: "channel-thread-mention" | "timeout" | "revoke" | "hang" = "channel-thread-mention";
  let historyCount = 0;
  let onFirstHangPoll: (() => void) | null = null;

  const conversations: ConversationSummaryWire[] = [
    summary({ conversation_id: GEN_CONV, kind: "general" }),
    summary({ conversation_id: DESIGN_CONV, kind: "public_channel", channel_id: DESIGN_CONV, slug: "design" }),
  ];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = req.url ?? "/";
      requests.push({ path, body });
      res.setHeader("content-type", "application/json");

      if (path === "/functions/v1/command") {
        const cmd = (body.command ?? {}) as Record<string, unknown>;
        if (cmd.kind === "ack_agent_delivery" && cmd.outcome === "observed" && Array.isArray(cmd.signal_ids)) {
          res.end(JSON.stringify({ ok: true, status: "accepted", observed: cmd.signal_ids, refused: [] }));
          return;
        }
      }

      if (path === "/functions/v1/read" && body.resource === "conversations") {
        res.end(JSON.stringify({ conversations }));
        return;
      }

      if (path === "/functions/v1/read" && body.resource === "conversation_history") {
        historyCount += 1;
        if (mode === "channel-thread-mention") {
          if (body.after_id === undefined) {
            // Initial tip anchor: existing SIG_1
            res.end(JSON.stringify({
              conversation: conversations[1],
              messages: [{ id: SIG_1, created_at: "2026-11-20T15:00:00.000Z", body: "existing tip" }],
              has_more: false,
              next_after: { created_at: "2026-11-20T15:00:00.000Z", id: SIG_1 },
            }));
            return;
          }
          if (body.after_id === SIG_1) {
            // Return one non-matching message + two matching replies in order
            res.end(JSON.stringify({
              conversation: conversations[1],
              messages: [
                { id: SIG_2, kind: "note", created_at: "2026-11-20T15:00:02.000Z", thread_root_id: ROOT_1, mentions: [], body: "unmentioned" },
                { id: SIG_3, kind: "note", created_at: "2026-11-20T15:00:03.000Z", thread_root_id: ROOT_1, mentions: [{ kind: "agent", id: AGENT_A }], body: "first match" },
                { id: SIG_4, kind: "note", created_at: "2026-11-20T15:00:04.000Z", thread_root_id: ROOT_1, mentions: [{ kind: "agent", id: AGENT_A }], body: "second match" },
              ],
              has_more: false,
              next_after: { created_at: "2026-11-20T15:00:04.000Z", id: SIG_4 },
            }));
            return;
          }
          if (body.after_id === SIG_3) {
            res.end(JSON.stringify({
              conversation: conversations[1],
              messages: [
                { id: SIG_4, kind: "note", created_at: "2026-11-20T15:00:04.000Z", thread_root_id: ROOT_1, mentions: [{ kind: "agent", id: AGENT_A }], body: "second match" },
              ],
              has_more: false,
              next_after: { created_at: "2026-11-20T15:00:04.000Z", id: SIG_4 },
            }));
            return;
          }
        }

        if (mode === "timeout") {
          res.end(JSON.stringify({
            conversation: conversations[0],
            messages: [],
            has_more: false,
            next_after: null,
          }));
          return;
        }

        if (mode === "revoke") {
          res.statusCode = 404;
          res.end(JSON.stringify({
            error: "conversation_not_found",
            message: "This conversation isn't available in this workspace.",
          }));
          return;
        }

        if (mode === "hang") {
          res.end(JSON.stringify({
            conversation: conversations[0],
            messages: [],
            has_more: false,
            next_after: null,
          }));
          if (onFirstHangPoll) {
            const cb = onFirstHangPoll;
            onFirstHangPoll = null;
            cb();
          }
          return;
        }
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cliPath = resolve("dist/cli.js");
  const cred = makeCredFixture();
  const baseArgs = [
    "--url", baseUrl,
    "--anon-key", "public-test-anon",
    "--workspace-id", WS,
    "--agent-token-file", cred.tokenFile,
  ];

  const runCli = async (args: string[]) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
        env: { ...process.env, HOME: cred.dir, XDG_CONFIG_HOME: join(cred.dir, "cfg") },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };

  try {
    // 1. Channel + --thread <root> + --mentions anchors on tip and matches SIG_3 with exit 0.
    const match1 = await runCli([
      "wait", "--channel", "design", "--thread", ROOT_1, "--mentions", "--timeout", "3s", "--json", ...baseArgs,
    ]);
    assert.equal(match1.code, 0, match1.stderr);
    const out1 = JSON.parse(match1.stdout) as {
      ok: boolean; matched: boolean; conversation_id: string; event: { id: string }; cursor: string; next: string[];
    };
    assert.equal(out1.ok, true);
    assert.equal(out1.matched, true);
    assert.equal(out1.conversation_id, DESIGN_CONV);
    assert.equal(out1.event.id, SIG_3);
    assert.equal(out1.cursor, encodeConversationCursor({ created_at: "2026-11-20T15:00:03.000Z", id: SIG_3 }));
    assert.ok(out1.next[0]?.includes(`--after ${out1.cursor}`));

    // 2. Chaining --after <cursor> immediately delivers SIG_4 without replaying SIG_3.
    const match2 = await runCli([
      "wait", "--conversation", DESIGN_CONV, "--thread", ROOT_1, "--mentions", "--after", out1.cursor, "--timeout", "3s", "--json", ...baseArgs,
    ]);
    assert.equal(match2.code, 0, match2.stderr);
    const out2 = JSON.parse(match2.stdout) as { ok: boolean; event: { id: string }; cursor: string };
    assert.equal(out2.ok, true);
    assert.equal(out2.event.id, SIG_4);
    const observedSignals = requests
      .filter((r) => r.path === "/functions/v1/command")
      .flatMap((r) => {
        const cmd = r.body.command as { kind?: unknown; outcome?: unknown; signal_ids?: unknown } | undefined;
        return cmd?.kind === "ack_agent_delivery" && cmd.outcome === "observed" && Array.isArray(cmd.signal_ids)
          ? (cmd.signal_ids as string[])
          : [];
      });
    assert.deepEqual(observedSignals, [SIG_3, SIG_4], "spawned cswarm wait must observe each returned agent delivery");

    // 3. Unknown --channel fails closed with channel_not_found and never hits /functions/v1/command.
    const beforeCmdCount = requests.filter((r) => r.path === "/functions/v1/command").length;
    const missingChan = await runCli([
      "wait", "--channel", "does-not-exist", "--timeout", "3s", "--json", ...baseArgs,
    ]);
    assert.equal(missingChan.code, 1);
    const missingJson = JSON.parse(missingChan.stdout) as { ok: boolean; error: string; reason: string; next: string[] };
    assert.equal(missingJson.ok, false);
    assert.equal(missingJson.reason, "channel_not_found");
    assert.equal(missingJson.error, "channel_not_found");
    assert.ok(missingJson.next.some((h) => h.includes("cswarm channel ls")));
    assert.equal(requests.filter((r) => r.path === "/functions/v1/command").length, beforeCmdCount);

    // 4. Timeout returns exit code 124 and structured timeout envelope with cursor.
    mode = "timeout";
    const startCursor = encodeConversationCursor({ created_at: "2026-11-20T15:00:00.000Z", id: SIG_1 });
    const timedOut = await runCli([
      "wait", "--conversation", GEN_CONV, "--after", startCursor, "--timeout", "250ms", "--json", ...baseArgs,
    ]);
    assert.equal(timedOut.code, WAIT_TIMED_OUT_EXIT_CODE);
    const timeoutJson = JSON.parse(timedOut.stdout) as {
      ok: boolean; matched: boolean; reason: string; cursor: string; next: string[];
    };
    assert.equal(timeoutJson.ok, false);
    assert.equal(timeoutJson.matched, false);
    assert.equal(timeoutJson.reason, "timeout");
    assert.equal(timeoutJson.cursor, startCursor);
    assert.ok(timeoutJson.next[0]?.includes(`--after ${startCursor}`));

    // 5. 404 access loss stops immediately without waiting out a long timeout and never echoes the token.
    mode = "revoke";
    const t0 = Date.now();
    const revoked = await runCli([
      "wait", "--conversation", GEN_CONV, "--after", startCursor, "--timeout", "30s", "--json", ...baseArgs,
    ]);
    assert.ok(Date.now() - t0 < 5_000, "404 must stop immediately");
    assert.equal(revoked.code, 1);
    const revokedJson = JSON.parse(revoked.stdout) as { ok: boolean; reason: string };
    assert.equal(revokedJson.ok, false);
    assert.equal(revokedJson.reason, "conversation_not_found");
    assert.ok(!revoked.stdout.includes(TOKEN));
    assert.ok(!revoked.stderr.includes(TOKEN));

    // 6. Clean SIGINT and SIGTERM teardown with zero hanging sockets/timers.
    mode = "hang";
    for (const [sig, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const firstPoll = new Promise<void>((resolvePoll) => {
        onFirstHangPoll = resolvePoll;
      });
      const child = spawn(
        process.execPath,
        [cliPath, "wait", "--conversation", GEN_CONV, "--after", startCursor, "--timeout", "30s", "--json", ...baseArgs],
        { env: { ...process.env, HOME: cred.dir, XDG_CONFIG_HOME: join(cred.dir, "cfg") }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      await firstPoll;
      child.kill(sig);
      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.once("exit", (code) => resolveExit(code));
      });
      assert.equal(exitCode, expectedCode, `${sig} should exit cleanly with ${expectedCode}`);
      const interrupted = JSON.parse(stdout) as { ok: boolean; reason: string; signal: string; cursor: string };
      assert.equal(interrupted.ok, false);
      assert.equal(interrupted.reason, "interrupted");
      assert.equal(interrupted.signal, sig);
      assert.equal(interrupted.cursor, startCursor);
    }

    // 7. Invalid cursor and over-max timeout fail fast with structured V1/V3 error envelopes.
    const badCursorRes = await runCli([
      "wait", "--conversation", GEN_CONV, "--after", "not-a-valid-cursor", "--json", ...baseArgs,
    ]);
    assert.equal(badCursorRes.code, 1);
    const badCursorJson = JSON.parse(badCursorRes.stdout) as { ok: boolean; error: string; reason: string; next: string[] };
    assert.equal(badCursorJson.ok, false);
    assert.equal(badCursorJson.reason, "invalid_cursor");
    assert.equal(badCursorJson.error, "invalid_cursor");
    assert.ok(badCursorJson.next.length > 0);

    const overMaxRes = await runCli([
      "wait", "--channel", "general", "--timeout", "31m", "--json", ...baseArgs,
    ]);
    assert.equal(overMaxRes.code, 1);
    const overMaxJson = JSON.parse(overMaxRes.stdout) as { ok: boolean; reason: string };
    assert.equal(overMaxJson.ok, false);
    assert.equal(overMaxJson.reason, "invalid_arguments");

    // 8. Regression check: `cswarm reply --thread` still treats --thread as a boolean flag (not requiring a value).
    const replyHelp = await runCli(["reply", "--help"]);
    assert.equal(replyHelp.code, 0);
    assert.match(replyHelp.stdout, /--thread \[--broadcast-to-channel\]/);
    const replyCheck = await runCli(["reply", SIG_1, "hello", "--thread", ...baseArgs]);
    assert.doesNotMatch(replyCheck.stderr, /--thread requires a value/);
    assert.ok(historyCount >= 4);
  } finally {
    server.close();
    cred.cleanup();
  }
});
