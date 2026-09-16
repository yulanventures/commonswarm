# Supabase's Cloudflare blocks proxied requests that carry CF-Connecting-IP (measured 2026-09-16 ~21:00Z)

Found while re-checking lane edge-runtime-box 8f38a55e on the box: through edge-staging.commonswarm.com (our
Cloudflare → Caddy on yulan-vps-1 → https://ukezjcnxjvkpkeezxaew.supabase.co), /auth/v1/health, /auth/v1/settings and
/storage/v1/status returned **403 "Attention Required | Cloudflare"** served by Supabase's Cloudflare edge
(cf-ray ...-FRA from the box). Realtime websockets still subscribed. At 76487b81 the same routes had been checked only
from the box's loopback, which sends no Cloudflare headers — so the defect was present from the first version and
invisible to that check.

Direct curl from the box to .../storage/v1/status, one header at a time: 200 with none; 200 with X-Forwarded-For
(public 172.67.1.1, box 178.105.29.28, 127.0.0.1, 10.0.0.1), X-Forwarded-Host, X-Forwarded-Proto, CF-Ray, CF-Visitor,
CF-IPCountry, CDN-Loop, True-Client-IP, X-Real-IP; **403 with `CF-Connecting-IP: 8.8.8.8`**.

Bisect with throwaway `caddy:2.11` containers on the box (loopback ports, live config untouched):

| Caddy Supabase-origin form | plain | with CF-Connecting-IP / Cloudflare-shaped headers |
|---|---|---|
| Host rewrite only (76487b81) | 200 | 403 |
| Host + XFH + XFP + `X-Forwarded-For {http.request.client_ip}` (8f38a55e) | 403 | 403 |
| same without the XFF override | 200 | 403 |
| strip CF-Connecting-IP and X-Forwarded-For | 200 | 200 |
| strip CF-Connecting-IP, CF-Ray, CF-Visitor, CF-IPCountry, CDN-Loop; default XFF; XFH + XFP | storage 200, auth health 401 (no apikey) | storage 200, auth health 401 |
| same with `X-Forwarded-For {http.request.header.CF-Connecting-IP}` | 200 / 401 | 200 / 401 |

Consequence if shipped: after the DNS cutover every browser and CLI call to /auth/v1, /rest/v1 and /storage/v1 would get
403 — sign-in broken. Fix sent to the Maker as N-edge fix round 4 (strip the Cloudflare request headers on
Supabase-origin routes; keep Caddy's default X-Forwarded-For).
NOT ESTABLISHED: whether Supabase Auth's per-IP rate limits read the left of the X-Forwarded-For chain.
