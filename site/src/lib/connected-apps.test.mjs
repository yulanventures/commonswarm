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
