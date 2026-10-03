import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import Provider from "oidc-provider";

export const SPIKE_ISSUER = "https://mcp.commonswarm.com";
export const SPIKE_ADMIN_RESOURCE = "https://api.commonswarm.com/admin";

// Shared by the PostgreSQL spike and its service-free HTTP transport check.
// This resource gate exists ONLY in the test harness; production stays closed.
export function createSpikeProvider({ adapter, metadata, jwk, extraTokenClaims, jwtCustomizer }) {
  const provider = new Provider(SPIKE_ISSUER, {
    adapter, clients: [metadata], jwks: { keys: [jwk] },
    clientAuthMethods: ["none"], grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"], scopes: ["openid", "offline_access"],
    cookies: { keys: [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")] },
    pkce: { required: () => true },
    features: { devInteractions: { enabled: false }, resourceIndicators: { enabled: true,
      defaultResource: () => SPIKE_ADMIN_RESOURCE, useGrantedResource: () => false,
      getResourceServerInfo: () => ({ audience: SPIKE_ADMIN_RESOURCE, scope: "admin:read", accessTokenFormat: "jwt",
        accessTokenTTL: 300, jwt: { sign: { alg: "ES256" } } }) } },
    routes: { authorization: "/authorize" }, rotateRefreshToken: true,
    ttl: { Grant: 86400, RefreshToken: 86400, AuthorizationCode: 60 },
    findAccount: async (_ctx, accountId) => ({ accountId, claims: async () => ({ sub: accountId }) }),
    extraClientMetadata: { properties: ["dpop_signing_alg"], validator() {} },
    extraTokenClaims,
    formats: { customizers: { jwt: jwtCustomizer } },
  });
  provider.proxy = true;
  provider.on("server_error", () => {});
  return provider;
}

// Spike-only: the provider caches adapters by model, NOT by HTTP request.
// The existing adapter's private transaction helper is adapted here; production
// must explicitly join the coordinator rather than acquire/commit its own client.
export function requestDatabase() {
  const context = new AsyncLocalStorage();
  function current() {
    const scope = context.getStore();
    assert.ok(scope && !scope.closed, "adapter requires a live request transaction");
    return scope;
  }
  async function query(sql, values) {
    const scope = current();
    if (scope.failure) throw scope.failure;
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      scope.joined.push(sql);
      return { rows: [], rowCount: 0 }; // Join, never send nested transaction SQL.
    }
    const operation = (async () => {
      const result = await scope.client.query(sql, values);
      const stamp = (await scope.client.query(
        "SELECT txid_current()::text AS xid, pg_backend_pid() AS pid",
      )).rows[0];
      scope.calls.push({ sql: sql.trim().split(/\s+/u).slice(0, 3).join(" "), ...stamp });
      if (/^\s*(INSERT|UPDATE|DELETE)\b/iu.test(sql)) {
        scope.writes.push({ ...stamp, sql: scope.calls.at(-1).sql });
        if (scope.writes.length === scope.failAfterWrite) {
          throw new Error("spike injected after write");
        }
      }
      return result;
    })();
    scope.pending.add(operation);
    try { return await operation; }
    catch (error) { scope.failure ??= error; throw error; }
    finally { scope.pending.delete(operation); }
  }
  return { context, current, pool: { query, connect: async () => ({ query, release() {} }) },
    async drain(scope) {
      await Promise.allSettled([...scope.pending]);
      if (scope.failure) throw scope.failure;
    } };
}

// Hold the REAL ServerResponse. Koa normally responds after its middleware
// resolves, while interactionFinished writes/end directly. Both are covered.
// Deliberately bounded and nonstreaming; flushHeaders fails closed.
export function holdResponse(response, maxBytes = 64 * 1024) {
  const originals = Object.fromEntries(["writeHead", "write", "end", "flushHeaders"]
    .map(name => [name, response[name]]));
  const operations = [];
  let bytes = 0, ended = false;
  function bodySize(chunk, encoding) {
    if (chunk != null) bytes += Buffer.isBuffer(chunk) ? chunk.length
      : Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined);
    if (bytes > maxBytes) throw new Error("spike response limit exceeded");
  }
  response.writeHead = function (status, message, headers) {
    this.statusCode = status;
    if (typeof message === "string") this.statusMessage = message;
    const supplied = typeof message === "object" ? message : headers;
    for (const [name, value] of Object.entries(supplied ?? {})) this.setHeader(name, value);
    operations.push(["writeHead", [status, message, headers]]);
    return this;
  };
  response.write = function (...args) {
    assert.equal(ended, false, "write after staged end");
    bodySize(args[0], args[1]); operations.push(["write", args]); return true;
  };
  response.end = function (...args) {
    assert.equal(ended, false, "duplicate staged end");
    bodySize(args[0], args[1]); ended = true; operations.push(["end", args]); return this;
  };
  response.flushHeaders = () => { throw new Error("spike forbids early flush"); };
  function restore() { Object.assign(response, originals); }
  return {
    get staged() { return ended; },
    release() {
      assert.equal(response.headersSent, false, "response escaped before commit");
      restore();
      for (const [name, args] of operations) originals[name].apply(response, args);
      operations.length = 0;
    },
    discard() {
      restore(); operations.length = 0;
      for (const name of response.getHeaderNames()) response.removeHeader(name);
    },
  };
}
