import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  channelConversationCommand,
  classifyConversationMemberSelector,
  dedupeConversationMembers,
  findChannelConversation,
  type ConversationSummaryWire,
} from "../src/cloud/conversations.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../src/cloud/agent-credential-input.js";

const WS = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const USER_B = "33333333-3333-4333-8333-333333333333";
const AGENT_A = "44444444-4444-4444-8444-444444444444";
const GEN_CONV = "55555555-5555-4555-8555-555555555555";
const PUB_CH = "66666666-6666-4666-8666-666666666666";
const PRIV_CH = "77777777-7777-4777-8777-777777777777";
const DM_CONV = "88888888-8888-4888-8888-888888888888";

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

test("classifyConversationMemberSelector & dedupeConversationMembers handle explicit refs, invalid explicit refs, and lookups", () => {
  assert.deepEqual(classifyConversationMemberSelector(`user:${USER_A.toUpperCase()}`), {
    kind: "explicit",
    member: { kind: "user", id: USER_A },
  });
  assert.deepEqual(classifyConversationMemberSelector(`agent:${AGENT_A}`), {
    kind: "explicit",
    member: { kind: "agent", id: AGENT_A },
  });
  const bad = classifyConversationMemberSelector("user:not-a-uuid");
  assert.equal(bad.kind, "invalid_explicit");
  assert.deepEqual(classifyConversationMemberSelector("Alice"), { kind: "lookup" });
  assert.deepEqual(classifyConversationMemberSelector(USER_A), { kind: "lookup" });

  assert.deepEqual(
    dedupeConversationMembers([
      { kind: "user", id: USER_A.toUpperCase() },
      { kind: "agent", id: AGENT_A },
      { kind: "user", id: USER_A },
    ]),
    [
      { kind: "user", id: USER_A },
      { kind: "agent", id: AGENT_A },
    ],
  );
});

test("findChannelConversation resolves general, slug, channel_id, and conversation_id while ignoring DMs", () => {
  const list: ConversationSummaryWire[] = [
    summary({ conversation_id: GEN_CONV, kind: "general" }),
    summary({ conversation_id: PUB_CH, kind: "public_channel", channel_id: PUB_CH, slug: "design" }),
    summary({ conversation_id: PRIV_CH, kind: "private_channel", channel_id: PRIV_CH, slug: "ops-priv" }),
    summary({ conversation_id: DM_CONV, kind: "dm" }),
  ];

  assert.equal(findChannelConversation(list, "general")?.conversation_id, GEN_CONV);
  assert.equal(findChannelConversation(list, "GENERAL")?.conversation_id, GEN_CONV);
  assert.equal(findChannelConversation(list, "design")?.conversation_id, PUB_CH);
  assert.equal(findChannelConversation(list, PRIV_CH.toUpperCase())?.conversation_id, PRIV_CH);
  assert.equal(findChannelConversation(list, DM_CONV), null);
  assert.equal(findChannelConversation(list, "missing"), null);
});

test("channelConversationCommand routes public channels to conversation_* and private channels to channel_*", () => {
  const pub = summary({ conversation_id: PUB_CH, kind: "public_channel", channel_id: PUB_CH, slug: "design" });
  const priv = summary({ conversation_id: PRIV_CH, kind: "private_channel", channel_id: PRIV_CH, slug: "ops-priv" });
  const m = { kind: "user" as const, id: USER_B };

  assert.deepEqual(channelConversationCommand(pub, { action: "join" }), {
    kind: "conversation_join",
    conversation_id: PUB_CH,
  });
  assert.deepEqual(channelConversationCommand(pub, { action: "leave" }), {
    kind: "conversation_leave",
    conversation_id: PUB_CH,
  });
  assert.deepEqual(channelConversationCommand(priv, { action: "leave" }), {
    kind: "channel_leave",
    channel_id: PRIV_CH,
  });
  assert.deepEqual(channelConversationCommand(pub, { action: "invite", members: [m] }), {
    kind: "conversation_invite",
    conversation_id: PUB_CH,
    members: [m],
  });
  assert.deepEqual(channelConversationCommand(priv, { action: "invite", members: [m] }), {
    kind: "channel_member_add",
    channel_id: PRIV_CH,
    members: [m],
  });
  assert.deepEqual(channelConversationCommand(pub, { action: "remove", member: m }), {
    kind: "conversation_remove",
    conversation_id: PUB_CH,
    member: m,
  });
  assert.deepEqual(channelConversationCommand(priv, { action: "remove", member: m }), {
    kind: "channel_member_remove",
    channel_id: PRIV_CH,
    member: m,
  });
});

