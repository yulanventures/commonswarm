/** X2 lock-order harness (FOLLOW-UPS-C1 #33, #35) for the server-suite files
 * admin-principal-lock-order.test.ts, admin-principal-lock-order-binding.test.ts and
 * hosted-mcp-contract-golden.test.ts.
 *
 * Node side: the explicit target binding (round-C F4, LANE-2-DELTA D1-D2), the target
 * database, the raw-SQL positive control and the Deno launcher. A fixture binding is a
 * restored, non-empty database reached only through db_url over verified TLS (D1, D4);
 * the CI binding gets a throwaway database on the CLI stack.
 * Deno side (this file as the entry point): one race or the golden run against the
 * real command module. It reaches only the bound database; fetch is fenced and the
 * admin JWKS is served in-process. Output is one LOCK_ORDER_RESULT line of codes,
 * statuses and booleans: never SQL text, driver messages, bodies or credentials. */
import { execFileSync, spawn } from 'node:child_process';
import { X509Certificate, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BINDING_ENV = 'C1B_LOCK_ORDER_BINDING';
/** Exact key sets, sorted. A binding file is always a fixture binding (D1.2). */
export const FIXTURE_BINDING_KEYS = Object.freeze(['compose_network', 'compose_project', 'compose_volume', 'db_container_id',
  'db_tls_ca_file', 'db_url', 'mode']);
export const CI_BINDING_KEYS = Object.freeze(['compose_network', 'compose_project', 'compose_volume', 'db_container_id', 'db_url', 'mode']);
/** The fixture publishes one port on this address (D1.3, D1.5). */
export const FIXTURE_HOST = '127.0.0.1';
export const FIXTURE_PROJECT_RE = /^c1b-x2-[a-z0-9]{8}$/u;
export const COMPOSE_LABEL = 'com.docker.compose.project';
/** supabase/cli v2.118.0 (tag object 3a7ba11e, commit 70b42b8b):
 * apps/cli-go/internal/utils/docker.go:59 and :375-376 label every container, network and volume. */
export const CLI_LABEL = 'com.supabase.cli.project';
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
const DATA_DIRECTORY = '/var/lib/postgresql/data';
const CI_ADMIN_ROLE = 'supabase_admin';
const LOCK_TIMEOUT_MS = 5000; // setTransaction (command/index.ts:1601) and adminDbRole (admin-oauth-db.ts:10)

const RACES = Object.freeze({
  'admin-oauth-vs-hosted-claim-seat': { parked: 'hosted', waiting: 'admin' },
  'admin-oauth-vs-local-join-registration': { parked: 'join', waiting: 'admin' },
  'admin-oauth-vs-local-command-creation': { parked: 'local', waiting: 'admin' },
  'accept-invitation-vs-hosted-claim-seat': { parked: 'hosted', waiting: 'accept' },
  'accept-invitation-vs-local-join-registration': { parked: 'join', waiting: 'accept' },
  'remove-member-vs-hosted-claim-seat': { parked: 'hosted', waiting: 'remove' },
  'remove-member-vs-local-join-registration': { parked: 'join', waiting: 'remove' },
  'household-invitation-vs-hosted-claim-seat': { parked: 'hosted', waiting: 'household' },
  'household-invitation-vs-local-join-registration': { parked: 'join', waiting: 'household' },
});

/** A refused target. Callers branch on `code`, never on the message. */
export class LockOrderBindingRefusal extends Error {
  constructor(code) {
    super(`lock-order target refused: ${code}`);
    this.name = 'LockOrderBindingRefusal';
    this.code = code;
  }
}
const refuse = (code) => { throw new LockOrderBindingRefusal(code); };

/** Live staging facts, read from the reviewed compose files rather than retyped. */
export function liveStackFacts(stackCompose, edgeCompose) {
  const project = [...stackCompose.matchAll(/^name:\s*(\S+)\s*$/gmu)].map((m) => m[1]);
  const containers = [...stackCompose.matchAll(/^\s+container_name:\s*(\S+)\s*$/gmu)].map((m) => m[1]);
  const networksAt = stackCompose.search(/^networks:\s*$/mu);
  const network = networksAt === -1 ? [] : [...stackCompose.slice(networksAt).matchAll(/^\s+name:\s*(\S+)\s*$/gmu)].map((m) => m[1]);
  const ports = [...`${stackCompose}\n${edgeCompose}`.matchAll(/"127\.0\.0\.1:(\d+):\d+"/gu)].map((m) => Number(m[1]));
  const dataDir = [...stackCompose.matchAll(/\$\{COMMONSWARM_POSTGRES_DATA_DIR:-([^}]+)\}:\/var\/lib\/postgresql\/data/gu)].map((m) => m[1]);
  // Fail closed: a parse that finds less would silently weaken the refusals.
  if (project.length !== 1 || containers.length < 5 || network.length !== 1 || ports.length < 5 || dataDir.length !== 1) {
    refuse('live_stack_facts_unreadable');
  }
  return Object.freeze({ project: project[0], containers: Object.freeze(containers), network: network[0],
    ports: Object.freeze([...new Set(ports)].sort((a, b) => a - b)), dataDir: dataDir[0] });
}
export function readLiveStackFacts(root = REPO_ROOT) {
  return liveStackFacts(readFileSync(join(root, 'deploy/supabase-stack/compose.yaml'), 'utf8'),
    readFileSync(join(root, 'deploy/edge-runtime/compose.yaml'), 'utf8'));
}
/** The CLI project id, from supabase/config.toml:5. */
export function cliProjectId(configToml) {
  const ids = [...configToml.matchAll(/^project_id\s*=\s*"([^"]+)"\s*$/gmu)].map((m) => m[1]);
  if (ids.length !== 1) refuse('cli_project_id_unreadable');
  return ids[0];
}

