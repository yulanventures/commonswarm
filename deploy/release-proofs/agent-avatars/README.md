Phase 2, version 20261015000001. Prepared from main 7a9d3878. Only the
three new tables and the new view are changed by the migration.

HezLead owns release approval and Anvil runs deploy/RELEASE-TO-BOX.md.
No release, CI dispatch, or production query was performed by this lane.

With writes paused, retain `20261015000001-backfill-counts.sql` before apply.
Its agent/person/unknown counts partition model_rows. Run the catalog proof
in the apply transaction and the functional proof immediately after apply,
before new edge writes. The functional proof is a backfill proof, not an
ongoing production health query. Actual historical coverage is not measured
on the Mac mini; retain the counts and reconcile all three branches at release.

The reserve rollback is `20261015000001-rollback.sql`, verbatim, through the
reviewed schema-correction procedure. Stop writers, export all three tables,
then execute it in one transaction with the rollback catalog proof. Preserve
immutable events and the migration ledger. A reapply after use needs a reviewed
restore/replay. CI's `tests/p1-server/agent-avatars.test.ts` executes the exact
up/proof/down files and checks that the old identity schema/view are unchanged.
That database verification is pending CI; static preparation is not execution.

The bucket and signing are phase 3. Upload begin returns a private bucket/key
contract only. A declaration reports pending processing; it keeps the prior
picture until completion. An undeclared upload is never runnable. Phase 3 must
retain quarantine objects until jobs are terminal, then perform safe cleanup.

`completeAgentAvatarJob` in the command module is a trusted internal port,
modeled on the existing hosted management port. Its service actor has all three
envelope identity fields null and is permitted only for completion. It locks
the workspace stream, as ordinary workspace commands do, before reading generation and projecting
the completion/refusal. No public validator or MCP tool accepts completion.
Worker authentication/transport is pending HezLead's decision in phase 3.

The operator core gate is ctx.operatorAllowed. The main edge adapter supplies
false; no support allowlist or cross-workspace routing is invented here.

At identity v1 3c415572, migration 20261006000004:459 builds app.client_id;
:462 gates the summary by workspace membership; :490-491 expose app to members.
The current main base lacks that summary. app_host and verified_family are
NULL in this lane. `agent-avatars.test.ts` records the pending agreement test;
when identity v1 and directory reviews are ready, define host extraction and
assert it agrees with app.client_id without changing whoami or MCP tools.
