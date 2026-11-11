import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGrantSeatAdminCommand,
  clearSeatAdminReauthIntent,
  hasActiveGrantForTarget,
  hasFreshInteractiveSession,
  newestInteractiveAmrSeconds,
  nonActiveSeatAdminGrantMessage,
  parseSeatAdminGrants,
  parseSeatAdminStatus,
  readSeatAdminReauthIntent,
  resolveSeatAdminPanelModel,
  saveSeatAdminReauthIntent,
  seatAdminRemovalReceipt,
} from "./seat-admin.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const ORG_1 = "55555555-5555-4555-8555-555555555555";
const ORG_2 = "66666666-6666-4666-8666-666666666666";
const WS_GRANT_ID = "77777777-7777-4777-8777-777777777777";
const ORG_GRANT_ID = "88888888-8888-4888-8888-888888888888";

function encodeJwt(claims) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

test("parseSeatAdminStatus accepts disabled and enabled v3 status payloads and rejects malformed shapes", () => {
  assert.deepEqual(parseSeatAdminStatus({ enabled: false }), { enabled: false });
  const parsed = parseSeatAdminStatus({
    enabled: true,
    registry_version: 3,
    agents: [
      {
        principal_id: AGENT_ID.toUpperCase(),
        name: "Builder",
        eligible: {
          workspace: [WORKSPACE_ID.toUpperCase()],
          organization: [ORG_1, ORG_2],
          scoped: [WORKSPACE_ID],
        },
        active_grant_ids: [WS_GRANT_ID.toUpperCase()],
      },
    ],
  });
  assert.deepEqual(parsed, {
    enabled: true,
    registryVersion: 3,
    agents: [
      {
        principalId: AGENT_ID,
        name: "Builder",
        eligible: {
          workspace: [WORKSPACE_ID],
          organization: [ORG_1, ORG_2],
          scoped: [WORKSPACE_ID],
        },
        activeGrantIds: [WS_GRANT_ID],
      },
    ],
  });
  assert.equal(parseSeatAdminStatus(null), null);
  assert.equal(parseSeatAdminStatus({ enabled: true, registry_version: 3, agents: [{ principal_id: "bad" }] }), null);
});

test("parseSeatAdminGrants normalizes expired active rows, accepts downgraded rows, and preserves distinct grant levels", () => {
  const now = Date.parse("2026-11-10T18:00:00.000Z");
  const rows = parseSeatAdminGrants(
    {
      grants: [
        {
          grant_id: WS_GRANT_ID,
          principal_id: AGENT_ID,
          level: "workspace",
          organization_id: null,
          scope_names: ["role:workspace_admin"],
          workspace_ids: [WORKSPACE_ID],
          registry_version: 3,
          expires_at: "2026-11-10T17:59:59.000Z",
          state: "active",
          created_at: "2026-11-01T00:00:00.000Z",
          ended_at: null,
          end_reason: null,
        },
        {
          grant_id: ORG_GRANT_ID,
          principal_id: AGENT_ID,
          level: "organization",
          organization_id: ORG_1,
          scope_names: ["role:organization_admin"],
          workspace_ids: [],
          registry_version: 3,
          expires_at: null,
          state: "downgraded",
          created_at: "2026-11-02T00:00:00.000Z",
          ended_at: "2026-11-10T17:30:00.000Z",
          end_reason: "owner_downgrade",
        },
      ],
    },
    now,
  );
  assert.ok(rows);
  assert.equal(rows[0].state, "expired");
  assert.equal(rows[1].state, "downgraded");
  assert.equal(rows[1].endReason, "owner_downgrade");
  assert.equal(rows[1].level, "organization");
});

test("hasFreshInteractiveSession mirrors fresh-auth.ts interactive AMR methods and rejects refreshed iat alone", () => {
  const nowMs = 1_760_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);

  for (const method of ["oauth", "password", "otp", "totp", "sso/saml", "magiclink", "email/signup", "MagicLink"]) {
    const token = encodeJwt({
      sub: USER_ID,
      iat: nowSec,
      amr: [{ method, timestamp: nowSec - 120 }],
    });
    assert.equal(hasFreshInteractiveSession(token, nowMs), true, `expected ${method} to count as interactive`);
  }

  const nonInteractiveMethodToken = encodeJwt({
    sub: USER_ID,
    iat: nowSec,
    amr: [{ method: "webauthn", timestamp: nowSec - 10 }],
  });
  assert.equal(hasFreshInteractiveSession(nonInteractiveMethodToken, nowMs), false);

  const refreshedTokenWithOldAmr = encodeJwt({
    sub: USER_ID,
    iat: nowSec,
    amr: [
      { method: "password", timestamp: nowSec - 301 },
      { method: "token_refresh", timestamp: nowSec },
    ],
  });
  assert.equal(newestInteractiveAmrSeconds({ amr: [{ method: "password", timestamp: nowSec - 301 }, { method: "token_refresh", timestamp: nowSec }] }), nowSec - 301);
  assert.equal(hasFreshInteractiveSession(refreshedTokenWithOldAmr, nowMs), false);

  const iatOnlyToken = encodeJwt({
    sub: USER_ID,
    iat: nowSec,
  });
  assert.equal(hasFreshInteractiveSession(iatOnlyToken, nowMs), false);
});

