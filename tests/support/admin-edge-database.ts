/** Fresh local database for HTTP edge proofs. Its cutover state cannot change
 * the shared test stack or production. Docker-dependent, server suite only. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { databaseContainer, localClusterAdminUrl, openIssuanceForTest } from './admin-schema-db.js';
export async function adminEdgeDatabase(localUrl: string) {
  const adminUrl = localClusterAdminUrl(localUrl);
  const master = postgres(adminUrl, { prepare: false, max: 1 });
  const name = `admin_edge_${randomUUID().replaceAll('-', '')}`;
  await master.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const db = postgres(url.toString(), { prepare: false, max: 1 });
  const close = async () => {
    await db.end();
    if (!/^admin_edge_[a-f0-9]{32}$/u.test(name)) throw new Error('unsafe_database_cleanup');
    await master.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await master.end();
  };
  try {
    const dump = execFileSync('docker', ['exec', databaseContainer(), 'pg_dump', '-U', 'supabase_admin', '-d', 'postgres', '--schema-only', ...['auth','swarm','swarm_read','commonswarm_oauth','commonswarm_ops','supabase_migrations'].map(s=>`--schema=${s}`)],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    await db.unsafe('CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;');
    await db.unsafe(dump.replace(/^\\(?:un)?restrict \S+\r?$/gm, ''));
    await db.begin(async tx => {
      await tx`INSERT INTO commonswarm_oauth.admin_cutover_state(singleton) VALUES(true)`;
      await tx.unsafe(openIssuanceForTest);
    });
    return { url: url.toString(), db, close };
  } catch { await close(); throw new Error('isolated_edge_database_setup_failed'); }
}