test("cswarm dm and cswarm channel join|leave|invite|remove|members execute exact wire payloads", { timeout: 30_000 }, async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const conversations: ConversationSummaryWire[] = [
    summary({ conversation_id: GEN_CONV, kind: "general" }),
    summary({
      conversation_id: PUB_CH,
      kind: "public_channel",
      channel_id: PUB_CH,
      slug: "design",
      joined: false,
      members: [
        { kind: "user", id: USER_A, name: "Alice", left_at: null },
        { kind: "agent", id: AGENT_A, name: "DesignBot", left_at: null },
        { kind: "user", id: USER_B, name: "Bob", left_at: "2026-11-19T00:00:00Z" },
      ],
    }),
    summary({
      conversation_id: PRIV_CH,
      kind: "private_channel",
      channel_id: PRIV_CH,
      slug: "ops-priv",
      joined: true,
      members: [
        { kind: "user", id: USER_A, name: "Alice", left_at: null },
      ],
    }),
  ];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.trim().length > 0 ? JSON.parse(raw) as Record<string, unknown> : {};
      const path = req.url ?? "/";
      requests.push({ path, body });
      res.setHeader("content-type", "application/json");
      if (path === "/functions/v1/read") {
        if (body.resource === "conversations") {
          res.end(JSON.stringify({ conversations }));
          return;
        }
        if (body.resource === "members") {
          res.end(JSON.stringify({
            members: [
              { user_id: USER_A, display_name: "Alice" },
              { user_id: USER_B, display_name: "Bob" },
            ],
            agents: [
              { principal_id: AGENT_A, name: "DesignBot" },
            ],
          }));
          return;
        }
      }
      if (path === "/functions/v1/command") {
        const cmd = body.command as Record<string, unknown>;
        if (cmd.kind === "conversation_open") {
          res.end(JSON.stringify({
            created: true,
            conversation: {
              conversation_id: DM_CONV,
              kind: Array.isArray(cmd.members) && cmd.members.length > 1 ? "group_dm" : "dm",
              generation: 1,
              members: cmd.members,
            },
          }));
          return;
        }
        res.end(JSON.stringify({ ok: true, changed: true, command_kind: cmd.kind }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "cswarm-conv-ergonomics-"));
  const tokenFile = join(dir, "agent.token");
  writeFileSync(
    tokenFile,
    `${JSON.stringify({
      message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted",
      principal_id: AGENT_A,
      token_id: "99999999-9999-4999-8999-999999999999",
      run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agent_token: "swm_agt_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
    })}\n`,
    { mode: 0o600 },
  );

  const run = async (cliArgs: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import", "tsx",
        resolve("src/cli.ts"),
        ...cliArgs,
        "--url", baseUrl,
        "--anon-key", "test-anon-key",
        "--workspace-id", WS,
        "--agent-token-file", tokenFile,
      ],
      { encoding: "utf8", env: { ...process.env, HOME: dir } },
    );
    return stdout;
  };

  try {
    // 1. cswarm dm <name> <agent-name> resolves names via directory and opens group_dm
    const dmOut = await run(["dm", "Bob", "DesignBot", "--new-group", "--json"]);
    assert.equal((JSON.parse(dmOut).conversation as Record<string, unknown>).kind, "group_dm");
    const openCmd = requests.at(-1)!.body.command as Record<string, unknown>;
    assert.deepEqual(openCmd, {
      kind: "conversation_open",
      members: [
        { kind: "user", id: USER_B },
        { kind: "agent", id: AGENT_A },
      ],
      new_group: true,
    });

    // 2. cswarm dm user:<uuid> skips members lookup completely
    const reqCountBefore = requests.length;
    await run(["dm", `user:${USER_A}`]);
    const dmExplicitReqs = requests.slice(reqCountBefore);
    assert.equal(dmExplicitReqs.length, 1, "explicit user:<uuid> must skip members lookup");
    assert.deepEqual(dmExplicitReqs[0]!.body.command, {
      kind: "conversation_open",
      members: [{ kind: "user", id: USER_A }],
    });

    // 3. cswarm channel join design -> conversation_join
    const joinOut = await run(["channel", "join", "design"]);
    assert.match(joinOut, /Joined #design/);
    assert.deepEqual(requests.at(-1)!.body.command, {
      kind: "conversation_join",
      conversation_id: PUB_CH,
    });

    // 4. cswarm channel leave design (public) -> conversation_leave; ops-priv (private) -> channel_leave
    await run(["channel", "leave", "design"]);
    assert.deepEqual(requests.at(-1)!.body.command, {
      kind: "conversation_leave",
      conversation_id: PUB_CH,
    });
    await run(["channel", "leave", "ops-priv"]);
    assert.deepEqual(requests.at(-1)!.body.command, {
      kind: "channel_leave",
      channel_id: PRIV_CH,
    });

    // 5. cswarm channel invite on public -> conversation_invite; on private -> channel_member_add
    await run(["channel", "invite", "design", "Bob", `agent:${AGENT_A}`]);
    assert.deepEqual(requests.at(-1)!.body.command, {
      kind: "conversation_invite",
      conversation_id: PUB_CH,
      members: [
        { kind: "user", id: USER_B },
        { kind: "agent", id: AGENT_A },
      ],
    });
    await run(["channel", "invite", "ops-priv", "Bob"]);
    assert.deepEqual(requests.at(-1)!.body.command, {
      kind: "channel_member_add",
      channel_id: PRIV_CH,
      members: [{ kind: "user", id: USER_B }],
    });

    // 6. cswarm channel remove on public -> conversation_remove; on private -> channel_member_remove
    await run(["channel", "remove", "design", "Bob"]);
    assert.deepEqual(requests.at(-1)!.body.command, {
      kind: "conversation_remove",
      conversation_id: PUB_CH,
      member: { kind: "user", id: USER_B },
    });
    await run(["channel", "remove", "ops-priv", "Bob"]);
    assert.deepEqual(requests.at(-1)!.body.command, {
      kind: "channel_member_remove",
      channel_id: PRIV_CH,
      member: { kind: "user", id: USER_B },
    });

    // 7. cswarm channel members design --json lists ONLY live members (excludes left_at)
    const membersJson = JSON.parse(await run(["channel", "members", "design", "--json"])) as {
      slug: string;
      members: Array<{ kind: string; id: string; name: string | null }>;
    };
    assert.equal(membersJson.slug, "design");
    assert.deepEqual(
      membersJson.members.map((m) => `${m.kind}:${m.id}`),
      [`user:${USER_A}`, `agent:${AGENT_A}`],
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
