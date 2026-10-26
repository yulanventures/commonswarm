import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePendingAccess, readPendingAccess } from "../../src/cloud/pending-access.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("pending parser rejects a malformed kind and does not infer identity", { timeout: 2_000 }, () => {
  const row = { kind: "classic", principal_id: PRINCIPAL, principal_name: "Wren",
    join_credential_id: null, owner_user_id: OWNER, issuer_display: "Owner",
    issued_at: "2026-09-24T12:00:00Z", expires_at: null, seats_used: null, seat_cap: null };
  const safe = parsePendingAccess({ pending: [{ ...row, credential_hash: "must-not-leak" }] });
  assert.equal(safe.length, 1);
  assert.doesNotMatch(JSON.stringify(safe), /credential_hash|must-not-leak/);
  assert.throws(() => parsePendingAccess({ pending: [{ ...row, kind: "invented" }] }), /malformed row/);
});

test("members pending read requests the workspace-scoped edge resource", { timeout: 2_000 }, async () => {
  const workspace = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  let requests = 0;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests++;
    assert.equal(String(input), "http://127.0.0.1:54321/functions/v1/read");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer fixture-bearer");
    assert.deepEqual(JSON.parse(String(init?.body)), { resource: "pending_access", workspace_id: workspace });
    return new Response(JSON.stringify({ pending: [] }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await readPendingAccess(
    { url: "http://127.0.0.1:54321", anonKey: "fixture-anon", profileId: "fixture" },
    "fixture-bearer", workspace, fetcher,
  ), []);
  assert.equal(requests, 1);
});