test("buildGrantSeatAdminCommand preserves the confirmation dialog's pinned numeric epoch-ms expiresAt", () => {
  const pinnedExpiryMs = 1_765_393_200_000;
  assert.deepEqual(
    buildGrantSeatAdminCommand({
      principalId: AGENT_ID,
      level: "workspace",
      scopeId: WORKSPACE_ID,
      days: 30,
      expiresAt: pinnedExpiryMs,
    }),
    {
      kind: "grant_seat_admin",
      principal_id: AGENT_ID,
      level: "workspace",
      scope_names: ["role:workspace_admin"],
      workspace_ids: [WORKSPACE_ID],
      organization_id: null,
      expires_at: pinnedExpiryMs,
    },
  );
  assert.deepEqual(
    buildGrantSeatAdminCommand({
      principalId: AGENT_ID,
      level: "organization",
      scopeId: ORG_2,
      days: null,
      expiresAt: null,
    }),
    {
      kind: "grant_seat_admin",
      principal_id: AGENT_ID,
      level: "organization",
      scope_names: ["role:organization_admin"],
      workspace_ids: [],
      organization_id: ORG_2,
      expires_at: null,
    },
  );
});

test("resolveSeatAdminPanelModel stays hidden while feature status is loading, failed, or disabled", () => {
  const base = {
    signedIn: true,
    sampleMode: false,
    viewerUserId: USER_ID,
    agent: { principalId: AGENT_ID, name: "Builder", ownerUserId: USER_ID, transport: "local", turnOnly: false },
    currentWorkspace: { id: WORKSPACE_ID, name: "Design" },
    grantsState: { phase: "error", message: "Should not surface while status is off" },
  };
  assert.equal(resolveSeatAdminPanelModel({ ...base, statusState: { phase: "loading" } }).panel.state, "hidden");
  assert.equal(resolveSeatAdminPanelModel({ ...base, statusState: { phase: "error", message: "500" } }).panel.state, "hidden");
  assert.equal(
    resolveSeatAdminPanelModel({ ...base, statusState: { phase: "loaded", status: { enabled: false } } }).panel.state,
    "hidden",
  );
});

test("resolveSeatAdminPanelModel never renders Off when an active_grant_id is unresolved", () => {
  const resolved = resolveSeatAdminPanelModel({
    signedIn: true,
    sampleMode: false,
    viewerUserId: USER_ID,
    agent: { principalId: AGENT_ID, name: "Builder", ownerUserId: USER_ID, transport: "local", turnOnly: false },
    currentWorkspace: { id: WORKSPACE_ID, name: "Design" },
    statusState: {
      phase: "loaded",
      status: {
        enabled: true,
        registryVersion: 3,
        agents: [
          {
            principalId: AGENT_ID,
            name: "Builder",
            eligible: { workspace: [WORKSPACE_ID], organization: [ORG_1], scoped: [WORKSPACE_ID] },
            activeGrantIds: [WS_GRANT_ID],
          },
        ],
      },
    },
    grantsState: {
      phase: "loaded",
      grants: [],
    },
  });
  assert.equal(resolved.panel.state, "ready");
  assert.equal(resolved.panel.workspace?.access.state, "unresolved");
  assert.equal(resolved.panel.organization?.access.state, "unresolved");
});

