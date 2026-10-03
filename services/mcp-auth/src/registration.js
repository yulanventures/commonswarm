import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { errors } from "oidc-provider";

import { metadataUrlAllowed } from "./metadata-fetch.js";

export const REGISTRATION_IDLE_SECONDS = 30 * 24 * 60 * 60;
export const CLIENT_SCOPES = Object.freeze(["openid", "offline_access", "mcp"]);
const LOOPBACKS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const GENERIC_CC_SLD = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
const HOSTNAME_IN_TEXT = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\b/giu;

export function registrableDomain(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || isIP(host)) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tld = labels.at(-1);
  const sld = labels.at(-2);
  if (tld.length === 2 && GENERIC_CC_SLD.has(sld) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

function redirectRegistrableDomains(metadata) {
  const domains = new Set();
  for (const uri of metadata.redirect_uris ?? []) {
    domains.add(registrableDomain(new URL(uri).hostname));
  }
  return domains;
}

function hostnamesInText(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  return [...new Set([...value.matchAll(HOSTNAME_IN_TEXT)].map((match) => match[1].toLowerCase()))];
}

function validateDcrBranding(metadata) {
  if (metadata.client_id && metadataUrlAllowed(metadata.client_id)) return;
  if (metadata.logo_uri !== undefined) {
    throw new errors.InvalidClientMetadata("registered clients cannot declare logo_uri");
  }
  const allowed = redirectRegistrableDomains(metadata);
  for (const host of hostnamesInText(metadata.client_name)) {
    if (!allowed.has(registrableDomain(host))) {
      throw new errors.InvalidClientMetadata("client_name cannot claim a different host than redirect_uris");
    }
  }
  if (metadata.client_uri !== undefined) {
    const host = registrableDomain(new URL(metadata.client_uri).hostname);
    if (!allowed.has(host)) {
      throw new errors.InvalidClientMetadata("client_uri must stay on the redirect host");
    }
  }
}

// Applied to both CIMD and registered metadata, after the provider's schema
// checks. The provider independently restricts grants, responses and algorithms.
export function validateClientPolicy(metadata, nativeLoopbackEnabled) {
  if (metadata.token_endpoint_auth_method !== "none") {
    throw new errors.InvalidClientMetadata("only public clients are supported");
  }
  if (metadata.application_type === "native" && !nativeLoopbackEnabled) {
    throw new errors.InvalidClientMetadata("native clients are disabled");
  }
  for (const uri of [...metadata.redirect_uris, ...metadata.post_logout_redirect_uris ?? []]) {
    const url = new URL(uri);
    const loopback = metadata.application_type === "native" && nativeLoopbackEnabled &&
      url.protocol === "http:" && LOOPBACKS.has(url.hostname);
    if (url.username || url.password || url.hash ||
        (!loopback && (url.protocol !== "https:" || LOOPBACKS.has(url.hostname)))) {
      throw new errors.InvalidClientMetadata("redirect URIs require HTTPS or enabled native loopback");
    }
  }
  validateDcrBranding(metadata);
}

// One container: fixed windows bound memory and registration write pressure.
// Never evict a live bucket (which would allow key churn to reset a quota).
// At capacity, fail closed until a window expires. Restart resets the limits.
export function createRegistrationLimiter({ perIp = 10, perHost = 30,
  windowMs = 60 * 60 * 1000, maxKeys = 10_000 } = {}) {
  const buckets = new Map();
  return (ctx) => {
    // registrationResponse decides whether to generate a secret before applying
    // clientDefaults. Set the public default in the parsed request as well.
    ctx.oidc.body.token_endpoint_auth_method ??= "none";
    if (ctx.oidc.body.token_endpoint_auth_method !== "none") {
      throw new errors.InvalidClientMetadata("only public clients are supported");
    }
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
    const uris = ctx.oidc.body.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10) {
      throw new errors.InvalidClientMetadata("register between one and ten redirect URIs");
    }
    let hosts;
    try {
      hosts = [...new Set(uris.map((uri) => registrableDomain(new URL(uri).hostname)))];
    } catch { throw new errors.InvalidClientMetadata("invalid redirect URI"); }
    const keys = [[`ip:${ctx.ip}`, perIp], ...hosts.map((host) => [`host:${host}`, perHost])];
    const until = Math.min(...keys.map(([key]) => buckets.get(key)?.until ?? now + windowMs));
    if (buckets.size + keys.filter(([key]) => !buckets.has(key)).length > maxKeys ||
        keys.some(([key, limit]) => (buckets.get(key)?.count ?? 0) >= limit)) {
      ctx.set("Retry-After", String(Math.max(1, Math.ceil((until - now) / 1000))));
      throw new errors.InvalidRequest("registration rate limit exceeded", 429);
    }
    for (const [key] of keys) {
      const bucket = buckets.get(key) ?? { count: 0, until: now + windowMs };
      bucket.count += 1;
      buckets.set(key, bucket);
    }
    return randomBytes(24).toString("base64url");
  };
}

