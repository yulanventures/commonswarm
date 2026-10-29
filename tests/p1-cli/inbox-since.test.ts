import assert from "node:assert/strict";
import test from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { INBOX_SINCE_PAGE_CAP, readDirectedInboxSince, InboxSinceError } from "../../src/cloud/signals.js";
import { assertInboxWorkspace, inboxMoreNotice } from "../../src/cli.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const target = cloudTarget("http://127.0.0.1:9", "public-test-key");
const rows = Array.from({ length: 101 }, (_, index) => ({
  id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
  workspace_id: WORKSPACE, from: "33333333-3333-4333-8333-333333333333",
  from_kind: "user", to: null, to_agent: PRINCIPAL, in_reply_to: null,
  about: null, kind: "ask", body: `ask ${index + 1}`,
  until: "2099-01-01T00:00:00.000Z",
  created_at: new Date(Date.UTC(2026, 8, 25, 0, 0, index)).toISOString(),
  sender_owner_relation: "same_owner",
}));

test("inbox --since drains beyond the default 50 and across a full cursor page", { timeout: 10_000 }, async () => {
  const requests: Record<string, unknown>[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);
    const after = request.after_id;
    const start = after ? rows.findIndex(row => row.id === after) + 1 : 0;
    const page = rows.slice(start, start + Number(request.limit));
    return new Response(JSON.stringify({ signals: page,
      capabilities: { sender_owner_relation: 1, cursor_after: 1 } }), { status: 200 });
  }) as typeof fetch;
  const result = await readDirectedInboxSince(target, { kind: "agent", token: TOKEN }, {
    workspaceId: WORKSPACE, inbox: true, since: rows[0]!.created_at,
  }, { fetcher });
  assert.equal(result.length, 101);
  assert.equal(result[0]?.id, rows.at(-1)!.id);
  assert.equal(result.at(-1)?.id, rows[0]!.id);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.limit, 100);
  assert.equal(requests[1]?.after_id, rows[99]!.id);
  assert.equal(requests[0]?.since, rows[0]!.created_at);
});

test("wrong agent workspace is a typed refusal, not an empty inbox", { timeout: 10_000 }, () => {
  assert.doesNotThrow(() => assertInboxWorkspace(WORKSPACE, WORKSPACE));
  assert.throws(() => assertInboxWorkspace(undefined, WORKSPACE), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "inbox_workspace_mismatch");
});

test("inbox drain stops at the exact cursor and explains equal-timestamp rereads", { timeout: 10_000 }, async () => {
  assert.equal(INBOX_SINCE_PAGE_CAP, 10);
  const many = Array.from({ length: (INBOX_SINCE_PAGE_CAP + 1) * 100 }, (_, index) => ({
    ...rows[index % rows.length]!, id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    created_at: "2026-09-25T01:00:00.000Z",
  }));
  let calls = 0;
  let notice = "";
  const requests: Array<{ after_created_at?: string; after_id?: string }> = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { after_created_at?: string; after_id?: string; limit: number };
    requests.push(request);
    calls += 1;
    const start = request.after_id ? many.findIndex(row => row.id === request.after_id) + 1 : 0;
    return new Response(JSON.stringify({ signals: many.slice(start, start + request.limit),
      capabilities: { sender_owner_relation: 1, cursor_after: 1 } }), { status: 200 });
  }) as typeof fetch;
  const result = await readDirectedInboxSince(target, { kind: "agent", token: TOKEN }, {
    workspaceId: WORKSPACE, inbox: true, since: many[0]!.created_at,
  }, { fetcher, onTruncated: last => { notice = inboxMoreNotice(last, many[0]!.created_at); } });
  assert.equal(calls, INBOX_SINCE_PAGE_CAP);
  assert.equal(result.length, INBOX_SINCE_PAGE_CAP * 100);
  assert.equal(requests[1]?.after_created_at, many[99]!.created_at);
  assert.equal(requests[1]?.after_id, many[99]!.id);
  assert.match(notice, new RegExp(`Stopped after ${many[999]!.created_at} \\(id ${many[999]!.id}\\)`));
  assert.match(notice, /same --since re-reads from 2026-09-25T01:00:00.000Z, including this timestamp/);
  assert.match(notice, /cswarm inbox --follow --ndjson --since '2026-09-25T01:00:00.000Z'/);
  assert.doesNotMatch(notice, /rerun with --since 2026-/i);
  assert.match(inboxMoreNotice({ created_at: many[999]!.created_at, id: many[999]!.id }, "2026-09-24T00:00:00.000Z"),
    /same --since re-reads from 2026-09-24T00:00:00.000Z, including this timestamp/);
});

test("inbox drain paging failures are typed", { timeout: 10_000 }, async () => {
  const fetcher = (async () => new Response(JSON.stringify({ signals: [], capabilities: {} }), { status: 200 })) as typeof fetch;
  await assert.rejects(readDirectedInboxSince(target, { kind: "agent", token: TOKEN }, {
    workspaceId: WORKSPACE, inbox: true, since: rows[0]!.created_at,
  }, { fetcher }), (error: unknown) => error instanceof InboxSinceError && error.code === "inbox_paging_unsupported");
});
