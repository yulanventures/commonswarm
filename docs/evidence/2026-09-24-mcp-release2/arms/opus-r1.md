# Checker review (Claude Opus arm): lane/mcp-connect at da5fa657, base 86a938f3

Scope: item H release 2, option A (`cswarm mcp code` / `cswarm mcp connect`). I worked on a `git archive da5fa657` copy
(`opus-probes/lane`), a `git archive 86a938f3` copy (`opus-probes/base`) and a copy for mutations (`opus-probes/mut`).
I changed no tracked file and made no commit. All probes used loopback fakes: `harness/fake.mjs` for h0/register and command,
`harness/redir.mjs` for redirects. I used a real pseudo-terminal from `harness/drive.py` (python `pty.fork`, with a bash
wrapper that runs `stty -a` on the same pty after the CLI exits) and `script(1)`. HOME was temporary for every run.

**Probe-rule breach (disclosed).** In the base/lane comparison matrix (`harness/cmp.sh`) I put one case, `cswarm mcp code`,
with no `--url`. The lane CLI then ran F-1 target discovery. It printed "Using the CommonSwarm deployment at
https://api.commonswarm.com, discovered from https://commonswarm.com and saved", then "not logged in; run cswarm login".
So one unauthenticated discovery request reached https://commonswarm.com (about 08:15 UTC on 2026-09-24). No
credential was found, sent or read. No command request was sent. The saved target went only into the temporary HOME
(`harness/cmp/home/.cswarm/credentials.d/current-target.json`). After that, every run set `CSWARM_SITE=http://127.0.0.1:9`
or gave a loopback `--url`.

Severity key: **PRODUCTION** = the lane must not land or release until this is fixed. **RIGOUR** = the claim, control or
evidence is wrong or missing. Fix it in this lane or record it.

---

## 1. PRODUCTION — after a committed register, local failures do not tell the operator to revoke; a common input strands a seat with no warning

`src/cloud/mcp-connect.ts:134`
```ts
  await saveAgentProfile(path, connection, undefined, undefined, true);
```
Nothing wraps this call. The only pre-prompt checks (`:88-93`) are `assertPrivateLocation` and "path/credential.json
does not exist". The parent directory's mode, owner and writability are checked only inside `saveAgentProfile`, and that
runs after `h0/register` has committed. `cli.ts:9807` then prints the raw error under the code `mcp_start_failed`.

Measured with the CLI in a pty. The fake returned 200 with a seat, so the seat was committed:

| Input | register calls | stderr | revoke told? |
|---|---|---|---|
| `--profile <existing 0755 dir>/profile.json` (an ordinary directory) | 1 | `cswarm: [mcp_start_failed] credential directory must be mode 0700 (found 755): <path>` | no |
| `--profile <0500 dir>/sub/profile.json` | 1 | `cswarm: [mcp_start_failed] EACCES: permission denied, mkdir '<path>'` | no |
| in-process: two connects race to one path (distinct codes) | 2 | loser: `profile_exists` "This profile path already holds a connection. Choose a new profile path." | no |
| in-process: `profile.json` write fails (EIO injected) after `credential.json` was written | 1 | `EIO: injected write failure …` | no |

This also applies to the response itself (`:111-118`). A 200 whose body cannot be read or parsed (`ok_garbage`, and `cut` =
headers sent, then the connection dropped mid-body), a 200 with `status` other than `accepted`, and any 5xx (a gateway
502/504 after the edge committed) all print `Registration failed. Ask the operator for a new code.`. All of these were
measured (`harness/runs/m_*`). Only the fetch-rejection path (`:108-109`, `register_outcome_unknown`) and the
invalid-seat path (`:125`) say "revoke".

Brief decision 4 and Checker item 4 require that any local failure after a committed register tells the operator to
revoke. Today the person gets a false "Registration failed" or a raw fs error. The seat stays a live principal: it counts
toward the free-tier principal limit and is never revoked. The operator also spends one of the 5-per-user mints on a new
code.

