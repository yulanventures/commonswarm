# N-site cutover: commonswarm.com and www served by yulan-vps-1 (2026-09-16 23:01Z)

GO: Strategist a8686a4e (22:42Z). Records applied by HezLead (zone commonswarm.com, holder of the DNS rights).

## Change

| record | before | after | at |
|---|---|---|---|
| commonswarm.com (id 192de44b) | A 76.76.21.21, DNS-only, TTL auto | A 178.105.29.28, proxied, TTL auto | 23:01:38Z |
| www.commonswarm.com (id ded0fb0d) | A 76.76.21.21, DNS-only, TTL auto | A 178.105.29.28, proxied, TTL auto | 23:01:38Z |

MX and TXT on the apex untouched (HezLead listed them after). Cache purge by host for both names at 23:01:39Z. Zone
settings changed by HezLead earlier (22:36Z): Browser Cache TTL = Respect Existing Headers; SSL = Full (strict). The box
serves release 20260916T223546Z-8cd2ba3c with a Cloudflare Origin CA certificate (SAN *.commonswarm.com, commonswarm.com).

## Pre-switch controls

- Vercel served www as 200 (no redirect), so the box serving www directly matches.
- sha256 of /install.sh, /llms.txt, /skills/cswarm/SKILL.md and /start on Vercel equalled the box's site-staging copy.
- Negative control of the path probe: through Vercel `x-vercel-id` present; forced through a Cloudflare IP before the
  switch, Cloudflare still answered from Vercel (`x-vercel-id` present, `cf-ray` present), so the probe can fail.

## Post-switch controls, 23:02:09Z: 18/18 PASS

Log: cutover-controls-2026-09-16T2302Z.txt. Public DNS on Cloudflare for both names; `/` on both names 200 with no
`x-vercel-id` and a `cf-ray` (box path); the four files byte-identical to Vercel's pre-switch copy; the AGENTS.md list
(/ 200, /install.sh 200, /nope.sh 404, /app 200, /start `commonswarm:url` = https://api.commonswarm.com, no service_role
JWT, /acceptable-use names 600); strict parity 111/111 on apex and on www; `cswarm check` x3 exit 0 (api path, unchanged).
Listener wake: HezLead's reply 9a6e9417 created 23:02:00.338Z, surfaced at the lead's next turn, read 23:02:09Z.

## Rollback

Both records back to A 76.76.21.21, DNS-only, TTL auto. Vercel project `coswarm-site` stays deployed and untouched until
the operator confirms deletion.

## Not established at this commit

- GitHub sign-in returning to /app on the box: the Strategist runs it in the operator's Chrome.
- Resolver caches: clients that cached the DNS-only answer see Vercel for up to 300 s after 23:01:38Z; both serve the
  same bytes.
