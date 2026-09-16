# Resume here — item H0, link-join and long-poll (2026-09-16)

Written for a cold successor. Refs are hashes. Read this before re-deriving anything.

## What H0 is

Operator ruling 2026-09-14, top priority: fast-follow Plasma AI's Radio. A fresh Claude Code, Codex,
and Grok session each join a workspace from ONE pasted message, with no install and no typed token,
then read, post, and reply. Production controls per path.

Spec of record: `docs/design/2026-09-15-H0-LINK-JOIN.md` at **v10, `394fef2f`**, on branch
`spec/h0-link-join` (NOT on main). CSwarmStrategist ruled "A": no more spec versions; the three open
mechanism questions in §7 are closed by lanes, with evidence from running code.

## STATE: FOUR LANES ON MAIN, TWO MAKERS RUNNING, NOTHING DEPLOYED

| lane | what | where | pair |
|---|---|---|---|
| 1 | seven-verb table + generated agent document | main `13e6d8fc` | grok PASS, antigravity PASS |
| 2 | `supabase/functions/h0/` edge function serving the document | main, `24b1df45` through `36383bd4` (4 commits) | grok PASS, antigravity PASS |
| 4a | the paste a human copies (`src/h0/paste.ts`) | main, `de7f1389` through `5cd5e91b` (6 commits) | antigravity PASS, grok PASS |
| 3a | agent-join credential: table, mint, revoke, hidden registrar | main, `165114ee` through `b4198f98` (3 commits) | grok PASS, antigravity PASS |
| 3b | registration: `register_agent_seat` on the command edge | `lane/h0-register` from `b4198f98` | Codex Maker (gpt-5.6-sol xhigh) RUNNING; prompt `maker-lane3b.txt` in the session scratchpad |

`main` = `b4198f98`. CI (agent trailers, commit identity) green on each landing through `5cd5e91b`;
`b4198f98` was in progress when this was written.

**Item H runs in parallel.** Lane 1 (the command table becomes the dispatcher, MCP spec v20 `c72f0916`
§3, on local branch `spec/mcp-server`, not pushed) is with a second Codex Maker on
`lane/mcp-command-table`. It must not edit the files lane 3b edits (`supabase/**`,
`tests/p1-server/**`, `tests/p1-cli/citation-drift.test.ts`, `site/src/lib/agent-connect.ts`, the mint
observer test, `acceptable-use.astro`); its `src/cli.ts` citation changes for those files go to
`docs/evidence/2026-09-16-h-lane1/CITATIONS.md` and the lead applies them at landing. v20 never had its
pair: H0 took priority first. Lane 1 does not depend on the connect design the v19 and v20 arms failed.

**LIVE vs WRITTEN.** Nothing in H0 is live. The h0 function is not deployed. No H0 migration is
applied to production. No npm release carries H0. The paste is not wired into the app — the live
invite copy is still `dashboardAgentPrompt` (`site/src/components/connect/agent-prompt.ts`), called
at `site/src/components/connect/AgentConnect.astro:721`.

Each lane directory under `docs/evidence/2026-09-15-h0-lane1/`, `…-h0-lane2/`, `2026-09-16-h0-lane4/`
holds the arm outputs and a `LANDING.md` recording the pair, accepted gaps, and corrections to commit
messages (messages are immutable, so corrections live there).

## NEXT, in order

1. **Lane 3a is LANDED** (`b4198f98`). A full `test:p1-server` run passed 201/201 (exit 0) with nothing
   else running in that worktree, on the lane BEFORE its final commit. That commit changed tests only; its
   server file then passed 16/16 alone, with six mutations each confirmed applied. The two earlier failed
   runs had a build running in the same worktree at the time.
2. **Lane 3b: registration (Maker running).** The atomic fold in ONE transaction: attempt row keyed
   `(join_credential, attemptId)` + seat consumed (`seats_used`, schema already caps it) + principal
   + device + run + renewal grant + token. Attribution to the credential's REGISTRAR principal and
   run. Retry with the same `attemptId` replaces an UNUSED token only. Spec §5.
   **DO NOT run a Maker that resets the local database while any server test is running against it.**
3. **Poll and ack.** Fence seam, ruled by the Strategist: refuse the listener claim for H0 seats at
   the single caller of `claimAgentInbox`, `supabase/functions/command/index.ts` claim branch (was
   `:8597`), and prove an H0 seat's claim is refused while its ack succeeds. Per-message ack carries
   message id + effect ordinal (SWARM-CLOUD.md:470).
4. **Lane 4b, the app's "Add an agent" on the link-join** — prompt drafted (`maker-lane4b-DRAFT.txt` in the
   session scratchpad). Held because host memory pressure read level 2 with two Makers running.
