I'll review the lane as a read-only check against L1–L8 and the fold-2 record, starting with the rulings and the diff from `f8328f83` to `057c79cb`.HEAD is `057c79cb`. Next I’ll read the fold-2 diff and the server refusal paths so the two CLI sets can be checked against the source.The fold-2 diff is in. I’ll derive the seat-existence codes from the command and H0 handlers, then match them to the CLI sets and the new tests.The three codes that can be returned only after a seat exists match the client set, and their sentence matches the ruling. The seven-code "not used" set does not: several of those responses are still returned when a seat already exists, and the client still says the code was not used.

## Findings

### 1. PRODUCTION — "The code was not used" is still false for refusals the server can return after a seat exists

`registerAgentSeat` returns `forbidden` before it reads attempts or `seats_used`. An expired credential, a revoked credential, and a missing owner membership all take this path, including after a seat was inserted:

```5970:5980:supabase/functions/command/index.ts
  if (
    credential === null || credential.revoked_at !== null ||
    credential.unexpired !== true
  ) {
    // ...
    return { status: 403, body: { error: "forbidden" } };
  }
```

`upgrade_required` and `invalid_request` are the same shape: the credential is already locked and may already have seats, and the return is still before `const attemptRows` (`supabase/functions/command/index.ts:6008`, `:6049-6059`). `mcp code` uses `ttl_hours: 1`, so a connect that succeeded is a `403 forbidden` an hour later.

`principal_limit_reached` is only reached when `seats_used < seat_cap` (`supabase/functions/command/index.ts:6190-6228`). `seat_cap` is 1..10 (`supabase/functions/command/index.ts:723-724`) and `seats_used` starts at 0 and increments only with the seat insert (`:6380-6388`, `:6645`). For `seat_cap` 1 this means no seat. For `seat_cap` 2..10 it is returned with seats already created. Connect redeems any join code.

`method_not_allowed` and `payload_too_large` are returned before the body is parsed (`supabase/functions/h0/forward.ts:115`, `:124`). `not_found` is the agent-document router (`supabase/functions/h0/core.ts:266-267`). None of those loads the join credential.

What can occur only after a seat exists is exactly these three, and only these three:

- `registration_token_already_used` — existing attempt, `first_used_at` set, or the replacement fence lost (`supabase/functions/command/index.ts:6135-6150`, `:5835-5850`)
- `registration_seat_revoked` — existing attempt whose token, principal, run, or grant is dead (`:6152-6174`)
- `join_credential_seat_cap_reached` — `seats_used >= seat_cap` and `seat_cap >= 1` (`:6190-6207`)

`REGISTER_EXISTING_SEAT_REFUSALS` is those three, and the sentence at `src/cloud/mcp-connect.ts:183` is the ruling's sentence. `command_id_conflict` is in neither set (`src/cloud/mcp-register-refusals.ts:3`, `:15-27`). That part holds.

The unused set is the other seven, and every one of them is told the code was not used:

```180:184:src/cloud/mcp-connect.ts
          const message = errorCode === "upgrade_required" ? "Update cswarm and run mcp connect again; the code was not used."
            : errorCode === "principal_limit_reached" ? "The workspace has no free agent seat. Ask the operator to revoke a principal. The code was not used."
            : errorCode === "not_found" || errorCode === "method_not_allowed" ? "Check --url; the code was not used."
            : REGISTER_EXISTING_SEAT_REFUSALS[errorCode] === response.status ? "This code was already used. ..."
            : "The code was not used. Ask the operator for a new code.";
```

`forbidden`, `invalid_request`, and `payload_too_large` take the last line. A used code that has expired gets `[forbidden] The code was not used. Ask the operator for a new code.` The seat stays up.

The generator builds that set by taking every `error: "..."` before `const attemptRows`, deleting `command_id_conflict`, then force-adding `principal_limit_reached`, `method_not_allowed`, `payload_too_large`, and `not_found` (`scripts/generate-mcp-register-refusals.mjs:26-32`). Being before the attempt query means the handler did not look, which is how a used credential still gets `forbidden`.

The test requires that classification. `tests/p1-cli/mcp-connect.test.ts:60-61` expects those seven keys in `REGISTER_UNUSED_REFUSALS`. `:246-248` requires `/The code was not used/` for every code outside the existing-seat set. Moving `forbidden` off that sentence fails the test. The same pattern as the seat-cap pin in round 2.

### 2. RIGOUR — a kept fallback shortening tells the agent to report a bad release on the normal installer path

The base sentence attached "otherwise" to the version check:

