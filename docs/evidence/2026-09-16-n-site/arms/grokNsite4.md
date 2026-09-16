I'll review the lane at the exact SHA: first the diff against main, then the Caddy block, deploy path, and tests. I will not contact the box, Cloudflare, DNS, or start another model.SHA matches. Next I'll read the Caddy block, deploy scripts, tests, and the two latest commits.Core files are in. Next I'll read the tests, the slash-route commit, and the reference structure.Site build copies `install.sh`. Next I’ll stand up local Caddy, probe slash/404/HEAD paths, and start the gates.CLI and site builds succeeded. Next I’ll compare dist to the reference, serve it with Caddy, and start the test gates.Local Caddy still returns 400 for `/install.sh/foo`. I’ll compare that with Vercel, then rerun the failed gate and the rest of the checks.Round-4 slash routes work. `/install.sh/`, `/llms.txt/`, and `/og.png/` are 200 on local Caddy 2.11 and on site-staging. A path that walks **through** a real file is still Caddy 400, not Vercel 404.

## PRODUCTION

**1. Caddy still returns 400 for any extra segment under a real file.**

- `deploy/site/commonswarm-site.caddy:16-17` rewrites only `^(.+\.[^/]+)/$` (a trailing slash).
- `deploy/site/commonswarm-site.caddy:55-56` maps only status 404 in `handle_errors`.

Request: `GET /install.sh/foo` (also `/llms.txt/x`, `/og.png/x`, `/index.html/foo`, `/fonts/inter-latin.woff2/x`, …).

| Origin | Status | Body |
|---|---|---|
| Vercel `https://commonswarm.com/install.sh/foo` | 404 | `The page could not be found` / `NOT_FOUND` / request id |
| This SHA, local Caddy 2.11 | 400 | empty, no Content-Type |
| This SHA, `https://site-staging.commonswarm.com/install.sh/foo` | 400 | empty, no Content-Type |

A visitor sees a blank 400. Not Vercel’s 404 text. `curl -f` still fails, but the status and body do not match.

The missing-file slash case `/__commonswarm_missing__.txt/` is 404, because that file is not on disk. The 400 happens only when an intermediate part **is** a file. Round 4 closed `/install.sh/`. It did not close `/install.sh/foo`.

On Caddy 2.11, adding `|| {http.error.status_code} == 400` to the `@notFound` expression turned `/install.sh/foo` into the same 404 body without breaking `/install.sh/` (200) or `/nope` (404).

## RIGOUR

**2. The “never 400” claim cannot fail in the suite.**

- `deploy/site/generate-vercel-reference.mjs:87-93` negative cases are only missing paths, `/_astro/`, `/fonts/`, and a dotfile.
- `tests/p1-cli/site-on-box.test.ts:82-86` and the Docker loop (`:211`) only hit `inventory.routes`.
- `deploy/site/parity-check.mjs` only hits those routes plus hashed assets from HTML.

`GET /install.sh/foo` is in none of them. Local parity passed **106/106**. Staging parity can pass too. Both miss this 400.

## Also checked (not findings)

Trailing-slash files serve the same bytes as the file. 404s carry HSTS and `Cache-Control`. `/fonts` is 404 with no redirect. Dotfiles 404. `..` 404s. HEAD matches GET headers with an empty body. Query strings do not change the file. Dist stable files match the 25 reference artifacts. `deploy.sh --dry-run` accepts a built `/start` URL and refuses an empty one.

## Gates (real exit codes)

| Gate | Exit |
|---|---|
| `npm run build` | 0 |
| `env -u FORCE_COLOR npm test` | **1** twice, `tests/support/host-stderr-exit-parity.ts` OpenCode held-close timing; **not in this lane** |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (736 pass, including the Caddy Docker route test) |
| `npm run check:tests` | 0 |
| `(cd site && find dist -delete; npm run build)` | 0 |
| `env -u FORCE_COLOR npm --prefix site test` | 0 (547 pass, 0 fail) |
| `parity-check.mjs` vs loopback Caddy 2.11 + this dist | 0, 106 routes |

Did not contact the box by IP, Cloudflare, DNS, or `*.supabase.co`. Removed every Caddy container I started.

VERDICT: FAIL Caddy still returns empty 400 for GET /install.sh/foo (and every other extra segment under a real file) while Vercel returns 404; the slash rewrite and the tests never reach that path.
