import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isReviewCheckCommandKind,
  parseReviewCheckCommand,
  reviewCheckReplayFields,
  storedReviewCheckConversationId,
} from "../supabase/functions/command/review-checks.ts";
import {
  isReviewCheckReadResource,
  parseReviewCheckReadRequest,
} from "../supabase/functions/read/review-checks.ts";
import {
  renderReviewCheck,
  resolveReviewCheckSeats,
  type ReviewCheckRecord,
} from "../src/cloud/review-checks.js";
import { parseSubjectSelector } from "../src/cli/review-checks.js";
import { STDIO_MCP_TOOLS } from "../src/mcp/tools.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CHECK_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONV_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_ID = "22222222-2222-4222-8222-222222222222";
const SHA_1 = "80035223af57448b46aff4e77d58aee3f34758c1";

test("review check command parser validates open and stamp wire shapes strictly", () => {
  assert.equal(isReviewCheckCommandKind("review_check_open"), true);
  assert.equal(isReviewCheckCommandKind("review_check_stamp"), true);
  assert.equal(isReviewCheckCommandKind("post_signal"), false);

  const openOk = parseReviewCheckCommand({
    kind: "review_check_open",
    subject_repo: " yulanventures/commonswarm ",
    subject_ref: " 698 ",
    head_sha: SHA_1.toUpperCase(),
    required_seats: [
      { kind: "agent", id: AGENT_A.toUpperCase() },
      { kind: "agent", id: AGENT_A },
      { kind: "user", id: USER_1 },
    ],
    conversation_id: CONV_ID,
    thread_root_id: ROOT_ID,
  });
  assert.equal(openOk.ok, true);
  if (openOk.ok && openOk.command.kind === "review_check_open") {
    assert.equal(openOk.command.subject_repo, "yulanventures/commonswarm");
    assert.equal(openOk.command.subject_ref, "698");
    assert.equal(openOk.command.head_sha, SHA_1);
    assert.deepEqual(openOk.command.required_seats, [
      { kind: "agent", id: AGENT_A },
      { kind: "user", id: USER_1 },
    ]);
    assert.equal(openOk.command.conversation_id, CONV_ID);
    assert.equal(openOk.command.thread_root_id, ROOT_ID);
  }

  // Extra keys, bad SHA, empty seats are refused.
  assert.equal(parseReviewCheckCommand({
    kind: "review_check_open",
    subject_repo: "yulanventures/commonswarm",
    subject_ref: "698",
    head_sha: "not-hex!",
    required_seats: [{ kind: "agent", id: AGENT_A }],
  }).ok, false);
  assert.equal(parseReviewCheckCommand({
    kind: "review_check_open",
    subject_repo: "yulanventures/commonswarm",
    subject_ref: "698",
    head_sha: SHA_1,
    required_seats: [],
  }).ok, false);
  assert.equal(parseReviewCheckCommand({
    kind: "review_check_open",
    subject_repo: "yulanventures/commonswarm",
    subject_ref: "698",
    head_sha: SHA_1,
    required_seats: [{ kind: "agent", id: AGENT_A }],
    unexpected: true,
  }).ok, false);

  const stampOk = parseReviewCheckCommand({
    kind: "review_check_stamp",
    check_id: CHECK_ID.toUpperCase(),
    head_sha: SHA_1,
    verdict: "pass",
    note: "  All checks green  ",
  });
  assert.equal(stampOk.ok, true);
  if (stampOk.ok && stampOk.command.kind === "review_check_stamp") {
    assert.equal(stampOk.command.check_id, CHECK_ID);
    assert.equal(stampOk.command.verdict, "pass");
    assert.equal(stampOk.command.note, "All checks green");
  }

  // Cannot pass seat_id on stamp (derived strictly from caller identity).
  assert.equal(parseReviewCheckCommand({
    kind: "review_check_stamp",
    check_id: CHECK_ID,
    head_sha: SHA_1,
    verdict: "pass",
    seat_id: AGENT_B,
  }).ok, false);
  assert.equal(parseReviewCheckCommand({
    kind: "review_check_stamp",
    check_id: CHECK_ID,
    head_sha: SHA_1,
    verdict: "approve",
  }).ok, false);
});

test("review check read parser enforces workspace_id, paired subject fields, and limit bounds", () => {
  assert.equal(isReviewCheckReadResource("review_checks"), true);
  assert.equal(isReviewCheckReadResource("signals"), false);

  const bySubject = parseReviewCheckReadRequest({
    resource: "review_checks",
    workspace_id: WS.toUpperCase(),
    subject_repo: "yulanventures/commonswarm",
    subject_ref: "698",
  });
  assert.ok(bySubject);
  assert.equal(bySubject.workspace_id, WS);
  assert.equal(bySubject.subject_repo, "yulanventures/commonswarm");
  assert.equal(bySubject.subject_ref, "698");

  // Unpaired subject_repo without subject_ref refused.
  assert.equal(parseReviewCheckReadRequest({
    resource: "review_checks",
    workspace_id: WS,
    subject_repo: "yulanventures/commonswarm",
  }), null);
  assert.equal(parseReviewCheckReadRequest({
    resource: "review_checks",
    workspace_id: WS,
    limit: 51,
  }), null);
  assert.equal(parseReviewCheckReadRequest({
    resource: "review_checks",
    workspace_id: WS,
    unknown: 1,
  }), null);
});

