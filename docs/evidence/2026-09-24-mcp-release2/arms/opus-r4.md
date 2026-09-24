# Checker review round 4 (Claude Opus arm): lane/mcp-connect at 094d9563 (fold 3: 2892f3ee + 094d9563)

**Setup.** Clean `git archive 094d9563` copy in `opus-probes/lane4`; `npm run build` exit 0. Mutations ran on a separate
archive (`opus-probes/mut4`). The git-dependent tests ran in a local `git clone --shared` with no remote
(`opus-probes/clone`), after `npm run build` there.

**Safety.** Every probe used loopback fakes, a temporary HOME and `CSWARM_SITE=http://127.0.0.1:9`. Every cswarm
command had a loopback `--url`. No production host was contacted. No tracked file was changed and nothing was committed.
None of my processes are running.

**Severity key.** PRODUCTION = blocks landing or release. RIGOUR = claim, control or evidence gap.

## Rulings M1-M5: measured

### M1: every refusal sentence against `registerAgentSeat`

No connect message says "was not used". A grep over `src/`, `site/src/components/connect/` and LANE.md finds 0 matches.

Measured through the CLI in a pty against a loopback fake. Each case had register calls = 1, no secret in the
transcript, and the empty profile directory removed:

| Server result | Sentence printed | True? |
|---|---|---|
| `forbidden` 403 | "This code is unknown, expired or revoked; this attempt created no seat. Ask the operator for a new code." | Yes. The server returns it at the credential lock (revoked or not unexpired) and at the owner-membership check. Both come before any seat logic. |
| `upgrade_required` 426 | "Update cswarm and run mcp connect again; this attempt created no seat." | Yes. The version check runs before the attempt and seat logic. |
| `principal_limit_reached` 403 | "The workspace has no free agent seat; this attempt created no seat. Ask the operator." | Yes. It is refused before the seat insert. |
| `invalid_request` 400, `payload_too_large` 413 | "The request was refused; this attempt created no seat. Ask the operator for a new code." | The claim is true. |
| `not_found` 404 (JSON) | "Check --url; this attempt created no seat." | Yes. H0 routing refuses before registration. |
| `join_credential_seat_cap_reached`, `registration_token_already_used`, `registration_seat_revoked` (409) | The "already used … revoke that agent" sentence | Yes. |
| `command_id_conflict`, 5xx, 401, 429, HTML 404, non-JSON / truncated / non-accepted / invalid 200, a known code with the wrong status | The "may have been created … cswarm principal revoke" sentence | Yes (the result is uncertain). |

**Redeemed code, then `forbidden`.** One stateful fake served two connects (`harness/seq.sh`). The first redeemed the
code (exit 0, profile written). The second got 403 `forbidden`, which models the code having expired or been revoked
since. It printed "This code is unknown, expired or revoked; this attempt created no seat. …" (exit 1). The sentence is
true. My round-3 blocker is closed.

The generator still derives both sets from server source, and `--check` passes. The test now pins all ten sentences by
exact equality and asserts that no message matches `/was not used/i`. That is stronger than fold 2.

### M2: fallback prompt

- "Confirm cswarm setup --check-version returns setup_version 1; otherwise report that the release needs updating." The
  remedy is back on the version check.
- The npm fallback sentence stands on its own.
- The prompt says "the local Grok Bot gateway".
- The observer test and LANE.md pin these sentences. Mutation Q6 (dropping the remedy) is CAUGHT.

### M3: cleanup and signals

- **EACCES after a committed 502.** In-process (`harness/inproc/l8.mts`), connect creates the directory, the parent is
  made 0500 during the prompt, and the reply is a 502. Result: `register_outcome_unknown` with the revoke sentence. In
  round 3 the result was a raw EACCES.
- **Signals, in a pty:**
  - Ctrl-C: exit 130. SIGTERM: exit 143. Echo is on in both cases.
  - The empty directory created in this run is removed, both with `--profile …/newdir` and with the default
    `~/.cswarm/agents/mcp-<uuid>`.
  - A pre-existing empty directory is kept after Ctrl-C.
  - Parent directories created along the way (`~/.cswarm/agents`) stay. That is correct: the rule is to remove only
    the profile directory itself.
- **Ctrl-D, an empty line, an invalid code:** exit 1, directory removed, pre-existing directory kept.

### M4: timer citation

