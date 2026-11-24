# CommonSwarm site releases

Only Anvil under HezLead's direction stages or releases to Yulan VPS. Every
production input is an exact reviewed SHA landed on `main`. CI builds never
publish the site. The historical cutover notes below are retained as history.

## Prepare off production

Reserve a root-owned Linux build window with HezLead. Use a disk-backed build workspace;
never build on Yulan VPS or the Mac mini. The builder uses the pinned Node image,
UID 65534, a disk npm cache, bounded resources and `ASTRO_TELEMETRY_DISABLED=1`.
Image pulls stop after five minutes (with a five-second kill grace); the container build has a separate
fifteen-minute deadline.
It reads only the committed archive and explicitly validated public JSON.
No credentials or secret env files belong in CI. Do not source `.env` or a profile.

The JSON has exactly `PUBLIC_SUPABASE_URL=https://api.commonswarm.com` and
`PUBLIC_SUPABASE_ANON_KEY` with JWT role `anon`; it may also carry the matching
`PUBLIC_H0_LINK_JOIN`. The builder's third argument **must explicitly be `0` or
`1`**. Preserve the approved current H0 value, confirmed by HezLead; the earlier
standard release required `1`. Do not infer it from the host environment or flip
product defaults. The receipt binds that explicit value. Public values can be
collected from public HTML or supplied in this allowlisted JSON; never provide a
service-role key or arbitrary env file.

HezLead has approved `PUBLIC_H0_LINK_JOIN=1` for production. Supply `1`
explicitly with that approved configuration; the builder has no implicit H0 default.
After the real build, receipt creation and packet preparation inspect
`app/index.html` inside the validated `site.tar`: H0 `1` requires the
`data-h0-link-join` element and `mint-join`/`revoke-join` buttons; intentional
H0 `0` requires all three absent. Script text does not count as an element.
This output gate does not prove invite creation or revocation works; Anvil must
verify those UI flows separately under HezLead's direction.

```sh
# On the reserved Linux build host; REVIEWED_SHA is the exact landed revision.
# Standard release: omits the /next preview app (COMMONSWARM_INCLUDE_NEXT defaults to 0).
bash deploy/site/build-artifact.sh "$REVIEWED_SHA" /absolute/public.json "$APPROVED_H0" /absolute/new-artifact
# Opt-in release with the /next preview app (ONLY after updating Caddy on yulan-vps-1 and running probe-next-ingress.sh first):
bash deploy/site/probe-next-ingress.sh https://commonswarm.com
COMMONSWARM_INCLUDE_NEXT=1 bash deploy/site/build-artifact.sh "$REVIEWED_SHA" /absolute/public.json "$APPROVED_H0" /absolute/new-artifact
# Record the printed BUILD.sha256 and review BUILD.json and build.log.
# Fetch that complete output directory to the operator Mac, then prepare there:
bash deploy/site/deploy.sh prepare /absolute/artifact "$REVIEWED_BUILD_SHA256" /root/cswarm-site-UNIQUE-ID
```

By default (`COMMONSWARM_INCLUDE_NEXT` unset or `0`), `build-artifact.sh` omits `next/` completely, refuses any stray `next/` member in `site.tar`, omits all `next` fields from `BUILD.json`, and renders `SITE-DIRECT.sh` without `/next` probes or header checks. Any value other than unset, `0`, or `1` fails closed before anything is built.

Enabling `/next` is a per-release decision in strict order:

