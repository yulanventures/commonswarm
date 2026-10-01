// Real adapters, real command transactions, fixed assertion labels only.
const config = JSON.parse(await Deno.readTextFile(Deno.args[0]));
for (const value of [config.local.API_URL, config.local.DB_URL]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)) throw new Error('local stack required');
}
Deno.env.set('SWARM_ENV', 'test');
Deno.env.set('SWARM_DATABASE_URL', config.local.DB_URL);
Deno.env.set('SUPABASE_URL', config.local.API_URL);
Deno.env.set('SUPABASE_ANON_KEY', config.local.ANON_KEY);
Deno.env.set('SWARM_COMMAND_ALLOWED_ORIGINS', 'https://commonswarm.com');
const { db, handleRequest: command } = await import('../../supabase/functions/command/index.ts');
const { handleRequest: read } = await import('../../supabase/functions/read/index.ts');
const policy = await import('../../supabase/functions/_shared/protocol.js');
let stage = 'initialization';
const check = (condition, label) => { stage = label; if (!condition) throw new Error('assertion'); };
const id = () => crypto.randomUUID();
const person = config.people[0], owner = config.people[1], member = config.people[2];
async function invoke(handler, body, jwt = person.jwt) {
  const response = await handler(new Request('http://127.0.0.1/functions/v1/test', {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Origin: 'https://commonswarm.com' }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}
const view = (resource, workspace_id = null, before = null) => ({ resource, workspace_id, before, limit: 1 });
const wire = value => ({ command_id: id(), stream: { kind: 'account' }, resource: policy.ADMIN_RESOURCE, command: value });
async function grant(full = false, expires = Date.now() + 86400000) {
  const manifest = { connection_id: id(), client_id: '<img src=x onerror=alert(1)>\u001b[2J', resource: policy.ADMIN_RESOURCE,
    mode: full ? 'full_account' : 'granular', registry_version: policy.ADMIN_REGISTRY_VERSION,
    scope_names: full ? policy.ADMIN_SCOPE_NAMES : ['admin:read'], workspace_selector: full ? 'owned_and_selected' : 'selected', workspace_ids: [config.workspace],
    created_workspace_policy: { scope_names: [] }, target_rules: { seat_ids: [], own_seats: false, grant_created_seats: false, recipient_user_ids: [], recipient_connection_ids: [], transports: [] },
    worker_scope_ceiling: [], role_ceiling: 'member', renewal_limits: { ...policy.ADMIN_RENEWAL_CEILINGS, grant_kinds: [], principal_ids: [] },
    issuance_limits: { ...policy.ADMIN_ISSUANCE_CEILINGS }, expires_at: expires, refresh_deadline: Date.now() + 86400000 };
  const prepared = await invoke(command, wire({ kind: 'prepare_admin_consent', manifest, full_account_selected: full }));
  check(prepared.status === 200, 'real human consent prepared');
  const grant_id = id();
  const result = await invoke(command, wire({ kind: 'grant_admin_delegation', grant_id, consent_receipt_id: prepared.body.consent_receipt_id, replaces_grant_id: null }));
  check(result.status === 200 && result.body.ok === true, 'real human grant activated');
  return grant_id;
}
try {
  const catalog = await db`SELECT to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)')::text AS function`;
  check(catalog[0]?.function, 'lane C read adapter migration required');
  const grants = [await grant(), await grant(true), await grant()];
  let page = await invoke(read, view('admin_grants'));
  check(page.status === 200 && page.body.grants.length === 1 && page.body.active.grant_count === 3 && page.body.active.full_account_count === 1, 'active summary independent of page');
  const seen = [];
  while (true) {
    seen.push(page.body.grants[0].grant_id);
    if (!page.body.next_before) break;
    page = await invoke(read, view('admin_grants', null, page.body.next_before));
  }
  check(seen.length === 3 && new Set(seen).size === 3 && grants.every(g => seen.includes(g)), 'grant cursor has no gaps or duplicates');
  const privatePage = await invoke(read, view('admin_grants'), owner.jwt);
  check(privatePage.status === 200 && privatePage.body.grants.length === 0, 'foreign account grants remain private');
  const workspacePage = await invoke(read, view('admin_grants', config.workspace), owner.jwt);
  check(workspacePage.status === 200 && workspacePage.body.grants.length === 0 && workspacePage.body.active.grant_count === 3 && workspacePage.body.active.full_account_count === 0, 'workspace indicator hides foreign grant details');
  check((await invoke(read, view('admin_history', config.workspace), member.jwt)).status === 403, 'ordinary membership does not expose private administration');
  check((await invoke(read, { ...view('admin_grants'), owner_user_id: person.user_id })).status === 400, 'account substitution rejected');
  check((await invoke(read, { ...view('admin_grants'), limit: 101 })).status === 400, 'unbounded read rejected');
  check((await invoke(read, view('admin_grants'), 'swm_adm_' + 'a'.repeat(43))).status === 403, 'admin access cannot use human recovery');
  check((await invoke(read, view('admin_history'), 'swm_agt_' + 'a'.repeat(43))).status === 403, 'worker access cannot use human recovery');
  const withdraw = await invoke(command, wire({ kind: 'withdraw_admin_workspace_access', grant_id: grants[0], workspace_id: config.workspace, reason_code: 'human_withdrawn' }), owner.jwt);
  check(withdraw.status === 200, 'workspace owner withdrawal uses existing command');
  const workspaceHistory = await invoke(read, view('admin_history', config.workspace), owner.jwt);
  check(workspaceHistory.status === 200 && workspaceHistory.body.actions.length === 1 && workspaceHistory.body.actions[0].action === 'withdraw_admin_workspace_access', 'workspace owner sees relevant action only');
  check((await invoke(read, view('admin_history'), owner.jwt)).body.actions.length === 0, 'workspace access never exposes foreign account lifecycle');
  const allActions = []; let before = null;
  do {
    const next = await invoke(read, view('admin_history', null, before));
    check(next.status === 200 && next.body.actions.length <= 1, 'bounded history page');
    allActions.push(...next.body.actions); before = next.body.next_before;
  } while (before);
  const stored = await db`SELECT event_id FROM swarm.admin_events WHERE owner_user_id = ${person.user_id}::uuid AND event->>'type' = 'AdminActionRecorded'`;
  check(allActions.length === stored.length && new Set(allActions.map(a => a.event_id)).size === stored.length, 'audit cursor reconciles the complete set');
  const material = JSON.stringify(allActions);
  check(!/request_digest|manifest_digest|policy_check|session_binding|access_hash|refresh_hash/.test(material), 'history excludes private payload fields');
  const last = await grant(false, Date.now() + 5000);
  await new Promise(resolve => setTimeout(resolve, 5500));
  const expired = await invoke(read, { ...view('admin_grants'), limit: 100 });
  check(expired.body.grants.find(g => g.grant_id === last)?.state === 'expired', 'expiry enforced before materialization');
  await db`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${config.workspace}::uuid AND user_id = ${person.user_id}::uuid`;
  await db`UPDATE swarm.workspaces SET archived_at = statement_timestamp() WHERE workspace_id = ${config.workspace}::uuid`;
  check((await invoke(read, view('admin_grants'))).status === 200, 'account recovery survives archived workspace and membership loss');
  const revokeWire = wire({ kind: 'revoke_admin_delegation', grant_id: grants[1], reason_code: 'human_revoked' });
  const revoked = await invoke(command, revokeWire);
  check(revoked.status === 200 && revoked.body.ok === true, 'offline account revoke accepted');
  const count = await db`SELECT count(*)::integer AS n FROM swarm.admin_events WHERE owner_user_id = ${person.user_id}::uuid`;
  check((await invoke(command, revokeWire)).status === 200, 'same revocation request replays');
  const after = await db`SELECT count(*)::integer AS n FROM swarm.admin_events WHERE owner_user_id = ${person.user_id}::uuid`;
  check(after[0].n === count[0].n, 'revocation retry adds no audit duplicate');
  const final = await invoke(read, { ...view('admin_grants'), limit: 100 });
  check(final.body.grants.find(g => g.grant_id === grants[1])?.state === 'revoked', 'durable revocation displayed');
  console.log('ADMIN_RECOVERY_SERVER_OK');
} catch {
  console.log('ADMIN_RECOVERY_SERVER_FAILED:' + stage); Deno.exitCode = 1;
} finally { await db.end({ timeout: 2 }); }
