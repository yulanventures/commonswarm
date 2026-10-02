/** M2 first-approval verification lock: real PostgreSQL, CI/Docker only. */
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { catalog, databaseContainer, dbAssert, fixture, refuses, runSql } from '../support/admin-schema-db.js';

function verification(client: string, version = 1, active = true): string {
  return `SET LOCAL ROLE commonswarm_admin_release;
INSERT INTO commonswarm_oauth.admin_verified_clients(client_id,verification_version,application_type,registration_source,
  publisher_identity,publisher_contact,metadata_digest,redirect_uris,scope_ceiling,pkce_s256_tested,dpop_tested,redirect_tested,
  origin_control_verified,review_evidence_ref,reviewed_by,active)
VALUES('${client}',${version},'web','static','Lock test publisher','contact@example.test',repeat('a',64),
  ARRAY['https://client.example/callback'],ARRAY['admin:read'],true,true,true,true,'lock-test-evidence','lock-test',${active});
RESET ROLE;`;
}

test('admin-schema-isolation: command locks exact first-approval verification facts without writing any application row', () => {
  const client = `https://client.example/${randomUUID()}`;
  runSql(`${verification(client)}${verification(client, 2, false)}
${dbAssert('SELECT count(*)=0 FROM commonswarm_oauth.admin_client_owner_approvals', 'first approval has no approval rows')}
${dbAssert('SELECT count(*)=0 FROM commonswarm_oauth.admin_grant_bindings', 'first approval has no provider binding')}
-- Snapshot every application table, not only the target verification row.
CREATE TEMP TABLE lock_test_snapshot(name text PRIMARY KEY, rows jsonb);
DO $snapshot$ DECLARE t record; BEGIN
  FOR t IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('swarm','commonswarm_oauth') AND c.relkind='r' LOOP
    EXECUTE format('INSERT INTO lock_test_snapshot SELECT %L,coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM %I.%I r',
      t.nspname||'.'||t.relname,t.nspname,t.relname);
  END LOOP;
END $snapshot$;
SET LOCAL ROLE swarm_command;
-- Direct locking is the pre-fix failure: SELECT alone cannot take FOR SHARE.
${refuses(`SELECT * FROM commonswarm_oauth.admin_verified_clients WHERE client_id='${client}' AND verification_version=1 FOR SHARE`, '42501')}
${dbAssert(`SELECT count(*)=1 AND bool_and(client_id='${client}' AND verification_version=1 AND active AND withdrawn_at IS NULL
  AND metadata_digest=repeat('a',64) AND application_type='web' AND redirect_class='hosted_https'
  AND redirect_uris=ARRAY['https://client.example/callback'])
  FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, 'exact active verification control')}
${dbAssert(`SELECT count(*)=1 AND bool_and(verification_version=2 AND NOT active AND withdrawn_at IS NULL)
  FROM commonswarm_oauth.lock_admin_client_verification('${client}',2)`, 'exact inactive version control')}
${refuses(`SELECT * FROM commonswarm_oauth.lock_admin_client_verification('absent-client',1)`, 'P0001')}
${refuses(`SELECT * FROM commonswarm_oauth.lock_admin_client_verification('${client}',3)`, 'P0001')}
${refuses(`SELECT * FROM commonswarm_oauth.lock_admin_client_verification('${client}',NULL)`, 'P0001')}
${refuses(`UPDATE commonswarm_oauth.admin_verified_clients SET active=false WHERE client_id='${client}'`, '42501')}
${refuses(`DELETE FROM commonswarm_oauth.admin_verified_clients WHERE client_id='${client}'`, '42501')}
${refuses(`INSERT INTO commonswarm_oauth.admin_verified_clients SELECT * FROM commonswarm_oauth.admin_verified_clients WHERE client_id='${client}'`, '42501')}
RESET ROLE;
DO $unchanged$ DECLARE t record; actual jsonb; expected jsonb; BEGIN
  FOR t IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('swarm','commonswarm_oauth') AND c.relkind='r' LOOP
    SELECT rows INTO STRICT expected FROM lock_test_snapshot WHERE name=t.nspname||'.'||t.relname;
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM %I.%I r',t.nspname,t.relname) INTO actual;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'locking changed %.%',t.nspname,t.relname; END IF;
  END LOOP;
END $unchanged$;
${dbAssert('SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state', 'issuance remains closed')}
`);
});

test('admin-schema-isolation: withdrawn facts remain readable only through the command verification lock', () => {
  const client = `https://client.example/${randomUUID()}`;
  runSql(`${verification(client)}
SET LOCAL ROLE swarm_command;
${dbAssert(`SELECT active AND withdrawn_at IS NULL FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, 'active control before withdrawal')}
RESET ROLE;
SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_verified_clients SET active=false,withdrawn_at=statement_timestamp(),withdrawal_reason='operator_withdrawn'
  WHERE client_id='${client}' AND verification_version=1;
