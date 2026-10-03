import { ADMIN_RESOURCE, ADMIN_ACCESS_TTL_SECONDS, adminScopes } from './protocol.js';

// Pinned OAuth signing authority. Public keys are cached; authority never is.
export const ADMIN_ISSUER = "https://mcp.commonswarm.com";
export const ADMIN_JWKS_URL = "https://mcp.commonswarm.com/jwks";

const TOKEN_MAX_BYTES = 12 * 1024;
const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_MAX_KEYS = 16;
const KID_MAX_LENGTH = 128;
const CLIENT_ID_MAX_LENGTH = 2048;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface VerifiedAdminToken {
  grant_id: string; admin_grant_id: string; admin_identity_id: string;
  owner_user_id: string; connection_id: string; client_id: string;
  resource: typeof ADMIN_RESOURCE; scope_names: string[]; registry_version: number;
  manifest_digest: string; jti: string; jkt: string; kid: string;
  issued_at: number; expires_at: number;
}

export interface JwtVerifierOptions {
  cacheTtlSeconds?: number;
  clockSkewSeconds?: number;
  fetch?: typeof fetch;
  now?: () => number;
  fetchTimeoutMs?: number;
}

interface PublicKeyEntry {
  kid: string;
  key: CryptoKey;
}

interface JsonObject {
  [key: string]: unknown;
}

export class AdminTokenError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AdminTokenError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function decodeBase64Url(value: string, limit: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length > Math.ceil(limit * 4 / 3) + 4) {
    throw new AdminTokenError("invalid_token");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new AdminTokenError("invalid_token");
  }
  if (decoded.length > limit) throw new AdminTokenError("invalid_token");
  const result = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (base64url(result) !== value) throw new AdminTokenError('invalid_token');
  return result;
}

