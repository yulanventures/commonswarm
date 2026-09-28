import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { Pool } from "pg";

import { InteractionStore } from "../src/interaction-store.js";
import { hashOpaque } from "../src/browser-security.js";

const databaseUrl = process.env.MCP_OAUTH_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const userId = randomUUID();
const interactionUid = `consent-${randomUUID()}`;
const workspaceId = randomUUID();
let firstSession;
let secondSession;

before(async () => {
  const exists = await pool.query("SELECT to_regclass('commonswarm_oauth.interactions') AS table_name");
  assert.ok(exists.rows[0]?.table_name, "run the OAuth migration before this suite");
  const store = new InteractionStore(pool);
  firstSession = await store.createSession();
  secondSession = await store.createSession();
  await store.bindInteraction({
    interactionUid,
    sessionId: firstSession,
    clientId: "https://client.example/oauth.json",
    redirectUri: "https://client.example/callback",
    resource: "https://mcp.commonswarm.com/mcp",
    scopes: ["openid", "mcp"],
    pkceChallenge: "a".repeat(43),
    oauthState: "oauth-state",
  });
  await pool.query(
    `UPDATE commonswarm_oauth.browser_sessions SET user_id = $1, authenticated_at = statement_timestamp()
      WHERE session_hash IN (
        SELECT session_hash FROM commonswarm_oauth.interactions WHERE interaction_uid = $2
      )`,
    [userId, interactionUid],
  );
  await pool.query(
    "UPDATE commonswarm_oauth.interactions SET user_id = $1 WHERE interaction_uid = $2",
    [userId, interactionUid],
  );
});

after(async () => {
  await pool.query("DELETE FROM commonswarm_oauth.interactions WHERE interaction_uid = $1", [interactionUid]);
  await pool.query(
    "DELETE FROM commonswarm_oauth.browser_sessions WHERE session_hash IN ($1, $2)",
    [hashOpaque(firstSession), hashOpaque(secondSession)],
  );
  await pool.end();
});

test("selection is session-bound, consumed once, and has a same-session positive control", async () => {
  const store = new InteractionStore(pool);
  const issued = await store.issueConsentToken(interactionUid, firstSession, userId);
  await assert.rejects(store.selectAndConsumeConsent({
    interactionUid,
    sessionId: secondSession,
    userId,
    token: issued.token,
    selectionVersion: issued.selectionVersion,
    workspaceIds: [workspaceId],
  }), { code: "interaction_binding_mismatch" });
  const selected = await store.selectAndConsumeConsent({
    interactionUid,
    sessionId: firstSession,
    userId,
    token: issued.token,
    selectionVersion: issued.selectionVersion,
    workspaceIds: [workspaceId],
  });
  assert.deepEqual(selected.selected_workspace_ids, [workspaceId]);
  assert.equal(selected.manifest_digest.length, 32);
  await store.bindProviderGrant(interactionUid, `provider-${randomUUID()}`, randomUUID());
  const retry = await store.issueConsentToken(interactionUid, firstSession, userId);
  await assert.rejects(store.selectAndConsumeConsent({
    interactionUid,
    sessionId: firstSession,
    userId,
    token: retry.token,
    selectionVersion: retry.selectionVersion,
    workspaceIds: [randomUUID()],
  }), { code: "interaction_binding_mismatch" });
  const resumed = await store.selectAndConsumeConsent({
    interactionUid,
    sessionId: firstSession,
    userId,
    token: retry.token,
    selectionVersion: retry.selectionVersion,
    workspaceIds: [workspaceId],
  });
  assert.deepEqual(resumed.selected_workspace_ids, [workspaceId]);
  await assert.rejects(store.selectAndConsumeConsent({
    interactionUid,
    sessionId: firstSession,
    userId,
    token: retry.token,
    selectionVersion: retry.selectionVersion,
    workspaceIds: [workspaceId],
  }), { code: "interaction_binding_mismatch" });
});
