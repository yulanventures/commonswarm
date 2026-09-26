# Item M follow-ups (non-blocking under the 2026-09-26 landing bar)

Landing bar (lead ruling, 2026-09-26): a finding blocks a landing only if it is PRODUCTION, the lead verifies it on
the branch, and it is in the brief's scope or introduced by the lane. Pre-existing defects on main and RIGOUR items
come here.

1. **Fold 19, ready for its own review:** branch `lane/item-m-fold19` at c8b6f845 (commits c8cf3f76, c8b6f845), built
   on 49c6eefd. AK1: the exclusive fallback claim gets fchmod 0600 at once, and a recognized empty own claim is
   repaired (Codex round 19 item 2, Opus round 19 item 2). AK2: the default scan classifies each `mcp-*` directory
   before reading its pending record (Opus round 19 item 1). AK3: the partial-clear sentence, contained HOME setup in
   tests, HOME for the two default-route refusal tests (Opus round 19 items 3, 4, 6). Needs: merge with main, a
   review scoped to its delta, and gates through scripts/run-gates.sh.
2. **Pre-existing on main, owned by lane 2b:** `src/cloud/storage.ts` generic lock creates the lock before writing its
   owner, so a crash in that window makes a retry within 30 s time out with the wrong lock name (Codex rounds 18-19
   item 1, Opus round 19 item 7). Lane 2b's lock module replaces this code.
3. **Opus round 19 item 5, CLOSED at landing:** the home control used `--test-isolation=none`, and GitHub Actions
   (Node 22.23.2) measured that Node 22 rejects it. Fixed by `86446769` (AS1): the control passes the name the running
   node's `--help` lists. Node 22 is not runnable on the mini, so that path is proven only by the help text rule.
4. **Server suite at b4cbfb0a in GitHub Actions (run 36212518314, 2026-09-26): 262 of 265.** None of the three is
   from item M. M changes no file under `supabase/`, `src/protocol/` or the edge functions. The import graph of both
   failing test files (`src/cloud/files.ts`, `src/cloud/config.ts`, `src/h0/verbs.ts` and what they import) reaches
   none of the files M changes (measured with a static import walk). Main baseline, same workflow, main `54900214`
   (run 36214115638): 262 of 264, failing item L and h0 subtest 12 exactly as below, so both are pre-existing on
   main; F7 passed on main, so its one failure in M's run is a flake (the edge answered 500 once on a replay):
   - F7 (`tests/p1-server/file-artifacts.test.ts:876`): "accepted result replays", 500 !== 200. The edge returned 500
     when the same command id was retried after the cause was fixed.
   - h0 poll and ack, subtest 12 (`tests/p1-server/h0-poll-ack.test.ts:966`): "an aborted waiting poll frees the slot
     for another seat", null !== 0. Same class as the concurrency flakes ruled at 9627cb37.
   - item L (`derived ids replay one live version and upsert-off Storage refuses a second PUT`): the test deep-equals
     Storage's 409 body, and Storage from supabase CLI 2.118.0 adds `code: 'KeyAlreadyExists'`. Known stack
     difference; the test pin needs a fix on main.
