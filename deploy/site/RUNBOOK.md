# CommonSwarm site releases

Only Anvil under HezLead's direction stages or releases to Yulan VPS. Every
production input is an exact reviewed SHA landed on `main`. CI builds never
publish the site. The historical cutover notes below are retained as history.

## Prepare off production

Reserve a root-owned Linux build window with HezLead. Use a disk-backed build workspace;
never build on Yulan VPS or the Mac mini. The builder uses the pinned Node image,
UID 65534, a disk npm cache, bounded resources and `ASTRO_TELEMETRY_DISABLED=1`.
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
bash deploy/site/build-artifact.sh "$REVIEWED_SHA" /absolute/public.json "$APPROVED_H0" /absolute/new-artifact
# Record the printed BUILD.sha256 and review BUILD.json and build.log.
# Fetch that complete output directory to the operator Mac, then prepare there:
bash deploy/site/deploy.sh prepare /absolute/artifact "$REVIEWED_BUILD_SHA256" /root/cswarm-site-UNIQUE-ID
```

The builder retains its private workspace and build log for diagnosis; it never
removes another job's files. `source.tar`, `site.tar`, public JSON and `BUILD.json`
are read-only outputs. Provenance records source revision/archive, public config,
H0, lockfile, pinned image, builder, validator, production template and HTML hashes.
Preparation validates plain ustar members and rejects traversal, duplicates,
links, special files and corrupt headers. It computes all packet pins and renders
`packet/SITE-DIRECT.sh` automatically. No person edits hashes or script fields.
Review the rendered script and record the printed `PACKET.sha256` digest.

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

Staging creates a fresh root-owned reserve and checks every packet hash. The
production script uses Bash, tar, curl and ordinary file tools; it never calls
npm, Docker, a compiler or an installer. It checks provenance pins, records the
old pointer, extracts into a new immutable release directory, retains every old
`/_astro` asset and refuses differing bytes under the same asset name. It
normalizes modes, refuses pointer drift, and atomically renames `current`.
Named-user-agent HTTP probes require status 200 and exact HTML hashes for `/`
and `/app`. Failed probes trigger automatic rollback. A manual rollback refuses
if current no longer names this packet's release. Keep the lock on rollback
failure and report it to HezLead. Release directories, partial attempts and all
old reserves are retained; automatic retention pruning is retired. Separate
reviewed maintenance may remove them later. Record statuses, hashes and release
IDs only, never raw access-log lines or query strings.

Linux verification uses real `build-artifact.sh` output, with the artifact path
passed explicitly (the Mac runs syntax and small fixtures only):

```sh
COMMONSWARM_SITE_TEST_ARTIFACT=/absolute/artifact node --import tsx --test tests/p1-cli/site-artifact.test.ts
```

The render fixture requires Linux root, drives a local HTTP server and exercises
swap, manual/automatic rollback, pointer/asset drift, pins and malformed tar
members. It skips honestly when no real build output is supplied. The existing
historical lane 8 and deletion fixtures keep their exact historical source pins.

## Historical cutover notes

## Before the first deploy

1. Ask the box admin to remove the placeholder `https://commonswarm.com` block from the main Caddyfile. The block in `deploy/site/commonswarm-site.caddy` cannot load beside that duplicate site address. Do not work around the duplicate.
2. Confirm these Origin CA files exist on the box and are readable only by the Caddy service where possible:

   ```text
   /etc/caddy/certs/commonswarm.com.pem
   /etc/caddy/certs/commonswarm.com.key
   ```

3. Create `/srv/commonswarm/site/releases` and give the SSH deploy user write access to `/srv/commonswarm/site`.
4. Copy `deploy/site/commonswarm-site.caddy` to `/etc/caddy/sites/commonswarm-site.caddy`. Validate and reload Caddy with the box's normal admin procedure.
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
