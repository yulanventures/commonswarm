/** Durable proof admission across independent PostgreSQL sessions; CI/Docker only. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { databaseContainer, dbAssert, fixture, runSql } from '../support/admin-schema-db.js';

const execute = promisify(execFile);

test('edge-dpop-shared-replay: two sessions admit once, reconnect and later authority rollback cannot release a proof', { timeout: 30_000 }, async () => {
  const container = databaseContainer(), proof = randomUUID(), key = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('hex');
  const query = async (sql: string) => (await execute('docker', ['exec', container, 'psql', '-X', '-Atq',
    '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], { timeout: 10_000 })).stdout.trim();
  const admission = (domain: string, jti = proof) => `SELECT commonswarm_oauth.admit_dpop_proof('${jti}','${key}','${domain}',
    floor(extract(epoch FROM clock_timestamp()))::bigint,decode('${nonce}','hex'));`;
  // Every query is a separate backend and commits before returning. No grant,
  // client or issuance is activated; TTL cleanup owns the retained proof rows.
  assert.equal(await query(`SET ROLE commonswarm_dpop_verifier;
    SELECT commonswarm_oauth.register_dpop_nonce(decode('${nonce}','hex'),'${key}','as');
    SELECT commonswarm_oauth.register_dpop_nonce(decode('${nonce}','hex'),'${key}','admin_resource');`), 't\nt');
  const outcomes = await Promise.all([
    query(`SET ROLE commonswarm_oauth_runtime; ${admission('as')}`),
    query(`SET ROLE commonswarm_dpop_verifier; ${admission('admin_mcp')}`),
  ]);
  assert.deepEqual(outcomes.sort(), ['accepted', 'replay']);
  assert.equal(await query(`SET ROLE commonswarm_dpop_verifier; ${admission('admin_command')}`), 'replay', 'new backend sees committed cross-entry uniqueness');
  const f = fixture();
  // A real domain fixture rolls back independently after committed admission.
  runSql(f.sql);
  assert.equal(await query(`SET ROLE commonswarm_dpop_verifier; ${admission('admin_mcp')}`), 'replay', 'domain rollback cannot undo earlier admission');
  assert.equal(await query(`SET ROLE commonswarm_dpop_verifier; ${admission('admin_command', `fresh-${proof}`)}`), 'accepted', 'fresh proof is the paired success control');
  await query(dbAssert(`SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state`, 'proof tests never enable issuance'));
});
