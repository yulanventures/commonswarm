# H0 lane 5b — Checker (Claude Opus), delta round 3

Scope: `git diff 6cfb063e...2453ec6b` (fold 2, one commit `2453ec6b`), context from `git show 2453ec6b:<path>`.
Read-only. I ran no test, database, Docker, supabase, or network command.

## Result on the five fold claims

1. **attemptId note / 409 remedy — holds.** `src/h0/verbs.ts:123` now says "a used or revoked seat
   returns 409; follow the message in that response". It no longer attaches the seat-cap remedy to the
   used-token 409, so Grok's round-2 finding is resolved. The two outer refusal sites use the constants
   (`supabase/functions/command/index.ts:6146-6149`, `6170-6173`); strings in
   `registration-conflicts.ts` are byte-identical to the old literals. One producer was not converted
   (R1). Other 409s an attempt retry can meet: `command_id_conflict` cannot occur (H0 register uses a fresh
   random `command_id`, `forward.ts:150-152`); the seat-cap 409 is only for a NEW attempt. So the note's
   scope is right.
2. **h0 env without `SUPABASE_SERVICE_ROLE_KEY` — holds; no reachable path breaks.** Trace:
   - The only reader in `supabase/functions/**` and `src/**` is `fileStorage()` (`command/index.ts:1084-1088`).
     Nothing reads it at import time; the only `createClient` (`:1185`) uses the anon key.
   - `fileStorage()` has two callers. `:10108` sits inside `if (FILE_COMMAND_KINDS.includes(command.kind))`
     (`:9938`). The post-transaction purge drain `:11335` sits inside
     `if (FILE_COMMAND_KINDS.includes(kind))` (`:11326`), where `kind = commandKind(body)` (`:11211`, `:1384`)
     reads `body.command.kind`.
   - H0 builds `command.kind` only from the literals `register_agent_seat` / `post_signal`
     (`forward.ts:139-150`); the spread adds only `to`, and `parseH0ForwardBody` refuses unknown keys.
     `handleRequest` (`:11394`) does not route on the URL path. `signal-attachments.ts`, `h0-seat.ts`, and
     `_shared/wake.ts` contain no storage call or `fetch`.
   - `environmentFor` (`deploy/edge-runtime/main/index.ts:50-60`) passes only listed names, so the h0
     worker gets `COMMAND_ENV` minus the key (`router.ts:201-203`, `:223`).
   - `edge-runtime-box.test.ts` asserts that set. It is computed with the same filter, so the test pins the
     construction, not an independent list. The literal `["SUPABASE_SERVICE_ROLE_KEY"]` assertion and the
     `includes(...) === false` line are the independent part. That is enough for this claim.
3. **LANE.md 503 narrowing — holds.** The new text limits the shared 40001/40P01 → 503 classifier to the
   routing lookup. It says a serialization failure inside the command transaction takes the command
   edge's 500. That matches round-2 evidence (`command/index.ts` catch → 500).
4. **Shared resolver — holds, same behaviour for the command worker.** `commandRequiredConfig`
   (`command/required-config.ts:8-17`) uses `get(SWARM_DATABASE_URL) ?? get(SUPABASE_DB_URL)`, the same
   precedence as before. The truthiness check is the same, so an empty string still fails. The throw and
   its message at `command/index.ts:1051-1055` are unchanged, and destructuring after the null check keeps
   the non-null types. `forward.ts:133` uses the same resolver. Its new static import of `required-config.ts`
   has no side effect, so poll/ack still do not depend on command config.
