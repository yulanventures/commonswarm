Fold 3 on item H release 2 (option A) in the CommonSwarm repo, branch lane/mcp-connect at 057c79cb. Spec:
docs/design/2026-09-24-MCP-RELEASE-2-BRIEF.md; earlier rulings in LANE.md "Fold 1" and "Fold 2". Both round-3 arms
FAILED on the same claim; both reviews are pasted at the end. Implement EVERY ruling with a test that fails when the fix
is reverted; record them in LANE.md under "Fold 3". Read AGENTS.md first (claim controls: check each claim against what
the server does).

HARD RULES: as before — no production host; never run a cswarm command without a loopback --url; no supabase, vercel,
ssh; no real workspace; do not touch ~/.cswarm or ~/.config/cswarm; NO server, edge or migration change; every test has
a timeout; no process survives. Commit yourself: "fix(mcp): ..." / "test(mcp): ...", trailers exactly (one per line):
Agent-Name: Yulan Bot / Agent-Model: <your model id> / Agent-Family: openai / Agent-Tool: codex <version> /
Agent-Model-Source: runtime-ambiguous.

RULINGS
M1 (both arms, PRODUCTION). No message may say "the code was not used". The server proves only that THIS attempt created
   no seat: `forbidden`, `invalid_request`, `upgrade_required` and `principal_limit_reached` are returned after the
   credential is loaded but before the attempt/seat logic, so a code someone else already redeemed (and that has since
   expired or been revoked) also gets them. Rename the generated set to what it proves (e.g. REGISTER_NO_SEAT_THIS_ATTEMPT;
   keep it generated from server source, not typed) and use sentences that claim only that:
   - forbidden: "This code is unknown, expired or revoked; this attempt created no seat. Ask the operator for a new code."
   - upgrade_required: "Update cswarm and run mcp connect again; this attempt created no seat."
   - principal_limit_reached: "The workspace has no free agent seat; this attempt created no seat. Ask the operator."
   - invalid_request / payload_too_large: "The request was refused; this attempt created no seat. Ask the operator for a new code."
   - not_found / method_not_allowed (the request never reached registration): "Check --url; this attempt created no seat."
   The three seat-exists codes keep the "already used ... revoke" sentence. Update every test that pins the old words;
   add a test that no connect message contains "was not used" (mutation: putting it back fails).