`The installer reuses a matching build. If its host is blocked, use npm install -g commonswarm. Confirm cswarm setup --check-version returns setup_version 1; otherwise report that the release needs updating.`

The retained text moves that otherwise onto the host check:

```42:43:site/src/components/connect/agent-prompt.ts
    "Confirm cswarm setup --check-version returns setup_version 1.",
    "The installer reuses a matching build. If its host is blocked, use npm install -g commonswarm; otherwise report that the release needs updating.",
```

When the installer host is reachable, this sentence says to report that the release needs updating. The npm fallback is still there. The failure instruction for `setup_version` 1 is gone.

The same paragraph also says wake "works with … Grok Bot". The setup guide still says "the local Grok Bot gateway" (`src/onboarding-cli.ts:53`). The base prompt said "the local Grok Bot gateway" too.

`docs/evidence/2026-09-24-mcp-release2/LANE.md:104` lists the installer sentence as a required shortening. `site/src/components/connect/agent-prompt.observer.test.ts:188-189` asserts the prompt and `LANE.md` contain it verbatim, so correcting the otherwise fails the test. The other four listed shortenings are the ones in the base diff, and they are listed.

### 3. RIGOUR — Ctrl-C still leaves the profile directory this run created

The directory is created before the prompt:

```132:135:src/cloud/mcp-connect.ts
  const profileDir = dirname(path);
  const createdDirectory = (await mkdir(profileDir, { recursive: true, mode: 0o700 })) !== undefined;
  const createdInfo = createdDirectory ? await lstat(profileDir) : null;
```

Cleanup is an async `finally` that `rmdir`s that directory when it is still empty (`src/cloud/mcp-connect.ts:214-222`). SIGINT/SIGTERM restore echo and then exit:

```74:76:src/cloud/mcp-connect.ts
  const interrupted = (status: number) => { try { restore(); } finally { removeSignals(); terminal.exit(status); } };
  function onInterrupt() { interrupted(130); }
  function onTerminate() { interrupted(143); }
```

`terminal.exit` is `process.exit` (`src/cloud/mcp-connect.ts:64`). That ends the process before the async `finally` runs, so the empty `0700` directory remains. A thrown `readCode` and a `forbidden` response do remove a directory created in this run, and a directory that already existed is left in place (`tests/p1-cli/mcp-connect.test.ts:415-432`). The test's "cancelled" case is `throw new Error("cancelled")` (`:420`), so deleting the `finally` fails that test, and removing the signal path's cleanup does not.

The signal handler's own echo restore is guarded: `tests/p1-cli/mcp-connect.test.ts:158-161` asserts `[false, true]` and the exit status before `input.end()`.

### 4. RIGOUR — the register abort-timer citation points at the wrong line

Fold 2 moved `setTimeout`. The enumerator places it at line 151 (`src/cloud/mcp-connect.ts:151`). The map still says line 146, which is now the empty-code check (`src/cloud/mcp-connect.ts:146`):

```3165:3166:scripts/timeout-table/mapping.json
          "citation": "src/cloud/mcp-connect.ts:146",
          "detail": "Abort timer for the H0 register POST.",
```

`validateMapping` checks row ids, not citation lines, so this stays green. The `main` → `HEAD` alias itself resolves: on this commit's tree, `mappingForRef(mapping, "main")` includes `MCP_REGISTER_TIMEOUT_MS`, `setTimeout`, and `timeout`, and `validateMapping` passes. The fold-1 omit section fails that check with `missing=[src/cloud/mcp-connect.ts:MCP_REGISTER_TIMEOUT_MS, src/cloud/mcp-connect.ts:setTimeout, src/cloud/mcp-connect.ts:timeout]`.

The bundle-SHA gate is gone (`tests/p1-cli/mcp-connect.test.ts:398-399`). `LANE.md` records the old hash as the build in one folder at `f8328f83`. A known refusal at the wrong HTTP status becomes `register_outcome_unknown` (`tests/p1-cli/mcp-connect.test.ts:404-411`), which fails if the status comparison is removed. `mcp code` / `mcp connect` generic failures use `mcp_code_failed` and `mcp_connect_failed`; serve keeps `mcp_start_failed` (`src/cli.ts:9811-9821`). The dispatch fixture is 1,330 rows, 0 added, 0 removed, 11 stderr-label changes, none of them serve. Refusal text is fixed sentences, and a profile path containing `swm_join_` or `swm_agt_` is still refused before `mkdir` (`src/cloud/mcp-connect.ts:128`). The fold-2 diff is those client, test, mapping, and evidence files.

VERDICT: FAIL
