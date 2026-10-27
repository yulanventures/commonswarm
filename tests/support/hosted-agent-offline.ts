/** Run the hosted P1 file without sockets, Docker or Deno downloads:
 * HOSTED_AGENT_TEST_PGDATA=/private/tmp/<stopped-migrated-PG17>/data \
 *   node --import tsx --test tests/p1-server/hosted-agent-workspaces.test.ts
 * Supply a disposable cluster with the real migrations and Supabase test surface.
 * Each case copies it; the supplied cluster is never opened or changed.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type postgres from 'postgres';
import { repoSql } from './admin-schema-db.js';

type Row = Record<string, unknown>;
type Sql = postgres.Sql;
export const offlineHostedData = process.env.HOSTED_AGENT_TEST_PGDATA;

export async function offlineHostedDatabase() {
  assert.ok(offlineHostedData);
  const source = realpathSync(offlineHostedData);
  assert.ok(source.startsWith('/private/tmp/'), 'disposable offline cluster required');
  assert.equal(readFileSync(join(source, 'PG_VERSION'), 'utf8').trim(), '17');
  assert.equal(existsSync(join(source, 'postmaster.pid')), false, 'stop the offline cluster before copying');
  const directory = mkdtempSync('/private/tmp/hosted-agent-offline-');
  cpSync(source, join(directory, 'data'), { recursive: true });
  chmodSync(join(directory, 'data'), 0o700);
  const child = spawn(process.env.HOSTED_AGENT_TEST_POSTGRES ?? 'postgres',
    ['--single', '-D', join(directory, 'data'), '-j', 'postgres'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', sequence = 0, savepoint = 0, stopped = false;
  let pending: { id: number; resolve: (rows: Row[]) => void; reject: (error: Error) => void } | null = null;
  const ended = new Promise<void>(resolve => child.on('close', () => { stopped = true; resolve(); }));
  const fail = (error: Error) => { const current = pending; pending = null; current?.reject(error); };
  child.on('error', fail);
  child.on('close', () => fail(new Error('offline PostgreSQL stopped')));
  const decode = (_key: string, value: unknown) => typeof value === 'string' && /^\\x[0-9a-f]+$/i.test(value)
    ? Buffer.from(value.slice(2), 'hex')
    : typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) ? new Date(value) : value;
  const output = (data: Buffer) => {
    buffer += data.toString();
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.includes('ERROR:') || line.includes('FATAL:')) fail(new Error(line));
      const result = line.match(/HOSTED_OFFLINE_(\d+):(.*)$/);
      if (result && pending && Number(result[1]) === pending.id) {
        const current = pending; pending = null;
        current.resolve(JSON.parse(result[2]!, decode));
      }
    }
  };
  child.stdout.on('data', output); child.stderr.on('data', output);
  const quote = (value: unknown) => "E'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "''").replaceAll('\n', '\\n') + "'";
  const literal = (value: unknown): string => {
    if (value == null) return 'NULL';
    if (typeof value === 'object' && 'fragment' in value) return String(value.fragment);
    if (value instanceof Uint8Array) return quote('\\x' + Buffer.from(value).toString('hex'));
    if (value instanceof Date) return quote(value.toISOString());
    if (Array.isArray(value)) return 'ARRAY[' + value.map(literal).join(',') + ']';
    if (typeof value === 'object' && 'jsonValue' in value) return quote(JSON.stringify(value.jsonValue));
    if (typeof value === 'boolean') return String(value);
    return quote(value);
  };
  const execute = (sql: string) => new Promise<Row[]>((resolve, reject) => {
    assert.equal(pending, null);
    if (stopped) return reject(new Error('offline PostgreSQL stopped'));
    const id = ++sequence; pending = { id, resolve, reject };
    const direct = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql);
    const rows = /^\s*(SELECT|WITH)\b/i.test(sql) || /^\s*(INSERT|UPDATE|DELETE)\b[\s\S]*\bRETURNING\b/i.test(sql);
    const body = direct ? '' : rows
      ? `FOR r IN EXECUTE ${quote(sql)} LOOP result=result||jsonb_build_array(to_jsonb(r)); END LOOP;`
      : `EXECUTE ${quote(sql)};`;
    child.stdin.write((direct ? sql + ';\n\n' : '') + `DO $bridge$ DECLARE result jsonb='[]'; r record;
      BEGIN ${body} RAISE WARNING 'HOSTED_OFFLINE_${id}:%',result; END $bridge$;\n\n`);
  });
  // postgres.js queues concurrent queries and evaluates nested tagged fragments
  // lazily. Match those transport semantics; PostgreSQL owns every row/decision.
  let queue: Promise<unknown> = Promise.resolve();
  const run = (sql: string) => {
    const result = queue.then(() => execute(sql)); queue = result.catch(() => {}); return result;
  };
  const database = Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = parts.reduce((sql, part, i) => sql + (i ? literal(values[i - 1]) : '') + part, '');
    let result: Promise<Row[]> | undefined;
    const perform = () => result ??= run(fragment);
    return { fragment, then: (...args: Parameters<Promise<Row[]>['then']>) => perform().then(...args),
      cursor: async function* () { yield await perform(); } };
  }, {
    json: (value: unknown) => ({ jsonValue: value }),
    unsafe: (sql: string) => run(sql),
    end: async () => {},
    begin: async (...args: unknown[]) => {
      const mode = args.length > 1 ? String(args[0]) : 'isolation level read committed';
      assert.match(mode, /^isolation level (read committed|serializable)$/i);
      await run('BEGIN ' + mode);
      try { const result = await (args.at(-1) as (db: Sql) => Promise<unknown>)(database as unknown as Sql); await run('COMMIT'); return result; }
      catch (error) { await run('ROLLBACK'); throw error; }
    },
    savepoint: async (fn: (db: Sql) => Promise<unknown>) => {
      const name = 'hosted_offline_' + (++savepoint); await run('SAVEPOINT ' + name);
      try { const result = await fn(database as unknown as Sql); await run('RELEASE SAVEPOINT ' + name); return result; }
      catch (error) { await run('ROLLBACK TO SAVEPOINT ' + name); throw error; }
    },
  });
  const close = async () => {
    try { child.stdin.end(); await ended; }
    finally { execFileSync('rm', ['-rf', directory]); }
  };
  try {
    const [catalog] = await run("SELECT to_regclass('swarm.hosted_mcp_grant_agents') IS NOT NULL AS installed");
    if (!catalog?.installed) await run(repoSql('supabase/migrations/20261028000003_hosted_agent_workspaces.sql'));
    return { db: database as unknown as Sql, close };
  } catch (error) { await close(); throw error; }
}

/** Bundle the same Deno scenario and production entrypoints against the real
 * single-user SQL connection. Any attempted HTTP authentication fails loudly. */