/** A 0600 regular file (not a symlink) with exactly FIXTURE_BINDING_KEYS. */
export function readBindingFile(path, fs) {
  if (typeof path !== 'string' || !isAbsolute(path)) refuse('binding_path_not_absolute');
  let stat;
  try { stat = fs.lstatSync(path); } catch { refuse('binding_file_missing'); }
  if (stat.isSymbolicLink()) refuse('binding_file_symlink');
  if (!stat.isFile()) refuse('binding_file_not_regular');
  if ((stat.mode & 0o777) !== 0o600) refuse('binding_file_mode');
  let value;
  try { value = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { refuse('binding_file_invalid'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('binding_file_invalid');
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(FIXTURE_BINDING_KEYS)) refuse('binding_keys');
  return value;
}

/** Value checks that need no Docker. `expect` is { mode: 'fixture' } or { mode: 'ci', project }. */
export function checkBindingShape(binding, live, expect) {
  if (binding.mode !== expect.mode) refuse('binding_mode');
  const keys = expect.mode === 'fixture' ? FIXTURE_BINDING_KEYS : CI_BINDING_KEYS;
  for (const key of keys) if (typeof binding[key] !== 'string' || binding[key] === '') refuse('binding_value');
  if (!/^[0-9a-f]{64}$/u.test(binding.db_container_id)) refuse('container_id_format');
  if (binding.compose_project === live.project) refuse('live_compose_project');
  if (expect.mode === 'fixture' ? !FIXTURE_PROJECT_RE.test(binding.compose_project) : binding.compose_project !== expect.project) {
    refuse('compose_project_not_allowed');
  }
  if (binding.compose_network === live.network) refuse('live_network');
  let url;
  try { url = new URL(binding.db_url); } catch { refuse('db_url_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^\/[A-Za-z_][A-Za-z0-9_]*$/u.test(url.pathname)) refuse('db_url_invalid');
  if (!LOOPBACK_HOSTS.includes(url.hostname)) refuse('endpoint_not_loopback');
  if (!/^\d+$/u.test(url.port)) refuse('endpoint_port_missing');
  if (live.ports.includes(Number(url.port))) refuse('live_published_port');
  if (expect.mode === 'fixture') {
    if (url.hostname !== FIXTURE_HOST) refuse('fixture_endpoint_not_127_0_0_1');
    // TLS with full verification only; postgres.js passes any other parameter to the server.
    const parameters = [...url.searchParams];
    if (parameters.length !== 1 || parameters[0][0] !== 'sslmode' || parameters[0][1] !== 'verify-full') refuse('db_url_tls_not_verify_full');
  }
}

/** D1.2: the fixture's self-signed server certificate, which is also its CA. */
export function readTlsCaFile(path, fs) {
  if (typeof path !== 'string' || !isAbsolute(path)) refuse('tls_ca_path_not_absolute');
  let stat;
  try { stat = fs.lstatSync(path); } catch { refuse('tls_ca_file_missing'); }
  if (stat.isSymbolicLink()) refuse('tls_ca_file_symlink');
  if (!stat.isFile()) refuse('tls_ca_file_not_regular');
  let pem;
  try { pem = fs.readFileSync(path, 'utf8'); } catch { refuse('tls_ca_file_missing'); }
  // Exactly one certificate block and nothing else (no key, no second certificate).
  if (typeof pem !== 'string' || !/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/u.test(pem)) {
    refuse('tls_ca_not_one_pem_certificate');
  }
  try { new X509Certificate(pem); } catch { refuse('tls_ca_not_one_pem_certificate'); }
  return pem.trim() + '\n';
}

function under(path, root) {
  return typeof path === 'string' && (path === root || path.startsWith(`${root}/`));
}

/** Labels, networks, data mount and published port, verified before any SQL. */
export function verifyDockerTarget(binding, live, docker, label) {
  const container = docker.inspectContainer(binding.db_container_id);
  if (!container || container.Id !== binding.db_container_id) refuse('container_id_mismatch');
  const name = String(container.Name ?? '').replace(/^\//u, '');
  if (live.containers.includes(name)) refuse('live_container_name');
  if (container.State?.Running !== true) refuse('container_not_running');
  const labels = container.Config?.Labels ?? {};
  if (labels[COMPOSE_LABEL] === live.project) refuse('live_compose_project');
  if (labels[label] !== binding.compose_project) refuse('container_label_mismatch');
  const networks = Object.keys(container.NetworkSettings?.Networks ?? {}).sort();
  if (networks.includes(live.network)) refuse('live_network');
  if (networks.length !== 1 || networks[0] !== binding.compose_network) refuse('container_network_mismatch');
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  if (mounts.some((mount) => mount.Type === 'bind' && under(mount.Source, live.dataDir))) refuse('live_data_bind_mount');
  const data = mounts.filter((mount) => mount.Destination === DATA_DIRECTORY);
  if (data.length !== 1 || data[0].Type !== 'volume' || data[0].Name !== binding.compose_volume) refuse('data_volume_mismatch');
  const volume = docker.inspectVolume(binding.compose_volume);
  if (!volume || volume.Name !== binding.compose_volume || (volume.Labels ?? {})[label] !== binding.compose_project) refuse('volume_label_mismatch');
  // D2: the project's own network carries the project label (the compose label for a fixture).
  const network = docker.inspectNetwork(binding.compose_network);
  if (!network || network.Name !== binding.compose_network || (network.Labels ?? {})[label] !== binding.compose_project) refuse('network_label_mismatch');
  const ports = container.NetworkSettings?.Ports ?? {};
  if (binding.mode === 'fixture') {
    // D1.5: exactly one published binding, 5432/tcp on 127.0.0.1. Docker reports an exposed,
    // unpublished port as null. The CI path keeps the CLI's own binding (HostPort only, so
    // Docker reports 0.0.0.0 and ::; supabase/cli db/start/start.go:120).
    const bindings = Object.values(ports).flatMap((list) => (Array.isArray(list) ? list : []));
    if (bindings.some((entry) => entry?.HostIp !== FIXTURE_HOST)) refuse('published_host_not_127_0_0_1');
    if (bindings.length > 1) refuse('published_binding_extra');
  }
  const published = (Array.isArray(ports['5432/tcp']) ? ports['5432/tcp'] : []).map((port) => String(port.HostPort));
  if (!published.includes(new URL(binding.db_url).port)) refuse('published_port_mismatch');
}

/** GitHub Actions only: this repository's Supabase CLI project. The CLI names the database
 * container, network and volume from the project id (config.go:57-66, db/start/start.go:120-124);
 * the label filter is the CLI's own project filter (docker.go:155), never a name prefix match. */
export function ciBinding(status, docker, projectId) {
  let url;
  try { url = new URL(String(status?.DB_URL)); } catch { refuse('ci_status_invalid'); }
  // The CLI stack's cluster administrator, as localClusterAdminUrl uses (admin-schema-db.ts:22-27).
  url.username = CI_ADMIN_ROLE;
  const databaseName = `supabase_db_${projectId}`;
  const rows = docker.listByLabel(CLI_LABEL, projectId).filter((row) => row.name === databaseName);
  if (rows.length !== 1) refuse('ci_database_container_not_unique');
  return { mode: 'ci', db_container_id: rows[0].id, db_url: url.toString(), compose_project: projectId,
    compose_network: `supabase_network_${projectId}`, compose_volume: databaseName };
}

/** The only way the lock-order files reach a database. `connector` runs after verification. */
export async function openLockOrderTarget(options) {
  const env = options.env ?? process.env;
  const live = options.live ?? readLiveStackFacts();
  const docker = options.docker ?? realDocker();
  const fs = options.fs ?? { lstatSync, readFileSync };
  let binding;
  let label;
  let tlsCaPem = null;
  if (env[BINDING_ENV] !== undefined) {
    binding = readBindingFile(env[BINDING_ENV], fs);
    checkBindingShape(binding, live, { mode: 'fixture' });
    tlsCaPem = readTlsCaFile(binding.db_tls_ca_file, fs);
    label = COMPOSE_LABEL;
  } else if (env.GITHUB_ACTIONS === 'true') {
    const projectId = options.projectId ?? cliProjectId(readFileSync(join(REPO_ROOT, 'supabase/config.toml'), 'utf8'));
    binding = ciBinding((options.supabaseStatus ?? realSupabaseStatus)(), docker, projectId);
    checkBindingShape(binding, live, { mode: 'ci', project: projectId });
    label = CLI_LABEL;
  } else {
    refuse('binding_required');
  }
  verifyDockerTarget(binding, live, docker, label);
  return await options.connector(Object.freeze({ ...binding }), { docker, tlsCaPem });
}

export function realDocker() {
  const json = (args) => {
    const parsed = JSON.parse(execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return Array.isArray(parsed) ? parsed[0] ?? null : parsed;
  };
  return {
    inspectContainer: (id) => json(['inspect', '--type', 'container', id]),
    inspectVolume: (name) => json(['volume', 'inspect', name]),
    inspectNetwork: (name) => json(['network', 'inspect', name]),
    listByLabel: (key, value) => execFileSync('docker', ['ps', '--no-trunc', '--filter', `label=${key}=${value}`,
      '--format', '{{.ID}}\t{{.Names}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean).map((line) => { const [id, name] = line.split('\t'); return { id, name }; }),
    // The password travels on stdin, never in an argument.
    execWithSecret: (id, script, args, secret) => execFileSync('docker', ['exec', '-i', id, 'sh', '-c', script, 'sh', ...args],
      { encoding: 'utf8', input: `${secret}\n`, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }),
  };
}
export function realSupabaseStatus() {
  // Never print this object: it holds local test credentials.
  return JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
}

/** Test-side TLS for a fixture target (D1.3). postgres.js 3.4.9 leaves the TLS server name
 * unset for an IP host (src/connection.js, secure()), and Node and Deno then verify the name
 * "localhost" (measured: ERR_TLS_CERT_ALTNAME_INVALID against an IP:127.0.0.1 certificate).
 * `host` makes the check use the address actually dialed: verify-full as libpq does it. */
export function tlsClientOptions(target) {
  return target.tlsCaPem === null ? {} : { ssl: { ca: target.tlsCaPem, rejectUnauthorized: true, host: new URL(target.url).hostname } };
}

/** `issuance` is { record, measure, enable }: the reviewed test-only SQL of
 * tests/support/admin-schema-db.ts (recordChecksumEvidenceForTest, measureIssuanceForTest,
 * enableIssuanceForTest). It runs only for the admin races (ensureAdminIssuance). */
export function lockOrderConnector(issuance) {
  return async (binding, { docker, tlsCaPem }) => (binding.mode === 'fixture'
    ? await restoredDatabaseTarget(binding, tlsCaPem, issuance)
    : await isolatedDatabaseTarget(binding, docker, issuance));
}

/** Fixture (D1, D4): the bound database is a fresh restore of c1-staging and is not empty.
 * Every statement goes through db_url over verified TLS; nothing runs inside the container.
 * The tests add only run-unique rows; ensureAdminIssuance (admin races only) changes the
 * cutover singleton and commonswarm_ops.migration_checksums of this disposable restore. */
async function restoredDatabaseTarget(binding, tlsCaPem, issuance) {
  if (typeof tlsCaPem !== 'string') throw new Error('fixture_tls_ca_missing');
  const { default: postgres } = await import('postgres');
  const target = { url: binding.db_url, mode: 'fixture', tlsCaPem };
  const sql = postgres(binding.db_url, { prepare: false, max: 1, onnotice: () => {}, ...tlsClientOptions(target) });
  let present;
  try {
    [present] = await sql`SELECT bool_and(to_regnamespace(s) IS NOT NULL) AS ok
      FROM unnest(${['auth', 'swarm', 'commonswarm_oauth']}::text[]) AS s`;
  } catch (error) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw new Error(`restored_database_unreachable:${failureCode(error)}`);
  }
  if (present?.ok !== true) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw new Error('restored_database_schema_missing');
  }
  return { ...target, ensureAdminIssuance: () => ensureAdminIssuance(sql, issuance), close: () => sql.end({ timeout: 5 }) };
}

const DUMP_SCHEMAS = ['auth', 'swarm', 'swarm_read', 'commonswarm_oauth', 'commonswarm_ops', 'supabase_migrations'];
/** CI only: a throwaway database on the CLI cluster, as adminEdgeDatabase builds one, but from
 * the verified container. Admin issuance opens only inside it; seed rows come from the bound source. */
async function isolatedDatabaseTarget(binding, docker, issuance) {
  if (binding.mode !== 'ci') throw new Error('isolated_database_ci_only');
  const { default: postgres } = await import('postgres');
  const source = new URL(binding.db_url);
  const name = `lock_order_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(binding.db_url);
  target.pathname = `/${name}`;
  const quiet = { prepare: false, max: 1, onnotice: () => {} };
  const master = postgres(binding.db_url, quiet);
  const db = postgres(target.toString(), quiet);
  let created = false;
  const close = async () => {
    try { await db.end({ timeout: 5 }); } finally {
      try {
        if (created) {
          if (!/^lock_order_[a-f0-9]{32}$/u.test(name)) throw new Error('unsafe_database_cleanup');
          await master.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
          created = false;
        }
      } finally { await master.end({ timeout: 5 }); }
    }
  };
  let phase = 'source';
  try {
    const [present] = await master`SELECT bool_and(to_regnamespace(s) IS NOT NULL) AS ok,
      to_regclass('commonswarm_oauth.admin_cutover_state') IS NOT NULL AS cutover
      FROM unnest(${DUMP_SCHEMAS}::text[]) AS s`;
    if (present?.ok !== true || present.cutover !== true) throw new Error('source_schema_missing');
    phase = 'dump';
    const dump = docker.execWithSecret(binding.db_container_id,
      `IFS= read -r PGPASSWORD || true; export PGPASSWORD; exec pg_dump -U "$1" -d "$2" --schema-only --strict-names ${DUMP_SCHEMAS.map((s) => `--schema=${s}`).join(' ')}`,
      [decodeURIComponent(source.username), decodeURIComponent(source.pathname.slice(1))], decodeURIComponent(source.password));
    phase = 'create';
    await master.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`);
    created = true;
    phase = 'restore';
    await db.unsafe(`CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions; GRANT USAGE ON SCHEMA extensions TO PUBLIC;`);
    await db.unsafe(dump.replace(/^\\(?:un)?restrict \S+\r?$/gmu, ''));
    await db.unsafe('RESET ALL');
    phase = 'seed';
    // A schema-only copy has no seed rows; the command paths read swarm.config (min_client_version).
    const config = await master`SELECT key, value::text AS value FROM swarm.config ORDER BY key`;
    const wake = await master`SELECT applied_at FROM swarm.wake_path_release`;
    await db.begin(async (tx) => {
      for (const row of config) await tx`INSERT INTO swarm.config (key, value) VALUES (${row.key}, ${row.value}::jsonb)`;
      for (const row of wake) await tx`INSERT INTO swarm.wake_path_release (singleton, applied_at) VALUES (true, ${row.applied_at})`;
      await tx`INSERT INTO commonswarm_oauth.admin_cutover_state(singleton) VALUES(true)`;
    });
    return { url: target.toString(), mode: binding.mode, tlsCaPem: null, ensureAdminIssuance: () => ensureAdminIssuance(db, issuance), close };
  } catch (error) {
    try { await close(); } catch { /* the setup failure below is the result */ }
    throw new Error(`isolated_database_setup_failed:${phase}:${sqlstate(error)}`);
  }
}

export const ADMIN_ISSUANCE_OPEN = Object.freeze(['already_open', 'opened', 'opened_with_restored_checksums']);
/** The OAuth admin path runs only while issuance is open and legacy admin is closed
 * (admin_access_is_active and the audit and issuance guards,
 * supabase/migrations/20261003000003_admin_oauth_cutover.sql). So the three admin races, and
 * only they, depend on the cutover singleton and on commonswarm_ops.migration_checksums (D4).
 * Recorded checksums are kept when the target already has some; the enable step's own gate
 * (migration_checksum_failures) then compares them. A refusal returns a code, never 40P01. */
async function ensureAdminIssuance(sql, issuance) {
  try {
    return await sql.begin(async (tx) => {
      const [state] = await tx`SELECT admin_issuance_enabled AND legacy_closed AS open
        FROM commonswarm_oauth.admin_cutover_state WHERE singleton`;
      if (state === undefined) return 'cutover_singleton_missing';
      if (state.open === true) return 'already_open';
      const [evidence] = await tx`SELECT count(*)::int AS n FROM commonswarm_ops.migration_checksums`;
      if (evidence.n === 0) await tx.unsafe(issuance.record);
      await tx.unsafe(issuance.measure);
      await tx.unsafe(issuance.enable);
      return evidence.n === 0 ? 'opened' : 'opened_with_restored_checksums';
    });
  } catch (error) {
    return `open_failed:${failureCode(error)}`;
  }
}

export function sqlstate(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? code : 'non_sql';
}
/** Setup diagnostics only: a SQLSTATE, or a driver, TLS or socket error code. Never a message. */
export function failureCode(error) {
  const state = sqlstate(error);
  if (state !== 'non_sql') return state;
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ? code : 'non_sql';
}

/** LANE-2-DELTA D3: the tree under test, printed once by the race file before its first test. */
export function migrationTreeLine(git = (args) => execFileSync('git', ['-C', REPO_ROOT, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
  try {
    const head = git(['rev-parse', 'HEAD']);
    const migrations = git(['rev-parse', 'HEAD:supabase/migrations']);
    if (/^[0-9a-f]{40}$/u.test(head) && /^[0-9a-f]{40}$/u.test(migrations)) {
      return `C1B_LOCK_ORDER_TREE head=${head} migrations=${migrations}`;
    }
  } catch { /* reported below */ }
  return 'C1B_LOCK_ORDER_TREE unavailable';
}

function secretDirectory() {
  const root = realpathSync(process.platform === 'darwin' ? '/private/tmp' : tmpdir());
  const dir = execFileSync('mktemp', ['-d', join(root, 'anvil-secret.XXXXXX')], { encoding: 'utf8' }).trim();
  chmodSync(dir, 0o700);
  return { root, dir };
}
function removeSecretDirectory({ root, dir }) {
  const resolved = realpathSync(dir);
  if (dirname(resolved) !== root || !basename(resolved).startsWith('anvil-secret.') || resolved === process.env.HOME) {
    throw new Error('unsafe_cleanup_path');
  }
  execFileSync('rm', ['-r', resolved], { stdio: 'ignore' });
}

/** Runs one Deno scenario against the target. Only LOCK_ORDER_ lines are read back. */
export async function runScenario(target, scenario, timeoutMs = 170_000) {
  let adminIssuance = null;
  if (RACES[scenario]?.waiting === 'admin') {
    adminIssuance = await target.ensureAdminIssuance();
    if (!ADMIN_ISSUANCE_OPEN.includes(adminIssuance)) return { scenario, stage: 'admin_issuance', error: adminIssuance };
  }
  const secret = secretDirectory();
  try {
    const configPath = join(secret.dir, 'target.json');
    writeFileSync(configPath, JSON.stringify({ db_url: target.url, tls_ca_pem: target.tlsCaPem }), { mode: 0o600 });
    const env = { PATH: process.env.PATH ?? '', NO_COLOR: '1' };
    for (const key of ['HOME', 'DENO_DIR', 'XDG_CACHE_HOME']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn('deno', ['run', '--no-lock', '--config', join(REPO_ROOT, 'supabase/functions/command/deno.json'),
      '--allow-read', '--allow-env', '--allow-net', fileURLToPath(import.meta.url), configPath, scenario],
    { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    const line = stdout.split('\n').reverse().find((entry) => entry.startsWith('LOCK_ORDER_RESULT '));
    if (line === undefined) return { scenario, stage: 'no_result', exit_code: exit.code, signal: exit.signal };
    const result = JSON.parse(line.slice('LOCK_ORDER_RESULT '.length));
    return adminIssuance === null ? result : { ...result, admin_issuance: adminIssuance };
  } finally {
    removeSecretDirectory(secret);
  }
}

async function waitForBlocked(sql, holderPid, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql`SELECT pid FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if (rows.length === 1 && await check(Number(rows[0].pid))) return Number(rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}
const tupleOnStreams = (sql) => async (pid) => (await sql`SELECT EXISTS (SELECT 1 FROM pg_locks
  WHERE pid = ${pid}::int AND locktype = 'tuple' AND relation = 'swarm.streams'::regclass) AS ok`)[0].ok === true;

/** Raw SQL in the base order, independent of the edge source: session one holds the owner and
 * workspace FOR UPDATE and waits for the stream; session two holds the stream and inserts an
 * agent_principals row for that owner and workspace. PostgreSQL must break the cycle with 40P01. */
export async function rawSqlPositiveControl(target) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(target.url, { prepare: false, max: 4, onnotice: () => {}, ...tlsClientOptions(target) });
  const result = { stage: 'fixture', tls: target.tlsCaPem === null ? 'none' : 'verify-full' };
  const discard = Symbol('discard');
  try {
    // D4: every row this control creates has ids and names unique to the run.
    const owner = randomUUID(), workspace = randomUUID(), stream = randomUUID(), tag = owner.slice(0, 8);
    await sql.begin(async (tx) => {
      await tx`INSERT INTO auth.users (id, aud, role, email) VALUES (${owner}::uuid, 'authenticated', 'authenticated', ${`control-${owner}@example.test`})`;
      await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner}::uuid, ${`Lock-order control ${tag}`})`;
      await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, ${`Lock-order control ${tag}`}, ${owner}::uuid)`;
      await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${stream}::uuid, ${workspace}::uuid, 'workspace')`;
    });
    const [timing] = await sql`SELECT setting::int AS ms FROM pg_settings WHERE name = 'deadlock_timeout'`;
    result.deadlock_timeout_ms = Number(timing?.ms);
    result.lock_timeout_ms = 10_000;
    const gate = () => { let open; const opened = new Promise((resolve) => { open = resolve; }); return { open, opened }; };
    const streamHeld = gate(), insertNow = gate(), rowsHeld = gate();
    let creatorPid = 0, holderPid = 0;
    const settle = (promise) => promise.then(() => ({ code: null }), (error) => ({ code: error === discard ? null : sqlstate(error) }));
    result.stage = 'creator-stream';
    const creator = settle(sql.begin(async (tx) => {
      await tx`SELECT set_config('lock_timeout', '10s', true)`;
      creatorPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await tx`SELECT head_seq FROM swarm.streams WHERE stream_id = ${stream}::uuid FOR UPDATE`;
      streamHeld.open();
      await insertNow.opened;
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        VALUES (${randomUUID()}::uuid, ${workspace}::uuid, ${owner}::uuid, ${`control-principal-${tag}`})`;
      throw discard;
    }));
    await streamHeld.opened;
    result.stage = 'holder-rows';
    const holder = settle(sql.begin(async (tx) => {
      await tx`SELECT set_config('lock_timeout', '10s', true)`;
      holderPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await tx`SELECT user_id FROM swarm.users WHERE user_id = ${owner}::uuid FOR UPDATE`;
      await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id = ${workspace}::uuid FOR UPDATE`;
      rowsHeld.open();
      await tx`SELECT head_seq FROM swarm.streams WHERE stream_id = ${stream}::uuid FOR UPDATE`;
      throw discard;
    }));
    await rowsHeld.opened;
    result.stage = 'holder-waits-for-stream';
    const waiting = await waitForBlocked(sql, creatorPid, async (pid) => pid === holderPid && await tupleOnStreams(sql)(pid));
    result.holder_waits_on_stream = waiting === holderPid;
    if (!result.holder_waits_on_stream) { insertNow.open(); await Promise.all([creator, holder]); return result; }
    result.stage = 'creator-inserts';
    insertNow.open();
    const outcomes = await Promise.race([Promise.all([creator, holder]),
      new Promise((resolve) => setTimeout(() => resolve(null), 30_000))]);
    if (outcomes === null) { result.stage = 'control-timeout'; return result; }
    result.sqlstates = outcomes.map((outcome) => outcome.code).filter((code) => code !== null);
    result.stage = 'complete';
    return result;
  } catch (error) {
    result.error = failureCode(error);
    return result;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/* ---------------------------------------------------------------------------------------
 * Deno side. Everything below runs only as `deno run <this file> <config> <scenario>`.
 * --------------------------------------------------------------------------------------- */

class HarnessStage extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new HarnessStage(code); };
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const id = () => randomUUID();
const ADMIN_JWKS_URL = 'https://mcp.commonswarm.com/jwks';

/** Fixture mode (D1.3). The command module's TLS options carry only the CA
 * (_shared/database-options.ts), and postgres.js 3.4.9 leaves the server name unset for an IP
 * host, so Deno would verify the name "localhost". This process gives tls.connect the dialed
 * address instead: full verification against the certificate's IP:127.0.0.1. Measured locally
 * with Deno 2.9.4: without it, ERR_TLS_CERT_ALTNAME_INVALID; with it, the handshake succeeds
 * and a wrong CA is still refused. */
async function verifyTlsAgainstDialedAddress(host) {
  const tls = (await import('node:tls')).default;
  const connect = tls.connect;
  tls.connect = function (options, ...rest) {
    if (options !== null && typeof options === 'object' && options.socket !== undefined
      && options.servername === undefined && options.host === undefined) {
      return connect.call(this, { ...options, host }, ...rest);
    }
    return connect.call(this, options, ...rest);
  };
}

async function denoMain() {
  const [configPath, scenario] = Deno.args;
  const out = { scenario, stage: 'config' };
  const http = { refused: 0 };
  const jwks = { body: null };
  let exitCode = 0;
  try {
    const config = JSON.parse(await Deno.readTextFile(configPath));
    const host = new URL(config.db_url).hostname;
    if (!LOOPBACK_HOSTS.includes(host)) fail('target_not_loopback');
    for (const hook of ['SWARM_CMD_TEST_SLEEP_AFTER_STEP', 'SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP']) {
      if (Deno.env.get(hook) !== undefined) fail('test_hook_set');
    }
    Deno.env.set('SWARM_ENV', 'test');
    Deno.env.set('SWARM_DATABASE_URL', config.db_url);
    Deno.env.delete('SUPABASE_DB_URL');
    // D1.3: a fixture is reached only over TLS with full verification, by the command module
    // (SWARM_DATABASE_TLS_CA_B64, read at import) and by this process's own observer.
    let ssl = {};
    if (typeof config.tls_ca_pem === 'string') {
      if (host !== FIXTURE_HOST) fail('fixture_endpoint_not_127_0_0_1');
      Deno.env.set('SWARM_DATABASE_TLS_CA_B64', btoa(config.tls_ca_pem));
      await verifyTlsAgainstDialedAddress(host);
      ssl = { ssl: { ca: config.tls_ca_pem, rejectUnauthorized: true, host } };
      out.tls = 'verify-full';
    } else {
      Deno.env.delete('SWARM_DATABASE_TLS_CA_B64');
      out.tls = 'none';
    }
    // No path in these files uses the API: a reserved host, and a fence on fetch.
    Deno.env.set('SUPABASE_URL', 'http://lock-order.invalid');
    Deno.env.set('SUPABASE_ANON_KEY', 'lock-order-no-api');
    Deno.env.set('SWARM_COMMAND_ALLOWED_ORIGINS', 'https://commonswarm.com');
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === ADMIN_JWKS_URL && jwks.body !== null) {
        const response = new Response(jwks.body);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      http.refused += 1;
      throw new TypeError('lock-order harness has no network access');
    };
    out.stage = 'import';
    const { default: postgres } = await import('npm:postgres@3.4.9');
    const observer = postgres(config.db_url, { prepare: false, max: 4, idle_timeout: 5, connect_timeout: 10, onnotice: () => {}, ...ssl });
    const command = await import('../../supabase/functions/command/index.ts');
    const { db } = command;
    // Every command-module transaction (admin, hosted, join and ordinary) runs through db.begin.
    // Record the SQLSTATE of each rejected one while a race is open; no message is read.
    const failures = { recording: false, codes: [] };
    const begin = db.begin;
    db.begin = function (...args) {
      return begin.apply(this, args).catch((error) => {
        if (failures.recording) failures.codes.push(sqlstate(error));
        throw error;
      });
    };
    out.stage = 'sqlstate-capture-control';
    failures.recording = true;
    await db.begin((tx) => tx`SELECT 1 / 0`).catch(() => {});
    failures.recording = false;
    out.sqlstate_capture_control = failures.codes.join(',');
    if (out.sqlstate_capture_control !== '22012') fail('sqlstate_capture_control_failed');
    failures.codes.length = 0;
    const [timing] = await observer`SELECT setting::int AS ms FROM pg_settings WHERE name = 'deadlock_timeout'`;
    out.deadlock_timeout_ms = Number(timing?.ms);
    out.lock_timeout_ms = LOCK_TIMEOUT_MS;
    if (!(out.deadlock_timeout_ms < LOCK_TIMEOUT_MS)) fail('deadlock_timeout_not_below_lock_timeout');
    // A restored target keeps its own minimum (D4); no command path branches on client_version
    // except this minimum (command/index.ts swarm.config reads).
    const [minimum] = await observer`SELECT value #>> '{}' AS version FROM swarm.config WHERE key = 'min_client_version'`;
    if (typeof minimum?.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(minimum.version)) fail('min_client_version_unreadable');
    out.client_version = minimum.version;
    // D4: names and ids unique to this run (fresh workspace, users and grants per scenario).
    const ctx = { command, db, observer, failures, jwks, out, tag: randomUUID().replaceAll('-', '').slice(0, 10), clientVersion: minimum.version };
    const result = scenario === 'golden' ? await golden(ctx) : await raceScenario(ctx, scenario);
    out.stage = 'complete';
    console.log('LOCK_ORDER_RESULT ' + JSON.stringify({ ...out, ...result, http_refused: http.refused }));
  } catch (error) {
    exitCode = 1;
    console.log('LOCK_ORDER_RESULT ' + JSON.stringify({ ...out,
      error: error instanceof HarnessStage ? error.code : failureCode(error), http_refused: http.refused }));
  }
  Deno.exit(exitCode);
}

async function human(ctx, label) {
  const userId = id(), email = `lock-${label}-${userId}@example.test`, displayName = `Lock ${label} ${ctx.tag}`;
  await ctx.observer`INSERT INTO auth.users (id, aud, role, email) VALUES (${userId}::uuid, 'authenticated', 'authenticated', ${email})`;
  await ctx.observer`INSERT INTO swarm.users (user_id, display_name, email) VALUES (${userId}::uuid, ${displayName}, ${email})`;
  return { userId, email, identity: { userId, email, displayName, identityVerified: true, interactiveAuthAtSeconds: null } };
}
async function workspace(ctx, owner, household) {
  const workspaceId = id(), streamId = id();
  await ctx.observer.begin(async (tx) => {
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspaceId}::uuid, ${`Lock-order race ${ctx.tag}`}, ${owner.userId}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspaceId}::uuid, ${owner.userId}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${streamId}::uuid, ${workspaceId}::uuid, 'workspace')`;
    if (household) await tx`INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose) VALUES (${workspaceId}::uuid, 'shared')`;
  });
  return { workspaceId, streamId };
}
const member = (ctx, workspaceId, user, role) =>
  ctx.observer`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspaceId}::uuid, ${user.userId}::uuid, ${role})`;
const summary = (result) => ({ status: result.status, body_status: result.body?.status ?? null, error: result.body?.error ?? null });
const manage = (ctx, user, workspaceId, body) => ctx.command.handleHostedManagementCommand({
  command_id: id(), client_version: ctx.clientVersion,
  ...(workspaceId === null ? {} : { workspace_id: workspaceId, stream: { kind: 'workspace' } }), command: body,
}, user.identity);
const principalLive = async (ctx, workspaceId, name) => (await ctx.observer`SELECT count(*)::int AS n FROM swarm.agent_principals
  WHERE workspace_id = ${workspaceId}::uuid AND name = ${name} AND revoked_at IS NULL`)[0].n === 1;

async function hostedGrant(ctx, owner, workspaceId, otherWorkspaceIds = []) {
  const grantId = id();
  await ctx.observer.begin(async (tx) => {
    await tx`INSERT INTO swarm.hosted_mcp_grants (grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
      selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at)
      VALUES (${grantId}::uuid, ${`provider-${grantId}`}, ${owner.userId}::uuid, ${workspaceId}::uuid, ${`lock-order-client-${ctx.tag}`},
        'https://mcp.commonswarm.com/mcp', ${[workspaceId, ...otherWorkspaceIds]}::uuid[], ${new Uint8Array(32).fill(7)},
        ${`interaction-${grantId}`}, 'active', statement_timestamp(), statement_timestamp())`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at)
      VALUES (${grantId}::uuid, ${workspaceId}::uuid, ${owner.userId}::uuid, ${new Uint8Array(32).fill(7)}, ${id()}::uuid, statement_timestamp())`;
  });
  return { grantId, providerGrantId: `provider-${grantId}` };
}

