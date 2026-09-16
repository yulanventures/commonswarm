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
5. In the local checkout, confirm `site/.env` has non-empty `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` values. Do not print or copy either value into a log.

`www.commonswarm.com` resolved to an A record on 2026-09-16, so the Caddy block includes it.

## First deploy

From the committed revision to release:

```sh
deploy/site/deploy.sh yulan-vps-1
```

The script builds from a clean archive, creates a timestamped directory under `/srv/commonswarm/site/releases`, and switches `/srv/commonswarm/site/current` atomically. It keeps all earlier release directories.

## Check the box before DNS moves

Use the box's reachable HTTPS address as the base URL and send the production host name. The certificate must be trusted by the machine that runs this command. If the system trust store does not include the Cloudflare Origin CA root, set `NODE_EXTRA_CA_CERTS` to a local copy of that public CA certificate.

```sh
node deploy/site/parity-check.mjs https://BOX_ADDRESS --host commonswarm.com
```

The result must say that all routes passed. Do not move DNS if it reports a difference.

Run the production controls against the box in the same way. Replace `BOX_ADDRESS` only. Keep the `Host` header:

```sh
U=https://BOX_ADDRESS
curl -sS -H 'Host: commonswarm.com' -o /dev/null -w '%{http_code}\n' "$U"
curl -sS -H 'Host: commonswarm.com' "$U" | grep -c '<some string that MUST be there>'
curl -sS -H 'Host: commonswarm.com' "$U" | grep -c '<the thing that must be GONE>'
curl -sS -H 'Host: commonswarm.com' -o /dev/null -w '%{http_code}\n' "$U/install.sh"
curl -sS -H 'Host: commonswarm.com' -o /dev/null -w '%{http_code}\n' "$U/nope.sh"
curl -sS -H 'Host: commonswarm.com' "$U/start" | grep -o 'commonswarm:url" content="[^"]*"'
curl -sS -H 'Host: commonswarm.com' "$U/start" | grep -c 'InNlcnZpY2Vfcm9sZSI'
```

Expected status codes are 200 for `/` and `/install.sh`, and 404 for `/nope.sh`. The backend URL output is non-empty. The service-role marker count is 0.

## Move Cloudflare DNS

1. Lower the TTL for the `commonswarm.com` and `www.commonswarm.com` records before the move.
2. Change both records to the Hetzner address. Keep the Cloudflare proxy and TLS settings unchanged.
3. Run `node deploy/site/parity-check.mjs https://commonswarm.com`.
4. Repeat every production control above with `U=https://commonswarm.com` and no `Host` option.

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
