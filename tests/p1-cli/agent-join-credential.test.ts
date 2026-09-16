/**
 * Pure controls for H0 join credentials. Reached by test:p1-cli's glob.
 */
import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { redactCredentialText } from "../../src/host/credential-redaction.js";
import {
  decideWorkspace,
  HUMAN_ONLY_COMMANDS,
  type DecideWorkspaceCtx,
  type WorkspaceCommand,
} from "../../src/protocol/workspace-commands.js";

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260916000001_agent_join_credentials.sql",
);

function agentContext(): DecideWorkspaceCtx {
  return {
    now: Date.now(),
    actor: {
      user: "00000000-0000-4000-8000-000000000001",
      agent_principal: "00000000-0000-4000-8000-000000000002",
      run: "00000000-0000-4000-8000-000000000003",
    },
    credential_kind: "agent",
    presenting_token_id: "00000000-0000-4000-8000-000000000004",
    command_id: "join-control-1",
    workspace_id: "00000000-0000-4000-8000-000000000005",
    stream_id: "00000000-0000-4000-8000-000000000006",
    operatorAllowed: () => false,
    role: () => "owner",
    inviteeAlreadyMember: () => false,
    identityVerified: () => true,
    humanRights: () => [],
    landingAuthorityChangeResolved: () => true,
    nextSeq: () => 1,
    nextEventId: () => "00000000-0000-4000-8000-000000000007",
  };
}

test("join mint and revoke are human-only in the pure authority core", () => {
  const commands: WorkspaceCommand[] = [
    { kind: "mint_agent_join_credential", seat_cap: 3, ttl_hours: 4 },
    {
      kind: "revoke_agent_join_credential",
      join_credential_id: "00000000-0000-4000-8000-000000000008",
    },
  ];
  for (const command of commands) {
    assert.equal(HUMAN_ONLY_COMMANDS.has(command.kind), true);
    const decision = decideWorkspace(null, command, agentContext());
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.class, "authz");
      assert.equal(decision.reason, "credential_kind_forbidden");
    }
  }
});

test("swm_join_ secrets are removed by the shared host redactor", () => {
  const secret = `swm_join_${"J".repeat(43)}`;
  const redacted = redactCredentialText(`register with ${secret} now`);
  assert.equal(redacted, "register with [redacted-credential] now");
  assert.doesNotMatch(redacted, /swm_join_/i);
});

test("the schema holds a digest and separate locator with database bounds", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS swarm\.agent_join_credentials/);
  assert.match(sql, /credential_hash bytea NOT NULL UNIQUE/);
  assert.match(sql, /octet_length\(credential_hash\) = 32/);
  assert.match(sql, /locator text NOT NULL UNIQUE/);
  assert.match(sql, /seat_cap BETWEEN 1 AND 10/);
  assert.match(sql, /seats_used BETWEEN 0 AND seat_cap/);
  assert.match(sql, /expires_at <= created_at \+ interval '24 hours'/);
  assert.match(
    sql,
    /REVOKE ALL ON TABLE swarm\.agent_join_credentials FROM PUBLIC, anon, authenticated/,
  );
  assert.match(sql, /registrar_principal_id = p\.principal_id/);
});

test("every principal-ceiling count takes the workspace lock first, in the one shared helper", () => {
  /* WHY THIS IS STRUCTURAL. A server test fires six concurrent mints with room for one and expects
   * exactly one to succeed. With the lock REMOVED that test still passed 16/16 locally: the local edge
   * runtime does not interleave those transactions, so the race it guards against never happens there.
   * A control that cannot fail proves nothing about the lock, so the lock is pinned here instead:
   *  - the helper takes pg_advisory_xact_lock BEFORE its count;
   *  - it is the ONLY place in the command edge that counts swarm.agent_principals, so no ceiling
   *    check can bypass it (enumerated by AST: one such count exists);
   *  - all three ceiling checks call it: credential mint, seat registration,
   *    and ordinary principal creation. */
  const path = new URL("../../supabase/functions/command/index.ts", import.meta.url);
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const enclosingFunction = (node: ts.Node): string => {
    let parent: ts.Node | undefined = node.parent;
    while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
    return parent && ts.isFunctionDeclaration(parent) && parent.name ? parent.name.text : "<top>";
  };
  const helper = "lockAndCountLivePrincipals";
  const counts: { at: number; fn: string }[] = [];
  const locks: { at: number; fn: string }[] = [];
  let helperCalls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      const text = node.template.getText(file);
      /* ANY count form, not only `count(*)`: an arm noted a new inline ceiling check written as
       * `count(1)` or `count(p.principal_id)` would have slipped past the one-count rule. */
      if (/\bcount\s*\(/i.test(text) && /swarm\.agent_principals/.test(text)) {
        counts.push({ at: node.getStart(file), fn: enclosingFunction(node) });
      }
      if (/pg_advisory_xact_lock/.test(text) && /principal-ceiling/.test(text)) {
        locks.push({ at: node.getStart(file), fn: enclosingFunction(node) });
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === helper) {
      helperCalls++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  assert.equal(counts.length, 1, `principal counts in the command edge: ${counts.length}`);
  assert.equal(counts[0]!.fn, helper, "the only principal count must live in the shared helper");
  assert.equal(locks.length, 1, "exactly one principal-ceiling lock");
  assert.equal(locks[0]!.fn, helper, "the lock must be taken inside the helper");
  assert.ok(locks[0]!.at < counts[0]!.at, "the lock must be taken BEFORE the count");
  assert.equal(
    helperCalls,
    3,
    "all ceiling checks — join mint, seat registration, and create_agent_principal — use it",
  );
});
