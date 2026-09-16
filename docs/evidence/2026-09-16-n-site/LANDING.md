# N-site landing: the marketing site and app served from yulan-vps-1 behind Caddy (2026-09-16)

Lane `lane/site-on-box`, reviewed tip **8cd2ba3c** (Codex gpt-5.6-sol high as Maker, four fix rounds, three lead
commits: 97ab1455, 8e618e37, ef24893a). Landed with `git merge --no-ff 8cd2ba3c`, so the exact reviewed SHA is in
history.

## What is LIVE and what is not

- LIVE on the box, no public traffic: release `20260916T223546Z-8cd2ba3ca189-b4efb4d81fea174c` at
  /srv/commonswarm/site/current; /etc/caddy/sites/20-commonswarm-site.caddy serves commonswarm.com, www and
  site-staging.commonswarm.com (validated with the exit code checked, reloaded, active).
- NOT moved: commonswarm.com and www still resolve to Vercel (A 76.76.21.21, DNS-only). Vercel remains the live
  site until the DNS step in deploy/site/RUNBOOK.md runs.

## Review pairs (outputs in arms/)

| round | SHA | antigravity | grok |
|---|---|---|---|
| 1 | 81c81f3d | FAIL (findings 1-2 refuted by grok's live Caddy run) | PASS (65/65 parity on Caddy 2.11.4) |
| 2 | 97ab1455 | FAIL (runbook tooling; ruled RIGOUR) | — |
| 3 | ef24893a | PASS | FAIL (PRODUCTION: `/install.sh/` 400 on Caddy, 200 on Vercel) |
| 4 | 568b9490 | PASS | FAIL (`/install.sh/foo` and other paths through a real file: 400 on Caddy, 404 on Vercel) |

Fix round 4 (33770df3, 8cd2ba3c) closes the round-4 finding: file-descendant 400s become the Vercel-shaped 404, and the
reference gained the five measured routes (`/install.sh/foo`, `/llms.txt/x`, `/og.png/x`, `/index.html/foo`,
`/fonts/inter-latin.woff2/x`). Mutation: removing the normalization makes live local Caddy parity exit 1 with 15
differences. Per the pacing rule the fold lands without another pair; its evidence is the live parity below.

## Controls at 8cd2ba3c

- Maker gates: build 0; `npm test` 0 (875); `test:p1-cli` 0 (736, one earlier run failed a four-second timing test
  under host load and passed on retry); `check:tests` 0; clean site build 0; site tests 0 (547); `git diff --check` 0.
- Local Caddy 2.11 parity: 111/111 routes.
- deploy.sh to the box: exit 0.
- Live parity through Cloudflare on site-staging.commonswarm.com, STRICT (no `--allow-cloudflare-browser-ttl`), after
  HezLead set the zone's Browser Cache TTL to Respect Existing Headers and SSL to Full (strict) at 22:36Z:
  **111 routes passed** (83 fixed, 14 discovered assets / 28 asset routes).
  Log: parity-live-site-staging-8cd2ba3c-strict.txt.

## Not established

- The site through Cloudflare on the production names (commonswarm.com, www): DNS has not moved.
- A browser GitHub sign-in that returns to /app served by the box.
- Behaviour under Vercel-only features the reference does not record (for example Vercel's image optimizer or
  analytics endpoints); the reference covers the 83 fixed routes and every asset the served HTML references.