Fix: (a) before the prompt, run the same directory check that `secureDirectory` runs, read-only (existing parent must be
0700 and owned by the user; the nearest existing ancestor must be writable). (b) Wrap everything after `response` arrives
in one catch that throws `McpConnectError("connect_incomplete", "Registration may have committed. Ask the operator to
revoke the seat and issue a new code.")`. Treat 200 and 5xx responses as "may have committed".

What was right (measured): in the EIO case no half-written profile is accepted. `readAgentProfile` refuses with
`profile_missing`, and a rerun at the same path is refused with `profile_exists` before the prompt. The credential.json
that was left behind is 0600.

## 2. PRODUCTION — the site gate (`npm --prefix site test`) has two new failures from this lane's copy changes

These are source-level tests (they do not need `site/dist`). They pass at base and fail at da5fa657:
- `site/src/components/app/access-lifecycle.observer.test.ts` "Add an agent asks only for a name and warns about the key when it exists":
  `The input did not match the regular expression /ac__warn[\s\S]*Keep the prompt or setup file private/`. The cause is
  the lane's new text at `AgentConnect.astro:211`, "This fallback prompt or setup file carries a secret through the model. Keep it private."
- `site/src/components/app/workspace-entry.observer.test.ts` "the live dashboard offers peer agent and collaborator paths from an empty workspace":
  `did not match /Generate prompt/`. The cause is the button text changed to "Generate fallback prompt" (`AgentConnect.astro:154`).

Measured: site suite, base 511 tests / 105 fail, lane 512 / 107 fail. After sorting and removing duplicates, the lists of
failing test names differ in exactly these two tests. All other failures happen in both, because this archive has no
built `site/dist`. LANE.md ("built-page and browser checks failed in that environment. The focused site prompt test
passed") hides these two, because nobody diffed the failure set against base. The release ritual runs this suite.

## 3. RIGOUR — the TTY rule meets the ruling's words, but not its purpose: a pseudo-terminal wrapper pipes the code in

`src/cloud/mcp-connect.ts:50`
```ts
  if (!process.stdin.isTTY) throw new McpConnectError("terminal_required", ...);
```
Measured: piped stdin, `< /dev/null` and closed stdin (`<&-`) are all refused with `terminal_required` before the read and
before any request (0 register calls, nothing written under HOME). However:
```
(sleep 1; echo "$CODE") | script -q /dev/null cswarm mcp connect --url http://127.0.0.1:<port> --anon-key k
```
exits 0, registers once, and writes the profile (`harness/nontty.sh`). `script` is on every macOS and Linux host. An agent
that has the code can redeem it. The commit message da5fa657 and the test comment (`tests/p1-cli/mcp-connect.test.ts:141`)
say "an agent cannot pipe the code in". That is a false claim (AGENTS.md "Claim controls prove stability, not truth").
Also, `mcp code` has no TTY check. An agent that can run the operator's CLI (the same user, the operator's keychain)
gets the code on stdout. Ruling condition 1 is met as written. Its stated purpose cannot be enforced on the client, so it
is a deterrent. Reword the claims to "a plain pipe or redirect is refused; a pseudo-terminal wrapper is not detected". Tell
the Strategist that condition 1 is a speed bump.

## 4. RIGOUR — Ctrl-D at the hidden prompt exits 0 with no message; echo is restored by Node, not by the lane's `finally`

`src/cloud/mcp-connect.ts:53-60`. Measured in a pty: Ctrl-D (EOF) prints `Connect code: ` and nothing more, and the exit
status is **0**. The readline `question` promise never settles, the event loop drains, and neither `finally` runs (the
trailing `\n` is never written). A wrapper like `cswarm mcp connect … && echo connected` reports success (AGENTS.md
"Honesty is not sufficient"; brain `false-success-signals`). Echo was still on after Ctrl-D, Ctrl-C at an empty prompt,
Ctrl-C after partial input, and Ctrl-C during a hung register (exit 130 each time). The positive control, `stty -echo`
run directly, reads `-echo`. On the EOF and SIGINT paths, Node 26 restores the saved termios itself (`ResetStdio`). The
lane's `terminalEcho(true)` is not what restores it there. Other points:
- `stty` missing from PATH: `terminal_unavailable` before the read, 0 requests (measured). If `stty echo` fails in `finally`,
  the code that was read is discarded and `terminal_unavailable` is thrown. That is safe.
