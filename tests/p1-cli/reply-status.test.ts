import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { REPLY_STATUSES } from "../../src/cloud/reply-status.js";
import { parseDeliveryReceiptResult } from "../../src/cloud/delivery-receipts.js";
import { renderSignalReceiptReport } from "../../src/cloud/receipts.js";
import { parseSignalRecord, renderSignals } from "../../src/cloud/signals.js";
import { usage } from "../../src/cli.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPLY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RESPONDER_ONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RESPONDER_TWO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

test("reply help derives the status choices from the shared constant", () => {
  assert.match(
    usage(),
    new RegExp(`cswarm reply [^\n]+--status <${REPLY_STATUSES.join("\\|")}>`),
  );
});

test("--status with --thread exits 2 with reply_status_thread before any request", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const state = await mkdtemp(join(tmpdir(), "cswarm-reply-status-"));
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveRun) => {
      const child = spawn(process.execPath, [
        process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"),
        "reply", SIGNAL, "answer", "--thread", "--status", "declined",
        "--workspace-id", WORKSPACE, "--agent-token-stdin",
      ], {
        env: {
          ...process.env,
          HOME: state,
          SWARM_CLOUD_URL: `http://127.0.0.1:${address.port}`,
          SWARM_CLOUD_ANON_KEY: "fixture-key",
        },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.stdin.end(`${TOKEN}\n`);
      child.on("close", (code) => resolveRun({ code, stderr }));
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /reply_status_thread/);
    assert.equal(requests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(state, { recursive: true, force: true });
  }
});

test("a private CLI reply defaults reply_status to answered on the wire", async () => {
  const commands: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => raw += chunk);
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (request.url === "/functions/v1/read") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ members: [], agents: [] }),
        );
        return;
      }
      const command = body.command as Record<string, unknown>;
      commands.push(command);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        events: [],
        signal: {
          id: REPLY, workspace_id: WORKSPACE, from: RESPONDER_ONE,
          from_kind: "agent", to: null, to_agent: RESPONDER_TWO,
          in_reply_to: SIGNAL, reply_status: command.reply_status,
          about: null, kind: "note", body: "answer", attachments: [],
          until: "2026-09-27T12:00:00.000Z",
          created_at: "2026-09-26T12:00:00.000Z",
        },
      }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const state = await mkdtemp(join(tmpdir(), "cswarm-reply-default-"));
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveRun) => {
      const child = spawn(process.execPath, [
        process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"),
        "reply", SIGNAL, "answer", "--workspace-id", WORKSPACE,
        "--agent-token-stdin",
      ], {
        env: {
          ...process.env,
          HOME: state,
          SWARM_CLOUD_URL: `http://127.0.0.1:${address.port}`,
          SWARM_CLOUD_ANON_KEY: "fixture-key",
        },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.stdin.end(`${TOKEN}\n`);
      child.on("close", (code) => resolveRun({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.reply_status, "answered");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(state, { recursive: true, force: true });
  }
});

test("receipt parsing is old-server compatible and renders the latest reply per responder", () => {
  const base = {
    addressed: true,
    receipts: [{
      recipient_user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      seen_at: null,
    }],
  };
  const old = parseDeliveryReceiptResult(base);
  assert.deepEqual(old.replies, []);

  const parsed = parseDeliveryReceiptResult({
    ...base,
    replies: [{
      responder_principal_id: RESPONDER_ONE,
      responder_display_name: "Ari",
      reply_signal_id: "11111111-1111-4111-8111-111111111111",
      reply_status: "answered",
      created_at: "2026-09-26T12:00:00.000Z",
    }, {
      responder_principal_id: RESPONDER_TWO,
      responder_display_name: "Bo",
      reply_signal_id: "22222222-2222-4222-8222-222222222222",
      reply_status: "failed",
      created_at: "2026-09-26T12:01:00.000Z",
    }, {
      responder_principal_id: RESPONDER_ONE,
      responder_display_name: "Ari",
      reply_signal_id: "33333333-3333-4333-8333-333333333333",
      reply_status: "declined",
      created_at: "2026-09-26T12:02:00.000Z",
    }],
  });
  const rendered = renderSignalReceiptReport({
    workspaceId: WORKSPACE,
    signalId: SIGNAL,
    addressed: true,
    receipts: parsed.receipts,
    replies: parsed.replies,
  }, Date.parse("2026-09-26T12:05:00.000Z"));
  assert.match(rendered, /Replied \(declined\) by Ari 3m ago/);
  assert.match(rendered, /Replied \(failed\) by Bo 4m ago/);
  assert.doesNotMatch(rendered, /Replied \(answered\)/);
});

test("signal rows parse and render reply_status", () => {
  const signal = parseSignalRecord({
    id: REPLY,
    workspace_id: WORKSPACE,
    from: RESPONDER_ONE,
    from_kind: "agent",
    to: null,
    to_agent: RESPONDER_TWO,
    in_reply_to: SIGNAL,
    reply_status: "declined",
    about: null,
    kind: "note",
    body: "No, thank you.",
    attachments: [],
    until: "2026-09-27T12:00:00.000Z",
    created_at: "2026-09-26T12:00:00.000Z",
  });
  assert.equal(signal.reply_status, "declined");
  assert.match(
    renderSignals([signal], {
      inbox: true,
      includeStale: true,
      now: Date.parse("2026-09-26T12:05:00.000Z"),
    }),
    /\[note\] \(declined\)/,
  );
});
