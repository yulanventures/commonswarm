# CommonSwarm site move to Hetzner

Status: **NOT RUN**. Nothing in this lane ran on `yulan-vps-1` or through Cloudflare.

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
6. Save the public Cloudflare Origin CA root as `./cloudflare-origin-ca-root.pem`. This certificate is public. It is needed to verify the box before Cloudflare proxies the request.

`www.commonswarm.com` resolved to an A record on 2026-09-16, so the Caddy block includes it.

## First deploy

From the committed revision to release:

```sh
deploy/site/deploy.sh yulan-vps-1
```

The script builds from a clean archive, creates a timestamped directory with a random suffix under `/srv/commonswarm/site/releases`, and switches `/srv/commonswarm/site/current` atomically. It carries forward old `/_astro` files for in-flight pages, keeps new files when names match, and retains the five newest releases.

## Check the box before DNS moves

Use the box's reachable HTTPS address as the base URL and send the production host name. Pass the public Cloudflare Origin CA root explicitly:

```sh
node deploy/site/parity-check.mjs https://BOX_ADDRESS --host commonswarm.com --ca ./cloudflare-origin-ca-root.pem
```

The result must say that all routes passed. Do not move DNS if it reports a difference.

Run the production controls against the box in the same way. Replace `BOX_ADDRESS` with its IP address. `--resolve` sends the production Host header and TLS server name while it connects to that IP:

```sh
U=https://commonswarm.com
curl -sS --cacert ./cloudflare-origin-ca-root.pem --resolve commonswarm.com:443:BOX_ADDRESS -o /dev/null -w '%{http_code}\n' "$U"
curl -sS --cacert ./cloudflare-origin-ca-root.pem --resolve commonswarm.com:443:BOX_ADDRESS "$U" | grep -c '<some string that MUST be there>'
curl -sS --cacert ./cloudflare-origin-ca-root.pem --resolve commonswarm.com:443:BOX_ADDRESS "$U" | grep -c '<the thing that must be GONE>'
curl -sS --cacert ./cloudflare-origin-ca-root.pem --resolve commonswarm.com:443:BOX_ADDRESS -o /dev/null -w '%{http_code}\n' "$U/install.sh"
curl -sS --cacert ./cloudflare-origin-ca-root.pem --resolve commonswarm.com:443:BOX_ADDRESS -o /dev/null -w '%{http_code}\n' "$U/nope.sh"
curl -sS --cacert ./cloudflare-origin-ca-root.pem --resolve commonswarm.com:443:BOX_ADDRESS "$U/start" | grep -o 'commonswarm:url" content="[^"]*"'
curl -sS --cacert ./cloudflare-origin-ca-root.pem --resolve commonswarm.com:443:BOX_ADDRESS "$U/start" | grep -c 'InNlcnZpY2Vfcm9sZSI'
```

Expected status codes are 200 for `/` and `/install.sh`, and 404 for `/nope.sh`. The backend URL output is non-empty. The service-role marker count is 0.

## Move Cloudflare DNS

1. Lower the TTL for the `commonswarm.com` and `www.commonswarm.com` records before the move.
2. Change both records to the Hetzner address. Keep the Cloudflare proxy and TLS settings unchanged.
3. Run `node deploy/site/parity-check.mjs https://commonswarm.com`.
4. Repeat every production control above without `--resolve` or `--cacert`.

## Roll back

For a site release rollback on the box, point `current.next` to the selected earlier directory and rename it over `current`:

```sh
cd /srv/commonswarm/site
ln -sfn releases/RELEASE_TO_RESTORE current.next
mv -Tf current.next current
```

For a full rollback to Vercel, restore the former Cloudflare DNS records for both `commonswarm.com` and `www.commonswarm.com`. Then run the parity check and production controls against `https://commonswarm.com`.

## Retire Vercel

Delete the Vercel `coswarm-site` project only after the operator confirms all of these points:

- DNS has served the Hetzner box for the full old TTL window.
- The parity check and production controls pass through Cloudflare.
- Sign-in and `/app` work in a browser.
- The Vercel DNS values needed for rollback are recorded.

The Vercel project name is intentionally old. Do not delete it before this confirmation.
