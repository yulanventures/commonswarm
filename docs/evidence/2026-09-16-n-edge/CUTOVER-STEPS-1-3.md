# N-edge cutover, steps 1-3 (2026-09-16) — Strategist GO 15b462c0

1. **Land:** merge 0a04de20 of the reviewed SHA 70d17d08; evidence 486143d2.
2. **DNS switch at 2026-09-16T22:07:58Z:** api.commonswarm.com CNAME ukezjcnxjvkpkeezxaew.supabase.co (DNS-only) →
   A 178.105.29.28, proxied, TTL auto (Cloudflare record 6f7dc08041c08c0d622a62130ba82a9d). A first attempt at 22:06:42Z
   was REFUSED by Cloudflare (record comment over 100 characters); the read-back confirmed nothing changed.
   Public resolvers (1.1.1.1, 8.8.8.8) returned the zone's Cloudflare IPs immediately.
3. **Path proof:** the h0 document (served ONLY by the box) through api.commonswarm.com returned 200 at 22:09:17Z, about
   80 s after the switch — also through the mini's system resolver, with the h0 function's x-robots-tag. So while
   Supabase's custom hostname is still ACTIVE, Cloudflare routes api.commonswarm.com to our proxied record (the box).
   Before the switch the same check returned 404 (negative-control-pre-switch.log).
4. **Step-3 controls through the box (step3-controls-2026-09-16T2210Z.log): 14/14 PASS** — h0 200; CLI members 2.73 s,
   feed 2.51 s, receipt 2.14 s; file put 13.20 s, get round trip identical 9.52 s, rm; Realtime subscribe 1180 ms and
   broadcast 1386 ms; /auth/v1/health 200, /auth/v1/settings 200, /storage/v1/status 200, /rest/v1/ 401; site /start
   publishes api.commonswarm.com. Edge container healthy, 194 MiB / 512 MiB, 0 restarts.
   Site controls (still Vercel): / 200, /acceptable-use 200 (600 present), /install.sh 200, /nope.sh 404, /download 200,
   /start commonswarm:url non-empty, no service_role JWT.
   File put/get are ~4x slower through the box than through Supabase (13.2 s / 9.5 s vs 3.3 s / 1.9 s pre-switch),
   no client timeout.
5. **STOPPED after step 3** as ruled. Step 4 (deactivate the custom domain) waits for the Strategist's Google GO.
   Rollback now = restore the CNAME only (window/rollback-put-body.json).
NOT ESTABLISHED: a seat's listener wake round trip through the box (the Realtime broadcast probe is a proxy for it);
a GitHub sign-in through the box path.