1. **Web server first:** before building or deploying any release with `COMMONSWARM_INCLUDE_NEXT=1`, update `/etc/caddy/sites/20-commonswarm-site.caddy` from `deploy/site/commonswarm-site.caddy` on `yulan-vps-1` (after running `deploy/site/check-site-caddy.sh /path/to/caddy`) so every `/next` response sends `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-cache` on preview HTML, and immutable caching on `/next/assets/*`. Those rules are inert when a release omits `next/`, returning the site's normal 404 carrying `Content-Security-Policy: frame-ancestors 'none'` for `/next`.
2. **Prove ingress while preview is still off:** run `bash deploy/site/probe-next-ingress.sh https://commonswarm.com` against the real public front door while the preview is still off. It requests `/next`, `/next/`, and `/next/index.html` and requires `Content-Security-Policy: frame-ancestors 'none'` on all three (accepting the off-release 404 or an already-active 200), proving anti-framing is enforced end-to-end without exposing the preview shell.
3. **Opt in at build time and release:** pass `COMMONSWARM_INCLUDE_NEXT=1` to `build-artifact.sh`. It builds `app/` inside the same pinned read-only container with the same validated `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY`, places `app/dist` at `next/` inside `site.tar`, pins `next: "1"`, `appLock` (`app/package-lock.json`), `html["next/index.html"]`, and `nextAssets` in `BUILD.json`, and validates `next/index.html` (matching meta tags, anon-role JWT, Content-Security-Policy meta tag first after charset matching the exact expected directive set and values with no duplicates, zero third-party origins, and all referenced `/next/` assets present). Before switching `current`, `SITE-DIRECT.sh` probes the live `/next`, `/next/`, and `/next/index.html` and refuses to flip if `Content-Security-Policy: frame-ancestors 'none'` is missing on any of the three. After the flip, `SITE-DIRECT.sh` probes `/next`, `/next/`, and `/next/index.html` (with both the release-check user agent and a browser user agent under compressed and `Accept-Encoding: identity` requests) plus every referenced `/next/` asset, and automatically rolls back if any status, hash, content type, or required response header is wrong. Pass `--check-next` to `deploy/site/parity-check.mjs` when verifying a release with `/next` enabled (without `--check-next`, `/next` is not probed). Rollback retains both `/_astro/*` and `/next/assets/*` while tolerating releases that have no `next/` directory at all.

The builder retains its private workspace and build log for diagnosis; it never
removes another job's files. `source.tar`, `site.tar`, public JSON and `BUILD.json`
are read-only outputs. Provenance records source revision/archive, public config,
H0, lockfile, pinned image, builder, validator, production template and HTML hashes.
Preparation validates plain ustar members and rejects traversal, duplicates,
links, special files and corrupt headers. It computes all packet pins and renders
`packet/SITE-DIRECT.sh` automatically. No person edits hashes or script fields.
Review the rendered script and record the printed `PACKET.sha256` digest.

## Before the preview is first switched on

Complete these checks before the first release with `COMMONSWARM_INCLUDE_NEXT=1`:

1. **No edge HTML rewriting on `/next`:** Cloudflare Web Analytics is enabled on the `commonswarm.com` zone and injects its script into `200 text/html` responses. Any HTML injection breaks the preview's strict `script-src 'self'` Content-Security-Policy and fails the post-flip exact-hash check, triggering automatic rollback. Before first switch-on, exclude `/next` and `/next/*` from Cloudflare Web Analytics injection and any other HTML rewriting (such as Email Address Obfuscation, Rocket Loader, or Automatic HTTPS Rewrites), confirm no edge rule alters `Cache-Control: no-cache` on `/next`, `/next/`, or `/next/index.html`, and record the verified state in the edge notes. Never waive the `/next` byte check.
2. **Exact-hash public probe:** once a preview-on release is live (or staged on `site-staging.commonswarm.com`), verify the public front door against `html["next/index.html"]` from `BUILD.json`:

   ```sh
   bash deploy/site/probe-next-ingress.sh https://commonswarm.com --expect-sha "$NEXT_INDEX_SHA256"
   ```

   This checks `/next`, `/next/`, and `/next/index.html` with a browser `User-Agent` and `Accept: text/html,application/xhtml+xml` under both compressed and `Accept-Encoding: identity` requests, requiring HTTP `200`, the exact built SHA-256, `text/html`, a single `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-cache`. Without `--expect-sha`, `probe-next-ingress.sh` keeps its preview-off ingress check (`404` or `200` with `frame-ancestors 'none'`).
