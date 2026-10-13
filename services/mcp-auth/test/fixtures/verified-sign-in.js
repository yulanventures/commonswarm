import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Dummy evidence for the GoTrue /user + live-session contract. This JWT is
// deliberately unsigned: only fixtures may accept it as a verified token.
export function verifiedSignIn({ userId, sessionId = randomUUID(),
  authenticatedAtSeconds = Math.floor(Date.now() / 1000) - 60,
  email = "human@example.test", displayName = "Human",
  issuer = "https://api.commonswarm.com/auth/v1" } = {}) {
  const authenticatedAt = new Date(authenticatedAtSeconds * 1000);
  const claims = { iss: issuer, aud: "authenticated", sub: userId,
    session_id: sessionId, exp: Math.floor(Date.now() / 1000) + 3600 };
  const accessToken = [Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"), "DUMMYSIGNATURE"].join(".");
  const liveRow = { session_id: sessionId, user_id: userId, authenticated_at: authenticatedAt };
  const pool = { async query(sql, [sid, uid]) {
    assert.equal(sql, "SELECT * FROM commonswarm_oauth.live_gotrue_session($1::uuid, $2::uuid)");
    const rows = sid === sessionId && uid === userId ? [liveRow] : [];
    return { rows, rowCount: rows.length };
  } };
  const identity = { userId, email, displayName, identityVerified: true,
    gotrueSessionId: sessionId, interactiveAuthAtSeconds: authenticatedAtSeconds };
  return { accessToken, liveRow, pool, identity, user: { ...identity, id: userId },
    browserSession: { user_id: userId, user_email: email, user_display_name: displayName,
      gotrue_session_id: sessionId, authenticated_at: authenticatedAt,
      expires_at: new Date((authenticatedAtSeconds + 604800) * 1000) } };
}
