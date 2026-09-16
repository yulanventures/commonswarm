I'll review the N-site lane at the exact SHA: git range first, then the Caddy block, deploy script, and parity tests. No box, DNS, or other models.Three commits, seven files. I'll read the full diff and every new file next.I'll read the Caddy block, deploy script, generators, tests, and the reference inventory next.I'll pull unique content-types from the reference, the test gate lists, and Caddy 2.11 matcher behaviour.I'll check whether the new test is on a gate, then start the required builds and a local Caddy.Site `.env` is present and `caddy:2.11` is local. I'll build the site, then serve it on loopback.The site build ran in the wrong directory. I'll build `site/` next and stand up Caddy on loopback.Caddy is up on loopback. I'll run the parity checker and extra route/header probes next.Parity passed. I'll inspect how Caddy adapted `try_files @cleanUrl` and then run the gates.Site tests ran from the wrong directory. I'll rerun them from the repo root.Reviewed SHA `81c81f3deadc242d026c1bd5f994bc9f15e35047` vs `48995569e460dcc41eb672758b2ff455ff72722d`. Three commits. Seven new files. No `site/` change.

Served a fresh `site/dist` with `caddy:2.11` (v2.11.4) on `127.0.0.1:18443`, self-signed cert, SNI `commonswarm.com`. Did not contact the box, Cloudflare, DNS, `api.commonswarm.com`, or `*.supabase.co`.

**What matched**

- Dist SHA `bcf5cbdc…` equals the committed inventory. 39 files, 65 routes, `mismatches: []`.
- `parity-check.mjs` against that Caddy: **exit 0**, 65/65.
- `/x` and `/x/` and `/x/index.html` → 200, no `Location`.
- `/fonts`, `/fonts/`, `/_astro/` → 404, `text/plain; charset=utf-8`, body `The page could not be found` (27 bytes).
- HEAD `/start` and HEAD 404 → empty body. Query string does not change the file.
- MIME and headers match the reference: HSTS `max-age=63072000` (one value), `Cache-Control: public, max-age=0, must-revalidate`, no CSP/XFO. One HSTS header, not two.
- Path `../` stays in the site root. Empty dirs do not list.
- `deploy.sh --dry-run --dist site/dist` exit 0. Empty `commonswarm:url` exit 1. Bad SSH host exit 2 (no SSH).

**PRODUCTION**

None on the 65-route surface. A visitor of `/`, `/start`, `/app`, `/install.sh`, `/_astro/*.js`, fonts, 404s sees the same status, type, and recorded headers as Vercel.

**RIGOUR**

1. `deploy/site/commonswarm-site.caddy:27-28` — `@cleanUrl` is not a matcher. Adapted JSON `try_files` is `["@cleanUrl", "{path}/index.html", "{path}", "=404"]`. Caddy looks for a file named `@cleanUrl` on every request. The named matcher `not path */` is unused. Harmless while dist has no file of that name. `GET /start` still returns `start/index.html`.

2. `tests/p1-cli/site-on-box.test.ts:47-77` — this test never starts Caddy and never reads `site/dist`. It greps the Caddyfile (and keeps the dead `@cleanUrl` token) and walks the JSON with `caddyArtifact()`. Delete `handle_errors` and this test still passes. The live control is `parity-check.mjs`; CI does not run it against Caddy.

3. `deploy/site/parity-check.mjs:74-84` — compares status, content-type, and seven headers. Not the 404 body. Body is typed in the Caddyfile. I measured it. The JSON does not record it.

4. `deploy/site/deploy.sh:27-32` — `--dry-run` only runs `validate_dist`. It does not test archive, `npm ci`, rsync, or the `current.next` swap. Those paths look correct in the script (`set -eu`, build then validate, rsync into `*.tmp`, then `mv` + `ln -sfn` + `mv -Tf`). Not executed here.

Dotfile probe (attack copy of dist, not the real dist): `GET /.secret` → 200. Current dist has no dotfiles. Vercel not measured.

**Gates (real exit codes)**

| Gate | Exit |
|---|---|
| `npm run build` | 0 |
| `env -u FORCE_COLOR npm test` | 0 (875, fail 0) |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (727, fail 0; includes the three site-on-box tests) |
| `npm run check:tests` | 0 |
| `cd site && rm -rf dist && npm run build` | 0 |
| `env -u FORCE_COLOR npm --prefix site test` | 0 (547 pass, 1 skip) |

**Not established:** live Vercel POST/OPTIONS/www-redirect (no contact). Origin through Cloudflare after DNS (no contact). Case-sensitive disk (`/START` was 200 here because the Mac bind mount folds case).

Containers `nsite-caddy-d036` and `nsite-caddy-d036-attack` removed.

VERDICT: PASS — Caddy 2.11.4 on loopback matched all 65 Vercel reference routes (status, type, recorded headers, 404 body); remaining issues are an unused matcher and tests that do not run Caddy.