/** Creation sides: each holds the workspace stream and parks on the principal-ceiling
 * advisory lock (command/index.ts:5914), taken after the stream by all three paths. */
async function creationSide(ctx, kind, fixture) {
  const { owner, workspaceId } = fixture;
  if (kind === 'hosted') {
    const { authenticateHostedGrantCapability } = await import('../../supabase/functions/_shared/hosted-seat-auth.ts');
    const grant = await hostedGrant(ctx, owner, workspaceId);
    const capability = await ctx.db.begin((tx) => authenticateHostedGrantCapability(tx, {
      grantId: grant.grantId, ownerUserId: owner.userId, providerGrantId: grant.providerGrantId,
      workspaceId, tool: 'claim_hosted_seat', providerStatus: async () => ({ active: true }),
    }));
    if (capability === null) fail('hosted_capability_refused');
    const claim = async (name) => {
      const result = await ctx.command.handleHostedCommand({ command_id: id(), client_version: ctx.clientVersion, workspace_id: workspaceId,
        stream: { kind: 'workspace' }, command: { kind: 'claim_hosted_seat', name } }, capability);
      return { ...summary(result), ok: result.status === 200 && result.body?.status === 'accepted' && typeof result.body?.handle === 'string' };
    };
    const name = `race-hosted-seat-${ctx.tag}`;
    return { name, warm: () => claim(`warm-hosted-seat-${ctx.tag}`), start: () => claim(name) };
  }
  if (kind === 'join') {
    const minted = await manage(ctx, owner, workspaceId, { kind: 'mint_agent_join_credential', seat_cap: 2, ttl_hours: 4 });
    if (minted.status !== 200 || typeof minted.body?.join_credential !== 'string') fail('join_credential_mint_refused');
    const credential = minted.body.join_credential;
    const register = async (name) => {
      const response = await ctx.command.handleRequest(new Request('http://127.0.0.1/functions/v1/command', {
        method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ command_id: id(), client_version: ctx.clientVersion, workspace_id: workspaceId, stream: { kind: 'workspace' },
          command: { kind: 'register_agent_seat', attempt_id: id(), name } }),
      }));
      const result = { status: response.status, body: await response.json() };
      return { ...summary(result), ok: result.status === 200 && result.body?.status === 'accepted' };
    };
    const name = `race-join-seat-${ctx.tag}`;
    return { name, warm: () => register(`warm-join-seat-${ctx.tag}`), start: () => register(name) };
  }
  // A member, not the owner: the owner's own users-row upsert (index.ts:3076) would
  // serialize it with the admin owner lock before the stream, so no cycle could form.
  const creator = await human(ctx, 'member');
  await member(ctx, workspaceId, creator, 'member');
  const create = async (name) => {
    const result = await manage(ctx, creator, workspaceId, { kind: 'create_agent_principal', name });
    return { ...summary(result), ok: result.status === 200 && result.body?.status === 'accepted' };
  };
  const name = `race-local-seat-${ctx.tag}`;
  return { name, warm: () => create(`warm-local-seat-${ctx.tag}`), start: () => create(name) };
}

