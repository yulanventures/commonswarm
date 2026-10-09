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

function verifyPrincipalCeilings(source: string, routine: string): void {
  // Retained structural guard: the old concurrency positive still passed 16/16
  // with its lock removed. This enumerates SQL counts and call order independently.
  const helper = 'lockAndCountLivePrincipals', counter = 'countLiveDurablePrincipals';
  const counts: { fn: string; text: string; variable: string; file: string }[] = [];
  const locks: { at: number; fn: string }[] = [];
  const calls: { at: number; fn: string; callee: string; file: string }[] = [];
  const workspaceLocks: number[] = [];
  const enclosingFunction = (node: ts.Node): string => {
    let parent = node.parent;
    while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
    return parent?.name?.text ?? '<top>';
  };
  for (const [name, text] of [['index.ts', source], ['admin-routine.ts', routine]]) {
    const file = ts.createSourceFile(name!, text!, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        const sql = node.template.getText(file), fn = enclosingFunction(node);
        if (/\bcount\s*\(/i.test(sql) && /swarm\.agent_principals/.test(sql)) {
          let parent: ts.Node | undefined = node.parent;
          while (parent && !ts.isVariableDeclaration(parent)) parent = parent.parent;
          counts.push({ fn, text: sql, variable: parent?.name.getText(file) ?? '', file: name! });
        }
        if (/pg_advisory_xact_lock/.test(sql) && /principal-ceiling/.test(sql)) locks.push({ at: node.getStart(file), fn });
        if (name === 'admin-routine.ts' && /FROM swarm\.workspaces/.test(sql) && /FOR UPDATE/.test(sql)) workspaceLocks.push(node.getStart(file));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && [helper, counter].includes(node.expression.text)) {
        calls.push({ at: node.getStart(file), fn: enclosingFunction(node), callee: node.expression.text, file: name! });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const principalCounts = counts.filter(row => /FROM\s+swarm\.agent_principals\b/i.test(row.text));
  assert.equal(principalCounts.length, 1, 'one shared durable-principal count across both edge modules');
  assert.equal(principalCounts[0]!.fn, counter);
  assert.equal(principalCounts[0]!.file, 'admin-routine.ts');
  assert.match(principalCounts[0]!.text, /p\.identity_lifetime\s*=\s*'durable'/);
  // Phase 1 also counts active contexts and durable hosted seats. These two
  // queries JOIN principals but count their own resources, not the workspace ceiling.
  const quotaCounts = counts.filter(row => row !== principalCounts[0]);
  assert.deepEqual(quotaCounts.map(row => [row.file, row.fn, row.variable]), [
    ['index.ts', 'claimHostedSeat', '[counts]'], ['index.ts', 'claimHostedSeat', '[seatCount]'],
  ], 'only the two hosted quotas may join principals in another count');
  assert.match(quotaCounts[0]!.text, /FROM swarm\.hosted_agent_contexts/);
  assert.match(quotaCounts[1]!.text, /FROM swarm\.hosted_mcp_seats/);
  assert.equal(locks.length, 1, 'exactly one principal-ceiling advisory lock');
  assert.equal(locks[0]!.fn, helper);
  const direct = calls.filter(row => row.callee === counter);
  assert.deepEqual(direct.map(row => [row.file, row.fn]), [
    ['index.ts', helper], ['admin-routine.ts', 'prepareAdminRoutine'],
  ], 'no issuance path may bypass the shared locked helper');
  assert.ok(locks[0]!.at < direct[0]!.at, 'ceiling lock precedes shared count');
  // Option A preserves the existing admin workspace lock and its order.
  assert.equal(workspaceLocks.length, 1);
  assert.ok(workspaceLocks[0]! < direct[1]!.at, 'admin workspace lock precedes shared count');
  assert.deepEqual(calls.filter(row => row.callee === helper).map(row => row.fn), [
    'registerAgentSeat', 'mintAgentJoinCredential', 'enforceFreeTierBudget', 'claimHostedSeat',
  ], 'every hosted/local principal-creating path uses the locked helper');
}

test('every principal-ceiling count takes the workspace lock first, in the one shared helper', () => {
  const source = readFileSync(new URL('../../supabase/functions/command/index.ts', import.meta.url), 'utf8');
  const routine = readFileSync(new URL('../../supabase/functions/command/admin-routine.ts', import.meta.url), 'utf8');
  verifyPrincipalCeilings(source, routine);
  const withoutLock = source.replace("hashtext('principal-ceiling')", "hashtext('wrong-ceiling')");
  assert.notEqual(withoutLock, source, 'lock mutation reaches the real lock');
  assert.throws(() => verifyPrincipalCeilings(withoutLock, routine), /exactly one principal-ceiling advisory lock/);
  const bypass = source.replace('const livePrincipals = await lockAndCountLivePrincipals(tx, route.workspaceId);',
    'const livePrincipals = await countLiveDurablePrincipals(tx, route.workspaceId);');
  assert.notEqual(bypass, source, 'helper-bypass mutation reaches hosted issuance');
  assert.throws(() => verifyPrincipalCeilings(bypass, routine), /no issuance path may bypass/);
  const inline = source + '\nasync function unlocked(tx: any) { return tx`SELECT count(1) FROM swarm.agent_principals`; }';
  assert.throws(() => verifyPrincipalCeilings(inline, routine), /one shared durable-principal count/);
  // Target the workspace lock, retaining the preceding owner lock.
  const withoutWorkspaceLock = routine.replace(/(FROM swarm\.workspaces[^`]+)FOR UPDATE/, '$1');
  assert.notEqual(withoutWorkspaceLock, routine);
  assert.throws(() => verifyPrincipalCeilings(source, withoutWorkspaceLock));
});
