import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test } from "node:test";
import ts from "typescript";
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
  const body = migration.match(/AS \$\$([\s\S]*?)\$\$;/)?.[1];
  assert.ok(body, "migration contains a function body");
  const digest = createHash("md5").update(body).digest("hex");
  assert.match(catalog, new RegExp(`md5\\(p\\.prosrc\\)\\s*=\\s*'${digest}'`));
  assert.match(functional, /IF v_count < 1 THEN RAISE EXCEPTION/);
  assert.match(functional, /SELECT count\(\*\) INTO v_count FROM swarm_read\.pending_access\(v_workspace\);\s*IF v_count <> 0 THEN/);
  assert.doesNotMatch(migration, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
});

function membersPendingCalls(source: string): string[] {
  const ast = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true);
  let members: ts.FunctionDeclaration | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "runMembers") members = node;
    ts.forEachChild(node, find);
  };
  find(ast);
  assert.ok(members?.body, "members command must exist");
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^readPendingAccess/.test(node.expression.text)) calls.push(node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(members.body);
  return calls;
}

test("the members command itself uses the nonthrowing pending read", { timeout: 2_000 }, async () => {
  const source = await readFile(new URL("../../src/cli.ts", import.meta.url), "utf8");
  const calls = membersPendingCalls(source);
  assert.deepEqual(calls, ["readPendingAccessOptional"]);
  const reverted = source.replace("const pending = await readPendingAccessOptional(",
    "const pending = await readPendingAccess(");
  assert.notEqual(reverted, source, "the mutation reaches members");
  assert.deepEqual(membersPendingCalls(reverted), ["readPendingAccess"]);
});

test("lane evidence records the local reset and every Fold 2 ruling", { timeout: 2_000 }, async () => {
  const lane = await readFile(new URL("../../docs/evidence/2026-09-24-item-j/LANE.md", import.meta.url), "utf8");
  assert.match(lane, /### Fold 1 post-apply update[\s\S]*lead ran `db:reset`[\s\S]*normal[\s\S]*1\/1 passed/);
  assert.doesNotMatch(lane, /The revised function is not installed in the lead's shared local stack/);
  const fold = lane.split("## Fold 2 — 2026-09-24")[1];
  assert.ok(fold, "Fold 2 section exists");
  for (const ruling of ["F1", "F2", "F3", "F4", "F5"]) {
    assert.match(fold, new RegExp(`\\| ${ruling} \\|`));
  }
});