5. **Lane 5a, poll + ack + the listener fence** — prompt drafted (`maker-lane5a-DRAFT.txt`). Starts after
   3b lands: it edits `command/index.ts` and needs the attempt-row marker.
6. **Lane 5b, the h0 function forwards register, ask, note, reply, working-on** to the command edge. After
   5a (both edit `supabase/functions/h0/`).
7. Release; deploy (resolve the ref first); run the three-host done-test.

## DEFERRED OR ACCEPTED, stated so nobody rediscovers them

- Recipient `id` is `format: uuid`; the server's `CHAT_UUID_RE` also requires version [1-8] and
  variant [89ab], and is deliberately module-local. Agents take ids from server responses.
- `swarm_read.agent_runs` and `swarm_read.my_devices` are `SELECT *` views; any column added to those
  tables later would be published by a re-creation. Today their live columns match the originals.
- The paste guard refuses 12+ consecutive secret characters; shorter pieces pass by design.
- `tests/support/host-stderr-exit-parity.ts` has a 1300 ms wall-clock ceiling that failed six times
  across three providers in two days, all under load, all passing on rerun. Filed as its own task.

## NOT ESTABLISHED

- **An H0 seat has no renew path, by ruling.** Strategist 2026-09-16 16:39Z: no eighth verb and no 24-hour
  seat. The seat token lives `AGENT_TOKEN_MAX_TTL_MS` (30 days, `src/protocol/workspace-commands.ts`, equal
  to the connect picker default). The renewal grant is still created, and the agent document's first
  paragraph states the lifetime, generated from the constant. Lane 3b's Maker was dispatched with a
  24-hour constant BEFORE the ruling, so that change is owed in lane 3b before its pair.
  The ruling also said a seat past 30 days "re-registers through the same invite by replaying its
  registration". That CANNOT work on main: the join credential expires within 24 hours (CHECK in
  `20260916000001_agent_join_credentials.sql`), and spec §5 refuses a replay whose token was used.
  Sent back as signal `90346c31`; the Strategist AGREED and withdrew the replay sentence (`0fd36319`,
  16:41Z): after 30 days the seat stops and the document says to ask the human for a new invite. Invite TTL
  stays in hours; renewal beyond 30 days is item H's session renew.

- Any H0 path on production. The three-host done-test.
- Whether two sentences are enough for each host to register unprompted.
- A green full `test:p1-server` run on lane 3a's FINAL commit (see NEXT item 1 for what did run).

## CORRECTIONS TO PUBLISHED CLAIMS (retired wording kept, because readers may meet it)

- d702852e said importing `durable-delivery.ts` "pulls in postgres and cannot load under Node tests".
  FALSE and never run: its only import is `import type`; tsx, tsc and deno all load it. Corrected in
  2bc56127, which then served the closed sets it had claimed were impossible.
- Spec v9 said `agent_principals` has `UNIQUE (workspace_id, name)`. FALSE: a later migration dropped
  it. Withdrawn in v10. Lesson: a migration directory is a sequence; read the live schema.
- Spec v9 said `managed_at` shows "refuse the claim, keep the ack". FALSE: it binds a flag. Withdrawn.

## THINGS THAT COST REAL TIME — read before dispatching arms or Makers

- `FORCE_COLOR=` does NOT unset it (an empty variable is still set). Use `env -u FORCE_COLOR`.
- `codex exec` in a background task hangs forever on unclosed stdin. Always `< /dev/null`.
- `agy` returns EXIT 0 with an EMPTY file on its 5-minute default timeout (`--print-timeout 25m`), and
  on a denied tool call in headless mode. Give it a fully self-contained prompt that forbids tools, and
  never pass `--dangerously-skip-permissions`.
- A prompt passed as argv lands in `ps`; around 80 KB it breaks `cswarm resume` for every agent on the
  host. Keep arm prompts well under that; split a large review between arms instead.
- An arm (grok) once sent live GET requests to production unprompted. Every arm prompt now forbids
  contacting production explicitly.
- A green mutation result means nothing until the mutation is confirmed APPLIED. That check caught
  mutations that had silently failed to apply, repeatedly, during this sprint.

## Processes and worktrees at time of writing

Worktrees under the session scratchpad: `wt-h0-lane3b` (lane 3b), `wt-h-lane1` (item H lane 1),
`arms-h-codex/tree`,
`arms-h-grok/tree`, `wt-itemg` (item G, `lane/wake-liveness`, paused behind H, I and J), `wt-itemh`
(`spec/h0-link-join`). The antigravity scratch worktree of this repo was removed. A local Supabase
(Docker) is running, started by the lane 3a Maker; lane 3b uses it, and nothing else may.
