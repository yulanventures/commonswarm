import { AUTH_PROVIDER_CATALOG } from "./auth-provider-catalog.js";
import { adminTransactionContext, joinAdminTransaction } from "./admin-transaction.js";
import { createHash } from "node:crypto";

import { hashOpaque, opaqueMatches, randomOpaque } from "./browser-security.js";
import { InteractionStateError } from "./client-error.js";

async function transaction(pool, callback) {
  if (adminTransactionContext(false)) return joinAdminTransaction(callback);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await callback(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function conflict(message) {
  return new InteractionStateError("interaction_binding_mismatch", message);
}

// PostgreSQL stores this CAS counter as bigint. pg returns int8 as text by
// default; the HTTP forms, JSON API and consent digest use safe JS integers.
export function interactionRow(row) {
  if (!row) return row;
  const raw = row.selection_version;
  const version = typeof raw === "string" && /^(?:0|[1-9][0-9]*)$/u.test(raw)
    ? Number(raw) : raw;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw conflict("interaction selection version is invalid");
  }
  return { ...row, selection_version: version };
}

export class InteractionStore {
  constructor(pool, { sessionTtlSeconds = 3600, interactionTtlSeconds = 600 } = {}) {
    this.pool = pool;
    this.sessionTtlSeconds = sessionTtlSeconds;
    this.interactionTtlSeconds = interactionTtlSeconds;
  }

  async createSession() {
    const value = randomOpaque();
    await this.pool.query(
      `INSERT INTO commonswarm_oauth.browser_sessions (session_hash, expires_at)
       VALUES ($1, statement_timestamp() + ($2 * interval '1 second'))`,
      [hashOpaque(value), this.sessionTtlSeconds],
    );
    return value;
  }

  async requireSession(value) {
    if (typeof value !== "string" || value.length < 20) return null;
    const result = await this.pool.query(
      `SELECT session_hash, user_id, user_email, user_display_name, authenticated_at
         FROM commonswarm_oauth.browser_sessions
        WHERE session_hash = $1 AND invalidated_at IS NULL
          AND expires_at > statement_timestamp()
        LIMIT 1`,
      [hashOpaque(value)],
    );
    return result.rows[0] ?? null;
  }

  async rotateSession(value) {
    const next = randomOpaque();
    return await transaction(this.pool, async (client) => {
      const current = await client.query(
        `UPDATE commonswarm_oauth.browser_sessions
            SET invalidated_at = statement_timestamp()
          WHERE session_hash = $1 AND invalidated_at IS NULL
            AND expires_at > statement_timestamp()
          RETURNING user_id, user_email, user_display_name, authenticated_at`,
        [hashOpaque(value)],
      );
      if (current.rowCount !== 1) throw conflict("browser session is unavailable");
      const row = current.rows[0];
      await client.query(
        `INSERT INTO commonswarm_oauth.browser_sessions (
           session_hash, user_id, user_email, user_display_name,
           authenticated_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5,
                   statement_timestamp() + ($6 * interval '1 second'))`,
        [hashOpaque(next), row.user_id, row.user_email, row.user_display_name,
          row.authenticated_at, this.sessionTtlSeconds],
      );
      await client.query(
        `UPDATE commonswarm_oauth.interactions
            SET session_hash = $1, consent_token_hash = NULL,
                consent_token_consumed_at = NULL, selection_version = selection_version + 1,
                updated_at = statement_timestamp()
          WHERE session_hash = $2 AND completed_at IS NULL`,
        [hashOpaque(next), hashOpaque(value)],
      );
      return next;
    });
  }

  async bindInteraction(binding) {
    const result = await this.pool.query(
      `INSERT INTO commonswarm_oauth.interactions (
         interaction_uid, session_hash, client_id, redirect_uri, resource,
         requested_scopes, pkce_challenge, oauth_state, user_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10::uuid,
                 statement_timestamp() + ($9 * interval '1 second'))
       ON CONFLICT (interaction_uid) DO UPDATE SET updated_at = statement_timestamp()
       WHERE commonswarm_oauth.interactions.session_hash = EXCLUDED.session_hash
         AND commonswarm_oauth.interactions.client_id = EXCLUDED.client_id
         AND commonswarm_oauth.interactions.redirect_uri = EXCLUDED.redirect_uri
         AND commonswarm_oauth.interactions.resource = EXCLUDED.resource
         AND commonswarm_oauth.interactions.requested_scopes = EXCLUDED.requested_scopes
         AND commonswarm_oauth.interactions.pkce_challenge = EXCLUDED.pkce_challenge
         AND commonswarm_oauth.interactions.oauth_state IS NOT DISTINCT FROM EXCLUDED.oauth_state
         AND commonswarm_oauth.interactions.completed_at IS NULL
         AND commonswarm_oauth.interactions.expires_at > statement_timestamp()
       RETURNING *`,
      [binding.interactionUid, hashOpaque(binding.sessionId), binding.clientId,
        binding.redirectUri, binding.resource, binding.scopes, binding.pkceChallenge,
        binding.oauthState ?? null, this.interactionTtlSeconds, binding.userId ?? null],
    );
    if (result.rowCount !== 1) throw conflict("OAuth interaction binding changed");
    return interactionRow(result.rows[0]);
  }

  async beginSignIn(interactionUid, sessionId, { state, verifier, provider }) {
    if (!AUTH_PROVIDER_CATALOG.some(({ id }) => id === provider)) throw new InteractionStateError("invalid_callback");
    const result = await this.pool.query(
      `UPDATE commonswarm_oauth.interactions
          SET signin_state_hash = $1, signin_pkce_verifier = $2,
              signin_state_consumed_at = NULL, updated_at = statement_timestamp()
        WHERE interaction_uid = $3 AND session_hash = $4
          AND completed_at IS NULL AND expires_at > statement_timestamp()`,
      [hashOpaque(`${provider}:${state}`), verifier, interactionUid, hashOpaque(sessionId)],
    );
    if (result.rowCount !== 1) throw conflict("sign-in interaction is unavailable");
  }

  async consumeSignIn(interactionUid, sessionId, state, provider) {
    if (!AUTH_PROVIDER_CATALOG.some(({ id }) => id === provider)) throw new InteractionStateError("invalid_callback");
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT * FROM commonswarm_oauth.interactions
          WHERE interaction_uid = $1 AND session_hash = $2
            AND signin_state_consumed_at IS NULL
            AND completed_at IS NULL AND expires_at > statement_timestamp()
          FOR UPDATE`,
        [interactionUid, hashOpaque(sessionId)],
      );
      const row = result.rows[0];
      if (!row || !opaqueMatches(`${provider}:${state}`, row.signin_state_hash)) {
        throw conflict("sign-in state does not match the browser interaction");
      }
      await client.query(
        `UPDATE commonswarm_oauth.interactions
            SET signin_state_consumed_at = statement_timestamp(), updated_at = statement_timestamp()
          WHERE interaction_uid = $1`,
        [interactionUid],
      );
      return interactionRow(row);
    });
  }

  async attachUser(interactionUid, sessionId, user) {
    return await transaction(this.pool, async (client) => {
      const sessionHash = hashOpaque(sessionId);
      const binding = await client.query(
        `SELECT user_id FROM commonswarm_oauth.interactions
          WHERE interaction_uid = $1 AND session_hash = $2
            AND completed_at IS NULL AND expires_at > statement_timestamp() FOR UPDATE`,
        [interactionUid, sessionHash],
      );
      if (binding.rowCount !== 1) throw conflict("sign-in interaction is unavailable");
      if (binding.rows[0].user_id && binding.rows[0].user_id !== user.id) {
        throw new InteractionStateError("different_account");
      }
      const updated = await client.query(
        `UPDATE commonswarm_oauth.browser_sessions
            SET user_id = $1, user_email = $2, user_display_name = $3,
                authenticated_at = statement_timestamp()
          WHERE session_hash = $4 AND invalidated_at IS NULL
            AND expires_at > statement_timestamp() AND (user_id IS NULL OR user_id = $1::uuid)`,
        [user.id, user.email ?? null, user.displayName, sessionHash],
      );
      if (updated.rowCount !== 1) throw new InteractionStateError("different_account");
      const interaction = await client.query(
        `UPDATE commonswarm_oauth.interactions
            SET user_id = $1, updated_at = statement_timestamp()
          WHERE interaction_uid = $2 AND session_hash = $3
            AND signin_state_consumed_at IS NOT NULL
            AND completed_at IS NULL AND expires_at > statement_timestamp()
          RETURNING *`,
        [user.id, interactionUid, sessionHash],
      );
      if (interaction.rowCount !== 1) throw conflict("sign-in interaction is unavailable");
      return interactionRow(interaction.rows[0]);
    });
  }

  async issueConsentToken(interactionUid, sessionId, userId) {
    const token = randomOpaque();
    const result = await this.pool.query(
      `UPDATE commonswarm_oauth.interactions
          SET consent_token_hash = $1, consent_token_consumed_at = NULL,
              updated_at = statement_timestamp()
        WHERE interaction_uid = $2 AND session_hash = $3 AND user_id = $4::uuid
          AND EXISTS (SELECT 1 FROM commonswarm_oauth.browser_sessions AS browser
            WHERE browser.session_hash = commonswarm_oauth.interactions.session_hash
              AND browser.user_id = $4::uuid AND browser.invalidated_at IS NULL
              AND browser.expires_at > statement_timestamp())
          AND completed_at IS NULL AND expires_at > statement_timestamp()
        RETURNING selection_version`,
      [hashOpaque(token), interactionUid, hashOpaque(sessionId), userId],
    );
    if (result.rowCount !== 1) throw conflict("consent interaction is unavailable");
    return { token, selectionVersion: interactionRow(result.rows[0]).selection_version };
  }

  async selectWithToken({ interactionUid, sessionId, userId, token, selectionVersion, workspaceIds }) {
    const selected = [...new Set(workspaceIds)].sort();
    if (selected.length < 1 || selected.length > 100) throw conflict("workspace selection is invalid");
    const nextToken = randomOpaque();
    const manifestDigest = createHash("sha256").update(JSON.stringify(selected)).digest();
    const result = await this.pool.query(
      `UPDATE commonswarm_oauth.interactions
          SET selected_workspace_ids = $1::uuid[], manifest_digest = $2,
              selection_version = selection_version + 1,
              consent_token_hash = $3, consent_token_consumed_at = NULL,
              updated_at = statement_timestamp()
        WHERE interaction_uid = $4 AND session_hash = $5 AND user_id = $6::uuid
          AND selection_version = $7 AND consent_token_hash = $8
          AND consent_token_consumed_at IS NULL
          AND EXISTS (SELECT 1 FROM commonswarm_oauth.browser_sessions AS browser
            WHERE browser.session_hash = commonswarm_oauth.interactions.session_hash
              AND browser.user_id = $6::uuid AND browser.invalidated_at IS NULL
              AND browser.expires_at > statement_timestamp())
          AND completed_at IS NULL AND expires_at > statement_timestamp()
        RETURNING *`,
      [selected, manifestDigest, hashOpaque(nextToken), interactionUid, hashOpaque(sessionId), userId,
        selectionVersion, hashOpaque(token)],
    );
    if (result.rowCount !== 1) throw conflict("selection token is stale, swapped, or already used");
    return { interaction: interactionRow(result.rows[0]), token: nextToken };
  }

  async bindProviderGrant(interactionUid, providerGrantId, commonswarmGrantId) {
    const result = await this.pool.query(
      `UPDATE commonswarm_oauth.interactions
          SET provider_grant_id = COALESCE(provider_grant_id, $1),
              commonswarm_grant_id = COALESCE(commonswarm_grant_id, $2::uuid),
              updated_at = statement_timestamp()
        WHERE interaction_uid = $3 AND completed_at IS NULL
          AND (provider_grant_id IS NULL OR provider_grant_id = $1)
          AND (commonswarm_grant_id IS NULL OR commonswarm_grant_id = $2::uuid)
        RETURNING *`,
      [providerGrantId, commonswarmGrantId, interactionUid],
    );
    if (result.rowCount !== 1) throw conflict("provider grant binding changed");
    return interactionRow(result.rows[0]);
  }

  async consumeConsent({ interactionUid, sessionId, userId, token, selectionVersion }) {
    const result = await this.pool.query(
      `UPDATE commonswarm_oauth.interactions
          SET consent_token_consumed_at = statement_timestamp(), updated_at = statement_timestamp()
        WHERE interaction_uid = $1 AND session_hash = $2 AND user_id = $3::uuid
          AND selection_version = $4 AND consent_token_hash = $5
          AND consent_token_consumed_at IS NULL
          AND EXISTS (SELECT 1 FROM commonswarm_oauth.browser_sessions AS browser
            WHERE browser.session_hash = commonswarm_oauth.interactions.session_hash
              AND browser.user_id = $3::uuid AND browser.invalidated_at IS NULL
              AND browser.expires_at > statement_timestamp())
          AND completed_at IS NULL AND expires_at > statement_timestamp()
        RETURNING *`,
      [interactionUid, hashOpaque(sessionId), userId, selectionVersion, hashOpaque(token)],
    );
    if (result.rowCount !== 1) throw conflict("consent token is stale, swapped, or already used");
    return interactionRow(result.rows[0]);
  }

  async selectAndConsumeConsent({
    interactionUid,
    sessionId,
    userId,
    token,
    selectionVersion,
    workspaceIds,
  }) {
    const selected = [...new Set(workspaceIds)].sort();
    if (selected.length < 1 || selected.length > 100) {
      throw conflict("workspace selection is invalid");
    }
    const manifestDigest = createHash("sha256").update(JSON.stringify(selected)).digest();
    const result = await this.pool.query(
      `UPDATE commonswarm_oauth.interactions
          SET selected_workspace_ids = $1::uuid[], manifest_digest = $2,
              selection_version = selection_version + 1,
              consent_token_consumed_at = statement_timestamp(),
              updated_at = statement_timestamp()
        WHERE interaction_uid = $3 AND session_hash = $4 AND user_id = $5::uuid
          AND selection_version = $6 AND consent_token_hash = $7
          AND consent_token_consumed_at IS NULL
          AND (
            commonswarm_grant_id IS NULL OR
            (selected_workspace_ids = $1::uuid[] AND manifest_digest = $2)
          )
          AND EXISTS (SELECT 1 FROM commonswarm_oauth.browser_sessions AS browser
            WHERE browser.session_hash = commonswarm_oauth.interactions.session_hash
              AND browser.user_id = $5::uuid AND browser.invalidated_at IS NULL
              AND browser.expires_at > statement_timestamp())
          AND completed_at IS NULL AND expires_at > statement_timestamp()
        RETURNING *`,
      [selected, manifestDigest, interactionUid, hashOpaque(sessionId), userId,
        selectionVersion, hashOpaque(token)],
    );
    if (result.rowCount !== 1) throw conflict("consent token is stale, swapped, or already used");
    return interactionRow(result.rows[0]);
  }

  async switchAccount({ interactionUid, sessionId, userId, token }) {
    const next = randomOpaque();
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT * FROM commonswarm_oauth.interactions
          WHERE interaction_uid = $1 AND session_hash = $2 AND user_id = $3::uuid
            AND consent_token_hash = $4 AND consent_token_consumed_at IS NULL
            AND commonswarm_grant_id IS NULL
            AND completed_at IS NULL AND expires_at > statement_timestamp() FOR UPDATE`,
        [interactionUid, hashOpaque(sessionId), userId, hashOpaque(token)],
      );
      if (result.rowCount !== 1) throw conflict("switch-account token is stale or the connection has started");
      const ended = await client.query(
        `UPDATE commonswarm_oauth.browser_sessions SET invalidated_at = statement_timestamp()
          WHERE session_hash = $1 AND user_id = $2::uuid AND invalidated_at IS NULL
            AND expires_at > statement_timestamp()`, [hashOpaque(sessionId), userId],
      );
      if (ended.rowCount !== 1) throw new InteractionStateError("different_account");
      await client.query(
        `INSERT INTO commonswarm_oauth.browser_sessions (session_hash, expires_at)
          VALUES ($1, statement_timestamp() + ($2 * interval '1 second'))`,
        [hashOpaque(next), this.sessionTtlSeconds],
      );
      await client.query(
        `UPDATE commonswarm_oauth.interactions SET session_hash = $1, user_id = NULL,
            selected_workspace_ids = '{}', manifest_digest = NULL,
            selection_version = selection_version + 1, consent_token_hash = NULL,
            consent_token_consumed_at = NULL, signin_state_hash = NULL,
            signin_pkce_verifier = NULL, signin_state_consumed_at = NULL,
            updated_at = statement_timestamp() WHERE interaction_uid = $2`,
        [hashOpaque(next), interactionUid],
      );
      return next;
    });
  }

  async complete(interactionUid) {
    await this.pool.query(
      `UPDATE commonswarm_oauth.interactions SET completed_at = statement_timestamp(),
         updated_at = statement_timestamp() WHERE interaction_uid = $1`,
      [interactionUid],
    );
  }
}
