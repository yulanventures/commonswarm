# CommonSwarm OAuth service contract

This directory defines the lane 6 service and its OAuth-only Caddy activation.
Only Anvil operates the production service under HezLead's direction from a
reviewed SHA already landed on `main`.

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
- Image identity: an immutable release image digest built from the Dockerfile's
  digest-pinned Node 22 base and exact `oidc-provider` 9.12.2 dependency.

The OAuth container is separate from the edge pool. Caddy imports only the
OAuth snippet. `/mcp` and `/.well-known/oauth-protected-resource/mcp` still
return explicit `503 feature_disabled` JSON; the MCP resource snippet remains
unimported until its edge function ships.

## Key and secret-file contract

The ES256 signing key is generated on the box. Its source of truth is a
protected item in the 1Password vault **Yulan Ventures Infra**.

Runtime files live under `/etc/commonswarm-oauth/`, owned by
`root:<service gid>`, mode `0640`, and mounted read-only:

- `signing-keys.pem` (despite the retained lane-5 filename, its content is a
  JSON private JWK set; every key is ES256/P-256 with a unique `kid`);
- `cookie-keys`;
- `database-credentials`.

The internal database CA is the separately managed host file
`/etc/ssl/yulan-internal-ca.pem`, mounted read-only at that same container
path. It is not a runtime file under `/etc/commonswarm-oauth/`. As a public
certificate, it may be mode `0644`; it must be a root-owned regular file, not
a symlink, and must not be writable by group or other users.

The container receives only their mounted paths through
`MCP_OAUTH_SIGNING_KEYS_FILE`, `MCP_OAUTH_COOKIE_KEYS_FILE`,
`MCP_OAUTH_DATABASE_CREDENTIALS_FILE`, and
`MCP_OAUTH_DATABASE_TLS_CA_FILE`. Secret material is absent from environment
values, Compose substitutions, logs, release evidence, and the edge worker.
The OAuth database credential belongs only to the least-privilege
`commonswarm_oauth_runtime` role and uses verified TLS.
The Compose database connection also requires both
`MCP_OAUTH_DATABASE_HOST`, the TLS hostname sent to the client, and
`MCP_OAUTH_DATABASE_ADDRESS`, the fixed IP mapped for that hostname through
`extra_hosts`; Compose fails before startup if either is unset.
The migration creates that login role without a password. Anvil provisions and
rotates its SCRAM password outside migrations, then stores the role name and
password only in the protected `database-credentials` file. This is an
operator-owned service fact, not a runnable repository release step.

Database backups intentionally omit role passwords: the globals export uses
`pg_dumpall --globals-only --no-role-passwords`, and the generated role export
also contains no password verifier. After any restore, Anvil sets the
`commonswarm_oauth_runtime` password again from its protected 1Password item
before starting the OAuth service, and ensures the protected
`database-credentials` file contains that same restored-role credential.

Directly presented authorization-code and refresh lookup values are stored only
as SHA-256 keys. Provider models that require a recoverable secondary lookup,
and the one-use GoTrue PKCE verifier needed after the browser round trip, remain
recoverable only inside the RLS-protected OAuth schema until expiry or
consumption. They never enter logs, environment values, evidence, or browser
responses.

The `kid` rotation contract publishes the next public key before it signs,
allows the bounded JWKS cache to observe the overlap, retains the previous
public key for the access-token lifetime plus clock skew and propagation
allowance, and removes it only after overlap and unknown-`kid` refresh proofs.
A compromise also revokes affected provider families and CommonSwarm grants.
`MCP_OAUTH_ACTIVE_SIGNING_KID` selects the signing key; all keys in the mounted
set remain published by JWKS during overlap. Cookie keys are newline-delimited,
with the current key first and at least one prior key retained.

`MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED=0` is the release default. Discovery,
JWKS, and health remain available while authorization, token, interaction, and
callback requests return `503 authorization_service_disabled`. Enabling the
flag also requires the reviewed lane-2 management-command binding; startup
fails closed if that binding is absent.

## Lane-2 entrypoint and image build

