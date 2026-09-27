# CommonSwarm OAuth service contract

Lane 5 defines the dark infrastructure shape only. The executable release and
rollback procedure belongs to HM lane 6, when the OAuth service exists. Only
Anvil operates the production service under HezLead's direction from a reviewed
SHA already landed on `main`.

## Service shape

- Compose project: `commonswarm-oauth`.
- Operational owner: `commonswarm`.
- Immutable releases: `/home/commonswarm/oauth/releases/<sha>`.
- Active symlink: `/home/commonswarm/oauth/current`.
- External network: `commonswarm-net`.
- Host publication: exactly one loopback socket,
  `127.0.0.1:<confirmed-port>`.
- Container budget: 512 MiB and at most one CPU.
- Runtime policy: unprivileged UID/GID, read-only root filesystem, all
  capabilities dropped, `no-new-privileges`, `unless-stopped`, a bounded
  healthcheck, and `json-file` logging with `max-size: 10m` and
  `max-file: "3"`.
- Image identity: an immutable image digest and the exact accepted provider
  version supplied by lane 6.

The OAuth container is separate from the edge pool. Lane 5's Caddy site remains
dark: neither active snippet is imported, and unavailable MCP and OAuth routes
return explicit `503 feature_disabled` JSON.

## Key and secret-file contract

The ES256 signing key is generated on the box. Its source of truth is a
protected item in the 1Password vault **Yulan Ventures Infra**.

Runtime files live under `/etc/commonswarm-oauth/`, owned by
`root:<service gid>`, mode `0640`, and mounted read-only:

- `signing-keys.pem`;
- `cookie-keys`;
- `database-credentials`;
- `yulan-internal-ca.pem`.

The container receives only their mounted paths through
`MCP_OAUTH_SIGNING_KEYS_FILE`, `MCP_OAUTH_COOKIE_KEYS_FILE`,
`MCP_OAUTH_DATABASE_CREDENTIALS_FILE`, and
`MCP_OAUTH_DATABASE_TLS_CA_FILE`. Secret material is absent from environment
values, Compose substitutions, logs, release evidence, and the edge worker.
The OAuth database credential belongs only to the least-privilege
`commonswarm_oauth_runtime` role and uses verified TLS.

The `kid` rotation contract publishes the next public key before it signs,
allows the bounded JWKS cache to observe the overlap, retains the previous
public key for the access-token lifetime plus clock skew and propagation
allowance, and removes it only after overlap and unknown-`kid` refresh proofs.
A compromise also revokes affected provider families and CommonSwarm grants.

## Port rule

The host port is one value from `3490` through `3499`, chosen by Anvil only
after inspecting the live listening-socket inventory. The plan reserves no
port. The selected value is recorded and rechecked immediately before a lane 6
release. Caddy and Compose use the same confirmed value, and no non-loopback
publication is permitted.

## Cloudflare and Caddy contract

`mcp.commonswarm.com` uses proxied DNS, a certificate with proven hostname
coverage, and a hostname-scoped Cloudflare rule that skips Browser Integrity
Check and bot challenges only for that hostname. External evidence includes a
non-browser User-Agent, including a Python-style default, across discovery,
authorization, token, JWKS, and MCP routes; Cloudflare HTML challenges and
error 1010 are failures.

The reviewed Caddy contract sends exact `/mcp` and protected-resource
metadata routes to the edge MCP function after activation. Authorization
metadata, `/authorize`, `/token`, `/jwks`, interaction, GoTrue callback,
and enumerated connection-management routes go to the confirmed OAuth
loopback port after activation. Methods, request sizes, and timeouts are
bounded; external host and scheme are preserved; credential-bearing headers,
cookies, codes, bodies, and query values are not logged.
