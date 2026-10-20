import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { groupConnectedApps } from "./connected-apps.ts";

test("connected apps group owner-scoped rows and grant revocation stops every seat", () => {
  const apps = groupConnectedApps([{
    grant_id: "grant-a",
    client_id: "https://claude.example/oauth.json",
    home_workspace_id: "workspace-a",
    selected_workspace_ids: ["workspace-a", "workspace-lost"],
    state: "revoked",
    revoked_at: "2026-09-28T00:00:00Z",
  }], [{
    seat_id: "seat-a",
    grant_id: "grant-a",
    workspace_id: "workspace-a",
    principal_id: "principal-a",
    name: "Helper <not markup>",
    revoked_at: null,
  }], new Map([["workspace-a", "Alpha"]]));
  assert.equal(apps[0].clientHost, "claude.example");
  assert.deepEqual(apps[0].workspaces, [
    { id: "workspace-a", name: "Alpha" },
    { id: "workspace-lost", name: "workspace-lost" },
  ]);
  assert.equal(apps[0].seats[0].revoked, false);
  assert.equal(apps[0].seats[0].effectiveRevoked, true);
});

test("Connected apps DOM uses textContent, durable rereads, and no browser owner id", async () => {
  const source = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  assert.match(source, /data-connected-apps-open/u);
  assert.match(source, /loadConnectedApps/u);
  assert.match(source, /durable connection revocation is not visible/u);
  assert.match(source, /durable seat revocation is not visible/u);
  assert.doesNotMatch(source, /innerHTML\s*=.*connected/iu);
  const client = await readFile(new URL("./connected-apps.ts", import.meta.url), "utf8");
  assert.doesNotMatch(client, /owner_user_id|ownerUserId/u);
  assert.match(client, /revoke_hosted_mcp_grant/u);
  assert.match(client, /revoke_hosted_mcp_seat/u);
});

// Authoring gate: hosted projection owns policy presence and status precedence;
// this catches lost terminal metadata without replaying the browser click contract.
test("hosted mapping distinguishes unknown, NULL, malformed, chosen and terminal policy", () => {
  const future = "2099-01-01T00:00:00Z", past = "2020-01-01T00:00:00Z";
  for (const [fields, expected] of [
    [{}, "active"],
    [{ connection_expires_at: null }, "active"],
    [{ connection_expires_at: null, connection_expired_at: null }, "active"],
    [{ connection_expires_at: "bad", connection_expired_at: null }, "active"],
    [{ connection_expires_at: future, connection_expired_at: null }, "active"],
    [{ connection_expires_at: future, connection_expired_at: past }, "ended"],
    [{ connection_expires_at: past, connection_expired_at: null }, "ended"],
  ]) {
    const [connection] = groupConnectedApps([{ grant_id: "exact-hosted", state: "active", ...fields }], []);
    assert.equal(connection.grantId, "exact-hosted");
    assert.equal(Object.hasOwn(connection, "connectionExpiresAt"), Object.hasOwn(fields, "connection_expires_at"));
    assert.equal(Object.hasOwn(connection, "connectionExpiredAt"), Object.hasOwn(fields, "connection_expired_at"));
    assert.equal(connection.connectionExpiresAt, fields.connection_expires_at === "bad" ? undefined : fields.connection_expires_at);
    assert.equal(connection.connectionExpiredAt, fields.connection_expired_at);
    assert.equal(connection.status, expected);
  }
  assert.equal(groupConnectedApps([{ state: "revoked", connection_expires_at: past, connection_expired_at: past }], [])[0].status, "revoked");
});