- The prompt is written (`:51`) before `stty -echo` (`:52`). Characters typed ahead in that gap are echoed. Write the prompt after `-echo`.
- No test runs the production reader past the TTY gate. Mutation M6 (delete `terminalEcho(true)`) is NOT CAUGHT.
Fix: reject when the readline interface closes (`input.once("close", …)`) with `connect_cancelled` "No code was entered. Nothing changed."

## 5. RIGOUR — refusal remedies are wrong for several non-consuming failures; tests pin server codes that do not exist

`src/cloud/mcp-connect.ts:18-22, 99, 115-117`. The server sends `403 {"error":"forbidden"}` for unknown, expired, revoked
and owner-removed codes (`command/index.ts` `registerAgentSeat`, and the pre-auth gate at about line 11233). Other remedies measured:
- `426 upgrade_required` gives `[upgrade_required] Registration failed. Ask the operator for a new code.` The code was not consumed; the person must upgrade cswarm.
- `403 principal_limit_reached` (free-tier cap, raised before any seat is spent) gives the same sentence. A new code fails the same way; the operator must revoke a principal.
- A valid code with trailing spaces gives `[join_credential_invalid] The connect code is invalid. Ask the operator for a new code.` The code is unused. Trim the input and say "Nothing was sent."
- A wrong `--url` (for example the site host instead of the API host) gets 404/405, which gives "Ask the operator for a new code". The code is unused.
Each of these makes the operator mint again (5 mints per user). `CODE_REFUSALS` lists `join_credential_not_found`,
`join_credential_expired`, `join_credential_revoked` and `join_credential_invalid`, and h0/register never sends any of
them. `mcp-connect.test.ts:98` asserts all four, so the test pins a server behaviour that does not exist. LANE.md
decision 4 does state that `forbidden` is the shared refusal. Fix: a closed table from server code to remedy, built from
the edge's own constants where they exist, with "nothing was consumed" for codes that are refused before any seat is spent.

## 6. RIGOUR — the register fetch follows redirects and sends the code to another origin

`src/cloud/mcp-connect.ts:104-107`: `fetch(...)` with the default `redirect: "follow"`. Measured (`harness/redir.sh`): the
`--url` origin answers 308 to another loopback origin. That origin receives the POST with `joinCredential` (1 request).
Connect then succeeds and writes a profile whose `url` is the first origin, not the one that issued the seat. The person
now types `--url` by hand (decision 3), so typos are likely. The repo uses `redirect: "error"` on credential-bearing
requests (`src/cloud/agent-check.ts:92`, `agent-channel.ts:111`). Use it here too. The `http:` scheme is also accepted for
non-loopback hosts (`config.ts:20`, older than this lane). For connect, allow only https or loopback.

## 7. RIGOUR — secret-bearing error paths have no control (mutations NOT CAUGHT)

Mutation run, `opus-probes/mutate.py` against `tests/p1-cli/mcp-connect.test.ts` (source restored and checked with `cmp` after each run):

| Mutation | Result |
|---|---|
| M1 remove the isTTY check (with rebuild) | CAUGHT |
| M2 a second register after a refusal | CAUGHT |
| M3 print `Principal:` again | CAUGHT |
| M4 remove the pre-prompt occupancy check | CAUGHT |
| M5 `seat_cap: 2` | CAUGHT |
| M11 generic sentence for `forbidden` | CAUGHT |
| M6 remove `terminalEcho(true)` | **NOT CAUGHT** |
| M7 put the code into the invalid-code error (`:99`) | **NOT CAUGHT** |
| M8 put the seat token into the error when the write fails (`:134`) | **NOT CAUGHT** |
| M9 remove the in-lock orphan-credential recheck (`agent-profile.ts`) | **NOT CAUGHT** |
| M10 put the seat token into `register_response_invalid` (`:125`) | **NOT CAUGHT** |

