# Item J landing: "invited, not connected" is visible (2026-09-24)

Branch `lane/item-j` from main `e9fe4fe8`, tip `68754c27`, merged with `git merge --no-ff` (merge `3fe2b6db`). Spec:
`docs/design/2026-09-24-ITEM-J-INVITED-NOT-CONNECTED-BRIEF.md`, option A (Strategist ruling 2026-09-24: no setup-error
text; that becomes its own item). The Maker's record, fold by fold, is `LANE.md` here.

## What it does

- A new `swarm_read.pending_access(workspace)` (migration `supabase/migrations/20260924000001_pending_access.sql`)
  returns, for members of that workspace only, two kinds of pending entry, with exactly ten columns and no hash, secret,
  locator or token:
  - classic: a live principal whose owner is still a member, with no used token, and either a live unused token or no
    token at all (a revoked or expired sibling token does not hide it); age and expiry come from its newest live token;
  - join code: an unexpired, unrevoked H0 / `mcp code` join credential with a free seat, whose issuer is still a member.
- A read-edge resource `pending_access` serves it to a human session (the app) and to an agent credential of the same
  workspace (`cswarm members`). Another workspace's caller gets nothing and no existence signal.
- The app's People and agents dialog shows "Invited, not connected · <age>" beside the existing per-token Pending access
  rows (unchanged, with Cancel), at every width: the rail's own pending details were removed in b7977ad3, so the dialog
  section is the only pending surface. `cswarm members` prints an "Invited, not connected" section and a `pending`
  array in `--json`.
- An entry clears when the server records the first use (`agent_tokens.first_used_at`, the first authenticated call of
  any kind), or when the code is used up, revoked or expired, or the principal is revoked.
- If the pending read fails (an edge without the resource, 5xx, network), `cswarm members` and the app still work and
  say "Invited, not connected: could not load".
- Box-release proofs for RELEASE-TO-BOX.md section 5: `deploy/release-proofs/item-j/20260924000001-catalog.sql` (checks
  the installed function's shape and body digest) and `...-functional.sql` (a member sees at least one seeded row, a
  caller without member identity sees none). The Opus arm made each fail for its stated reason on the local database.

## Release order (required)

The migration and the read edge reach the box FIRST (RELEASE-TO-BOX.md, `KIND_LIST` including the edge), then npm
(cswarm) and the site. Until then `cswarm members` and the app show "could not load" for the pending section. The
functional proof needs a live pending row on the box: HezLead seeds a join code (at most 24 h old) close to the window.

## Review (D-036)

Maker: Codex gpt-6-sol (a direct `codex exec` lane). Lead fixes: c26b98a7 (server-test Result comparison; timeout row),
281595e0 (desktop observer discriminates; comment), 68754c27 (LANE.md). Checker: Claude Opus 5.5 (measured on the local
stack). Second arm: Grok 4.7. Reviews and prompts: `arms/`.

| Round | SHA | Opus | Grok |
|---|---|---|---|
| 1 | c26b98a7 | FAIL (a revoked/expired sibling token hid a live invite; app lost per-token rows; test gaps; proofs missing) | FAIL (same SQL defect) |
| 2 | a1ef90ff | PASS (findings ruled in scope) | PASS |
| 3 | 90467bbf -> 281595e0 | PASS (fold 2 and the lead's commit) | PASS (90467bbf; the lead's 281595e0 is a comment and a test) |

## Gates on the merged tree (lead, 3fe2b6db)

build 0; npm test 962/962; test:p1-cli 929/929; check:tests 0; check:edge 0; `npm run build:command-core && git diff
--exit-code supabase/functions/_shared/protocol.js` 0; test:p1-server 243/243 (local stack reset with this migration);
build-release 0; site build 0; site test 573 pass, 1 skipped (includes the rendered 600px / 1200px width test);
diff-check 0.

## Not established

- The box release itself (HezLead directs, Anvil applies) and the proofs under the box's database role.
- The done-test on production: issue a code, see "invited, not connected" with its age within one minute, connect, see it
  clear.
- Production query plans (measured locally 2.4-5.6 ms at about 3.8k agents and 3.1k credentials; no new index).
- Follow-ups: the server test runs the catalog-digest check before the behaviour checks (reorder it); the setup-error
  text is its own item (Strategist).
