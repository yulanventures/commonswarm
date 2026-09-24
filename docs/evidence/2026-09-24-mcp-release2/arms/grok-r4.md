I'll review this lane read-only against the Fold 3 rulings. First I'm reading the ruling record and the diff from `057c79cb` to `094d9563`.HEAD is `094d9563`. Next I’ll read the fold-3 diff and derive the refusal sets from the command and H0 handlers.The fold-3 diff is in. I’ll derive the refusal sets from `registerAgentSeat` and the H0 handlers, then match them to the client sentences and tests.No findings. Fold 3 at `094d9563` matches M1–M5. The connect sentences stay inside what `registerAgentSeat` and the H0 handlers prove, and each ruling’s test fails when that fix is reverted.

## M1

These refusals can still come back after this credential already has a seat, because they return before the attempt lookup and before the seat insert at `supabase/functions/command/index.ts:6380`:

- `forbidden` — unknown, revoked, or expired (`:5970-5980`), and also when the owner’s membership is missing or revoked after that check has passed (`:5988-5995`)
- `invalid_request` (`:6008`, `:6049`, `:6053`)
- `upgrade_required` (`:6055-6059`)
- `principal_limit_reached` (`:6210-6228`), only when `seats_used < seat_cap`. `seat_cap` is at least 1 (`:723`), so a cap of 2–10 can already have seats

What proves a seat already exists is only these three, and only these three:

- `registration_token_already_used` and `registration_seat_revoked` require an existing attempt row (`:6135-6174`)
- `join_credential_seat_cap_reached` requires `seats_used >= seat_cap` (`:6190-6207`), so at least one seat was consumed

`method_not_allowed` and `payload_too_large` are returned by H0 forward before the command runs (`supabase/functions/h0/forward.ts:115`, `:124`). `not_found` is the agent-document router when the path is not a register route (`supabase/functions/h0/core.ts:266-267`, `supabase/functions/h0/index.ts:72-81`). Those calls never insert a seat. `command_id_conflict` (`command/index.ts:6094`) is in neither set and keeps the uncertain revoke sentence.

`REGISTER_NO_SEAT_THIS_ATTEMPT` is generated from those handlers (`scripts/generate-mcp-register-refusals.mjs:26-38`). `node scripts/generate-mcp-register-refusals.mjs --check` passed. The client sentences are the ruling’s sentences (`src/cloud/mcp-connect.ts:196-201`). Each one says this attempt created no seat. None says the code was not used. A repo search of the connect sources finds that phrase only in the negative test at `tests/p1-cli/mcp-connect.test.ts:260`.

Putting “The code was not used” back into the forbidden sentence fails the exact-remedy test and the redeemed-then-forbidden test. Renaming the generated export fails the generator test.

## M2–M5

M2. The version check again owns the release-update instruction, the npm fallback stays on the installer sentence, and the gateway name matches the setup guide (`site/src/components/connect/agent-prompt.ts:42-48`; `src/onboarding-cli.ts:53`). The length tests in the same file passed. Reverting either sentence fails `agent-prompt.observer.test.ts:183`.

M3. Directory removal cannot replace the revoke sentence: the `finally` swallows every removal error (`src/cloud/mcp-connect.ts:231-236`). Restoring the old rethrow makes the committed-502 test return `EACCES` instead of `register_outcome_unknown` (`tests/p1-cli/mcp-connect.test.ts:460`). SIGINT and SIGTERM remove only a directory this run created, after a device and inode match, and before `exit` (`src/cloud/mcp-connect.ts:74-79`, `:145-150`). Removing that call leaves the new directory in place at exit (`tests/p1-cli/mcp-connect.test.ts:476`). An existing directory is left alone. LANE.md’s L8 row now says the same thing.

M4. The register abort timer is `src/cloud/mcp-connect.ts:167`. `scripts/timeout-table/mapping.json:3165` cites that line. Pointing the citation at line 146 fails `tests/p1-cli/timeout-table.test.ts:139`, because line 146 is `if (!createdInfo) return`.

M5. The exact-both-directions inventory measures `v0.1.71` and `HEAD` only (`tests/p1-cli/timeout-table.test.ts:56-58`). LANE.md records that Fold 2 dropped the real `main` enumeration because, before merge, `main` lacks the MCP rows. Deleting that sentence fails `tests/p1-cli/timeout-table.test.ts:148`.

## What else was checked

Fold 3 changes nine files: the client, the generator and its output, the prompt and its test, the timeout map and its test, and `LANE.md`. `git diff 86a938f3..094d9563` has no `supabase/` or `deploy/` files. `git diff --check 057c79cb..094d9563` is clean. Removed assertions were replaced with stricter ones: exact remedy text, and a ban on “was not used”.

After `npm run build`, `tests/p1-cli/mcp-connect.test.ts` passed 22/22. The prompt file and `timeout-table.test.ts` passed, including the citation and disclosure tests. Every run used a temporary `HOME` and loopback URLs. No production host was contacted.

VERDICT: PASS
