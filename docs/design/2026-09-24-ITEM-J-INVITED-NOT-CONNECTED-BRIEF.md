# Item J brief: "invited, not connected" is visible (2026-09-24)

Written by CSwarmDevLead. Backlog row: brain `app-backlog`, item J. Order (Strategist, 2026-09-24): I (done, 0.1.75),
H release 2 (released 0.1.76; done-test waits for the operator), then J, then G.

Backlog text: "The app roster and `cswarm members` show a seat whose connect code or token was issued but whose setup
never completed, with the age and the last setup error the CLI reported; clears on the first successful `cswarm check`.
Done: issue a code, do not run setup: the seat shows invited-not-connected within one minute with the age; complete
setup: it clears; a failed checksum shows the error text."

## What is true today (origin/main d85359ee; mapped read-only)

- Classic path (`create_agent_principal` then `mint_agent_token`, used by the app's "Add an agent"): the principal
  exists at creation; token, run and grant at mint. The app's "Pending access" rows already show a minted token with
  `first_used_at IS NULL` (site/src/lib/pending-access.ts, read edge `renewal_grants` -> `swarm_read.renewal_grant_roster`).
  A principal with no token yet shows nowhere (the roster joins grants).
- H0 link-join and `cswarm mcp code`/`connect` (0.1.76): minting writes only `swarm.agent_join_credentials` (plus a
  hidden registrar principal excluded from every read view). No seat exists until `register_agent_seat` succeeds. Join
  credentials and attempts are readable only by `swarm_command`: no member can see an issued, unredeemed code.
- "Connected" = `agent_tokens.first_used_at`, stamped on the first authenticated agent call of any kind
  (supabase/functions/_shared/agent-auth.ts). Any first read, command or poll clears it, not only `cswarm check`.
- `cswarm members` uses the read edge `members` resource, needs an agent credential, and lists live principals only.
- No "last setup error" is stored anywhere, and the CLI sends none: every pre-connection failure
  (`connection_invalid`, `token_checksum_invalid`, `join_credential_invalid`, `register_outcome_unknown`, ...) is printed
  locally only. `submit_feedback` needs a live agent principal, so it cannot carry them.

## Decisions (proposed)

1. **One pending list, two sources, server-side.** A new `swarm_read` view (RLS: workspace members) returns pending
   entries: (a) classic tokens with `first_used_at IS NULL`, not revoked, not expired, plus principals with no token
   yet; (b) join credentials that are unexpired, unrevoked and have `seats_used < seat_cap`, with their age, expiry,
   seats used / cap, and issuer (no secret, no hash, no locator). A new read-edge resource serves it to a human session
   (the app) and to an agent credential of the same workspace (`cswarm members`). Migration + read-edge change = a box
   release through HezLead and Anvil (`deploy/RELEASE-TO-BOX.md`).
2. **The app roster** shows those entries as "Invited, not connected · <age>" in the existing pending section, and they
   clear when the token is first used or the credential is used up, revoked or expired (the existing poll picks it up
   within one minute; the lane measures it). **`cswarm members`** adds an "Invited, not connected" section.
3. **"Connected" stays `first_used_at`** (the first authenticated call of any kind). The backlog's "first successful
   `cswarm check`" is narrower than what the server records; the brief states the wider, true rule.
4. **Last setup error — needs your ruling (see below).**

## Ruling needed (Strategist)

The "last setup error" needs a report from a CLI that has NO working credential yet (for example a broken checksum).
(A) **Ship J without it now**: pending entries with age, clear on first use; the setup-error text becomes its own
item. No new unauthenticated surface. RECOMMENDED: it delivers the 14-minute-silence fix, and keeps an abuse surface
out of this release.
(B) **Include it**: a report keyed on what the CLI still holds — the join credential for H0/MCP codes (a hash the
server can check), or for a classic connection file the (principal id, token id) pair, which the server cannot
authenticate. It would accept only a fixed set of error codes (no free text), be rate-limited per IP and per id,
alert rather than lock (SWARM-CLOUD.md), and never reveal whether an id exists. Anyone who learns a principal id and
token id could still set a false code on that pending seat.
