# Storage upload CORS live edit: staging rehearsal (2026-10-09)

Plan: deploy/supabase-stack/STORAGE-CORS-LIVE-EDIT.md, sha256 `f8c48fe7b167fe615250ef4a6fe00a4138d92e4ead0822fc8fac87e7c86c9dec`.
Release `01ccc1fc946b6228f2879339cc068ffa2ce987a3` (main), archive sha256 `e6b8074d5071b4eedbcd0b051beb8ac49f21689e181de8cff981795a356e9b0b`; previous `ec098859df48458c3079ca55c00ab09a8bed7e27`, archive sha256 `0167241cdb54c5e44d3c093eda6afdd062974c623738d8086c3a1d2904970909`. CI 5/5 at 01ccc1fc.
Box c1-staging-20261006 (staging marker present, no 11-file), MEMBERS=10. Live 10-file before: `1d8cbfe4…` root:root 0644; it carries the C1 admin gate (admin_gate count 3).

| Window | Steps | Result |
| --- | --- | --- |
| w1 (06:33:26Z) | cors-preflight, cors-apply, cors-verify, cors-rollback, cors-close rolled-back | All PASS. Caddy reloaded twice (apply, rollback). Live 10-file back to 1d8cbfe4…, root:root 0644. Lock released. No .candidate file left. |
| w2 (06:33:5xZ) | cors-preflight, cors-close aborted | PASS; no live write. |

Verify probes in w1, against local Caddy (curl --resolve api.commonswarm.com:443:127.0.0.1, supplied CA):
- OPTIONS from https://commonswarm.com with Access-Control-Request-Method PUT: 204, ACAO = that origin, Allow-Methods "PUT, OPTIONS", Allow-Headers content-type, Max-Age 600, Vary Origin.
- The same request from a refused origin: 404 from Storage, no ACAO, Vary Origin.
- PUT with a bogus token from the allowed origin: 400, the same status as direct Storage; ACAO = the allowed origin only.
- GET on a non-upload Storage path: 400 before and 400 after.
- The outside-block hash (the C1 gate region) and the admin_gate count (3) were unchanged.

Not exercised on a real box: cors-close success, and the 11 member (staging has no 11-file). Both are covered by tests/storage-cors-live-edit.test.ts. Copyback files hold hashes and statuses only.
