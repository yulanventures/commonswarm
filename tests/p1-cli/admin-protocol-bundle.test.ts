// This boundary catches a stale/generated edge bundle even when source tests pass.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as bundle from '../../supabase/functions/_shared/protocol.js';
import { adminCoreFixture } from '../support/admin-fixture.js';

test('the generated edge bundle can issue a consented account grant and refuses a worker grant', () => {
  const f = adminCoreFixture();
  const command = { kind: 'grant_admin_delegation' as const, grant_id: f.grantId, consent_receipt_id: f.receipt, replaces_grant_id: null };
  const denied = bundle.decideAdminAuthority(command, f.state(), { ...f.ctx, actor: { kind: 'worker' } });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'credential_kind_forbidden');
  const accepted = bundle.decideAdminAuthority(command, f.state(), f.ctx);
  assert.equal(accepted.ok, true);
  const state = accepted.events.reduce(bundle.reduceAdminAuthority, f.state());
  assert.equal(state.grants[f.grantId]?.owner_user_id, f.owner);
  const issued = bundle.decideAdminAuthority({ kind: 'issue_admin_credential', grant_id: f.grantId, credential_lineage_id: randomUUID() }, state, {
    ...f.ctx, actor: { kind: 'credential_runtime', connection_id: f.manifest.connection_id, client_id: f.manifest.client_id, resource: bundle.ADMIN_RESOURCE },
  });
  assert.equal(issued.ok, true);
  assert.equal(issued.events[0]?.type, 'AdminCredentialIssued');
  assert.equal(Object.hasOwn(issued.events[0]!.payload, 'access_credential'), false);
});