test("replay helpers preserve review_check fields and extract conversation_id", () => {
  const stored = {
    ok: true,
    review_check: { check_id: CHECK_ID, conversation_id: CONV_ID },
    satisfied_now: true,
    satisfied_signal_id: ROOT_ID,
  };
  assert.equal(storedReviewCheckConversationId(stored), CONV_ID);
  assert.deepEqual(reviewCheckReplayFields(stored), {
    review_check: { check_id: CHECK_ID, conversation_id: CONV_ID },
    satisfied_now: true,
    satisfied_signal_id: ROOT_ID,
  });
  assert.deepEqual(reviewCheckReplayFields({ ok: true, event_ids: [] }), {});
});

test("seat resolver, subject parser, and renderer handle names, UUIDs, and stale stamps", () => {
  const seats = resolveReviewCheckSeats(
    ["@Lead", `agent:${AGENT_B}`, USER_1],
    {
      agents: [
        { principal_id: AGENT_A, name: "Lead" },
        { principal_id: AGENT_B, name: "Sec" },
      ],
      members: [{ user_id: USER_1, display_name: "Owner" }],
    },
  );
  assert.deepEqual(seats, [
    { kind: "agent", id: AGENT_A },
    { kind: "agent", id: AGENT_B },
    { kind: "user", id: USER_1 },
  ]);
  assert.throws(() => resolveReviewCheckSeats(["MissingSeat"], { agents: [], members: [] }), {
    name: "ReviewCheckError",
  });
  assert.deepEqual(parseSubjectSelector("yulanventures/commonswarm#698", undefined, undefined), {
    repo: "yulanventures/commonswarm",
    ref: "698",
  });
  assert.deepEqual(parseSubjectSelector(undefined, "yulanventures/commonswarm", "#701"), {
    repo: "yulanventures/commonswarm",
    ref: "701",
  });

  const sample: ReviewCheckRecord = {
    check_id: CHECK_ID,
    workspace_id: WS,
    subject: { kind: "pr", repo: "yulanventures/commonswarm", ref: "698" },
    head_sha: "bbbbbbbbbbbb",
    conversation_id: CONV_ID,
    thread_root_id: ROOT_ID,
    required_seats: [
      { kind: "agent", id: AGENT_A, name: "Lead" },
      { kind: "agent", id: AGENT_B, name: "Sec" },
    ],
    stamps: [
      {
        seat_kind: "agent",
        seat_id: AGENT_A,
        name: "Lead",
        verdict: "pass",
        head_sha: "aaaaaaaaaaaa",
        note: "old head",
        stamped_at: "2026-11-20T12:00:00Z",
        stale: true,
        effective_verdict: "pending",
      },
      {
        seat_kind: "agent",
        seat_id: AGENT_B,
        name: "Sec",
        verdict: "hold",
        head_sha: "bbbbbbbbbbbb",
        note: "needs test",
        stamped_at: "2026-11-20T12:05:00Z",
        stale: false,
        effective_verdict: "hold",
      },
    ],
    status: "hold",
    satisfied: false,
    satisfied_head_sha: null,
    satisfied_signal_id: null,
    satisfied_at: null,
    created_by: { kind: "agent", id: AGENT_A },
    created_at: "2026-11-20T12:00:00Z",
    updated_at: "2026-11-20T12:05:00Z",
  };
  const rendered = renderReviewCheck(sample);
  assert.match(rendered, /yulanventures\/commonswarm#698 @ bbbbbbbbb \[hold\]/);
  assert.match(rendered, /Lead: pending \(stale pass @ aaaaaaaaa\)/);
  assert.match(rendered, /Sec: hold - needs test/);
});

test("C3 migration invariants and stdio MCP tool catalog registration", () => {
  const sql = readFileSync("supabase/migrations/20261120000005_review_checks.sql", "utf8");
  assert.match(sql, /ALTER TABLE swarm\.review_checks ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE swarm\.review_check_stamps ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE swarm\.review_checks FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /REFERENCES swarm\.(workspaces|conversations|signals|memberships|agent_principals)/);
  assert.match(sql, /satisfied_head_sha IS DISTINCT FROM v_check\.head_sha/);
  assert.match(sql, /FOR UPDATE;/);

  const toolNames = STDIO_MCP_TOOLS.map((tool) => tool.name);
  assert.ok(toolNames.includes("review_check_open"), "STDIO_MCP_TOOLS includes review_check_open");
  assert.ok(toolNames.includes("review_check_stamp"), "STDIO_MCP_TOOLS includes review_check_stamp");
  assert.ok(toolNames.includes("review_check_status"), "STDIO_MCP_TOOLS includes review_check_status");
});
