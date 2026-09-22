# CommonSwarm site on Hetzner

Status: the site cutover is done. https://commonswarm.com is served by Caddy on yulan-vps-1. Publish with `deploy/site/deploy.sh yulan-vps-1`. The checks below are the ones used for that cutover. The Vercel project `coswarm-site` is deleted.

## Before the first deploy

1. Ask the box admin to remove the placeholder `https://commonswarm.com` block from the main Caddyfile. The block in `deploy/site/commonswarm-site.caddy` cannot load beside that duplicate site address. Do not work around the duplicate.
2. Confirm these Origin CA files exist on the box and are readable only by the Caddy service where possible:

   ```text
   /etc/caddy/certs/commonswarm.com.pem
   /etc/caddy/certs/commonswarm.com.key
   ```

3. Create `/srv/commonswarm/site/releases` and give the SSH deploy user write access to `/srv/commonswarm/site`.
4. Copy `deploy/site/commonswarm-site.caddy` to `/etc/caddy/sites/commonswarm-site.caddy`. Validate and reload Caddy with the box's normal admin procedure.
5. In the local checkout, confirm `site/.env` has non-empty `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` values. The deploy script decodes the key locally and refuses a `service_role` payload. It does not print the key. Do not print or copy either value into a log.
6. Keep `site-staging.commonswarm.com` proxied to the box until the production cutover is complete.

`www.commonswarm.com` resolved to an A record on 2026-09-16, so the Caddy block includes it.

## First deploy

From the committed revision to release:

```sh
deploy/site/deploy.sh yulan-vps-1
```

The script builds from a clean archive, creates a timestamped directory with a random suffix under `/srv/commonswarm/site/releases`, and switches `/srv/commonswarm/site/current` atomically. It carries forward old `/_astro` files for in-flight pages, keeps new files when names match, and retains the five newest releases. Cleanup after the live switch is best-effort: a prune error is logged but does not mark a successful switch as failed.

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

## Roll back

For a site release rollback on the box, point `current.next` to the selected earlier directory and rename it over `current`:

```sh
cd /srv/commonswarm/site
ln -sfn releases/RELEASE_TO_RESTORE current.next
mv -Tf current.next current
```

Roll back a site release on the server by moving the `current` symlink. Do not point DNS at Vercel.
