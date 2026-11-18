import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkspaceAdminGrants, peopleAdminCoverage, peopleAdminDetail, peopleAdminEmpty, peopleAdminHeading, peopleAdminLabel, peopleAdminPeople, workspaceAdminGrantsNotDeployed, workspaceAdminGrantsRefused } from "./people/admins.ts";

const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const row = (over = {}) => ({ grant_id: id(1), principal_id: id(2), agent_name: "Atlas", owner_user_id: id(3), owner_display: "Sam Rivera",
  level: "workspace", expires_at: "2026-12-12T00:00:00Z", created_at: "2026-11-18T00:00:00Z", may_end: true, ...over });

test("null means the viewer is not an owner; rows are read; anything else is a failed read", () => {
  assert.equal(parseWorkspaceAdminGrants(null), null);
  assert.deepEqual(parseWorkspaceAdminGrants({ grants: [] }), []);
  assert.deepEqual(parseWorkspaceAdminGrants({ grants: [row()] }), [{ grantId: id(1), principalId: id(2), agentName: "Atlas", giverId: id(3), giverName: "Sam Rivera",
    level: "workspace", expiresAt: "2026-12-12T00:00:00Z", mayEnd: true }]);
  for (const bad of [undefined, [], {}, { grants: null }, { grants: [row({ level: "root" })] }, { grants: [row({ may_end: "yes" })] }, { grants: [row({ grant_id: "x" })] },
    { grants: [row({ agent_name: "" })] }, { grants: [row({ expires_at: "soon" })] }])
    assert.throws(() => parseWorkspaceAdminGrants(bad), /could not be read/, JSON.stringify(bad));
  assert.equal(parseWorkspaceAdminGrants({ grants: [row({ owner_display: "  " })] })[0].giverName, null);
});

test("a row says what was given, who gave it and when it ends", () => {
  const [grant] = parseWorkspaceAdminGrants({ grants: [row()] });
  assert.equal(peopleAdminDetail(grant, id(9)), "Workspace admin · granted by Sam Rivera · ends Dec 12, 2026");
  assert.equal(peopleAdminDetail(grant, id(3).toUpperCase()), "Workspace admin · granted by you · ends Dec 12, 2026");
  assert.equal(peopleAdminDetail({ ...grant, level: "organization", giverName: null, expiresAt: null }, id(9)), "Organization admin · grantor name unavailable · no end date");
});

test("the heading and the empty line say whether the list is everything or only the viewer's own", () => {
  assert.equal(peopleAdminHeading({ all: true }), "Admin access given to agents");
  assert.equal(peopleAdminHeading({ all: false }), "Admin access you gave to agents");
  assert.equal(peopleAdminEmpty({ all: true }), "No active admin grants for agents here.");
  assert.equal(peopleAdminEmpty({ all: false }), "No active admin grants from you here.");
});

test("people who can manage are owners and admins; ending a wider grant says how far it reaches", () => {
  assert.deepEqual(peopleAdminPeople([{ role: "owner" }, { role: "member" }, { role: "admin" }, {}]).map((p) => p.role), ["owner", "admin"]);
  assert.equal(peopleAdminCoverage({ level: "workspace" }, "Rivera household"), "Rivera household");
  assert.equal(peopleAdminCoverage({ level: "organization" }, "Rivera household"), "this organization");
  assert.equal(peopleAdminCoverage({ level: "scoped" }, "Rivera household"), "every workspace it covers");
});

test("a server without the read yet is not a failed read; any other refusal is", () => {
  for (const [status, code] of [[404, undefined], [400, "PGRST202"], [400, "42883"]]) assert.equal(workspaceAdminGrantsNotDeployed(status, code), true, `${status} ${code}`);
  for (const [status, code] of [[500, undefined], [401, "PGRST301"], [403, "42501"], [400, undefined]]) assert.equal(workspaceAdminGrantsNotDeployed(status, code), false, `${status} ${code}`);
});

test("a refusal is told apart from a failure, and look-alike rows from each other", () => {
  assert.equal(workspaceAdminGrantsRefused(401), true); assert.equal(workspaceAdminGrantsRefused(403), true);
  for (const status of [404, 500, 503, 400]) assert.equal(workspaceAdminGrantsRefused(status), false, String(status));
  const g = (grantId, principalId, agentName, level = "workspace") => ({ grantId, principalId, agentName, giverId: "u", giverName: null, level, expiresAt: null, mayEnd: true });
  const rows = [g("11111111-g", "aaaaaaaa-p", "Atlas"), g("22222222-g", "bbbbbbbb-p", "Atlas"), g("33333333-g", "cccccccc-p", "Pixel"), g("44444444-g", "cccccccc-p", "Pixel", "organization"),
    g("55555555-g", "dddddddd-p", "Twin"), g("66666666-g", "dddddddd-p", "Twin")];
  assert.deepEqual(rows.map((row) => peopleAdminLabel(row, rows)), ["Atlas (agent aaaaaaaa)", "Atlas (agent bbbbbbbb)", "Pixel", "Pixel", "Twin (grant 55555555)", "Twin (grant 66666666)"],
    "two agents with one name carry the agent's id; one agent's two levels need nothing; one agent's two grants of a level carry the grant's id");
});
