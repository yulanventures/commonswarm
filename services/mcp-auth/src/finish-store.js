// Durable finish storage. Inputs: bound consent, display/result, live-session
// verifier and a provider response creator. Outputs: record or identical saved
// 303/cookies. Fixed bindings/deadlines; one creator; ambiguous crash restarts.
import { hashOpaque } from './browser-security.js';
import { InteractionStateError } from './client-error.js';

const requestSql = `jsonb_build_object('clientId', i.client_id, 'redirectUri', i.redirect_uri,
  'resource', i.resource, 'scopes', i.requested_scopes,
  'pkceChallenge', i.pkce_challenge, 'oauthState', i.oauth_state)`;
const restart = () => new InteractionStateError('interaction_expired', 'Return link unavailable. Start a new connection.');

export class FinishStore {
  // verifySession(browserRow, client) must perform P1's restricted live GoTrue
  // check (including trusted auth time); missing/unproved status is false.
  constructor(pool, { issuer, verifySession } = {}) {
    this.pool = pool;
    this.issuer = new URL(issuer);
    if (this.issuer.protocol !== 'https:' || typeof verifySession !== 'function') throw new TypeError('live session verifier required');
    this.verifySession = verifySession;
  }

  async prepareFinish(binding, { displayModel, providerResult }) {
    const client = await this.pool.connect();
    try {
      await client.query(`INSERT INTO commonswarm_oauth.finish_records
        (interaction_uid, session_hash, user_id, provider_grant_id, commonswarm_grant_id,
         validated_request, display_model, provider_result, expires_at)
        SELECT i.interaction_uid, i.session_hash, i.user_id, i.provider_grant_id,
          i.commonswarm_grant_id, ${requestSql}, $4::jsonb, $5::jsonb,
          LEAST(statement_timestamp() + interval '2 minutes', i.expires_at, b.expires_at)
        FROM commonswarm_oauth.interactions i JOIN commonswarm_oauth.browser_sessions b USING (session_hash)
        WHERE i.interaction_uid=$1 AND i.session_hash=$2 AND i.user_id=$3::uuid
          AND i.resource='https://mcp.commonswarm.com/mcp'
          AND b.user_id=i.user_id AND b.invalidated_at IS NULL AND b.authenticated_at IS NOT NULL
          AND b.expires_at>statement_timestamp() AND i.expires_at>statement_timestamp()
          AND i.completed_at IS NULL AND i.consent_token_consumed_at IS NOT NULL
          AND i.provider_grant_id IS NOT NULL AND i.commonswarm_grant_id IS NOT NULL
          AND ${requestSql}=$6::jsonb
        ON CONFLICT (interaction_uid) DO NOTHING`,
      [binding.interactionUid, hashOpaque(binding.sessionId), binding.userId,
        JSON.stringify(displayModel), JSON.stringify(providerResult), JSON.stringify(binding.request)]);
      return await this.getFinish(binding, client);
    } finally { client.release(); }
  }

  async getFinish(binding, client = this.pool) {
    const result = await client.query(`SELECT f.*, to_jsonb(b) AS browser
      FROM commonswarm_oauth.finish_records f
      JOIN commonswarm_oauth.browser_sessions b ON b.session_hash=f.session_hash
      JOIN commonswarm_oauth.interactions i ON i.interaction_uid=f.interaction_uid
      WHERE f.interaction_uid=$1 AND f.session_hash=$2 AND f.user_id=$3::uuid
        AND i.resource='https://mcp.commonswarm.com/mcp'
        AND f.validated_request=$4::jsonb AND f.validated_request=${requestSql}
        AND i.session_hash=f.session_hash AND i.user_id=f.user_id AND b.user_id=f.user_id
        AND i.provider_grant_id=f.provider_grant_id AND i.commonswarm_grant_id=f.commonswarm_grant_id
        AND b.authenticated_at IS NOT NULL AND b.invalidated_at IS NULL
        AND b.expires_at>statement_timestamp() AND i.expires_at>statement_timestamp()
        AND f.expires_at>statement_timestamp()`,
    [binding.interactionUid, hashOpaque(binding.sessionId), binding.userId, JSON.stringify(binding.request)]);
    const row = result.rows[0];
    if (!row) throw restart();
    try { if (await this.verifySession(row.browser, client) !== true) throw restart(); }
    catch { throw restart(); }
    delete row.browser;
    return row;
  }

  // creator(record) captures provider.interactionFinished's AS resume response
  // without sending it. Never return a code-bearing client callback here.
  async ensureResume(binding, creator) {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 384004))', [binding.interactionUid]);
      locked = true;
      const row = await this.getFinish(binding, client);
      if (row.state === 'resume_ready') return this.validateResponse(row.resume_response);
      if (row.state !== 'prepared') throw restart();
      // Autocommit persists the uncertainty fence BEFORE the external effect.
      await client.query("UPDATE commonswarm_oauth.finish_records SET state='preparing_resume' WHERE interaction_uid=$1", [binding.interactionUid]);
      let response;
      try { response = this.validateResponse(await creator(row)); }
      catch { throw restart(); }
      await this.getFinish(binding, client); // Revocation/expiry while creator ran fails closed.
      const saved = await client.query(`UPDATE commonswarm_oauth.finish_records SET state='resume_ready', resume_response=$2::jsonb
        WHERE interaction_uid=$1 AND state='preparing_resume' AND expires_at>statement_timestamp()`,
      [binding.interactionUid, JSON.stringify(response)]);
      if (saved.rowCount !== 1) throw restart();
      return response;
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 384004))', [binding.interactionUid]); }
        catch { client.release(true); locked = null; }
      }
      if (locked !== null) client.release();
    }
  }

  validateResponse(response) {
    const location = response?.location;
    if (response?.status !== 303 || typeof location !== 'string' || /[\s\\]/u.test(location)) throw restart();
    let target;
    try { target = new URL(location, this.issuer); }
    catch { throw restart(); }
    // oidc-provider's code-free AS resume path; real-provider proof is P9c.
    if (target.origin !== this.issuer.origin || !/^\/authorize\/[A-Za-z0-9_-]+$/u.test(target.pathname) ||
        target.search || target.hash || target.username || target.password) throw restart();
    const cookies = response.cookies ?? [];
    if (!Array.isArray(cookies) || cookies.some(value => typeof value !== 'string' || /[\r\n]/u.test(value))) throw restart();
    return { status: 303, location, cookies: [...cookies] };
  }
}
