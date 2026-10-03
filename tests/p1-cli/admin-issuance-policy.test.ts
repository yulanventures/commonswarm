import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import * as core from '../../src/protocol/index.js';
import { adminCoreFixture, routineContext } from './admin-issuance-fixture.test.js';

function granted(mode: 'granular' | 'full_account', implementation = core) {
  const f = adminCoreFixture([], mode, implementation);
  if (mode === 'granular') {
    f.manifest.scope_names.push('workspaces:create');
    f.manifest.capability_names = implementation.adminAvailableCapabilities(f.manifest.scope_names);
  }
  assert.equal(f.prepare().ok, true);
  assert.equal(f.grant().ok, true);
  return f;
}
const create = (f: ReturnType<typeof granted>) => ({ kind: 'admin_create_workspace' as const,
  grant_id: f.grantId, workspace_id: randomUUID(), name: 'Policy control' });

// Compile a real future core entirely in memory, with real parser/reducer paths.
// No registry injection hook or other test-only production API is needed.
async function futureCore(sameVersion = false, removal = false, changedAuthority = false): Promise<typeof core> {
  const result = await build({ entryPoints: ['src/protocol/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:crypto'], plugins: [{
      name: 'future-registry-fixture', setup(builder) {
        builder.onLoad({ filter: /admin-policy\.ts$/ }, async ({ path }) => {
          let source = await readFile(path, 'utf8');
          const additions = `
  admin_clone_workspace: { scope: 'workspaces:create', label: 'Clone workspaces', available: true, authority_revision: 1 },
  admin_import_workspace: { scope: 'workspaces:import', label: 'Import workspaces', available: true, authority_revision: 1 },`;
          const current = removal || changedAuthority
            ? `Object.fromEntries(Object.entries(ADMIN_AVAILABILITY_V2).map(([name, d]) => [name,
                name === 'admin_create_workspace' ? { ...d, ${removal ? 'available: false' : 'authority_revision: 2'} } : d]))`
            : `{ ...ADMIN_AVAILABILITY_V2, ${additions} }`;
          if (sameVersion) {
            source = source.replace('const ADMIN_AVAILABILITY_V2 = {', 'const ADMIN_AVAILABILITY_V2 = {' + additions);
          } else {
            source = source.replace('ADMIN_REGISTRY_VERSION = 2', 'ADMIN_REGISTRY_VERSION = 3')
              .replace('[ADMIN_REGISTRY_VERSION]: Object.freeze', '2: Object.freeze')
              .replace('export const ADMIN_AVAILABILITY:', `const ADMIN_AVAILABILITY_V3 = ${current};\nexport const ADMIN_AVAILABILITY:`)
              .replace('Object.freeze({\n  2:', 'Object.freeze({\n  3: Object.freeze(ADMIN_AVAILABILITY_V3),\n  2:');
          }
          return { contents: source, loader: 'ts' };
        });
        builder.onLoad({ filter: /admin-routine\.ts$/ }, async ({ path }) => {
          let source = await readFile(path, 'utf8');
          if (!removal && !changedAuthority) source = source
            .replace('case "admin_create_workspace":', 'case "admin_clone_workspace":\n    case "admin_import_workspace":\n    case "admin_create_workspace":')
            .replaceAll('command.kind !== "admin_create_workspace"', '!["admin_create_workspace", "admin_clone_workspace", "admin_import_workspace"].includes(command.kind)')
            .replace('if (command.kind === "admin_create_workspace") {', 'if (["admin_create_workspace", "admin_clone_workspace", "admin_import_workspace"].includes(command.kind)) {');
          return { contents: source, loader: 'ts' };
        });
      },
    }] });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text).toString('base64'));
}