- The mapping cites `src/cloud/mcp-connect.ts:167`, and line 167 is `const timer = setTimeout(() => controller.abort(), MCP_REGISTER_TIMEOUT_MS);`.
- The other two rows (`:21` for the constant, `:48` for the `stty` timeout) also match their lines.
- A new test asserts that the cited line contains the timer. Mutation Q5 (citation changed to 166) is CAUGHT by that test.

### M5: removed real-`main` check

LANE.md now records that the check was removed and why. A test pins that disclosure.

### Timeout table after the merge (clone)

`timeout-table.test.ts` passes 18/18 with `main` at 86a938f3 (before the merge) and 18/18 with `main` at 094d9563
(after a fast-forward merge).

## Earlier probes: all still hold

- **Refused before the prompt, 0 register calls:** an existing 0755 directory (`[mcp_connect_failed] credential
  directory must be mode 0700`), a read-only parent, `…/credential.json`, and a symlinked directory.
- **In-process:** a lost race, a parent made read-only after the prompt, and an injected EIO each give the revoke
  sentence. After EIO the credential file is 0600, `readAgentProfile` refuses the half-written profile, and a rerun is
  refused before the prompt.
- **No echo:** option values given as `--code=`, `--agent-token-file=`, `--body=` or `--url=` on `mcp connect`,
  `mcp code`, `whoami`, `ask` and `status`, and secrets placed in a `--url` or `--profile` path, appear 0 times in the
  output.
- **Stdin:** a pipe, `/dev/null` and a closed stdin are refused with 0 register calls. `script` still redeems the code,
  as the output text states.
- **Redirect:** a 308 gives `register_redirected`, and the second origin receives no request.
- **Anon key:** without `--anon-key`, connect names only `--anon-key`, whether the host is fresh, has only the
  environment key set, or has a saved key for another URL.

## Mutations (`opus-probes/mutate4.py`; sources restored and compared with the commit using `cmp`)

| Mutation | Result |
|---|---|
| Q1 `forbidden` says "The code was not used" again | CAUGHT |
| Q2 cleanup rethrows | CAUGHT |
| Q3 no cleanup on signal | CAUGHT |
| Q4 signal cleanup removes any directory | CAUGHT |
| Q5 citation drift | CAUGHT |
| Q6 version remedy moved | CAUGHT |
| Q7 status check removed | CAUGHT |
| Q8 `forbidden` gets the generic sentence | CAUGHT |
| Q9 outer `try` around the signal cleanup removed | NOT CAUGHT. This mutant is equivalent: `cleanupOnSignal` already catches everything inside, so the outer `try` is redundant. It is not a control gap. |

Baselines: `mcp-connect.test.ts` 22/22 (in the lane4 copy and in the clone), and the site prompt test 13/13.

**No test was weakened.** I checked every removed line in the diff from 057c79cb to 094d9563. Each assertion that
pinned the old "not used" wording or the old shortened prompt sentence was replaced by a stricter one: exact equality,
or a verbatim sentence.

## Gates (loopback, temporary HOME; base = 86a938f3)

| Gate | base | 094d9563 | Diff of the failure sets |
|---|---|---|---|
| `npm test` | 962 / 2 fail | 962 / 2 fail | identical |
| `npm run test:p1-cli` | 896 / 12 fail | 922 / 13 fail | +1 "main alias validates the post-merge HEAD inventory". It fails in this archive because the archive has no `.git`, the same cause as base's timeout-table failures. It passes in the clone (18/18). |
| `npm run check:tests` | — | exit 0 | — |
| `npm --prefix site test` | 511 / 105 fail | 513 / 105 fail | identical |

## Remaining notes (RIGOUR, none blocking)

1. **`forbidden` wording.** "unknown, expired or revoked" also covers the case where the issuing operator has left the
   workspace. The server returns `forbidden` for that too. "Revoked" is loose there, but "this attempt created no
   seat" stays true.
2. **Next step for `invalid_request` and `payload_too_large`.** The sentence says "Ask the operator for a new code",
   but a new code will not fix a malformed request. The claim is true. Only the next step is weak. The CLI checks the
   name before it sends, so this case should not happen in practice.
3. **Ctrl-C during the register request** (after the prompt), carried from round 1 and never ruled on. Node's default
   handler exits 130 with no message and no cleanup, and a seat may already be committed.

## Not established

- No live run against production: no H0 register, read or post; no fresh Codex or Claude Code MCP session; no
  transcripts.
- Whether `cswarm principal revoke` works on an H0 seat.
- Whether the 10 s register timeout is enough in production.
- I verified the sentences above by reading the server source. I did not run them against a live server.

VERDICT: PASS