function parsePart(value: string, limit: number): JsonObject {
  let parsed: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value, limit));
    rejectDuplicateKeys(json);
    parsed = JSON.parse(json);
  } catch (error) {
    if (error instanceof AdminTokenError) throw error;
    throw new AdminTokenError("invalid_token");
  }
  const result = object(parsed);
  if (result === null) throw new AdminTokenError("invalid_token");
  return result;
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const announced = response.headers.get("content-length");
  if (announced !== null && (!/^\d+$/u.test(announced) || Number(announced) > maximum)) {
    throw new AdminTokenError("jwks_unavailable");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new AdminTokenError("jwks_unavailable");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function boundedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  close: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("jwks_timeout")), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export class AdminJwtVerifier {
  readonly issuer = ADMIN_ISSUER;
  readonly resource = ADMIN_RESOURCE;
  readonly jwksUrl = ADMIN_JWKS_URL;
  private readonly cacheTtlSeconds: number;
  private readonly clockSkewSeconds: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private keys = new Map<string, CryptoKey>();
  private cacheExpiresAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(options: JwtVerifierOptions = {}) {
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? 60;
    this.clockSkewSeconds = 0;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 3_000;
    if (!Number.isSafeInteger(this.cacheTtlSeconds) || this.cacheTtlSeconds < 1 ||
        this.cacheTtlSeconds > 300 || !Number.isSafeInteger(this.clockSkewSeconds) ||
        this.clockSkewSeconds < 0 || this.clockSkewSeconds > 60 ||
        !Number.isSafeInteger(this.fetchTimeoutMs) || this.fetchTimeoutMs < 100 ||
        this.fetchTimeoutMs > 10_000) {
      throw new Error("Admin runtime JWT bounds are invalid");
    }
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private async refresh(parentSignal?: AbortSignal): Promise<void> {
    if (this.refreshPromise !== null) return await this.refreshPromise;
    const operation = (async () => {
      const linked = linkedSignal(parentSignal, this.fetchTimeoutMs);
      try {
        const response = await this.fetcher(this.jwksUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: linked.signal,
        });
        if (!response.ok || response.url !== "" && response.url !== this.jwksUrl) {
          throw new AdminTokenError("jwks_unavailable");
        }
        const bytes = await boundedBytes(response, JWKS_MAX_BYTES);
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new AdminTokenError("jwks_unavailable");
        }
        const document = object(parsed);
        if (document === null || !Array.isArray(document.keys) ||
            document.keys.length < 1 || document.keys.length > JWKS_MAX_KEYS) {
          throw new AdminTokenError("jwks_unavailable");
        }
        const imported: PublicKeyEntry[] = [];
        const seen = new Set<string>();
        for (const value of document.keys) {
          const jwk = object(value);
          const kid = jwk?.kid;
          if (jwk === null || typeof kid !== "string" || kid.length < 1 ||
              kid.length > KID_MAX_LENGTH || seen.has(kid) || jwk.kty !== "EC" ||
              jwk.crv !== "P-256" || jwk.alg !== "ES256" || jwk.use !== "sig" ||
              typeof jwk.x !== "string" || typeof jwk.y !== "string" ||
              Object.hasOwn(jwk, "d") ||
              (jwk.key_ops !== undefined &&
                (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify")))) {
            throw new AdminTokenError("jwks_unavailable");
          }
          seen.add(kid);
          try {
            imported.push({ kid, key: await crypto.subtle.importKey(
              "jwk",
              jwk as JsonWebKey,
              { name: "ECDSA", namedCurve: "P-256" },
              false,
              ["verify"],
            ) });
          } catch {
            throw new AdminTokenError("jwks_unavailable");
          }
        }
        this.keys = new Map(imported.map(({ kid, key }) => [kid, key]));
        this.cacheExpiresAt = this.now() + this.cacheTtlSeconds;
      } catch (error) {
        if (error instanceof AdminTokenError) throw error;
        throw new AdminTokenError("jwks_unavailable");
      } finally {
        linked.close();
      }
    })();
    this.refreshPromise = operation;
    try {
      await operation;
    } finally {
      this.refreshPromise = null;
    }
  }

  async verify(token: string, signal?: AbortSignal): Promise<VerifiedAdminToken> {
    if (typeof token !== "string" || new TextEncoder().encode(token).byteLength > TOKEN_MAX_BYTES) {
      throw new AdminTokenError("invalid_token");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new AdminTokenError("invalid_token");
    }
    const header = parsePart(parts[0]!, 2 * 1024);
    if (header.typ !== "at+jwt" || header.crit !== undefined || header.b64 !== undefined || header.alg !== "ES256" || typeof header.kid !== "string" ||
        header.kid.length < 1 || header.kid.length > KID_MAX_LENGTH ||
        Object.hasOwn(header, "jku") || Object.hasOwn(header, "jwk") ||
        Object.hasOwn(header, "x5u") || Object.hasOwn(header, "x5c")) {
      throw new AdminTokenError("invalid_token");
    }
    let key = this.cacheExpiresAt > this.now() ? this.keys.get(header.kid) : undefined;
    if (key === undefined) {
      // A missing kid performs one bounded fetch. There is no second fallback,
      // and no URL or key carried by the token participates in this lookup.
      await this.refresh(signal);
      key = this.keys.get(header.kid);
    }
    if (key === undefined) throw new AdminTokenError("invalid_token");
    const signature = decodeBase64Url(parts[2]!, 64);
    if (signature.byteLength !== 64) throw new AdminTokenError("invalid_token");
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signatureBuffer = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength,
    ) as ArrayBuffer;
    if (!await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, signatureBuffer, signed,
    )) throw new AdminTokenError("invalid_token");

    const claims = parsePart(parts[1]!, 8 * 1024);
    const now = this.now();
    if (claims.iss !== this.issuer || claims.aud !== this.resource ||
        typeof claims.sub !== "string" || !UUID_RE.test(claims.sub) ||
        claims.grant_class !== 'delegated_admin' ||
        typeof claims.grant_id !== "string" || claims.grant_id.length < 1 || claims.grant_id.length > 2048 ||
        typeof claims.admin_grant_id !== 'string' || !UUID_RE.test(claims.admin_grant_id) ||
        typeof claims.admin_identity_id !== 'string' || !UUID_RE.test(claims.admin_identity_id) ||
        !Number.isSafeInteger(claims.registry_version) || Number(claims.registry_version) < 2 ||
        typeof claims.scope !== 'string' || claims.scope.length > 2048 ||
        !adminScopes(claims.scope.split(' '), Number(claims.registry_version)) ||
        !claims.scope.split(' ').includes('admin:read') ||
        typeof claims.manifest_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(claims.manifest_digest) ||
        typeof claims.jti !== 'string' || new TextEncoder().encode(claims.jti).length < 1 || new TextEncoder().encode(claims.jti).length > 200 ||
        typeof object(claims.cnf)?.jkt !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(String(object(claims.cnf)?.jkt)) ||
        typeof claims.connection_id !== "string" || !UUID_RE.test(claims.connection_id) ||
        typeof claims.client_id !== "string" || claims.client_id.length < 1 ||
        claims.client_id.length > CLIENT_ID_MAX_LENGTH ||
        !boundedInteger(claims.iat) || !boundedInteger(claims.exp) ||
        claims.exp <= claims.iat || claims.exp - claims.iat > ADMIN_ACCESS_TTL_SECONDS ||
        claims.iat > now + this.clockSkewSeconds ||
        claims.iat < now - ADMIN_ACCESS_TTL_SECONDS - this.clockSkewSeconds ||
        claims.exp <= now - this.clockSkewSeconds ||
        claims.exp > now + ADMIN_ACCESS_TTL_SECONDS + this.clockSkewSeconds ||
        (claims.nbf !== undefined &&
          (!boundedInteger(claims.nbf) || claims.nbf > now + this.clockSkewSeconds ||
            claims.nbf > claims.exp))) {
      throw new AdminTokenError("invalid_token");
    }
    return {
      grant_id: claims.grant_id,
      admin_grant_id: claims.admin_grant_id.toLowerCase(),
      admin_identity_id: claims.admin_identity_id.toLowerCase(),
      scope_names: claims.scope.split(' '), registry_version: Number(claims.registry_version),
      manifest_digest: claims.manifest_digest, jti: claims.jti,
      jkt: String(object(claims.cnf)?.jkt), kid: header.kid, issued_at: claims.iat * 1000,
      owner_user_id: claims.sub.toLowerCase(),
      connection_id: claims.connection_id.toLowerCase(),
      client_id: claims.client_id,
      resource: ADMIN_RESOURCE,
      expires_at: claims.exp * 1000,
    };
  }
}