3. **Retained `next/assets/` after rollback:** rolling back from a preview-on release to a preview-off release copies `next/assets/*` into the restored release directory (matching `_astro/*`) and never copies `next/index.html` or `next/fonts/`. This is intended: `finalize-release.sh` never deletes files, and retaining content-hashed `next/assets/*` lets already-open preview tabs finish loading chunks while `/next`, `/next/`, and `/next/index.html` return the site's normal 404 page with `Cache-Control: public, max-age=0, must-revalidate` and the preview security headers. Subsequent releases carry those retained `next/assets/*` files forward alongside `_astro/*`.
4. **One-time real-browser Back-button (bfcache) check:** run once at switch-on in a real desktop Chromium/Chrome browser against `https://commonswarm.com/next/` with DevTools **Network -> "Disable cache" UNCHECKED**:
   1. **Sign in and confirm realtime is open:** sign in at `https://commonswarm.com/app` (if needed), then open `https://commonswarm.com/next/` in that same tab. Wait for workspace content to render and verify in DevTools **Network -> WS** that a live `wss://api.commonswarm.com/realtime/v1/...` WebSocket is open (`101 Switching Protocols`).
   2. **Record `pagehide`/`pageshow` without adding bfcache blockers:** in DevTools Console on `/next/`, run:
      ```js
      window.__bf = []; addEventListener('pagehide', e => __bf.push(['hide', e.persisted])); addEventListener('pageshow', e => __bf.push(['show', e.persisted]));
      ```
      Do not register `unload` or `beforeunload` listeners.
   3. **Navigate away cross-site in the same tab:** in the address bar of that same tab, navigate to a different origin (for example, `https://example.com`) and wait for it to finish loading, leaving `/next`'s `pagehide` handler to synchronously tear down the realtime connection and private DOM.
   4. **Press Back:** click the browser's **Back** button once to return to `https://commonswarm.com/next/` and wait for the view to finish revalidating.
   5. **Inspect `navigation[0]` and transition log:** in DevTools Console on `/next/`, run:
      ```js
      (() => { const n = performance.getEntriesByType('navigation')[0]; return { type: n?.type, notRestoredReasons: n?.notRestoredReasons ?? null, events: window.__bf ?? null }; })()
      ```
      - **Restored from bfcache:** `events` survives and ends with `['show', true]`, `type` remains the original `'navigate'`, and `notRestoredReasons` is `null` (confirm no stale private content flashed during revalidation).
      - **Reloaded instead of restored:** `type === 'back_forward'`, `events === null`, and `notRestoredReasons` (in Chromium) reports the exact blocker(s) (for example, `websocket` if realtime did not close before bfcache eligibility).

## Stage, deploy and verify

Anvil owns `/Users/yulanbot/work/BOX-RELEASE.lock`, a regular file containing
`holder=ANVIL_WINDOW_ID` and `since=UTC_TIMESTAMP`. Hold it continuously from
before staging through verification or rollback; never replace another holder's
lock. Export `COMMONSWARM_RELEASE_LOCK_HOLDER` to that exact holder. Check the
approved SSH host fingerprint before using `ops@100.115.66.74`.

```sh
export COMMONSWARM_RELEASE_LOCK_HOLDER=ANVIL_WINDOW_ID
bash deploy/site/deploy.sh stage ops@100.115.66.74 /absolute/artifact/packet "$REVIEWED_PACKET_SHA256"
bash deploy/site/deploy.sh deploy ops@100.115.66.74 /absolute/artifact/packet "$REVIEWED_PACKET_SHA256"
# Rollback, under the SAME held Mac lock:
bash deploy/site/deploy.sh rollback ops@100.115.66.74 /absolute/artifact/packet "$REVIEWED_PACKET_SHA256"
```