test("resolveSeatAdminPanelModel resolves workspace and organization levels independently", () => {
  const resolved = resolveSeatAdminPanelModel({
    signedIn: true,
    sampleMode: false,
    viewerUserId: USER_ID,
    agent: { principalId: AGENT_ID, name: "Builder", ownerUserId: USER_ID, transport: "local", turnOnly: false },
    currentWorkspace: { id: WORKSPACE_ID, name: "Design" },
    knownOrganizations: [
      { id: ORG_1, name: "First Org" },
      { id: ORG_2, name: "Second Org" },
    ],
    statusState: {
      phase: "loaded",
      status: {
        enabled: true,
        registryVersion: 3,
        agents: [
          {
            principalId: AGENT_ID,
            name: "Builder",
            eligible: { workspace: [WORKSPACE_ID], organization: [ORG_1, ORG_2], scoped: [WORKSPACE_ID] },
            activeGrantIds: [WS_GRANT_ID, ORG_GRANT_ID],
          },
        ],
      },
    },
    grantsState: {
      phase: "loaded",
      grants: [
        {
          grantId: WS_GRANT_ID,
          principalId: AGENT_ID,
          level: "workspace",
          organizationId: null,
          scopeNames: ["role:workspace_admin"],
          workspaceIds: [WORKSPACE_ID],
          registryVersion: 3,
          expiresAt: "2026-12-10T00:00:00.000Z",
          state: "active",
          createdAt: "2026-11-10T00:00:00.000Z",
          endedAt: null,
          endReason: null,
        },
        {
          grantId: ORG_GRANT_ID,
          principalId: AGENT_ID,
          level: "organization",
          organizationId: ORG_2,
          scopeNames: ["role:organization_admin"],
          workspaceIds: [],
          registryVersion: 3,
          expiresAt: null,
          state: "active",
          createdAt: "2026-11-10T00:00:00.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    },
  });
  assert.equal(resolved.panel.state, "ready");
  assert.equal(resolved.panel.workspace?.access.state, "on");
  assert.equal(resolved.panel.workspace?.access.grantId, WS_GRANT_ID);
  assert.equal(resolved.panel.organization?.access.state, "on");
  assert.equal(resolved.panel.organization?.access.grantId, ORG_GRANT_ID);
  assert.equal(resolved.panel.organization?.scope.name, "Second Org");
  assert.equal(seatAdminRemovalReceipt("workspace", false, true), "Workspace admin removed. Organization admin remains on.");
});

test("saveSeatAdminReauthIntent stores only non-secret selection intent scoped to userId, including 1-day duration", () => {
  clearSeatAdminReauthIntent();
  saveSeatAdminReauthIntent(
    {
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      routeView: "agent",
      principalId: AGENT_ID,
      level: "organization",
      scopeId: ORG_2,
      days: 1,
    },
    null,
  );
  assert.equal(readSeatAdminReauthIntent(OTHER_USER_ID, null), null);
  const restored = readSeatAdminReauthIntent(USER_ID, null);
  assert.deepEqual(restored, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    routeView: "agent",
    principalId: AGENT_ID,
    level: "organization",
    scopeId: ORG_2,
    days: 1,
  });
  assert.equal("expiresAt" in restored, false);
  assert.equal("commandId" in restored, false);
  clearSeatAdminReauthIntent(USER_ID, null);
  assert.equal(readSeatAdminReauthIntent(USER_ID, null), null);
});

test("hasActiveGrantForTarget matches exact workspaceId or organizationId and unresolvedLevels prevents false Off", () => {
  const grants = [
    {
      grantId: ORG_GRANT_ID,
      principalId: AGENT_ID,
      level: "organization",
      organizationId: ORG_1,
      scopeNames: ["role:organization_admin"],
      workspaceIds: [],
      registryVersion: 3,
      expiresAt: null,
      state: "active",
      createdAt: "2026-11-10T00:00:00.000Z",
      endedAt: null,
      endReason: null,
    },
  ];
  assert.equal(
    hasActiveGrantForTarget(grants, { principalId: AGENT_ID, level: "organization", scopeId: ORG_1 }),
    true,
  );
  assert.equal(
    hasActiveGrantForTarget(grants, { principalId: AGENT_ID, level: "organization", scopeId: ORG_2 }),
    false,
  );

  const resolved = resolveSeatAdminPanelModel({
    signedIn: true,
    sampleMode: false,
    viewerUserId: USER_ID,
    agent: { principalId: AGENT_ID, name: "Builder", ownerUserId: USER_ID, transport: "local", turnOnly: false },
    currentWorkspace: { id: WORKSPACE_ID, name: "Design", orgId: ORG_2 },
    knownOrganizations: [
      { id: ORG_1, name: "First Org" },
      { id: ORG_2, name: "Second Org" },
    ],
    statusState: {
      phase: "loaded",
      status: {
        enabled: true,
        registryVersion: 3,
        agents: [
          {
            principalId: AGENT_ID,
            name: "Builder",
            eligible: { workspace: [WORKSPACE_ID], organization: [ORG_1, ORG_2], scoped: [WORKSPACE_ID] },
            activeGrantIds: [],
          },
        ],
      },
    },
    grantsState: { phase: "loaded", grants: [] },
    unresolvedLevels: new Set(["workspace"]),
  });
  assert.equal(resolved.panel.state, "ready");
  assert.equal(resolved.panel.workspace?.access.state, "unresolved");
  assert.equal(resolved.panel.organization?.access.state, "off");
});

test("nonActiveSeatAdminGrantMessage returns explicit notices for expired, downgraded, and ended replays", () => {
  assert.match(nonActiveSeatAdminGrantMessage("expired"), /already expired/i);
  assert.match(nonActiveSeatAdminGrantMessage("downgraded"), /already removed/i);
  assert.match(nonActiveSeatAdminGrantMessage("ended"), /already ended/i);
});