"Done for release 2" requires that connect's error text never contains `swm_join_` or `swm_agt_`. Three of the error
producers that hold a secret in scope (M7, M8, M10) have no test. The in-lock recheck (M9) has no race test. Add a test
per producer that passes the secret into scope and asserts on the thrown error. Also add a race test that runs two
connects on one path.

## 8. RIGOUR — secret producers: enumeration and result

Code (`swm_join_`):
- `cli.ts:9401` `mcp code` stdout. By design. It also prints only the expiry and "Give this code to the person at the agent host." Measured only through `mintMcpCode` with a fake fetcher (the unit test). I did not run the CLI end to end, because a human session would need the keychain.
- `readHiddenJoinCode`: read into memory from the tty, with echo off. The pty transcripts had 0 matches for every action, including Ctrl-C after partial input.
- The register request body: loopback, and a redirect target (finding 6).
- Errors: the static sentences at `:99` and `:117`. The server `error` is filtered by `/^[a-z0-9_]{1,80}$/` and `!/swm_(join|agt)_/`. Measured with `errsecret` (a token in `error`) and `errjoin`: both give `register_refused`.
- Not in argv. `stty` gets only `echo` or `-echo`. The environment is not read. Mint response: `ThinCommandClient` does not persist it.

Seat token (`swm_agt_`):
- The register response, then `credential.json`: 0600, in a 0700 directory, written through a `.tmp` file created with `wx` and mode 0600 and then renamed. Measured 0600 and 0700. `profile.json` holds only the credential path. Across all runs, no file other than `credential.json` held either prefix.
- Errors: static (`:125`, `:117`). With `ok_badtoken` (malformed `swm_agt_short`), `ok_garbage` (token inside non-JSON) and `cut` (token cut off mid-body), stdout and stderr had no match.
Result: no leak measured on any path I ran. The gaps in control are in finding 7.

## 9. RIGOUR — `--profile <dir>/credential.json` exits 0, and the profile overwrote the seat token

In-process, measured (`harness/inproc/cred.mts`): connect returns success and prints install lines. `saveAgentProfile`
writes the credential to `<dir>/credential.json` and then writes the profile to the same path. The token is lost, and
`readProfileCredential` refuses with `agent_credential_missing_agent_token`. The seat is stranded and the exit is 0. The
cause is older than this lane (`saveAgentProfile`), but connect makes it a committed seat. Refuse a profile basename of
`credential.json` before the prompt.

## 10. RIGOUR — target (`--url` and anon key)

`cli.ts:9407` passes only `explicitUrl` and `explicitAnonKey`. Measured:
- Fresh host, no `--anon-key`: `no Cloud anon key is selected: pass --anon-key, set SWARM_CLOUD_ANON_KEY, …`. With `SWARM_CLOUD_ANON_KEY=k` set, the same refusal appears, because connect ignores the environment. So the remedy names a source that this command does not read (AGENTS.md "An enumeration inside a message must be generated").
- A saved target for another URL is refused (`differs from the stored current target`). A saved target for the same URL (trailing slash normalised) is used. **No wrong key or deployment is used silently.**
- `MCP_OPERATOR_GUIDE` (`agent-onboarding-contract.ts:46`) tells the person to run `cswarm mcp connect --url <deployment-url>` with no `--anon-key`. On a fresh agent host (the normal case) that exact command fails. `mcp code` prints neither the URL nor the connect command, so the person at the agent host must find out the API origin and the anon key alone (brain memory "never type the anon key"). Brief decision 3 says connect "uses the public anon key from that deployment". The lane requires `--anon-key` or a saved target instead. LANE.md states this, but the guide does not. Fix: `mcp code` prints the exact secret-free connect line (`cswarm mcp connect --url <its url> --anon-key <its public key>`), or connect fetches the public key from the deployment.

## 11. RIGOUR — claims in onboarding text, LANE.md and help

