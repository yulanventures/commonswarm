# OAuth and MCP preparation contract

Lane 5 establishes reviewed configuration only. It does not establish a
working OAuth provider, hosted MCP resource server, DNS or Cloudflare state,
deployment, or live Claude interoperability. Executable release and rollback
verification belongs to HM lane 6, when the service exists.

## Repository state

- `mcp` is a prepared router name, while every
  `/functions/v1/mcp` request returns stable `503 feature_disabled` JSON
  before worker creation.
- The MCP worker environment allowlist contains database configuration, public
  Supabase configuration, issuer/resource/JWKS settings, origins, and bounded
  limits. OAuth signing, cookie, refresh, database-credential, private-key,
  password, token, and service-role names are excluded.
- Compose publishes only
  `127.0.0.1:${MCP_OAUTH_HOST_PORT}:3490`, uses 512 MiB and one CPU, mounts
  protected files read-only, joins `commonswarm-net`, and defines bounded
  health and log rotation.
- `env.example` assignments contain names and empty values only.
- The Caddy site's active handlers return explicit disabled JSON. Its
  unimported snippets preserve the reviewed edge-resource and OAuth-upstream
  routing contracts for a later activation lane.
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

Signing, cookie, database-credential, and TLS CA files live under
`/etc/commonswarm-oauth/` as `root:<service gid>`, mode `0640`, read-only
mounts. Secret contents are represented inside the container only by
`*_FILE` paths. The ES256 signing key originates on the box, with its source
of truth in the 1Password vault **Yulan Ventures Infra**. The `kid` overlap
contract retains both required public keys through cache propagation, token
lifetime, and clock skew.

## Cloudflare and public-route facts

Proxied DNS follows the live zone convention and the certificate covers
`mcp.commonswarm.com`. A Cloudflare rule scoped by hostname equality skips
Browser Integrity Check and bot challenges for that hostname only. Its
effective coverage includes protected-resource metadata, authorization-server
metadata, OIDC metadata, JWKS, token, interaction, callback,
connection-management, and MCP paths.

External evidence uses a non-browser User-Agent such as
`Python-urllib/3.12`. During lane 5, all not-yet-available routes return the
repository's explicit JSON disabled response rather than a 502, Cloudflare HTML
challenge, or error 1010. After activation, expected protocol responses become
metadata, unauthenticated 401, or invalid-request errors.

The Caddy contract bounds methods, requests, and proxy timeouts; preserves the
external host and scheme; and excludes Authorization headers, cookies, codes,
request bodies, and sensitive query values from logs.
