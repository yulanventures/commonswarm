# Resume here: 0.1.74 (`cswarm mcp`) and 0.1.75 (item I) released (2026-09-24)

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
