# Item M brief: a crashed `cswarm mcp connect` recovers its seat (2026-09-25)

Written by CSwarmDevLead. Order (Strategist, 2026-09-24): after L. MCP release 2 shipped connect fail-closed and named
recovery as item M (`docs/design/2026-09-24-MCP-RELEASE-2-BRIEF.md:39`, `:59`; `docs/evidence/2026-09-24-mcp-release2/LANDING.md:41`).
Base: origin/main 5d603b8e. **Client only: the server already supports it.**

## What is true today (mapped read-only)

- `connectMcp` (`src/cloud/mcp-connect.ts`) checks the TTY, the URL and the profile path, creates the profile
  directory, refuses an occupied path (a `profile.json` OR a `credential.json`), reads the code at a hidden prompt,
  then POSTs `h0/register {joinCredential, attemptId: randomUUID(), name}` once. The `attemptId` is never stored. After
  the request is sent, any failure reports `register_outcome_unknown`: "The seat may have been created. Ask the operator
  to revoke it with cswarm principal revoke and issue a new code." `saveAgentProfile` then writes `credential.json` and
  `profile.json` as two separate atomic files.
- Crash windows: (a) the server commits and the client never saves anything, so one seat is stranded and the code is
  used; (b) `credential.json` is written and `profile.json` is not, and a rerun refuses the path as occupied; (c) a
  `kill -9` after `mkdir` leaves an empty directory.
- Server (`registerAgentSeat`, `supabase/functions/command/index.ts`; tables `swarm.agent_join_attempts` with PK
  `(join_credential_id, attempt_id)`): a register with the SAME code and the SAME `attemptId` while the seat's token is
  still unused revokes that unused token and returns the SAME principal and run with a FRESH token
  (`replaceUnusedRegistrationToken`; test `tests/p1-server/agent-join-credential.test.ts` "registration retry recovers
  only an unused token and never stores a secret"). Once the token was used, the same retry is refused
  (`registration_token_already_used`). A new `attemptId` on a used one-seat code is refused
  (`join_credential_seat_cap_reached`). No endpoint re-sends an issued token.

## Decisions

1. **A pending record before the request.** Before the register POST, connect writes `connect-pending.json` (0600) in
   the profile's 0700 directory: `attemptId`, the target URL, the agent name, an HMAC-SHA256 of the code keyed with the
   `attemptId` (so it never equals the server's stored credential hash; it only lets a rerun check that the same code
   was typed; the code itself is never written),
   and when it was created. It holds no secret.
2. **Rerun recovers.** When `mcp connect` finds a pending record for that profile path, it says it is resuming an
   interrupted connect, asks for the code at the same hidden prompt, and:
   - same code (hash matches): POSTs register with the SAME `attemptId`. The server returns the same seat with a fresh
     token (the old one was never used, so nothing a model saw is revoked). Connect then writes the files and deletes
     the pending record;
   - a different code: refuses, says the earlier interrupted connect may have stranded a seat for the earlier code,
     and tells the operator to revoke it (the same revoke sentence as today) and to delete the pending record with a
     named command before a fresh connect;
   - `registration_token_already_used` on the retry: someone used that seat's token; refuse with today's revoke
     advice; keep the pending record until the operator clears it.
   - an expired code (1 hour): the typed refusal says the code expired and the stranded seat must be revoked.
3. **The occupied-path rule changes only for this case.** A directory with a pending record and a `credential.json`
   but no `profile.json` is an interrupted connect, not an occupied path. Any other occupied state is refused as today.
   The files are written in this order: credential, profile, then the pending record is removed; a crash anywhere
   leaves a state the rerun recognizes.
4. **The Strategist's conditions stay true:** connect still refuses without a TTY; the code is still single-use (a
   recovery re-registers the SAME seat; it never creates a second one); the printed lines still name the profile path
   only. `register_outcome_unknown`'s sentence now says to run the same `cswarm mcp connect` command again with the
   same code (recovery), and only then, if that fails, to revoke. Generate every sentence from constants.
5. **No server change.** If measurement shows the server cannot do this, stop and report the evidence in LANE.md.

## Tests (each must fail when its fix is reverted; record the measured mutation)

- Stdio/CLI tests with a stateful fake register endpoint: a crash (a thrown save, a truncated response, a killed child
  process) after the server committed, then a rerun with the same code, gives one seat (the fake counts seats), a
  working profile, and no pending record. The second POST carries the same `attemptId`.
- A different code on rerun: refused before any POST; the message names the revoke step and the clear command.
- `registration_token_already_used` and an expired code on the retry: typed refusals, no files written.
- The pending record never contains the code or a token (a test greps the file and all output for `swm_join_` and
  `swm_agt_`); its mode is 0600 in a 0700 directory.
- A server test (the lead runs it on the local stack): the real `h0/register` retry with the same `attemptId` after a
  simulated lost response returns the same principal and a different token, and the first token is revoked.

## Gates

`npm run build`; `env -u FORCE_COLOR npm test`; `env -u FORCE_COLOR npm run test:p1-cli`; `npm run check:tests`;
`npm run check:edge`; `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js`;
`bash scripts/build-release.sh` (check its exit code); `npm --prefix site run build`;
`git diff --check origin/main...HEAD`. Server tests run on the lead's local stack.

## Deferred

Recovery after the code's 1-hour expiry (the server refuses; the operator revokes); recovery on a different host.
