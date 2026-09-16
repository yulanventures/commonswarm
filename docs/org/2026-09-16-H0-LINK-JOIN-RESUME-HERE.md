# Resume here — item H0, link-join and long-poll (2026-09-16)

Written for a cold successor. Refs are hashes. Read this before re-deriving anything.

## What H0 is

Operator ruling 2026-09-14, top priority: fast-follow Plasma AI's Radio. A fresh Claude Code, Codex,
and Grok session each join a workspace from ONE pasted message, with no install and no typed token,
then read, post, and reply. Production controls per path.

Spec of record: `docs/design/2026-09-15-H0-LINK-JOIN.md` at **v10, `394fef2f`**, on branch
`spec/h0-link-join` (NOT on main). CSwarmStrategist ruled "A": no more spec versions; the three open
mechanism questions in §7 are closed by lanes, with evidence from running code.

## STATE: FOUR LANES WRITTEN, THREE ON MAIN, NOTHING DEPLOYED

| lane | what | where | pair |
|---|---|---|---|
| 1 | seven-verb table + generated agent document | main `13e6d8fc` | grok PASS, antigravity PASS |
| 2 | `supabase/functions/h0/` edge function serving the document | main, `24b1df45` through `36383bd4` (4 commits) | grok PASS, antigravity PASS |
| 4a | the paste a human copies (`src/h0/paste.ts`) | main, `de7f1389` through `5cd5e91b` (6 commits) | antigravity PASS, grok PASS |
| 3a | agent-join credential: table, mint, revoke, hidden registrar | `lane/h0-join-credential` `a7741ca3` | IN REVIEW (grok + antigravity dispatched) |

`main` = `5cd5e91b`. CI (agent trailers, commit identity) green on each landing.

**LIVE vs WRITTEN.** Nothing in H0 is live. The h0 function is not deployed. No H0 migration is
applied to production. No npm release carries H0. The paste is not wired into the app — the live
invite copy is still `dashboardAgentPrompt` (`site/src/components/connect/agent-prompt.ts`), called
at `site/src/components/connect/AgentConnect.astro:721`.

Each lane directory under `docs/evidence/2026-09-15-h0-lane1/`, `…-h0-lane2/`, `2026-09-16-h0-lane4/`
holds the arm outputs and a `LANDING.md` recording the pair, accepted gaps, and corrections to commit
messages (messages are immutable, so corrections live there).

## NEXT, in order

1. **Land lane 3a** once its pair returns. Its commit message says the full `test:p1-server` suite
   has NOT passed in one run: two runs failed on DIFFERENT tests with local-stack transport errors
   (gateway "invalid response", socket "other side closed"), and each failing file passed alone.
2. **Lane 3b: registration.** The atomic fold in ONE transaction: attempt row keyed
   `(join_credential, attemptId)` + seat consumed (`seats_used`, schema already caps it) + principal
   + device + run + renewal grant + token. Attribution to the credential's REGISTRAR principal and
   run. Retry with the same `attemptId` replaces an UNUSED token only. Spec §5.
   **DO NOT run a Maker that resets the local database while any server test is running against it.**
3. **Poll and ack.** Fence seam, ruled by the Strategist: refuse the listener claim for H0 seats at
   the single caller of `claimAgentInbox`, `supabase/functions/command/index.ts` claim branch (was
   `:8597`), and prove an H0 seat's claim is refused while its ack succeeds. Per-message ack carries
   message id + effect ordinal (SWARM-CLOUD.md:470).
4. Wire the paste into the app's "Invite an agent" flow; release; deploy; run the three-host done-test.

## DEFERRED OR ACCEPTED, stated so nobody rediscovers them

- Recipient `id` is `format: uuid`; the server's `CHAT_UUID_RE` also requires version [1-8] and
  variant [89ab], and is deliberately module-local. Agents take ids from server responses.
- `swarm_read.agent_runs` and `swarm_read.my_devices` are `SELECT *` views; any column added to those
  tables later would be published by a re-creation. Today their live columns match the originals.
- The paste guard refuses 12+ consecutive secret characters; shorter pieces pass by design.
- `tests/support/host-stderr-exit-parity.ts` has a 1300 ms wall-clock ceiling that failed six times
  across three providers in two days, all under load, all passing on rerun. Filed as its own task.

## NOT ESTABLISHED

- Any H0 path on production. The three-host done-test.
- Whether two sentences are enough for each host to register unprompted.
- A green full `test:p1-server` run on lane 3a.

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

Worktrees under the session scratchpad: `wt-h0-lane3` (lane 3a), `arms-h-codex/tree`,
`arms-h-grok/tree`, `wt-itemg` (item G, `lane/wake-liveness`, paused behind H0), `wt-itemh`
(`spec/h0-link-join`). antigravity also created a worktree of this repo at
`~/.gemini/antigravity-cli/scratch/commonswarm`; remove it when its reviews are done. A local Supabase
(Docker) is running, started by the lane 3a Maker.
