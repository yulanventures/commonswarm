import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  grantRiskBadge,
  STANDING_GRANT_COPY,
  STANDING_GRANT_RULES,
  STANDING_IDLE_PAUSE_DAYS,
  STANDING_RESUME_ACTORS,
  type GrantRiskInput,
} from "../../lib/standing-grants";

const dashboard = await readFile(
  new URL("./LiveDashboard.astro", import.meta.url),
  "utf8",
);
const now = Date.parse("2026-08-31T12:00:00Z");
const base: GrantRiskInput = {
  kind: "timeboxed",
  horizonExpiresAt: "2026-09-30T12:00:00Z",
  boundDeviceId: null,
  lastUsedAt: "2026-08-31T11:00:00Z",
  issuedAt: "2026-08-01T12:00:00Z",
  newHostAt: null,
  suspendedAt: null,
  revokedAt: null,
};

test("grant risk badge covers every state in strict first-match order", () => {
  const cases: Array<[string, GrantRiskInput]> = [
    ["REVOKED", { ...base, revokedAt: "2026-08-31T11:00:00Z", suspendedAt: "2026-08-30T11:00:00Z" }],
    ["SUSPENDED", { ...base, suspendedAt: "2026-08-30T11:00:00Z", newHostAt: "2026-08-29T11:00:00Z" }],
    ["NEW HOST", { ...base, newHostAt: "2026-08-29T11:00:00Z" }],
    ["UNBOUND", { ...base, kind: "standing", horizonExpiresAt: null, boundDeviceId: null }],
    ["STALE", { ...base, lastUsedAt: "2026-08-20T11:00:00Z" }],
    ["HORIZON 3d", { ...base, horizonExpiresAt: "2026-09-02T12:00:00Z" }],
  ];
  for (const [expected, row] of cases) {
    assert.equal(grantRiskBadge(row, now), expected);
  }
  assert.equal(grantRiskBadge(base, now), null);
});

test("standing copy is assembled from the rules, never a typed list", () => {
  /* THE RETIRED ASSERTION PINNED THE WRONG CLAIM. It required exactly "This does
     not expire. Revoke is the only kill switch." while the schema already
     suspended an idle standing grant after 14 days with no way back — so revoke
     was NOT the only thing that stopped it, and the green test made that
     sentence stable rather than true. What is checked now is that the paragraph
     is BUILT from the rules and that the rules name the two numbers the server
     enforces, which is a claim that fails when the enforcement moves. */
  assert.equal(STANDING_GRANT_COPY, STANDING_GRANT_RULES.join(" "));
  assert.ok(STANDING_GRANT_RULES.length >= 3);
  assert.match(STANDING_GRANT_COPY, /does not expire/);
  assert.match(
    STANDING_GRANT_COPY,
    new RegExp(`${STANDING_IDLE_PAUSE_DAYS} days with no use pauses it`),
  );
  for (const actor of STANDING_RESUME_ACTORS) {
    assert.ok(
      STANDING_GRANT_COPY.includes(actor),
      `the copy drops "${actor}" from the set the resume gate accepts`,
    );
  }
  assert.match(STANDING_GRANT_COPY, /Revoking it is the only permanent stop\./);
  assert.doesNotMatch(
    STANDING_GRANT_COPY,
    /Revoke is the only kill switch/,
    "retired copy claimed revocation was the only stop while idle suspension also stopped it",
  );
});

test("roster keeps support truth in details and uses the in-dialog key confirmation", async () => {
  const view = await readFile(new URL("../../lib/people-dialog-view.ts", import.meta.url), "utf8");
  assert.match(dashboard, /technical.push\(STANDING_GRANT_COPY\)/);
  assert.match(view, /Turn off key for/);
  assert.match(view, /showPeopleConfirmation/);
  assert.match(dashboard, /action === "turn-off-key"[\s\S]*revokeAgentToken\(session, uuid\(\), workspaceId, grant.tokenId\)/);
  assert.match(dashboard, /grantRiskBadge\(\{/);
  assert.match(dashboard, /grant\.lastUsedAt/);
});

test("Resume client sends the existing command and uses the public stable refusal", async () => {
  const { runInNewContext } = await import("node:vm");
  const { default: ts } = await import("typescript");
  const client = await readFile(new URL("../../lib/commonswarm.ts", import.meta.url), "utf8");
  const start = client.indexOf("export async function resumeRenewalGrant(");
  const end = client.indexOf("export interface PendingMemberInvite", start);
  assert.ok(start >= 0 && end > start);
  const calls: unknown[][] = [];
  let result: { status: number; body: Record<string, string> } = { status: 200, body: { status: "accepted" } };
  const source = client.slice(start, end).replace("export async", "async");
  const compiled = ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
  const resume = runInNewContext(`${compiled}; resumeRenewalGrant`, { postCommand: async (...args: unknown[]) => { calls.push(args); return result; } });
  const session = { user: { id: "member" } };
  await resume(session, "request", "workspace", "key-id");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0]?.slice(0, 4))), [session, "request", { kind: "resume_renewal_grant", renewal_grant_id: "key-id" }, { workspace_id: "workspace", stream: { kind: "workspace" } }]);
  result = { status: 403, body: { error: "forbidden" } };
  await assert.rejects(resume(session, "request-2", "workspace", "key-id"), /This key cannot be resumed with your current access\. Nothing was changed\./);
  result = { status: 503, body: { error: "unavailable" } };
  await assert.rejects(resume(session, "request-3", "workspace", "key-id"), /Resume was not confirmed\. Reload to check/);
});
