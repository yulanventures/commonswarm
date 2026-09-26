# Item G lane G3e: presence in `cswarm members` and the app roster (landed 2026-09-26)

Brief: `docs/design/2026-09-26-REST-OF-G-BRIEF.md`, section G3e (Tincan T1).

- Lane commit `4f970237` (Alloy task `6cc944b064a1429d`: Codex Maker; Grok 4.7 Checker PASS), authored by the lead.
- `cswarm members` (text and JSON) and the app roster read `swarm_read.agent_presence` and show the classifier's wake
  kind, last call, escaped client build and "update available". An old server without the view: the CLI prints one
  "presence: not available on this server" line; the roster shows nothing new.

## Gates

| Gate | Result |
|---|---|
| mini `gates` at `4f970237` | exit 0; `npm test` 1031 of 1031 |
| Actions site suite 36272632013 at `4f970237` | 569 of 585; the 15 failures are main's known set (0 new) |
| mini `p1-cli` | with the T3b landing (a p1-cli run cannot overlap a running Alloy task) |

## Release

Needs the G3d server (view) live: the box window after 2b. The roster and CLI degrade quietly on an older server.
The live control (one production seat per wake kind; a seat on an older build shows "update available") follows that
window.