test('admin-capability-snapshot: old full account denies new scope and same-scope commands; fresh consent succeeds', async () => {
  const old = granted('full_account'), next = await futureCore();
  assert.equal(next.adminManifestValid(core.adminGrantManifest(old.state().grants[old.grantId]!), old.now, false), true);
  assert.equal(next.decideAdminRoutine(create(old), old.state(), routineContext(old)).ok, true);
  for (const kind of ['admin_clone_workspace', 'admin_import_workspace']) {
    const command = { ...create(old), kind };
    assert.ok(next.parseAdminRoutineCommand(command), 'negative must reach the implemented future parser');
    const denied = next.decideAdminRoutine(command as core.AdminRoutineCommand, old.state(), routineContext(old));
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, kind === 'admin_clone_workspace' ? 'capability_forbidden' : 'scope_forbidden');
    assert.deepEqual(denied.workspace_events, []);
    assert.deepEqual(denied.events.map(e => e.type), ['AdminActionRecorded']);
    const fresh = granted('full_account', next);
    assert.equal(next.adminManifestValid(old.manifest, old.now), false, 'fresh consent requires the current version');
    const accepted = next.decideAdminRoutine({ ...create(fresh), kind } as core.AdminRoutineCommand, fresh.state(), routineContext(fresh));
    assert.equal(accepted.ok, true, accepted.reason ?? undefined);
    assert.equal(accepted.workspace_events[0]?.type, 'WorkspaceCreated');
  }
  const accidental = await futureCore(true);
  for (const kind of ['admin_clone_workspace', 'admin_import_workspace']) {
    const command = { ...create(old), kind } as core.AdminRoutineCommand;
    assert.ok(accidental.parseAdminRoutineCommand(command));
    assert.equal(accidental.decideAdminRoutine(command, old.state(), routineContext(old)).reason, 'grant_inactive');
    assert.deepEqual(accidental.adminEffectiveCapabilities(old.manifest), []);
    const fresh = granted('full_account', accidental);
    assert.equal(accidental.decideAdminRoutine({ ...create(fresh), kind } as core.AdminRoutineCommand, fresh.state(), routineContext(fresh)).ok, true);
  }
});

test('admin-capability-snapshot: current removal and changed authority restrict immutable old consent', async () => {
  const old = granted('full_account');
  for (const [remove, changed] of [[true, false], [false, true]]) {
    const next = await futureCore(false, remove, changed), command = create(old);
    assert.equal(next.adminManifestValid(old.manifest, old.now, false), true);
    assert.ok(!next.adminEffectiveCapabilities(old.manifest).includes(command.kind));
    const denied = next.decideAdminRoutine(command, old.state(), routineContext(old));
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, remove ? 'invalid_request' : 'capability_forbidden');
    assert.deepEqual(denied.workspace_events, []);
    const read = next.decideAdminAuthority({ kind: 'admin_read_metadata', grant_id: old.grantId, resource_kind: 'grant', workspace_id: null }, old.state(), routineContext(old));
    assert.equal(read.ok, true, 'independent unchanged operation remains usable');
    if (changed) {
      const fresh = granted('full_account', next);
      assert.equal(next.decideAdminRoutine(create(fresh), fresh.state(), routineContext(fresh)).ok, true);
    }
  }
});

