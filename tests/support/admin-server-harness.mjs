import { oauthFixture } from './admin-edge-oauth-fixture.mjs';
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
  if (url === 'https://mcp.commonswarm.com/jwks') return new Response(JSON.stringify({ keys: [publicJwk, {...publicJwk,kid:"independent-key"}] }));
  return await upstreamFetch(...args);
};
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const encoded = value => base64url(new TextEncoder().encode(JSON.stringify(value)));
const { db, handleRequest, handleAdminMcpRequest } = await import('../../supabase/functions/command/index.ts');
const { adminTransaction, adminDigest, recordAdminFailure } = await import('../../supabase/functions/command/admin-delegation.ts');
const policy = await import('../../supabase/functions/_shared/protocol.js');
const { handleRequest: readRequest } = await import('../../supabase/functions/read/index.ts');
const id = () => crypto.randomUUID();
let stage = 'initialization';
function check(condition, label) { stage = label; if (!condition) throw new Error('assertion'); }
const wire = (command, command_id = id()) => ({ command_id, stream: { kind: 'account' }, resource: policy.ADMIN_RESOURCE, command });
const oauthTokens = new Map();
async function http(input, token = config.jwt, origin = 'https://commonswarm.com') {
  const response = await handleRequest(oauthTokens.has(token) ? await oauthTokens.get(token).request(input) : new Request('http://127.0.0.1/functions/v1/command', {
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
  const scope_names = full ? policy.adminConsentOptions().filter(option => option.available).map(option => option.scope) : ['admin:read'];
  return {
    connection_id: id(), client_id: `https://client.example/${id()}`, resource: policy.ADMIN_RESOURCE,
    mode: full ? 'full_account' : 'granular', registry_version: policy.ADMIN_REGISTRY_VERSION,
    scope_names, capability_names: policy.adminAvailableCapabilities(scope_names),
    availability_digest: policy.adminAvailabilityDigest(policy.ADMIN_REGISTRY_VERSION),
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
async function issue(grant, kid = publicJwk.kid) {
  const oauth = await oauthFixture(db, grant.grantId, signing, kid);
  oauthTokens.set(oauth.access, oauth);
  return oauth;
}
async function mcp(oauth, method, params) {
  const response = await handleAdminMcpRequest(await oauth.request({jsonrpc:'2.0',id:1,method,params},'admin_mcp'));
  return {status:response.status, body:await response.json()};
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
    const issueInput = wire({ kind:'issue_admin_credential',grant_id:grant.grantId,credential_lineage_id:id() });
    const before = await count();
    for (const kind of ['runtime','access','system']) {
      check((await transact(issueInput, {kind,credential:'retired',identity:{owner_user_id:config.owner},owner_user_id:config.owner})).result.status === 401,'retired direct authentication refused');
    }
    const fake = await transact(readWire(grant), {kind:'oauth',admission:{token:{owner_user_id:config.owner,admin_grant_id:grant.grantId},digest:new Uint8Array(32)}});
    check(fake.result.status === 401 && await count() === before,'forged identity cannot bind victim audit');
    for (const old of ['swm_adm_'+ 'a'.repeat(43),'swm_adr_'+ 'b'.repeat(43)]) check((await http(readWire(grant),old)).status === 401,'legacy public credentials refused');
    const commandModule = await import('../../supabase/functions/command/index.ts');
    check(!('handleAdminRuntimeCommand' in commandModule) && !('handleAdminWorkerRuntimeCommand' in commandModule),'retired callbacks absent');
    const oauth = await issue(grant);
    const untrusted=(await import('../../supabase/functions/_shared/admin-oauth-db.ts')).createAdminRequestVerifier(db);
    const forgedFromImport=await untrusted.verify(await oauth.request(readWire(grant)),'admin_command');
    check((await transact(readWire(grant),{kind:'oauth',admission:forgedFromImport})).result.status===401,'caller-instantiated verifier cannot confer authority through imports');
    check((await http(issueInput,oauth.access)).status === 403,'OAuth token cannot mint opaque admin access');
    check((await http(readWire(grant),oauth.access)).status === 200,'actual OAuth admin positive control');
  } else if (scenario === 'consent') {
    const defaults = manifest();
    delete defaults.mode; delete defaults.workspace_selector; delete defaults.scope_names;
    const defaulted = await http(wire({ kind: 'prepare_admin_consent', manifest: defaults, full_account_selected: false }));
    check(defaulted.status === 200 && defaulted.body.manifest.mode === 'granular' && defaulted.body.manifest.scope_names.join(',') === 'admin:read', 'granular read-only default');
    const m = manifest(true);
    const legacy = { ...m, registry_version: 1, scope_names: [...policy.ADMIN_SCOPE_NAMES] };
    delete legacy.capability_names; delete legacy.availability_digest;
    const legacyResult = await http(wire({ kind: 'prepare_admin_consent', manifest: legacy, full_account_selected: true }));
    check(legacyResult.status === 400 && legacyResult.body.error === 'invalid_request', 'v1 consent refused without conversion');
    const unavailable = { ...m, scope_names: [...policy.ADMIN_SCOPE_NAMES] };
    const unavailableResult = await http(wire({ kind: 'prepare_admin_consent', manifest: unavailable, full_account_selected: true }));
    check(unavailableResult.status === 400 && unavailableResult.body.error === 'invalid_request', 'full-account unavailable scopes refused');
    check((await http(wire({ kind: 'prepare_admin_consent', manifest: m, full_account_selected: false }))).status === 403, 'full-account selection required');
    check((await http(wire({ kind: 'prepare_admin_consent', manifest: m, full_account_selected: true }), config.jwt, '')).status === 403, 'CSRF origin required');
    const full = await activate(true);
    const availableScopes = policy.adminConsentOptions().filter(option => option.available).map(option => option.scope);
    check(full.manifest.scope_names.length === availableScopes.length && availableScopes.every(scope => full.manifest.scope_names.includes(scope)) &&
      JSON.stringify(full.manifest.capability_names) === JSON.stringify(policy.adminAvailableCapabilities(availableScopes)) &&
      full.manifest.availability_digest === policy.adminAvailabilityDigest(policy.ADMIN_REGISTRY_VERSION), 'pinned full available registry and exact capabilities');
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
    const rollbackDrill = new Error('rollback drill');
    stage = 'rollback round trip';
    await db.begin(async tx => {
      // Exercise the inverse against empty copies of the real DDL. The original
      // versioned grants/history remain intact and the transaction restores names.
      await tx.unsafe(config.rollbackSchema);
      // Additive OAuth schema depends on these predecessor tables. Its reserves
      // refuse if artifacts exist; this isolated legacy drill has none.
      for (const version of ['20261003000004','20261003000003','20261003000002','20261003000001']) {
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
      for (const name of ['20261003000001_admin_oauth_bindings.sql','20261003000002_admin_oauth_policy.sql','20261003000003_admin_oauth_cutover.sql','20261003000004_migration_checksums.sql']) {
        await tx.unsafe(await Deno.readTextFile(`supabase/migrations/${name}`));
      }
      control = true;
      throw rollbackDrill;
    }).catch(error => { if (error !== rollbackDrill) throw error; });
    check(control, 'rollback round trip');
    await db`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${config.workspace}::uuid AND user_id = ${config.owner}::uuid`;
    check((await http(wire({ kind: 'revoke_admin_delegation', grant_id: grant.grantId, reason_code: 'human_revoked' }))).status === 200, 'human recovery without workspace membership');
  } else {
    const oauth = await issue(grant), token = oauth.access, read = readWire(grant);
    check((await http(read,token)).status === 200,'admin read positive control');
    if (scenario === 'boundary') {
      let gotrue = 0; const original = globalThis.fetch;
      globalThis.fetch = async (...args) => { if (String(args[0]).includes('/auth/v1/')) { gotrue++; throw new Error(); } return original(...args); };
      check((await http(readWire(grant),token)).status === 200 && gotrue === 0,'delegated actor never becomes a human');
      globalThis.fetch = original;
      check((await http({...readWire(grant),resource:'https://mcp.commonswarm.com/mcp'},token)).status === 400,'foreign resource refuses');
      check((await http(wire({...read.command,grant_id:id()}),token)).status === 403,'foreign grant refuses');
      check((await http(wire({...read.command,workspace_id:id()}),token)).status === 403,'foreign workspace refuses');
      for (const scheme of ['Bearer','DPoP']) {
        const req = await oauth.request(readWire(grant)); req.headers.set('authorization',`${scheme} ${token}`);
        if (scheme==='Bearer') check((await handleRequest(req)).status===401,'Bearer admin refused');
        const ordinary = await readRequest(new Request('http://127.0.0.1/functions/v1/read?view=members&workspace_id='+config.workspace,{headers:{Authorization:`${scheme} ${token}`}}));
        check(ordinary.status===403,'ordinary read refuses admin under both schemes');
      }
      check((await http(readWire(grant),'swm_agt_'+ 'a'.repeat(43))).status===403,'worker cannot use human account branch');
    } else if (scenario === 'lifecycle') {
      const independentGrant = await activate(), independent = await issue(independentGrant);
      check((await mcp(oauth,'initialize')).status===200 && (await mcp(oauth,'tools/list')).status===200,'init and listing active control');
      const queued = await oauth.admission();
      check((await http(wire({kind:'revoke_admin_delegation',grant_id:grant.grantId,reason_code:'human_revoked'}))).status===200,'human revoke commits');
      const [family] = await db`SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id=${oauth.provider}) AS fenced`;
      check(family.fenced,'human revoke atomically tombstones OAuth family');
      for (const method of ['initialize','tools/list']) check((await mcp(oauth,method)).status===403,'revoked metadata surfaces refuse');
      check((await http(read,token)).status===403,'cached same command result rechecks revoke');
      check((await http(wire({kind:'surrender_admin_delegation',grant_id:grant.grantId,reason_code:'test_revoke'}),token)).status===403,'revoked action refuses');
      check((await transact(readWire(grant),{kind:'oauth',admission:queued})).result.status===403,'queued work rechecks after revoke');
      check((await http(readWire(independentGrant),independent.access)).status===200,'independent active grant remains usable');
      const [status] = await db`SELECT active FROM commonswarm_oauth.resolve_admin_grant_status(${oauth.provider},${config.owner}::uuid,${publicJwk.kid})`;
      check(!status.active,'refresh policy shares terminal family state');
      const keyControlGrant=await activate(), keyControl=await issue(keyControlGrant,'independent-key');
      const parallel=await Promise.all([http(readWire(independentGrant),independent.access),http(readWire(keyControlGrant),keyControl.access)]);
      check(parallel.every(r=>r.status===200),'distinct issuer keys share account without lock upgrade deadlock');
      const cachedKeyRead=readWire(independentGrant);
      check((await http(cachedKeyRead,independent.access)).status===200,'key-denial cached read positive');
      await db`INSERT INTO commonswarm_oauth.issuer_key_denials(issuer,kid,reason,evidence_ref) VALUES('https://mcp.commonswarm.com',${publicJwk.kid},'test_compromise','edge-test')`;
      for (const method of ['initialize','tools/list']) check((await mcp(independent,method)).status===403,'key denial rechecks metadata');
      check((await http(cachedKeyRead,independent.access)).status===403,'key denial invalidates cached result');
      check((await http(wire({kind:'surrender_admin_delegation',grant_id:independentGrant.grantId,reason_code:'test'}),independent.access)).status===403,'key denial refuses action');
      check((await http(readWire(keyControlGrant),keyControl.access)).status===200,'independent issuer key positive after denial');
    } else if (scenario === 'expiry') {
      const independentGrant=await activate(), independent=await issue(independentGrant);
      await db`UPDATE swarm.memberships SET revoked_at=statement_timestamp() WHERE workspace_id=${config.workspace}::uuid AND user_id=${config.owner}::uuid`;
      check((await http(read,token)).status===403,'cached metadata rechecks current rights');
      check((await mcp(oauth,'tools/list')).status===403,'listing rechecks current rights');
      await db`UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=${config.workspace}::uuid AND user_id=${config.owner}::uuid`;
      check((await http(readWire(independentGrant),independent.access)).status===200,'restored current-rights independent control');
      const short={...grant.manifest,expires_at:Date.now()+2000};
      const consent=await http(wire({kind:'prepare_admin_consent',manifest:short,full_account_selected:false}));
      check(consent.status===200,'human narrowing preparation');
      check((await http(wire({kind:'narrow_admin_delegation',grant_id:grant.grantId,manifest:consent.body.manifest,manifest_digest:consent.body.manifest_digest,consent_receipt_id:consent.body.consent_receipt_id}))).status===200,'human narrowing');
      check((await http(read,token)).status===403,'old manifest JWT refuses immediately after narrowing');
      await new Promise(resolve=>setTimeout(resolve,2200));
      check((await http(readWire(grant),token)).status===403,'expiry enforced without lazy event');
      check((await http(wire({kind:'revoke_admin_delegation',grant_id:grant.grantId,reason_code:'human_revoked'}))).status===200,'human recovery after expiry');
    } else if (scenario === 'failure') {
      const input=readWire(grant), admission=await oauth.admission(), authentication={kind:'oauth',admission}, before=await count();
      const proofRequest=await oauth.request(input), admitted=await (await import('../../supabase/functions/command/admin-admission.ts')).admitAdminRequest(proofRequest,'admin_command');
      let reached=false; const rollback=new Error('intentional rollback');
      await db.begin(async tx=>{ await tx`SELECT set_config('role','swarm_command',true)`; const result=await adminTransaction(tx,input,{kind:'oauth',admission:admitted}); check(result.result.status===200,'rollback reaches positive authority'); reached=true; throw rollback; }).catch(error=>{if(error!==rollback)throw error;});
      check(reached && await count()===before,'rollback retains no domain success');
      const replayed=await handleRequest(proofRequest.clone()); check(replayed.status===401,'authority rollback cannot release committed proof');
      await db.begin(async tx=>{await tx`SELECT set_config('role','swarm_command',true)`;await recordAdminFailure(tx,input,authentication);});
      check(await count()===before+1,'separate failure card');
      const [failure]=await db`SELECT event FROM swarm.admin_events WHERE owner_user_id=${config.owner}::uuid ORDER BY seq DESC LIMIT 1`;
      check(failure.event.type==='AdminActionRecorded' && failure.event.payload.outcome==='failed' && failure.event.actor_user===null && failure.event.grant_id===grant.grantId,'failure is an audited delegated actor');
      check((await http(input,token)).status===503 && await count()===before+1,'failure receipt retains stable retry outcome');
    } else if (scenario === 'replay') {
      const postgres = (await import('npm:postgres@3.4.9')).default;
      const otherDb=postgres(config.local.DB_URL,{prepare:false,max:1});
      const {createAdminRequestVerifier}=await import('../../supabase/functions/_shared/admin-oauth-db.ts');
      try {
        const first=createAdminRequestVerifier(db), second=createAdminRequestVerifier(otherDb), jti=id();
        const request=await oauth.request(readWire(grant),'admin_command',{jti});
        const outcomes=await Promise.allSettled([first.verify(request,'admin_command'),second.verify(request.clone(),'admin_command')]);
        check(outcomes.filter(r=>r.status==='fulfilled').length===1 && outcomes.filter(r=>r.status==='rejected' && r.reason.code==='replay').length===1,'two edge verifier instances admit one signed proof');
        const {admitAdminRequest}=await import('../../supabase/functions/command/admin-admission.ts');
        const rollbackRequest=await oauth.request(readWire(grant));
        const accepted=await admitAdminRequest(rollbackRequest,'admin_command');
        const rollback=new Error('domain rollback'); let reached=false;
        await db.begin(async tx=>{await tx`SELECT set_config('role','swarm_command',true)`;check((await adminTransaction(tx,readWire(grant),{kind:'oauth',admission:accepted})).result.status===200,'replay test enters real authority');reached=true;throw rollback;}).catch(error=>{if(error!==rollback)throw error;});
        check(reached,'authority rollback executes');
        const restarted=createAdminRequestVerifier(otherDb);
        let replay=false;try{await restarted.verify(request.clone(),'admin_command');}catch(error){replay=error.code==='replay';}
        check(replay,'restarting verifier cannot release accepted proof');
        replay=false;try{await restarted.verify(rollbackRequest.clone(),'admin_command');}catch(error){replay=error.code==='replay';}
        check(replay,'authority rollback cannot release production-verifier proof');
        replay=false;try{await restarted.verify(await oauth.request({},'admin_mcp',{jti}),'admin_mcp');}catch(error){replay=error.code==='replay';}
        check(replay,'re-signed correct second-entry URI reaches shared uniqueness');
        check(!!(await restarted.verify(await oauth.request({},'admin_mcp'),'admin_mcp')),'new jti correct URI is positive control');
      } finally {await otherDb.end();}
    } else if (scenario === 'issuance') {
      const sign=async changes=>oauth.sign({typ:'at+jwt',alg:'ES256',kid:publicJwk.kid},{...oauth.claims,...changes},signing.privateKey);
      for (const changes of [{jti:id()},{connection_id:id()},{admin_identity_id:id()},{client_id:'foreign'},{manifest_digest:'f'.repeat(64)}]) {
        const foreign=await sign(changes), req=await oauth.request(readWire(grant));
        req.headers.set('authorization',`DPoP ${foreign}`);
        const header={typ:'dpop+jwt',alg:'ES256',jwk:oauth.jwk};
        req.headers.set('dpop',await oauth.sign(header,{htm:'POST',htu:'https://api.commonswarm.com/functions/v1/command',iat:Math.floor(Date.now()/1000),jti:id(),nonce:oauth.nonce,ath:base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(foreign))))},oauth.keys.privateKey));
        check((await handleRequest(req)).status===401,'signed but unrecorded or mismatched ledger cannot enter');
      }
      for (const method of ['initialize','tools/list']) check((await mcp(oauth,method)).status===200,'committed issuance metadata positive');
      check((await http(readWire(grant),token)).status===200,'committed issuance command positive');
      const rolledBack=await oauth.issue(1,{},oauth.g.scope_names,true);
      for (const surface of ['admin_command','admin_mcp']) {
        const body=surface==='admin_command'?readWire(grant):{jsonrpc:'2.0',id:1,method:'tools/list'};
        const handler=surface==='admin_command'?handleRequest:handleAdminMcpRequest;
        check((await handler(await oauth.request(body,surface,{},rolledBack))).status===401,'rolled-back issuance row refuses both entries');
      }
      const rotated=await oauth.issue(1);
      check((await handleRequest(await oauth.request(readWire(grant),'admin_command',{},rotated))).status===200,'new committed generation succeeds');
      check((await http(readWire(grant),token)).status===200,'prior live generation remains valid after rotation');
      const state=await db`SELECT projection FROM swarm.admin_accounts WHERE owner_user_id=${config.owner}::uuid`;
      check(state[0].projection.grants[grant.grantId].registry_version===2,'real v2 ledger binding');
    } else if (scenario === 'limits') {
      for (const method of ['initialize','tools/list']) check((await mcp(oauth,method)).status===200,'D3 metadata transaction');
      const [before]=await db`SELECT read_requests,action_rows FROM commonswarm_oauth.admin_oauth_audit_daily WHERE admin_grant_id=${grant.grantId}::uuid`;
      check(Number(before.read_requests)===3,'D3 init list read count');
      check((await http(read,token)).status===200,'fresh proof recovers fixed-command result');
      const bad=wire({kind:'unsupported_command'});check((await http(bad,token)).status===403,'authenticated refusal');
      check((await http(bad,token)).status===403,'refusal cached outcome');
      const [after]=await db`SELECT read_requests,action_rows FROM commonswarm_oauth.admin_oauth_audit_daily WHERE admin_grant_id=${grant.grantId}::uuid`;
      check(Number(after.read_requests)===4 && Number(after.action_rows)===2,'D3 counts every authenticated replay');
      // Put the real daily counter at its boundary, then use the HTTP entry.
      await db`UPDATE commonswarm_oauth.admin_oauth_audit_daily SET read_requests=1000,read_rows=1000 WHERE admin_grant_id=${grant.grantId}::uuid`;
      check((await mcp(oauth,'tools/list')).status===200,'read succeeds beyond retained audit row cap');
      const [capped]=await db`SELECT read_requests,read_rows,suppressed_read_rows FROM commonswarm_oauth.admin_oauth_audit_daily WHERE admin_grant_id=${grant.grantId}::uuid`;
      check(Number(capped.read_requests)===1001 && Number(capped.read_rows)===1000 && Number(capped.suppressed_read_rows)===1,'D3 suppresses row while counting beyond cap');
      const keys=[`mutation:grant:${grant.grantId}`,`mutation:connection:${grant.manifest.connection_id}`,`mutation:account:${config.owner}`];
      for (let n=1;n<policy.ADMIN_MUTATION_RATE_PER_HOUR.lineage;n++) {
        const attempt=wire({kind:'unsupported_command'}), prior=await count();
        check((await http(attempt,token)).status===403,'refused mutation consumes finite allowance');
        const rows=await db`SELECT attempts FROM swarm.admin_rate_buckets WHERE bucket_key=ANY(${keys}) AND hour_start=floor(extract(epoch FROM clock_timestamp())/3600)::bigint`;
        check(rows.length===keys.length && rows.every(r=>r.attempts===n+1),'durable connection/account/grant allowance counts');
        check((await http(attempt,token)).status===403 && await count()===prior+1,'idempotent domain refusal does not spend twice');
      }
      check((await http(wire({kind:'unsupported_command'}),token)).status===429,'finite mutation ceiling blocks next attempt');
      const [actions]=await db`SELECT count(*)::integer AS n FROM commonswarm_oauth.admin_oauth_audit WHERE admin_grant_id=${grant.grantId}::uuid AND event_kind='action'`;
      const [daily]=await db`SELECT action_rows FROM commonswarm_oauth.admin_oauth_audit_daily WHERE admin_grant_id=${grant.grantId}::uuid`;
      check(actions.n===Number(daily.action_rows) && actions.n>2,'every action retained beyond metadata cap');
      check((await http(wire({kind:'surrender_admin_delegation',grant_id:grant.grantId,reason_code:'surrendered'}),token)).status===200,'surrender audit commits with terminal family');
    } else throw new Error('unknown scenario');
    const material=JSON.stringify(await db`SELECT event FROM swarm.admin_events WHERE owner_user_id=${config.owner}::uuid`);
    check(!material.includes(token),'domain events exclude raw credential');
  }
  console.log('ADMIN_SERVER_OK');
} catch {
  console.log('ADMIN_SERVER_FAILED:' + stage);
  Deno.exitCode = 1;
} finally { await db.end({ timeout: 2 }); }