export async function runOfflineHostedCommands(harness: string, db: Sql, directory: string) {
  const globals = globalThis as typeof globalThis & { __hostedOfflineDb?: Sql };
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  const priorFetch = globalThis.fetch;
  globals.__hostedOfflineDb = db;
  const settings: Record<string, string> = { SWARM_ENV: 'test', SWARM_MCP_PUBLIC_ENABLED: '1',
    SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused', SUPABASE_URL: 'https://unused.invalid', SUPABASE_ANON_KEY: 'synthetic' };
  Object.defineProperty(globalThis, 'Deno', { configurable: true, value: { env: { get: (name: string) => settings[name] } } });
  globalThis.fetch = async () => { throw new Error('network requested by offline hosted scenario'); };
  try {
    const result = await build({ entryPoints: [harness], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'offline-hosted-ports', setup(builder) {
        builder.onResolve({ filter: /^file:\/\// }, args => ({ path: new URL(args.path).pathname }));
        builder.onResolve({ filter: /^npm:/ }, args => ({ path: args.path, namespace: 'offline-port' }));
        builder.onLoad({ filter: /.*/, namespace: 'offline-port' }, args => ({ loader: 'js', contents:
          args.path.startsWith('npm:postgres@') ? 'export default function(){return globalThis.__hostedOfflineDb;}'
            : args.path.startsWith('npm:@supabase/supabase-js@')
              ? 'export function createClient(){return {auth:{getUser(){throw new Error("offline auth requested")}}};}'
              : 'throw new Error("unexpected offline dependency");' }));
      } }],
    });
    const path = join(directory, 'commands.mjs'); writeFileSync(path, result.outputFiles[0]!.text);
    await import(pathToFileURL(path).href);
  } finally {
    delete globals.__hostedOfflineDb; globalThis.fetch = priorFetch;
    if (priorDeno) Object.defineProperty(globalThis, 'Deno', priorDeno); else Reflect.deleteProperty(globalThis, 'Deno');
  }
}
