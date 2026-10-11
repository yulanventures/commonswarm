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
  const commandCodes = [];
  const begin = command.db.begin;
  command.db.begin = function (...args) {
    return begin.apply(this, args).catch((error) => { commandCodes.push(sqlstate(error)); throw error; });
  };
  const { CLIENT_PROTOCOL_VERSION } = await import(`${tree}/src/cloud/config.ts`);
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
  const seat = async (name) => {
    const principal = id(), device = id(), run = id(), task = id(), lineage = id(), grant = id(), t0 = id();
    const raw = mintRaw(), hash = await hashOf(raw);
    await observer.begin(async (tx) => {
      await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner}::uuid, ${`r12b-${name}`})`;
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name) VALUES (${principal}::uuid, ${W}::uuid, ${owner}::uuid, ${`r12b-${name}-${tag}`})`;
      await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
      await tx`INSERT INTO swarm.renewal_grants (renewal_grant_id, workspace_id, principal_id, run_id, kind, max_successors, successors_used,
        horizon_expires_at, bound_device_id, created_by)
        VALUES (${grant}::uuid, ${W}::uuid, ${principal}::uuid, ${run}::uuid, 'standing', NULL, 0, NULL, ${device}::uuid, ${owner}::uuid)`;
      await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, task_id, epoch, scopes, token_hash, expires_at, lineage_id,
        renewal_grant_id)
        VALUES (${t0}::uuid, ${principal}::uuid, ${run}::uuid, ${task}::uuid, 1, ${tx.json(['post_signal'])}::jsonb, ${hash},
        statement_timestamp() + interval '1 hour', ${lineage}::uuid, ${grant}::uuid)`;
    });
    const firstUse = await readAs(raw);
    const [used] = await observer`SELECT first_used_at IS NOT NULL AS used FROM swarm.agent_tokens WHERE token_id = ${t0}::uuid`;
    if (firstUse.status !== 200 || !used.used) throw Object.assign(new Error('seat'), { code: `FIXTURE_SEAT_${firstUse.status}` });
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
    out.stage = 'real_read';
    const s = await seat('real-read');
    const C = id();
    const lost = await renew(s.raw, C);
    nameSuccessor(s, lost, 'S1');
    const rawS1 = credential(lost);
    const gateKey = Math.floor(Math.random() * 1000000000) + 1;
    const gate = postgres(DB, { prepare: false, max: 1, onnotice: () => {} });
    const fn = `r13_read_gate_${tag}`;
    await gate`SELECT pg_advisory_lock(130013, ${gateKey}::int)`;
    await observer.unsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(130013, ${gateKey}); RETURN NEW; END $$`);
    await observer.unsafe(`CREATE TRIGGER ${fn} AFTER UPDATE OF last_used_at ON swarm.renewal_grants FOR EACH ROW WHEN (NEW.renewal_grant_id = '${s.grant}'::uuid) EXECUTE FUNCTION public.${fn}()`);
    const before = await snapshot(); const state0 = await seatState(s);
    const code0 = commandCodes.length;
    const n0 = (await logLines('ERROR:  deadlock detected')).length;
    // The renewal retry (same command_id: the recovery path) holds the grant FOR UPDATE after step 9 and sleeps 2.5 s.
    const t0 = Date.now();
    const renewalP = renew(s.raw, C);
    let held = false;
    for (let i = 0; i < 200 && !held; i++) {
      try {
        await observer.begin(async (tx) => { await tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id = ${s.grant}::uuid FOR KEY SHARE NOWAIT`; });
        await sleep(10);
      } catch (e) { if (sqlstate(e) === '55P03') held = true; else throw e; }
    }
    const grantHeldAfterMs = Date.now() - t0;
    // The read presents the stranded successor S1: its first use.
    const readP = readAs(rawS1);
    let readPid = 0, renewalPid = 0, readWait = null;
    for (let i = 0; i < 300 && renewalPid === 0; i++) {
      const rows = await observer`SELECT pid, pg_blocking_pids(pid) AS b FROM pg_stat_activity WHERE datname = ${new URL(DB).pathname.slice(1)} AND query LIKE '%record_renewal_grant_use%' AND wait_event_type = 'Lock'`;
      if (rows.length === 1 && rows[0].b.length === 1) { readPid = Number(rows[0].pid); renewalPid = Number(rows[0].b[0]); readWait = await waitDetail(readPid); }
      else await sleep(20);
    }
    // Then the renewal wakes and waits on the read at index.ts:4142.
    let renewalWait = null;
    for (let i = 0; i < 300 && renewalWait === null; i++) {
      const b = renewalPid ? await observer`SELECT pg_blocking_pids(${renewalPid}::int) AS b` : [{ b: [] }];
      if (b[0].b.length === 1 && Number(b[0].b[0]) === readPid) renewalWait = await waitDetail(renewalPid);
      else await sleep(20);
    }
    const renewal = await renewalP;
    const answeredMs = Date.now() - t0;
    // The reader is held before COMMIT, so only the command's diagnostic may survive.
    const afterCommand = await snapshot();
    const stateAfterCommand = await seatState(s);
    await gate`SELECT pg_advisory_unlock(130013, ${gateKey}::int)`;
    const readResponse = await readP;
    await gate.end();
    await observer.unsafe(`DROP TRIGGER ${fn} ON swarm.renewal_grants`);
    await observer.unsafe(`DROP FUNCTION public.${fn}()`);
    nameSuccessor(s, renewal, 'real-read-answer');
    const after = await snapshot();
    const res = {
      scenario: 'real_read', command_sqlstates: commandCodes.slice(code0), command_rollback_rows: diff(before, afterCommand), state_after_command: stateAfterCommand, grant_held_after_ms: grantHeldAfterMs, read_wait: readWait, renewal_wait: renewalWait,
      server_log_victims: await victimsSince(n0, { renewal: renewalPid, read: readPid }), answered_after_ms: answeredMs,
      first_response: shape(lost), response: shape(renewal), read_response: shape(readResponse),
      state_before: state0, state_after: await seatState(s), rows: diff(before, after),
    };
    const retry = await renew(s.raw, C);
    const r1 = await snapshot();
    res.retry_same_command_id = { response: shape(retry), state_after: await seatState(s), rows: diff(after, r1) };
    const fresh = await renew(s.raw, id());
    res.renewal_new_command_id = { response: shape(fresh), state_after: await seatState(s) };
    res.successor_still_works = { read: shape(await readAs(rawS1)), state_after: await seatState(s) };
    out.results.real_read = res;
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
      const statement = label === 'last_write' ? 'INSERT INTO swarm.agent_presence' : label === 'first_lock' ? 'SELECT swarm.prepare_renewal_grant(' : label === 'fence_insert' ? 'INSERT INTO swarm.agent_tokens (' : 'UPDATE swarm.agent_tokens SET revoked_at';
      check(`${label}: victim reached the intended SQL statement`, wait?.statement.trim().startsWith(statement));
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
  if (mode === 'real_read') {
    const v = R.real_read;
    check('real read: contender waits at grant use', v.read_wait?.statement.trim().startsWith('SELECT swarm.record_renewal_grant_use('));
    check('real read: renewal waits at discardStrandedSuccessor', v.renewal_wait?.statement.trim().startsWith('UPDATE swarm.agent_tokens SET revoked_at'));
    check('real read: renewal propagates 40P01', same(v.command_sqlstates, ['40P01']));
    check('real read: renewal returns 503', v.response.status === 503 && same(v.response.body, { error: 'temporarily_unavailable' }));
    check('real read: all command tables unchanged plus one diagnostic before reader commit', diagnosticOnly(v.command_rollback_rows));
    check('real read: command state unchanged before reader commit', seatUnchanged(v.state_before, v.state_after_command));
    check('real read: one diagnostic preserves 40P01', newFailure(v.state_before, v.state_after_command, '40P01'));
    if (serverLog) check('real read: server log confirms renewal victim', same(v.server_log_victims, ['renewal']));
    check('real read: first use commits', v.read_response.status === 200);
    check('real read: only reader token/grant writes and diagnostic survive', same(v.rows.content_changed, ['swarm.agent_tokens', 'swarm.command_failures', 'swarm.renewal_grants']) && same(v.rows.counts, { 'swarm.command_failures': 1 }));
    check('real read: command ledger and audit survive unchanged', ['audit', 'idempotency', 'events', 'stream_head_seq'].every((k) => same(v.state_before[k], v.state_after[k])));
    check('real read: T0 retry may refuse after committed handover', v.retry_same_command_id.response.status === 401);
    check('real read: no token loss, S1 still works', v.successor_still_works.read.status === 200);
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
