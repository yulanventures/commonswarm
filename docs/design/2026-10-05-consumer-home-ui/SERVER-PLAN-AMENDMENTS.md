# SERVER-PLAN amendments, round 1 (CSwarm Lead, 2026-10-05 ~21:50Z)

Refute round 1 (Codex gpt-6.1-sol, Cursor Composer 2.5, Cursor Grok 4.6; all read-only): 3 x FAIL.
Reports: ~/work/cswarm-vision/home-ui/lanes/plan-refute/{codex,composer,cursor-grok}.txt.
These amendments override SERVER-PLAN.md where they differ. Every server lane reads both.

## Blocking findings and their answers
AM1 (Codex B1, "now" bypasses human-only steering). Front-of-line placement is steering. `start:'now'` on
    todo_create/todo_assign takes effect ONLY for a HUMAN credential (no agent principal) of the assignee agent's owner.
    From any agent credential (including the owner's other agents) or any other person, `now` becomes an OFFER decided
    by the owner (same as SERVER-PLAN C "others asking now"). An agent credential may assign to an agent only at the
    back of its line or with a gate, and only when that agent's accepts_from allows it; otherwise it is an offer.
    `household_todo_steer` stays human-only. Tests: an approved agent of the owner assigning `now` to a sibling agent
    gets an offer, not a front placement (with a positive control: the owner's human credential does reorder).
AM2 (Codex B2, local CLI/MCP adapters). New lane L6 owns the local adapters: src/cloud/household-http.ts (new write
    kinds), src/cloud/household-objects.ts or a new src/cloud/household-todos.ts (decoders for to-do/comment/queue
    results; no blob revision required for to-dos), src/mcp/household-tools.ts, and the CLI wiring in src/cli.ts that
    the registry drives. L6 runs after L4 and proves a local round trip in a test (create -> assign -> queue -> start
    -> done) against an injected transport.
AM3 (Codex B3, queue response size). Lists and the queue return SUMMARIES, never notes or comments:
    TodoSummary = { todo_id, version, title, state, due_on, assignee, offer (without gate note), gate kind + clear,
    queue_position, comment_count, state_at }. todo_queue takes `section?: 'working'|'up_next'|'not_yet'|'requests'`,
    `offset`, `limit <= 50` and returns per-section `next_offset`; todo_list limit <= 50. Details come only from
    todo_read (one to-do, comments paged at <= 20). Every read response is checked against a 48 KiB budget in the store
    and truncates the page (setting next_offset) before it can exceed the hosted MCP limit; a test builds a worst case
    (200 items, 200-char multibyte titles) and asserts every page < 48 KiB. contract.ts changes accordingly (Lead edits
    contract.ts; L5 maps to it).
AM4 (Cursor Grok B1, L2 cannot typecheck before L4). Re-sequence and re-own the generation step:
    L1 (pure core) -> L2 owns: migration 000001 + reserve/proofs + supabase/functions/command/household-todos.ts store
    + the export line in src/protocol/index.ts + scripts/build-admin-types.mjs roots/count + the regenerated
    supabase/functions/_shared/*.d.ts and protocol.js (npm run build:command-core). L3 runs IN PARALLEL with L2 and owns
    ONLY migration 000002 (overview SQL) + its reserve/proofs + the pure proofs test (no TypeScript store).
    household-activity.ts moves to L4. L4 runs after L2 and L3 merge. L6 after L4.

## Non-blocking findings folded in
AM5 (Codex 5) The to-do events table mirrors the household stream's envelope integrity checks (JSON object shape,
    payload workspace_id/seq/event_id equal to their columns), as 20261004000002:12.
AM6 (Codex 4) "Last looked" = max first-seen receipt counts only NEW MESSAGES reliably. Catch up shows "N new messages
    since you last looked" (messages only); to-do/object activity is listed as "Latest", not counted as new.
AM7 (Cursor Grok 3) Grants: events/comments/receipts get SELECT, INSERT for swarm_command (the catalog proof is the
    spec), unlike household_object_events (INSERT only).
AM8 (Cursor Grok 4) home_overview is VOLATILE and evaluates gates with statement_timestamp().
AM9 (Cursor Grok 5) Offers: CHECK (offer_user IS NULL OR offer_principal IS NULL) and exactly one of them when offer_id
    is set.
AM10 (Composer B1) Not a conflict: HomeServer.startTodo is the HUMAN site client and always names todo_id; the agent
    registry tool todo_start may omit it (take the first of its own up_next). Both stay.
AM11 (Codex 6) Every lane names each new test file in its report; the Lead alone registers them in tests/lists/* and
    package.json.
AM12 (Cursor Grok NB1) A working-on post is itself a recent action. Accepted, because the UI words it as the agent's
    own statement ("Said it’s working on ‘X’ · 2 minutes ago") and it lapses after 30 minutes without another action.
Citation slips reported by Composer/Cursor Grok (wrong line numbers) change no design; lanes verify lines themselves.