export type ProofOutcome = 'accepted' | 'nonce_required' | 'stale_proof' | 'replay';
export interface AdminProofStore {
  // Both operations resolve only after their separate database transaction commits.
  admit(jti: string, jkt: string, domain: 'admin_command' | 'admin_mcp', iat: number, nonce: Uint8Array | null): Promise<ProofOutcome>;
  registerNonce(digest: Uint8Array, jkt: string): Promise<boolean>;
}
export interface AdminAdmission {
  readonly token: Readonly<VerifiedAdminToken>;
  readonly digest: Uint8Array;
}
const admissions = new WeakMap<object, { digest: Uint8Array; verifier: AdminRequestVerifier }>();
export function isAdminAdmission(value: unknown, verifier?: AdminRequestVerifier): value is AdminAdmission {
  return value !== null && typeof value === 'object' && admissions.has(value) && (verifier === undefined || admissions.get(value)?.verifier === verifier);
}
export function adminAdmissionDigest(admission: AdminAdmission): Uint8Array {
  const value = admissions.get(admission);
  if (!value) throw new AdminTokenError('invalid_token');
  return value.digest.slice();
}
export class AdminProofError extends Error {
  constructor(readonly code: 'invalid_dpop' | 'replay' | 'nonce_required', readonly nonce?: string) {
    super(code); this.name = 'AdminProofError';
  }
}
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export async function adminTokenDigest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
export const ADMIN_COMMAND_URI = 'https://api.commonswarm.com/functions/v1/command';
export const ADMIN_MCP_URI = 'https://api.commonswarm.com/admin';

/** The only capability constructor. A body, identity object or module import cannot
 * manufacture admission. Public URI is a reviewed constant, never forwarded input. */
