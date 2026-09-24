I'll review fold 1 against rulings K1–K11 without changing the tree. First I'm reading the lead's rulings, the lane record, and both diffs.HEAD is `f8328f83`. Next I’ll read the fold record and the connect, refusal, and test code the rulings name.The seat-cap refusal is still described as an unused code. A second connect, after the server has already created a seat, tells the operator the code was not used, so the live seat is left in place.

## PRODUCTION

**K2 and K7.** `join_credential_seat_cap_reached`, `registration_token_already_used`, and `registration_seat_revoked` are treated as proof the code was not used. The server returns them only after a seat exists.

`src/cloud/mcp-connect.ts:174-178` sends every generated refusal except three special cases through one sentence:

```174:178:src/cloud/mcp-connect.ts
      if (typeof errorCode === "string" && REGISTER_REFUSALS[errorCode] === response.status) {
        const message = errorCode === "upgrade_required" ? "Update cswarm and run mcp connect again; the code was not used."
          : errorCode === "principal_limit_reached" ? "The workspace has no free agent seat. Ask the operator to revoke a principal. The code was not used."
          : errorCode === "not_found" || errorCode === "method_not_allowed" ? "Check --url; the code was not used."
          : "The code was not used. Ask the operator for a new code.";
```

The catch at `src/cloud/mcp-connect.ts:203-206` rethrows those `McpConnectError`s, so they never become `register_outcome_unknown`.

Seat cap is the normal second connect. The server reaches it only when `seats_used` is already at the cap, and that counter is incremented only when a seat is inserted:

```6190:6204:supabase/functions/command/index.ts
  if (credential.seats_used >= credential.seat_cap) {
    return await refuseRegistrationDomain(
      ...
      409,
      "join_credential_seat_cap_reached",
      "join_credential_seat_cap_reached",
      "This join credential has no seats left. Mint a new join credential or revoke a seat.",
```

`registration_token_already_used` is returned when `first_used_at` is set (`supabase/functions/command/index.ts:6135-6149`). Its own text is "Revoke that seat and register again" (`supabase/functions/command/registration-conflicts.ts:2-5`). `registration_seat_revoked` is an existing attempt whose seat was later revoked (`supabase/functions/command/index.ts:6152-6173`). Revoke does not decrease `seats_used`.

The test locks the false sentence in. `tests/p1-cli/mcp-connect.test.ts:212` expects `join_credential_seat_cap_reached` with message `"The code was not used. Ask the operator for a new code."` Changing that message to the revoke sentence fails this test. The typed-remedy loop at `tests/p1-cli/mcp-connect.test.ts:221-227` only requires `/new code/` for seat cap.

A lost response correctly says to revoke. Retrying the same code then says the code was not used. The operator mints again and leaves the principal in place.

`upgrade_required`, `principal_limit_reached`, `forbidden`, `invalid_request`, `payload_too_large`, `not_found`, and the register handler's pre-body `method_not_allowed` really are unused. Those sentences match the server. Network errors, 5xx, bad bodies, save failures, and the profile race do end in the revoke sentence (`src/cloud/mcp-connect.ts:161-164`, `203-206`; tests at `mcp-connect.test.ts:291-348`).

## RIGOUR

**K6.** The signal handler does restore echo and then exit (`src/cloud/mcp-connect.ts:74-76`), but the test does not fail if that call is removed. After emitting `SIGINT` or `SIGTERM`, `tests/p1-cli/mcp-connect.test.ts:141-150` calls `input.end()`. The `finally` at `src/cloud/mcp-connect.ts:89-91` then calls `restore()` again, so `echoes` is still `[false, true]`. EOF, empty input, a write error, and `stty` failure are guarded. The handler's own restore is not. On a real signal, `process.exit` does not run that `finally`.

**K10.** `docs/evidence/2026-09-24-mcp-release2/LANE.md:14` still says every registration refusal uses "Ask the operator for a new code." That is no longer what `upgrade_required`, `principal_limit_reached`, `not_found`, or `register_outcome_unknown` say.

## What holds

K1: `src/cli.ts:687-688` prints only the name before `=`. `"code=swm_join_SECRET".split("=", 1)` is `["code"]`. The three-command test at `tests/p1-cli/mcp-connect.test.ts:49-57` rejects stdout and stderr that contain `swm_join_` or `swm_agt_`. Connect errors use fixed sentences. A profile path containing `swm_join_` or `swm_agt_` is refused before any error that includes the path (`src/cloud/mcp-connect.ts:128`). `--body-file` and credential-directory errors still include a filesystem path; those are not the join code.

K3, K4, K5, K8, K9, and K11 match the rulings, and their tests call the code they name. The site warning on the result panel is true for that screen (`site/src/components/connect/AgentConnect.astro:210-211`). No lane claim says an agent cannot pipe the code. The fold's site assertions got stricter, not looser. `mcp code` printing the one-time code is the product; connect's rendered install text does not include it.

VERDICT: FAIL
