// Real Deno edge adapters. Local credentials stay in memory or the protected
// task file; no credentials, SQL errors, or response bodies go to stdout.
const config = JSON.parse(await Deno.readTextFile(Deno.args[0]));
for (const target of [config.local.API_URL, config.local.DB_URL]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname)) throw new Error('local stack required');
}
Deno.env.set('SWARM_ENV', 'test');
Deno.env.set('SWARM_DATABASE_URL', config.local.DB_URL);
Deno.env.set('SUPABASE_URL', config.local.API_URL);
Deno.env.set('SUPABASE_ANON_KEY', config.local.ANON_KEY);
Deno.env.set('SWARM_COMMAND_ALLOWED_ORIGINS', 'https://commonswarm.com');
const { db, handleRequest, handleAdminRuntimeCommand } = await import('../../supabase/functions/command/index.ts');
const { adminTransaction, adminDigest, recordAdminFailure } = await import('../../supabase/functions/command/admin-delegation.ts');
const policy = await import('../../supabase/functions/_shared/protocol.js');
const { handleRequest: readRequest } = await import('../../supabase/functions/read/index.ts');
const id = () => crypto.randomUUID();
let stage = 'initialization';
function check(condition, label) { stage = label; if (!condition) throw new Error('assertion'); }
const wire = (command, command_id = id()) => ({ command_id, stream: { kind: 'account' }, resource: policy.ADMIN_RESOURCE, command });
async function http(input, token = config.jwt, origin = 'https://commonswarm.com') {
  const response = await handleRequest(new Request('http://127.0.0.1/functions/v1/command', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(input),
  }));
  return { status: response.status, body: await response.json() };
}
async function transact(input, auth) {
  return await db.begin(async tx => {
    await tx`SELECT set_config('role', 'swarm_command', true), set_config('search_path', 'swarm, pg_catalog', true)`;
    return await adminTransaction(tx, input, auth);
  });
}
function manifest(full = false) {
  const now = Date.now();
  return {
    connection_id: id(), client_id: 'lane-b-runtime', resource: policy.ADMIN_RESOURCE,
    mode: full ? 'full_account' : 'granular', registry_version: policy.ADMIN_REGISTRY_VERSION,
    scope_names: full ? [...policy.ADMIN_SCOPE_NAMES] : ['admin:read'],
    workspace_selector: full ? 'owned_and_selected' : 'selected', workspace_ids: [config.workspace],
    created_workspace_policy: { scope_names: [] },
    target_rules: { seat_ids: [], own_seats: false, grant_created_seats: false, recipient_user_ids: [], recipient_connection_ids: [], transports: [] },
    worker_scope_ceiling: [], role_ceiling: 'member',
    renewal_limits: { ...policy.ADMIN_RENEWAL_CEILINGS, grant_kinds: [], principal_ids: [] },
    issuance_limits: { ...policy.ADMIN_ISSUANCE_CEILINGS }, expires_at: now + 86400000, refresh_deadline: now + 86400000,
  };
}
async function activate(full = false) {
  const prepared = await http(wire({ kind: 'prepare_admin_consent', manifest: manifest(full), full_account_selected: full }));
  check(prepared.status === 200, 'human preparation');
  const grantId = id();
  const input = wire({ kind: 'grant_admin_delegation', grant_id: grantId, consent_receipt_id: prepared.body.consent_receipt_id, replaces_grant_id: null });
  const granted = await http(input);
  check(granted.status === 200, 'human activation');
  return { grantId, input, manifest: prepared.body.manifest, receipt: prepared.body.consent_receipt_id };
}
async function issue(grant) {
  let delivery;
  const identity = { connection_id: grant.manifest.connection_id, client_id: grant.manifest.client_id, resource: policy.ADMIN_RESOURCE };
  const result = await handleAdminRuntimeCommand(wire({ kind: 'issue_admin_credential', grant_id: grant.grantId, credential_lineage_id: id() }), identity, async value => { delivery = value; });
  check(result.status === 200 && delivery, 'private credential delivery');
  check(!JSON.stringify(result).includes(delivery.access_credential) && !JSON.stringify(result).includes(delivery.refresh_credential), 'no replayable credentials');
  return { identity, delivery };
}
const readWire = grant => wire({ kind: 'admin_read_metadata', grant_id: grant.grantId, resource_kind: 'grant', workspace_id: null });
async function count(owner = config.owner) {
  const [row] = await db`SELECT count(*)::integer AS n FROM swarm.admin_events WHERE owner_user_id = ${owner}::uuid`;
  return row.n;
}
try {
  const scenario = Deno.args[1];
  const grant = await activate();
  if (scenario === 'consent') {
    const defaults = manifest();
    delete defaults.mode; delete defaults.workspace_selector; delete defaults.scope_names;
    const defaulted = await http(wire({ kind: 'prepare_admin_consent', manifest: defaults, full_account_selected: false }));
    check(defaulted.status === 200 && defaulted.body.manifest.mode === 'granular' && defaulted.body.manifest.scope_names.join(',') === 'admin:read', 'granular read-only default');
    const m = manifest(true);
    check((await http(wire({ kind: 'prepare_admin_consent', manifest: m, full_account_selected: false }))).status === 403, 'full-account selection required');
    check((await http(wire({ kind: 'prepare_admin_consent', manifest: m, full_account_selected: true }), config.jwt, '')).status === 403, 'CSRF origin required');
    const full = await activate(true);
    check(full.manifest.scope_names.length === policy.ADMIN_SCOPE_NAMES.length, 'pinned full registry');
    check((await http(wire({ ...grant.input.command, grant_id: id() }))).status === 403, 'consent single use');
    const binding = await adminDigest({ wrong: 'session' });
    const prepared = await http(wire({ kind: 'prepare_admin_consent', manifest: manifest(), full_account_selected: false }));
    check(prepared.status === 200, 'session negative positive control');
    const result = await transact(wire({ kind: 'grant_admin_delegation', grant_id: id(), consent_receipt_id: prepared.body.consent_receipt_id, replaces_grant_id: null }),
      { kind: 'human', identity: { user_id: config.owner, session_binding: binding, interactive_at_seconds: Date.now() / 1000, csrf_verified: true } });
    check(result.result.status === 403, 'session substitution refused');
  } else if (scenario === 'storage') {
    const names = ['admin_accounts', 'admin_grants', 'admin_consents', 'admin_credentials', 'admin_events', 'admin_command_results', 'admin_rate_buckets', 'admin_security_audit'];
    const rows = await db`SELECT c.relname, c.relrowsecurity,
      has_table_privilege('authenticated', c.oid, 'SELECT') AS human_read,
      has_table_privilege('swarm_read', c.oid, 'SELECT') AS worker_read,
      pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'swarm' AND c.relname = ANY(${names})`;
    check(rows.length === names.length && rows.every(r => r.relrowsecurity && !r.human_read && !r.worker_read && r.owner === 'swarm_admin'), 'private RLS catalogs');
    let refused = false;
    try { await db`UPDATE swarm.admin_events SET command_id = 'tampered' WHERE owner_user_id = ${config.owner}::uuid`; } catch { refused = true; }
    check(refused, 'append-only events');
    const rollback = await Deno.readTextFile('supabase/admin-delegation-reserve/20261001000001-rollback.sql');
    const migration = await Deno.readTextFile('supabase/migrations/20261001000001_admin_delegation.sql');
    let control = false;
    await db.begin(async tx => {
      await tx.unsafe(rollback);
      const [absent] = await tx`SELECT to_regclass('swarm.admin_grants') AS relation`;
      check(absent.relation === null, 'rollback removes grants');
      await tx.unsafe(migration);
      const [restored] = await tx`SELECT to_regclass('swarm.admin_grants') AS relation`;
      check(restored.relation !== null, 'migration restores grants');
      control = true;
      throw new Error('rollback drill');
    }).catch(() => {});
    check(control, 'rollback round trip');
    await db`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${config.workspace}::uuid AND user_id = ${config.owner}::uuid`;
    check((await http(wire({ kind: 'revoke_admin_delegation', grant_id: grant.grantId, reason_code: 'human_revoked' }))).status === 200, 'human recovery without workspace membership');
  } else {
    const runtime = await issue(grant), token = runtime.delivery.access_credential;
    const read = readWire(grant);
    check((await http(read, token)).status === 200, 'admin read positive control');
    if (scenario === 'expiry') {
      const short = { ...grant.manifest, expires_at: Date.now() + 2000 };
      const consent = await http(wire({ kind: 'prepare_admin_consent', manifest: short, full_account_selected: false }));
      check(consent.status === 200, 'narrowing preparation');
      check((await http(wire({ kind: 'narrow_admin_delegation', grant_id: grant.grantId, manifest: consent.body.manifest, manifest_digest: consent.body.manifest_digest, consent_receipt_id: consent.body.consent_receipt_id }))).status === 200, 'human deadline narrowing');
      check((await http(readWire(grant), token)).status === 200, 'narrowed positive read');
      await new Promise(resolve => setTimeout(resolve, 2200));
      check((await http(readWire(grant), token)).status === 403, 'expiry enforced before lazy event');
      const refresh = await handleAdminRuntimeCommand(wire({ kind: 'rotate_admin_credential', grant_id: grant.grantId, credential_lineage_id: runtime.delivery.credential_lineage_id, generation: 0, scope_names: ['admin:read'] }), runtime.identity, async () => {}, runtime.delivery.refresh_credential);
      check(refresh.status === 403, 'expired refresh refused');
      check((await http(wire({ kind: 'revoke_admin_delegation', grant_id: grant.grantId, reason_code: 'human_revoked' }))).status === 200, 'human recovery after expiry');
    } else if (scenario === 'failure') {
      const input = readWire(grant), authentication = { kind: 'access', credential: token };
      const before = await count();
      let reached = false;
      await db.begin(async tx => {
        await tx`SELECT set_config('role', 'swarm_command', true), set_config('search_path', 'swarm, pg_catalog', true)`;
        const outcome = await adminTransaction(tx, input, authentication);
        check(outcome.result.status === 200, 'rollback positive command');
        reached = true;
        throw new Error('rollback');
      }).catch(() => {});
      check(reached && await count() === before, 'rollback retains no success event');
      await db.begin(async tx => {
        await tx`SELECT set_config('role', 'swarm_command', true), set_config('search_path', 'swarm, pg_catalog', true)`;
        await recordAdminFailure(tx, input, authentication);
      });
      check(await count() === before + 1, 'failure card committed separately');
      const [failure] = await db`SELECT event FROM swarm.admin_events WHERE owner_user_id = ${config.owner}::uuid ORDER BY seq DESC LIMIT 1`;
      check(failure.event.type === 'AdminActionRecorded' && failure.event.payload.outcome === 'failed' && failure.event.payload.related_event_ids.length === 0, 'failure contains no success reference');
      check((await http(input, token)).status === 500 && await count() === before + 1, 'failure retry is recorded outcome');
    } else if (scenario === 'boundary') {
      let gotrue = 0;
      const upstream = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        if (url.includes('/auth/v1/')) { gotrue++; throw new Error('admin reached human auth'); }
        return await upstream(...args);
      };
      check((await http(readWire(grant), token)).status === 200 && gotrue === 0, 'admin never uses GoTrue');
      globalThis.fetch = upstream;
      check((await http({ ...readWire(grant), resource: 'https://mcp.commonswarm.com/mcp' }, token)).status === 403, 'wrong resource refused');
      check((await http(wire({ ...read.command, workspace_id: id() }), token)).status === 403, 'foreign workspace refused');
      check((await http(wire({ ...read.command, grant_id: id() }), token)).status === 403, 'foreign grant refused');
      check((await http({ ...readWire(grant), command_id: '' }, token)).status === 400, 'invalid command ID audited');
      check((await http(wire({ kind: 'issue_admin_credential', grant_id: grant.grantId, credential_lineage_id: id() }), token)).status === 403, 'admin cannot issue its own credentials');
      const beforeUnknown = await count();
      check((await http(readWire(grant), 'swm_adm_' + 'a'.repeat(43))).status === 401, 'unknown credential refused');
      check(await count() === beforeUnknown, 'unknown credential never charges victim audit');
      check((await http(wire({ kind: 'admin_create_workspace', name: 'forbidden' }), token)).status === 403, 'operations deferred to lane C');
      check((await http(wire({ ...grant.input.command, grant_id: id() }), token)).status === 403, 'admin cannot grant');
      const ordinary = await readRequest(new Request('http://127.0.0.1/functions/v1/read?view=members&workspace_id=' + config.workspace, { headers: { Authorization: `Bearer ${token}` } }));
      check(ordinary.status === 403, 'worker read endpoint rejects admin');
      check((await http(readWire(grant), runtime.delivery.refresh_credential)).status === 403, 'refresh cannot be public bearer');
      check((await http(readWire(grant), 'swm_agt_' + 'a'.repeat(43))).status === 403, 'worker cannot use account endpoint');
      const widened = await handleAdminRuntimeCommand(wire({ kind: 'rotate_admin_credential', grant_id: grant.grantId, credential_lineage_id: runtime.delivery.credential_lineage_id, generation: 0, scope_names: ['admin:read', 'seats:create'] }), runtime.identity, async () => {}, runtime.delivery.refresh_credential);
      check(widened.status === 403, 'refresh cannot widen');
      await db`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${config.workspace}::uuid AND user_id = ${config.owner}::uuid`;
      check((await http(wire({ ...read.command, workspace_id: config.workspace }), token)).status === 403, 'current membership checked');
      check((await http(readWire(grant), token)).status === 200, 'own grant status survives membership loss');
    } else if (scenario === 'lifecycle') {
      const rotate = wire({ kind: 'rotate_admin_credential', grant_id: grant.grantId, credential_lineage_id: runtime.delivery.credential_lineage_id, generation: 0, scope_names: ['admin:read'] });
      let successor;
      const rotated = await handleAdminRuntimeCommand(rotate, runtime.identity, async value => { successor = value; }, runtime.delivery.refresh_credential);
      check(rotated.status === 200 && successor.generation === 1 && successor.refresh_deadline === runtime.delivery.refresh_deadline, 'atomic rotation retains deadline');
      const beforeRetry = await count();
      let deliveredAgain = false;
      check((await handleAdminRuntimeCommand(rotate, runtime.identity, async () => { deliveredAgain = true; }, runtime.delivery.refresh_credential)).status === 200 && !deliveredAgain, 'rotation retry has no secret delivery');
      check(await count() === beforeRetry, 'rotation retry has no extra events');
      const responses = await Promise.all([
        handleAdminRuntimeCommand(wire({ ...rotate.command, generation: 1 }), runtime.identity, async () => {}, successor.refresh_credential),
        handleAdminRuntimeCommand(wire({ ...rotate.command, generation: 1 }), runtime.identity, async () => {}, successor.refresh_credential),
      ]);
      check(responses.filter(r => r.status === 200).length === 1 && responses.filter(r => r.status === 403).length === 1, 'concurrent refresh replay fences lineage');
      check((await http(read, token)).status === 403, 'revoked read retry refused');
      const [row] = await db`SELECT state FROM swarm.admin_grants WHERE grant_id = ${grant.grantId}::uuid`;
      check(row.state === 'revoked', 'replay tombstone persisted');
      const another = await activate();
      const uncertain = await handleAdminRuntimeCommand(wire({ kind: 'issue_admin_credential', grant_id: another.grantId, credential_lineage_id: id() }),
        { connection_id: another.manifest.connection_id, client_id: another.manifest.client_id, resource: policy.ADMIN_RESOURCE }, async () => { throw new Error('delivery failed'); });
      check(uncertain.status === 503, 'delivery failure reported');
      const [ended] = await db`SELECT state FROM swarm.admin_grants WHERE grant_id = ${another.grantId}::uuid`;
      check(ended.state === 'revoked', 'uncertain delivery terminally revoked');
    } else if (scenario === 'limits') {
      const beforeRetry = await count();
      check((await http(read, token)).status === 200 && await count() === beforeRetry, 'read retry uncharged');
      for (let i = 0; i < policy.ADMIN_MUTATION_RATE_PER_HOUR.lineage; i++) {
        check((await http(wire({ kind: 'unsupported_command' }), token)).status === 403, 'refused mutation charged');
      }
      check((await http(wire({ kind: 'unsupported_command' }), token)).status === 429, 'malformed mutation allowance exhausted');
      check((await http(wire({ kind: 'surrender_admin_delegation', grant_id: grant.grantId, reason_code: 'surrendered' }), token)).status === 200, 'surrender survives exhausted allowance');
      const [audit] = await db`SELECT count(*)::integer AS n FROM swarm.admin_events WHERE owner_user_id = ${config.owner}::uuid AND event->>'type' = 'AdminActionRecorded' AND event->'payload'->>'outcome' = 'refused'`;
      check(audit.n >= policy.ADMIN_MUTATION_RATE_PER_HOUR.lineage, 'refusals have durable human audit');
    } else throw new Error('unknown scenario');
    const events = await db`SELECT event FROM swarm.admin_events WHERE owner_user_id = ${config.owner}::uuid`;
    const material = JSON.stringify(events);
    check(!material.includes(token) && !material.includes(runtime.delivery.refresh_credential), 'events exclude credential material');
  }
  console.log('ADMIN_SERVER_OK');
} catch {
  console.log('ADMIN_SERVER_FAILED:' + stage);
  Deno.exitCode = 1;
} finally { await db.end({ timeout: 2 }); }
