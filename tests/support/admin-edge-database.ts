/** Fresh local database for HTTP edge proofs. Its cutover state cannot change
 * the shared test stack or production. Docker-dependent, server suite only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { databaseContainer, localClusterAdminUrl, openIssuanceForTest } from './admin-schema-db.js';
import { edgeSetupCause } from './admin-edge-setup-diagnostic.js';

const schemas = ['auth', 'swarm', 'swarm_read', 'commonswarm_oauth', 'commonswarm_ops', 'supabase_migrations'];
export async function adminEdgeDatabase(localUrl: string) {
  const adminUrl = localClusterAdminUrl(localUrl);
  const master = postgres(adminUrl, { prepare: false, max: 1 });
  const name = `admin_edge_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const db = postgres(url.toString(), { prepare: false, max: 1 });
  let created = false;
  const close = async () => {
    try {
      try { await db.end(); } finally {
        // Even a failed disconnect must attempt to remove the allocated database.
        if (created) {
          if (!/^admin_edge_[a-f0-9]{32}$/u.test(name)) throw new Error('unsafe_database_cleanup');
          await master.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
          created = false;
        }
      }
    } finally { await master.end(); }
  };
  let phase = 'source-prerequisites';
  const context: Record<string, unknown> = {};
  try {
    const source = await master<{ schema: string; present: boolean }[]>`
      SELECT required.schema, to_regnamespace(required.schema) IS NOT NULL AS present
      FROM unnest(${schemas}::text[]) AS required(schema)`;
    context.schemas = Object.fromEntries(source.map(row => [row.schema, row.present]));
    assert.ok(source.every(row => row.present), 'required source schema missing');
    const [sourceState] = await master<{ server_version: string; cutover_present: boolean }[]>`
      SELECT current_setting('server_version_num') AS server_version,
        to_regclass('commonswarm_oauth.admin_cutover_state') IS NOT NULL AS cutover_present`;
    context.source = sourceState;
    assert.equal(sourceState?.cutover_present, true, 'admin cutover migration missing');
    phase = 'dump';
    const container = databaseContainer();
    context.container = /^supabase_db_[a-zA-Z0-9_-]+$/u.test(container) ? container : 'unexpected';
    const dumpVersion = execFileSync('docker', ['exec', container, 'pg_dump', '--version'], { encoding: 'utf8' });
    context.pg_dump_version = dumpVersion.match(/\b(\d+\.\d+(?:\.\d+)?)\b/u)?.[1] ?? 'unknown';
    const dump = execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'supabase_admin', '-d', 'postgres',
      '--schema-only', '--strict-names', ...schemas.map(s => `--schema=${s}`)],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    phase = 'create-database';
    // Do not inherit the Supabase template1's schemas/extension objects.
    await master.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`);
    created = true;
    phase = 'extensions';
    // The schema-filtered dump does not install extensions or copy their ACL.
    // Fresh CREATE SCHEMA gives PUBLIC no USAGE, unlike the source stack.
    await db.unsafe(`CREATE SCHEMA extensions;
      CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
      GRANT USAGE ON SCHEMA extensions TO PUBLIC;`);
    phase = 'restore';
    await db.unsafe(dump.replace(/^\\(?:un)?restrict \S+\r?$/gm, ''));
    phase = 'restore-session';
    // pg_dump leaves row_security=off, search_path='' and other session SETs.
    // max:1 reuses that session for cutover and subsequent fixture operations.
    // Restore connection defaults before switching to non-BYPASSRLS roles.
    await db.unsafe('RESET ALL');
    phase = 'test-cutover';
    await db.begin(async tx => {
      // --schema-only copies no singleton or migration-ledger rows.
      await tx`INSERT INTO commonswarm_oauth.admin_cutover_state(singleton) VALUES(true)`;
      await tx.unsafe(openIssuanceForTest);
    });
    return { url: url.toString(), db, close };
  } catch (error) {
    // Raw driver/exec errors include SQL, parameters and stderr. The retained
    // cause exposes only safe first-line metadata to Node's nested reporter.
    const cause = edgeSetupCause(error, phase);
    console.error('isolated_edge_database_setup_failed', JSON.stringify({ ...context, ...cause.summary }));
    try { await close(); } catch (cleanupError) {
      console.error('isolated_edge_database_cleanup_failed', JSON.stringify(edgeSetupCause(cleanupError, 'cleanup').summary));
    }
    throw new Error('isolated_edge_database_setup_failed', { cause });
  }
}