// Test/spike store. Production composes the PostgreSQL store below.
export function createMemoryRegistrationStore() {
  const clients = new Map();
  const store = {
    async upsert(id, metadata) {
      await store.cleanup();
      if (clients.size >= 10_000) throw new errors.InvalidRequest("registration capacity exceeded", 429);
      const now = Date.now();
      clients.set(id, { client_id: id, metadata: structuredClone(metadata), registered_at: now,
        last_used_at: null, expires_at: now + REGISTRATION_IDLE_SECONDS * 1000 });
    },
    async find(id) {
      await store.cleanup();
      return structuredClone(clients.get(id)?.metadata);
    },
    async destroy(id) { clients.delete(id); },
    async markUsed(id) {
      await store.cleanup();
      const row = clients.get(id);
      if (row) { row.last_used_at = Date.now(); row.expires_at = Date.now() + REGISTRATION_IDLE_SECONDS * 1000; }
    },
    async cleanup() {
      let removed = 0;
      for (const [id, row] of clients) if (row.expires_at <= Date.now()) { clients.delete(id); removed += 1; }
      return removed;
    },
    async list() { await store.cleanup(); return structuredClone([...clients.values()]); },
  };
  return store;
}

// Safe for an internal admin caller; never exposed as an unauthenticated route.
export const LIST_REGISTRATIONS_SQL = `SELECT client_id, metadata, registered_at, last_used_at, expires_at
  FROM commonswarm_oauth.registered_clients
  WHERE expires_at > statement_timestamp()
  ORDER BY registered_at DESC, client_id LIMIT $1`;

export function createPostgresRegistrationStore(pool) {
  return {
    async upsert(id, metadata) {
      await pool.query(`INSERT INTO commonswarm_oauth.registered_clients (client_id, metadata)
        VALUES ($1, $2::jsonb)`, [id, JSON.stringify(metadata)]);
    },
    async find(id) {
      const result = await pool.query(`SELECT metadata FROM commonswarm_oauth.registered_clients
        WHERE client_id = $1 AND expires_at > statement_timestamp()`, [id]);
      return result.rows[0]?.metadata;
    },
    async destroy(id) {
      await pool.query("DELETE FROM commonswarm_oauth.registered_clients WHERE client_id = $1", [id]);
    },
    async markUsed(id) {
      await pool.query(`UPDATE commonswarm_oauth.registered_clients
        SET last_used_at = statement_timestamp(), expires_at = statement_timestamp() + interval '30 days'
        WHERE client_id = $1 AND expires_at > statement_timestamp()`, [id]);
    },
    async cleanup() {
      try {
        return (await pool.query(`DELETE FROM commonswarm_oauth.registered_clients
          WHERE expires_at <= statement_timestamp()`)).rowCount;
      } catch (error) {
        // Maintenance must not abort startup or the hourly retry. Request-time
        // reads and writes still reject when the database is unavailable.
        const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code)
          ? error.code : "UNKNOWN";
        console.error(`mcp-auth registration cleanup failed (${code})`);
      }
    },
    async list(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("invalid listing limit");
      return (await pool.query(LIST_REGISTRATIONS_SQL, [limit])).rows;
    },
  };
}
