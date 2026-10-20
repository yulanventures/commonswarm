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
if (config?.source && tree !== config.source.path) throw new Error('source_path_mismatch');
if (mode === 'permanence' && ['SWARM_CMD_TEST_SLEEP_AFTER_STEP','SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP'].some(key=>Deno.env.get(key)!==undefined)) throw new Error('permanence_fault_hook_set');
const readTree = config?.read_source?.path ?? tree;
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
const out = { tree, mode, source:config?.source ? {commit:config.source.commit,tree:config.source.tree} : null,
  read_source:config?.read_source ? {commit:config.read_source.commit,tree:config.read_source.tree} : null, hook_sleep: Deno.env.get('SWARM_CMD_TEST_SLEEP_AFTER_STEP') ?? null, stage: 'import' };
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
  const read = await import(`${readTree}/supabase/functions/read/index.ts`);
  // Capture the error AFTER postgres.js rolls the entire transaction back.
  // No production seam: this is the exported real command pool at its existing boundary.
  const commandCodes = [];
  const begin = command.db.begin;
  command.db.begin = function (...args) {
    return begin.apply(this, args).catch((error) => { commandCodes.push(sqlstate(error)); throw error; });
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
  const renew = async (token, commandId) => capture(await command.handleRequest(new Request('http://127.0.0.1/functions/v1/command', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ command_id: commandId, client_version: CLIENT_PROTOCOL_VERSION, workspace_id: W,
      stream: { kind: 'workspace' }, command: { kind: 'renew_agent_token' } }) })));
  const readAs = async (token) => capture(await read.handleRequest(new Request('http://127.0.0.1/functions/v1/read', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ resource: 'members', workspace_id: W }) })));

  // A renewable seat: a local, unmanaged principal (no session proof needed, agent-auth.ts:246-248), its device and run,
  // a standing renewal grant bound to that device, and a root token T0 with a task/epoch binding and that grant (rows as
  // tests/p1-server/renewal-last-use.test.ts:70-80). T0 gets its first use from the real read route (a token is never
  // born used, SWARM_TOKEN_FIRST_USE_PRESET), because a pending token may not renew (predecessor_pending_first_use).
  const seat = async (name, use=true, boundDevice=null) => {
    const principal = id(), device = id(), run = id(), task = id(), lineage = id(), grant = id(), t0 = id();
    const raw = mintRaw(), hash = await hashOf(raw);
    await observer.begin(async (tx) => {
      await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner}::uuid, ${`r12b-${name}`})`;
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name) VALUES (${principal}::uuid, ${W}::uuid, ${owner}::uuid, ${`r12b-${name}-${tag}`})`;
      await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
      await tx`INSERT INTO swarm.renewal_grants (renewal_grant_id, workspace_id, principal_id, run_id, kind, max_successors, successors_used,
        horizon_expires_at, bound_device_id, created_by)
        VALUES (${grant}::uuid, ${W}::uuid, ${principal}::uuid, ${run}::uuid, 'standing', NULL, 0, NULL, ${boundDevice ?? device}::uuid, ${owner}::uuid)`;
      await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, task_id, epoch, scopes, token_hash, expires_at, lineage_id,
        renewal_grant_id)
        VALUES (${t0}::uuid, ${principal}::uuid, ${run}::uuid, ${task}::uuid, 1, ${tx.json(['post_signal'])}::jsonb, ${hash},
        statement_timestamp() + interval '1 hour', ${lineage}::uuid, ${grant}::uuid)`;
    });
    if(use) {
      const firstUse = await readAs(raw);
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
    const bootstrap=await seat('unused-bootstrap',false);
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${bootstrap.t0}::uuid`;
    const bootstrapBefore=await seatState(bootstrap),bootstrapDenied=await renew(bootstrap.raw,id());
    check('expired unused root cannot borrow recovery authority',bootstrapDenied.status===401 || bootstrapDenied.status===403);
    check('unused-root denial leaves no adoption or ledger',JSON.stringify(bootstrapBefore)===JSON.stringify(await seatState(bootstrap)));
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
    await import(`${readTree}/supabase/functions/activity/index.ts`);
    const activityHandler=served.at(-1);
    const activity=raw=>activityHandler(new Request('http://127.0.0.1/functions/v1/activity',{
      method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},
      body:JSON.stringify({version:1,workspace_id:W,stream_id:streamId,sequence:1,phase:'idle',
        signal_id:null,tool_title:null,elapsed_ms:0}),
    }));
    const activitySeat=await seat('activity-deadline'),issued=await renew(activitySeat.raw,id()),activityRaw=credential(issued);
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
    const readModels=await seat('read-models');
    const connectionFrom=overview=>overview.workspaces.find(w=>w.workspace_id===W)?.people
      .flatMap(person=>person.agents).find(a=>a.principal_id===readModels.principal)?.status.facts.connection;
    const overviewAs=async user=>observer.begin(async tx=>{
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims',${JSON.stringify({sub:user,role:'authenticated'})},true)`;
      const [row]=await tx`SELECT swarm_read.home_overview() AS value`;return row.value;
    });
    check('current local overview positive is live',connectionFrom(await overviewAs(owner))==='live');
    // The same observable connection contract at both public read boundaries.
    // Existing coverage only exercised live grants, not a dead bootstrap or
    // historical first use that cannot authenticate the current frontier.
    await observer`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose)
      VALUES(${W}::uuid,'shared') ON CONFLICT DO NOTHING`;
    const queueFor=async principal=>{
      const result=await command.handleHostedManagementCommand({command_id:id(),client_version:CLIENT_PROTOCOL_VERSION,
        workspace_id:W,stream:{kind:'workspace'},command:{kind:'household_tool',tool:'todo_queue',
          arguments:{seat:HOUSEHOLD_LOCAL_SEAT,principal_id:principal}}},
        {userId:owner,email,displayName:'Read truth owner',identityVerified:true,interactiveAuthAtSeconds:null});
      if(result.status!==200 || !result.body.queue?.status?.facts) throw Object.assign(new Error('queue boundary'),{code:'QUEUE_READ_CONTROL'});
      return result.body.queue.status.facts.connection;
    };
    const wrongDevice=id();
    await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${wrongDevice}::uuid,${owner}::uuid,'Mismatched read fixture')`;
    for(const variant of ['live-bootstrap','expired-unused','expired-used','pending','retired-history','predecessor-tombstone','elapsed','revoked','mismatched-device']) {
      const fixture=await seat(`truth-${variant}`,!['live-bootstrap','expired-unused','mismatched-device'].includes(variant),
        variant==='mismatched-device' ? wrongDevice:null);
      let child;
      if(['pending','retired-history','predecessor-tombstone'].includes(variant)) {
        const issued=await renew(fixture.raw,id());child=JSON.parse(issued.text);
        if(issued.status!==200 || !child.agent_token) throw Object.assign(new Error('truth successor'),{code:'TRUTH_SUCCESSOR'});
        if(variant==='retired-history') {
          if((await readAs(child.agent_token)).status!==200) throw Object.assign(new Error('truth use'),{code:'TRUTH_USE'});
          await observer`UPDATE swarm.agent_tokens SET surrender_only=true WHERE token_id=${child.token_id}::uuid`;
        }
        if(variant==='predecessor-tombstone') await observer`INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
          VALUES('token',${fixture.t0}::uuid,${owner}::uuid)`;
      }
      if(!['live-bootstrap','mismatched-device'].includes(variant)) await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second'
        WHERE renewal_grant_id=${fixture.grant}::uuid`;
      if(variant==='elapsed') await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
        WHERE renewal_grant_id=${fixture.grant}::uuid`;
      if(variant==='revoked') await observer`UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp() WHERE renewal_grant_id=${fixture.grant}::uuid`;
      const expected=['live-bootstrap','expired-used','pending'].includes(variant);
      const overview=await overviewAs(owner);
      const home=overview.workspaces.find(w=>w.workspace_id===W)?.people.flatMap(person=>person.agents)
        .find(agent=>agent.principal_id===fixture.principal)?.status.facts.connection;
      const queue=await queueFor(fixture.principal);
      check(`current-proof-${variant}-home-and-queue`,home!==undefined && (home==='live')===expected && (queue==='live')===expected);
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
    check('converted NULL-bound family has genuine runtime first use',(await convertedRead()).status===200);
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
    const mismatch=await seat('read-model-binding',false);
    const otherDevice=id();
    await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${otherDevice}::uuid,${owner}::uuid,'Other binding')`;
    await observer`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,
      kind,max_successors,successors_used,horizon_expires_at,bound_device_id,created_by)
      VALUES(${id()}::uuid,${W}::uuid,${mismatch.principal}::uuid,${mismatch.run}::uuid,'standing',NULL,0,NULL,
        ${otherDevice}::uuid,${owner}::uuid)`;
    await observer`UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp() WHERE renewal_grant_id=${mismatch.grant}::uuid`;
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${mismatch.t0}::uuid`;
    const mismatchOverview=await overviewAs(owner);
    const mismatchConnection=mismatchOverview.workspaces.find(w=>w.workspace_id===W)?.people.flatMap(person=>person.agents)
      .find(agent=>agent.principal_id===mismatch.principal)?.status.facts.connection;
    check('non-NULL mismatched device cannot claim renewal liveness',mismatchConnection!=='live');

    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '1 day',suspended_at=clock_timestamp()
      WHERE renewal_grant_id=${readModels.grant}::uuid`;
    await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${readModels.t0}::uuid`;
    check('future dated family with idle history stays live through renewal liveness',connectionFrom(await overviewAs(owner))==='live');
    check('live bearer control exists before terminal precedence',credential(await renew(readModels.raw,id()))!==null);
    const [deadline]=await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
      WHERE renewal_grant_id=${readModels.grant}::uuid RETURNING connection_expires_at`;
    check('elapsed canonical policy wins over renewal liveness in overview',connectionFrom(await overviewAs(owner))==='key_ended');
    const renewalRows=await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims',${JSON.stringify({sub:owner,role:'authenticated'})},true)`;
      return await tx`SELECT * FROM swarm_read.renewal_grant_roster(${W}::uuid)`;
    });
    const tokenRows=await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_read`;
      return await tx`SELECT * FROM swarm_read.renewal_grant_for_token(${W}::uuid,${readModels.t0}::uuid)`;
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
      VALUES(${hosted}::uuid,${'probe-'+hosted},${owner}::uuid,${W}::uuid,'probe-client','https://mcp.commonswarm.com/mcp',
        ${[W]}::uuid[],${new Uint8Array(32).fill(7)},'probe-consent','active',clock_timestamp(),clock_timestamp(),${hostedDeadline})`;
    const hostedPrincipal=id(),hostedSeat=id(),hostedDigest=new Uint8Array(32).fill(7);
    await observer`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
      VALUES(${hostedPrincipal}::uuid,${W}::uuid,${owner}::uuid,'probe-hosted','hosted_mcp',true)`;
    await observer`INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES(${hosted}::uuid,${W}::uuid,${owner}::uuid,${hostedDigest},${id()}::uuid,clock_timestamp())`;
    await observer`INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES(${hostedSeat}::uuid,${hosted}::uuid,${W}::uuid,${owner}::uuid,${hostedPrincipal}::uuid,'probe-hosted',clock_timestamp())`;
    const hostedOverview=await overviewAs(owner);
    const hostedConnection=hostedOverview.workspaces.find(w=>w.workspace_id===W).people.flatMap(p=>p.agents)
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
