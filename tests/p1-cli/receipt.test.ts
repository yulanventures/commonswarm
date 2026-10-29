import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  DeliveryReceiptReadError,
  readAgentDeliveryReceipts,
} from "../../src/cloud/delivery-receipts.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

/* Agents are listed under broadcast_roster.agents.principals, never in
 * `receipts` — the pre-roster parser reads any non-human `receipts` row as a
 * delivery ledger row (20260902000001, folded). */

/* 100 live members, 60 seen: the capped list is 50 seen rows and 0 not-seen
 * rows, so "Not-seen members: none" would be false about 40 people. */

function wireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipient_agent_principal_id: AGENT,
    enqueued_at: "2026-08-28T12:00:00.000Z",
    delivered_at: null,
    leased_until: null,
    acked_at: null,
    ack_outcome: null,
    attempt_count: 0,
    lease_expiry_count: 0,
    last_error_code: null,
    ...overrides,
  };
}

function wireReport(
  receipts: Record<string, unknown>[],
  addressed = true,
): Record<string, unknown> {
  return {
    addressed,
    receipts,
    ...(addressed
      ? {}
      : {
        broadcast_roster: {
          members: {
            total: receipts.filter((row) => "recipient_user_id" in row).length,
            seen: receipts.filter((row) => row.seen_at !== null && "recipient_user_id" in row).length,
            returned: receipts.filter((row) => "recipient_user_id" in row).length,
            limit: 50,
            truncated: false,
          },
          agents: {
            total: 0,
            seen: 0,
            returned: 0,
            limit: 50,
            truncated: false,
            tracking_state: "not_tracked",
            principals: [],
          },
        },
      }),
  };
}

test("the client seam sends the narrow author-scoped request with the agent credential", async () => {
  const authorizations: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(wireReport([wireRow()])), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const target = cloudTarget("https://example.supabase.co", "anon");

  const fromAgent = await readAgentDeliveryReceipts(
    target,
    TOKEN,
    WORKSPACE,
    SIGNAL,
    { fetcher },
  );
  assert.equal(fromAgent.receipts.length, 1);
  assert.deepEqual(authorizations, [`Bearer ${TOKEN}`]);
  assert.deepEqual(requests, [
    { resource: "delivery_receipts", workspace_id: WORKSPACE, signal_id: SIGNAL },
  ]);
});

test("broadcast and addressed-empty responses are distinguishable and fail closed", async () => {
  const target = cloudTarget("https://example.supabase.co", "anon");
  const broadcast = await readAgentDeliveryReceipts(
    target,
    TOKEN,
    WORKSPACE,
    SIGNAL,
    { fetcher: async () => new Response(JSON.stringify(wireReport([], false))) },
  );
  assert.equal(broadcast.addressed, false);
  assert.deepEqual(broadcast.receipts, []);

  await assert.rejects(
    readAgentDeliveryReceipts(target, TOKEN, WORKSPACE, SIGNAL, {
      fetcher: async () => new Response(JSON.stringify(wireReport([], true))),
    }),
    (error: unknown) =>
      error instanceof DeliveryReceiptReadError && error.code === "protocol",
  );
  await assert.rejects(
    readAgentDeliveryReceipts(target, TOKEN, WORKSPACE, SIGNAL, {
      fetcher: async () =>
        new Response(JSON.stringify({ addressed: null, receipts: [] })),
    }),
    (error: unknown) =>
      error instanceof DeliveryReceiptReadError && error.code === "not_author",
  );
});