/** Lock-holding sides: each takes the owner and/or workspace row, then waits for the stream. */
async function holderSide(ctx, kind, fixture) {
  const { owner, workspaceId } = fixture;
  if (kind === 'admin') return await adminSide(ctx, fixture);
  if (kind === 'accept') {
    const invitee = await human(ctx, 'invitee');
    const invited = await manage(ctx, owner, workspaceId, { kind: 'invite_member', email: invitee.email });
    if (invited.status !== 200 || typeof invited.body?.invitation_token !== 'string') fail('invitation_refused');
    const token = invited.body.invitation_token;
    return {
      start: async () => {
        const result = await manage(ctx, invitee, null, { kind: 'accept_invitation', token });
        return { ...summary(result), ok: result.status === 200 && result.body?.status === 'accepted' };
      },
      writes: async () => ({ invitee_membership_live: (await ctx.observer`SELECT count(*)::int AS n FROM swarm.memberships
        WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${invitee.userId}::uuid AND revoked_at IS NULL`)[0].n === 1 }),
    };
  }
  if (kind === 'remove') {
    const removed = await human(ctx, 'removed');
    await member(ctx, workspaceId, removed, 'member');
    return {
      start: async () => {
        const result = await manage(ctx, owner, workspaceId, { kind: 'remove_member', user_id: removed.userId });
        return { ...summary(result), ok: result.status === 200 && result.body?.status === 'accepted' };
      },
      writes: async () => ({ removed_membership_revoked: (await ctx.observer`SELECT count(*)::int AS n FROM swarm.memberships
        WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${removed.userId}::uuid AND revoked_at IS NOT NULL`)[0].n === 1 }),
    };
  }
  // The household invitation preview takes the same locks as accept (household-invitations.ts:32-45)
  // before its decision. Accept's preview digest includes head_seq (:54-56), so a correct accept
  // after a concurrent seat claim is 409 review_changed by design; preview is deterministic.
  const recipient = await human(ctx, 'recipient');
  const token = `swm_inv_${base64url(randomBytes(32))}`;
  const tokenHash = new Uint8Array(createHash('sha256').update(token).digest());
  await ctx.observer`INSERT INTO swarm.invitations (invitation_id, workspace_id, email, role, token_hash, created_by, created_at, expires_at)
    VALUES (${id()}::uuid, ${workspaceId}::uuid, ${recipient.email}, 'member', ${tokenHash}, ${owner.userId}::uuid,
      clock_timestamp(), clock_timestamp() + interval '1 day')`;
  const preview = async () => {
    const result = await manage(ctx, recipient, null, { kind: 'household_invitation', action: 'preview', invitation: { source: 'link', token } });
    return { ...summary(result), ok: result.status === 200 && result.body?.status === 'preview' };
  };
  return { warm: preview, start: preview, writes: async () => ({}) };
}

