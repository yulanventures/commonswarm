import assert from "node:assert/strict";
import test from "node:test";
import {
  decideHostedAuthority,
  HOSTED_MCP_RESOURCE,
  HOSTED_MCP_SEAT_LIMIT,
  HOSTED_SEAT_NAME_TAKEN,
  reduceHostedAuthorityStream,
  type DecideHostedAuthorityCtx,
  type HostedAuthorityFacts,
  type HostedGrantFacts,
} from "../src/protocol/hosted-authority.js";
import { reduceWorkspace, SCHEMA_VERSION } from "../src/protocol/index.js";

const owner = "10000000-0000-4000-8000-000000000001";
const grantId = "20000000-0000-4000-8000-000000000001";
const workspace = "30000000-0000-4000-8000-000000000001";
const stream = "40000000-0000-4000-8000-000000000001";
const principal = "50000000-0000-4000-8000-000000000001";
const seatId = "60000000-0000-4000-8000-000000000001";

function context(kind: DecideHostedAuthorityCtx["credential_kind"]): DecideHostedAuthorityCtx {
  let seq = 0;
  return {
    now: 1234,
    actor: { user: owner, agent_principal: null, run: null },
    credential_kind: kind,
    command_id: "cmd-1",
    workspace_id: workspace,
    stream_id: stream,
    nextSeq: () => ++seq,
    nextEventId: () => `70000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  };
}

const activeGrant: HostedGrantFacts = {
  grant_id: grantId,
  provider_grant_id: "provider-1",
  owner_user_id: owner,
  home_workspace_id: workspace,
  client_id: "client",
  resource: HOSTED_MCP_RESOURCE,
  state: "active",
  manifest_digest: "ab".repeat(32),
  interaction_ref: "interaction",
  selected_workspace_ids: [workspace],
  consented_workspace_ids: [workspace],
};

function namePrincipal(principal_id = principal, revoked = false, owner_user_id = owner) {
  return { principal_id, owner_user_id, revoked };
}

function facts(overrides: Partial<HostedAuthorityFacts> = {}): HostedAuthorityFacts {
  return {
    grant: activeGrant,
    seat: null,
    owner_is_live_member: true,
    workspace_archived: false,
    workspace_consented: true,
    all_required_consents: true,
    all_required_memberships: true,
    exact_name_principals: [],
    live_seat_count: 0,
    ...overrides,
  };
}

const claim = {
  kind: "claim_hosted_seat" as const,
  grant_id: grantId,
  seat_id: seatId,
  handle: "seat_abcdefghijklmnopqrstuv",
  principal_id: principal,
  workspace_id: workspace,
  owner_user_id: owner,
  name: "Claude",
};

test("hosted credential kinds are fenced in both directions", () => {
  const hostedClaim = decideHostedAuthority(claim, facts(), context("hosted_grant"));
  assert.equal(hostedClaim.ok, true, "positive control: hosted grant can claim");
  const humanClaim = decideHostedAuthority(claim, facts(), context("human"));
  assert.equal(humanClaim.ok, false);
  if (!humanClaim.ok) assert.equal(humanClaim.reason, "credential_kind_forbidden");
  const grantManagement = decideHostedAuthority(
    { kind: "activate_hosted_mcp_grant", grant_id: grantId },
    facts(),
    context("hosted_grant"),
  );
  assert.equal(grantManagement.ok, false);
  if (!grantManagement.ok) assert.equal(grantManagement.reason, "credential_kind_forbidden");
  const humanManagement = decideHostedAuthority(
    { kind: "activate_hosted_mcp_grant", grant_id: grantId },
    facts(),
    context("human"),
  );
  assert.equal(humanManagement.ok, true, "positive control: owner human can manage");
});

test("partial consent cannot activate and complete consent can", () => {
  const pending = { ...activeGrant, state: "pending" as const };
  const incomplete = decideHostedAuthority(
    { kind: "activate_hosted_mcp_grant", grant_id: grantId },
    facts({ grant: pending, all_required_consents: false }),
    context("human"),
  );
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.reason, "hosted_consent_incomplete");
  const complete = decideHostedAuthority(
    { kind: "activate_hosted_mcp_grant", grant_id: grantId },
    facts({ grant: pending, all_required_consents: true }),
    context("human"),
  );
  assert.equal(complete.ok, true);
  if (complete.ok) assert.equal(complete.events[0]?.type, "HostedMcpGrantActivated");
});

test("claim emits hosted turn-only identity and folds deterministically", () => {
  const decision = decideHostedAuthority(claim, facts(), context("hosted_grant"));
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.deepEqual(decision.events[0]?.payload, {
    ...claim,
    transport: "hosted_mcp",
    turn_only: true,
    created_at: 1234,
  });
  const state = reduceHostedAuthorityStream(decision.events);
  assert.equal(state.seats[seatId]?.principal_id, principal);
  const workspaceState = reduceWorkspace(null, {
    workspace_id: workspace,
    stream_id: stream,
    seq: 0,
    event_id: "70000000-0000-4000-8000-000000000000",
    command_id: "workspace-create",
    type: "WorkspaceCreated",
    schema_version: SCHEMA_VERSION,
    actor_user: owner,
    actor_agent_principal: null,
    actor_run: null,
    occurred_at_server: 1,
    payload: {
      workspace_id: workspace,
      name: "Workspace",
      created_by: owner,
      created_at: 1,
    },
  });
  const foldedWorkspace = reduceWorkspace(workspaceState, decision.events[0]!);
  assert.equal(foldedWorkspace.principals[principal]?.transport, "hosted_mcp");
});

test("name continuation after a claim fold retains lifetime and defaults legacy events to durable", () => {
  for (const identity_lifetime of ['ephemeral', 'durable', undefined] as const) {
    const created = decideHostedAuthority({ ...claim, ...(identity_lifetime ? { identity_lifetime } : {}) },
      facts(), context('hosted_grant'));
    assert.equal(created.ok, true);
    if (!created.ok) continue;
    const folded = reduceHostedAuthorityStream(created.events);
    assert.equal(folded.principals[principal]?.identity_lifetime, identity_lifetime ?? 'durable');
    const continued = decideHostedAuthority({ ...claim, intent: 'continue' },
      facts({ seat: folded.seats[seatId]!, exact_name_principals: [namePrincipal()] }), context('hosted_grant'));
    assert.equal(continued.ok, identity_lifetime !== 'ephemeral');
    if (!continued.ok) assert.equal(continued.reason, 'identity_resume_unavailable');
  }
});

test("stable reuse never adopts a collision or resurrects a revoked seat", () => {
  const liveSeat = {
    seat_id: seatId, grant_id: grantId, workspace_id: workspace,
    owner_user_id: owner, principal_id: principal, name: "Claude",
    handle: claim.handle, transport: "hosted_mcp" as const,
    turn_only: true as const, created_at: 100,
    revoked_at: null, handle_revoked_at: null, principal_revoked_at: null,
  };
  const reuse = decideHostedAuthority(
    { ...claim, intent: "continue" },
    facts({ seat: liveSeat, exact_name_principals: [namePrincipal()] }),
    context("hosted_grant"),
  );
  assert.equal(reuse.ok, true);
  if (reuse.ok) {
    assert.equal(reuse.reuse, liveSeat);
    assert.deepEqual(reuse.events, []);
  }
  const fresh = decideHostedAuthority(claim,
    facts({ seat: liveSeat, exact_name_principals: [namePrincipal()] }), context("hosted_grant"));
  assert.equal(fresh.ok, false, "default-new never silently reuses an existing seat");
  for (const changed of [{ grant_id: "different-grant" }, { owner_user_id: "different-owner" },
    { workspace_id: "different-workspace" }, { name: "different-exact-name" }, { identity_lifetime: "ephemeral" as const }]) {
    const refused = decideHostedAuthority({ ...claim, intent: "continue" },
      facts({ seat: { ...liveSeat, ...changed }, exact_name_principals: [namePrincipal()] }), context("hosted_grant"));
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, "identity_resume_unavailable");
  }
  const historical = decideHostedAuthority({ ...claim, intent: "continue" }, facts({ seat: liveSeat,
    exact_name_principals: [namePrincipal(), namePrincipal("old", true, "foreign")],
    live_seat_count: HOSTED_MCP_SEAT_LIMIT,
  }), context("hosted_grant"));
  assert.equal(historical.ok, true, "live reuse precedes historical reservations and the cap");
  if (historical.ok) assert.equal(historical.reuse, liveSeat);
  const collision = decideHostedAuthority(
    { ...claim, intent: "continue" },
    facts({ seat: liveSeat, exact_name_principals: [namePrincipal(), namePrincipal("other")] }),
    context("hosted_grant"),
  );
  assert.equal(collision.ok, false);
  if (!collision.ok) {
    assert.equal(collision.reason, HOSTED_SEAT_NAME_TAKEN.code);
    assert.equal(collision.detail, HOSTED_SEAT_NAME_TAKEN.message);
  }
  for (const changed of [
    { revoked_at: 1000 }, { handle_revoked_at: 1000 }, { principal_revoked_at: 1000 },
  ]) {
    const revoked = decideHostedAuthority(
      { ...claim, intent: "continue" },
      facts({ seat: { ...liveSeat, ...changed }, exact_name_principals: [namePrincipal()] }),
      context("hosted_grant"),
    );
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.equal(revoked.reason, "hosted_seat_revoked");
  }
});

test("seat cap is grant-wide and the resource is fixed", () => {
  const belowCap = decideHostedAuthority(
    claim,
    facts({ live_seat_count: HOSTED_MCP_SEAT_LIMIT - 1 }),
    context("hosted_grant"),
  );
  assert.equal(belowCap.ok, true, "positive control: a seat below the cap is accepted");
  const capped = decideHostedAuthority(
    claim,
    facts({ live_seat_count: HOSTED_MCP_SEAT_LIMIT }),
    context("hosted_grant"),
  );
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.equal(capped.reason, "hosted_seat_limit_reached");
  const begun = decideHostedAuthority({
    kind: "begin_hosted_mcp_grant", grant_id: grantId,
    provider_grant_id: "provider-1", owner_user_id: owner,
    home_workspace_id: workspace, client_id: "client",
    resource: HOSTED_MCP_RESOURCE, selected_workspace_ids: [workspace],
    manifest_digest: "ab".repeat(32), interaction_ref: "interaction",
  }, facts({ grant: null }), context("human"));
  assert.equal(begun.ok, true);
});

test("only the owner begins, consents, and activates a grant", () => {
  const other = context("human");
  other.actor = { user: "10000000-0000-4000-8000-000000000099", agent_principal: null, run: null };
  const pending = { ...activeGrant, state: "pending" as const };
  const activate = decideHostedAuthority(
    { kind: "activate_hosted_mcp_grant", grant_id: grantId },
    facts({ grant: pending }),
    other,
  );
  assert.equal(activate.ok, false);
  if (!activate.ok) assert.equal(activate.reason, "hosted_grant_not_owned");
  const consent = decideHostedAuthority({
    kind: "consent_hosted_mcp_workspace", grant_id: grantId,
    workspace_id: workspace, owner_user_id: owner,
    manifest_digest: pending.manifest_digest,
    consent_receipt_id: "80000000-0000-4000-8000-000000000001",
  }, facts({ grant: pending, workspace_consented: false }), other);
  assert.equal(consent.ok, false);
  const begin = decideHostedAuthority({
    kind: "begin_hosted_mcp_grant", grant_id: grantId,
    provider_grant_id: "provider-1", owner_user_id: owner,
    home_workspace_id: workspace, client_id: "client",
    resource: HOSTED_MCP_RESOURCE, selected_workspace_ids: [workspace],
    manifest_digest: "ab".repeat(32), interaction_ref: "interaction",
  }, facts({ grant: null }), other);
  assert.equal(begin.ok, false);
});

test("owner self-revocation survives membership loss and archive", () => {
  for (const changed of [
    facts({ owner_is_live_member: false }),
    facts({ workspace_archived: true }),
  ]) {
    const revoked = decideHostedAuthority(
      { kind: "revoke_hosted_mcp_grant", grant_id: grantId },
      changed,
      context("human"),
    );
    assert.equal(revoked.ok, true);
  }
});

test("seat names use one exact space, length, and control-character contract", () => {
  const accepted = decideHostedAuthority(
    { ...claim, name: " Claude\u00a0" },
    facts(),
    context("hosted_grant"),
  );
  assert.equal(accepted.ok, false, "ASCII leading space is refused");
  const nbsp = decideHostedAuthority(
    { ...claim, name: "Claude\u00a0" },
    facts(),
    context("hosted_grant"),
  );
  assert.equal(nbsp.ok, true, "non-breaking space is not PostgreSQL btrim space");
  const control = decideHostedAuthority(
    { ...claim, name: "Claude\u0007" },
    facts(),
    context("hosted_grant"),
  );
  assert.equal(control.ok, false);
});


test("same-owner revoked hosted and local names reclaim fresh identities across grants", () => {
  // Name facts intentionally have no transport filter: local and hosted history
  // have the same immutable owner boundary.
  for (const previous of ["revoked-hosted", "revoked-local"]) {
    for (const nextGrant of [grantId, "fresh-grant"]) {
      const replacement = { ...claim, grant_id: nextGrant };
      const decision = decideHostedAuthority(replacement, facts({
        grant: { ...activeGrant, grant_id: nextGrant },
        exact_name_principals: [namePrincipal(previous, true)],
      }), context("hosted_grant"));
      assert.equal(decision.ok, true, `${previous}/${nextGrant}`);
      if (!decision.ok) continue;
      assert.equal(decision.reuse, undefined);
      assert.deepEqual(decision.reclaimed_principal_ids, [previous]);
      assert.deepEqual(decision.events[0]?.payload, {
        ...replacement, transport: "hosted_mcp", turn_only: true, created_at: 1234,
      });
      assert.notEqual(decision.events[0]?.payload.principal_id, previous);
      assert.equal(reduceHostedAuthorityStream(decision.events).principals[principal]?.revoked_at, null);
    }
  }
});

test("live names and foreign-owner revoked names remain reserved", () => {
  const sameOwnerHistory = namePrincipal("old", true);
  const accepted = decideHostedAuthority(claim, facts({
    exact_name_principals: [sameOwnerHistory],
  }), context("hosted_grant"));
  assert.equal(accepted.ok, true, "positive control: same owner can reclaim");
  for (const collision of [namePrincipal("live"), namePrincipal("foreign-live", false, "other"),
    namePrincipal("foreign-revoked", true, "other")]) {
    const refused = decideHostedAuthority(claim, facts({
      exact_name_principals: [sameOwnerHistory, collision],
    }), context("hosted_grant"));
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.reason, HOSTED_SEAT_NAME_TAKEN.code);
      assert.equal(refused.detail, HOSTED_SEAT_NAME_TAKEN.message);
      assert.deepEqual(refused.events, []);
    }
  }
});

test("reclaim still requires capacity, active grant, consent, membership and an open workspace", () => {
  const reclaimFacts = facts({ exact_name_principals: [namePrincipal("old", true)],
    live_seat_count: HOSTED_MCP_SEAT_LIMIT - 1 });
  assert.equal(decideHostedAuthority(claim, reclaimFacts, context("hosted_grant")).ok, true);
  for (const [changed, reason] of [
    [{ live_seat_count: HOSTED_MCP_SEAT_LIMIT }, "hosted_seat_limit_reached"],
    [{ grant: { ...activeGrant, state: "revoked" as const } }, "hosted_grant_unavailable"],
    [{ grant: { ...activeGrant, state: "pending" as const } }, "hosted_grant_unavailable"],
    [{ workspace_consented: false }, "hosted_grant_unavailable"],
    [{ owner_is_live_member: false }, "hosted_grant_unavailable"],
    [{ workspace_archived: true }, "hosted_grant_unavailable"],
  ] as const) {
    const refused = decideHostedAuthority(claim, { ...reclaimFacts, ...changed }, context("hosted_grant"));
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, reason);
  }
});
