Fold 2 on item H release 2 (option A) in the CommonSwarm repo, branch lane/mcp-connect at f8328f83. Spec:
docs/design/2026-09-24-MCP-RELEASE-2-BRIEF.md; your fold-1 rulings are in LANE.md "Fold 1". Both round-2 arms FAILED;
both reviews are pasted at the end. Implement EVERY ruling, each with a test that fails when the fix is reverted, and
record them in docs/evidence/2026-09-24-mcp-release2/LANE.md under "Fold 2". Read AGENTS.md first.

HARD RULES: as for fold 1 — no production host; never run a cswarm command without a loopback --url (it contacts
commonswarm.com); no supabase, vercel, ssh; no real workspace; do not touch ~/.cswarm or ~/.config/cswarm; NO server,
edge or migration change; every test has a timeout; no process survives. Commit yourself: subject "fix(mcp): ..." /
"test(mcp): ...", trailers exactly (one per line): Agent-Name: Yulan Bot / Agent-Model: <your model id> /
Agent-Family: openai / Agent-Tool: codex <version> / Agent-Model-Source: runtime-ambiguous.

RULINGS
L1 (Opus 1, PRODUCTION). Remove the test that pins the release-bundle SHA in LANE.md: the bundle contains paths
   relative to node_modules, so its SHA depends on where the checkout sits and the test fails outside your folder.
   LANE.md may record a SHA only as "the SHA of the build in <folder> at <commit>", never as a gate.
L2 (Opus 2, Grok, PRODUCTION). "The code was not used" must be true. The server returns
   join_credential_seat_cap_reached, registration_token_already_used and registration_seat_revoked only after a seat
   exists (supabase/functions/command/index.ts ~6135-6204). For those, say: "This code was already used. If you did not
   use it, someone else may have: tell the operator to revoke that agent and issue a new code." Split the generated
   refusal set into "the code was not used" (upgrade_required, principal_limit_reached, forbidden, invalid_request,
   payload_too_large, not_found, method_not_allowed — verify each against the server) and "a seat exists", both derived
   from the server source, with a test that fails if a code is in the wrong set. Fix the test that pins the false
   sentence (mcp-connect.test.ts ~212, ~221-227).
L3 (Opus 3, PRODUCTION). The timeout mapping must survive the merge: restore the `main -> HEAD` alias the lane replaced
   (read the timeout-table source and tests), with the three new rows reachable from it. Add a test that simulates the
   post-merge state (the mapping resolved on a ref where main == HEAD) and fails on the fold-1 form.
L4 (Grok K6). The signal test must fail if the signal handler's own echo restore is removed: after the signal, do not
   let the prompt's finally run (assert on the handler's restore alone, e.g. stub process.exit and assert the restore
   happened before it). Mutation recorded.
L5 (Opus 4). The check that a typed refusal code arrives with its expected HTTP status needs a test (the one mutation
   not caught). Mutation recorded.
L6 (Opus, Grok K10). LANE.md: every remedy sentence claimed matches the code after L2; restore the five agent-facing
   sentences the lane shortened in the fallback prompt unless the shortening was required, and if kept, list them.
L7 (Opus). Errors from `mcp code` and `mcp connect` carry their own code, not `[mcp_start_failed]` (that label is for
   `mcp` serve start-up). Test.
L8 (Opus). A cancelled or refused prompt removes the profile directory it created in this run if it is still empty;
   it never removes a directory it did not create. Test both.
NOT IN SCOPE (lead ruling): an unknown COMMAND name is still echoed ("unknown command: x"); a command name is not an
option value and the echo helps a person.

GATES (exit code and counts): npm run build ; env -u FORCE_COLOR npm test ; env -u FORCE_COLOR npm run test:p1-cli ;
npm run check:tests ; bash scripts/build-release.sh ; npm --prefix site run build ; env -u FORCE_COLOR npm --prefix site
test ; git diff --check origin/main...HEAD. Name sandbox EPERM (ps) failures.

REPORT: commit SHAs; each ruling -> change -> test -> mutation; gates; not established.

===== OPUS REVIEW (round 2) =====
# Checker review round 2 (Claude Opus arm): lane/mcp-connect at f8328f83 (fold 1 on da5fa657)

