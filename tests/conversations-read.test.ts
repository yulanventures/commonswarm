/**
 * Unit tests for Conversations Step 2b read parser, browser contract parity,
 * SQL migration/rollback invariants, and local stdio MCP tool exposure.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONVERSATION_READ_RESOURCES,
  isConversationOversightResource,
  isConversationReadResource,
  parseConversationReadRequest,
} from "../supabase/functions/read/conversations.ts";
import {
  buildConversationHistoryRequest,
  buildListConversationsRequest,
  buildOversightHistoryRequest,
  buildOversightListRequest,
} from "../site/src/lib/conversations.ts";
import { MCP_TOOLS, STDIO_MCP_TOOLS } from "../src/mcp/tools.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SIG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("parseConversationReadRequest accepts every browser builder payload and normalizes UUIDs", () => {
  const listReq = buildListConversationsRequest(WS.toUpperCase(), true);
  assert.deepEqual(parseConversationReadRequest(listReq), {
    resource: "conversations",
    workspace_id: WS,
    include_archived: true,
  });

  const histReq = buildConversationHistoryRequest(WS.toUpperCase(), CONV.toUpperCase(), {
    before: { createdAt: "2026-11-19T12:00:00.000Z", id: SIG.toUpperCase() },
    limit: 25,
    includeMentions: true,
    includeReactions: true,
  });
  assert.deepEqual(parseConversationReadRequest(histReq), {
    resource: "conversation_history",
    workspace_id: WS,
    conversation_id: CONV,
    before_created_at: "2026-11-19T12:00:00.000Z",
    before_id: SIG,
    after_created_at: null,
    after_id: null,
    limit: 25,
    include_mentions: true,
    include_reactions: true,
  });

  const overList = buildOversightListRequest(WS.toUpperCase(), AGENT.toUpperCase());
  assert.deepEqual(parseConversationReadRequest(overList), {
    resource: "conversation_oversight",
    workspace_id: WS,
    agent_principal_id: AGENT,
  });

  const overHist = buildOversightHistoryRequest(WS.toUpperCase(), CONV.toUpperCase(), AGENT.toUpperCase(), {
    after: { createdAt: "2026-11-19T12:05:00.000Z", id: SIG.toUpperCase() },
  });
  assert.deepEqual(parseConversationReadRequest(overHist), {
    resource: "conversation_oversight_history",
    workspace_id: WS,
    conversation_id: CONV,
    agent_principal_id: AGENT,
    before_created_at: null,
    before_id: null,
    after_created_at: "2026-11-19T12:05:00.000Z",
    after_id: SIG,
    limit: 50,
    include_mentions: false,
    include_reactions: false,
  });
});

test("parseConversationReadRequest rejects half-cursors, both before+after, bad limits, and unknown keys", () => {
  // Half cursors
  assert.equal(
    parseConversationReadRequest({
      resource: "conversation_history",
      workspace_id: WS,
      conversation_id: CONV,
      before_created_at: "2026-11-19T12:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    parseConversationReadRequest({
      resource: "conversation_history",
      workspace_id: WS,
      conversation_id: CONV,
      after_id: SIG,
    }),
    null,
  );
  // Both before and after non-null
  assert.equal(
    parseConversationReadRequest({
      resource: "conversation_history",
      workspace_id: WS,
      conversation_id: CONV,
      before_created_at: "2026-11-19T12:00:00.000Z",
      before_id: SIG,
      after_created_at: "2026-11-19T12:01:00.000Z",
      after_id: SIG,
    }),
    null,
  );
  // Limit bounds
  assert.equal(
    parseConversationReadRequest({ resource: "conversation_history", workspace_id: WS, conversation_id: CONV, limit: 0 }),
    null,
  );
  assert.equal(
    parseConversationReadRequest({ resource: "conversation_history", workspace_id: WS, conversation_id: CONV, limit: 101 }),
    null,
  );
  // Unknown keys
  assert.equal(
    parseConversationReadRequest({ resource: "conversations", workspace_id: WS, extra: true }),
    null,
  );
  assert.equal(
    parseConversationReadRequest({ resource: "conversation_oversight", workspace_id: WS, agent_principal_id: AGENT, extra: 1 }),
    null,
  );
  // Resource helpers
  for (const r of CONVERSATION_READ_RESOURCES) {
    assert.equal(isConversationReadResource(r), true);
  }
  assert.equal(isConversationOversightResource("conversation_oversight"), true);
  assert.equal(isConversationOversightResource("conversation_oversight_history"), true);
  assert.equal(isConversationOversightResource("conversations"), false);
  assert.equal(isConversationOversightResource("conversation_history"), false);
});

test("Step 2b migration and rollback enforce least-privilege swarm_read grants, V4 C2 oversight gates, and clean rollback", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20261120000001_conversations_reads.sql", import.meta.url),
    "utf8",
  );
  const rollback = readFileSync(
    new URL("../deploy/release-proofs/conversations-2b/20261120000001-rollback.sql", import.meta.url),
    "utf8",
  );

  // Least-privilege grants: swarm_read only for read functions, swarm_command only for conversation_thread_root.
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*swarm_read\.conversations\(uuid, boolean\)[\s\S]*TO swarm_read;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*swarm\.conversation_thread_root\(uuid, uuid, uuid\)[\s\S]*TO swarm_command;/);
  assert.doesNotMatch(migration, /TO authenticated;/, "read functions stay behind /functions/v1/read (swarm_read only)");

  // V4 C2 oversight invariants: human-only claim check, left_at denial, and dm/group_dm scope.
  assert.match(migration, /v_claims \? 'agent_principal_id'/);
  assert.match(migration, /hm\.left_at IS NOT NULL/);
  assert.match(migration, /c\.kind IN \('dm', 'group_dm'\)/);

  // Rollback drops every added function and restores Step 2a route/filer functions.
  for (const fn of [
    "swarm_read.conversation_oversight_history",
    "swarm_read.conversation_oversight",
    "swarm_read.conversation_history",
    "swarm_read.conversations",
    "swarm.conversation_thread_root",
    "swarm.conversation_history_page",
    "swarm.conversation_summary_json",
    "swarm.conversation_members_json",
    "swarm.conversation_signal_visible_to",
    "swarm.conversation_oversight_actor",
    "swarm.conversation_read_actor",
  ]) {
    assert.ok(rollback.includes(`DROP FUNCTION IF EXISTS ${fn}`), `rollback must drop ${fn}`);
  }
  assert.match(rollback, /CREATE OR REPLACE FUNCTION swarm\.conversation_check_route/);
  assert.match(rollback, /CREATE OR REPLACE FUNCTION swarm\.file_conversation_signal/);
});

test("STDIO_MCP_TOOLS exposes Step 2b local conversation tools while hosted MCP_TOOLS stays frozen", () => {
  const stdioNames = STDIO_MCP_TOOLS.map((t) => t.name);
  for (const name of [
    "conversations_list",
    "conversation_read",
    "conversation_open",
    "conversation_join",
    "conversation_leave",
    "conversation_mark_read",
  ]) {
    assert.ok(stdioNames.includes(name), `STDIO_MCP_TOOLS includes ${name}`);
    assert.ok(!MCP_TOOLS.some((t) => t.name === name), `hosted MCP_TOOLS must NOT include ${name}`);
  }
});