async function adminSide(ctx, fixture) {
  const { owner, workspaceId } = fixture;
  const policy = await import('../../supabase/functions/_shared/protocol.js');
  const { adminTransaction } = await import('../../supabase/functions/command/admin-delegation.ts');
  const { oauthFixture } = await import('./admin-edge-oauth-fixture.mjs');
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', signing.publicKey), kid: `lock-order-${ctx.tag}`, alg: 'ES256', use: 'sig' };
  ctx.jwks.body = JSON.stringify({ keys: [jwk] });
  const humanAuth = { kind: 'human', identity: { user_id: owner.userId, session_binding: 'a'.repeat(64),
    interactive_at_seconds: Date.now() / 1000, csrf_verified: true } };
  const wire = (command, commandId = id()) => ({ command_id: commandId, stream: { kind: 'account' }, resource: policy.ADMIN_RESOURCE, command });
  const transact = (input) => ctx.db.begin(async (tx) => {
    await tx`SELECT set_config('role', 'swarm_command', true), set_config('search_path', 'swarm, pg_catalog', true)`;
    return await adminTransaction(tx, input, humanAuth);
  });
  const now = Date.now(), connection = id();
  const scopeNames = policy.adminConsentOptions().filter((option) => option.available).map((option) => option.scope);
  const manifest = {
    connection_id: connection, client_id: `lock-order-runtime-${ctx.tag}`, resource: policy.ADMIN_RESOURCE, mode: 'granular',
    registry_version: policy.ADMIN_REGISTRY_VERSION, scope_names: scopeNames,
    capability_names: policy.adminAvailableCapabilities(scopeNames),
    availability_digest: policy.adminAvailabilityDigest(policy.ADMIN_REGISTRY_VERSION),
    workspace_selector: 'selected', workspace_ids: [workspaceId],
    created_workspace_policy: { scope_names: ['seats:create', 'seats:revoke'] },
    target_rules: { seat_ids: [], own_seats: true, grant_created_seats: true, recipient_user_ids: [owner.userId],
      recipient_connection_ids: [connection], transports: ['local', 'hosted_mcp'] },
    worker_scope_ceiling: ['post_signal'], role_ceiling: 'member',
    renewal_limits: { ...policy.ADMIN_RENEWAL_CEILINGS, grant_kinds: ['timeboxed', 'standing'], principal_ids: [],
      successors_per_worker: 2, successors_per_grant: 2 },
    issuance_limits: { ...policy.ADMIN_ISSUANCE_CEILINGS, workspaces: 1 },
    expires_at: now + 86400000, refresh_deadline: now + 86400000,
  };
  const prepared = (await transact(wire({ kind: 'prepare_admin_consent', manifest, full_account_selected: false }))).result;
  if (prepared.status !== 200) fail('admin_consent_refused');
  const grant = id();
  const activated = (await transact(wire({ kind: 'grant_admin_delegation', grant_id: grant,
    consent_receipt_id: prepared.body.consent_receipt_id, replaces_grant_id: null }))).result;
  if (activated.status !== 200) fail('admin_grant_refused');
  const oauth = await oauthFixture(ctx.db, grant, signing, jwk.kid);
  // The DPoP request is built before the race so the parked side waits only for the edge path.
  const armed = async (name) => {
    const input = wire({ kind: 'admin_create_seat', grant_id: grant, workspace_id: workspaceId, name, model: null, transport: 'local' });
    return { input, request: await oauth.request(input) };
  };
  const send = async ({ input, request }) => {
    const response = await ctx.command.handleRequest(request);
    const result = { status: response.status, body: await response.json() };
    return { ...summary(result), command_id: input.command_id,
      ok: result.status === 200 && Array.isArray(result.body?.events) && result.body.events.some((event) => event.type === 'AdminSeatCreated') };
  };
  const audit = async (commandId) => (await ctx.observer`SELECT outcome FROM commonswarm_oauth.admin_oauth_audit
    WHERE admin_grant_id = ${grant}::uuid AND request_id = ${commandId} ORDER BY occurred_at, audit_id`).map((row) => row.outcome);
  let race = null;
  const name = `race-admin-seat-${ctx.tag}`;
  return {
    name,
    warm: async () => {
      const warmed = await send(await armed(`warm-admin-seat-${ctx.tag}`));
      return { ...warmed, audit: await audit(warmed.command_id) };
    },
    arm: async () => { race = await armed(name); },
    start: () => send(race),
    writes: async () => ({ admin_principal_live: await principalLive(ctx, workspaceId, name) }),
    audit: () => audit(race.input.command_id),
  };
}