- LANE.md:10 "Connect prints only profile path, principal ID, and the … install lines". This is stale after da5fa657, which removed the Principal line. The LANE.md:37 bundle SHA `fc9d9114…` is from before the fix. I rebuilt da5fa657 and got `952ccf0f26d1ce68c386da8c102cdcf560d618e460e38dbbd3d19392aa450b04`.
- LANE.md 'Not established' and the verification table say the site suite failures are environmental. That is false for two tests (finding 2).
- LANE.md does not mention a change to the fallback prompt: `agent-prompt.ts:42` removed "The installer reuses a matching build. If its host is blocked, use npm install -g commonswarm … otherwise report that the release needs updating." That removes the npm fallback and the remedy from the agent's prompt, probably to stay under the 2000/3200-character budget. State it and get it accepted, or restore it.
- `agent-prompt.ts:20` shows the Codex config as one line: `[mcp_servers.cswarm] command = "cswarm", args = [...]`. That is not valid TOML. A table header must be on its own line, and top-level keys are not separated by commas. Connect's own output (`mcp-connect.ts:136`) is correct.
- `MCP_OPERATOR_GUIDE` "If a code fails, ask the operator for a new code": wrong for the cases in finding 5.
- The mint output "Connect code (shown once)" and the help lines `cswarm mcp code …` / `cswarm mcp connect --url <url> [--anon-key <key>] [--profile <absolute-path>] [--name <display-name>]` are accurate. `mcp code` also accepts `--force-file-store` (`TARGET_FLAGS`), which the help does not show. This is older behaviour, and the same on other verbs.
- `mcp code` and `mcp connect` errors all print under the `mcp` stderr branch (`cli.ts:9807`), so every error that is not an `AgentSetupError` is labelled `[mcp_start_failed]` (for example "not logged in", EACCES, the anon-key refusal). No server was started. Use a connect or code specific fallback code.
- H0 paste (`src/h0/paste.ts:137`) and the fallback-prompt disclosure sentences are true.

## 12. RIGOUR — `mcp` as a group: behaviour at 0.1.75 kept; fixture rows mislabelled

Measured side by side, base against lane dist, 16 argv cases with MCP `initialize` + `tools/list` on stdin (`harness/cmp.sh`).
Stdout bytes, stderr and exit status are identical for: `mcp`; `--profile` missing; unbound profile with and without an
id (3769 B stdout each, stderr empty); bound profile with no id (`host_session_required`), with the wrong id
(`profile_other_session`) and with the right id (serves); `serve`; `--json`; `--url`; relative path. The only differences
are:
- `mcp bogus --profile P` and `mcp --profile P extra` now say "mcp requires code or connect, or --profile to serve tools" (base: "too many positional arguments"). This is intended. Stdout is still empty.
- The global help gains the two usage lines.

Dispatch fixture: I recomputed 78 added, 9 removed and 339 changed rows. For 337 changed rows, the only difference is the
two inserted help lines. The `mcp` row has the refusal wording above. `setup.guide` has the new guide prefix. **Every
changed row is intended.** But `command-dispatch-baseline.test.ts:515` maps `"mcp.serve.default": ["mcp", "extra"]`,
and that argv now selects the group refusal, not serve. So `selected-error.mcp.serve.*` and
`policy.host-session.mcp.serve.keep` exercise the refusal. `policy.host-session.mcp.refusal.keep`
(`mcp --profile P --host-session-id …`, exit 0) exercises serve. The names are swapped. The serve entry's selected-error
policy has no row that reaches it (AGENTS.md "A negative result must reach the path it claims to test"). Also,
`cswarm mcp serve --profile P` can be typed and always fails with "too many positional arguments". Either accept `serve`
as an alias or hide the key.

## 13. RIGOUR — single use: analysis

