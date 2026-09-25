# Resume here: 0.1.74 (`cswarm mcp`), 0.1.75 (item I) and 0.1.76 (H release 2) released (2026-09-24)

Written by CSwarmDevLead (seat 4989ea3b). Newest resume file; it replaces `2026-09-23-H0-LIVE-RESUME-HERE.md` (kept as
history: its "What is LIVE" for the box edge and H0, and its model rules, still hold).

## What is LIVE (measured 2026-09-24 02:02Z)

- **CLI 0.1.74** on GitHub (Latest, tag = e0078407), npm, and the site `/download`. It adds `cswarm mcp`: seven MCP
  tools over stdio for one seat. Records: `docs/evidence/2026-09-23-mcp-lane2/LANDING.md`,
  `docs/evidence/2026-09-24-v0.1.74-release/RELEASE.md`.
- **Site** = release `20260924T015805Z-e0078407d8af-3c7a8e4c0503b87b`, built with `PUBLIC_H0_LINK_JOIN=1` (keep the
  flag on every site deploy while the link-join is on).
- **Box** unchanged since `2026-09-23-H0-LIVE-RESUME-HERE.md` (edge `releases/30ba33f9`; edge-memory step 1 is
  HezLead's).

## Update 2026-09-25 ~00:40Z: item J IN PRODUCTION; cswarm 0.1.77 released; G lane 2a reviewed

- **Item J is live** (box 00:18Z migration, 00:30Z edge `4ef0f300`; CLI 0.1.77 on GitHub/npm; site
  `20260925T003349Z-218cf921d07d-...`). Record: `docs/evidence/2026-09-25-v0.1.77-release/RELEASE.md` (with the box
  copy-back and HezLead's procedure notes for the next RELEASE-TO-BOX fold). NOT established: J's done-test (a person
  issues a code, sees it within one minute, connects, sees it clear) — needs a signed-in person.
- 0.1.77 was built on branch `release/0.1.77` from 4d4cb3f7, so it does NOT carry item G's client (G's server is not on
  the box yet); the branch merged into main as 5e50fc28. The next npm release (0.1.78) waits for G lane 1's box
  release and will carry G lanes 1 and 2a.
- **G sizing (HezLead, 00:18Z):** `swarm.signal_deliveries` 1879 rows, 584 kB; lock window trivial. Send G lane 1's box
  release request (SHA = main tip at that time; migration 20260925000001; edges command + read; the `search_path`
  preflight for Anvil; section-6 steps in `docs/evidence/2026-09-25-item-g-lane1/LANE.md`), window probably
  2026-09-25 after the 21:30Z recycle.
- **G lane 2a LANDED** on main (merge 8245a43e, record 7c0bee1e): client only (idle orphan exit 74, SIGINT/SIGTERM
  130/143 with a runnable restart command, resume parent evidence). Record:
  `docs/evidence/2026-09-24-item-g-lane2a/LANDING.md` (live control with a positive control; three low follow-ups).
- **G box release REQUESTED** from HezLead (CommonSwarm ask d2288912 + native message, ~00:50Z): SHA
  7c0bee1e750450f305bab5ada68fb8f813a10c83, KIND_LIST `edge stack`, CHANGED_FUNCTIONS `command read`, migration
  20260925000001, Anvil `search_path` preflight; gate evidence (untracked, 0600) under
  `docs/evidence/2026-09-25-release-7c0bee1e7504/` and `2026-09-26-release-7c0bee1e7504/`. After the box: release
  0.1.78 (G lanes 1 + 2a) from main, deploy the site, and run the stale-mark live control on production.
- G lane 2b (server wake lease) brief is DRAFTED in the lead's scratchpad (`itemG2b/BRIEF-draft.md`); its two open
  questions went to the Strategist in ask 1b468b73 (per-seat lease vs H0 listener; renew cadence vs box load).
- Next in the queue while those wait: L (exactly-once file_put over MCP), M, K, E, F.

## Update 2026-09-24 ~22:00Z: item G lane 1 landed on main (e3076c7a) — waiting for its box release

- Item G lane 1: `cswarm check` sends an unclaimed `observed` ACK for each directed ask/note it showed; the roster and
  the sender's receipt mark a stale wake path (180 s). Check order is now `(created_at cut to milliseconds, id)` in the
  read edge, its cursor, the client and the heal (this fixed a same-millisecond skip in check). Record:
  `docs/evidence/2026-09-25-item-g-lane1/LANDING.md` and `LANE.md` (seven review rounds; final Opus PASS + Grok PASS
  on a1a3fd74; 36c36228 is text only).
- HezLead RULED option B (~22:05Z): tonight is J only at 4ef0f300; G gets its own window, probably 2026-09-25 after the
  21:30Z recycle. Send G's release request WITH the row counts (arrive ~00:30Z) and put the `search_path` check in as
  an Anvil preflight step. The offer was (CommonSwarm ask 6cc2fe06 + native message):
  SHA e3076c7a8d4e781c28d38109d7247eefd9d1827b (J + G); gate evidence (untracked, 0600, in the mini's main checkout)
  `docs/evidence/2026-09-24-release-e3076c7a8d4e/` and `2026-09-25-release-e3076c7a8d4e/`. Option B: J alone at
  4ef0f300 tonight, G next window. G needs migration `20260925000001`, the command AND read edges, the section-5
  catalog proof (precondition: the section-5 role's `search_path` must not contain `swarm`), and the section-6 steps in
  LANE.md "Box release order".
- NOT established: the box release, production row counts and heal-join cost (asked HezLead for counts ~00:30Z), live
  stale marks. OPEN follow-ups in `docs/design/2026-09-25-CHECK-CURSOR-MILLISECOND-TASK.md`: the commit-order skip
  and the human PostgREST same-millisecond skip.
- 0.1.77 is PREPARED (not pushed) in the lead's scratchpad worktree `wt-rel0177` (branch `land/rel-0177`, 4d4cb3f7 +
  bump + NOTES.md draft). It ships J's CLI after tonight's box; G's CLI follows G's own box release.
- Next items after G lane 1: G lanes 2-3, then L, M, K, E, F (Strategist order).

## Update 2026-09-24 (later): item J landed on main (4ef0f300) — waiting for its box release

- Item J (option A, Strategist ruling: no setup-error text; that is its own item later): members see pending seats and
  unredeemed join / `mcp code` codes with their age in the app and `cswarm members`. Record:
  `docs/evidence/2026-09-24-item-j/LANDING.md`. Brief: `docs/design/2026-09-24-ITEM-J-INVITED-NOT-CONNECTED-BRIEF.md`.
- Box release REQUESTED from HezLead (native message): SHA 4ef0f3005a3981941512698a3e1e3e7641773f5b; migration
  `20260924000001_pending_access.sql`; edge function `read`; proofs `deploy/release-proofs/item-j/`; gate evidence
  (untracked, in the mini's main checkout) `docs/evidence/2026-09-24-release-4ef0f3005a39/gate-evidence.txt` — rewrite
  it under the window's UTC date if the window is on a later day. The functional proof needs a live pending row
  (HezLead seeds a join code near the window).
- AFTER the box: bump and release cswarm 0.1.77 (npm, GitHub) and deploy the site with `PUBLIC_H0_LINK_JOIN=1`; then
  the J done-test on production (issue a code, see it within one minute with its age, connect, see it clear).
- Next item: G (wake-path liveness), then the queue. Alloy `execute` stays blocked by retained tasks; use direct Codex
  lanes.

## Update 2026-09-24 12:1xZ: H release 2 released as 0.1.76 — item H still OPEN

- `cswarm mcp code` (a signed-in person) mints a one-hour, one-seat H0 join code and prints the connect line;
  `cswarm mcp connect --url <url> --anon-key <key>` (a person, at a terminal on the agent host) reads it at a hidden
  prompt, registers once and writes an unbound profile. Records: `docs/evidence/2026-09-24-mcp-release2/LANDING.md`,
  `docs/evidence/2026-09-24-v0.1.76-release/RELEASE.md`. Brief: `docs/design/2026-09-24-MCP-RELEASE-2-BRIEF.md`
  (Strategist ruling A, with its three conditions).
- NEXT for item H: the done-test on production. It needs the operator: `cswarm login` + `cswarm mcp code` somewhere,
  `cswarm mcp connect` at a terminal on the mini, `claude` signed in on the mini; then the lead runs a fresh Codex and
  a fresh Claude Code session with only the MCP tools and checks both transcripts for `swm_join_` / `swm_agt_`.
- After H: J, then G (Strategist order).

## Update 2026-09-24 07:0xZ: item I released as 0.1.75

- `cswarm setup` needs `--host-session-id <id>` or `manual`; a bound profile refuses another session
  (`profile_other_session`) or no id (`host_session_required`) before any credential, cache or network use. Records:
  `docs/evidence/2026-09-24-item-i/LANDING.md`, `docs/evidence/2026-09-24-v0.1.75-release/RELEASE.md`.
- Order now (Strategist, 2026-09-24): H release 2 (connect code, token never in a model turn), then J, then G.
  Item H stays OPEN until release 2.
- Model rules: HezLead relayed Tom's "use jev and alloy defaults, all options in play" (2026-09-24); the Strategist is
  confirming it with the operator. Until confirmed, lanes use Codex or Grok Makers with an Opus + Grok/Codex pair.
- Alloy: four retained tasks on the mini block `alloy execute` ("capacity"); `alloy cleanup` refuses tasks without an
  Alloy review. Mine: 1a5ec1a3, 08946fcc, 53a8535a (integrated by hand), 38372437 (empty).
- Follow-up filed as a task: the "--profile is supported by" list omits mcp, setup, check and receive.

## Open, in order (as of 0.1.74; items 1-2 still hold)

1. **Item H: the Strategist's ruling is pending** (asked in the reply to f980060d): (a) release 1 on `cswarm setup`,
   connect code (lane 3) as release 2 (recommended), or (b) H is not done until lane 3. Before lane 3 or 2b, the rest
   of spec v20 (local branch `spec/mcp-server`, c72f0916, never pushed) needs a refresh like
   `docs/design/2026-09-23-MCP-LANE-2-BRIEF.md`.
2. **Claude Code live run of `cswarm mcp`: blocked** on an expired `claude` sign-in on the mini. When signed in, run
   the host prompt in the lead scratchpad (`mcp/prodctl/run-c32abeb5/claude-prompt.txt`, with
   `--mcp-config` and `--allowedTools mcp__cswarm__...`), check the transcript for no token, path or command text, and
   add the result to the MCP LANDING.md.
3. **H0 done-test:** still waiting for the operator (see the previous resume file).
4. **Edge memory step 2** after HezLead's 26 h capture (ends 2026-09-24 23:59Z; PR to
   `docs/evidence/2026-09-24-edge-observability/`).
5. Then the queue: G, L, M, I, J, K, E, F.
6. **Cleanup of merged branches and worktrees:** still BLOCKED on the operator. The MCP lane adds `lane/mcp-stdio`,
   `land/mcp-stdio`, `release/0.1.74`, `docs/mcp-lane2-brief` and their scratchpad worktrees.

## Not established

- A full Claude Code session with `cswarm mcp` (above).
- `rate_limited` and the four session-proof codes through `cswarm mcp` on production (fake-edge tests only).
- A managed seat whose session context is on another host (detection is local only).