const settleSide = (promise) => promise.then((value) => value, (error) => ({ ok: false, thrown: sqlstate(error) }));

async function raceScenario(ctx, scenario) {
  const race = RACES[scenario];
  if (race === undefined) fail('unknown_scenario');
  const { out, observer, failures } = ctx;
  out.stage = 'fixture';
  const owner = await human(ctx, 'owner');
  const { workspaceId } = await workspace(ctx, owner, race.waiting === 'household');
  const fixture = { owner, workspaceId };
  const creator = await creationSide(ctx, race.parked, fixture);
  const holder = await holderSide(ctx, race.waiting, fixture);
  out.stage = 'warm-up';
  const warmCreation = await creator.warm();
  if (!warmCreation.ok) { out.warm_creation = warmCreation; fail('creation_positive_control_failed'); }
  if (holder.warm) {
    const warmHolder = await holder.warm();
    if (!warmHolder.ok || (warmHolder.audit && warmHolder.audit.join(',') !== 'committed')) {
      out.warm_holder = warmHolder;
      fail('holder_positive_control_failed');
    }
  }
  if (holder.arm) await holder.arm();
  out.stage = 'blocker';
  let releaseBlocker;
  const released = new Promise((resolve) => { releaseBlocker = resolve; });
  let blockerReady;
  const ready = new Promise((resolve) => { blockerReady = resolve; });
  let blockerPid = 0;
  const blocker = observer.begin(async (tx) => {
    await tx`SELECT set_config('lock_timeout', '30s', true)`;
    blockerPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}::text), hashtext('principal-ceiling'))`;
    blockerReady();
    await released;
  });
  await ready;
  const parking = {};
  out.parking = parking;
  failures.codes.length = 0;
  failures.recording = true;
  let parked = null;
  let waiting = null;
  try {
    out.stage = 'park-creation';
    parked = settleSide(creator.start());
    const parkedPid = await waitForBlocked(observer, blockerPid, async (pid) => (await observer`SELECT EXISTS (SELECT 1 FROM pg_locks
      WHERE pid = ${pid}::int AND locktype = 'advisory' AND NOT granted) AS ok`)[0].ok === true);
    parking.creation_waits_on_ceiling_after_stream = parkedPid !== null;
    if (parkedPid === null) fail('creation_did_not_park');
    out.stage = 'park-holder';
    waiting = settleSide(holder.start());
    const waitingPid = await waitForBlocked(observer, parkedPid, tupleOnStreams(observer));
    parking.holder_waits_on_stream_held_by_creation = waitingPid !== null;
    if (waitingPid === null) fail('holder_did_not_wait_for_stream');
  } finally {
    out.stage = 'release';
    releaseBlocker();
    await blocker.catch(() => {});
  }
  const sides = await Promise.race([Promise.all([parked, waiting]), new Promise((resolve) => setTimeout(() => resolve(null), 60_000))]);
  failures.recording = false;
  if (sides === null) fail('race_timeout');
  out.stage = 'writes';
  const result = {
    parked: { side: race.parked, ...sides[0] },
    waiting: { side: race.waiting, ...sides[1] },
    sqlstates: [...failures.codes],
    writes: { creation_principal_live: await principalLive(ctx, workspaceId, creator.name), ...await holder.writes() },
  };
  if (holder.audit) result.admin_audit = await holder.audit();
  return result;
}

/** Golden run: the real MCP protocol module and tool rendering over the real claim and read
 * backends. executeTool mirrors supabase/functions/mcp/index.ts:235-279 for claim_seat and whoami. */
async function golden(ctx) {
  const { out, observer, command } = ctx;
  out.stage = 'golden-fixture';
  const { createMcpProtocolHandler } = await import('../../supabase/functions/mcp/protocol.ts');
  const { MCP_ISSUER, MCP_RESOURCE } = await import('../../supabase/functions/mcp/auth.ts');
  const { executeClaimSeat } = await import('../../supabase/functions/mcp/claim-seat.ts');
  const { commandOutput, readOutput, HostedToolFailure } = await import('../../supabase/functions/mcp/tool-errors.ts');
  const { authenticateHostedSeatCapability } = await import('../../supabase/functions/_shared/hosted-seat-auth.ts');
  const read = await import('../../supabase/functions/read/index.ts');
  const owner = await human(ctx, 'golden-owner');
  const { workspaceId } = await workspace(ctx, owner, false);
  const other = await workspace(ctx, owner, false);
  const grant = await hostedGrant(ctx, owner, workspaceId);
  const taken = await manage(ctx, owner, workspaceId, { kind: 'create_agent_principal', name: 'golden-taken' });
  if (taken.status !== 200 || taken.body?.status !== 'accepted') fail('golden_local_principal_refused');
  const setRole = (tx, role) => tx`SELECT set_config('role', ${role}, true),
    set_config('search_path', 'swarm, commonswarm_oauth, pg_catalog', true),
    set_config('lock_timeout', '5s', true), set_config('statement_timeout', '10s', true)`;
  const providerStatus = async () => ({ active: true });
  const executeTool = async (call) => {
    if (call.name === 'claim_seat') {
      return commandOutput(await executeClaimSeat(call, {
        withAuthTransaction: (run) => observer.begin('isolation level read committed', async (tx) => { await setRole(tx, 'swarm_command'); return await run(tx); }),
        providerStatus,
        handleCommand: (input, capability) => command.handleHostedCommand(input, capability),
      }));
    }
    if (call.name !== 'whoami') throw new HostedToolFailure('tool_failed');
    const handle = String(call.arguments.seat);
    const binding = await observer.begin('isolation level read committed', async (tx) => {
      await setRole(tx, 'swarm_command');
      const rows = await tx`SELECT g.grant_id, g.owner_user_id, h.workspace_id, h.handle
        FROM swarm.hosted_mcp_grants AS g JOIN swarm.hosted_mcp_seat_handles AS h ON h.grant_id = g.grant_id
        WHERE g.provider_grant_id = ${call.token.providerGrantId} AND g.owner_user_id = ${call.token.subject}::uuid AND h.handle = ${handle}
        LIMIT 2`;
      return rows.length === 1 ? rows[0] : null;
    });
    if (binding === null) throw new HostedToolFailure('hosted_seat_forbidden');
    const capability = await observer.begin('isolation level read committed', async (tx) => {
      await setRole(tx, 'swarm_read');
      return await authenticateHostedSeatCapability(tx, { grantId: binding.grant_id, providerGrantId: call.token.providerGrantId,
        handle: binding.handle, tool: 'whoami', providerStatus }, 'read');
    });
    if (capability === null) throw new HostedToolFailure('hosted_seat_forbidden');
    const output = readOutput(await read.handleHostedRead({ resource: 'whoami', workspace_id: binding.workspace_id }, capability));
    return { grant_id: output.grant_id, seat_id: output.seat_id, handle: output.handle, workspace_id: output.workspace_id,
      principal_id: output.principal_id, name: output.name, transport: output.transport, turn_only: output.turn_only };
  };
  const serve = createMcpProtocolHandler({
    issuer: MCP_ISSUER, resource: MCP_RESOURCE, publicEnabled: true, allowedOrigins: new Set(),
    limits: { maxBodyBytes: 128 * 1024, maxResponseBytes: 64 * 1024, requestTimeoutMs: 25_000, maxConcurrentRequests: 4 },
    verifyToken: async () => ({ providerGrantId: grant.providerGrantId, subject: owner.userId, expiresAt: Math.floor(Date.now() / 1000) + 300 }),
    executeTool,
  });
  const names = new Map([[owner.userId, '<owner_user_id>'], [workspaceId, '<workspace_id>'],
    [other.workspaceId, '<other_workspace_id>'], [grant.grantId, '<grant_id>']]);
  const counters = { uuid: 0, handle: 0 };
  const normalize = (text) => text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, (value) => {
      if (!names.has(value)) names.set(value, `<uuid_${++counters.uuid}>`);
      return names.get(value);
    })
    .replace(/seat_[A-Za-z0-9_-]{22,64}/gu, (value) => {
      if (!names.has(value)) names.set(value, `<handle_${++counters.handle}>`);
      return names.get(value);
    });
  let handle = null;
  const call = async (label, rpcId, name, args) => {
    const response = await serve(new Request(MCP_RESOURCE, {
      method: 'POST', headers: { authorization: 'Bearer golden.token.value', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } }),
    }));
    const text = await response.text();
    if (label === 'claim_seat success') handle = JSON.parse(JSON.parse(text).result.content[0].text).handle;
    return { label, http_status: response.status, text: normalize(text) };
  };
  out.stage = 'golden-calls';
  const outputs = [];
  outputs.push(await call('claim_seat success', 'golden-1', 'claim_seat', { name: 'golden-seat', request_id: 'golden-request-0001' }));
  outputs.push(await call('claim_seat replay', 'golden-2', 'claim_seat', { name: 'golden-seat', request_id: 'golden-request-0001' }));
  outputs.push(await call('claim_seat reuse', 'golden-3', 'claim_seat', { name: 'golden-seat', request_id: 'golden-request-0002' }));
  outputs.push(await call('claim_seat name taken', 'golden-4', 'claim_seat', { name: 'golden-taken', request_id: 'golden-request-0003' }));
  outputs.push(await call('claim_seat workspace not consented', 'golden-5', 'claim_seat',
    { workspace_id: other.workspaceId, name: 'golden-other', request_id: 'golden-request-0004' }));
  outputs.push(await call('claim_seat request_id conflict', 'golden-6', 'claim_seat', { name: 'golden-seat-changed', request_id: 'golden-request-0001' }));
  if (typeof handle !== 'string') fail('golden_claim_failed');
  outputs.push(await call('whoami success', 'golden-7', 'whoami', { seat: handle }));
  outputs.push(await call('whoami unknown seat', 'golden-8', 'whoami', { seat: `seat_${'Z'.repeat(22)}` }));
  return { golden: outputs };
}

if (typeof Deno !== 'undefined' && import.meta.main) await denoMain();
