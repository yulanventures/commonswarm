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

## GitHub sign-in through the box-served app (Strategist 7c0d6066)

In the operator's Chrome at 23:07:19Z: /app loaded signed in (CICD roster); Sign out showed the sign-in panel (email
link, GitHub, Google); Sign in with GitHub went through GitHub and returned to /app signed in as Ridgeio in about 12 s;
roster and feed rendered. Server side (production auth schema, read-only query, timestamps and provider only):
`auth.sessions` gained one session at 23:06:54Z for a GitHub identity, and no other session in 23:04-23:10Z.
`auth.audit_log_entries` has no rows in that window. **N-site accepted as in production by the Strategist.**

## Worth knowing

- Client DNS caches outlive the switch: the mini's resolver kept the DNS-only Vercel answer until flushed. The previous
  records had TTL auto (300 s) and were not proxied, so a client can see Vercel for up to five minutes, longer if its
  resolver ignores TTLs. Both origins served the same bytes, so nothing broke. Judge a cutover through 1.1.1.1 or after
  a resolver flush (deploy/site/RUNBOOK.md now says so).

## Not established

- Behaviour under Vercel-only features the reference does not record (for example image optimization or analytics).