Staging disables macOS copy metadata, extracts without preserving source UIDs,
and creates a fresh root-owned reserve with private modes. It checks every packet
hash. SSH uses a 15-second connect timeout and 15-second keepalives with four
misses allowed. The production script uses Bash, tar, curl and ordinary file tools; it never calls
npm, Docker, a compiler or an installer. It checks provenance pins, records the
old pointer, extracts into a new immutable release directory, retains every old
`/_astro` asset and refuses differing bytes under the same asset name. It
normalizes modes, refuses pointer drift, and atomically renames `current`.
Named-user-agent HTTP probes require status 200 and exact HTML hashes for `/`
and `/app`. All production-script output appends to the private reserve
`hostrun.log`, so closed SSH output cannot bypass probes or rollback. The wrapper tails
that log only after the program finishes and preserves its exit code. After any
nonzero exit, including transport failure, inspect the log host-side under the
same held lock. Failed probes trigger
automatic rollback. Rollback requires the old directory to exist, restores the
exact old pointer, and requires `/` and `/app` to return 200. It reports an
unchanged pointer when the swap never occurred or rollback already completed.
A manual rollback refuses a pointer belonging to another release. Keep the lock
on rollback failure and report it to HezLead. Release directories, partial attempts and all
old reserves are retained; automatic retention pruning is retired. Separate
reviewed maintenance may remove them later. Record statuses, hashes and release
IDs only, never raw access-log lines or query strings.

Current-tooling semantic verification needs no external artifact:

```sh
node --import tsx --test tests/p1-cli/site-artifact.test.ts
```

This default lane is explicitly labeled **SYNTHETIC CI artifact**. It makes small
HTML/assets and a synthetic source archive with current tooling bytes, then asks
the production receipt owner to compute pins. It does not prove an Astro build
or committed-source provenance. H0, provenance, unsafe-tar and local-validator
guards run on ordinary nonroot CI. The rendered release cases require Linux root
and exercise local HTTP swap, manual/automatic rollback, closed output, find/swap
failures, missing rollback target, pointer/asset drift, pins and retention. The
separately owned standalone box CI wiring must supply Linux root; the Mac skips
only those runtime cases.

The optional **REAL builder artifact** lane uses actual `build-artifact.sh` output
from the exact reviewed revision with H0=1, including its matching validator:

```sh
COMMONSWARM_SITE_TEST_ARTIFACT=/absolute/artifact node --import tsx --test tests/p1-cli/site-artifact.test.ts
```

This is the separate build/provenance proof. The existing historical lane 8 and
deletion fixtures keep their exact historical source pins and checks. Preparation
also refuses local validator bytes that differ from the build receipt.

## Historical cutover notes

## Before the first deploy

1. Ask the box admin to remove the placeholder `https://commonswarm.com` block from the main Caddyfile. The block in `deploy/site/commonswarm-site.caddy` cannot load beside that duplicate site address. Do not work around the duplicate.
2. Confirm these Origin CA files exist on the box and are readable only by the Caddy service where possible:

   ```text
   /etc/caddy/certs/commonswarm.com.pem
   /etc/caddy/certs/commonswarm.com.key
   ```

   The site block also requires a client certificate from the edge. Confirm its trust pool exists and is readable by the Caddy service:

   ```text
   /etc/caddy/aop/commonswarm.com/ca.pem
   ```

3. Create `/srv/commonswarm/site/releases` and give the SSH deploy user write access to `/srv/commonswarm/site`.
4. Copy `deploy/site/commonswarm-site.caddy` to `/etc/caddy/sites/commonswarm-site.caddy`. Validate and reload Caddy with the box's normal admin procedure.
   Before copying a changed file, run `deploy/site/check-site-caddy.sh /path/to/caddy` with a Caddy binary of the box's pinned version. It runs the rules on a loopback port with a temporary folder, touches no running server, and fails if any address answers with the wrong status, type, body or cache header. It needs `curl` and `openssl` on the machine that runs it: it also runs the TLS block on its own listener with throwaway certificates, and fails unless a connection without a trusted client certificate is refused. Without `openssl` the check fails; it never passes with that rule untested. Every listener it starts is bound to `127.0.0.1`, which it verifies before serving.