Setup: I archived f8328f83 into `opus-probes/lane2` and built it (`npm run build` exit 0). Mutations ran on a separate
archive, `opus-probes/mut2`. For the timeout-table check I used a local `git clone --shared` with its remote removed
(`opus-probes/clone`). Every probe used loopback fakes (`harness/fake.mjs`, `harness/redir.mjs`), a temporary HOME, and
`CSWARM_SITE=http://127.0.0.1:9`. Every cswarm command I ran had a loopback `--url`. I contacted no production host this
round. I changed no tracked file and made no commit, and no process of mine is still running.

Severity key: **PRODUCTION** means the lane must not land or release until this is fixed. **RIGOUR** means a claim,
control or piece of evidence is wrong or missing.

## What fold 1 fixed (measured)

- **K2 stranded seats.** Each case below ended with `register_outcome_unknown` and "The seat may have been created. Ask
  the operator to revoke it with cswarm principal revoke and issue a new code." Each case also had register calls = 1 and
  no secret in the pty transcript or in any file other than the 0600 credential:
  - 5xx, and 502 with an HTML body
  - 200 with a non-JSON body
  - a truncated 200 body
  - 200 with `status` other than accepted
  - 200 missing a field
  - a malformed token
  - a hostile `error` field
  - 401, 429
  - 500 carrying `{"error":"forbidden"}`
  - 200 carrying a refusal code

  In-process (`harness/inproc/probe.mts`), the losing racer, a parent made read-only between the prompt and the save,
  and an injected EIO on the profile write all gave the same sentence. After the EIO, the credential.json left behind is
  0600, `readAgentProfile` refuses it, and a rerun is refused before the prompt.
- **Refused before the prompt**, with no `Connect code:` printed and 0 register calls: an existing 0755 directory, a
  read-only parent, `…/credential.json`, `…/Credential.JSON`, and a symlinked directory. A cleartext non-loopback URL
  (`http://example.invalid`, `http://10.0.0.1`) gives `connect_url_invalid` before the read and before any fetch.
- **K1.** `--code=<S>`, `--agent-token-file=<S>`, `--body=<S>`, `--url=<S>` and `--workspace-id=<S>`, on `mcp connect`,
  `whoami`, `ask`, `status` and `mcp code`, print only `invalid option: --<name>`. The secret appears 0 times. Secrets
  passed in `--profile`, `--name` and `--url` paths, and in `--workspace-id` as a separate value, are not echoed either.
- **K5.** A plain pipe, `/dev/null` and a closed stdin are refused before the read (0 register calls). `script -q
  /dev/null` still redeems the code. The error sentence, the code comment and LANE.md now say exactly this.
- **K6, in a real pty** (echo state read from `stty -a` on the same pty):
  - Ctrl-D and an empty line: `code_missing`, exit 1, echo on.
  - Ctrl-C at an empty prompt, and Ctrl-C after partial input: exit 130, echo on.
  - SIGTERM: exit 143, echo on.
  - A code with spaces around it: accepted after trimming.

  A missing `stty` is refused before the prompt. The injected-terminal unit test covers the handlers.
- **K8.** A 308 to another origin gives `register_redirected`. The second origin got no request.
- **K9.** `renderMcpCode` prints `On the agent host run: cswarm mcp connect --url <url> --anon-key <key>`. Connect
  without `--anon-key` gives `connect_anon_key_required` "Pass --anon-key for this URL on the agent host." on a fresh
  host, with only `SWARM_CLOUD_ANON_KEY` set, and with a saved target for another URL. A saved target for the same URL
  is used.
- **K4.** The site test failure list is now identical to base (512 tests, 105 fail, all built-page or browser
  environment failures). Neither test was weakened: `workspace-entry` keeps `/Generate prompt/` and adds `/Connect with
  MCP/`, and `access-lifecycle` asserts the new, longer sentence. The npm fallback is back. The Codex TOML in the site
  prompt is valid.
