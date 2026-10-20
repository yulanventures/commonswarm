// HezLead ruling 38, item 4: real renewal transactions must abort on 40P01/40001.
// Adapted from the saved r12b 104-table probe. Run only on an isolated local database.
// deno run --allow-read --allow-env --allow-net <harness> <tree> <main|real_read> <server.log|empty> [0600 config.json]
// real_read requires SWARM_CMD_TEST_SLEEP_AFTER_STEP=9:2500. The positive controls
// and exact-lock synthetic sibling contenders run in that SAME invocation.
// Temporary database triggers gate the real reader before COMMIT and raise 40001
// at the stranded-token UPDATE. No production hook/export/flag is added.
// Output contains only fixture ids, redacted bodies, counts, hashes, and SQLSTATEs.
const [tree, mode, serverLog, configPath] = Deno.args;
const config = configPath ? JSON.parse(await Deno.readTextFile(configPath)) : null;
const DB = config?.db_url ?? 'postgres://postgres@127.0.0.1:54931/lock_order_probe';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(DB).hostname)) throw new Error('local probe database required');
Deno.env.set('SWARM_ENV', 'test');
Deno.env.set('SWARM_DATABASE_URL', DB);
Deno.env.delete('SUPABASE_DB_URL');
Deno.env.delete('SWARM_DATABASE_TLS_CA_B64');
Deno.env.set('SUPABASE_URL', 'http://lock-order.invalid');
Deno.env.set('SUPABASE_ANON_KEY', 'lock-order-no-api');
Deno.env.set('SWARM_COMMAND_ALLOWED_ORIGINS', 'https://commonswarm.com');
let httpRefused = 0;
globalThis.fetch = async () => {
  httpRefused += 1;
  throw new TypeError('probe has no network access');
};
const served = [];
Deno.serve = (handler) => {
  served.push(typeof handler === 'function' ? handler : handler.handler);
  return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: '127.0.0.1', port: 0 } };
};
const out = { tree, mode, hook_sleep: Deno.env.get('SWARM_CMD_TEST_SLEEP_AFTER_STEP') ?? null, stage: 'import' };
const sqlstate = (e) => (e && typeof e === 'object' && typeof e.code === 'string' && /^[0-9A-Z]{5}$/u.test(e.code) ? e.code : 'non_sql');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = () => crypto.randomUUID();
const logLines = async (needle) => serverLog ? (await Deno.readTextFile(serverLog)).split('\n').filter((l) => l.includes(needle)) : [];
const logPid = (line) => Number(/\[(\d+)\]/u.exec(line)?.[1] ?? 0);
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
try {
  const { default: postgres } = await import('npm:postgres@3.4.9');
  const observer = postgres(DB, { prepare: false, max: 8, onnotice: () => {} });
  const command = await import(`${tree}/supabase/functions/command/index.ts`);
  const read = await import(`${tree}/supabase/functions/read/index.ts`);
  // Capture the error AFTER postgres.js rolls the entire transaction back.
  // No production seam: this is the exported real command pool at its existing boundary.
  const authTypes = await import(`${tree}/supabase/functions/_shared/agent-auth.ts`);
  let discoveryRetries = 0;
  const commandCodes = [];
  const begin = command.db.begin;
  command.db.begin = function (...args) {
    return begin.apply(this, args).catch((error) => { commandCodes.push(sqlstate(error)); if(error instanceof authTypes.LocalAuthDiscoveryChanged) discoveryRetries++; throw error; });
  };
  const { CLIENT_PROTOCOL_VERSION } = await import(`${tree}/src/cloud/config.ts`);
  const {HOUSEHOLD_LOCAL_SEAT}=await import(`${tree}/supabase/functions/_shared/protocol.js`);
  const tag = id().replaceAll('-', '').slice(0, 10);

  out.stage = 'fixture';
  const owner = id();
  const email = `r12b-owner-${owner}@example.test`;
  await observer`INSERT INTO auth.users (id, aud, role, email) VALUES (${owner}::uuid, 'authenticated', 'authenticated', ${email})`;
  await observer`INSERT INTO swarm.users (user_id, display_name, email) VALUES (${owner}::uuid, ${`R12b owner ${tag}`}, ${email})`;
  const W = id(), streamId = id();
  await observer.begin(async (tx) => {
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${W}::uuid, ${`R12b ${tag}`}, ${owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${W}::uuid, ${owner}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${streamId}::uuid, ${W}::uuid, 'workspace')`;
  });
  const mintRaw = () => `swm_agt_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
  const hashOf = async (raw) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));

  const capture = async (response) => {
    const text = await response.text();
    return { status: response.status, text, headers: [...response.headers].map(([k, v]) => `${k}: ${v}`).sort() };
  };
  // The printed form: credentials and wake topics replaced, ids kept (they are fixture uuids).
  const shape = (r) => {
    let body;
    try { body = JSON.parse(r.text); } catch { return { status: r.status, body: '<not json>' }; }
    const clean = (v) => {
      if (typeof v === 'string') return v.replace(/swm_[A-Za-z0-9_-]+/gu, '<credential>');
      if (Array.isArray(v)) return v.map(clean);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'wake' ? '<wake redacted>' : k === 'request_id' ? '<uuid>' : clean(x)]));
      return v;
    };
    return { status: r.status, body: clean(body), headers: r.headers };
  };
  const credential = (r) => { try { return JSON.parse(r.text).agent_token ?? null; } catch { return null; } };
  const renew = async (token, commandId, fields = {}, workspace = W, proof = {}) => capture(await command.handleRequest(new Request('http://127.0.0.1/functions/v1/command', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...proof },
    body: JSON.stringify({ command_id: commandId, client_version: CLIENT_PROTOCOL_VERSION, workspace_id: workspace,
      stream: { kind: 'workspace' }, command: { kind: 'renew_agent_token', ...fields } }) })));
  const readAs = async (token, workspace = W) => capture(await read.handleRequest(new Request('http://127.0.0.1/functions/v1/read', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ resource: 'members', workspace_id: workspace }) })));

  // A renewable seat: a local, unmanaged principal (no session proof needed, agent-auth.ts:246-248), its device and run,
  // a standing renewal grant bound to that device, and a root token T0 with a task/epoch binding and that grant (rows as
  // tests/p1-server/renewal-last-use.test.ts:70-80). T0 gets its first use from the real read route (a token is never
  // born used, SWARM_TOKEN_FIRST_USE_PRESET). Unused expired permanent roots instead authenticate a renewal before issuance.
  const seat = async (name, use=true, boundDevice=undefined, kind='standing', options={}) => {
    const principal = options.principal ?? id(), device = id(), run = id(), task = id(), lineage = id(), grant = id(), t0 = id();
    const raw = mintRaw(), hash = await hashOf(raw), workspace = options.workspace ?? W;
    await observer.begin(async (tx) => {
      await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${options.deviceOwner ?? owner}::uuid, ${`r12b-${name}`})`;
      if(!options.principal) await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, parent_admin_grant_id) VALUES (${principal}::uuid, ${workspace}::uuid, ${owner}::uuid, ${`r12b-${name}-${tag}`}, ${options.principalParent ?? null}::uuid)`;
      await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
      await tx`INSERT INTO swarm.renewal_grants (renewal_grant_id, workspace_id, principal_id, run_id, kind, max_successors, successors_used,
        horizon_expires_at, bound_device_id, created_by, created_at)
        VALUES (${grant}::uuid, ${workspace}::uuid, ${options.familyPrincipal ?? principal}::uuid, ${options.familyRun ?? run}::uuid, ${kind==='timeboxed'?'timeboxed':'standing'}, ${kind==='timeboxed'?100:null}, 0,
          ${kind==='timeboxed'?new Date(Date.now()+86400000):null}::timestamptz,
          ${boundDevice===undefined ? device:boundDevice}::uuid, ${options.creator ?? owner}::uuid, ${options.createdAt ?? new Date()}::timestamptz)`;
      await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, task_id, epoch, scopes, token_hash, expires_at, lineage_id,
        renewal_grant_id, parent_admin_grant_id, recipient_connection_id)
        VALUES (${t0}::uuid, ${principal}::uuid, ${run}::uuid, ${task}::uuid, 1, ${tx.json(['post_signal'])}::jsonb, ${hash},
        statement_timestamp() + interval '1 hour', ${lineage}::uuid, ${kind==='no-family'?null:grant}::uuid, ${options.tokenParent ?? null}::uuid, ${options.recipient ?? null}::uuid)`;
    });
    if(use) {
      const firstUse = await readAs(raw,workspace);
      const [used] = await observer`SELECT first_used_at IS NOT NULL AS used FROM swarm.agent_tokens WHERE token_id = ${t0}::uuid`;
      if (firstUse.status !== 200 || !used.used) throw Object.assign(new Error('seat'), { code: `FIXTURE_SEAT_${firstUse.status}` });
    }
    return { name, principal, device, run, grant, t0, raw };
  };

  const tables = (await observer`SELECT schemaname || '.' || relname AS t FROM pg_stat_user_tables ORDER BY 1`).map((r) => r.t);
  out.tables_counted = tables.length;
  const snapshot = async () => {
    const counts = {}, hashes = {};
    for (const t of tables) {
      const [schema, name] = t.split('.');
      const [r] = await observer.unsafe(`SELECT count(*)::bigint AS n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h FROM "${schema}"."${name}" AS x`);
      counts[t] = Number(r.n);
      hashes[t] = r.h;
    }
    return { counts, hashes };
  };
  const diff = (a, b) => ({
    counts: Object.fromEntries(tables.filter((t) => a.counts[t] !== b.counts[t]).map((t) => [t, b.counts[t] - a.counts[t]])),
    content_changed: tables.filter((t) => a.hashes[t] !== b.hashes[t]),
  });
  // The renewal state of one seat: every token of its lineage, its grant counters, its audit rows, its idempotency rows,
  // the stream head and the failure rows. Ids are fixture uuids; no hash or credential is selected.
  const seatState = async (s) => {
    const tokens = await observer`SELECT token_id, predecessor_token_id, first_used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked,
      expires_at > statement_timestamp() AS unexpired FROM swarm.agent_tokens WHERE run_id = ${s.run}::uuid ORDER BY issued_at, token_id`;
    const [g] = await observer`SELECT successors_used, successors_stranded, last_used_at, new_host_at, suspended_at FROM swarm.renewal_grants WHERE renewal_grant_id = ${s.grant}::uuid`;
    const audit = await observer`SELECT command_kind, outcome, reason FROM swarm.audit_log WHERE actor_agent_principal = ${s.principal}::uuid ORDER BY audit_id`;
    const idem = await observer`SELECT command_id, response->>'ok' AS ok, response->>'reason' AS reason, response->>'token_id' AS token_id
      FROM swarm.idempotency_keys WHERE principal_kind = 'agent' AND principal_id LIKE '%' || ${s.principal}::text || '%' ORDER BY command_id`;
    const tombstones = await observer`SELECT kind, target_id FROM swarm.revocation_tombstones WHERE target_id IN (SELECT token_id FROM swarm.agent_tokens WHERE run_id = ${s.run}::uuid) ORDER BY kind, target_id`;
    const [head] = await observer`SELECT head_seq FROM swarm.streams WHERE stream_id = ${streamId}::uuid`;
    const events = await observer`SELECT type, payload->>'reason' AS reason FROM swarm.events WHERE stream_id = ${streamId}::uuid AND actor_agent_principal = ${s.principal}::uuid ORDER BY seq`;
    const presence = await observer`SELECT count(*)::int AS n FROM swarm.agent_presence WHERE principal_id = ${s.principal}::uuid`;
    const failures = await observer`SELECT command_kind, reason, db_code FROM swarm.command_failures WHERE command_kind = 'renew_agent_token' ORDER BY occurred_at, failure_id`;
    const label = (tid) => (tid === s.t0 ? 'T0' : s.labels?.[tid] ?? tid);
    return {
      tokens: tokens.map((t) => ({ token: label(t.token_id), predecessor: t.predecessor_token_id ? label(t.predecessor_token_id) : null, used: t.used, revoked: t.revoked, unexpired: t.unexpired })),
      grant: { successors_used: Number(g.successors_used), successors_stranded: Number(g.successors_stranded), last_used_at: iso(g.last_used_at), new_host_at: iso(g.new_host_at), suspended_at: iso(g.suspended_at) },
      audit: audit.map((a) => `${a.command_kind}/${a.outcome}/${a.reason ?? '-'}`),
      idempotency: idem.map((i) => ({ command_id: i.command_id, ok: i.ok, reason: i.reason, token_id: i.token_id ? label(i.token_id) : null })),
      tombstones: tombstones.map((t) => `${t.kind}:${label(t.target_id)}`),
      stream_head_seq: Number(head.head_seq),
      events: events.map((e) => `${e.type}${e.reason ? '/' + e.reason : ''}`),
      presence_rows: presence[0].n,
      command_failures_renew: failures.map((f) => `${f.reason}/${f.db_code ?? 'null'}`),
    };
  };
  const nameSuccessor = (s, r, label) => {
    try { const tid = JSON.parse(r.text).token_id; if (tid) { s.labels = { ...(s.labels ?? {}), [tid]: label }; } } catch { /* not json */ }
  };
  const blockedBy = async (pid) => (await observer`SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`).map((r) => Number(r.pid));
  const waitBlockedBy = async (pid, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      const rows = await blockedBy(pid);
      if (rows.length === 1) return rows[0];
      await sleep(20);
    }
    return 0;
  };
  const waitDetail = async (pid) => {
    const [a] = await observer`SELECT left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 140) AS q, wait_event_type, wait_event, state FROM pg_stat_activity WHERE pid = ${pid}::int`;
    const locks = await observer`SELECT l.locktype, l.mode, c.relname FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
      WHERE l.pid = ${pid}::int AND NOT l.granted`;
    return { statement: a?.q ?? null, wait: a ? `${a.wait_event_type}/${a.wait_event}` : null, state: a?.state ?? null,
      ungranted: locks.map((l) => `${l.locktype}:${l.mode}:${l.relname ?? '-'}`) };
  };
  const victimsSince = async (n0, pids) => (await logLines('ERROR:  deadlock detected')).slice(n0).map(logPid)
    .map((pid) => Object.entries(pids).find(([, p]) => p === pid)?.[0] ?? `other:${pid}`);

  // A contender transaction: takes `first`, signals ready, waits for release, takes `second`, then rolls back on purpose.
  const contender = (first, second) => {
    let release, ready, pid = 0, got = false;
    const released = new Promise((r) => { release = r; }), isReady = new Promise((r) => { ready = r; });
    const done = observer.begin(async (tx) => {
      pid = Number((await tx`SELECT pg_backend_pid() AS p`)[0].p);
      await first(tx);
      ready();
      await released;
      await second(tx);
      got = true;
      throw Object.assign(new Error('rollback'), { code: 'PROBE_ROLLBACK' });
    }).catch((e) => (sqlstate(e) === 'non_sql' && e.code === 'PROBE_ROLLBACK' ? 'rolled_back' : sqlstate(e)));
    return { isReady, release: () => release(), done, pid: () => pid, got: () => got };
  };

  // One fault scenario: the renewal (token, commandId) races the contender; then a retry of the identical request.
  const faultRace = async (s, label, token, commandId, first, second) => {
    const before = await snapshot();
    const code0 = commandCodes.length;
    const state0 = await seatState(s);
    const n0 = (await logLines('ERROR:  deadlock detected')).length;
    const c = contender(first, second);
    await c.isReady;
    const t0 = Date.now();
    const responseP = renew(token, commandId);
    const renewalPid = await waitBlockedBy(c.pid());
    const parked = { renewal_waits_on_contender: renewalPid !== 0, renewal_wait: renewalPid !== 0 ? await waitDetail(renewalPid) : null };
    c.release();
    const response = await responseP;
    const answeredMs = Date.now() - t0;
    const contenderEnd = await c.done;
    nameSuccessor(s, response, `${label}-answer`);
    const after = await snapshot();
    const result = {
      scenario: label, command_sqlstates: commandCodes.slice(code0), parked, contender_got_second_lock: c.got(), contender: contenderEnd, answered_after_ms: answeredMs,
      server_log_victims: await victimsSince(n0, { renewal: renewalPid, contender: c.pid() }),
      response: shape(response), state_before: state0, state_after: await seatState(s), rows: diff(before, after),
    };
    const retry = await renew(token, commandId);
    nameSuccessor(s, retry, `${label}-retry`);
    const r1 = await snapshot();
    result.retry_same_command_id = { response: shape(retry), state_after: await seatState(s), rows: diff(after, r1) };
    const successor = credential(retry);
    if (successor) {
      const use = await readAs(successor);
      result.retry_successor_first_use = { read: shape(use), state_after: await seatState(s) };
    }
    return result;
  };

  out.results = {};
  if(mode==='permanence') {
    out.stage='permanence';
    const checks=[];
    const check=(name,ok)=>checks.push({name,ok:Boolean(ok)});
    const s=await seat('expired-proof');
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${s.t0}::uuid`;
    const [before]=await observer`SELECT expires_at,first_used_at FROM swarm.agent_tokens WHERE token_id=${s.t0}::uuid`;
    const renewed=await renew(s.raw,id());
    const successor=credential(renewed);
    check('expired used standing bearer silently renews at real command boundary',renewed.status===200 && successor!==null);
    const [after]=await observer`SELECT expires_at,first_used_at FROM swarm.agent_tokens WHERE token_id=${s.t0}::uuid`;
    check('renewal proof changes no predecessor adoption or expiry history',iso(before.expires_at)===iso(after.expires_at) && iso(before.first_used_at)===iso(after.first_used_at));
    check('renewed successor authenticates at real read boundary',successor!==null && (await readAs(successor)).status===200);
    const terminal=await seat('chosen-terminal');
    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
      WHERE renewal_grant_id=${terminal.grant}::uuid`;
    const terminalBefore=await seatState(terminal);
    const refused=await renew(terminal.raw,id());
    const terminalAfter=await seatState(terminal);
    check('elapsed chosen date refuses despite same technical family',refused.status===401 || refused.status===403);
    check('chosen denial creates no successor spend or ledger effects',JSON.stringify(terminalBefore)===JSON.stringify(terminalAfter));
    // A decided content refusal is a valid use, while business effects stay absent.
    const content=await seat('household-denial');
    const first=await renew(content.raw,id());
    const unused=credential(first);
    const beforeDenied=await seatState(content);
    const denied=unused ? await capture(await command.handleRequest(new Request('http://127.0.0.1/functions/v1/command',{
      method:'POST',headers:{authorization:`Bearer ${unused}`,'content-type':'application/json'},
      body:JSON.stringify({command_id:id(),client_version:CLIENT_PROTOCOL_VERSION,workspace_id:W,stream:{kind:'workspace'},
        command:{kind:'household_tool',tool:'object_list',arguments:{seat:HOUSEHOLD_LOCAL_SEAT,offset:0,limit:10}}})}))) : null;
    const deniedBody=denied ? JSON.parse(denied.text) : null;
    check('household denial reaches its actual content boundary',denied?.status===200 && deniedBody?.status==='refused');
    const afterDenied=await seatState(content);
    const adopted=afterDenied.tokens.find(t=>t.token===JSON.parse(first.text).token_id);
    check('decided household refusal commits genuine successor use and predecessor cut',adopted?.used && !afterDenied.tokens.find(t=>t.token==='T0').unexpired);
    check('decided household refusal retains its intentional audit',afterDenied.audit.length===beforeDenied.audit.length+1);
    check('content refusal commits no business events or reducer ledger',JSON.stringify(afterDenied.events)===JSON.stringify(beforeDenied.events)
      && JSON.stringify(afterDenied.idempotency)===JSON.stringify(beforeDenied.idempotency) && afterDenied.stream_head_seq===beforeDenied.stream_head_seq);
    check('refused first-use successor remains usable',unused!==null && (await readAs(unused)).status===200);
    // Rejection is a decided, replayable result; it also completes the first
    // actual use needed by the next renewal, without issuing a child early.
    const pending=await seat('pending-decision'),pendingIssue=await renew(pending.raw,id());
    const pendingRaw=credential(pendingIssue),decisionId=id();
    const pendingBefore=await seatState(pending),decision=await renew(pendingRaw,decisionId);
    check('unused live successor reaches owning reducer refusal',JSON.parse(decision.text).reason==='predecessor_pending_first_use');
    const decidedState=await seatState(pending);
    check('rejected renewal commits use and exactly one rejected ledger entry',decidedState.tokens.length===pendingBefore.tokens.length
      && decidedState.tokens.find(t=>t.token===JSON.parse(pendingIssue.text).token_id)?.used
      && decidedState.idempotency.some(r=>r.command_id===decisionId && r.ok==='false'));
    const replayed=await renew(pendingRaw,decisionId);
    check('same ID and hash replay the stored domain reason',JSON.parse(replayed.text).reason==='predecessor_pending_first_use'
      && (await seatState(pending)).tokens.length===decidedState.tokens.length);
    check('a fresh renewal after committed use issues normally',credential(await renew(pendingRaw,id()))!==null);
    // Saved pending credentials are exercised as real proofs, including two
    // consecutive crashes after durable save and before first use.
    const crash=await seat('future-crash');
    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '1 day',
      suspended_at=clock_timestamp() WHERE renewal_grant_id=${crash.grant}::uuid`;
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${crash.t0}::uuid`;
    let saved=await renew(crash.raw,id());
    check('future chosen date and old idle history permit expired used proof renewal',credential(saved)!==null);
    for(let attempt=0;attempt<2;attempt++) {
      const savedId=JSON.parse(saved.text).token_id,savedRaw=credential(saved);
      await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${savedId}::uuid`;
      saved=await renew(savedRaw,id());
      const [used]=await observer`SELECT first_used_at IS NOT NULL AS used FROM swarm.agent_tokens WHERE token_id=${savedId}::uuid`;
      check(`saved pending proof crash recovery ${attempt+1} commits use before next issuance`,used.used && credential(saved)!==null);
    }
    check('recovered successor reaches actual read',(await readAs(credential(saved))).status===200);
    // Primary regression owner: real command/DB, no synthesized auth context.
    const bootstrap=await seat('unused-bootstrap',false);
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${bootstrap.t0}::uuid`;
    const bootstrapBefore=await seatState(bootstrap);
    check('unused-root admission starts unused expired and bound',bootstrapBefore.tokens.length===1
      && !bootstrapBefore.tokens[0].used && !bootstrapBefore.tokens[0].unexpired);

    check('unused-root ordinary expired read denies without use',[401,403].includes((await readAs(bootstrap.raw)).status)
      && JSON.stringify(bootstrapBefore)===JSON.stringify(await seatState(bootstrap)));
    const ordinaryFields={kind:'create',task_id:id(),slug:'unused-expired'};
    check('unused-root ordinary expired command denies without use',[401,403].includes((await renew(bootstrap.raw,id(),ordinaryFields)).status)
      && JSON.stringify(bootstrapBefore)===JSON.stringify(await seatState(bootstrap)));
    for(const fields of [{token_id:bootstrap.t0},{principal_id:bootstrap.principal},{expires_at:'2099-01-01T00:00:00Z'},
      {extra:true},{kind:'renew_agent_token ',principal_id:bootstrap.principal}]) {
      const malformed=await renew(bootstrap.raw,id(),fields);
      check('unused-root malformed renewal cannot commit use',malformed.status>=400
        && JSON.stringify(bootstrapBefore)===JSON.stringify(await seatState(bootstrap)));
    }
    const recovered=await renew(bootstrap.raw,id()),recoveredRaw=credential(recovered);
    const recoveredState=await seatState(bootstrap);
    check('unused-root real renewal commits genuine use and one child',recovered.status===200 && recoveredRaw!==null
      && recoveredState.tokens.length===2 && recoveredState.tokens.find(t=>t.token==='T0').used);
    check('unused-root ordinary expired read still denies after recovery',[401,403].includes((await readAs(bootstrap.raw)).status)
      && JSON.stringify(recoveredState)===JSON.stringify(await seatState(bootstrap)));
    check('unused-root ordinary expired command still denies after recovery',[401,403].includes((await renew(bootstrap.raw,id(),ordinaryFields)).status)
      && JSON.stringify(recoveredState)===JSON.stringify(await seatState(bootstrap)));
    check('unused-root successor authenticates',recoveredRaw!==null && (await readAs(recoveredRaw)).status===200);
    // A family with no device binding and a future owner date is still live.
    const unbound=await seat('unused-unbound-future',false,null);
    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '1 day'
      WHERE renewal_grant_id=${unbound.grant}::uuid`;
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${unbound.t0}::uuid`;
    check('unused-root NULL binding and future date renew',credential(await renew(unbound.raw,id()))!==null);
    // Each refusal differs from the positive by one authority gate.
    const foreignDevice=id();
    await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${foreignDevice}::uuid,${owner}::uuid,'Root foreign binding')`;
    for(const variant of ['timeboxed','no-family','wrong-binding','surrendered','revoked','principal-revoked','family-tombstone','token-tombstone','terminal-date','elapsed-date','ended-run','revoked-device','removed-member','archived']) {
      const bad=await seat(`unused-${variant}`,false,variant==='wrong-binding'?foreignDevice:undefined,
        variant==='timeboxed'?'timeboxed':variant==='no-family'?'no-family':'standing');
      await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${bad.t0}::uuid`;
      if(variant==='surrendered') await observer`UPDATE swarm.agent_tokens SET surrender_only=true WHERE token_id=${bad.t0}::uuid`;
      if(variant==='revoked') await observer`UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp() WHERE renewal_grant_id=${bad.grant}::uuid`;
      if(variant==='principal-revoked') await observer`UPDATE swarm.agent_principals SET revoked_at=clock_timestamp() WHERE principal_id=${bad.principal}::uuid`;
      if(variant==='family-tombstone') await observer`INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
        SELECT 'family',lineage_id,${owner}::uuid FROM swarm.agent_tokens WHERE token_id=${bad.t0}::uuid`;
      if(variant==='token-tombstone') await observer`INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by) VALUES('token',${bad.t0}::uuid,${owner}::uuid)`;
      if(variant==='terminal-date') await observer`UPDATE swarm.renewal_grants SET connection_expired_at=clock_timestamp() WHERE renewal_grant_id=${bad.grant}::uuid`;
      if(variant==='elapsed-date') await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second' WHERE renewal_grant_id=${bad.grant}::uuid`;
      if(variant==='ended-run') await observer`UPDATE swarm.agent_runs SET ended_at=clock_timestamp() WHERE run_id=${bad.run}::uuid`;
      if(variant==='revoked-device') await observer`UPDATE swarm.devices SET revoked_at=clock_timestamp() WHERE device_id=${bad.device}::uuid`;
      if(variant==='removed-member') await observer`UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${W}::uuid AND user_id=${owner}::uuid`;
      if(variant==='archived') await observer`UPDATE swarm.workspaces SET archived_at=clock_timestamp() WHERE workspace_id=${W}::uuid`;
      try {
        const before=await seatState(bad),refused=await renew(bad.raw,id());
        check(`unused-root-${variant}-denied-without-effects`,[401,403].includes(refused.status)
          && JSON.stringify(before)===JSON.stringify(await seatState(bad)));
      } finally {
        if(variant==='removed-member') await observer`UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=${W}::uuid AND user_id=${owner}::uuid`;
        if(variant==='archived') await observer`UPDATE swarm.workspaces SET archived_at=NULL WHERE workspace_id=${W}::uuid`;
      }
    }

    // C2 primary owner: real renewal + persisted no-effects. Each malformed
    // identity differs from the admitted unused root; used-root controls do
    // not exercise this branch. No auth/outcome is synthesized.
    const outsider=id();
    await observer`INSERT INTO auth.users(id,aud,role,email) VALUES(${outsider}::uuid,'authenticated','authenticated',${outsider+'@example.test'})`;
    await observer`INSERT INTO swarm.users(user_id,display_name) VALUES(${outsider}::uuid,'Root other owner')`;
    const otherFamily=await seat('unused-other-family',false);
    for(const [variant,options] of [
      ['wrong-device-owner',{deviceOwner:outsider}],['wrong-creator',{creator:outsider}],
      ['wrong-family',{familyPrincipal:otherFamily.principal,familyRun:otherFamily.run}],
    ]) {
      const bad=await seat(`unused-${variant}`,false,undefined,'standing',options);
      await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${bad.t0}::uuid`;
      const before=await seatState(bad),denied=await renew(bad.raw,id());
      check(`unused-root-${variant}-denied-without-effects`,denied.status===403
        && JSON.stringify(before)===JSON.stringify(await seatState(bad)));
    }
    // Reuse admin-schema-db's installed-table fixture shape, with real parent
    // liveness/scope routines and command auth. Cover both ancestry owners.
    await observer`INSERT INTO swarm.admin_accounts(owner_user_id,stream_id) VALUES(${owner}::uuid,${id()}::uuid) ON CONFLICT DO NOTHING`;
    for(const slot of ['token','principal']) for(const policy of ['live','expired','withdrawn','scope']) {
      const parent=id(),recipient=id();
      await observer`INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,registry_version,
        workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,
        expires_at,refresh_deadline,state,consent_receipt_id,manifest_digest,created_at)
        VALUES(${parent}::uuid,${owner}::uuid,${id()}::uuid,${id()}::uuid,'https://root.example.test','https://api.commonswarm.com/admin',2,
          ARRAY[${W}::uuid],'{"scope_names":[]}'::jsonb,${observer.json({recipient_connection_ids:[recipient]})}::jsonb,
          ARRAY['post_signal'],'member','{}'::jsonb,'{}'::jsonb,clock_timestamp()+interval '1 day',
          clock_timestamp()+interval '2 days','active',${id()}::uuid,${'a'.repeat(64)},clock_timestamp()-interval '1 day')`;
      const fixture=await seat(`unused-parent-${slot}-${policy}`,false,undefined,'standing',
        {...(slot==='token'?{tokenParent:parent}:{principalParent:parent}),recipient});
      await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${fixture.t0}::uuid`;
      if(policy==='expired') await observer`UPDATE swarm.admin_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE grant_id=${parent}::uuid`;
      if(policy==='withdrawn') await observer`UPDATE swarm.admin_grants SET withdrawn_workspace_ids=ARRAY[${W}::uuid] WHERE grant_id=${parent}::uuid`;
      if(policy==='scope') await observer`UPDATE swarm.admin_grants SET worker_scope_ceiling=ARRAY[]::text[] WHERE grant_id=${parent}::uuid`;
      const before=await seatState(fixture),response=await renew(fixture.raw,id());
      check(`unused-root-parent-${slot}-${policy}`,policy==='live'
        ? response.status===200 && credential(response)!==null
        : response.status===403 && JSON.stringify(before)===JSON.stringify(await seatState(fixture)));
    }
    // Session validation owns stamp rollback before issuance, a different
    // contract from the unmanaged and used-token baseline session controls.
    const managed=await seat('unused-managed',false),session=id(),key=mintRaw().slice(8);
    await observer`UPDATE swarm.agent_principals SET managed_at=clock_timestamp() WHERE principal_id=${managed.principal}::uuid`;
    await observer`INSERT INTO swarm.agent_execution_sessions(principal_id,workspace_id,session_id,generation,lifecycle_state,key_hash,started_at,renewed_at,expired_at)
      VALUES(${managed.principal}::uuid,${W}::uuid,${session}::uuid,1,'enabled',${await hashOf(key)},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '2 minutes')`;
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${managed.t0}::uuid`;
    const managedBefore=await seatState(managed);
    for(const [variant,proof] of [['missing',{}],['wrong-key',{'x-cswarm-session-id':session,'x-cswarm-session-generation':'1','x-cswarm-session-key':mintRaw().slice(8)}]]) {
      const response=await renew(managed.raw,id(),{},W,proof);
      check(`unused-root-session-${variant}`,JSON.parse(response.text).error===(variant==='missing'?'session_proof_missing':'session_proof_invalid')
        && JSON.stringify(managedBefore)===JSON.stringify(await seatState(managed)));
    }
    check('unused-root-session-valid',credential(await renew(managed.raw,id(),{},W,{
      'x-cswarm-session-id':session,'x-cswarm-session-generation':'1','x-cswarm-session-key':key}))!==null);
    // Actual closure change while blocked on our sole workspace row.
    const changed=await seat('unused-discovery-changed',false);
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${changed.t0}::uuid`;
    const retriesBefore=discoveryRetries;let changedPending;
    await observer.begin(async tx=>{
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${W}::uuid FOR UPDATE`;
      changedPending=renew(changed.raw,id());
      const waiter=await waitBlockedBy(pid,100);
      check('unused-root discovery change owned workspace wait',waiter>0
        && (await waitDetail(waiter)).statement?.includes('swarm.workspaces'));
      await tx`INSERT INTO swarm.agent_execution_sessions(principal_id,workspace_id,session_id,lifecycle_state)
        VALUES(${changed.principal}::uuid,${W}::uuid,${id()}::uuid,'disabled')`;
    });
    check('unused-root discovery change retries whole transaction',credential(await changedPending)!==null && discoveryRetries>retriesBefore);
    // Real post-discovery membership removal wins before authentication.
    const removed=await seat('unused-removal-wins',false);
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${removed.t0}::uuid`;
    const removedBefore=await seatState(removed);let removedPending;
    try {
      await observer.begin(async tx=>{
        const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${W}::uuid AND user_id=${owner}::uuid FOR UPDATE`;
        removedPending=renew(removed.raw,id());
        const waiter=await waitBlockedBy(pid,100);
        check('unused-root removal owned membership wait',waiter>0
          && (await waitDetail(waiter)).statement?.includes('swarm.memberships'));
        await tx`UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${W}::uuid AND user_id=${owner}::uuid`;
      });
      const response=await removedPending;
      check('unused-root removal wins without effects',response.status===403
        && JSON.stringify(removedBefore)===JSON.stringify(await seatState(removed)));
    } finally {
      if(removedPending) await removedPending;
      await observer`UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=${W}::uuid AND user_id=${owner}::uuid`;
    }
    // Two independent command IDs cannot fork an unused permanent root.
    const concurrent=await seat('unused-concurrent',false);
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${concurrent.t0}::uuid`;

    let firstPending,secondPending;
    await observer.begin(async tx=>{
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      // Sole owned row gate; the second recovery queues on the first's U lock.
      await tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id=${concurrent.grant}::uuid FOR UPDATE`;
      firstPending=renew(concurrent.raw,id());
      const firstPid=await waitBlockedBy(pid,100);
      check('unused-root concurrency owned grant wait',firstPid>0
        && (await waitDetail(firstPid)).statement?.includes('swarm.renewal_grants'));
      secondPending=renew(concurrent.raw,id());
      const secondPid=firstPid ? await waitBlockedBy(firstPid,100):0;
      check('unused-root concurrency distinct PID waits on first recovery',secondPid>0 && secondPid!==firstPid
        && (await waitDetail(secondPid)).statement?.includes('swarm.users'));
    });
    const replies=await Promise.all([firstPending,secondPending]);
    const children=await observer`SELECT token_id FROM swarm.agent_tokens WHERE predecessor_token_id=${concurrent.t0}::uuid AND revoked_at IS NULL`;
    const issued=replies.filter(r=>credential(r)!==null);
    check('unused-root concurrent recovery never forks',children.length===1 && issued.length>=1
      && new Set(issued.map(r=>JSON.parse(r.text).token_id)).size===issued.length);
    const liveReply=issued.find(r=>JSON.parse(r.text).token_id===children[0]?.token_id);
    check('unused-root concurrent live successor authenticates',liveReply!==undefined && (await readAs(credential(liveReply))).status===200);
    check('unused-root concurrent used successor wins',credential(await renew(concurrent.raw,id()))===null);
    // Hold the real adoption UPDATE after it writes but before the final clock.
    // The chosen date crossing this wait must roll back even the use stamp.
    const crossing=await seat('unused-final-clock',false),clockFn=`root_clock_${tag}`;
    const clockKey=Math.floor(Math.random()*1000000000);
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${crossing.t0}::uuid`;
    const crossingBefore=await seatState(crossing);
    await observer.unsafe(`CREATE FUNCTION public.${clockFn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(130014, ${clockKey}); RETURN NEW; END $$`);
    await observer.unsafe(`CREATE TRIGGER ${clockFn} AFTER UPDATE OF first_used_at ON swarm.agent_tokens FOR EACH ROW WHEN (OLD.token_id='${crossing.t0}'::uuid AND OLD.first_used_at IS NULL AND NEW.first_used_at IS NOT NULL) EXECUTE FUNCTION public.${clockFn}()`);
    let crossingPending;
    try {
      await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '3 seconds' WHERE renewal_grant_id=${crossing.grant}::uuid`;
      await observer.begin(async tx=>{
        const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT pg_advisory_xact_lock(130014,${clockKey}::int)`;
        crossingPending=renew(crossing.raw,id());
        check('unused-root final-clock fixture reaches actual adoption wait',await waitBlockedBy(pid,100)>0);
        await sleep(3200);
      });
      const denied=await crossingPending;
      check('unused-root date crossing adoption wait rolls back stamp',denied.status===403
        && JSON.stringify(crossingBefore)===JSON.stringify(await seatState(crossing)));
    } finally {
      if(crossingPending) await crossingPending;
      await observer.unsafe(`DROP TRIGGER ${clockFn} ON swarm.agent_tokens`);
      await observer.unsafe(`DROP FUNCTION public.${clockFn}()`);
    }
    // Fail only issuance after the real recovery-use transaction has committed.
    // A restart/same-ID retry must use that truthful proof, never fake a stamp.
    const interrupted=await seat('unused-issuance-interrupted',false),interruptedId=id(),failFn=`root_issue_${tag}`;
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${interrupted.t0}::uuid`;
    await observer.unsafe(`CREATE FUNCTION public.${failFn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture issuance interrupted' USING ERRCODE='40001'; END $$`);
    await observer.unsafe(`CREATE TRIGGER ${failFn} BEFORE INSERT ON swarm.agent_tokens FOR EACH ROW WHEN (NEW.predecessor_token_id='${interrupted.t0}'::uuid) EXECUTE FUNCTION public.${failFn}()`);
    try {
      const failed=await renew(interrupted.raw,interruptedId),state=await seatState(interrupted);
      check('unused-root issuance failure retains truthful use without child',failed.status>=500
        && state.tokens.length===1 && state.tokens[0].used && state.idempotency.length===0 && state.events.length===0);
    } finally {
      await observer.unsafe(`DROP TRIGGER ${failFn} ON swarm.agent_tokens`);
      await observer.unsafe(`DROP FUNCTION public.${failFn}()`);
    }
    const resumed=await renew(interrupted.raw,interruptedId);
    check('unused-root same ID resumes after committed use',credential(resumed)!==null);
    // Drop the issuance response before any use. Matching-ID recovery replaces
    // the pending child; it must never re-emit the old credential from storage.
    const replaced=await renew(interrupted.raw,interruptedId),replacementRaw=credential(replaced);
    const replacedState=await seatState(interrupted);
    const [ledger]=await observer`SELECT response::text NOT LIKE '%swm_agt_%' AS secret_free
      FROM swarm.idempotency_keys WHERE command_id=${interruptedId} AND principal_kind='agent'`;
    check('unused-root lost reply replaces pending child without secret replay',replacementRaw!==null
      && replacementRaw!==credential(resumed) && replacedState.tokens.length===3
      && replacedState.tokens.filter(t=>!t.revoked).length===2 && ledger?.secret_free===true
      && [401,403].includes((await readAs(credential(resumed))).status));
    check('unused-root resumed successor authenticates',replacementRaw!==null && (await readAs(replacementRaw)).status===200);
    const replay=await renew(interrupted.raw,interruptedId);
    check('unused-root used successor prevents root secret replay',[401,403].includes(replay.status) && credential(replay)===null
      && (await seatState(interrupted)).tokens.length===3);
    // A final effect wait must still defeat the new domain-commit path.
    const late=await seat('refusal-final-wait');
    await renew(late.raw,id()); // establish presence so the final write can wait
    const lateIssue=await renew(late.raw,id()),lateRaw=credential(lateIssue);
    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '3 seconds'
      WHERE renewal_grant_id=${late.grant}::uuid`;
    const lateBefore=await seatState(late);let latePending;
    await observer.begin(async tx=>{
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT principal_id FROM swarm.agent_presence WHERE principal_id=${late.principal}::uuid FOR UPDATE`;
      latePending=renew(lateRaw,id());
      check('decided rejection waits at its real final presence write',await waitBlockedBy(pid,100)>0);
      await sleep(3200);
    });
    check('date crossing during refusal wait overrides decided commit',(await latePending).status===403);
    check('failed final fence rolls back refused-use adoption and ledger',JSON.stringify(lateBefore)===JSON.stringify(await seatState(late)));
    // Activity owns a distinct final wait: the transactional realtime send.
    // The old Source returns 202 and commits adoption/broadcast after this wait.
    await import(`${tree}/supabase/functions/activity/index.ts`);
    const activityHandler=served.at(-1);
    const activity=raw=>activityHandler(new Request('http://127.0.0.1/functions/v1/activity',{
      method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},
      body:JSON.stringify({version:1,workspace_id:W,stream_id:streamId,sequence:1,phase:'idle',
        signal_id:null,tool_title:null,elapsed_ms:0}),
    }));
    const activitySeat=await seat('activity-deadline'),activityIssued=await renew(activitySeat.raw,id()),activityRaw=credential(activityIssued);
    check('activity fixture has a genuine unused successor',activityRaw!==null);
    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '3 seconds'
      WHERE renewal_grant_id=${activitySeat.grant}::uuid`;
    const activityBefore=await seatState(activitySeat);
    const [broadcastBefore]=await observer`SELECT count(*)::int AS n FROM realtime.messages`;
    let activityPending;
    await observer.begin(async tx=>{
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      await tx`LOCK TABLE realtime.messages IN SHARE MODE`;
      activityPending=activity(activityRaw);
      check('actual activity send waited at realtime after adoption',await waitBlockedBy(pid,100)>0);
      await sleep(3200);
    });
    const activityDenied=await activityPending;
    check('activity rejects a chosen deadline elapsed during its final send wait',activityDenied.status===403);
    check('activity denial rolls back token adoption and family use',JSON.stringify(activityBefore)===JSON.stringify(await seatState(activitySeat)));
    const [broadcastAfter]=await observer`SELECT count(*)::int AS n FROM realtime.messages`;
    check('activity denial commits no realtime broadcast',broadcastAfter.n===broadcastBefore.n);
    const activityControl=await seat('activity-positive'),controlIssued=await renew(activityControl.raw,id()),controlRaw=credential(controlIssued);
    const positiveActivity=await activity(controlRaw);
    check('same-invocation activity really publishes',positiveActivity.status===202);
    const [positiveUse]=await observer`SELECT first_used_at IS NOT NULL AS used FROM swarm.agent_tokens
      WHERE token_id=${JSON.parse(controlIssued.text).token_id}::uuid`;
    const [positiveBroadcast]=await observer`SELECT count(*)::int AS n FROM realtime.messages`;
    check('activity positive commits adoption and a realtime row',positiveUse.used && positiveBroadcast.n===broadcastAfter.n+1);
    // Read truth is owned here at real database roles. No stored marker is
    // fabricated to make an elapsed canonical date look persisted.
    // Keep all read-truth fixtures visible below Home's 50-agent bound.
    const readWorkspace=id(),readStream=id();
    await observer.begin(async tx=>{
      await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${readWorkspace}::uuid,'Read truth',${owner}::uuid)`;
      await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${readWorkspace}::uuid,${owner}::uuid,'owner')`;
      await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${readStream}::uuid,${readWorkspace}::uuid,'workspace')`;
    });
    const readSeat=(name,use=true,bound=undefined,kind='standing',options={})=>seat(name,use,bound,kind,{...options,workspace:readWorkspace});
    const readRenew=(raw,commandId,fields={},workspace=readWorkspace)=>renew(raw,commandId,fields,workspace);
    const readModels=await readSeat('read-models');
    const connectionFrom=overview=>overview.workspaces.find(w=>w.workspace_id===readWorkspace)?.people
      .flatMap(person=>person.agents).find(a=>a.principal_id===readModels.principal)?.status.facts.connection;
    const overviewAs=async user=>observer.begin(async tx=>{
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims',${JSON.stringify({sub:user,role:'authenticated'})},true)`;
      const [row]=await tx`SELECT swarm_read.home_overview() AS value`;return row.value;
    });
    check('current local overview positive is live',connectionFrom(await overviewAs(owner))==='live');
    // Reuse the real-schema seat and normal-role readers. No selection/auth mock.
    const rosterAs=async user=>observer.begin(async tx=>{
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims',${JSON.stringify({sub:user,role:'authenticated'})},true)`;
      return await tx`SELECT * FROM swarm_read.renewal_grant_roster(${readWorkspace}::uuid)`;
    });
    const scoped=async token=>observer.begin(async tx=>{
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL ROLE swarm_read`;
      return await tx`SELECT * FROM swarm_read.renewal_grant_for_token(${readWorkspace}::uuid,${token}::uuid)`;
    });
    for(const variant of ['elapsed','dead-run','dead-device','legacy','silent-renewal','both-revoked','none-eligible','newer-eligible','dead-token']) {
      const old=await readSeat(`mixed-${variant}`,true,undefined,variant==='legacy'?'no-family':'standing',{createdAt:new Date(Date.now()-86400000)});
      const newer=await readSeat(`mixed-new-${variant}`,true,undefined,'standing',{principal:old.principal});
      if(variant==='elapsed' || variant==='legacy') await observer`UPDATE swarm.renewal_grants
        SET connection_expires_at=clock_timestamp()-interval '1 second' WHERE renewal_grant_id=${newer.grant}::uuid`;
      if(['dead-run','silent-renewal','none-eligible','dead-token'].includes(variant)) await observer`UPDATE swarm.agent_runs SET ended_at=clock_timestamp() WHERE run_id=${newer.run}::uuid`;
      if(variant==='dead-device') await observer`UPDATE swarm.devices SET revoked_at=clock_timestamp() WHERE device_id=${newer.device}::uuid`;
      if(variant==='legacy' || variant==='none-eligible') await observer`UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp() WHERE renewal_grant_id=${old.grant}::uuid`;
      if(variant==='silent-renewal') await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${old.t0}::uuid`;
      if(variant==='both-revoked') await observer`UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp() WHERE renewal_grant_id IN (${old.grant}::uuid,${newer.grant}::uuid)`;
      if(variant==='dead-token') await observer`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,
        issued_at,expires_at,lineage_id,renewal_grant_id,revoked_at)
        SELECT ${id()}::uuid,principal_id,run_id,task_id,epoch,scopes,${await hashOf(mintRaw())},clock_timestamp()+interval '1 second',
          expires_at,lineage_id,renewal_grant_id,clock_timestamp() FROM swarm.agent_tokens WHERE token_id=${old.t0}::uuid`;
      const chosen=['both-revoked','none-eligible','newer-eligible'].includes(variant)?newer:old;
      const before=await snapshot();
      const home=await overviewAs(owner),roster=await rosterAs(owner);
      const facts=home.workspaces.find(w=>w.workspace_id===readWorkspace)?.people.flatMap(p=>p.agents)
        .find(a=>a.principal_id===old.principal)?.status.facts;
      const row=roster.find(r=>r.principal_id===old.principal);
      check(`mixed-${variant}-selected`,facts?.connection===(variant==='both-revoked'?'key_off':variant==='none-eligible'?'key_ended':'live')
        && facts?.token_id===chosen.t0 && facts?.renewal_grant_id===(variant==='legacy'?null:chosen.grant)
        && (variant==='legacy' ? !row && !Object.hasOwn(facts,'connection_expires_at') && !Object.hasOwn(facts,'connection_expired_at')
          : row?.renewal_grant_id===chosen.grant && row?.token_id===chosen.t0));
      const tokenRows=await scoped(newer.t0);
      check(`mixed-${variant}-scoped`,tokenRows[0]?.renewal_grant_id===newer.grant
        && (variant!=='elapsed' && variant!=='legacy' || tokenRows[0]?.connection_expired_at!==null));
      check(`mixed-${variant}-no-write`,JSON.stringify(before)===JSON.stringify(await snapshot()));
      const control=await readAs(old.raw,readWorkspace);
      check(`mixed-${variant}-bearer`,['silent-renewal','both-revoked','none-eligible'].includes(variant)
        ? control.status===401 || control.status===403 : control.status===200);
      if(variant==='silent-renewal') check('mixed-silent-renewal-real-renew',credential(await readRenew(old.raw,id()))!==null);
      if(['elapsed','dead-run','dead-device','legacy','silent-renewal','both-revoked','none-eligible','dead-token'].includes(variant))
        check(`mixed-${variant}-dead-bearer`,[401,403].includes((await readAs(newer.raw,readWorkspace)).status));
    }
    check('mixed-outsider-roster-empty',(await rosterAs(outsider)).length===0);
    const member=id();
    await observer`INSERT INTO auth.users(id,aud,role,email) VALUES(${member}::uuid,'authenticated','authenticated',${member+'@example.test'})`;
    await observer`INSERT INTO swarm.users(user_id,display_name) VALUES(${member}::uuid,'Mixed member')`;
    await observer`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${readWorkspace}::uuid,${member}::uuid,'member')`;
    const memberRows=await rosterAs(member);
    check('mixed-member-roster-visible',memberRows.some(r=>r.renewal_grant_id===readModels.grant));
    await observer`UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${readWorkspace}::uuid AND user_id=${member}::uuid`;
    check('mixed-revoked-member-roster-empty',(await rosterAs(member)).length===0);
    const [privateAcl]=await observer`SELECT pg_get_userbyid(proowner)='swarm_admin' AND NOT prosecdef
      AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE')
      AND NOT has_function_privilege('swarm_read',oid,'EXECUTE') AND NOT has_function_privilege('swarm_command',oid,'EXECUTE') AS ok
      FROM pg_proc WHERE oid='swarm_read.local_connection_selection(uuid,uuid,uuid)'::regprocedure`;
    check('mixed-selector-private-invoker',privateAcl.ok);

    // The same observable connection contract at both public read boundaries.
    // The regression is an expired virgin permanent root falsely shown dead.
    // Pair the live rows with one-gate denials at both installed read owners;
    // standing grants' NULL horizon/max are also enforced by the real schema.
    await observer`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose)
      VALUES(${readWorkspace}::uuid,'shared') ON CONFLICT DO NOTHING`;
    const queueFor=async (principal,workspace=readWorkspace)=>{
      const result=await command.handleHostedManagementCommand({command_id:id(),client_version:CLIENT_PROTOCOL_VERSION,
        workspace_id:workspace,stream:{kind:'workspace'},command:{kind:'household_tool',tool:'todo_queue',
          arguments:{seat:HOUSEHOLD_LOCAL_SEAT,principal_id:principal}}},
        {userId:owner,email,displayName:'Read truth owner',identityVerified:true,interactiveAuthAtSeconds:null});
      if(result.status!==200 || !result.body.queue?.status?.facts) throw Object.assign(new Error('queue boundary'),{code:'QUEUE_READ_CONTROL'});
      return result.body.queue.status.facts.connection;
    };
    const wrongDevice=id();
    await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${wrongDevice}::uuid,${owner}::uuid,'Mismatched read fixture')`;
    for(const variant of ['live-bootstrap','expired-unused','expired-used','pending','retired-history','predecessor-tombstone','elapsed','revoked','mismatched-device','unused-unbound','unused-future-bound','unused-future-unbound','unused-terminal','unused-elapsed','unused-timeboxed','unused-no-family','unused-wrong-creator','unused-foreign-device','unused-wrong-family','unused-token-tombstone','unused-family-tombstone']) {
      const unused=variant.startsWith('unused-') || ['live-bootstrap','expired-unused','mismatched-device'].includes(variant);
      const unbound=['unused-unbound','unused-future-unbound'].includes(variant);
      const fixture=await readSeat(`truth-${variant}`,!unused,
        variant==='mismatched-device' ? wrongDevice:unbound ? null:undefined,
        variant==='unused-timeboxed' ? 'timeboxed':variant==='unused-no-family' ? 'no-family':'standing',
        variant==='unused-wrong-creator' ? {creator:outsider}:variant==='unused-foreign-device' ? {deviceOwner:outsider}:
          variant==='unused-wrong-family' ? {familyPrincipal:otherFamily.principal,familyRun:otherFamily.run}:{});
      const [binding]=await observer`SELECT bound_device_id FROM swarm.renewal_grants WHERE renewal_grant_id=${fixture.grant}::uuid`;
      check(`current-proof-${variant}-binding`,binding.bound_device_id===(variant==='mismatched-device'?wrongDevice:unbound ? null:fixture.device));
      let child;
      if(['pending','retired-history','predecessor-tombstone'].includes(variant)) {
        const issued=await readRenew(fixture.raw,id());child=JSON.parse(issued.text);
        if(issued.status!==200 || !child.agent_token) throw Object.assign(new Error('truth successor'),{code:'TRUTH_SUCCESSOR'});
        if(variant==='retired-history') {
          if((await readAs(child.agent_token,readWorkspace)).status!==200) throw Object.assign(new Error('truth use'),{code:'TRUTH_USE'});
          await observer`UPDATE swarm.agent_tokens SET surrender_only=true WHERE token_id=${child.token_id}::uuid`;
        }
        if(variant==='predecessor-tombstone') await observer`INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
          VALUES('token',${fixture.t0}::uuid,${owner}::uuid)`;
      }
      if(variant!=='live-bootstrap') await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second'
        WHERE renewal_grant_id=${fixture.grant}::uuid OR token_id=${fixture.t0}::uuid`;
      if(variant==='elapsed') await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
        WHERE renewal_grant_id=${fixture.grant}::uuid`;
      if(variant==='revoked') await observer`UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp() WHERE renewal_grant_id=${fixture.grant}::uuid`;
      if(['unused-future-bound','unused-future-unbound'].includes(variant)) await observer`UPDATE swarm.renewal_grants
        SET connection_expires_at=clock_timestamp()+interval '1 day' WHERE renewal_grant_id=${fixture.grant}::uuid`;
      if(variant==='unused-terminal') await observer`UPDATE swarm.renewal_grants SET connection_expired_at=clock_timestamp()
        WHERE renewal_grant_id=${fixture.grant}::uuid`;
      if(variant==='unused-elapsed') await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
        WHERE renewal_grant_id=${fixture.grant}::uuid`;
      if(['unused-token-tombstone','unused-family-tombstone'].includes(variant)) await observer`INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
        SELECT ${variant==='unused-token-tombstone'?'token':'family'},
          CASE WHEN ${variant==='unused-token-tombstone'} THEN token_id ELSE lineage_id END,${owner}::uuid
        FROM swarm.agent_tokens WHERE token_id=${fixture.t0}::uuid`;
      const [beforeRead]=await observer`SELECT first_used_at,predecessor_token_id,expires_at>clock_timestamp() AS unexpired
        FROM swarm.agent_tokens WHERE token_id=${fixture.t0}::uuid`;
      const expected=['live-bootstrap','expired-unused','expired-used','pending','unused-unbound','unused-future-bound','unused-future-unbound'].includes(variant);
      const overview=await overviewAs(owner);
      const home=overview.workspaces.find(w=>w.workspace_id===readWorkspace)?.people.flatMap(person=>person.agents)
        .find(agent=>agent.principal_id===fixture.principal)?.status.facts.connection;
      const queue=await queueFor(fixture.principal);
      if(unused && variant!=='live-bootstrap') {
        const [afterRead]=await observer`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id=${fixture.t0}::uuid`;
        check(`current-proof-${variant}-virgin`,beforeRead.first_used_at===null && beforeRead.predecessor_token_id===null
          && !beforeRead.unexpired && afterRead.first_used_at===null);
      }
      check(`current-proof-${variant}-home-and-queue`,home!==undefined && queue!==undefined && (home==='live')===expected && (queue==='live')===expected);
    }

    // SQL fixture provenance permits the real owner-only conversion trigger.
    // Minting is outside this read-model contract; conversion, first-use and
    // overview results are produced by the actual database/runtime boundaries.
    const convertedWorkspace=id(),convertedStream=id(),convertedPrincipal=id(),convertedDevice=id(),
      convertedRun=id(),convertedGrant=id(),convertedToken=id(),convertedTask=id(),convertedLineage=id();
    const convertedRaw=mintRaw(),convertedHash=await hashOf(convertedRaw);
    await observer.begin(async tx=>{
      await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by)
        VALUES(${convertedWorkspace}::uuid,'Converted read model',${owner}::uuid)`;
      await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role)
        VALUES(${convertedWorkspace}::uuid,${owner}::uuid,'owner')`;
      await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind)
        VALUES(${convertedStream}::uuid,${convertedWorkspace}::uuid,'workspace')`;
      await tx`INSERT INTO swarm.devices(device_id,user_id,label)
        VALUES(${convertedDevice}::uuid,${owner}::uuid,'Converted device')`;
      await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name)
        VALUES(${convertedPrincipal}::uuid,${convertedWorkspace}::uuid,${owner}::uuid,'Converted CLI')`;
      await tx`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id)
        VALUES(${convertedRun}::uuid,${convertedPrincipal}::uuid,${convertedDevice}::uuid)`;
      await tx`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,
        kind,max_successors,successors_used,horizon_expires_at,bound_device_id,created_by)
        VALUES(${convertedGrant}::uuid,${convertedWorkspace}::uuid,${convertedPrincipal}::uuid,${convertedRun}::uuid,
          'timeboxed',100,0,clock_timestamp()+interval '1 day',NULL,${owner}::uuid)`;
      await tx`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,
        expires_at,lineage_id,renewal_grant_id)
        VALUES(${convertedToken}::uuid,${convertedPrincipal}::uuid,${convertedRun}::uuid,${convertedTask}::uuid,1,
          ${tx.json(['post_signal'])}::jsonb,${convertedHash},clock_timestamp()+interval '1 hour',
          ${convertedLineage}::uuid,${convertedGrant}::uuid)`;
      await tx`INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,payload)
        VALUES(${convertedWorkspace}::uuid,${convertedStream}::uuid,1,${id()}::uuid,${id()},'AgentTokenMinted',1,
          ${owner}::uuid,${tx.json({token_id:convertedToken})}::jsonb)`;
      await tx`SET LOCAL ROLE swarm_admin`;
      await tx`UPDATE swarm.renewal_grants SET kind='standing',max_successors=NULL,horizon_expires_at=NULL
        WHERE renewal_grant_id=${convertedGrant}::uuid`;
    });
    const convertedRead=()=>read.handleRequest(new Request('http://127.0.0.1/functions/v1/read',{
      method:'POST',headers:{authorization:`Bearer ${convertedRaw}`,'content-type':'application/json'},
      body:JSON.stringify({resource:'members',workspace_id:convertedWorkspace})}));
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second'
      WHERE token_id=${convertedToken}::uuid`;
    const [virginConverted]=await observer`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id=${convertedToken}::uuid`;
    check('converted unused root starts without fabricated use',virginConverted.first_used_at===null);
    check('converted unused root ordinary expired read denies',[401,403].includes((await convertedRead()).status));
    await observer`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose)
      VALUES(${convertedWorkspace}::uuid,'shared')`;
    const convertedVirginStatus=async()=>{
      const overview=await overviewAs(owner);
      return overview.workspaces.find(w=>w.workspace_id===convertedWorkspace)?.people.flatMap(person=>person.agents)
        .find(agent=>agent.principal_id===convertedPrincipal)?.status;
    };
    for(const future of [false,true]) {
      if(future) await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '1 day'
        WHERE renewal_grant_id=${convertedGrant}::uuid`;
      const home=await convertedVirginStatus(),queue=await queueFor(convertedPrincipal,convertedWorkspace);
      check(`converted unused ${future?'future-date':'permanent'} home-and-queue live`,home?.facts.connection==='live'
        && home.work==='idle' && queue==='live');
    }
    const [stillVirgin]=await observer`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id=${convertedToken}::uuid`;
    check('converted read projections do not authorize or stamp bearer',stillVirgin.first_used_at===null
      && [401,403].includes((await convertedRead()).status));
    const convertedRecovery=await readRenew(convertedRaw,id(),{},convertedWorkspace);
    check('converted unused permanent NULL-bound root renews',credential(convertedRecovery)!==null);
    check('converted successor authenticates at real read boundary',credential(convertedRecovery)!==null && (await capture(await read.handleRequest(new Request('http://127.0.0.1/functions/v1/read',{
      method:'POST',headers:{authorization:`Bearer ${credential(convertedRecovery)}`,'content-type':'application/json'},
      body:JSON.stringify({resource:'members',workspace_id:convertedWorkspace})})))).status===200);
    const [convertedUse]=await observer`SELECT t.first_used_at,g.kind,g.bound_device_id
      FROM swarm.agent_tokens t JOIN swarm.renewal_grants g USING(renewal_grant_id)
      WHERE t.token_id=${convertedToken}::uuid`;
    check('real conversion retained NULL binding and runtime committed use',convertedUse.kind==='standing'
      && convertedUse.bound_device_id===null && convertedUse.first_used_at!==null);
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second'
      WHERE token_id=${convertedToken}::uuid`;
    const convertedStatus=async()=>{
      const overview=await overviewAs(owner);
      return overview.workspaces.find(w=>w.workspace_id===convertedWorkspace)?.people.flatMap(person=>person.agents)
        .find(agent=>agent.principal_id===convertedPrincipal)?.status;
    };
    check('idle converted USED family remains live with NULL binding',(await convertedStatus())?.facts.connection==='live'
      && (await convertedStatus())?.work==='idle');
    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
      WHERE renewal_grant_id=${convertedGrant}::uuid`;
    check('converted elapsed date is terminal despite NULL binding',(await convertedStatus())?.facts.connection==='key_ended');
    check('converted elapsed family is denied by runtime',(await convertedRead()).status===403);
    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=NULL,revoked_at=clock_timestamp()
      WHERE renewal_grant_id=${convertedGrant}::uuid`;
    check('converted revoked family never appears live',(await convertedStatus())?.facts.connection!=='live');
    check('converted revoked family is denied by runtime',(await convertedRead()).status===403);
    // Independent non-NULL binding control: the expired bearer cannot mask it.
    const mismatch=await readSeat('read-model-binding',false);
    const otherDevice=id();
    await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${otherDevice}::uuid,${owner}::uuid,'Other binding')`;
    await observer`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,
      kind,max_successors,successors_used,horizon_expires_at,bound_device_id,created_by)
      VALUES(${id()}::uuid,${readWorkspace}::uuid,${mismatch.principal}::uuid,${mismatch.run}::uuid,'standing',NULL,0,NULL,
        ${otherDevice}::uuid,${owner}::uuid)`;
    await observer`UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp() WHERE renewal_grant_id=${mismatch.grant}::uuid`;
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${mismatch.t0}::uuid`;
    const mismatchOverview=await overviewAs(owner);
    const mismatchConnection=mismatchOverview.workspaces.find(w=>w.workspace_id===readWorkspace)?.people.flatMap(person=>person.agents)
      .find(agent=>agent.principal_id===mismatch.principal)?.status.facts.connection;
    check('non-NULL mismatched device cannot claim renewal liveness',mismatchConnection!=='live');

    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '1 day',suspended_at=clock_timestamp()
      WHERE renewal_grant_id=${readModels.grant}::uuid`;
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${readModels.t0}::uuid`;
    check('future dated family with idle history stays live through renewal liveness',connectionFrom(await overviewAs(owner))==='live');
    check('live bearer control exists before terminal precedence',credential(await readRenew(readModels.raw,id()))!==null);
    const [deadline]=await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
      WHERE renewal_grant_id=${readModels.grant}::uuid RETURNING connection_expires_at`;
    check('elapsed canonical policy wins over renewal liveness in overview',connectionFrom(await overviewAs(owner))==='key_ended');
    const renewalRows=await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims',${JSON.stringify({sub:owner,role:'authenticated'})},true)`;
      return await tx`SELECT * FROM swarm_read.renewal_grant_roster(${readWorkspace}::uuid)`;
    });
    const tokenRows=await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_read`;
      return await tx`SELECT * FROM swarm_read.renewal_grant_for_token(${readWorkspace}::uuid,${readModels.t0}::uuid)`;
    });
    const rosterRow=renewalRows.find(r=>r.renewal_grant_id===readModels.grant);
    check('both renewal readers derive the elapsed terminal timestamp',iso(rosterRow?.connection_expired_at)===iso(deadline.connection_expires_at)
      && iso(tokenRows[0]?.connection_expired_at)===iso(deadline.connection_expires_at));
    const [stored]=await observer`SELECT connection_expired_at FROM swarm.renewal_grants WHERE renewal_grant_id=${readModels.grant}::uuid`;
    check('read truth does not invent a persisted terminal write',stored.connection_expired_at===null);
    await observer`UPDATE swarm.renewal_grants SET connection_expired_at=${deadline.connection_expires_at},connection_expires_at=NULL
      WHERE renewal_grant_id=${readModels.grant}::uuid`;
    check('stored terminal marker wins even with null chosen date',connectionFrom(await overviewAs(owner))==='key_ended');
    const hosted=id(),hostedDeadline=new Date(Date.now()-1000);
    await observer`INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,
      selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at,connection_expires_at)
      VALUES(${hosted}::uuid,${'probe-'+hosted},${owner}::uuid,${readWorkspace}::uuid,'probe-client','https://mcp.commonswarm.com/mcp',
        ${[readWorkspace]}::uuid[],${new Uint8Array(32).fill(7)},'probe-consent','active',clock_timestamp(),clock_timestamp(),${hostedDeadline})`;
    const hostedPrincipal=id(),hostedSeat=id(),hostedDigest=new Uint8Array(32).fill(7);
    await observer`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
      VALUES(${hostedPrincipal}::uuid,${readWorkspace}::uuid,${owner}::uuid,'probe-hosted','hosted_mcp',true)`;
    await observer`INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES(${hosted}::uuid,${readWorkspace}::uuid,${owner}::uuid,${hostedDigest},${id()}::uuid,clock_timestamp())`;
    await observer`INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES(${hostedSeat}::uuid,${hosted}::uuid,${readWorkspace}::uuid,${owner}::uuid,${hostedPrincipal}::uuid,'probe-hosted',clock_timestamp())`;
    const hostedOverview=await overviewAs(owner);
    const hostedConnection=hostedOverview.workspaces.find(w=>w.workspace_id===readWorkspace).people.flatMap(p=>p.agents)
      .find(a=>a.principal_id===hostedPrincipal)?.status.facts.connection;
    check('hosted elapsed policy precedes otherwise active seat liveness',hostedConnection==='connection_off');
    const hostedAs=async user=>observer.begin(async tx=>{
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims',${JSON.stringify({sub:user,role:'authenticated'})},true)`;
      return await tx`SELECT grant_id,client_id,resource,home_workspace_id,selected_workspace_ids,state,created_at,activated_at,revoked_at,
        connection_expires_at,connection_expired_at FROM swarm_read.hosted_mcp_connections WHERE grant_id=${hosted}::uuid`;
    });
    const hostedRows=await hostedAs(owner);
    check('hosted owner view exposes canonical policy and derived terminal',hostedRows.length===1
      && iso(hostedRows[0].connection_expires_at)===hostedDeadline.toISOString() && iso(hostedRows[0].connection_expired_at)===hostedDeadline.toISOString());
    check('hosted view still filters another owner',(await hostedAs(id())).length===0);
    const oldReader=await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims',${JSON.stringify({sub:owner,role:'authenticated'})},true)`;
      return await tx`SELECT grant_id,client_id,resource,home_workspace_id,selected_workspace_ids,state,created_at,activated_at,revoked_at
        FROM swarm_read.hosted_mcp_connections WHERE grant_id=${hosted}::uuid`;
    });
    check('old hosted reader still selects its original nine columns',oldReader.length===1 && Object.keys(oldReader[0]).length===9);
    const [acl]=await observer`SELECT pg_get_userbyid(c.relowner)='swarm_admin' AS owner_ok,
      'security_barrier=true'=ANY(c.reloptions) AS barrier_ok,
      has_table_privilege('authenticated',c.oid,'SELECT') AND has_table_privilege('swarm_read',c.oid,'SELECT')
        AND NOT has_table_privilege('anon',c.oid,'SELECT') AS select_ok,
      has_function_privilege('authenticated','swarm_read.home_overview()','EXECUTE')
        AND NOT has_function_privilege('swarm_read','swarm_read.home_overview()','EXECUTE')
        AND NOT has_function_privilege('swarm_command','swarm_read.home_overview()','EXECUTE')
        AND NOT has_function_privilege('anon','swarm_read.home_overview()','EXECUTE') AS execute_ok
      FROM pg_class c WHERE c.oid='swarm_read.hosted_mcp_connections'::regclass`;
    check('read-model owners, barrier and role ACL boundary survive',acl.owner_ok && acl.barrier_ok && acl.select_ok && acl.execute_ok);
    // Exact family consumer: real command-role loader + production access
    // consumer. Fixture setup writes consent; the consumer never backfills it.
    const authModule=await import(`${tree}/supabase/functions/_shared/agent-auth.ts`);
    const accessModule=await import(`${tree}/supabase/functions/command/household-content-access.ts`);
    const family=await seat('family-approval');
    const consent=id();
    await observer.begin(async tx=>{
      await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES(${W}::uuid,'shared')`;
      await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
        VALUES(${W}::uuid,${owner}::uuid,'editor',${consent}::uuid,clock_timestamp())`;
      await tx`SET LOCAL ROLE swarm_command`;
      const plan=await authModule.planLocalConnection(tx,W,owner,family.principal,family.t0);
      if(!plan) throw Object.assign(new Error('fixture local plan'),{code:'FIXTURE_LOCAL_PLAN'});
      await authModule.lockLocalAuthPlan(tx,plan);
      await tx`SELECT set_config('cswarm.household_actor',${owner},true),set_config('cswarm.household_request',${id()},true),
        set_config('cswarm.household_digest',${'c'.repeat(64)},true),set_config('cswarm.household_command','household_approve_connection',true)`;
      await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,
        purpose,operations,consent_receipt_id,renewal_grant_id)
        VALUES(${family.t0}::uuid,${family.run}::uuid,${W}::uuid,${family.principal}::uuid,${owner}::uuid,
          'shared',ARRAY['read'],${consent}::uuid,${family.grant}::uuid)`;
    });
    const approvalBefore=await observer`SELECT to_jsonb(c) AS row FROM swarm.household_content_connections c WHERE connection_id=${family.t0}::uuid`;
    const rotated=await renew(family.raw,id()),rotatedSecret=credential(rotated);
    const accessAs=async raw=>observer.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      const hash=await hashOf(raw),plan=await authModule.planLocalOperation(tx,{hash,household:true});
      if(!plan) return null;
      await authModule.lockLocalAuthPlan(tx,plan);
      const agent=await authModule.loadAgentCredential(tx,hash,plan);
      if(!agent) return null;
      return accessModule.loadHouseholdContentAccess(tx,W,{user_id:agent.owner_user_id,principal_id:agent.principal_id,
        run_id:agent.run_id,connection:{connection_id:agent.token_id,grant_id:agent.run_id}});
    });
    const inherited=rotatedSecret ? await accessAs(rotatedSecret) : null;
    check('rotated successor consumes exact original family approval',inherited?.facts?.credential?.connection?.connection_id===JSON.parse(rotated.text).token_id);
    check('manual operation ceiling survives rotation',JSON.stringify(inherited?.facts?.credential?.connection?.operations)===JSON.stringify(['read']));
    const approvalAfter=await observer`SELECT to_jsonb(c) AS row FROM swarm.household_content_connections c WHERE connection_id=${family.t0}::uuid`;
    check('family consumer does not rewrite original consent or receipt',JSON.stringify(approvalBefore)===JSON.stringify(approvalAfter));
    const unrelated=await seat('unrelated-family');
    check('another family cannot inherit the approval',await accessAs(unrelated.raw)===null);
    await observer.begin(async tx=>{
      await tx`SELECT set_config('cswarm.household_actor',${owner},true),set_config('cswarm.household_request',${id()},true),
        set_config('cswarm.household_digest',${'d'.repeat(64)},true),set_config('cswarm.household_command','household_withdraw_connection',true)`;
      await tx`UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp() WHERE connection_id=${family.t0}::uuid`;
    });
    check('original withdrawal stops the rotated successor',rotatedSecret!==null && await accessAs(rotatedSecret)===null);
    check('no external authentication or HTTP mocks',httpRefused===0);
    out.checks=checks;out.verdict=checks.every(c=>c.ok)?'PASS':'FAIL';out.stage='complete';out.http_refused=httpRefused;
    await observer.end();
    console.log('R13_PROBE '+JSON.stringify(out));
    Deno.exit(out.verdict==='PASS'?0:1);
  }
  if (mode === 'main' || mode === 'real_read') {
    out.stage = 'control';
    {
      const s = await seat('control');
      const before = await snapshot(); const state0 = await seatState(s);
      const r = await renew(s.raw, id());
      nameSuccessor(s, r, 'S1');
      const after = await snapshot();
      const res = { response: shape(r), state_before: state0, state_after: await seatState(s), rows: diff(before, after) };
      const use = await readAs(credential(r));
      res.successor_first_use = { read: shape(use), state_after: await seatState(s) };
      out.results.control = res;
    }
    out.stage = 'recovery_control';
    {
      const s = await seat('recovery-control');
      const C = id();
      const lost = await renew(s.raw, C);           // the response is "lost": its credential is never used
      nameSuccessor(s, lost, 'S1');
      const before = await snapshot(); const state0 = await seatState(s);
      const r = await renew(s.raw, C);
      nameSuccessor(s, r, 'S2');
      const after = await snapshot();
      const res = { first_response: shape(lost), response: shape(r), state_before: state0, state_after: await seatState(s), rows: diff(before, after) };
      const use = await readAs(credential(r));
      res.successor_first_use = { read: shape(use), state_after: await seatState(s) };
      out.results.recovery_control = res;
    }
    out.stage = 'last_write';
    {
      const s = await seat('last-write');
      // The presence row must exist for its upsert to wait on a row lock (index.ts:2851 ON CONFLICT DO UPDATE).
      await observer`INSERT INTO swarm.agent_presence (workspace_id, principal_id, last_command_at) VALUES (${W}::uuid, ${s.principal}::uuid, statement_timestamp() - interval '1 hour')`;
      out.results.last_write = await faultRace(s, 'last_write', s.raw, id(),
        (tx) => tx`SELECT principal_id FROM swarm.agent_presence WHERE workspace_id = ${W}::uuid AND principal_id = ${s.principal}::uuid FOR UPDATE`,
        (tx) => tx`SELECT stream_id FROM swarm.streams WHERE stream_id = ${streamId}::uuid FOR UPDATE`);
    }
    out.stage = 'first_lock';
    {
      const s = await seat('first-lock');
      out.results.first_lock = await faultRace(s, 'first_lock', s.raw, id(),
        (tx) => tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id = ${s.grant}::uuid FOR UPDATE`,
        (tx) => tx`SELECT stream_id FROM swarm.streams WHERE stream_id = ${streamId}::uuid FOR UPDATE`);
    }
    out.stage = 'fence_insert';
    {
      const s = await seat('fence-insert');
      out.results.fence_insert = await faultRace(s, 'fence_insert', s.raw, id(),
        (tx) => tx`SELECT token_id FROM swarm.agent_tokens WHERE token_id = ${s.t0}::uuid FOR NO KEY UPDATE`,
        (tx) => tx`SELECT stream_id FROM swarm.streams WHERE stream_id = ${streamId}::uuid FOR UPDATE`);
    }
    // Ruling 38: the synthetic reader and all four sibling pairs must lose the
    // WHOLE renewal, then recover using the identical command_id. These are
    // exact-lock synthetic contenders, not measurements of real sibling edges.
    for (const [label, target] of [
      ['cycle_synthetic', 'grant'], ['sibling_stream', 'stream'],
      ['sibling_h0_poll', 'principal'], ['sibling_sl_inbox', 'principal'],
      ['sibling_renewal', 'stream'],
    ]) {
      out.stage = label;
      const s = await seat(label), C = id();
      const lost = await renew(s.raw, C);
      nameSuccessor(s, lost, 'S1');
      const s1 = JSON.parse(lost.text).token_id;
      const second = target === 'grant'
        ? (tx) => tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id = ${s.grant}::uuid FOR NO KEY UPDATE`
        : target === 'stream'
        ? (tx) => tx`SELECT stream_id FROM swarm.streams WHERE stream_id = ${streamId}::uuid FOR UPDATE`
        : (tx) => tx`SELECT principal_id FROM swarm.agent_principals WHERE principal_id = ${s.principal}::uuid FOR NO KEY UPDATE`;
      const res = await faultRace(s, label, s.raw, C,
        (tx) => tx`SELECT token_id FROM swarm.agent_tokens WHERE token_id = ${s1}::uuid FOR NO KEY UPDATE`, second);
      res.first_response = shape(lost);
      out.results[label] = res;
    }
    out.stage = 'revocation';
    {
      const s = await seat('revocation'), C = id();
      const lost = await renew(s.raw, C);
      nameSuccessor(s, lost, 'S1');
      const s1 = JSON.parse(lost.text).token_id;
      // Force the documented renewal loss; the contender rolls back. Then
      // commit a real grant revocation (including its cascade) before retrying.
      // This proves retry's refusal contract, not the frequency/order of a live revoker.
      const before = await snapshot(), state0 = await seatState(s), code0 = commandCodes.length;
      const c = contender(
        (tx) => tx`SELECT token_id FROM swarm.agent_tokens WHERE token_id = ${s1}::uuid FOR NO KEY UPDATE`,
        (tx) => tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id = ${s.grant}::uuid FOR NO KEY UPDATE`);
      await c.isReady;
      const rp = renew(s.raw, C), pid = await waitBlockedBy(c.pid());
      const parked = pid ? await waitDetail(pid) : null;
      c.release();
      const response = await rp; await c.done;
      const after = await snapshot();
      const res = { response: shape(response), command_sqlstates: commandCodes.slice(code0),
        renewal_wait: parked, rows: diff(before, after), state_before: state0, state_after: await seatState(s) };
      await observer`UPDATE swarm.renewal_grants SET revoked_at = statement_timestamp(), revoked_by = ${owner}::uuid WHERE renewal_grant_id = ${s.grant}::uuid`;
      res.retry_same_command_id = { response: shape(await renew(s.raw, C)), state_after: await seatState(s) };
      out.results.revocation = res;
    }
    out.stage = 'serialization';
    {
      const s = await seat('serialization'), C = id();
      const lost = await renew(s.raw, C);
      nameSuccessor(s, lost, 'S1');
      const s1 = JSON.parse(lost.text).token_id;
      const fn = `r13_serialization_${tag}`;
      await observer.unsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture conflict' USING ERRCODE='40001'; END $$`);
      await observer.unsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE OF revoked_at ON swarm.agent_tokens FOR EACH ROW WHEN (OLD.token_id = '${s1}'::uuid) EXECUTE FUNCTION public.${fn}()`);
      try {
        const before = await snapshot(), state0 = await seatState(s), code0 = commandCodes.length;
        const response = await renew(s.raw, C), after = await snapshot();
        out.results.serialization = { response: shape(response), command_sqlstates: commandCodes.slice(code0), rows: diff(before, after), state_before: state0, state_after: await seatState(s) };
      } finally {
        await observer.unsafe(`DROP TRIGGER ${fn} ON swarm.agent_tokens`);
        await observer.unsafe(`DROP FUNCTION public.${fn}()`);
      }
      const retry = await renew(s.raw, C);
      out.results.serialization.retry_same_command_id = { response: shape(retry) };
      out.results.serialization.retry_successor_first_use = { read: shape(await readAs(credential(retry))) };
    }
  }
  if (mode === 'real_read') {
    out.stage='real_read';
    const s=await seat('real-read'),C=id();
    const lost=await renew(s.raw,C),rawS1=credential(lost);
    nameSuccessor(s,lost,'S1');
    const gateKey=Math.floor(Math.random()*1000000000)+1;
    const gate=postgres(DB,{prepare:false,max:1,onnotice:()=>{}}),fn=`r13_read_gate_${tag}`;
    await gate`SELECT pg_advisory_lock(130013,${gateKey}::int)`;
    const [{pid:gatePid}]=await gate`SELECT pg_backend_pid() AS pid`;
    await observer.unsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(130013, ${gateKey}); RETURN NEW; END $$`);
    await observer.unsafe(`CREATE TRIGGER ${fn} AFTER UPDATE OF last_used_at ON swarm.renewal_grants FOR EACH ROW WHEN (NEW.renewal_grant_id = '${s.grant}'::uuid) EXECUTE FUNCTION public.${fn}()`);
    const before=await snapshot(),state0=await seatState(s),code0=commandCodes.length;
    let reader,renewal;
    try {
      // The real reader owns W/P/G/T and has stamped S1. Park it before
      // commit using fixture-only DDL; the real renewal must wait before T.
      reader=readAs(rawS1);
      const readPid=await waitBlockedBy(gatePid);
      if(!readPid) throw Object.assign(new Error('reader not parked'),{code:'READ_NOT_PARKED'});
      renewal=renew(s.raw,C);
      const renewalPid=await waitBlockedBy(readPid);
      const observed=renewalPid ? await observer`SELECT ${readPid}::int=ANY(pg_blocking_pids(${renewalPid}::int)) AS waits,
        EXISTS(SELECT 1 FROM pg_locks WHERE pid=${renewalPid}::int AND locktype='tuple' AND granted
          AND relation='swarm.agent_tokens'::regclass) AS token_before_workspace` : [];
      await gate`SELECT pg_advisory_unlock(130013,${gateKey}::int)`;
      const readResponse=await reader,response=await renewal,after=await snapshot();
      out.results.real_read={read_waited_on_fixture:readPid>0,renewal_waited_on_reader:renewalPid>0 && observed[0]?.waits===true,
        token_before_workspace:observed[0]?.token_before_workspace??null,command_sqlstates:commandCodes.slice(code0),
        read_response:shape(readResponse),response:shape(response),state_before:state0,state_after:await seatState(s),rows:diff(before,after),
        successor_still_works:shape(await readAs(rawS1)),retry_predecessor:shape(await renew(s.raw,C))};
    } finally {
      await gate`SELECT pg_advisory_unlock(130013,${gateKey}::int)`;
      if(reader) await reader;if(renewal) await renewal;
      await gate.end();
      await observer.unsafe(`DROP TRIGGER ${fn} ON swarm.renewal_grants`);
      await observer.unsafe(`DROP FUNCTION public.${fn}()`);
    }
  }
  // Owner-boundary regression assertions. The old catch fails these because it
  // commits a refusal, its audit/events/ledger/stream writes, and loses recovery.
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const accepted = (r) => r.status === 200 && r.body?.status === 'accepted';
  const diagnosticOnly = (rows) => same(rows, { counts: { 'swarm.command_failures': 1 }, content_changed: ['swarm.command_failures'] });
  const seatUnchanged = (a, b) => ['tokens', 'grant', 'audit', 'idempotency', 'tombstones', 'stream_head_seq', 'events', 'presence_rows'].every((k) => same(a[k], b[k]));
  const newFailure = (a, b, code) => same(b.command_failures_renew.slice(a.command_failures_renew.length), [code === '40P01' ? 'lock_timeout/40P01' : 'internal_error/40001']);
  check('all enumerated tables include every renewal write', tables.length > 0 &&
    ['swarm.agent_tokens', 'swarm.renewal_grants', 'swarm.events', 'swarm.streams', 'swarm.idempotency_keys', 'swarm.audit_log', 'swarm.agent_presence', 'swarm.revocation_tombstones', 'swarm.command_failures'].every((t) => tables.includes(t)));
  const R = out.results;
  check('unfaulted renewal commits', accepted(R.control.response));
  check('unfaulted successor works', R.control.successor_first_use.read.status === 200);
  check('unfaulted recovery commits', accepted(R.recovery_control.response));
  check('unfaulted recovered successor works', R.recovery_control.successor_first_use.read.status === 200);
  for (const label of ['last_write', 'first_lock', 'fence_insert', 'cycle_synthetic', 'sibling_stream', 'sibling_h0_poll', 'sibling_sl_inbox', 'sibling_renewal', 'revocation', 'serialization']) {
    const v = R[label], code = label === 'serialization' ? '40001' : '40P01';
    check(`${label}: SQLSTATE escaped the whole command transaction`, same(v.command_sqlstates, [code]));
    check(`${label}: response keeps existing mapping`, v.response.status === (code === '40P01' ? 503 : 500) && same(v.response.body, { error: code === '40P01' ? 'temporarily_unavailable' : 'internal_error' }));
    check(`${label}: every table unchanged except exactly one diagnostic row`, diagnosticOnly(v.rows));
    check(`${label}: every command state unchanged`, seatUnchanged(v.state_before, v.state_after));
    check(`${label}: diagnostic preserves SQLSTATE`, newFailure(v.state_before, v.state_after, code));
    if (label !== 'serialization') {
      const wait = v.parked?.renewal_wait ?? v.renewal_wait;
      check(`${label}: victim reached the independently blocked database operation`, wait?.wait?.startsWith('Lock/') && wait.ungranted.length>0);
      if (serverLog && label !== 'revocation') check(`${label}: server log confirms renewal victim`, same(v.server_log_victims, ['renewal']));
    }
    if (label === 'revocation') {
      check('revocation: retry refuses the now revoked credential', v.retry_same_command_id.response.status === 403 && same(v.retry_same_command_id.response.body, { error: 'forbidden' }));
      check('revocation: cascade revoked T0 and S1', v.retry_same_command_id.state_after.tokens.every((t) => t.revoked));
    } else {
      check(`${label}: SAME command_id retry succeeds`, accepted(v.retry_same_command_id.response));
      check(`${label}: retry successor works`, v.retry_successor_first_use?.read.status === 200);
    }
  }
  if(mode==='real_read') {
    const v=R.real_read;
    check('real read: fixture parks an actual reader after its adoption',v.read_waited_on_fixture);
    check('real read: real renewal waits on that reader before token acquisition',v.renewal_waited_on_reader && v.token_before_workspace===false);
    check('real read: no deadlock or command diagnostic',same(v.command_sqlstates,[]) && !v.rows.content_changed.includes('swarm.command_failures'));
    check('real read: committed first use wins',v.read_response.status===200);
    check('real read: consumed predecessor refuses renewal',v.response.status===401 && v.retry_predecessor.status===401);
    check('real read: original successor remains usable',v.successor_still_works.status===200);
    check('real read: no loser ledger, event, audit or presence changes',['audit','idempotency','events','stream_head_seq','presence_rows'].every(k=>same(v.state_before[k],v.state_after[k])));
    check('real read: only committed reader adoption and use survive',same(v.rows.content_changed,['swarm.agent_tokens','swarm.renewal_grants']) && same(v.rows.counts,{}));
  }
  check('no external HTTP', httpRefused === 0);
  out.checks = checks;
  out.verdict = checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  out.http_refused = httpRefused;
  out.stage = 'complete';
  await observer.end();
} catch (error) {
  out.error = sqlstate(error) !== 'non_sql' ? sqlstate(error) : (typeof error?.code === 'string' ? error.code : 'non_sql');
  out.error_name = error?.name ?? null;
}
console.log('R13_PROBE ' + JSON.stringify(out));
Deno.exit(out.verdict === 'PASS' ? 0 : 1);
