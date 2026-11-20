import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { configureAgentReceive } from "../../src/cloud/agent-receive.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "../../src/cli/ax.js";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const CONV_GEN = "44444444-4444-4444-8444-444444444444";
const CONV_DM = "55555555-5555-4555-8555-555555555555";
const CONV_MISSING = "66666666-6666-4666-8666-666666666666";
const SIG_1 = "77777777-7777-4777-8777-777777777777";
const SIG_2 = "88888888-8888-4888-8888-888888888888";
const TOKEN = `swm_agt_${"x".repeat(43)}`;
const ANON_KEY = "test-anon-key-public";
const CLI_PATH = resolve("dist/cli.js");

async function runCli(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, "config"),
        SWARM_AGENT_STATE_DIR: join(dir, "state"),
        SWARM_CLOUD_URL: "",
        SWARM_CLOUD_ANON_KEY: "",
        SWARM_CLOUD_WORKSPACE_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (status) => {
      resolveRun({ code: status ?? 1, stdout, stderr });
    });
  });
}

async function startMockCloud(options: {
  supportConversationsList?: boolean;
  rateLimitNextConversationRead?: boolean;
} = {}) {
  const seenReads: Array<Record<string, unknown>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url !== "/functions/v1/read") {
        return reply(404, { error: "not_found", message: "Not found" });
      }
      seenReads.push(body);
      const resource = body.resource;
      if (resource === "members") {
        return reply(200, {
          members: [{ user_id: OWNER, display_name: "Owner" }],
          agents: [{ principal_id: AGENT, name: "CLI AX Agent", owner_user_id: OWNER }],
          identity: {
            credential_valid: true,
            principal_id: AGENT,
            owner_user_id: OWNER,
            workspace_id: WS,
            workspace_name: "Test Workspace",
            lead_agent_principal_id: AGENT,
            is_workspace_lead: true,
          },
        });
      }
      if (resource === "renewal_grants") {
        return reply(200, { grants: [] });
      }
      if (resource === "conversations") {
        if (options.supportConversationsList === false) {
          return reply(400, { error: "invalid_request", message: "unknown resource" });
        }
        return reply(200, {
          conversations: [
            {
              conversation_id: CONV_GEN,
              kind: "general",
              channel_id: null,
              slug: null,
              description: null,
              archived_at: null,
              joined: true,
              generation: 1,
              lead_mode: "workspace",
              lead_agent_principal_id: AGENT,
              members: [],
              notify_level: "everything",
              starred: false,
              star_rank: null,
              read_through_at: null,
              read_through_id: null,
              unread_count: 2,
              mention_count: 1,
              last_message_at: "2026-11-20T10:00:00.000Z",
              last_message_id: SIG_1,
            },
            {
              conversation_id: CONV_DM,
              kind: "dm",
              channel_id: null,
              slug: null,
              description: null,
              archived_at: null,
              joined: true,
              generation: 1,
              lead_mode: "none",
              lead_agent_principal_id: null,
              members: [{ kind: "user", id: OWNER, name: "Owner", left_at: null }],
              notify_level: "everything",
              starred: false,
              star_rank: null,
              read_through_at: null,
              read_through_id: null,
              unread_count: 1,
              mention_count: 0,
              last_message_at: "2026-11-20T10:01:00.000Z",
              last_message_id: SIG_2,
            },
          ],
        });
      }
      if (resource === "channels") {
        return reply(200, {
          general_unread: true,
          channels: [
            {
              channel_id: CONV_GEN,
              slug: "ops",
              purpose: null,
              visibility: "open",
              archived_at: null,
              created_at: "2026-11-20T00:00:00.000Z",
              lead_mode: "workspace",
              lead_agent_principal_id: null,
              unread: false,
            },
          ],
        });
      }
      if (resource === "conversation_history") {
        if (options.rateLimitNextConversationRead) {
          return reply(429, {
            error: "rate_limited",
            message: `Too many requests for token ${TOKEN}`,
          });
        }
        if (body.conversation_id === CONV_MISSING) {
          return reply(404, {
            error: "conversation_not_found",
            message: "This conversation isn't available.",
          });
        }
        if (body.after_id === SIG_1) {
          return reply(200, {
            conversation: {
              conversation_id: CONV_GEN,
              kind: "general",
              channel_id: null,
              slug: null,
              description: null,
              archived_at: null,
              joined: true,
              generation: 1,
              lead_mode: "workspace",
              lead_agent_principal_id: AGENT,
              members: [],
              notify_level: "everything",
              starred: false,
              star_rank: null,
              read_through_at: null,
              read_through_id: null,
              unread_count: 0,
              mention_count: 0,
              last_message_at: "2026-11-20T10:01:00.000Z",
              last_message_id: SIG_2,
            },
            messages: [
              {
                id: SIG_2,
                created_at: "2026-11-20T10:01:00.000Z",
                from_kind: "user",
                from: OWNER,
                body: "Second page message",
              },
            ],
            has_more: false,
            next_before: null,
            next_after: { created_at: "2026-11-20T10:01:00.000Z", id: SIG_2 },
          });
        }
        return reply(200, {
          conversation: {
            conversation_id: CONV_GEN,
            kind: "general",
            channel_id: null,
            slug: null,
            description: null,
            archived_at: null,
            joined: true,
            generation: 1,
            lead_mode: "workspace",
            lead_agent_principal_id: AGENT,
            members: [],
            notify_level: "everything",
            starred: false,
            star_rank: null,
            read_through_at: null,
            read_through_id: null,
            unread_count: 1,
            mention_count: 0,
            last_message_at: "2026-11-20T10:00:00.000Z",
            last_message_id: SIG_1,
          },
          messages: [
            {
              id: SIG_1,
              created_at: "2026-11-20T10:00:00.000Z",
              from_kind: "user",
              from: OWNER,
              body: "First page message",
            },
          ],
          has_more: true,
          next_before: null,
          next_after: { created_at: "2026-11-20T10:00:00.000Z", id: SIG_1 },
        });
      }
      if (resource === "signals") {
        const rows = body.after_id === SIG_1
          ? [
              {
                id: SIG_2,
                workspace_id: WS,
                kind: "note",
                about: null,
                body: "Inbox follow-up",
                from: OWNER,
                from_kind: "user",
                to: null,
                to_agent: AGENT,
                created_at: "2026-11-20T10:01:00.000Z",
                until: "2099-01-01T00:00:00.000Z",
              },
            ]
          : [
              {
                id: SIG_1,
                workspace_id: WS,
                kind: "note",
                about: null,
                body: "Inbox first",
                from: OWNER,
                from_kind: "user",
                to: null,
                to_agent: AGENT,
                created_at: "2026-11-20T10:00:00.000Z",
                until: "2099-01-01T00:00:00.000Z",
              },
            ];
        return reply(200, {
          signals: rows,
          capabilities: { cursor_after: 1 },
        });
      }
      return reply(400, { error: "invalid_request", message: `unexpected resource ${String(resource)}` });
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    seenReads,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

