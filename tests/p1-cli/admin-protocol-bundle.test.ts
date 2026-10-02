// This boundary catches a stale/generated edge bundle even when source tests pass.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import * as bundle from "../../supabase/functions/_shared/protocol.js";
import { adminCoreFixture } from "../support/admin-fixture.js";

test("the generated edge bundle can issue a consented account grant and refuses a worker grant", () => {
  const f = adminCoreFixture();
  const command = {
    kind: "grant_admin_delegation" as const,
    grant_id: f.grantId,
    consent_receipt_id: f.receipt,
    replaces_grant_id: null,
  };
  const denied = bundle.decideAdminAuthority(command, f.state(), {
    ...f.ctx,
    actor: { kind: "worker" },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "credential_kind_forbidden");
  const accepted = bundle.decideAdminAuthority(command, f.state(), f.ctx);
  assert.equal(accepted.ok, true);
  const state = accepted.events.reduce(bundle.reduceAdminAuthority, f.state());
  assert.equal(state.grants[f.grantId]?.owner_user_id, f.owner);
  const issued = bundle.decideAdminAuthority(
    {
      kind: "issue_admin_credential",
      grant_id: f.grantId,
      credential_lineage_id: randomUUID(),
    },
    state,
    {
      ...f.ctx,
      actor: {
        kind: "credential_runtime",
        connection_id: f.manifest.connection_id,
        client_id: f.manifest.client_id,
        resource: bundle.ADMIN_RESOURCE,
      },
    },
  );
  assert.equal(issued.ok, true);
  assert.equal(issued.events[0]?.type, "AdminCredentialIssued");
  assert.equal(
    Object.hasOwn(issued.events[0]!.payload, "access_credential"),
    false,
  );
});

test("the generated bundle enforces separate routine creation permission and folds both streams", () => {
  const f = adminCoreFixture();
  f.manifest.scope_names = ["admin:read", "workspaces:create"];
  const granted = bundle.decideAdminAuthority(
    {
      kind: "grant_admin_delegation",
      grant_id: f.grantId,
      consent_receipt_id: f.receipt,
      replaces_grant_id: null,
    },
    f.state(),
    f.ctx,
  );
  assert.equal(granted.ok, true);
  const state = granted.events.reduce(bundle.reduceAdminAuthority, f.state());
  const command = {
    kind: "admin_create_workspace" as const,
    grant_id: f.grantId,
    workspace_id: randomUUID(),
    name: "Bundle workspace",
  };
  const actor = {
    kind: "delegated_admin" as const,
    grant_id: f.grantId,
    admin_identity_id: f.manifest.admin_identity_id,
    connection_id: f.manifest.connection_id,
    scope_names: f.manifest.scope_names,
    resource: bundle.ADMIN_RESOURCE,
    access_expires_at: f.now + 300000,
  };
  const context = {
    ...f.ctx,
    actor,
    workspace: null,
    workspace_stream_id: randomUUID(),
    workspace_seq: 0,
    owned_workspaces: 0,
    workspace_creations_last_day: 0,
    invitations_last_day: 0,
    live_principals: 0,
    live_members_and_invitations: 0,
    live_agent_invitations_person: 0,
    live_agent_invitations_workspace: 0,
    human_worker_scopes: [],
    recipient_exists: false,
    recipient_is_member: false,
    delivery_connection_id: null,
    target_credential: null,
    principal_lineage_ids: [],
    nextResourceId: randomUUID,
  };
  const denied = bundle.decideAdminRoutine(command, state, {
    ...context,
    actor: { ...actor, scope_names: ["admin:read"] },
  });
  assert.equal(denied.reason, "scope_forbidden");
  const accepted = bundle.decideAdminRoutine(command, state, context);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.workspace_events.map((e) => e.type), [
    "WorkspaceCreated",
    "AdminWorkspaceCreated",
  ]);
  const account = accepted.events.reduce(bundle.reduceAdminAuthority, state);
  assert.equal(account.routine!.spend[f.grantId]!.workspaces, 1);
  const workspace = accepted.workspace_events.reduce(
    bundle.reduceWorkspace,
    null,
  );
  assert.equal(workspace!.workspace.created_by, f.owner);
  assert.deepEqual(
    workspace!.admin_routine!.created_workspaces[command.workspace_id]!
      .scope_names,
    [],
  );
});