- **K11.** I diffed the fixtures from da5fa657 to f8328f83: 12 rows changed and none were added or removed. The
  `serve` rows now reach serve (`unknown option: --json` from serve's shape check, or exit 0). The refusal row reaches
  the refusal.
- **Mutations** (`opus-probes/mutate2.py`, against `tests/p1-cli/mcp-connect.test.ts`, source restored and checked with
  `cmp`): 14 of the 15 were CAUGHT. They are N1 redirect follow, N2 outer catch pass-through, N3 no directory preflight,
  N4 no credential.json refusal, N5 no SIGTERM handler, N6 handler not removed, N7 no trim, N8 code in the invalid-code
  error, N9 token in an invalid-seat error, N11 EOF resolving to empty, N12 echo-off after the prompt, N14 a 5xx code in
  the refusal table, N15 a raw save error, and N13 (see finding 2). N10 was NOT CAUGHT (finding 4).

## Findings

### 1. PRODUCTION — the new evidence test fails in every checkout except the Maker's, so `test:p1-cli` goes red

`tests/p1-cli/mcp-connect.test.ts:370-379`
```ts
  const checksum = (await readFile("dist-release/cswarm.sha256", "utf8")).split(/\s+/)[0];
  ...
  assert.ok(lane.includes(checksum), "LANE must name the current built bundle SHA");
```
The bundle is not position-independent. The esbuild output holds relative paths from the checkout to the real path of
`node_modules`: `grep` finds 410 matches such as `../../../../../../../../../Users/yulanbot/Developer/Ridge.io/cloud-swarm/node_modules/zod/...`.
So the SHA depends on where the checkout sits. At exactly f8328f83, `bash scripts/build-release.sh` gives
`3c3d4543096da75bb3b2901b8edcb1dc160a2433e859f749d86cb3767f1d43d5` (the same on two builds). LANE.md names
`ae2926…`. Results:
- The test fails with no `dist-release`, because the file is missing.
- The test fails after a fresh build-release.
- `npm run test:p1-cli` at f8328f83 has 913 tests, 13 fail. The one failure added against base is this test.

The test will also fail on `main` after any later source change, because LANE.md is a historical record. It also
races with `release-bundle.test.ts`, which runs `rm -rf dist-release` while the suite runs files in parallel. This is a
test between a generated artifact and a document that repeats it (memory "tests must compare something independent").
Fix: remove the SHA assertion, or check only that LANE.md names a 64-hex SHA. Record the SHA as a measured fact, not as
a gate.

### 2. PRODUCTION — "The code was not used" is false for a code that was already used, and a test pins the false sentence

`src/cloud/mcp-connect.ts:174-179`. Every entry in `REGISTER_REFUSALS` that is not an upgrade, a principal-limit or a
routing code gets "The code was not used. Ask the operator for a new code." Measured: a second connect with a consumed
code gets `409 join_credential_seat_cap_reached`, and the CLI prints `[join_credential_seat_cap_reached] The code was not
used. Ask the operator for a new code.` The seat cap means the code **was** used and made a seat. This is the brief's
"second connect with the same code" case. It is also the only signal a person gets when someone else redeemed a leaked
code first, and the CLI tells them the opposite. The same sentence is unprovable for:
- `forbidden`: the server sends it for expired and revoked codes too, whether or not they were redeemed.
- `registration_token_already_used` and `registration_seat_revoked`: these exist only because the attempt ran before.

`tests/p1-cli/mcp-connect.test.ts:212` asserts `message: "The code was not used. Ask the operator for a new code."`
for the seat-cap case. Mutation N13, which makes the seat-cap message say the code was already used, is "CAUGHT"
because the test defends the false claim. This is the exact case in AGENTS.md "Claim controls prove stability, not
truth".

What each code proves is "this attempt created no seat". Fix: for the whole set, say "No seat was created by this
attempt." For `join_credential_seat_cap_reached`, say: "This code was already used to create a seat. If that was not
you, ask the operator to check the workspace's agents and revoke unknown ones, then issue a new code." Change the test
to match.

### 3. PRODUCTION — the timeout mapping passes before the merge and fails on `main` after it

`scripts/timeout-table/mapping.json`: the lane replaced `"aliases": {"main": "HEAD"}` with a `main` section. That
section inherits `HEAD` and omits the three new `mcp-connect.ts` rows (the `inherits`/`omit` support is new in
`mapping.mjs:17-25`). `timeout-table.test.ts:58-61` enumerates the real `main` ref. I measured it in the local clone,
running `--test-name-pattern "exact in both directions"`:

| `main` points at | mapping | result |
|---|---|---|
| 86a938f3 (before the merge) | f8328f83 | pass 1 |
| f8328f83 (after a fast-forward merge) | f8328f83 | **fail 1**: `missing=[src/cloud/mcp-connect.ts:MCP_REGISTER_TIMEOUT_MS, …:setTimeout, …:timeout]` |
| f8328f83 | f8328f83 with the `main→HEAD` alias restored | pass 1 (control) |

When this lane lands, `test:p1-cli` goes red on `main` and on every lane branched from it, in any checkout with `.git`.
The omission list says "main lacks these rows", which becomes false at the merge. Fix: restore the alias, and accept
that the test fails on the branch until the merge. Or have the landing step delete the `main` section in the same merge
commit, and write that step down.

### 4. RIGOUR — the status-match guard has no control

`mcp-connect.ts:174` `REGISTER_REFUSALS[errorCode] === response.status`. Measured: the code works. A 500 carrying
`{"error":"forbidden"}` gives "may have been created", and a 200 carrying a refusal code gives the same. Mutation N10
(`errorCode in REGISTER_REFUSALS`) was **NOT CAUGHT**, so no test covers a known code arriving with the wrong status.
Add one test: a 500 with a known refusal code must give `register_outcome_unknown`.

### 5. RIGOUR — the fallback prompt was reworded beyond the ruling, and LANE.md does not say so

`site/src/components/connect/agent-prompt.ts:37-49`. To stay within the prompt-length budget after restoring the npm
sentence, five other agent-facing sentences were shortened:
- "Run the setup command for this host with --json. Use the returned --profile…" became "Run setup --json. Reuse its --profile…".
- "the local Grok Bot gateway" became "Grok Bot".
- "shell commands" became "commands".

These look equivalent in meaning, but the agent follows this text. LANE.md reports only the restored npm sentence. List
the reworded sentences in LANE.md, or keep the originals.

### 6. RIGOUR, carried from round 1 and not in the fold-1 rulings

- Errors that are not `AgentSetupError` from `mcp code` and `mcp connect` are still labelled `[mcp_start_failed]`, for
  example `credential directory must be mode 0700 …` and `EACCES … mkdir`. Both now happen before the prompt, so they
  are safe. The label is still wrong, because no server was started.
- `cswarm <positional>` still echoes a positional: `unknown command: <S>`. K1 covered only option values, and this
  echoes a positional, not an option value.
- A cancelled prompt leaves an empty 0700 profile directory behind, because the preflight creates it. This is harmless.
- `register_redirected` uses the "may have been created" sentence. That is conservative, and acceptable, because the
  code did reach the host that redirected.

## Gates (loopback, temporary HOME)

| Gate | base 86a938f3 | f8328f83 | failure-set diff |
|---|---|---|---|
| `npm test` | 962 / 2 fail | 962 / 2 fail | identical (this archive has no `.git`) |
| `npm run test:p1-cli` | 896 / 12 fail | 913 / 13 fail | **+1: "Fold 1 evidence … current bundle hash" (finding 1)** |
| `npm run check:tests` | — | exit 0 | — |
| `npm --prefix site test` | 511 / 105 fail | 512 / 105 fail | identical |
| `bash scripts/build-release.sh` | — | exit 0, SHA `3c3d4543…` (location-dependent) | — |
| timeout-table, `main` after the merge (clone) | — | fail | finding 3 |

## Not established

- Live H0 register and read/post against production, fresh Codex and Claude Code MCP sessions, and transcripts: the
  release control is still owed.
- Whether `cswarm principal revoke --principal-id` works on an H0 seat. The revoke sentence depends on it, and the person
  at the agent host has no principal id to pass on.
- Whether the 10 s register budget fits production.
- I did not run `mcp code` end to end with a human session. I checked `renderMcpCode` directly and ran the unit test.

VERDICT: FAIL

===== GROK REVIEW (round 2) =====
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
