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