5. **h0 `deno.lock` — equal; runtime read not established.** `supabase/functions/h0/deno.lock` and
   `command/deno.lock` have the same bytes (shasum `e448fbe452fc` for both). Its `workspace.dependencies`
   (`npm:postgres@3.4.9`) matches `deploy/edge-runtime/h0-deno.json`, which `bootstrap.sh:7` copies over
   `h0/deno.json`. `bootstrap.sh` `cp -R` stages the lock next to it. H0's remote graph
   (`npm:postgres@3.4.9`, plus `npm:@supabase/supabase-js@2.110.8` through command) is exactly the
   lock's `specifiers`. If edge-runtime v1.73.13 honours the lock, it is complete, so the runtime has no
   need to write to the read-only staged tree. That is the state command already runs in. Whether the
   runtime reads it at all is not established; LANE.md says so.

Shared-constant change and existing consumers: I searched every tracked file for the old strings. The
old note text survives only in the negative assertion `h0-verbs.test.ts:400`. The two edge messages
still appear as literals in `tests/p1-server/agent-join-credential.test.ts:1400-1401` and `:1462-1463`;
those are independent pins and still match. No `src/` or `site/` code depends on either string. The
edge's response text did not change.

## Findings

### R1. RIGOUR — a third producer of the used-token 409 still types its message
`supabase/functions/command/index.ts:5835-5850` (`replaceUnusedRegistrationToken`, the atomic fence)
returns `409, "registration_token_already_used", …, "Revoke that seat and register again."` as literals.
LANE.md:145 says the constants are "used at its refusal sites". This site is a refusal site of the
same code and message, and it is not converted. The text is identical today, so the behaviour does not
change. The drift the fold removes at two sites stays open at the third. AGENTS.md D-053 says to "name
every producer". Fix: use `REGISTRATION_TOKEN_ALREADY_USED` there too.

### R2. RIGOUR — the operator README still says h0 gets the command environment
`deploy/edge-runtime/README.md:40-41` (written in this lane): "`FUNCTION_ENV_NAMES.h0` includes the
command function's environment names because forwarded verbs call its request handler…". Fold 2 removes
`SUPABASE_SERVICE_ROLE_KEY` from that set. The sentence is now wrong about the one name an operator
cares about most. Fix: add "except `SUPABASE_SERVICE_ROLE_KEY` (`H0_COMMAND_ENV_EXCLUSIONS`), which
only file commands read".

### R3. RIGOUR — the line-for-line golden test was relaxed against its own rule
`tests/p1-cli/h0-verbs.test.ts:358` now builds the attemptId line from `H0_VERBS` itself, so that line
compares the generator with itself. The test's own comment (`:335-340`) says the whole document must
match the golden line for line: "Do NOT relax the assertion". The JSON fixture
(`tests/p1-cli/fixtures/h0-agent-document.golden.json`, compared at `h0-agent-document.test.ts:411`)
still pins the text independently, so a pin still exists. Fix: restore the literal line.

### R4. RIGOUR, minor
- `command/index.ts:1053` still types the list of required names in its error. `COMMAND_REQUIRED_ENV`
  now exists, and the AGENTS.md rule says to build that list from the constant.
- `h0-forward-contract.test.ts` "share the required configuration names" does not test precedence
  (`SWARM_DATABASE_URL` wins over `SUPABASE_DB_URL`) or the empty-string case.
- `h0-verbs.test.ts:394-398` runs the same regex once for each constant. Past `status === 409` and
  "message non-empty", it checks nothing about either message. This is acceptable because the note
  defers to the response, but it is not an "agreement" check in the sense LANE.md implies.

## Not established
- I did not run any gate. The pass counts in LANE.md are the Maker's.
- Whether edge-runtime v1.73.13 loads `h0/deno.lock`.
- Whether a user worker's `Deno.env` is limited to `envVars` (assumed from round 2 and the runtime design).
  I did not measure it on the box.
- `swarm.signal_recipients` and delivery-row parity, live pool headroom, and the three-host done-test.
  LANE.md already lists these.

No PRODUCTION finding. The fold resolves Grok's round-2 FAIL, and removing the key breaks no path H0
can reach. R1-R3 are one-line fixes. Fold them before landing if another fold happens. Alone, they do
not block the lane.

VERDICT: PASS