test('admin-unavailable-dispatch: consent, validation, parser and effective tool dispatch share availability', () => {
  for (const mode of ['granular', 'full_account'] as const) {
    const f = granted(mode), command = create(f);
    const available = core.adminConsentOptions().filter(o => o.available);
    assert.ok(available.some(o => o.scope === 'workspaces:create' && o.capability_names.includes(command.kind)));
    assert.equal(core.adminManifestValid(f.manifest, f.now), true);
    assert.ok(core.parseAdminRoutineCommand(command));
    assert.ok(core.adminEffectiveCapabilities(f.manifest).includes(command.kind));
    assert.equal(core.decideAdminRoutine(command, f.state(), routineContext(f)).ok, true);
    for (const option of core.adminConsentOptions().filter(o => !o.available)) {
      assert.deepEqual(option.capability_names, []);
      assert.equal(core.adminManifestValid({ ...f.manifest, scope_names: [...f.manifest.scope_names, option.scope] }, f.now), false);
    }
    for (const [kind, definition] of Object.entries(core.ADMIN_AVAILABILITY[2]!)) {
      if (definition.available) continue;
      const unavailable = { ...command, kind } as core.AdminRoutineCommand;
      assert.equal(core.adminManifestValid({ ...f.manifest, scope_names: [...new Set([...f.manifest.scope_names, definition.scope])],
        capability_names: [...f.manifest.capability_names, kind].sort() }, f.now), false, kind);
      assert.equal(core.parseAdminRoutineCommand(unavailable), null, kind);
      assert.ok(!core.adminEffectiveCapabilities(f.manifest).includes(kind));
      const denied = core.decideAdminRoutine(unavailable, f.state(), routineContext(f));
      assert.equal(denied.reason, 'invalid_request');
      assert.deepEqual(denied.workspace_events, []);
      assert.deepEqual(denied.events.map(e => e.type), ['AdminActionRecorded']);
    }
    for (const scope of ['admin:delegate', 'billing:manage', 'openid', 'profile', 'email', 'unknown:scope']) {
      assert.equal(core.adminManifestValid({ ...f.manifest, scope_names: [...f.manifest.scope_names, scope] }, f.now), false);
      assert.deepEqual(core.adminAvailableCapabilities([scope]), []);
    }
    for (const capability_names of [[], [...f.manifest.capability_names, 'unknown_command'].sort(),
      [...f.manifest.capability_names, f.manifest.capability_names[0]!].sort(), [...f.manifest.capability_names].reverse()]) {
      assert.equal(core.adminManifestValid({ ...f.manifest, capability_names }, f.now), false);
    }
    for (const registry_version of [1, 999]) {
      assert.equal(core.adminManifestValid({ ...f.manifest, registry_version }, f.now), false);
      assert.deepEqual(core.adminEffectiveCapabilities({ ...f.manifest, registry_version }), []);
      assert.deepEqual(core.adminConsentOptions(registry_version), []);
    }
    assert.equal(core.adminManifestValid({ ...f.manifest, resource: 'https://mcp.commonswarm.com/mcp' }, f.now), false);
  }
  assert.ok(core.adminConsentOptions().every(o => o.resource === core.ADMIN_RESOURCE));
  assert.equal(core.ADMIN_BILLING_CONSENT.label, 'Renew seats');
  assert.equal(core.ADMIN_BILLING_CONSENT.available, false);
  assert.deepEqual(core.ADMIN_BILLING_CONSENT.scope_names, []);
  assert.deepEqual(core.ADMIN_BILLING_CONSENT.capability_names, []);
  assert.equal(core.adminConsentOptions().find(o => o.scope === 'seats:renew')?.label, 'Renew seats');
});

test('admin-delegation-v1-denied: granular and full account refuse child issuance beside a routine positive', () => {
  for (const mode of ['granular', 'full_account'] as const) {
    const f = granted(mode), ctx = routineContext(f);
    const denied = core.decideAdminAuthority({ kind: 'grant_admin_delegation', grant_id: randomUUID(),
      consent_receipt_id: f.receipt, replaces_grant_id: null }, f.state(), ctx);
    assert.equal(denied.reason, 'human_confirmation_required');
    assert.deepEqual(denied.events.map(e => e.type), ['AdminActionRecorded']);
    assert.equal(denied.events[0]?.payload.outcome, 'refused');
    const prepare = core.decideAdminAuthority({ kind: 'prepare_admin_consent', consent: {
      ...f.state().consents[f.receipt]!, consent_receipt_id: randomUUID(), consumed_at: null } }, f.state(), ctx);
    assert.equal(prepare.reason, 'human_confirmation_required');
    for (const kind of ['issue_admin_credential', 'rotate_admin_credential'] as const) {
      const result = core.decideAdminAuthority({ kind, grant_id: f.grantId, credential_lineage_id: randomUUID(),
        generation: 0, scope_names: f.manifest.scope_names }, f.state(), ctx);
      assert.equal(result.reason, 'credential_runtime_required');
      assert.deepEqual(result.events.map(e => e.type), ['AdminActionRecorded']);
    }
    const allowed = core.decideAdminRoutine(create(f), f.state(), ctx);
    assert.equal(allowed.ok, true);
    assert.equal(allowed.workspace_events[0]?.type, 'WorkspaceCreated');
    assert.ok(!core.adminConsentOptions().some(o => String(o.scope) === 'admin:delegate'));
  }
});
