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
// A local test signing authority serves only the pinned JWKS URL. All API
// traffic still reaches the local stack; no production service is contacted.
const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = { ...await crypto.subtle.exportKey('jwk', signing.publicKey), kid: 'local-admin-runtime', alg: 'ES256', use: 'sig' };
const upstreamFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const url = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (url === 'https://mcp.commonswarm.com/jwks') return new Response(JSON.stringify({ keys: [publicJwk] }));
  return await upstreamFetch(...args);
};
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const encoded = value => base64url(new TextEncoder().encode(JSON.stringify(value)));
async function runtimeProof(grant, overrides = {}, key = signing.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const head = encoded({ alg: 'ES256', typ: 'at+jwt', kid: publicJwk.kid });
  const body = encoded({ iss: 'https://mcp.commonswarm.com', aud: 'https://api.commonswarm.com/admin',
    sub: config.owner, grant_id: grant.grantId, connection_id: grant.manifest.connection_id,
    client_id: grant.manifest.client_id, iat: now, exp: now + 300, ...overrides });
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`;
}
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
  const credential = await runtimeProof(grant);
  const result = await handleAdminRuntimeCommand(wire({ kind: 'issue_admin_credential', grant_id: grant.grantId, credential_lineage_id: id() }), credential, async value => { delivery = value; });
  check(result.status === 200 && delivery, 'private credential delivery');
  check(!JSON.stringify(result).includes(delivery.access_credential) && !JSON.stringify(result).includes(delivery.refresh_credential), 'no replayable credentials');
  return { credential, delivery };
}
const readWire = grant => wire({ kind: 'admin_read_metadata', grant_id: grant.grantId, resource_kind: 'grant', workspace_id: null });
async function count(owner = config.owner) {
  const [row] = await db`SELECT count(*)::integer AS n FROM swarm.admin_events WHERE owner_user_id = ${owner}::uuid`;
  return row.n;
}
try {
  const scenario = Deno.args[1];
  const grant = await activate();
  if (scenario === 'runtime') {
    const issueInput = wire({ kind: 'issue_admin_credential', grant_id: grant.grantId, credential_lineage_id: id() });
    let deliveries = 0;
    const deliver = async () => { deliveries++; };
    const forged = { connection_id: grant.manifest.connection_id, client_id: grant.manifest.client_id, resource: policy.ADMIN_RESOURCE };
    const before = await count();
    check((await handleAdminRuntimeCommand(issueInput, forged, deliver)).status === 401, 'caller identity is not runtime proof');
    const direct = await transact(issueInput, { kind: 'runtime', identity: forged });
    check(direct.result.status === 401, 'direct transaction cannot bypass runtime proof');
    const attacker = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const badProofs = [
      await runtimeProof(grant, {}, attacker.privateKey),
      await runtimeProof(grant, { aud: 'https://mcp.commonswarm.com/mcp' }),
      await runtimeProof(grant, { exp: Math.floor(Date.now() / 1000) - 1 }),
      await runtimeProof(grant, { sub: id() }),
      await runtimeProof(grant, { connection_id: id() }),
      await runtimeProof(grant, { client_id: 'different-client' }),
      await runtimeProof(grant, { grant_id: id() }),
    ];
    for (const proof of badProofs) check((await handleAdminRuntimeCommand(issueInput, proof, deliver)).status >= 400, 'unverified or foreign runtime refused');
    check(deliveries === 0 && await count() === before, 'runtime proof denials deliver nothing and cannot charge victim');
    // Positive control exercises the same command, adapter, database, and delivery.
    const runtime = await issue(grant);
    const rotate = wire({ kind: 'rotate_admin_credential', grant_id: grant.grantId, credential_lineage_id: runtime.delivery.credential_lineage_id, generation: 0, scope_names: ['admin:read'] });
    check((await handleAdminRuntimeCommand(rotate, forged, deliver, runtime.delivery.refresh_credential)).status === 401, 'refresh possession cannot replace runtime proof');
    check((await handleAdminRuntimeCommand(rotate, await runtimeProof(grant, { connection_id: id() }), deliver, runtime.delivery.refresh_credential)).status === 403, 'refresh bound to signed connection');
    check((await handleAdminRuntimeCommand(rotate, runtime.credential, deliver, runtime.delivery.refresh_credential)).status === 200 && deliveries === 1, 'authenticated rotation control');
  } else if (scenario === 'consent') {
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
    const foreignGrant = await activate();
    let isolatedHistory = false;
    const historyDrill = new Error('history rollback drill');
    await db.begin(async tx => {
      const stream = id(), foreignWorkspace = id(), foreignStream = id();
      await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${stream}::uuid,${config.workspace}::uuid,'workspace')`;
      await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${foreignWorkspace}::uuid,'Other history workspace',${config.owner}::uuid)`;
      await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${foreignStream}::uuid,${foreignWorkspace}::uuid,'workspace')`;
      const privateMarker = 'future-private-field-must-not-escape';
      const invitation = { invitation_id: id(), workspace_id: config.workspace,
        recipient_ref: config.owner, recipient_user_id: config.owner,
        recipient_connection_id: null, role: 'member', expires_at: Date.now() + 60000,
        delivery_state: 'awaiting_authorization', future_private_field: privateMarker };
      const credential = { credential_id: id(), principal_id: id(), worker_lineage_id: id(),
        future_private_field: privateMarker };
      const provision = { principal_id: credential.principal_id, credential_id: credential.credential_id,
        recipient_connection_id: grant.manifest.connection_id, worker_scope_names: ['post_signal'],
        worker_policy: { kind: 'timeboxed', future_private_field: privateMarker },
        parent_admin_grant_id: grant.grantId, dependent_on_admin_grant: true,
        credential_expires_at: Date.now() + 60000, delivery_state: 'awaiting_delivery', credential,
        unused_credential_metadata: privateMarker };
      const facts = [
        [config.workspace, stream, grant, 'AdminMemberInvited', invitation],
        [config.workspace, stream, grant, 'AdminSeatProvisioned', provision],
        [config.workspace, stream, foreignGrant, 'AdminMemberInvited', invitation],
        [foreignWorkspace, foreignStream, grant, 'AdminMemberInvited', invitation],
        [config.workspace, stream, grant, 'CommandRejected', { ordinary_body: privateMarker }],
      ];
      for (const [offset, [workspace, streamId, g, type, payload]] of facts.entries()) {
        await tx`INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,
          admin_identity_id,grant_id,grant_manifest_digest,payload)
          VALUES(${workspace}::uuid,${streamId}::uuid,${offset + 1},${id()}::uuid,${id()},${type},1,
          ${g.manifest.admin_identity_id}::uuid,${g.grantId}::uuid,${await adminDigest(g.manifest)},${tx.json(payload)})`;
      }
      await tx`SELECT set_config('role','swarm_command',true)`;
      // Deliberately poison the caller's search_path; the definer pins its own.
      await tx`SELECT set_config('search_path','pg_temp,public',true)`;
      const rows = await tx`SELECT seq,type,schema_version,actor_user,actor_agent_principal,
        admin_identity_id,grant_id,grant_manifest_digest,occurred_at_server,payload
        FROM swarm.admin_routine_workspace_history(${config.workspace}::uuid,${grant.grantId}::uuid,${stream}::uuid)`;
      check(rows.length === 2 && Number(rows[0].seq) === 1 && Number(rows[1].seq) === 2,
        'history scopes workspace grant stream and excludes ordinary events');
      const columns = ['seq','type','schema_version','actor_user','actor_agent_principal',
        'admin_identity_id','grant_id','grant_manifest_digest','occurred_at_server','payload'];
      check(rows.every(row => Object.keys(row).length === columns.length && columns.every(key => Object.hasOwn(row,key))),
        'history returns only replay envelope columns');
      check(!JSON.stringify(rows).includes(privateMarker) &&
        rows[0].payload.recipient_user_id === config.owner &&
        rows[1].payload.credential.credential_id === credential.credential_id &&
        rows[1].payload.worker_policy.kind === 'timeboxed' &&
        !Object.hasOwn(rows[1].payload,'unused_credential_metadata'),
        'history strips unused and future payload fields including nested credential fields');
      const wrongGrant = await tx`SELECT seq FROM swarm.admin_routine_workspace_history(${config.workspace}::uuid,${foreignGrant.grantId}::uuid,${stream}::uuid)`;
      check(wrongGrant.length === 1 && Number(wrongGrant[0].seq) === 3, 'other grant has its own isolated history');
      const wrongWorkspace = await tx`SELECT seq FROM swarm.admin_routine_workspace_history(${foreignWorkspace}::uuid,${grant.grantId}::uuid,${stream}::uuid)`;
      const wrongStream = await tx`SELECT seq FROM swarm.admin_routine_workspace_history(${config.workspace}::uuid,${grant.grantId}::uuid,${foreignStream}::uuid)`;
      const foreignControl = await tx`SELECT seq FROM swarm.admin_routine_workspace_history(${foreignWorkspace}::uuid,${grant.grantId}::uuid,${foreignStream}::uuid)`;
      check(wrongWorkspace.length === 0 && wrongStream.length === 0 && foreignControl.length === 1,
        'mismatched workspace or stream returns no history with populated positive control');
      isolatedHistory = true;
      throw historyDrill;
    }).catch(error => { if (error !== historyDrill) throw error; });
    check(isolatedHistory, 'history isolation drill completed');
    let rawReadDenied = false;
    try { await db.begin(async tx => {
      await tx`SELECT set_config('role','swarm_command',true)`;
      await tx`SELECT * FROM swarm.events LIMIT 0`;
    }); } catch (error) { rawReadDenied = error.code === '42501'; }
    check(rawReadDenied, 'routine history readable while raw event history remains denied');
    const [historyRights] = await db`SELECT
      has_function_privilege('anon','swarm.admin_routine_workspace_history(uuid,uuid,uuid)','EXECUTE') AS anonymous,
      has_function_privilege('authenticated','swarm.admin_routine_workspace_history(uuid,uuid,uuid)','EXECUTE') AS human,
      has_function_privilege('swarm_read','swarm.admin_routine_workspace_history(uuid,uuid,uuid)','EXECUTE') AS worker,
      has_function_privilege('swarm_command','swarm.admin_routine_workspace_history(uuid,uuid,uuid)','EXECUTE') AS command,
      to_regclass('swarm.admin_routine_workspace_events') AS broad_view`;
    check(!historyRights.anonymous && !historyRights.human && !historyRights.worker && historyRights.command && historyRights.broad_view === null, 'routine history remains command-only and read-only without a broad view');
    const [historyFunction] = await db`SELECT p.prosecdef,p.provolatile,p.proconfig,
      pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
      WHERE p.oid='swarm.admin_routine_workspace_history(uuid,uuid,uuid)'::regprocedure`;
    check(historyFunction.prosecdef && historyFunction.provolatile === 's' &&
      historyFunction.owner === 'swarm_admin' && historyFunction.proconfig.includes('search_path=pg_catalog'),
      'history function pins trusted owner read-only execution and search path');
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
      // Additive OAuth schema depends on these predecessor tables. Its reserves
      // refuse if artifacts exist; this isolated legacy drill has none.
      for (const version of ['20261003000003','20261003000002','20261003000001']) {
        await tx.unsafe(await Deno.readTextFile(`supabase/admin-delegation-reserve/${version}-rollback.sql`));
      }
      await tx.unsafe(await Deno.readTextFile('supabase/admin-delegation-reserve/20261001000005-rollback.sql'));
      const [historyAbsent] = await tx`SELECT to_regprocedure('swarm.admin_routine_workspace_history(uuid,uuid,uuid)') AS fn`;
      check(historyAbsent.fn === null, 'rollback removes routine history function');
      await tx.unsafe(await Deno.readTextFile('supabase/admin-delegation-reserve/20261001000004-rollback.sql')); await tx.unsafe(await Deno.readTextFile('supabase/admin-delegation-reserve/20261001000003-rollback.sql'));
      const [readAbsent] = await tx`SELECT to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)') AS fn`;
      check(readAbsent.fn === null, 'rollback removes human recovery function');
      await tx.unsafe(await Deno.readTextFile('supabase/admin-delegation-reserve/20261001000002-rollback.sql'));
      await tx.unsafe(rollback);
      const [absent] = await tx`SELECT to_regclass('swarm.admin_grants') AS relation`;
      check(absent.relation === null, 'rollback removes grants');
      await tx.unsafe(migration);
      await tx.unsafe(await Deno.readTextFile('supabase/migrations/20261001000002_admin_routine.sql'));
      await tx.unsafe(await Deno.readTextFile('supabase/migrations/20261001000003_admin_recovery_read.sql')); await tx.unsafe(await Deno.readTextFile('supabase/migrations/20261001000004_admin_worker_read_fence.sql'));
      await tx.unsafe(await Deno.readTextFile('supabase/migrations/20261001000005_admin_routine_workspace_history.sql'));
      const [historyRestored] = await tx`SELECT to_regprocedure('swarm.admin_routine_workspace_history(uuid,uuid,uuid)') AS fn`;
      check(historyRestored.fn !== null, 'migration restores routine history function');
      const [readRestored] = await tx`SELECT to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)') AS fn`;
      check(readRestored.fn !== null, 'migration restores human recovery function');
      const [restored] = await tx`SELECT to_regclass('swarm.admin_grants') AS relation`;
      check(restored.relation !== null, 'migration restores grants');
      for (const name of ['20261003000001_admin_oauth_bindings.sql','20261003000002_admin_oauth_policy.sql','20261003000003_admin_oauth_cutover.sql']) {
        await tx.unsafe(await Deno.readTextFile(`supabase/migrations/${name}`));
      }
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
      const refresh = await handleAdminRuntimeCommand(wire({ kind: 'rotate_admin_credential', grant_id: grant.grantId, credential_lineage_id: runtime.delivery.credential_lineage_id, generation: 0, scope_names: ['admin:read'] }), runtime.credential, async () => {}, runtime.delivery.refresh_credential);
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
      const beforeWrongResource = await count();
      const wrongResource = await http({ ...readWire(grant), resource: 'https://mcp.commonswarm.com/mcp' }, token);
      check(wrongResource.status === 400 && wrongResource.body.error === 'invalid_request' && !Object.hasOwn(wrongResource.body, 'grant'), 'wrong resource refused without metadata');
      const [resourceAudit] = await db`SELECT event FROM swarm.admin_events WHERE owner_user_id = ${config.owner}::uuid ORDER BY seq DESC LIMIT 1`;
      check(await count() === beforeWrongResource + 1 && resourceAudit.event.type === 'AdminActionRecorded' && resourceAudit.event.payload.outcome === 'refused' && resourceAudit.event.payload.reason_code === 'invalid_request' && resourceAudit.event.payload.related_event_ids.length === 0, 'wrong resource produces only refusal audit');
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
      const widened = await handleAdminRuntimeCommand(wire({ kind: 'rotate_admin_credential', grant_id: grant.grantId, credential_lineage_id: runtime.delivery.credential_lineage_id, generation: 0, scope_names: ['admin:read', 'seats:create'] }), runtime.credential, async () => {}, runtime.delivery.refresh_credential);
      check(widened.status === 403, 'refresh cannot widen');
      await db`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${config.workspace}::uuid AND user_id = ${config.owner}::uuid`;
      check((await http(wire({ ...read.command, workspace_id: config.workspace }), token)).status === 403, 'current membership checked');
      check((await http(readWire(grant), token)).status === 200, 'own grant status survives membership loss');
    } else if (scenario === 'lifecycle') {
      const rotate = wire({ kind: 'rotate_admin_credential', grant_id: grant.grantId, credential_lineage_id: runtime.delivery.credential_lineage_id, generation: 0, scope_names: ['admin:read'] });
      let successor;
      const rotated = await handleAdminRuntimeCommand(rotate, runtime.credential, async value => { successor = value; }, runtime.delivery.refresh_credential);
      check(rotated.status === 200 && successor.generation === 1 && successor.refresh_deadline === runtime.delivery.refresh_deadline, 'atomic rotation retains deadline');
      const beforeRetry = await count();
      let deliveredAgain = false;
      check((await handleAdminRuntimeCommand(rotate, runtime.credential, async () => { deliveredAgain = true; }, runtime.delivery.refresh_credential)).status === 200 && !deliveredAgain, 'rotation retry has no secret delivery');
      check(await count() === beforeRetry, 'rotation retry has no extra events');
      const responses = await Promise.all([
        handleAdminRuntimeCommand(wire({ ...rotate.command, generation: 1 }), runtime.credential, async () => {}, successor.refresh_credential),
        handleAdminRuntimeCommand(wire({ ...rotate.command, generation: 1 }), runtime.credential, async () => {}, successor.refresh_credential),
      ]);
      check(responses.filter(r => r.status === 200).length === 1 && responses.filter(r => r.status === 403).length === 1, 'concurrent refresh replay fences lineage');
      check((await http(read, token)).status === 403, 'revoked read retry refused');
      const [row] = await db`SELECT state FROM swarm.admin_grants WHERE grant_id = ${grant.grantId}::uuid`;
      check(row.state === 'revoked', 'replay tombstone persisted');
      const another = await activate();
      const uncertain = await handleAdminRuntimeCommand(wire({ kind: 'issue_admin_credential', grant_id: another.grantId, credential_lineage_id: id() }),
        await runtimeProof(another), async () => { throw new Error('delivery failed'); });
      check(uncertain.status === 503, 'delivery failure reported');
      const [ended] = await db`SELECT state FROM swarm.admin_grants WHERE grant_id = ${another.grantId}::uuid`;
      check(ended.state === 'revoked', 'uncertain delivery terminally revoked');
    } else if (scenario === 'limits') {
      const mutationKeys = [`mutation:grant:${grant.grantId}`, `mutation:connection:${grant.manifest.connection_id}`, `mutation:account:${config.owner}`];
      async function mutationAttempts() {
        return await db`SELECT bucket_key, attempts FROM swarm.admin_rate_buckets
          WHERE bucket_key = ANY(${mutationKeys}) AND hour_start = floor(extract(epoch FROM clock_timestamp()) / 3600)::bigint`;
      }
      const initial = await mutationAttempts();
      // Issuance is an authenticated mutation, so it already used one attempt.
      check(initial.length === mutationKeys.length && initial.every(row => row.attempts === 1), 'credential issuance consumes mutation allowance');
      const beforeRetry = await count();
      check((await http(read, token)).status === 200 && await count() === beforeRetry, 'read retry uncharged');
      check((await mutationAttempts()).every(row => row.attempts === 1), 'read retry preserves mutation allowance');
      const remaining = policy.ADMIN_MUTATION_RATE_PER_HOUR.lineage - initial[0].attempts;
      for (let i = 0; i < remaining; i++) {
        const refused = wire({ kind: 'unsupported_command' });
        const beforeRefusal = await count();
        const result = await http(refused, token);
        check(result.status === 403 && result.body.error === 'human_confirmation_required', 'unsupported mutation refused');
        const charged = await mutationAttempts();
        check(charged.length === mutationKeys.length && charged.every(row => row.attempts === i + 2) && await count() === beforeRefusal + 1, 'refused mutation durably charged once');
        check((await http(refused, token)).status === 403 && await count() === beforeRefusal + 1 && (await mutationAttempts()).every(row => row.attempts === i + 2), 'refused mutation retry uncharged');
      }
      const exhausted = await http(wire({ kind: 'unsupported_command' }), token);
      check(exhausted.status === 429 && exhausted.body.error === 'rate_limited', 'malformed mutation allowance exhausted');
      check((await mutationAttempts()).every(row => row.attempts === policy.ADMIN_MUTATION_RATE_PER_HOUR.lineage + 1), 'exhausted refusal still charged');
      check((await http(wire({ kind: 'surrender_admin_delegation', grant_id: grant.grantId, reason_code: 'surrendered' }), token)).status === 200, 'surrender survives exhausted allowance');
      check((await mutationAttempts()).every(row => row.attempts === policy.ADMIN_MUTATION_RATE_PER_HOUR.lineage + 1), 'surrender preserves exhausted allowance');
      const [audit] = await db`SELECT count(*)::integer AS n FROM swarm.admin_events WHERE owner_user_id = ${config.owner}::uuid AND event->>'type' = 'AdminActionRecorded' AND event->'payload'->>'outcome' = 'refused'`;
      check(audit.n === remaining + 1, 'every refusal has one durable human audit');
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