- The CLI calls `randomUUID()` for `attemptId` inside the one fetch body (`:106`). It never persists, logs or retries it (M2 control). A second connect with the same code: the fake returned `join_credential_seat_cap_reached`, 2 calls total, and nothing was written (the test, plus my run `m_ok` followed by the in-process second path).
- Server: `seats_used` only increases (`command/index.ts:6382`). Revoking the seat does not give capacity back, so the code alone is single-use within its hour, including after the operator revokes a stranded seat.
- Replay path (migration 20260916000002, `replaceUnusedRegistrationToken`): the same code **plus** the same `attemptId`, within the hour, while the seat's token has never been used, mints a replacement token for that seat. The CLI cannot trigger this, because it throws `attemptId` away. It could be reached by anyone who has both the code and the `attemptId`. The `attemptId` is written into server audit `detail` (`attempt_id=…`). I did not check who can read those audit rows. That is **not established**. It matters only when the code has also leaked. In the "local write failed" cases (finding 1), that window stays open until the hour ends or the seat is revoked.

## 14. RIGOUR — `scripts/build-release.sh` writes `dist-release/package.json`

Effect measured: `bash scripts/build-release.sh` exit 0. `dist-release/` now holds `cswarm`, `cswarm.sha256` and
`package.json` (`{"type":"commonjs"}`). The checksum covers only `cswarm`. `scripts/build-npm.sh:26` copies only
`dist-release/cswarm` into `dist-npm/cswarm.cjs`, so the npm artifact does not change. The resume files upload two named
assets. If a release ever uploads `dist-release/*`, package.json becomes a third, harmless release asset. The copied
bundle, run from an isolated directory, completed a full connect against the fake (`runs/bundle_ok`: exit 0, 0600/0700,
no secret in the transcript). This is the check the source suites never do. The `release-bundle.test.ts` check
(`mcp connect --help`) only reaches the global `--help` branch. It proves that the in-repo bundle starts, not that connect works.

## 15. Gates (measured, loopback only, temporary HOME, `CSWARM_SITE=http://127.0.0.1:9`)

| Gate | base 86a938f3 | lane da5fa657 | Diff of failing test names |
|---|---|---|---|
| `npm test` | 962 / 2 fail | 962 / 2 fail | identical (checker self-test, receipts parser: this archive has no `.git`) |
| `npm run test:p1-cli` | 896 / 12 fail | 901 / 12 fail | identical. The 5 new mcp-connect tests pass |
| `npm run check:tests` | — | exit 0 | — |
| `npm --prefix site test` | 511 / 105 fail | 512 / 107 fail | **+2, lane only (finding 2)** |
| `bash scripts/build-release.sh` | — | exit 0 | — |

`tests/p1-cli/mcp-connect.test.ts` runs only through the `test:p1-cli` glob. The literal `npm test` list does not name it
(the brief asks only for "tests/p1-cli, named by the package script", so this is acceptable).

## Not established

The live H0 seat with read, check and ask/reply edges, the fresh Codex and Claude Code MCP sessions, and the transcripts
(brief decision 6 and the Done list): not run, because production was out of scope. I did not measure whether the 10 s
register budget (`:101`) fits production, where h0 does a cold `import("../command/index.ts")` and a transaction. The
same class failed before: a 3 s budget that nobody had measured rolled back the 2026-09-16 cutover. I did not run
`mcp code` end to end through the CLI with a human session. Who can read the `attempt_id` in the audit rows (finding 13).

## Summary

The core works. Secrets did not leak on any path I ran. Piped, null and closed stdin are refused before the read. There
is one register and no retry. The occupancy preflight works. Seat cap limits the code to one use. `mcp --profile`
behaves exactly as at 0.1.75. Two PRODUCTION findings block landing: (1) seats that commit and then fail locally are
stranded without a revoke instruction, and an ordinary 0755 directory triggers this; (2) the site gate has two new red
tests. The main RIGOUR items: the pty bypass of the TTY rule makes a published claim false, Ctrl-D exits 0, remedies are
wrong for non-consuming refusals, a redirect forwards the code to another origin, three secret-bearing error paths have no
control, the guide's connect command fails on a fresh host, and LANE.md is stale in places.

VERDICT: FAIL