export class AdminRequestVerifier {
  constructor(private readonly jwt: AdminJwtVerifier, private readonly store: AdminProofStore) {}
  async verify(request: Request, surface: 'admin_command' | 'admin_mcp'): Promise<AdminAdmission> {
    const auth = request.headers.get('authorization');
    const proof = request.headers.get('dpop');
    const match = auth === null ? null : /^DPoP ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu.exec(auth);
    if (!match || auth!.length > 16 * 1024) throw new AdminTokenError('invalid_token');
    const access = match[1]!;
    if (proof === null || proof.length > 12 * 1024) throw new AdminProofError('invalid_dpop');
    const token = await this.jwt.verify(access, request.signal);
    try {
      const parts = proof.split('.');
      if (parts.length !== 3 || parts.some(p => p.length === 0)) throw new Error();
      const header = parsePart(parts[0]!, 2048), claims = parsePart(parts[1]!, 8192), jwk = object(header.jwk);
      if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' ||
          Object.keys(header).some(k => !['typ', 'alg', 'jwk'].includes(k)) ||
          !jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' ||
          Object.keys(jwk).some(k => !['kty','crv','x','y','alg','use','key_ops','ext'].includes(k)) ||
          typeof jwk.x !== 'string' || typeof jwk.y !== 'string' ||
          decodeBase64Url(jwk.x, 32).length !== 32 || decodeBase64Url(jwk.y, 32).length !== 32 ||
          jwk.alg !== undefined && jwk.alg !== 'ES256' || jwk.use !== undefined && jwk.use !== 'sig' ||
          jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || jwk.key_ops.some(op => op !== 'verify'))) throw new Error();
      const thumbprint = base64url(await adminTokenDigest(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y })));
      if (thumbprint !== token.jkt) throw new Error();
      const key = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const sig = decodeBase64Url(parts[2]!, 64);
      if (sig.length !== 64 || !await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
          sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength) as ArrayBuffer,
          new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error();
      const uri = surface === 'admin_command' ? ADMIN_COMMAND_URI : ADMIN_MCP_URI;
      const incoming = new URL(request.url);
      if (incoming.search !== '' || incoming.hash !== '' ||
          claims.htm !== request.method || claims.htu !== uri ||
          !boundedInteger(claims.iat) || typeof claims.jti !== 'string' ||
          new TextEncoder().encode(claims.jti).length < 1 || new TextEncoder().encode(claims.jti).length > 200 ||
          claims.ath !== base64url(await adminTokenDigest(access))) throw new Error();
      const digest = await adminTokenDigest(access);
      const outcome = await this.store.admit(claims.jti, token.jkt, surface, claims.iat,
        typeof claims.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(claims.nonce) ? await adminTokenDigest(claims.nonce) : null);
      if (outcome === 'nonce_required') {
        const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
        if (!await this.store.registerNonce(await adminTokenDigest(nonce), token.jkt)) throw new Error();
        throw new AdminProofError('nonce_required', nonce);
      }
      if (outcome === 'replay') throw new AdminProofError('replay');
      if (outcome !== 'accepted') throw new Error();
      const admission = Object.freeze({ token: Object.freeze({ ...token, scope_names: Object.freeze([...token.scope_names]) as unknown as string[] }), digest });
      admissions.set(admission, { digest: digest.slice(), verifier: this });
      return admission;
    } catch (error) {
      if (error instanceof AdminProofError) throw error;
      throw new AdminProofError('invalid_dpop');
    }
  }
}

// JSON.parse silently accepts repeated members. JWT ambiguity must fail closed.
function rejectDuplicateKeys(json: string): void {
  const tokens = json.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/gu) ?? [];
  const stack: { keys: Set<string>; object: boolean; key: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '{' || token === '[') stack.push({ keys: new Set(), object: token === '{', key: token === '{' });
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { const top = stack.at(-1); if (top?.object) top.key = true; }
    else if (token.startsWith('"') && stack.at(-1)?.key && tokens[i + 1] === ':') {
      const top = stack.at(-1)!; const key = JSON.parse(token);
      if (top.keys.has(key)) throw new AdminTokenError('invalid_token');
      top.keys.add(key); top.key = false;
    }
  }
}

export interface AdminInput {
  command_id?: unknown; stream?: unknown; resource?: unknown; command?: unknown;
  [key: string]: unknown;
}
export type AdminAuditKind = 'init' | 'list' | 'read' | 'action';
export type AdminSecurityReason = 'unknown_admin_credential' | 'invalid_token' | 'invalid_dpop' | 'replay' | 'nonce_required' | 'invalid_request' | 'transaction_failed' | 'rate_limited' | 'forbidden' | 'inactive';
