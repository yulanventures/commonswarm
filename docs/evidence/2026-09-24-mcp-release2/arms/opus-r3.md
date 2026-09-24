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
