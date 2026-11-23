const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode a JWT payload locally for non-authoritative client-side comparisons (such as
 * GoTrue's `amr` or `session_id` claims). Returns `null` for any malformed or unreadable token.
 */
export function decodeJwtClaims(accessToken: string): Record<string, unknown> | null {
  if (typeof accessToken !== "string") return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1] || !BASE64URL_RE.test(parts[1]) || parts[1].length % 4 === 1) {
    return null;
  }
  try {
    const padded = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    let json: string;
    if (typeof globalThis.atob === "function") {
      const binary = globalThis.atob(padded);
      if (typeof TextDecoder === "function") {
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } else {
        json = binary;
      }
    } else if (typeof Buffer !== "undefined") {
      json = Buffer.from(padded, "base64").toString("utf8");
    } else {
      return null;
    }
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read GoTrue's refresh-stable `session_id` claim from an access JWT.
 * Stays constant across token refreshes of one login and differs for a new login.
 * Returns `null` ("unknown") when the token is malformed or has no readable `session_id`.
 */
export function sessionIdFromAccessToken(accessToken: string | null | undefined): string | null {
  if (typeof accessToken !== "string" || !accessToken) return null;
  const claims = decodeJwtClaims(accessToken);
  if (!claims || typeof claims.session_id !== "string") return null;
  const trimmed = claims.session_id.trim();
  return trimmed.length > 0 ? trimmed : null;
}