5. The original cutover read local `site/.env`; current releases use the explicit public JSON and H0 input described above.
6. Keep `site-staging.commonswarm.com` proxied to the box until the production cutover is complete.

`www.commonswarm.com` resolved to an A record on 2026-09-16, so the Caddy block includes it.

## Historical first deploy

The original procedure built on the caller and retained five releases. Current
releases use the prebuilt packet procedure above and retain all reserves.

## Check through Cloudflare before DNS moves

Use the staging name. It exercises Cloudflare, TLS, Caddy, and the release without changing production DNS:

```sh
node deploy/site/parity-check.mjs https://site-staging.commonswarm.com --allow-cloudflare-browser-ttl
```

The last staging check before file-slash routes were added found this accepted difference on 21 URLs: Cloudflare changed `cache-control` from `public, max-age=0, must-revalidate` to `public, max-age=14400, must-revalidate`. The operator accepted it for cutover and will change the Browser Cache TTL zone setting later. The option above permits only that exact rewrite on `.css`, `.js`, `.png`, `.svg`, and `.woff2` paths, including their trailing-slash forms. It permits no status, content-type, security-header, path, or other cache change. Without the option, the checker reports every such rewrite and exits nonzero.

The result must say that all routes passed and list only allowed browser-TTL rewrites. Do not move DNS if it reports another difference.
For non-loopback URLs, the checker uses the reference's 550 ms request interval so the check stays below two requests per second.

Run the production controls against the staging name:

```sh
U=https://site-staging.commonswarm.com
curl -sS -o /dev/null -w '%{http_code}\n' "$U"
curl -sS "$U" | grep -c '<some string that MUST be there>'
curl -sS "$U" | grep -c '<the thing that must be GONE>'
curl -sS -o /dev/null -w '%{http_code}\n' "$U/install.sh"
curl -sS -o /dev/null -w '%{http_code}\n' "$U/nope.sh"
curl -sS "$U/start" | grep -o 'commonswarm:url" content="[^"]*"'
curl -sS "$U/start" | grep -c 'InNlcnZpY2Vfcm9sZSI'
```

Expected status codes are 200 for `/` and `/install.sh`, and 404 for `/nope.sh`. The backend URL output is non-empty. The service-role marker count is 0.

If the staging name is unavailable, connect to the box directly. Save the public Cloudflare Origin CA root as `./cloudflare-origin-ca-root.pem`, then use the production TLS name and Host header:

```sh
node deploy/site/parity-check.mjs https://BOX_ADDRESS --host commonswarm.com --ca ./cloudflare-origin-ca-root.pem
curl -sS --cacert ./cloudflare-origin-ca-root.pem --resolve commonswarm.com:443:BOX_ADDRESS https://commonswarm.com/
```

## Move Cloudflare DNS

1. Lower the TTL for the `commonswarm.com` and `www.commonswarm.com` records before the move.
2. Change both records to the Hetzner address. Keep the Cloudflare proxy and TLS settings unchanged.
3. Run `node deploy/site/parity-check.mjs https://commonswarm.com --allow-cloudflare-browser-ttl` while the zone still overrides Browser Cache TTL.
4. Repeat every production control above with `U=https://commonswarm.com`.
5. Judge the result through public DNS (`dig @1.1.1.1`) or after flushing your resolver. On 2026-09-16 the operator's mini kept the old DNS-only Vercel answer until flushed: a path probe from a stale resolver reports Vercel even when the switch worked. Tell the two origins apart with the `x-vercel-id` response header (present only on Vercel) and `cf-ray` (present through the Cloudflare proxy).

After the Cloudflare Browser Cache TTL setting stops changing the origin value, run the checker once without `--allow-cloudflare-browser-ttl`. Drop the option from later checks only after that unflagged check passes.

## Historical rollback

The cutover moved `current.next` over `current` using GNU `mv -Tf`. Current
releases use the packet's bottom rollback command above under the held Mac lock.
Do not change DNS during a release rollback.