RESET ROLE;
SET LOCAL ROLE swarm_command;
${dbAssert(`SELECT NOT active AND withdrawn_at IS NOT NULL AND verification_version=1 AND metadata_digest=repeat('a',64)
  AND redirect_class='hosted_https' FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, 'withdrawn status is returned, not hidden')}
RESET ROLE;
-- Resolve the exact function while schema lookup is permitted. A denied role
-- must still prove its EXECUTE ACL, even when it also lacks schema USAGE.
SELECT set_config('lock_test.function_oid',
  'commonswarm_oauth.lock_admin_client_verification(text,integer)'::regprocedure::oid::text,true);
${['commonswarm_oauth_runtime', 'swarm_read', 'anon', 'authenticated', 'commonswarm_admin_release',
    'commonswarm_dpop_verifier', 'commonswarm_oauth_maintenance'].map(role => `SET LOCAL ROLE ${role};
${dbAssert("SELECT NOT has_function_privilege(current_user,current_setting('lock_test.function_oid')::oid,'EXECUTE')", `${role} lacks EXECUTE`)}
${refuses(`SELECT * FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, '42501')}
RESET ROLE;`).join('\n')}
-- Pair denied execution with existing runtime/read status execution; both roles
-- have schema usage, so their refusal reaches the new function's EXECUTE ACL.
${['commonswarm_oauth_runtime', 'swarm_read'].map(role => `SET LOCAL ROLE ${role};
${dbAssert("SELECT has_schema_privilege(current_user,'commonswarm_oauth','USAGE')", `${role} schema control`)}
${dbAssert("SELECT commonswarm_oauth.issuer_key_allowed('https://mcp.commonswarm.com','lock-test-kid')", `${role} permitted function control`)}
RESET ROLE;`).join('\n')}
SET LOCAL ROLE swarm_command;
${dbAssert("SELECT has_schema_privilege(current_user,'commonswarm_oauth','USAGE')", 'command schema usage control')}
${dbAssert(`SELECT NOT active FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, 'command execution still permitted')}
RESET ROLE;
${catalog('20261003000002')}
-- An accidentally exposed ACL must make the executable release proof fail.
GRANT EXECUTE ON FUNCTION commonswarm_oauth.lock_admin_client_verification(text,integer) TO commonswarm_oauth_runtime;
${catalog('20261003000002', false, false)}
REVOKE EXECUTE ON FUNCTION commonswarm_oauth.lock_admin_client_verification(text,integer) FROM commonswarm_oauth_runtime;
${catalog('20261003000002')}
`);
});

test('admin-schema-isolation: AS locks consent policy before a family exists without granting approval or verification writes', () => {
  const f = fixture();
  const familyStart = f.sql.indexOf('SET LOCAL ROLE commonswarm_oauth_runtime;');
  assert.ok(familyStart>0, 'fixture contains the family creation step');
  runSql(`${f.sql.slice(0, familyStart)}
${dbAssert('SELECT count(*)=0 FROM commonswarm_oauth.admin_grant_bindings', 'consent policy needs no family binding')}
SET LOCAL ROLE commonswarm_oauth_runtime;
${refuses(`SELECT * FROM commonswarm_oauth.admin_verified_clients WHERE client_id='${f.client}' FOR SHARE`, '42501')}
${dbAssert(`SELECT active AND owner_approved AND client_id='${f.client}' AND verification_version=1
  AND metadata_digest='${f.digest}' AND scope_ceiling=ARRAY['admin:read']
  AND redirect_uris=ARRAY['https://client.example/callback'] AND NOT full_account_eligible
  FROM commonswarm_oauth.lock_admin_consent_policy('${f.client}',1,'${f.owner}')`, 'AS exact consenting-owner policy control')}
${dbAssert(`SELECT active AND NOT owner_approved FROM commonswarm_oauth.lock_admin_consent_policy('${f.client}',1,'${f.foreign}')`, 'another owner cannot borrow approval')}
${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.lock_admin_consent_policy('${f.client}',2,'${f.owner}')`, 'missing verification version hidden')}
${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.lock_admin_consent_policy(NULL,1,'${f.owner}')`, 'invalid lookup is empty')}
${refuses(`UPDATE commonswarm_oauth.admin_verified_clients SET active=false WHERE client_id='${f.client}'`, '42501')}
${refuses(`UPDATE commonswarm_oauth.admin_client_owner_approvals SET withdrawn_at=statement_timestamp() WHERE client_id='${f.client}'`, '42501')}
RESET ROLE;
${dbAssert(`SELECT count(*)=1 AND bool_and(withdrawn_at IS NULL) FROM commonswarm_oauth.admin_client_owner_approvals WHERE client_id='${f.client}'`, 'policy reads preserve human approval')}
SELECT set_config('lock_test.consent_oid','commonswarm_oauth.lock_admin_consent_policy(text,integer,uuid)'::regprocedure::oid::text,true);
${['swarm_command','swarm_read','anon','authenticated','commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'].map(role => `SET LOCAL ROLE ${role};
${dbAssert("SELECT NOT has_function_privilege(current_user,current_setting('lock_test.consent_oid')::oid,'EXECUTE')", `${role} lacks AS policy execution`)}
${refuses(`SELECT * FROM commonswarm_oauth.lock_admin_consent_policy('${f.client}',1,'${f.owner}')`, '42501')}
RESET ROLE;`).join('\n')}
SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_verified_clients SET active=false,withdrawn_at=statement_timestamp(),withdrawal_reason='policy_test';
RESET ROLE;
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT NOT active AND owner_approved FROM commonswarm_oauth.lock_admin_consent_policy('${f.client}',1,'${f.owner}')`, 'withdrawn verification cannot authorize even with approval')}
RESET ROLE;
${catalog('20261003000002')}
GRANT EXECUTE ON FUNCTION commonswarm_oauth.lock_admin_consent_policy(text,integer,uuid) TO swarm_command;
${catalog('20261003000002',false,false)}
REVOKE EXECUTE ON FUNCTION commonswarm_oauth.lock_admin_consent_policy(text,integer,uuid) FROM swarm_command;
${catalog('20261003000002')}
`);
});

/** Persistent psql backends inside the CI database container; no auth files. */
class LockSession {
  private readonly child;
  private readonly exited: Promise<void>;
  private pending?: { marker: string; rows: string[]; resolve: (rows: string[]) => void; reject: (error: Error) => void };
  private buffer = '';
  private stderr = '';
  private stopped = false;

  constructor(container: string) {
    this.child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-Atq',
      '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']);
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '');
        this.buffer = this.buffer.slice(newline + 1);
        if (line === this.pending?.marker) {
          const query = this.pending;
          this.pending = undefined;
          query.resolve(query.rows);
        } else if (this.pending) this.pending.rows.push(line);
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => { this.stderr += chunk; });
    this.exited = new Promise(resolve => {
      const stop = (error: Error) => {
        this.stopped = true;
        this.pending?.reject(error);
        this.pending = undefined;
        resolve();
      };
      this.child.once('error', stop);
      this.child.once('close', (code, signal) => stop(new Error(`lock session exited: ${code}/${signal}; ${this.stderr}`)));
    });
  }

  query(sql: string): Promise<string[]> {
    assert.equal(this.stopped, false, `live lock session required: ${this.stderr}`);
    assert.equal(this.pending, undefined, 'one in-flight query per backend');
    return new Promise((resolve, reject) => {
      const marker = `lock_marker_${randomUUID().replaceAll('-', '')}`;
      this.pending = { marker, rows: [], resolve, reject };
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }

  async close(): Promise<void> {
    // Closing a caller with a pending query must also be bounded on failures.
    const timeout = setTimeout(() => this.child.kill('SIGTERM'), 3000);
    try { this.child.stdin.end(); await this.exited; }
    finally { clearTimeout(timeout); }
  }
}

test('admin-schema-isolation: command and AS consent FOR SHARE block release row locks until the caller commits', { timeout: 40_000 }, async () => {
  const client = `https://client.example/${randomUUID()}`;
  const sessions = Array.from({ length: 3 }, () => new LockSession(databaseContainer()));
  const [caller, release, monitor] = sessions as [LockSession, LockSession, LockSession];
  const retainedLock = `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation'
    AND relation='commonswarm_oauth.admin_verified_clients'::regclass AND mode='RowShareLock' AND granted);`;
  let failed = false;
  let firstError: unknown;
  const recordFailure = (error: unknown) => {
    if (!failed) { failed = true; firstError = error; }
  };
  try {
    for (const session of sessions) await session.query("SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s';");
    // Commit only reviewed verification fixtures in the CI database so every
    // backend sees the real table/rows. No cloned-schema DDL lock can interfere.
    // Verification history is immutable: withdraw these rows in finally, retain
    // them for history, and never delete them or enable issuance.
    await monitor.query(`BEGIN; ${verification(client)} ${verification(client, 2, false)} COMMIT;`);
    const callerPid = Number((await caller.query('SELECT pg_backend_pid();'))[0]);
    const releasePid = Number((await release.query('SELECT pg_backend_pid();'))[0]);
    assert.ok(Number.isInteger(callerPid) && callerPid > 0);
    assert.ok(Number.isInteger(releasePid) && releasePid > 0 && releasePid !== callerPid);

    for (const [callerRole, policyCall] of [
      ['swarm_command', `commonswarm_oauth.lock_admin_client_verification('${client}',1)`],
      ['commonswarm_oauth_runtime', `commonswarm_oauth.lock_admin_consent_policy('${client}',1,'${randomUUID()}')`],
    ]) for (const mode of ['UPDATE', 'NO KEY UPDATE']) {
      const competingLock = `SELECT verification_version FROM commonswarm_oauth.admin_verified_clients
        WHERE client_id='${client}' AND verification_version=1 FOR ${mode};`;
      await caller.query(`BEGIN; SET LOCAL ROLE ${callerRole};`);
      // Negative control: a real nonlocking command read must not block the
      // same release-role query; NOWAIT fails immediately if setup holds a lock.
      assert.deepEqual(await caller.query(`SELECT verification_version FROM commonswarm_oauth.admin_verified_clients
        WHERE client_id='${client}' AND verification_version=1;`), ['1']);
      assert.deepEqual(await caller.query(retainedLock), ['f'], 'unlocked read has no RowShareLock');
      await release.query('BEGIN; SET LOCAL ROLE commonswarm_admin_release;');
      assert.deepEqual(await release.query(competingLock.replace(/;$/, ' NOWAIT;')), ['1'], 'unlocked read permits the competing lock');
      await release.query('COMMIT;');

      assert.deepEqual(await caller.query(`SELECT verification_version FROM ${policyCall};`), ['1']);
      assert.deepEqual(await caller.query(retainedLock), ['t'], 'function retains RowShareLock after return');
      await release.query('BEGIN; SET LOCAL ROLE commonswarm_admin_release;');
      assert.deepEqual(await release.query(`SELECT verification_version FROM commonswarm_oauth.admin_verified_clients
        WHERE client_id='${client}' AND verification_version=2 FOR ${mode} NOWAIT;`), ['2'], 'other version stays unlocked');
      await release.query('COMMIT;');

      await release.query('BEGIN; SET LOCAL ROLE commonswarm_admin_release;');
      let settled = false;
      const contender = release.query(competingLock).then(
        rows => { settled = true; return rows; },
        error => { settled = true; throw error; });
      // Attach a rejection handler while observing; still await the original
      // result below so an early SQL failure cannot masquerade as blocking.
      void contender.catch(() => {});
      try {
        const deadline = performance.now() + 5000;
        let blocked = false;
        while (performance.now() < deadline) {
          assert.equal(settled, false, 'competing row lock must remain pending until commit');
          const rows = await monitor.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
            WHERE a.pid=${releasePid} AND a.wait_event_type='Lock' AND a.wait_event='transactionid'
              AND ${callerPid}=ANY(pg_blocking_pids(a.pid))
              AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='transactionid'
                AND NOT l.granted AND l.transactionid=(SELECT transactionid FROM pg_locks
                  WHERE pid=${callerPid} AND locktype='transactionid' AND mode='ExclusiveLock' AND granted)));
          `);
          assert.equal(settled, false, 'row-lock query cannot finish during the blocking observation');
          if (rows[0] === 't') { blocked = true; break; }
          await delay(25);
        }
        assert.equal(blocked, true, `release FOR ${mode} waits on the exact caller transaction`);
        // NO KEY UPDATE also conflicts with SHARE, but not KEY SHARE. This
        // catches an accidental weakening that a FOR UPDATE probe alone misses.
      } catch (error) {
        // Keep the blocking observation's failure if releasing a dead caller
        // or awaiting the contender also fails in the following finally.
        recordFailure(error);
        throw error;
      } finally {
        await caller.query('COMMIT;');
        assert.deepEqual(await contender, ['1'], 'release lock succeeds after caller commit');
        await release.query('COMMIT;');
      }
      assert.deepEqual(await caller.query(retainedLock), ['f'], 'commit releases the caller lock');
    }
    await monitor.query(`${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.admin_client_owner_approvals WHERE client_id='${client}'`, 'locking creates no owner approval')}
      ${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.admin_grant_bindings WHERE client_id='${client}'`, 'locking creates no provider binding')}
      ${dbAssert('SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state', 'issuance remains closed')}`);
    await monitor.query(catalog('20261003000002'));
  } catch (error) {
    recordFailure(error);
  } finally {
    // Close every holder/observer before cleanup, including failed sessions.
    // Never reuse the monitor: ON_ERROR_STOP may already have killed it.
    const closed = await Promise.allSettled(sessions.map(session => session.close()));
    for (const result of closed) if (result.status === 'rejected') recordFailure(result.reason);
    try {
      const cleanup = new LockSession(databaseContainer());
      try {
        await cleanup.query("SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s';");
        await cleanup.query(`BEGIN; SET LOCAL ROLE commonswarm_admin_release;
          UPDATE commonswarm_oauth.admin_verified_clients SET active=false,withdrawn_at=statement_timestamp(),withdrawal_reason='lock_test_complete'
            WHERE client_id='${client}' AND verification_version IN (1,2) AND withdrawn_at IS NULL;
          COMMIT;
          ${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.admin_verified_clients
            WHERE client_id='${client}' AND verification_version IN (1,2) AND (active OR withdrawn_at IS NULL)`, 'both exact fixture versions withdrawn')}`);
      } finally { await cleanup.close(); }
    } catch (error) { recordFailure(error); }
  }
  if (failed) throw firstError;
});