test("cswarm whoami --json returns richer workspace, seat, and conversations metadata (Step 2b + pre-2b fallback) without leaking secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-ax-whoami-"));
  chmodSync(dir, 0o700);
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  const cloud = await startMockCloud({ supportConversationsList: true });
  const legacyCloud = await startMockCloud({ supportConversationsList: false });
  try {
    const profilePath = join(dir, "profile.json");
    await saveAgentProfile(
      profilePath,
      {
        version: 1,
        url: cloud.url,
        anon_key: ANON_KEY,
        workspace_id: WS,
        principal_id: AGENT,
        credential: {
          message: AGENT_CREDENTIAL_MESSAGE_D088,
          status: "accepted",
          principal_id: AGENT,
          token_id: "99999999-9999-4999-8999-999999999999",
          run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agent_token: TOKEN,
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      },
      undefined,
      "session-ax-1",
    );

    const res = await runCli(dir, [
      "whoami",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-1",
      "--json",
    ]);
    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /swm_agt_/);
    const body = JSON.parse(res.stdout) as Record<string, any>;
    assert.equal(body.credential_valid, true);
    assert.equal(body.workspace.workspace_id, WS);
    assert.equal(body.workspace.name, "Test Workspace");
    assert.equal(body.workspace.role, "workspace_lead");
    assert.equal(body.seat.status, "active");
    assert.equal(body.seat.host_binding.mode, "session");
    assert.equal(body.seat.host_binding.profile_bound, true);
    assert.equal(body.seat.host_binding.host_session_id, "session-ax-1");
    assert.equal(body.receive.configured, false);
    assert.equal(body.receive.effective_mode, "turn");
    assert.equal(body.receive.turn_check, "instruction");
    assert.equal(body.receive.wake_verified, false);
    assert.equal(body.conversations.source, "conversations");
    assert.equal(body.conversations.channels.length, 1);
    assert.equal(body.conversations.direct_messages.length, 1);
    assert.equal(body.conversations.total_unread, 3);
    assert.equal(body.conversations.total_mentions, 1);

    // Host-bound receive witness: once configured for session-ax-1, whoami --json MUST report receive.configured: true!
    const projectDir = join(dir, "project");
    mkdirSync(projectDir, { recursive: true });
    await configureAgentReceive({
      profilePath,
      mode: "turn",
      provider: "codex",
      hostSessionId: "session-ax-1",
      cwd: projectDir,
      execution: { command: process.execPath, args: [CLI_PATH] },
    });
    const configuredRes = await runCli(dir, [
      "whoami",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-1",
      "--json",
    ]);
    assert.equal(configuredRes.code, 0, configuredRes.stderr);
    const configuredBody = JSON.parse(configuredRes.stdout) as Record<string, any>;
    assert.equal(configuredBody.receive.configured, true);
    assert.equal(configuredBody.receive.requested_mode, "turn");
    assert.equal(configuredBody.receive.effective_mode, "turn");
    assert.equal(configuredBody.receive.turn_check, "pending_host");
    assert.equal(configuredBody.receive.host_session_id, "session-ax-1");

    // Pre-2b fallback path via direct token file
    const tokenPath = join(dir, "agent.token");
    writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
    const legacyRes = await runCli(dir, [
      "whoami",
      "--agent-token-file",
      tokenPath,
      "--url",
      legacyCloud.url,
      "--anon-key",
      ANON_KEY,
      "--workspace-id",
      WS,
      "--json",
    ]);
    assert.equal(legacyRes.code, 0, legacyRes.stderr);
    assert.doesNotMatch(legacyRes.stdout, /swm_agt_/);
    const legacyBody = JSON.parse(legacyRes.stdout) as Record<string, any>;
    assert.equal(legacyBody.seat.host_binding.mode, "direct");
    assert.equal(legacyBody.receive.configured, false);
    assert.equal(legacyBody.receive.effective_mode, "direct");
    assert.equal(legacyBody.receive.turn_check, "none");
    assert.equal(legacyBody.conversations.source, "channels_fallback");
    assert.equal(legacyBody.conversations.channels.length, 2);
    assert.equal(legacyBody.conversations.channels[0].slug, "general");
    assert.equal(legacyBody.conversations.channels[1].slug, "ops");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await cloud.close();
    await legacyCloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cswarm conversation read and check round-trip opaque --after <cursor> and emit self-healing --json error envelopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-ax-cursor-"));
  chmodSync(dir, 0o700);
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  const cloud = await startMockCloud({ supportConversationsList: true });
  const rateLimitCloud = await startMockCloud({ supportConversationsList: true, rateLimitNextConversationRead: true });
  try {
    const profilePath = join(dir, "profile.json");
    await saveAgentProfile(
      profilePath,
      {
        version: 1,
        url: cloud.url,
        anon_key: ANON_KEY,
        workspace_id: WS,
        principal_id: AGENT,
        credential: {
          message: AGENT_CREDENTIAL_MESSAGE_D088,
          status: "accepted",
          principal_id: AGENT,
          token_id: "99999999-9999-4999-8999-999999999999",
          run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agent_token: TOKEN,
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      },
      undefined,
      "session-ax-2",
    );

    // 1. conversation read returns next_cursor + runnable next command
    const page1 = await runCli(dir, [
      "conversation",
      "read",
      CONV_GEN,
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-2",
      "--json",
    ]);
    assert.equal(page1.code, 0, page1.stderr);
    const page1Json = JSON.parse(page1.stdout) as Record<string, any>;
    assert.equal(typeof page1Json.next_cursor, "string");
    assert.deepEqual(decodeOpaqueCursor(page1Json.next_cursor), {
      v: 1,
      created_at: "2026-11-20T10:00:00.000Z",
      id: SIG_1,
    });
    assert.match(page1Json.next[0], new RegExp(`^cswarm conversation read ${CONV_GEN} --after ${page1Json.next_cursor}`));

    // 2. conversation read accepts --after <next_cursor> and advances
    const page2 = await runCli(dir, [
      "conversation",
      "read",
      CONV_GEN,
      "--after",
      page1Json.next_cursor,
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-2",
      "--json",
    ]);
    assert.equal(page2.code, 0, page2.stderr);
    const page2Json = JSON.parse(page2.stdout) as Record<string, any>;
    assert.equal(page2Json.messages[0].id, SIG_2);
    assert.deepEqual(decodeOpaqueCursor(page2Json.next_cursor), {
      v: 1,
      created_at: "2026-11-20T10:01:00.000Z",
      id: SIG_2,
    });

    // 3. invalid --after cursor returns structured JSON error envelope with exit 1
    const badCursor = await runCli(dir, [
      "conversation",
      "read",
      CONV_GEN,
      "--after",
      "not-a-valid-cursor!",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-2",
      "--json",
    ]);
    assert.equal(badCursor.code, 1);
    assert.equal(badCursor.stdout, "");
    const badCursorJson = JSON.parse(badCursor.stderr) as Record<string, any>;
    assert.equal(badCursorJson.ok, false);
    assert.equal(badCursorJson.error, "invalid_cursor");
    assert.equal(badCursorJson.reason, "invalid_cursor");
    assert.match(badCursorJson.next[0], new RegExp(`^cswarm conversation read ${CONV_GEN}`));

    // 4. 404 conversation_not_found returns structured JSON error envelope
    const missingConv = await runCli(dir, [
      "conversation",
      "read",
      CONV_MISSING,
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-2",
      "--json",
    ]);
    assert.equal(missingConv.code, 1);
    assert.equal(missingConv.stdout, "");
    const missingConvJson = JSON.parse(missingConv.stderr) as Record<string, any>;
    assert.equal(missingConvJson.ok, false);
    assert.equal(missingConvJson.error, "conversation_not_found");
    assert.equal(missingConvJson.reason, "conversation_not_found");
    assert.match(missingConvJson.next[0], /^cswarm conversations /);

    // 5. channel join unknown channel returns channel_not_found envelope
    const missingCh = await runCli(dir, [
      "channel",
      "join",
      "does-not-exist",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-2",
      "--json",
    ]);
    assert.equal(missingCh.code, 1);
    assert.equal(missingCh.stdout, "");
    const missingChJson = JSON.parse(missingCh.stderr) as Record<string, any>;
    assert.equal(missingChJson.ok, false);
    assert.equal(missingChJson.reason, "channel_not_found");
    assert.match(missingChJson.next[0], /^cswarm channel ls /);

    // 6. check --json returns next_cursor + next and accepts --after <cursor> + handles invalid_cursor & session mismatch
    const check1 = await runCli(dir, [
      "check",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-2",
      "--json",
    ]);
    assert.equal(check1.code, 0, `${check1.stdout}\n${check1.stderr}`);
    const check1Json = JSON.parse(check1.stdout) as Record<string, any>;
    assert.equal(check1Json.messages[0].id, SIG_1);
    assert.equal(typeof check1Json.next_cursor, "string");
    assert.match(check1Json.next[0], new RegExp(`--after ${check1Json.next_cursor} --json$`));

    const check2 = await runCli(dir, [
      "check",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-2",
      "--after",
      check1Json.next_cursor,
      "--json",
    ]);
    assert.equal(check2.code, 0, check2.stderr);
    const check2Json = JSON.parse(check2.stdout) as Record<string, any>;
    assert.equal(check2Json.messages[0].id, SIG_2);
    assert.equal(
      check2Json.next_cursor,
      encodeOpaqueCursor({ created_at: "2026-11-20T10:01:00.000Z", id: SIG_2 }),
    );

    const checkBadCursor = await runCli(dir, [
      "check",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-ax-2",
      "--after",
      "bad",
      "--json",
    ]);
    assert.equal(checkBadCursor.code, 1);
    const checkBadJson = JSON.parse(checkBadCursor.stdout) as Record<string, any>;
    assert.equal(checkBadJson.ok, false);
    assert.equal(checkBadJson.reason, "invalid_cursor");
    assert.equal(checkBadJson.error.code, "invalid_cursor");
    assert.match(checkBadJson.next[0], /^cswarm check /);

    const wrongSession = await runCli(dir, [
      "conversation",
      "read",
      CONV_GEN,
      "--profile",
      profilePath,
      "--host-session-id",
      "session-other",
      "--json",
    ]);
    assert.equal(wrongSession.code, 1);
    assert.equal(wrongSession.stdout, "");
    const wrongSessionJson = JSON.parse(wrongSession.stderr) as Record<string, any>;
    assert.equal(wrongSessionJson.ok, false);
    assert.equal(wrongSessionJson.reason, "profile_session_mismatch");
    assert.match(wrongSessionJson.next[0], /^cswarm setup --connection-file/);

    // 7. 429 rate_limited scrubs echoed tokens from message
    const tokenPath = join(dir, "rate-token.txt");
    writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
    const rl = await runCli(dir, [
      "conversation",
      "read",
      CONV_GEN,
      "--agent-token-file",
      tokenPath,
      "--url",
      rateLimitCloud.url,
      "--anon-key",
      ANON_KEY,
      "--workspace-id",
      WS,
      "--json",
    ]);
    assert.equal(rl.code, 1);
    assert.equal(rl.stdout, "");
    assert.doesNotMatch(rl.stderr, /swm_agt_/);
    const rlJson = JSON.parse(rl.stderr) as Record<string, any>;
    assert.equal(rlJson.ok, false);
    assert.equal(rlJson.reason, "rate_limited");
    assert.match(rlJson.message, /\[redacted\]/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await cloud.close();
    await rateLimitCloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