M2 (Grok 2). The kept fallback-prompt shortening changed a meaning: "otherwise report that the release needs updating"
   now hangs on the installer-host check. Put it back on the version check ("Confirm cswarm setup --check-version
   returns setup_version 1; otherwise report that the release needs updating.") within the prompt limit, keep the npm
   fallback sentence, and use the same Grok Bot wording as the setup guide ("the local Grok Bot gateway"). Update the
   observer test and LANE.md's list.
M3 (Opus, Grok 3). Cleanup never throws or replaces the real error: a failure while removing the directory is ignored
   (or appended), never thrown over the revoke sentence — test with an EACCES-style failure after a committed 502. The
   signal path removes the empty directory this run created, synchronously, before exiting (never a directory it did not
   create). Correct LANE.md's L8 claim to what is true.
M4 (Grok 4). scripts/timeout-table/mapping.json cites src/cloud/mcp-connect.ts:146 for the register abort timer; the
   timer is at line 151 now. Fix the citation and add a test that this row's citation line contains the timer, so it
   cannot drift silently.
M5 (Opus). LANE.md records that the timeout test no longer checks the real `main` ref before the merge (and why), as a
   removed check.

GATES (exit code and counts): npm run build ; env -u FORCE_COLOR npm test ; env -u FORCE_COLOR npm run test:p1-cli ;
npm run check:tests ; bash scripts/build-release.sh ; npm --prefix site run build ; env -u FORCE_COLOR npm --prefix site
test ; git diff --check origin/main...HEAD. Name sandbox failures.

REPORT: commit SHAs; each ruling -> change -> test -> mutation; gates; not established.

===== OPUS REVIEW (round 3) =====
# Checker review round 3 (Claude Opus arm): lane/mcp-connect at 057c79cb (fold 2: 8e4c21f0 + 057c79cb)

Setup: I archived 057c79cb into `opus-probes/lane3` and built it (`npm run build` exit 0). Mutations ran on a separate
archive, `opus-probes/mut3`. The timeout checks ran in a local `git clone --shared` with its remote removed
(`opus-probes/clone`). Every probe used loopback fakes, a temporary HOME and `CSWARM_SITE=http://127.0.0.1:9`, and
every cswarm command had a loopback `--url`. I contacted no production host. I changed no tracked file and made no
commit. No process of mine is still running. Out of scope by lead ruling: the echo of an unknown command name.

Severity key: **PRODUCTION** means the lane must not land or release until this is fixed. **RIGOUR** means a claim,
control or piece of evidence is wrong or missing.

## What fold 2 fixed (measured)

- **L1.** The bundle-SHA gate is gone. In my folder, `mcp-connect.test.ts` passes 19 of 19, and the `test:p1-cli`
  failure list matches base except for one test that needs `.git` (see the gates below). That test passes in the clone.
- **L2, existing-seat group.** `join_credential_seat_cap_reached`, `registration_token_already_used` and
  `registration_seat_revoked` (each at 409) now print "This code was already used. If you did not use it, someone else
  may have: tell the operator to revoke that agent and issue a new code." A second connect after a lost response gets
  the seat-cap code and this sentence, which is true. When a known code arrives with the wrong status (seat-cap at 403,
  a refusal code at 200, `forbidden` at 500), connect gives the uncertain "may have been created" sentence.
  `command_id_conflict` also gives the uncertain sentence. The sets are generated, and `--check` passes.
- **L3.** In the clone, the `main→HEAD` alias is back. With `main` at 86a938f3 (before the merge) the tests pass 2 of 2.
  With `main` at 057c79cb (after a fast-forward merge) they pass 2 of 2.
- **L4, L5, L7, L8, and the earlier fixes all have working controls.** I ran 12 mutations (`opus-probes/mutate3.py`) and
  all 12 were CAUGHT:
  - L4: the signal handler without its restore.
  - L5: the status check removed.
  - L2: seat-cap told "not used", and seat-cap moved into the "not used" set.
  - L8: cleanup removing a directory that already existed, and no cleanup at all.
  - L7: the `mcp code` label reverted.
  - Earlier fixes: redirect follow, the outer catch passing errors through, the code inside the invalid-code error,
    cleanup errors thrown, and option values echoed again.

  I restored each source and checked it with `cmp`.
- **L7.** A 0755 folder gives `[mcp_connect_failed] credential directory must be mode 0700 …`. `mcp bogus` keeps
  `[mcp_start_failed]`.
- **L8.**
  - Ctrl-D, an empty line, and an invalid code: the directory this run created is removed.
  - An empty directory that already existed is kept (in-process).
  - The default path keeps only `~/.cswarm/agents`.
- **Stranded seats still end in the revoke sentence** (register calls = 1, no secret in the transcript or any file):
  5xx, a 502 with an HTML body, a non-JSON 200, a truncated 200, a 200 that is not accepted, a 200 missing a field, a
  malformed token, a hostile `error`, 401 and 429. In-process, the losing racer, a parent made read-only after the prompt,
  and an injected EIO also end in it. **Refused before the prompt**, with 0 calls: an existing 0755 folder, a read-only
  parent, `…/credential.json`, and a symlinked folder.
- **No echo (K1).** `--code=`, `--agent-token-file=`, `--body=` and `--url=` on `mcp connect`, `mcp code`, `whoami`,
  `ask` and `status` show the secret 0 times. Neither do secrets inside a `--url` path or a `--profile` path.
- **The prompt, in a real pty.**
  - Ctrl-D and an empty line: exit 1 with `code_missing`.
  - Ctrl-C: exit 130. SIGTERM: exit 143.
  - Echo was on after every one of these.
- **Other checks.**
  - A pipe, `/dev/null` and a closed stdin are refused with 0 calls. `script` still redeems the code, and the text says so.
  - A 308 redirect gives `register_redirected`, and the second origin receives nothing.
  - Connect without `--anon-key` names only `--anon-key`.
- **L6.** The five retained shortenings are listed word for word in LANE.md and pinned by a test. I read each one
  against the longer original, and each is still true.

## Findings

### 1. PRODUCTION — "The code was not used" is still false for a code that was used and has since expired or been revoked

`src/cloud/mcp-connect.ts` remedy table: `forbidden`, `invalid_request` and `payload_too_large` all print "The code was
not used. Ask the operator for a new code." The server returns 403 `forbidden` from `registerAgentSeat` as soon as
`lockJoinCredential` finds the credential revoked or expired (`credential.revoked_at !== null || credential.unexpired
!== true`). That happens before any seat-cap or attempt check, and `seats_used` is never read. So a code that was
already redeemed, and has then expired or been revoked, gets `forbidden`. The CLI then tells the person "The code was
not used".

This is the round-2 case (someone else redeemed the code first), reached through a different path. The code lives
for 1 hour. A person who connects after the hour gets "not used" even if an attacker redeemed the code inside the hour.
Unlike `upgrade_required`, where the retry shows the truth, `forbidden` is the last thing the person ever sees. The
lead ruling said to verify each code against the server. For `forbidden` the verification fails: the server can prove
only that **this attempt** created no seat.

`invalid_request` and `payload_too_large` have the same problem, and for them a new code is also the wrong remedy. The
LANE.md sentence "The first group is returned before this registration inserts a seat" is true. The client sentence
says more than that.

Fix: for `forbidden`, say "This code is unknown, expired or revoked; this attempt created no seat. Ask the operator for
a new code." For the other codes in the "not used" group, say "this attempt created no seat" rather than "the code was
not used". Update the test that pins the current sentence. I verified this by reading the code at `command/index.ts`
`registerAgentSeat`. I did not measure it against a live server.

### 2. RIGOUR — cleanup can replace the revoke sentence with a raw error

The cleanup `finally` rethrows any `rmdir` error that is not ENOENT, ENOTEMPTY or EEXIST. That rethrow replaces the
error that was already being thrown. Measured in-process (`harness/inproc/l8.mts`): connect creates the directory,
the parent is made 0500 during the prompt, the register reply is a 502, and the caller gets `EACCES: permission denied,
rmdir …` instead of `register_outcome_unknown`. So the revoke instruction is lost for a seat that may exist. The
trigger is contrived: the permissions must change while connect runs. Fix: cleanup should never throw. Swallow every
error there.

### 3. RIGOUR — L8's claim is broader than the behaviour: Ctrl-C and SIGTERM leave the created directory

LANE.md says "Connect removes only its own empty profile directory after cancellation or refusal". Measured in a pty:
after Ctrl-C (exit 130) or SIGTERM (exit 143), the empty 0700 directory created in that run stays. This happens with
`--profile …/newdir/profile.json` and with the default path (`~/.cswarm/agents/mcp-<uuid>`). The signal handler calls
`process.exit` before `connectMcp`'s `finally` can run. It is harmless, but Ctrl-C is the most common way to cancel.
Either remove the directory in the signal path too, or narrow the claim to "after EOF, an empty line, or a refused code".

### 4. RIGOUR — the real-`main` enumeration was taken out of a pre-existing test, and LANE.md does not say so

`tests/p1-cli/timeout-table.test.ts` removed `{ ref: "main", enumerateRef: "main" }` from the "exact in both
directions" test and added a synthetic post-merge test. Measured in the clone with the removed row put back:
- After the merge (`main` = 057c79cb) the test passes.
- Before the merge (`main` = 86a938f3) it fails with `stale=[…mcp-connect.ts rows]`.

So the row fails only while the branch is unmerged, and the removal changes no post-merge result. It is still a
pre-existing assertion that was removed and not listed in LANE.md. Record it and give the reason.

## Gates (loopback, temporary HOME; base = 86a938f3 from round 1)

| Gate | base | 057c79cb | failure-set diff |
|---|---|---|---|
| `npm test` | 962 / 2 fail | 962 / 2 fail | identical |
| `npm run test:p1-cli` | 896 / 12 fail | 917 / 13 fail | +1 "main alias validates the post-merge HEAD inventory". It fails in this archive with `git … ls-files: not a git repository`, the same cause as base's timeout-table failure. It passes 2 of 2 in the clone. |
| `npm run check:tests` | — | exit 0 | — |
| `npm --prefix site test` | 511 / 105 fail | 513 / 105 fail | identical |
| mcp-connect focused | — | 19 / 19 | — |

## Not established

- Live H0 register and read/post against production, fresh Codex and Claude Code MCP sessions, and transcripts.
- Whether `cswarm principal revoke` works on an H0 seat.
- Whether the 10 s register budget fits production.
- Finding 1 comes from reading the server source, not from a live server.

VERDICT: FAIL

===== GROK REVIEW (round 3) =====
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
