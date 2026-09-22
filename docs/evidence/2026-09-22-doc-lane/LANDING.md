# Doc lane landing: production is the box (2026-09-22)

Lane `lane/doc-box-production`, five commits by a Grok Maker: fcc04050 (docs), e6c30851 (CLI strings and tests), 803117ff,
aaa8a914 and f4ab3394 (review folds). Merged to main with `git merge --no-ff`. It retires every instruction and claim that
the move to the box made false: the hosted Supabase project `cloud-swarm-dev` and the Vercel project `coswarm-site` are
deleted, and production is the one server `yulan-vps-1`.

## What changed

- A read-only Grok pass listed 76 false statements (`CLAIMS.md`, with the research in `arms/grokResearch.md`); the Maker
  and the review rounds brought the list to 105 rows. Every row has a Result: fixed, or "deferred: owner decision" for the
  six rows on `site/src/pages/privacy.astro`, which this lane did not touch.
- AGENTS.md: "cloud-swarm-dev IS PRODUCTION" became "Production is the box", with the commands never to run for
  CommonSwarm; the site deploy section is `deploy/site/deploy.sh`. Runbooks, README, SECURITY.md, the spec and the edge
  docs now describe the box. SUCCESSION-PLAN.md opens with a notice that it is history.
- Where no procedure exists (how a schema migration, and how a new stack or edge version, reach the box) the documents say
  "Not established" and point to the newest resume file. Nothing was invented.
- Code and tests: capability links default to https://commonswarm.com and refuse the deleted Vercel host; the CLI help says
  the `/see` page is not built (it returns 404). An invite link naming the deleted supabase.co host is refused with a
  message asking for a new invite. The `--url` and no-target messages name the service base URL and
  https://api.commonswarm.com. The command and capability edge functions default to commonswarm.com when their origin
  setting is empty.
- Site: `site/public/llms.txt` and `site/public/api.md` point agents at commonswarm.com and api.commonswarm.com.
- Caddy: the maintenance file's public site answers 503 with no upstream; the old fallback file and the pre-cutover edge
  Caddy file are deleted; a test fails if any `deploy/**/*.caddy` names a supabase.co host; the Caddy tests pin each
  route's port. The live API file changed in comments only.

## Review (arms/), antigravity and Codex (Grok Maker)

| round | SHA | antigravity | Codex |
|---|---|---|---|
| 1 | e6c30851 | PASS 3 of 4; D2 FAIL refuted (the named test passes 3 of 3; the other change is inside a comment) | FAIL: llms.txt, edge CORS defaults, site README path (all confirmed) |
| 2 | 803117ff | PASS 4 of 4 | FAIL: the maintenance file still routed to the deleted host during a recovery; SUCCESSION-PLAN.md still told leads to deploy to it (both confirmed) |
| 3 | aaa8a914 | PASS 5 of 5 | FAIL: the spec's firewall rows named `*.supabase.co`; the Caddy test did not pin each route's port (both RIGOUR, folded in f4ab3394) |

Measured on the box during review: the command edge's own origin setting names only commonswarm.com, and the capability
origin setting is empty with capability URLs off, so the stale CORS defaults were not a live exposure.

## Gates

At aaa8a914 (lead): build 0; npm test 895; test:p1-cli 824; check:tests 0; check:edge 0; build-release 0; site build and
test 547 pass; diff-check 0. At f4ab3394 (Maker): build 0; npm test 895; test:p1-cli 824; check:tests 0; diff-check 0.
The merge with main is gated again before the push.

## Not deployed by this landing

- The site files (llms.txt, api.md) go live with the next site deploy (`deploy/site/deploy.sh`).
- The CORS defaults go live with the next edge release; the CLI strings with the next npm release.
- The brain topic `releases` was corrected separately (version 4, only the 15 false lines).

## Not established

- The privacy page: owner decision pending (facts and the data-transfer wording).
- How a schema migration, and how a new stack or edge version, reach the box.
