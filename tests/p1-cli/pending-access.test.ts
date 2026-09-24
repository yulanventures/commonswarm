import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parsePendingAccess, pendingAccessAge, readPendingAccess, readPendingAccessOptional } from "../../src/cloud/pending-access.js";
import { renderRoster } from "../../src/cli.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("members renders server pending entries with age and join capacity", { timeout: 2_000 }, () => {
  const pending = parsePendingAccess({ pending: [
    { kind: "classic", principal_id: PRINCIPAL, principal_name: "Wren", join_credential_id: null,
      owner_user_id: OWNER, issuer_display: "Owner", issued_at: "2026-09-24T12:00:00Z",
      expires_at: null, seats_used: null, seat_cap: null },
    { kind: "join", principal_id: null, principal_name: null, join_credential_id: JOIN,
      owner_user_id: OWNER, issuer_display: "Owner", issued_at: "2026-09-24T12:00:00Z",
      expires_at: "2026-09-25T12:00:00Z", seats_used: 1, seat_cap: 2 },
  ] });
  assert.equal(pendingAccessAge(pending[0]!.issued_at, Date.parse("2026-09-24T12:02:00Z")), "2m ago");
  const roster = renderRoster(
    { members: [{ user_id: OWNER, display_name: "Owner" }], agents: [] },
    new Map([[OWNER, "Owner"]]), undefined, pending,
  );
  assert.match(roster, /Invited, not connected:\n- Wren/);
  assert.match(roster, /Agent connect code.*1\/2 seats used/);
  assert.match(roster, /issued by Owner/);
  assert.doesNotMatch(roster, /undefined|token_hash|credential_hash|locator/);
  // Mutation control: removing the server row removes the visible invitation.
  const cleared = renderRoster(
    { members: [{ user_id: OWNER, display_name: "Owner" }], agents: [] },
    new Map([[OWNER, "Owner"]]), undefined, [],
  );
  assert.doesNotMatch(cleared, /Wren|Agent connect code/);
  const unavailable = renderRoster(
    { members: [{ user_id: OWNER, display_name: "Owner" }], agents: [] },
    new Map([[OWNER, "Owner"]]), undefined, null,
  );
  assert.match(unavailable, /People:\n- Owner/);
  assert.match(unavailable, /Invited, not connected: could not load/);
});

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

test("pending read failures reject for the members fallback to handle", { timeout: 2_000 }, async () => {
  const target = { url: "http://127.0.0.1:54321", anonKey: "fixture-anon", profileId: "fixture" };
  const workspace = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  for (const status of [404, 500]) {
    await assert.rejects(readPendingAccess(target, "fixture-bearer", workspace,
      (async () => new Response("", { status })) as typeof fetch), /pending access read failed/);
    assert.equal(await readPendingAccessOptional(target, "fixture-bearer", workspace,
      (async () => new Response("", { status })) as typeof fetch), null);
  }
  await assert.rejects(readPendingAccess(target, "fixture-bearer", workspace,
    (async () => { throw new TypeError("network unavailable"); }) as typeof fetch), /network unavailable/);
  assert.equal(await readPendingAccessOptional(target, "fixture-bearer", workspace,
    (async () => { throw new TypeError("network unavailable"); }) as typeof fetch), null);
});

test("pending migration ships section 5 proofs and no new index", { timeout: 2_000 }, async () => {
  const root = new URL("../../", import.meta.url);
  const catalog = await readFile(new URL("deploy/release-proofs/item-j/20260924000001-catalog.sql", root), "utf8");
  const functional = await readFile(new URL("deploy/release-proofs/item-j/20260924000001-functional.sql", root), "utf8");
  const migration = await readFile(new URL("supabase/migrations/20260924000001_pending_access.sql", root), "utf8");
  assert.match(catalog, /AS catalog_ok\s*\\gset\s*$/);
  assert.match(functional, /swarm_read\.pending_access/);
  assert.doesNotMatch(migration, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
});