The real `node src/server.js` entrypoint composes the bindings before calling
`startServer`. The image builds the existing
`supabase/functions/command/index.ts` transaction path for Node; it does not
forward these commands to the public HTTP command route (that route refuses
them). Workspace listing uses `swarm_read.workspaces` with transaction-local
verified-user claims. No extra listener or management bearer is introduced.

Enabled startup additionally requires
`MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE`, mounted from
`/etc/commonswarm-oauth/management-database-credentials`. Install it only
at switch-on with `compose.yaml` plus `compose.management.yaml`. OFF and
both rollback paths use base Compose alone and remove the exact host file
with absolute `/usr/bin/rm` after the release plan checks root binary resolution,
absence of local wrappers, and the literal no-symlink path boundary. The Mac
rm guard remains unchanged. Its JSON document
contains `databaseUrl`, read from the existing box edge configuration's
`SWARM_DATABASE_URL` only. A root program reads it inside the exact OAuth
image on the box at switch-on; it first checks membership, SET ROLE and
effective schema/table grants in read-only transactions. Failed requirements print
`FAIL hm37-mcp-enable REQ <n>: <description>` with only fixed descriptions,
including the exact privilege/object/role for grants; never widen grants. Install
the file
`0440 root:986` after verifying the measured box runtime UID:GID `996:986`.
Compose explicitly overrides Dockerfile `USER 10001:10001`; preserve the
existing unprivileged service identity and stop on drift. Only root and
that runtime group can read it; its ON-only bind mount is read-only.
No management 1Password item is created or used. The login must be able to set
`swarm_command` and `swarm_read`; do not broaden the OAuth artifact role.
The URL must use `MCP_OAUTH_DATABASE_HOST`, contain a login/password, and
have no query overrides. The producer accepts an absent query or exactly one
parsed `sslmode=verify-full` pair; duplicates, other names or values fail closed.
It strips the query before connecting and writing the management URL, since the
runtime rejects query strings and enforces TLS explicitly. It changes the edge
URL host to `db.commonswarm.internal`, which base Compose maps to `172.31.0.10` through
`extra_hosts`; verify the live DNS mapping. The bundled postgres.js client
receives the mounted CA, explicit `servername=db.commonswarm.internal`, and
`rejectUnauthorized=true` from the management runtime adapter. `SUPABASE_URL` and
`SUPABASE_ANON_KEY` come from the existing service env file. Signing/cookie
keys and the OAuth artifact database credential are unchanged. No new
1Password item name is defined here; HezLead supplies existing item references
in vault **Yulan Ventures Infra** if recovery is needed.

The Dockerfile now uses the **clean exact-SHA repository archive root** as its
build context because it packages the shared lane-2 source. The two stages
use the same digest-pinned base. `git archive` excludes untracked files,
including local credentials; the Dockerfile copies only the needed source
paths and package manifests. The command pool is lazy and capped at two
connections; switch-on checks `docker stats --no-stream` against the inspected
memory limit after ON and route probes, and rolls back to OFF at or above 80%.
Build only on the box, retaining the old image; the release procedure contains the exact pull and build commands:

```sh
# step: oauth-image-build
set -eu
: "${OAUTH_RELEASE_DIR:?FAIL: exact-SHA archive directory required}"
: "${PROOF_DIR:?FAIL: release proof directory required}"
BASE_REFERENCE=node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
docker pull "$BASE_REFERENCE" || { echo 'FAIL: pinned base pull' >&2; exit 1; }
docker build --pull=false \
  --iidfile "$PROOF_DIR/oauth-image.id" \
  --file "$OAUTH_RELEASE_DIR/services/mcp-auth/Dockerfile" \
  "$OAUTH_RELEASE_DIR" || { echo 'FAIL: OAuth image build' >&2; exit 1; }
```

Use the resulting local immutable `sha256:<image-id>` in Compose with
`--pull never`, as in HM6. No registry image tag is assumed. See
`docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md` for the full release,
readiness, Caddy switch-on and rollback blocks. Root development dependencies
and service dependencies must be installed before running the service tests;
the service `pretest` builds the management bundle, and `test/*.test.js`
includes the entrypoint regression.

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
and health routes go to the confirmed OAuth loopback port in lane 6. Methods,
request sizes, and timeouts are bounded; external host and scheme are
preserved; credential-bearing headers, cookies, codes, bodies, and query
values are not logged.
