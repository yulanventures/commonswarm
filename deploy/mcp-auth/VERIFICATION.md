# OAuth and MCP preparation contract

The repository now contains the OAuth provider service, but this file does not
claim deployment, DNS or Cloudflare state, a hosted MCP resource server, or
live Claude interoperability. Those remain production checks for Anvil under
HezLead.

## Repository state

- `mcp` is a prepared router name. While `SWARM_MCP_PUBLIC_ENABLED` is not
  exactly `1`, every `/functions/v1/mcp` request returns stable
  `503 feature_disabled` JSON from the main router before worker creation.
  With the flag set to `1`, MCP resource requests route to the worker.
- The MCP worker environment allowlist contains database configuration, public
  Supabase configuration, issuer/resource/JWKS settings, origins, and bounded
  limits. OAuth signing, cookie, refresh, database-credential, private-key,
  password, token, and service-role names are excluded.
- Compose publishes only
  `127.0.0.1:${MCP_OAUTH_HOST_PORT}:3490`, uses 512 MiB and one CPU, mounts
  protected files read-only, joins `commonswarm-net`, and defines bounded
  health and log rotation.
- Public authorization is explicitly disabled by default. Health, discovery,
  and JWKS remain observable without making code or refresh issuance public.
- `env.example` assignments contain names and empty values only.
- The Caddy site imports only its reviewed OAuth-upstream snippet. The
  edge-resource snippet remains unimported, and `/mcp` plus its
  protected-resource metadata route return explicit disabled JSON.
- The GoTrue example appends
  `https://mcp.commonswarm.com/oauth/callback/gotrue` to the three baseline
  entries.

The service-free configuration test is in the literal root `npm test` list.
Docker validation belongs to the Actions `p1-cli` suite, and PostgreSQL
integration belongs to Actions `server`.

## Box service facts

The Compose project is `commonswarm-oauth`, owned operationally by
`commonswarm`, with immutable releases at
`/home/commonswarm/oauth/releases/<sha>` and the active symlink at
`/home/commonswarm/oauth/current`. The container is unprivileged,
read-only, capability-free, limited to 536870912 bytes and one CPU, connected
to `commonswarm-net`, and published only on one confirmed loopback port from
`3490` through `3499`.

The selected port follows inspection of the live listening-socket inventory;
the plan reserves no port. The same recorded value binds Compose and Caddy.

Signing, cookie, and database-credential files live under
`/etc/commonswarm-oauth/` as `root:<service gid>`, mode `0640`, read-only
mounts. The separately managed internal database CA is
`/etc/ssl/yulan-internal-ca.pem`, mounted read-only at that same container
path. Secret contents are represented inside the container only by `*_FILE`
paths. The ES256 signing key originates on the box, with its source of truth
in the 1Password vault **Yulan Ventures Infra**. The `kid` overlap contract
retains both required public keys through cache propagation, token lifetime,
and clock skew.

## Cloudflare and public-route facts

Proxied DNS follows the live zone convention and the certificate covers
`mcp.commonswarm.com`. A Cloudflare rule scoped by hostname equality skips
Browser Integrity Check and bot challenges for that hostname only. Its
effective coverage includes protected-resource metadata, authorization-server
metadata, OIDC metadata, JWKS, token, interaction, callback,
health, and MCP paths.

External evidence uses a non-browser User-Agent such as
`Python-urllib/3.12`. OAuth routes return metadata, health, unauthenticated 401,
or invalid-request responses rather than a 502, Cloudflare HTML challenge, or
error 1010. The MCP and protected-resource routes continue to return the
repository's explicit JSON disabled response.

The Caddy contract bounds methods, requests, and proxy timeouts; preserves the
external host and scheme; and excludes Authorization headers, cookies, codes,
request bodies, and sensitive query values from logs.
