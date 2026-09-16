I'll review the exact SHA against main, then attack the Caddy block, deploy path, and parity checker with the allowed local/Docker and staging GETs.The SHA matches. Next I’ll read the lane files and the round-3 delta.I’ve got the lane files. Next I’ll read the rest of the reference, then run gates and Caddy attacks in parallel.The `/fonts` path still isn’t in the 52-route set. I’ll check whether the try_files fix changed directory behavior, then run the gates and Caddy attacks.Root typecheck passed. I’ll start Caddy attacks and the remaining gates while `npm test` finishes.The first Caddy 404s likely hit an empty `dist` during the rebuild. I’ll recreate the container against the finished build.Caddy returns 400 on file paths with a trailing slash. I’ll compare that to Vercel and staging, and run local parity.Two gates failed. I’ll pull the actual failing tests before deciding if they’re in-scope.The Caddy route test passed. I’ll inspect the finalize-release failure and rerun site tests against the rebuilt dist.Checked `ef24893a` vs `48995569`. Served a fresh `site/dist` with `caddy:2.11` on loopback. Polite GETs to Vercel (`commonswarm.com`) and to `site-staging.commonswarm.com`. Did not touch the box by IP, DNS, or Supabase.

Local Caddy parity: **66/66** (52 fixed + 14 discovered). `/fonts` and `/_astro` without a slash are **404**, no redirect. Canonical `/install.sh` is **200**. Dist has the 25 stable artifacts, 14 hashed assets, no `.env`.

## PRODUCTION

**1. Trailing slash on a file is 200 on Vercel and 400 empty on Caddy**

`deploy/site/commonswarm-site.caddy:38-42` — every path that ends in `/` is rewritten to `{path}index.html`, then `file_server` runs. For a file that is not a directory, that walk hits `ENOTDIR` and Caddy returns **400** with no `Content-Type` and an empty body. `handle_errors` only rewrites **404**, so the 400 is not turned into the 404 page.

Request: `GET /install.sh/` (same family: `/api.md/`, `/llms.txt/`, `/og.png/`, `/fonts/inter-latin.woff2/`, `/skills/cswarm/SKILL.md/`).

| Origin | Status | Body |
|---|---|---|
| Vercel `https://commonswarm.com/install.sh/` | **200** `application/x-sh` | the installer (16824 bytes), same as `/install.sh` |
| Loopback Caddy 2.11 | **400** | empty |
| Staging through Cloudflare | **400** | empty |

Visitor after DNS moves: `curl -fsSL https://commonswarm.com/install.sh/` fails (`-f` on 400). Today that URL returns the script. HTML `/start` vs `/start/` still match (both 200). The comment on line 38 (“Vercel also serves `/x/` without a redirect”) is true for `index.html` pages and false for files.

## RIGOUR

**2. The reference and the tests never ask for those URLs, so they cannot go red for finding 1**

`deploy/site/generate-vercel-reference.mjs:33-39` only adds `/x/` for `*/index.html`. `install.sh` becomes `/install.sh` only. `tests/p1-cli/site-on-box.test.ts:183-190` and `deploy/site/parity-check.mjs:138-150` loop that list. Local and staging 66/66 stay green while `/install.sh/` is 400. The path list is generated from `dist`, not typed; the slash variants for files are just never generated.

**3. Finalize prune uses `ls` and can abort after the live symlink swap**

`deploy/site/finalize-release.sh:42-51` moves `current` to the new release first. Lines **67-80** then parse `$(ls -1dt "$releases"/20*)` and `exit 1` if a name does not match `"$releases"/*`.

Sequence on this host: `CLICOLOR_FORCE=1` (set here) makes BSD `ls` wrap directory names in ANSI. The case fails. stderr: `Refusing prune outside releases directory: <blue>…/releases/20260912T…`. The new release is already live; `deploy.sh` still exits 1.

Measured: `env -u FORCE_COLOR npm run test:p1-cli` → **exit 1** on that test. Same file with `CLICOLOR_FORCE` unset → 11/11 pass. Finalize on the Linux box is not shown to color `ls` (that path was not contacted). The Mac test path is.

**4. 404 body is not the Vercel body**

Caddy `handle_errors` (`commonswarm-site.caddy:45-49`) returns 27 bytes `The page could not be found`. Vercel returns 79 bytes with extra `NOT_FOUND` and a request id. Status and `content-type` match the reference; body is not recorded, so parity does not see it.

**5. Post-cutover parity drops the Cloudflare TTL flag**

`deploy/site/RUNBOOK.md:70` runs `node deploy/site/parity-check.mjs https://commonswarm.com` with no `--allow-cloudflare-browser-ttl`. Staging is documented to have 21 accepted rewrites until Browser Cache TTL changes. That command will exit 1 on a good cutover until the zone setting moves.

## Gates (real exit codes)

| Command | Exit |
|---|---|
| `npm run build` | 0 |
| `env -u FORCE_COLOR npm test` | 0 (875 pass) |
| `env -u FORCE_COLOR npm run test:p1-cli` | **1** (finding 3; Caddy 52-route test passed) |
| `npm run check:tests` | 0 |
| `(cd site && find dist -delete; npm run build)` | 0 |
| `env -u FORCE_COLOR npm --prefix site test` | 0 on rerun (547 pass, 1 skip). First run was 1 because `dist` was deleted while that run was live. |

Docker Caddy container used for the loopback serve was removed.

Not established: GNU `ls` color on the box; byte identity of every unrecorded Vercel header (`access-control-allow-origin`, `content-disposition`).

VERDICT: FAIL Caddy returns 400 empty for file URLs with a trailing slash, including GET /install.sh/ which is 200 on Vercel today (measured on Caddy 2.11 and site-staging).
