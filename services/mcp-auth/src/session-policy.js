// Decide ordinary MCP reuse from a stored browser session and OAuth parameters.
// Output names the login refusal; live GoTrue identity/time must agree with storage.
// Rotation, refresh and account selection never supply new authentication evidence.
import { readGoTrueSession } from "./gotrue.js";

export const SESSION_TTL_SECONDS = 604800;

export async function sessionReuseDecision(session, params = {}, { pool, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const deny = reason => ({ allowed: false, error: "login_required", reason });
  const at = session?.authenticated_at == null ? NaN : Math.floor(new Date(session.authenticated_at).getTime() / 1000);
  const expires = session?.expires_at == null ? NaN : new Date(session.expires_at).getTime() / 1000;
  if (!session?.user_id || !session.gotrue_session_id || session.invalidated_at != null
      || !Number.isSafeInteger(at) || at <= 0 || at > nowSeconds || !(expires > nowSeconds)
      || nowSeconds >= at + SESSION_TTL_SECONDS) return deny("unproved_session");
  const live = await readGoTrueSession(pool, { sessionId: session.gotrue_session_id, userId: session.user_id });
  if (!live || live.interactiveAuthAtSeconds !== at) return deny("revoked_or_unproved");
  if (String(params.prompt ?? "").split(/\s+/u).includes("login")) return deny("fresh_login_required");
  if (params.max_age !== undefined) {
    const raw = params.max_age;
    const age = typeof raw === "number" || typeof raw === "string" && /^(?:0|[1-9][0-9]*)$/u.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(age) || age < 0) return deny("invalid_max_age");
    if (age === 0 || nowSeconds - at > age) return deny("fresh_login_required");
  }
  return { allowed: true, authenticatedAtSeconds: at };
}
