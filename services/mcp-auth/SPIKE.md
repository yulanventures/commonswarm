# `oidc-provider` 9.12.2 MCP OAuth compatibility spike

Result: **feasible**. No requirement is `NOT possible`, but CIMD needs a fetch-policy wrapper and refresh safety needs an atomic adapter. The package pins the requested `oidc-provider@9.12.2` because that version exists on npm. Tests run the provider in process on ephemeral `127.0.0.1` ports, with issuer `https://mcp.commonswarm.com`, `provider.proxy = true`, and explicit forwarded HTTPS headers.

| # | Requirement | Result | Exact configuration or boundary |
|---:|---|---|---|
| 1 | Discovery | config | `clientAuthMethods: ["none"]`, `scopes: ["openid", "offline_access", "mcp"]`, and `features.clientIdMetadataDocument: { enabled: true, ack: "draft-02" }`. S256-only PKCE and RFC 9207 support flags are emitted natively. |
| 2 | CIMD | native + wrapper code | `features.clientIdMetadataDocument = { enabled: true, ack: "draft-02", allowFetch }`, injected `fetch`, and `fetchResponseBodyLimits["client_id metadata document"] = 4096`. Native code requires document `client_id` equality, exact registered redirects, sets `redirect: "manual"`, rejects a redirect response, enforces the configured body cap, and protects real network connections from resolved special-use IPs. Wrapper `allowFetch` rejects non-HTTPS and literal private/loopback addresses (including IPv4-compatible, IPv4-mapped, 6to4, and well-known-prefix NAT64 embeddings) before fetch; `createMetadataFetch` adds a 100 ms whole-body deadline because a test double need not honor the library's request-level abort signal. |
| 3 | PKCE | config | `pkce.required: () => true`; oidc-provider supports only S256, so plain and missing challenges fail. |
| 4 | RFC 8707 resource binding | config | `features.resourceIndicators.enabled = true`; `defaultResource` rejects missing or multi-valued indicators; `useGrantedResource` rejects omission at the token endpoint; `getResourceServerInfo` accepts only `https://mcp.commonswarm.com/mcp` and returns `{ accessTokenFormat: "jwt", accessTokenTTL: 300, audience: "https://mcp.commonswarm.com/mcp", jwt: { sign: { alg: "ES256" } }, scope: "mcp" }`. Other, missing, and duplicate resource values return `invalid_target`. |
| 5 | RFC 9207 response issuer | native | Authorization responses include `iss`; discovery emits `authorization_response_iss_parameter_supported: true`. |
| 6 | ES256 JWT access token | config | The resource server returns `accessTokenFormat: "jwt"`, `accessTokenTTL: 300`, `audience`, and `jwt.sign.alg: "ES256"`; `extraTokenClaims` adds `grant_id`. Tests independently verify with `jose` and the discovered JWKS. |
| 7 | Refresh rotation and replay family revocation | config + wrapper code | `rotateRefreshToken: true`; native replay handling returns `invalid_grant` and requests grant-family revocation. `createAtomicMemoryAdapter` supplies compare-and-swap consumption plus a grant-revocation tombstone for the process-local spike; production needs the PostgreSQL contract below. |
| 8 | Native loopback redirects | native | A CIMD client with `application_type: "native"` gets RFC 8252 loopback matching: a registered `http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback` matches the same host/path at any port. Unregistered host/path combinations fail. |

## PostgreSQL adapter contract for refresh safety

The library calls adapter `consume` and `upsert` separately, so a PostgreSQL adapter cannot claim one transaction around both without adding a wider request transaction. It must instead preserve these invariants across those calls:

1. `consume(id)` performs a conditional update such as `UPDATE ... SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND grant_revoked_at IS NULL RETURNING grant_id`; exactly one concurrent caller may transition the token. A caller that loses this compare-and-swap returns `invalid_grant` without revoking the family, because both racing requests may have read the token before either consumed it.
2. When the library's initial `find(id)` observes an already-consumed refresh token, its replay path calls `revokeByGrantId`. That operation must atomically create a durable family tombstone and revoke or delete every artifact indexed by the grant before returning.
3. Every grant-bound `upsert`, including a rotated refresh token, must check the same durable tombstone in its transaction and throw `invalid_grant` rather than silently skip the write when the grant is revoked. This prevents both resurrection and a successful response containing an unstored token if replay revocation overtakes rotation.
4. Grant-member lookup, tombstone creation, revocation, and inserts need indexes/constraints and transaction isolation sufficient for multiple application processes; correctness cannot depend on an in-memory mutex.

The later PostgreSQL acceptance test must race two independent connections, prove exactly one HTTP success and one `invalid_grant`, and then prove the winner's stored replacement refresh token rotates successfully. A separate sequential replay must still revoke the whole family and make the newer token unusable.

This spike does not implement sign-in, consent UI, storage, deployment, or production key management. Tests auto-approve one fixed account.
