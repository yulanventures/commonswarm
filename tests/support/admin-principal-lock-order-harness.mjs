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
import { chmodSync, existsSync, mkdirSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Round 4 (review A F1(i)): two OAuth admins, different owners and issuer kids, one workspace. */
export const ADMIN_PAIR = 'admin-oauth-vs-admin-oauth-shared-workspace';
/** Round 6 (review B B1, B2): two OAuth admins whose workspace locks cross (adminCrossScenario). */
export const ADMIN_CROSS = Object.freeze({
  CREATE_EXISTING: 'admin-oauth-create-existing-workspace-crossed',
  READ_OUTSIDE_GRANT: 'admin-oauth-read-outside-grant-vs-admin-oauth-routine',
  GRANT_COMMAND: 'admin-oauth-grant-admin-delegation-vs-admin-oauth-routine',
});
/** Round 6 (inventory): two owners each withdraw a workspace from the other's grant (adminWithdrawScenario). */
export const ADMIN_WITHDRAW = 'admin-human-withdraw-crossed-grants';
const RACES = Object.freeze({
  'local-allow-retired-parent-allow-first': { parked: 'local', waiting: 'admin' },
  'local-allow-retired-parent-issuer-first': { parked: 'local', waiting: 'admin' },
  'hosted-owner-removal-prefix': { parked: 'hosted', waiting: 'admin' },
  'admin-oauth-vs-hosted-claim-seat': { parked: 'hosted', waiting: 'admin' },
  'admin-oauth-vs-local-join-registration': { parked: 'join', waiting: 'admin' },
  'admin-oauth-vs-local-command-creation': { parked: 'local', waiting: 'admin' },
  'accept-invitation-vs-hosted-claim-seat': { parked: 'hosted', waiting: 'accept' },
  'accept-invitation-vs-local-join-registration': { parked: 'join', waiting: 'accept' },
  'remove-member-vs-hosted-claim-seat': { parked: 'hosted', waiting: 'remove' },
  'remove-member-vs-local-join-registration': { parked: 'join', waiting: 'remove' },
  'household-invitation-vs-hosted-claim-seat': { parked: 'hosted', waiting: 'household' },
  'household-invitation-vs-local-join-registration': { parked: 'join', waiting: 'household' },
  [ADMIN_PAIR]: { parked: 'admin', waiting: 'admin' },
  ...Object.fromEntries(Object.values(ADMIN_CROSS).map((name) => [name, { parked: 'admin', waiting: 'admin' }])),
  [ADMIN_WITHDRAW]: { parked: 'admin', waiting: 'admin' },
  ...Object.fromEntries(['delegated-local-permanent-suspension','delegated-local-revocation-closure','delegated-local-selector-compatibility','delegated-local-parent-reversal','delegated-local-renewal-budget','delegated-local-parent-deadline','delegated-local-parent-narrowing','delegated-local-wait-removal-rollback','ordinary-local-compat-policy','local-resume-parent-order','local-resume-recovery-controls'].map(name=>[name,{parked:'admin',waiting:'admin'}])),
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

/** Explicit CI contexts only: this repository's Supabase CLI project. The CLI names the database
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
  } else if (env.GITHUB_ACTIONS === 'true' || (env.CI === 'true' && env.STANDALONE_CI === '1')) {
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

/** A harness setup failure. Callers branch on `code`, never on the message. */
export class LockOrderSetupFailure extends Error {
  constructor(code) {
    super(`lock-order setup failed: ${code}`);
    this.name = 'LockOrderSetupFailure';
    this.code = code;
  }
}
const setupFailure = (code) => { throw new LockOrderSetupFailure(code); };

/** The X.Y.Z core that command/index.ts SEMVER_RE accepts; the races send this minimum as their
 * client_version, so compareSemver returns 0. */
const SEMVER_CORE_RE = /^\d+\.\d+\.\d+$/u;
/** min_client_version is public configuration: a value is echoed only when it is this short and plain. */
const OBSERVABLE_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/u;
/** One row of the swarm.config seed statement (20260723000001_p1_schema.sql:439-443). */
const MIN_CLIENT_VERSION_ROW_RE = /^ {2}\('min_client_version', '"([^"'\\\n]*)"'::jsonb\),?$/gmu;
const CONFIG_SEED_STATEMENT_RE = /^INSERT INTO swarm\.config \(key, value\)\nVALUES\n(?: {2}\('[a-z_]+', '[^'\n]*'::jsonb\),\n)* {2}\('[a-z_]+', '[^'\n]*'::jsonb\)\nON CONFLICT \(key\) DO NOTHING;$/u;

/** Every supabase/migrations/*.sql file as { name, text }, in name order. */
export function readMigrations(root = REPO_ROOT) {
  try {
    const directory = join(root, 'supabase/migrations');
    return readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()
      .map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }));
  } catch {
    return setupFailure('seed_migrations_unreadable');
  }
}

/** Lexical context of each character of a PostgreSQL script: code, comment, or quoted text
 * (a '...' literal with '' doubling, an E'...' literal with backslash escapes, a "..." identifier,
 * or a $tag$...$tag$ body). Comments run from -- to the end of the line, or are slash-star
 * blocks, which nest as in PostgreSQL. */
const SQL_CODE = 0, SQL_COMMENT = 1, SQL_QUOTED = 2;
const SQL_IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$\u0080-\uffff]/u;
const SQL_DOLLAR_TAG_RE = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/u;
export function sqlLexicalContexts(text) {
  const context = new Uint8Array(text.length);
  let i = 0;
  const mark = (from, to, kind) => { context.fill(kind, from, Math.min(to, text.length)); return Math.min(to, text.length); };
  while (i < text.length) {
    const c = text[i], next = text[i + 1], previous = i > 0 ? text[i - 1] : '';
    if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = mark(i, end === -1 ? text.length : end, SQL_COMMENT);
    } else if (c === '/' && next === '*') {
      let depth = 0, j = i;
      while (j < text.length) {
        if (text[j] === '/' && text[j + 1] === '*') { depth += 1; j += 2; } else if (text[j] === '*' && text[j + 1] === '/') {
          depth -= 1; j += 2; if (depth === 0) break;
        } else j += 1;
      }
      i = mark(i, j, SQL_COMMENT);
    } else if (c === "'") {
      const escapes = /[Ee]/u.test(previous) && !SQL_IDENTIFIER_CHAR_RE.test(i > 1 ? text[i - 2] : '');
      let j = i + 1;
      while (j < text.length) {
        if (escapes && text[j] === '\\') j += 2;
        else if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") { j += 1; break; } else j += 1;
      }
      i = mark(i, j, SQL_QUOTED);
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') j += 2;
        else if (text[j] === '"') { j += 1; break; } else j += 1;
      }
      i = mark(i, j, SQL_QUOTED);
    } else if (c === '$' && !SQL_IDENTIFIER_CHAR_RE.test(previous) && SQL_DOLLAR_TAG_RE.test(text.slice(i, i + 64))) {
      const tag = text.slice(i).match(SQL_DOLLAR_TAG_RE)[0];
      const close = text.indexOf(tag, i + tag.length);
      i = mark(i, close === -1 ? text.length : close + tag.length, SQL_QUOTED);
    } else i += 1;
  }
  return context;
}
/** The text with every UTF-16 unit of the given contexts replaced by a space (newlines kept). */
function sqlMask(text, context, kinds) {
  let masked = '';
  for (let i = 0; i < text.length; i += 1) masked += kinds.includes(context[i]) && text[i] !== '\n' ? ' ' : text[i];
  return masked;
}

/** The CI seed source: the migrations' own min_client_version, never a row of the shared CI
 * database. The key must appear exactly once in all migrations, as one row of
 * `INSERT INTO swarm.config (key, value) VALUES ... ON CONFLICT (key) DO NOTHING;` whose value is
 * a JSON string X.Y.Z. Any other mention (a second seed, a later UPDATE or upsert, a comment)
 * refuses: a fresh migrate might then hold another value. The statement must also run: it is
 * matched only outside comments, starts as a top-level statement (not in a comment, a quoted
 * body, parentheses, a BEGIN ATOMIC body, or after other words of the same statement) and
 * contains no comment. */
export function migrationMinClientVersion(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) setupFailure('seed_migrations_unreadable');
  const mentions = migrations.flatMap(({ name, text }) => (text.match(/min_client_version/gu) ?? []).map(() => name));
  if (mentions.length !== 1) setupFailure('seed_min_client_version_not_unique');
  const { text } = migrations.find((file) => file.name === mentions[0]);
  const context = sqlLexicalContexts(text);
  // Comments become spaces; quoted text stays, since the key and the value are literals.
  const executable = sqlMask(text, context, [SQL_COMMENT]);
  // Comments and quoted text become spaces: only code is left.
  const code = sqlMask(text, context, [SQL_COMMENT, SQL_QUOTED]);
  if (!executable.includes('min_client_version')) setupFailure('seed_min_client_version_not_executable');
  const rows = [...executable.matchAll(MIN_CLIENT_VERSION_ROW_RE)];
  if (rows.length !== 1) setupFailure('seed_min_client_version_row_unparsed');
  // The row's own parenthesis is code, not text inside a literal or a $$ body.
  if (context[rows[0].index + 2] !== SQL_CODE) setupFailure('seed_min_client_version_not_executable');
  const start = code.lastIndexOf('INSERT INTO', rows[0].index);
  const end = code.indexOf(';', rows[0].index);
  if (start === -1 || end === -1 || !CONFIG_SEED_STATEMENT_RE.test(text.slice(start, end + 1))) {
    setupFailure('seed_min_client_version_statement_unparsed');
  }
  const before = code.slice(0, start);
  const depth = [...before].reduce((n, c) => n + (c === '(' ? 1 : c === ')' ? -1 : 0), 0);
  if (before.slice(before.lastIndexOf(';') + 1).trim() !== '' || depth !== 0 || /\bBEGIN\s+ATOMIC\b/iu.test(code)) {
    setupFailure('seed_min_client_version_not_executable');
  }
  if (!SEMVER_CORE_RE.test(rows[0][1])) setupFailure('seed_min_client_version_non_semver');
  return rows[0][1];
}

/** One read of swarm.config min_client_version as `SELECT jsonb_typeof(value) AS type,
 * value #>> '{}' AS text` (undefined: no row). Used by the CI seed read-back and by every Deno run. */
export function classifyMinClientVersion(row) {
  if (row === undefined || row === null) return { ok: false, code: 'min_client_version_missing' };
  if (row.type !== 'string' || typeof row.text !== 'string') return { ok: false, code: 'min_client_version_non_string' };
  if (!SEMVER_CORE_RE.test(row.text)) {
    return OBSERVABLE_VERSION_RE.test(row.text)
      ? { ok: false, code: 'min_client_version_non_semver', observed: row.text }
      : { ok: false, code: 'min_client_version_non_semver' };
  }
  return { ok: true, version: row.text };
}
/** The stage error for a refused read: the code, and the observed value only when it may be echoed. */
export const minClientVersionDiagnostic = (check) => (check.observed === undefined ? check.code : `${check.code}:observed=${check.observed}`);

const DUMP_SCHEMAS = ['auth', 'swarm', 'swarm_read', 'commonswarm_oauth', 'commonswarm_ops', 'supabase_migrations'];
/** CI only: a throwaway database on the CLI cluster, as adminEdgeDatabase builds one, but from
 * the verified container. Only its DDL comes from the shared database; its seed rows are the
 * migrations' own, so earlier server files cannot change them. Admin issuance opens only inside it. */
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
  let phase = 'seed-source';
  try {
    const minimum = migrationMinClientVersion(readMigrations());
    phase = 'source';
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
    // A schema-only copy has no seed rows. The command module reads only min_client_version
    // from swarm.config. Its value is a text parameter: postgres.js describes a `${json}::jsonb`
    // parameter as jsonb and JSON-encodes the text again ('"0.1.0"' became "\"0.1.0\"").
    // The two singletons are the migrations' own inserts, with their column defaults
    // (20260925000001_unclaimed_observed_ack.sql:69, 20261003000003_admin_oauth_cutover.sql:223).
    await db.begin(async (tx) => {
      await tx`INSERT INTO swarm.config (key, value) VALUES ('min_client_version', to_jsonb(${minimum}::text))`;
      await tx`INSERT INTO swarm.wake_path_release (singleton) VALUES (true)`;
      await tx`INSERT INTO commonswarm_oauth.admin_cutover_state(singleton) VALUES(true)`;
    });
    phase = 'seed-readback';
    const [seeded] = await db`SELECT jsonb_typeof(value) AS type, value #>> '{}' AS text FROM swarm.config WHERE key = 'min_client_version'`;
    const check = classifyMinClientVersion(seeded);
    if (!check.ok) setupFailure(minClientVersionDiagnostic(check));
    if (check.version !== minimum) setupFailure('min_client_version_readback_mismatch');
    return { url: target.toString(), mode: binding.mode, tlsCaPem: null, ensureAdminIssuance: () => ensureAdminIssuance(db, issuance), close };
  } catch (error) {
    try { await close(); } catch { /* the setup failure below is the result */ }
    throw new Error(`isolated_database_setup_failed:${phase}:${error instanceof LockOrderSetupFailure ? error.code : sqlstate(error)}`);
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

/** Artifact selection for the existing renewal owner, not authorization evidence.
 * Both generations are read from immutable Git objects, never a labelled copy of
 * this checkout. Materialize the complete source trees so activity, config and
 * every relative/type import use the same generation as command/read. */
export const ACTIVE_FLOOR_SOURCES = Object.freeze({
  H: Object.freeze({commit:'b9ee52592df924d945f800619ee31e6c483200df',tree:'6c97679c7ffe042e88addcfaf573c78d6a1379dc'}),
  F: Object.freeze({commit:'27d7b2102f8c17579f6813cad50eaa35c5c1326a',tree:'5fcd7c1dce08fcec6301accea9d2123fc5f04792'}),
});
export function materializeActiveFloorSource(directory, generation) {
  if(generation==='current') return {path:REPO_ROOT,
    commit:execFileSync('git',['-C',REPO_ROOT,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    tree:execFileSync('git',['-C',REPO_ROOT,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim()};
  if (!Object.hasOwn(ACTIVE_FLOOR_SOURCES,generation)) throw new Error('unknown_source_generation');
  const source=ACTIVE_FLOOR_SOURCES[generation];
  const git=args=>execFileSync('git',['-C',REPO_ROOT,...args],{stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024});
  if(git(['rev-parse',`${source.commit}^{tree}`]).toString().trim()!==source.tree) throw new Error('source_tree_identity');
  const destination=join(directory,`source-${generation}`);
  if(existsSync(destination)) throw new Error('source_destination_exists');
  mkdirSync(destination,{mode:0o700});
  // Read blobs directly: archive attributes must not substitute source bytes.
  // No dependency, checkout hook or application code is executed here.
  const entries=git(['ls-tree','-rz',source.commit,'src','supabase/functions']).toString().split('\0').filter(Boolean);
  if(entries.length===0) throw new Error('source_tree_empty');
  for(const entry of entries) {
    const match=/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(entry);
    if(!match) throw new Error('source_not_regular_blob');
    const [, ,blob,path]=match;
    if(isAbsolute(path) || path.split('/').some(part=>part==='..' || part==='')) throw new Error('source_path_unsafe');
    const bytes=git(['cat-file','blob',blob]);
    if(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==blob) throw new Error('source_blob_identity');
    const file=join(destination,path);
    mkdirSync(dirname(file),{recursive:true,mode:0o700});
    writeFileSync(file,bytes,{mode:0o600,flag:'wx'});
  }
  return {...source,path:destination};
}

/** Read-only ACTIVE prerequisite. Source bodies come from the reviewed migrations;
 * this never activates PREP, installs SQL, or grants a role. */
export async function assertActiveFloorCatalog(sql) {
  const migrations = [
    '20261019000007_local_auth_lock_order.sql',
    '20261019000008_local_auth_inactive_parent_closure.sql',
    '20261019000009_hosted_snapshot_null_compat.sql',
    '20261019000010_local_permanence_read_models.sql',
  ];
  const expected = new Map();
  for (const file of migrations) {
    const text = readFileSync(join(REPO_ROOT,'supabase/migrations',file),'utf8');
    const pattern = /CREATE(?: OR REPLACE)? FUNCTION\s+([a-z_]+\.[a-z_]+)\s*\(([^)]*)\)([\s\S]*?)\bAS\s+(\$[a-z_]*\$)([\s\S]*?)\4\s*;/giu;
    let count=0;
    for (const match of text.matchAll(pattern)) {
      const args=match[2].trim() ? match[2].split(',').map(arg=>arg.trim().split(/\s+/u)[1]) : [];
      if(args.some(type=>typeof type!=='string' || !/^[a-z_]+(?:\[\])?$/u.test(type))) throw new Error('active_catalog_signature');
      const types=args.join(',');
      expected.set(`${match[1]}(${types})`,{body:match[5],definer:/SECURITY DEFINER/iu.test(match[3]),language:/LANGUAGE\s+(sql|plpgsql)\b/iu.exec(match[3])?.[1].toLowerCase(),volatility:/IMMUTABLE/iu.test(match[3])?'i':/STABLE/iu.test(match[3])?'s':'v'});count++;
    }
    if(count===0 || count!==[...text.matchAll(/^CREATE(?: OR REPLACE)? FUNCTION\b/gimu)].length) throw new Error('active_catalog_source_unreadable');
  }
  return await sql.begin('read only',async tx=>{
    for(const [signature,want] of expected) {
      const rows=await tx`SELECT p.prosrc,p.prosecdef,p.proconfig,p.provolatile,l.lanname,r.rolname AS owner
        FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure(${signature})`;
      const actual=rows[0];
      if(rows.length!==1 || actual.prosrc!==want.body || actual.prosecdef!==want.definer || actual.owner!=='swarm_admin' || actual.lanname!==want.language || actual.provolatile!==want.volatility)
        throw new Error('active_catalog_body_owner_or_mode');
      if(!actual.proconfig?.includes('search_path=pg_catalog')) throw new Error('active_catalog_search_path');
    }
    const privateFunctions=[
      ['swarm.discover_local_credential_ids(bytea)',['swarm_command']],
      ['swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean)',['swarm_command']],
      ['swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid)',['swarm_command']],
      ['swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)',['swarm_command']],
      ['swarm.discover_local_join_ids(bytea,uuid)',['swarm_command']],
      ['swarm.household_local_family_binding_guard()',[]],
      ['swarm.local_content_approval_pointer_guard()',[]],
      ['swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)',['swarm_command']],
      ['swarm_read.home_overview()',['authenticated']],
      ['swarm.agent_delivery_read_context(bytea,uuid)',['swarm_read']],
      ['swarm.agent_tokens_successor_fence()',[]],
      ['swarm.record_renewal_grant_use(uuid,uuid,text)',['swarm_read','swarm_command']],
      ['swarm.prepare_renewal_grant(uuid,uuid)',['swarm_command']],
      ['swarm.resume_renewal_grant(uuid,uuid,uuid)',['swarm_command']],
      ['swarm_read.renewal_grant_roster(uuid)',['authenticated','swarm_read']],
      ['swarm_read.renewal_grant_for_token(uuid,uuid)',['swarm_read']],
      ['swarm.renewal_grants_revoke_cascade()',[]],
      ['swarm.audit_household_hosted_restriction()',[]],
      ['swarm.renewal_grants_spend_or_revoke_only()',[]],
    ];
    for(const [signature,allowed] of privateFunctions) {
      const publicAcl=await tx`SELECT EXISTS(SELECT 1 FROM pg_proc p,
        LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=to_regprocedure(${signature}) AND a.grantee=0 AND a.privilege_type='EXECUTE') AS ok`;
      if(publicAcl[0].ok) throw new Error('active_catalog_public_execute');
      for(const role of ['anon','authenticated','swarm_read','swarm_command']) {
        const [row]=await tx`SELECT has_function_privilege(${role},${signature},'EXECUTE') AS ok`;
        if(row.ok!==allowed.includes(role)) throw new Error('active_catalog_effective_acl');
      }
    }
    for(const [table,trigger,fn,kind,predicate=null] of [
      ['swarm.household_content_connections','aa_household_local_family_binding','swarm.household_local_family_binding_guard()',23],
      ['swarm.renewal_grants','aa_local_content_approval_pointer','swarm.local_content_approval_pointer_guard()',23],
      ['swarm.agent_tokens','agent_tokens_successor_fence','swarm.agent_tokens_successor_fence()',7,'new.predecessor_token_idisnotnull'],
      ['swarm.renewal_grants','renewal_grants_spend_or_revoke_only','swarm.renewal_grants_spend_or_revoke_only()',27],
      ['swarm.renewal_grants','renewal_grants_revoke_cascade','swarm.renewal_grants_revoke_cascade()',17,'old.revoked_atisnullandnew.revoked_atisnotnull'],
      ['swarm.household_hosted_content_restrictions','household_hosted_restriction_audit','swarm.audit_household_hosted_restriction()',23],
    ]) {
      const rows=await tx`SELECT tgtype::int AS kind,pg_get_triggerdef(oid,true) AS definition FROM pg_trigger WHERE tgrelid=to_regclass(${table})
        AND tgname=${trigger} AND tgfoid=to_regprocedure(${fn}) AND tgenabled='O' AND NOT tgisinternal`;
      if(rows.length!==1 || rows[0].kind!==kind) throw new Error('active_catalog_trigger');
      const when=/ WHEN (.+) EXECUTE FUNCTION /u.exec(rows[0].definition)?.[1] ?? null;
      if((when===null ? null : when.toLowerCase().replace(/[()\s]/gu,''))!==predicate) throw new Error('active_catalog_trigger_predicate');
    }
    const [column]=await tx`SELECT count(*)::int AS n FROM pg_attribute
      WHERE attrelid='swarm.renewal_grants'::regclass AND attname='local_content_approval_token_id'
        AND atttypid='uuid'::regtype AND NOT attisdropped`;
    if(column.n!==1) throw new Error('active_catalog_column');
    return {functions:expected.size,migrations:migrations.length};
  });
}

/** Runs one Deno scenario against the target. Only LOCK_ORDER_ lines are read back. */
export async function runScenario(target, scenario, timeoutMs = 170_000, generations = null) {
  let adminIssuance = null;
  if (RACES[scenario]?.waiting === 'admin') {
    adminIssuance = await target.ensureAdminIssuance();
    if (!ADMIN_ISSUANCE_OPEN.includes(adminIssuance)) return { scenario, stage: 'admin_issuance', error: adminIssuance };
  }
  const secret = secretDirectory();
  try {
    const configPath = join(secret.dir, 'target.json');
    const source=generations ? materializeActiveFloorSource(secret.dir,generations.command) : null;
    const readSource=generations && generations.read!==generations.command ? materializeActiveFloorSource(secret.dir,generations.read) : source;
    let floor_url;
    if (scenario === 'floor-first-use-vs-head-revocation') {
      const floor='6d29f8060e05be93a1669cae30bdfa3e56c426d8';
      const modules=[
        ['supabase/functions/_shared/agent-auth.ts','7dcdd9e8fdc96e4951dd87005d8ab12cdc54d1b1'],
        ['src/cloud/session-wire.ts','d68dfeffa1210c2daff368c789e6e94d1986ea42'],
      ];
      for (const [path,blob] of modules) {
        const bytes=execFileSync('git',['-C',REPO_ROOT,'show',`${floor}:${path}`],{stdio:['ignore','pipe','ignore']});
        const actual=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if(actual!==blob) throw new LockOrderBindingRefusal('floor_blob_identity');
        const targetPath=join(secret.dir,path);mkdirSync(dirname(targetPath),{recursive:true,mode:0o700});
        writeFileSync(targetPath,bytes,{mode:0o600});
      }
      floor_url=pathToFileURL(join(secret.dir,modules[0][0])).href;
    }
    writeFileSync(configPath, JSON.stringify({ db_url: target.url, tls_ca_pem: target.tlsCaPem, floor_url, source, read_source:readSource, active_floor:generations!==null }), { mode: 0o600 });
    const env = { PATH: process.env.PATH ?? '', NO_COLOR: '1' };
    for (const key of ['HOME', 'DENO_DIR', 'XDG_CACHE_HOME']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn('deno', ['run', '--no-lock', ...(scenario==='floor-first-use-vs-head-revocation' ? ['--cached-only'] : []), '--config', join(REPO_ROOT, 'supabase/functions/command/deno.json'),
      '--allow-read', '--allow-env', '--allow-net', fileURLToPath(import.meta.url), configPath, scenario],
    { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
      child.on('error', () => { clearTimeout(timer); resolve({code:null,signal:'spawn_error'}); });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    const line = stdout.split('\n').reverse().find((entry) => entry.startsWith('LOCK_ORDER_RESULT '));
    if (exit.code !== 0 || exit.signal !== null || line === undefined) return { scenario, stage: 'process_failed', exit_code: exit.code, signal: exit.signal,
      ...(scenario==='floor-first-use-vs-head-revocation' ? {required_compatibility:'BLOCKED',floor_compatibility:'INCONCLUSIVE'} : {}) };
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
  const out = { scenario, stage: 'config', ...(scenario==='floor-first-use-vs-head-revocation'
    ? {required_compatibility:'BLOCKED',floor_compatibility:'INCONCLUSIVE'} : {}) };
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
    if(config.active_floor) {out.stage='active_catalog';out.active_catalog=await assertActiveFloorCatalog(observer);}
    out.stage='import';
    const load=(path,kind='command')=>import(pathToFileURL(join((kind==='read' ? config.read_source : config.source)?.path ?? REPO_ROOT,path)).href);
    const command = await load('supabase/functions/command/index.ts');
    const policyCommand=config.active_floor ? await import('../../supabase/functions/command/index.ts') : command;
    out.source=config.source ? {commit:config.source.commit,tree:config.source.tree} : null;
    out.read_source=config.read_source ? {commit:config.read_source.commit,tree:config.read_source.tree} : null;
    const { db } = command;
    // Every command-module transaction (admin, hosted, join and ordinary) runs through db.begin.
    // Record the SQLSTATE of each rejected one while a race is open; no message is read.
    const failures = { recording: false, codes: [], deadlocks: [] };
    const begin = db.begin;
    db.begin = function (...args) {
      return begin.apply(this, args).catch((error) => {
        if (failures.recording) { failures.codes.push(sqlstate(error));
          if(sqlstate(error)==='40P01') failures.deadlocks.push(deadlockEdges(error));
        }
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
    out.stage = 'deadlock-timeout';
    const [timing] = await observer`SELECT setting::int AS ms FROM pg_settings WHERE name = 'deadlock_timeout'`;
    out.deadlock_timeout_ms = Number(timing?.ms);
    out.lock_timeout_ms = LOCK_TIMEOUT_MS;
    if (!(out.deadlock_timeout_ms < LOCK_TIMEOUT_MS)) fail('deadlock_timeout_not_below_lock_timeout');
    // A restored target keeps its own minimum (D4); the CI target holds the migrations' own
    // (isolatedDatabaseTarget). No command path branches on client_version except this minimum
    // (command/index.ts swarm.config reads). An unreadable minimum is a STOP in both modes.
    out.stage = 'min-client-version';
    const [row] = await observer`SELECT jsonb_typeof(value) AS type, value #>> '{}' AS text FROM swarm.config WHERE key = 'min_client_version'`;
    const minimum = classifyMinClientVersion(row);
    if (!minimum.ok) fail(minClientVersionDiagnostic(minimum));
    out.client_version = minimum.version;
    // D4: names and ids unique to this run (fresh workspace, users and grants per scenario).
    const ctx = { load, policyCommand, issuerTarget:{url:config.db_url,ssl:ssl.ssl}, floorUrl:config.floor_url, command, db, observer, failures, jwks, out, tag: randomUUID().replaceAll('-', '').slice(0, 10), clientVersion: minimum.version };
    const result = scenario.startsWith('active-floor-canonical-') ? await activeFloorCanonicalScenario(ctx,scenario)
      : scenario.startsWith('local-allow-retired-parent-') ? await localAllowRetiredParentScenario(ctx,scenario)
      : scenario==='hosted-owner-removal-prefix' ? await hostedOwnerRemovalScenario(ctx)
      : scenario==='floor-first-use-vs-head-revocation' ? await floorFirstUseScenario(ctx)
      : scenario.startsWith('local-resume-') ? await localResumeScenario(ctx,scenario)
      : scenario.startsWith('delegated-local-') ? await delegatedLocalScenario(ctx,scenario)
      : scenario==='ordinary-local-compat-policy' ? await ordinaryLocalPolicyScenario(ctx)
      : scenario === 'golden' ? await golden(ctx)
      : scenario === ADMIN_PAIR ? await adminPairScenario(ctx)
      : Object.values(ADMIN_CROSS).includes(scenario) ? await adminCrossScenario(ctx, scenario)
      : scenario === ADMIN_WITHDRAW ? await adminWithdrawScenario(ctx) : await raceScenario(ctx, scenario);
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
async function workspace(ctx, owner, household, workspaceId = id()) {
  const streamId = id();
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
// F is an ACTIVE rollback reader/consumer; the chosen-date writer remains current.
const manage = (ctx, user, workspaceId, body) => (body.kind==='set_connection_expiry' ? ctx.policyCommand : ctx.command).handleHostedManagementCommand({
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
    const { authenticateHostedGrantCapability } = await ctx.load('supabase/functions/_shared/hosted-seat-auth.ts');
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
    // remove_member needs a fresh interactive sign-in (fresh-auth.ts:82-83). Without one,
    // command/index.ts:11352-11380 returns 401 fresh_auth_required before the step-8 workspace
    // and stream locks (:12350-12357). Production takes the time from the JWT's newest interactive
    // AMR (:13323); here it is the database clock that the check compares with (:11353), read
    // just before each command.
    const remove = async (user) => {
      const [clock] = await ctx.observer`SELECT extract(epoch FROM statement_timestamp())::float8 AS seconds`;
      const signedIn = { ...owner, identity: { ...owner.identity, interactiveAuthAtSeconds: Number(clock.seconds) } };
      const result = await manage(ctx, signedIn, workspaceId, { kind: 'remove_member', user_id: user.userId });
      return { ...summary(result), ok: result.status === 200 && result.body?.status === 'accepted' };
    };
    const removed = await human(ctx, 'removed');
    const warmRemoved = await human(ctx, 'warm-removed');
    await member(ctx, workspaceId, removed, 'member');
    await member(ctx, workspaceId, warmRemoved, 'member');
    return {
      // Positive control: the same command on another member is accepted before the race.
      warm: () => remove(warmRemoved),
      start: () => remove(removed),
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

/** One OAuth admin. Round-6 options: `grantWorkspaceIds`, the grant's selected workspaces (default
 * the fixture workspace, where the warm-up seat goes); `extraConsentWorkspaceIds`, a second consent
 * that is prepared and never granted; `race`, the race command and the result it must give. */
async function adminSide(ctx, fixture, label = 'admin', options = {}) {
  const { owner, workspaceId } = fixture;
  const policy = await ctx.load('supabase/functions/_shared/protocol.js');
  const { adminTransaction } = await ctx.load('supabase/functions/command/admin-delegation.ts');
  const { oauthFixture } = await import('./admin-edge-oauth-fixture.mjs');
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  // One issuer kid and one client per admin side; the in-process JWKS serves every side's key.
  const jwk = { ...await crypto.subtle.exportKey('jwk', signing.publicKey), kid: `lock-order-${ctx.tag}-${label}`, alg: 'ES256', use: 'sig' };
  ctx.jwks.body = JSON.stringify({ keys: [...(ctx.jwks.body === null ? [] : JSON.parse(ctx.jwks.body).keys), jwk] });
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
    connection_id: connection, client_id: `lock-order-runtime-${ctx.tag}-${label}`, resource: policy.ADMIN_RESOURCE, mode: 'granular',
    registry_version: policy.ADMIN_REGISTRY_VERSION, scope_names: scopeNames,
    capability_names: policy.adminAvailableCapabilities(scopeNames),
    availability_digest: policy.adminAvailabilityDigest(policy.ADMIN_REGISTRY_VERSION),
    workspace_selector: 'selected', workspace_ids: options.grantWorkspaceIds ?? [workspaceId],
    created_workspace_policy: { scope_names: ['seats:create', 'seats:revoke'] },
    target_rules: { seat_ids: [], own_seats: true, grant_created_seats: true, recipient_user_ids: [owner.userId],
      recipient_connection_ids: [connection], transports: ['local', 'hosted_mcp'] },
    worker_scope_ceiling: ['post_signal'], role_ceiling: 'member',
    renewal_limits: { ...policy.ADMIN_RENEWAL_CEILINGS, grant_kinds: ['timeboxed', 'standing'], principal_ids: options.renewalPrincipalIds ?? [],
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
  let extraConsent = null;
  if (options.extraConsentWorkspaceIds) {
    const other = id();
    const extra = (await transact(wire({ kind: 'prepare_admin_consent', manifest: { ...manifest, connection_id: other,
      workspace_ids: options.extraConsentWorkspaceIds, target_rules: { ...manifest.target_rules, recipient_connection_ids: [other] } },
    full_account_selected: false }))).result;
    if (extra.status !== 200) fail('admin_extra_consent_refused');
    extraConsent = extra.body.consent_receipt_id;
  }
  const oauth = await oauthFixture(ctx.db, grant, signing, jwk.kid);
  const seat = (seatName) => ({ kind: 'admin_create_seat', grant_id: grant, workspace_id: workspaceId, name: seatName, model: null, transport: 'local' });
  const seatCreated = (result) => result.status === 200 && Array.isArray(result.body?.events) && result.body.events.some((event) => event.type === 'AdminSeatCreated');
  // The DPoP request is built before the race so the parked side waits only for the edge path.
  const armed = async (command) => {
    const input = wire(command);
    return { input, request: await oauth.request(input) };
  };
  const send = async ({ input, request }, ok = seatCreated) => {
    const response = await ctx.command.handleRequest(request);
    const result = { status: response.status, body: await response.json() };
    return { ...summary(result), command_id: input.command_id, ok: ok(result) };
  };
  const audit = async (commandId) => (await ctx.observer`SELECT outcome FROM commonswarm_oauth.admin_oauth_audit
    WHERE admin_grant_id = ${grant}::uuid AND request_id = ${commandId} ORDER BY occurred_at, audit_id`).map((row) => row.outcome);
  let race = null;
  const name = `race-${label}-seat-${ctx.tag}`;
  const raceCommand = options.race ? options.race({ grant, extraConsent }) : { command: seat(name), ok: seatCreated };
  return {
    name,
    grant,
    connection,
    issuerFixture: { oauth, signing, kid:jwk.kid },
    // Private fixture driver: the same raw JWT+DPoP admission and runtime worker
    // channel as production, with no direct import of a lock helper.
    invoke: async (command, {worker=false,deliver=async()=>{},commandId=id()}={}) => {
      const input=wire(command,commandId),request=await oauth.request(input);
      let result,delivery=null,calls=0;
      if (worker) result=await ctx.command.handleAdminWorkerCommand(input,request,async c=>{
        delivery=c;calls++;await deliver(c);
      });
      else {
        const response=await ctx.command.handleRequest(request);
        result={status:response.status,body:await response.json()};
      }
      return {result,delivery,calls,commandId};
    },
    warm: async () => {
      const warmed = await send(await armed(seat(`warm-${label}-seat-${ctx.tag}`)));
      return { ...warmed, audit: await audit(warmed.command_id) };
    },
    arm: async () => { race = await armed(raceCommand.command); },
    start: () => send(race, raceCommand.ok),
    writes: async () => ({ admin_principal_live: await principalLive(ctx, workspaceId, name) }),
    audit: () => audit(race.input.command_id),
  };
}

const settleSide = (promise) => promise.then((value) => value, (error) => ({ ok: false, thrown: sqlstate(error) }));
/** `<status>:<code>` of a settled side: its HTTP status and its body error code or SQLSTATE. */
const returnedCode = (side) => {
  const code = side.error ?? side.thrown;
  return `${Number.isInteger(side.status) ? side.status : 'none'}:${typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(code) ? code : 'none'}`;
};

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
  if (!warmCreation.ok) { out.warm_creation = warmCreation; fail(`creation_positive_control_failed:${returnedCode(warmCreation)}`); }
  if (holder.warm) {
    const warmHolder = await holder.warm();
    if (!warmHolder.ok || (warmHolder.audit && warmHolder.audit.join(',') !== 'committed')) {
      out.warm_holder = warmHolder;
      fail(`holder_positive_control_failed:${returnedCode(warmHolder)}`);
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
    let holderReturned = null;
    waiting = settleSide(holder.start()).then((outcome) => { holderReturned = outcome; return outcome; });
    const waitingPid = await waitForBlocked(observer, parkedPid, async pid => (await observer`SELECT EXISTS (
      SELECT 1 FROM pg_locks WHERE pid=${pid}::int AND locktype='tuple'
        AND relation IN ('swarm.workspaces'::regclass,'swarm.streams'::regclass)) AS ok`)[0].ok === true);
    parking.holder_waits_on_creation_workspace_or_stream = waitingPid !== null;
    // A holder that returned without waiting names its HTTP status and error code.
    if (waitingPid === null) {
      fail(holderReturned === null ? 'holder_did_not_wait_for_stream' : `holder_returned_before_stream:${returnedCode(holderReturned)}`);
    }
  } finally {
    // A failed parking keeps its own stage; the blocker is released either way.
    releaseBlocker();
    await blocker.catch(() => {});
  }
  out.stage = 'release';
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

/** Admin vs admin (review A F1(i)): two owners, each with an OAuth grant signed under its own
 * issuer kid (so the issuer-key advisory lock does not serialize them), create a seat in one
 * shared workspace. A blocker session holds that workspace row FOR SHARE: every admin SHARE read
 * passes it and every stronger admin lock waits for it. The first admin parks on the blocker; the
 * second then parks on the same row. In the base order both already hold SHARE (currentRights,
 * admin-delegation.ts) and wait to raise it (admin-routine.ts:48): both wait for the blocker, and
 * the release deadlocks. In the coordinated order the stronger mode comes first: the second waits
 * for the first, and they serialize. */
async function adminPairScenario(ctx) {
  const { out, observer, failures } = ctx;
  out.stage = 'fixture';
  const owner = await human(ctx, 'owner');
  const coAdmin = await human(ctx, 'co-admin');
  const { workspaceId } = await workspace(ctx, owner, false);
  await member(ctx, workspaceId, coAdmin, 'admin');
  // Both keys are in the JWKS before the first OAuth request reads it.
  const admins = [await adminSide(ctx, { owner, workspaceId }, 'first'), await adminSide(ctx, { owner: coAdmin, workspaceId }, 'second')];
  out.stage = 'warm-up';
  for (const admin of admins) {
    const warmed = await admin.warm();
    if (!warmed.ok || warmed.audit.join(',') !== 'committed') { out.warm_holder = warmed; fail(`holder_positive_control_failed:${returnedCode(warmed)}`); }
    await admin.arm();
  }
  out.stage = 'blocker';
  let releaseBlocker;
  const released = new Promise((resolve) => { releaseBlocker = resolve; });
  let blockerReady;
  const ready = new Promise((resolve) => { blockerReady = resolve; });
  let blockerPid = 0;
  const blocker = observer.begin(async (tx) => {
    await tx`SELECT set_config('lock_timeout', '30s', true)`;
    blockerPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
    // The blocker holds this one row lock and nothing else.
    await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id = ${workspaceId}::uuid FOR SHARE`;
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
    out.stage = 'park-first-admin';
    parked = settleSide(admins[0].start());
    // Only the shared workspace row can make a backend wait for the blocker.
    const firstPid = await waitForBlocked(observer, blockerPid, async () => true);
    parking.first_admin_waits_on_shared_workspace = firstPid !== null;
    if (firstPid === null) fail('first_admin_did_not_park');
    out.stage = 'park-second-admin';
    waiting = settleSide(admins[1].start());
    const secondWait = await waitForSecondAdmin(observer, blockerPid, firstPid);
    parking.second_admin_waits_on_complete_plan = secondWait !== null;
    if (secondWait === null) fail('second_admin_did_not_park');
    // Diagnostic only: the blocker in the base order (both raise SHARE), the first admin in the
    // coordinated order (the second queues on an already held plan row).
    out.second_admin_blocked_by = secondWait.blockedBy;
  } finally {
    // A failed parking keeps its own stage; the blocker is released either way.
    releaseBlocker();
    await blocker.catch(() => {});
  }
  out.stage = 'release';
  const sides = await Promise.race([Promise.all([parked, waiting]), new Promise((resolve) => setTimeout(() => resolve(null), 60_000))]);
  failures.recording = false;
  if (sides === null) fail('race_timeout');
  out.stage = 'writes';
  return {
    parked: { side: 'admin', ...sides[0] },
    waiting: { side: 'admin', ...sides[1] },
    sqlstates: [...failures.codes],
    writes: {
      first_admin_principal_live: await principalLive(ctx, workspaceId, admins[0].name),
      second_admin_principal_live: await principalLive(ctx, workspaceId, admins[1].name),
    },
    admin_audit: [...await admins[0].audit(), ...await admins[1].audit()],
  };
}

/** The other backend waits for the fixture blocker or for the first admin
 * on a row in its complete U/account/parent/workspace plan. */
async function waitForSecondAdmin(sql, blockerPid, firstPid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE pid <> ${firstPid}::int
        AND (${blockerPid}::int = ANY(pg_blocking_pids(pid)) OR ${firstPid}::int = ANY(pg_blocking_pids(pid)))`;
    if (rows.length === 1) {
      const pid = Number(rows[0].pid), blockers = rows[0].blockers.map(Number);
      if (blockers.every((b) => b === blockerPid || b === firstPid)) {
        if (blockers.includes(blockerPid)) return { pid, blockedBy: 'blocker' };
        const [tuple] = await sql`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid}::int AND locktype = 'tuple'
          AND relation IN ('swarm.workspaces'::regclass,'swarm.admin_grants'::regclass,'swarm.users'::regclass,'swarm.admin_accounts'::regclass)) AS ok`;
        if (tuple.ok === true) return { pid, blockedBy: 'first_admin' };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

/** Round 6 (review B B1, B2): two OAuth admins, different owners and issuer kids, whose workspace
 * locks cross. A blocker session holds only workspace rows. The first admin parks on a blocked row
 * while it holds another workspace row; the second then parks on a row that the blocker or the
 * first admin holds. Workspace ids are sorted: low < high < top.
 * - CREATE_EXISTING (B1): each owner's grant selects only its own workspace, and each sends
 *   admin_create_workspace with the other owner's existing id. The blocker holds both rows FOR SHARE.
 *   The base and head''' lock the own row (currentRights or the membership-only pre-lock), then the
 *   other at admin-routine.ts:48: 40P01. Round 6 locks both first, in order: both 403 workspace_exists.
 * - READ_OUTSIDE_GRANT (B2) and GRANT_COMMAND: the first owner's grant selects high and top. It reads
 *   low (outside the grant: 403 workspace_forbidden), or sends grant_admin_delegation with its own
 *   consent for low (403 human_confirmation_required). The second owner's routine (grant low and
 *   high) creates a seat in high. The blocker holds top FOR NO KEY UPDATE, so the first holds high
 *   FOR SHARE and waits; the routine then waits for high. After the release, head''' locks low FOR
 *   SHARE while the routine holds it FOR NO KEY UPDATE (round-4 pre-lock): 40P01. The base routine
 *   holds low only FOR SHARE, so the base does not deadlock. Round 6 does not lock low here. */
async function adminCrossScenario(ctx, scenario) {
  const { out, observer, failures } = ctx;
  out.stage = 'fixture';
  const first = await human(ctx, 'first');
  const second = await human(ctx, 'second');
  const [low, high, top] = [id(), id(), id()].sort();
  const create = scenario === ADMIN_CROSS.CREATE_EXISTING;
  let admins;
  if (create) {
    await workspace(ctx, first, false, high);
    await workspace(ctx, second, false, low);
    const createIn = (target) => ({ grant }) => ({
      command: { kind: 'admin_create_workspace', grant_id: grant, workspace_id: target, name: `race-workspace-${ctx.tag}` },
      ok: (result) => result.status === 403 && result.body?.error === 'workspace_exists' });
    // Both keys are in the JWKS before the first OAuth request reads it.
    admins = [await adminSide(ctx, { owner: first, workspaceId: high }, 'first', { race: createIn(low) }),
      await adminSide(ctx, { owner: second, workspaceId: low }, 'second', { race: createIn(high) })];
  } else {
    await workspace(ctx, second, false, low);
    await workspace(ctx, second, false, high);
    await workspace(ctx, first, false, top);
    await member(ctx, low, first, 'admin');
    await member(ctx, high, first, 'admin');
    const read = scenario === ADMIN_CROSS.READ_OUTSIDE_GRANT;
    admins = [await adminSide(ctx, { owner: first, workspaceId: top }, 'first', {
      grantWorkspaceIds: [high, top],
      ...(read ? {} : { extraConsentWorkspaceIds: [low] }),
      race: read
        ? ({ grant }) => ({ command: { kind: 'admin_read_metadata', grant_id: grant, resource_kind: 'grant', workspace_id: low },
          ok: (result) => result.status === 403 && result.body?.error === 'workspace_forbidden' })
        : ({ extraConsent }) => ({ command: { kind: 'grant_admin_delegation', grant_id: id(), consent_receipt_id: extraConsent, replaces_grant_id: null },
          ok: (result) => result.status === 403 && result.body?.error === 'human_confirmation_required' }),
    }), await adminSide(ctx, { owner: second, workspaceId: high }, 'second', { grantWorkspaceIds: [low, high] })];
  }
  out.stage = 'warm-up';
  for (const admin of admins) {
    const warmed = await admin.warm();
    if (!warmed.ok || warmed.audit.join(',') !== 'committed') { out.warm_holder = warmed; fail(`holder_positive_control_failed:${returnedCode(warmed)}`); }
    await admin.arm();
  }
  out.stage = 'blocker';
  let releaseBlocker;
  const released = new Promise((resolve) => { releaseBlocker = resolve; });
  let blockerReady;
  const ready = new Promise((resolve) => { blockerReady = resolve; });
  let blockerPid = 0;
  const blocker = observer.begin(async (tx) => {
    await tx`SELECT set_config('lock_timeout', '30s', true)`;
    blockerPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
    // The blocker holds these workspace rows and nothing else.
    if (create) await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id = ANY(${[low, high]}::uuid[]) ORDER BY workspace_id FOR SHARE`;
    else await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id = ${top}::uuid FOR NO KEY UPDATE`;
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
    out.stage = 'park-first-admin';
    parked = settleSide(admins[0].start());
    // The blocker holds only workspace rows; the first admin waits for one of them.
    const firstPid = await waitForBlocked(observer, blockerPid, async (pid) => (await observer`SELECT EXISTS (SELECT 1 FROM pg_locks
      WHERE pid = ${pid}::int AND locktype = 'tuple' AND relation = 'swarm.workspaces'::regclass) AS ok`)[0].ok === true);
    parking.first_admin_waits_on_workspace = firstPid !== null;
    if (firstPid === null) fail('first_admin_did_not_park');
    out.stage = 'park-second-admin';
    waiting = settleSide(admins[1].start());
    const secondWait = await waitForCrossSecondAdmin(observer, blockerPid, firstPid);
    parking.second_admin_waits_on_complete_plan = secondWait !== null;
    if (secondWait === null) fail('second_admin_did_not_park');
    // Diagnostic only: who the second admin waits for, and whether it queues on a workspace tuple.
    out.second_admin_blocked_by = secondWait.blockedBy;
  } finally {
    // A failed parking keeps its own stage; the blocker is released either way.
    releaseBlocker();
    await blocker.catch(() => {});
  }
  out.stage = 'release';
  const sides = await Promise.race([Promise.all([parked, waiting]), new Promise((resolve) => setTimeout(() => resolve(null), 60_000))]);
  failures.recording = false;
  if (sides === null) fail('race_timeout');
  out.stage = 'writes';
  const noMembership = async (workspaceId, user) => (await observer`SELECT count(*)::int AS n FROM swarm.memberships
    WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${user.userId}::uuid`)[0].n === 0;
  return {
    parked: { side: 'admin', ...sides[0] },
    waiting: { side: 'admin', ...sides[1] },
    sqlstates: [...failures.codes],
    writes: create
      ? { first_target_unchanged: await noMembership(low, first), second_target_unchanged: await noMembership(high, second) }
      : { second_admin_principal_live: await principalLive(ctx, high, admins[1].name) },
    admin_audit: [...await admins[0].audit(), ...await admins[1].audit()],
  };
}

/** The one backend other than the first admin that waits only for the blocker and/or the first admin.
 * In these fixtures the blocker holds only workspace rows, and the two admins (different owners,
 * kids and clients) share no other row in a conflicting mode, so that wait is on a workspace row. */
async function waitForCrossSecondAdmin(sql, blockerPid, firstPid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE pid <> ${firstPid}::int
        AND (${blockerPid}::int = ANY(pg_blocking_pids(pid)) OR ${firstPid}::int = ANY(pg_blocking_pids(pid)))`;
    if (rows.length === 1) {
      const pid = Number(rows[0].pid), blockers = rows[0].blockers.map(Number);
      if (blockers.length > 0 && blockers.every((b) => b === blockerPid || b === firstPid)) {
        const names = [blockers.includes(blockerPid) ? 'blocker' : null, blockers.includes(firstPid) ? 'first_admin' : null].filter(Boolean);
        return { pid, blockedBy: names.join('+') };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

/** Round 6 (inventory): two owners, each an admin member of the other's workspace and granting over
 * it, withdraw the other's grant from their own workspace at the same time. A human admin command
 * runs runAdminAccountCommand (command/index.ts:13437-13447): setTransaction (:1596-1603), the
 * authenticateHuman users-row upsert (:3072-3087), then adminTransaction. runAdminAccountCommand
 * is not exported and its only entry, handleRequest, verifies the sign-in with GoTrue, so each side
 * runs the first two steps here with the same SQL. Both sides hold their own users row (the upsert)
 * before either calls adminTransaction, which then locks the grantor's users row: FOR UPDATE at
 * T''' and FOR NO KEY UPDATE at head''' (admin-delegation.ts:195), so each side waits for the
 * other's upsert: 40P01. Round 6 takes the grantor's row FOR KEY SHARE, which the upsert does not
 * block: both withdrawals are accepted. */
async function adminWithdrawScenario(ctx) {
  const { out, observer, failures } = ctx;
  out.stage = 'fixture';
  const first = await human(ctx, 'first');
  const second = await human(ctx, 'second');
  const { workspaceId: firstWorkspace } = await workspace(ctx, first, false);
  const { workspaceId: secondWorkspace } = await workspace(ctx, second, false);
  await member(ctx, firstWorkspace, second, 'admin');
  await member(ctx, secondWorkspace, first, 'admin');
  // Each owner's grant selects the other owner's workspace.
  const firstGrant = (await adminSide(ctx, { owner: first, workspaceId: secondWorkspace }, 'first')).grant;
  const secondGrant = (await adminSide(ctx, { owner: second, workspaceId: firstWorkspace }, 'second')).grant;
  const policy = await ctx.load('supabase/functions/_shared/protocol.js');
  const { adminTransaction } = await ctx.load('supabase/functions/command/admin-delegation.ts');
  const withdraw = (grant, workspaceId) => ({ command_id: id(), stream: { kind: 'account' }, resource: policy.ADMIN_RESOURCE,
    command: { kind: 'withdraw_admin_workspace_access', grant_id: grant, workspace_id: workspaceId, reason_code: 'withdrawn' } });
  const sides = [
    { user: first, input: withdraw(secondGrant, firstWorkspace) },
    { user: second, input: withdraw(firstGrant, secondWorkspace) },
  ];
  let arrived = 0, allArrived;
  const barrier = new Promise((resolve) => { allArrived = resolve; });
  const parking = {};
  out.parking = parking;
  const run = ({ user, input }) => ctx.db.begin('isolation level read committed', async (tx) => {
    await tx`SELECT set_config('role', 'swarm_command', true), set_config('search_path', 'swarm, pg_catalog', true),
      set_config('lock_timeout', '5s', true)`;
    await tx`INSERT INTO swarm.users (user_id, display_name, email) VALUES (${user.userId}::uuid, ${user.identity.displayName}, ${user.email})
      ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, email = coalesce(EXCLUDED.email, swarm.users.email)
      RETURNING user_id, email`;
    if (++arrived === sides.length) allArrived();
    await barrier;
    const [clock] = await tx`SELECT extract(epoch FROM statement_timestamp())::float8 AS seconds`;
    return await adminTransaction(tx, input, { kind: 'human', identity: { user_id: user.userId, session_binding: 'a'.repeat(64),
      interactive_at_seconds: Number(clock.seconds), csrf_verified: true } });
  }).then(({ result }) => ({ ...summary(result), ok: result.status === 200 && result.body?.status === 'accepted' &&
    result.body.events.some((event) => event.type === 'AdminWorkspaceAccessWithdrawn') }));
  failures.codes.length = 0;
  failures.recording = true;
  out.stage = 'race';
  const started = sides.map((side) => settleSide(run(side)));
  const held = await Promise.race([barrier.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 15_000))]);
  parking.both_sides_hold_own_users_row = held;
  const settled = await Promise.race([Promise.all(started), new Promise((resolve) => setTimeout(() => resolve(null), 60_000))]);
  failures.recording = false;
  if (!held) fail('sides_did_not_reach_barrier');
  if (settled === null) fail('race_timeout');
  out.stage = 'writes';
  const withdrawn = async (grant, workspaceId) => (await observer`SELECT ${workspaceId}::uuid = ANY(withdrawn_workspace_ids) AS ok
    FROM swarm.admin_grants WHERE grant_id = ${grant}::uuid`)[0]?.ok === true;
  return {
    parked: { side: 'admin', ...settled[0] },
    waiting: { side: 'admin', ...settled[1] },
    sqlstates: [...failures.codes],
    writes: {
      first_withdrawal_recorded: await withdrawn(secondGrant, firstWorkspace),
      second_withdrawal_recorded: await withdrawn(firstGrant, secondWorkspace),
    },
  };
}

/** Golden run: the real MCP protocol module and tool rendering over the real claim and read
 * backends. executeTool mirrors supabase/functions/mcp/index.ts:235-279 for claim_seat and whoami. */
async function golden(ctx) {
  const { out, observer, command } = ctx;
  out.stage = 'golden-fixture';
  const { createMcpProtocolHandler } = await ctx.load('supabase/functions/mcp/protocol.ts');
  const { MCP_ISSUER, MCP_RESOURCE } = await ctx.load('supabase/functions/mcp/auth.ts');
  const { executeClaimSeat } = await ctx.load('supabase/functions/mcp/claim-seat.ts');
  const { commandOutput, readOutput, HostedToolFailure } = await ctx.load('supabase/functions/mcp/tool-errors.ts');
  const { authenticateHostedSeatCapability } = await ctx.load('supabase/functions/_shared/hosted-seat-auth.ts');
  const read = await ctx.load('supabase/functions/read/index.ts','read');
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


/** M3 cases own the protected worker boundary, rather than re-testing the plan
 * helper. The regression is an own-parent status lock preceding a foreign
 * parent, or an unbounded/partially committed worker renewal after a wait. */
async function delegatedLocalScenario(ctx,scenario) {
  const {observer,out,failures}=ctx,checks=[];
  const check=(name,ok)=>checks.push({name,ok:ok===true});
  const accepted=r=>r.result.status===200 && r.result.body?.status==='accepted';
  const owner=await human(ctx,'m3-owner');
  const {workspaceId}=await workspace(ctx,owner,false);
  const admin=await adminSide(ctx,{owner,workspaceId},'m3-first');
  const read=await ctx.load('supabase/functions/read/index.ts','read');
  const use=async raw=>{
    const response=await read.handleRequest(new Request('http://127.0.0.1/functions/v1/read',{
      method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},
      body:JSON.stringify({resource:'renewal_grants',workspace_id:workspaceId}),
    }));
    return {status:response.status,body:await response.json()};
  };
  const provision=async (side,label)=>{
    const made=await side.invoke({kind:'admin_create_seat',grant_id:side.grant,workspace_id:workspaceId,
      name:`m3-${label}-${ctx.tag}`,model:null,transport:'local'});
    if (!accepted(made)) fail('delegated_create_control');
    const [p]=await observer`SELECT principal_id FROM swarm.agent_principals
      WHERE workspace_id=${workspaceId}::uuid AND name=${`m3-${label}-${ctx.tag}`}`;
    const issued=await side.invoke({kind:'admin_provision_seat',grant_id:side.grant,workspace_id:workspaceId,
      principal_id:p.principal_id,recipient_connection_id:side.connection,worker_scope_names:['post_signal'],
      bearer_seconds:120,horizon_seconds:600,max_successors:2},{worker:true});
    if (issued.result.status!==200 || !issued.delivery || issued.calls!==1) fail('delegated_provision_control');
    const used=await use(issued.delivery.credential);
    if (used.status!==200) fail('delegated_child_read_control');
    const [g]=await observer`SELECT g.renewal_grant_id,g.kind,g.max_successors,g.horizon_expires_at,
      t.first_used_at,t.token_id FROM swarm.renewal_grants g JOIN swarm.agent_tokens t USING(renewal_grant_id)
      WHERE t.token_id=${issued.delivery.credential_id}::uuid`;
    check(`bounded-admin-authority-${label}`,g.kind==='timeboxed' && g.max_successors===2 && g.horizon_expires_at instanceof Date && g.first_used_at instanceof Date);
    return {principal:p.principal_id,grant:g.renewal_grant_id,token:g.token_id,raw:issued.delivery.credential};
  };
  const seat=await provision(admin,'first');
  check('same-invocation-positive',(await observer`SELECT t.first_used_at IS NOT NULL AND g.kind='timeboxed' AS ok
    FROM swarm.agent_tokens t JOIN swarm.renewal_grants g USING(renewal_grant_id)
    WHERE t.token_id=${seat.token}::uuid`)[0]?.ok===true);
  const renewCommand=(side,s)=>({kind:'admin_renew_seat',grant_id:side.grant,workspace_id:workspaceId,
    principal_id:s.principal,predecessor_credential_id:s.token,recipient_connection_id:side.connection,
    worker_scope_names:['post_signal'],bearer_seconds:120});
  const family=async s=>{
    const [g]=await observer`SELECT successors_used,successors_stranded,revoked_at,connection_expires_at,connection_expired_at,last_used_at,last_used_device_id,new_host_at
      FROM swarm.renewal_grants WHERE renewal_grant_id=${s.grant}::uuid`;
    const tokens=await observer`SELECT token_id,predecessor_token_id,first_used_at,revoked_at,issued_at,expires_at,lineage_id FROM swarm.agent_tokens
      WHERE renewal_grant_id=${s.grant}::uuid ORDER BY token_id`;
    const [a]=await observer`SELECT projection->'routine'->'spend' AS spend FROM swarm.admin_accounts WHERE owner_user_id=${owner.userId}::uuid`;
    const tombstones=await observer`SELECT kind,target_id FROM swarm.revocation_tombstones
      WHERE target_id=${s.grant}::uuid OR target_id=ANY(${tokens.flatMap(t=>[t.token_id,t.lineage_id])}::uuid[])
      ORDER BY kind,target_id`;
    return JSON.stringify({g,tokens,tombstones,spend:a.spend});
  };
  if (scenario==='delegated-local-permanent-suspension') {
    // Ordinary standing issuance and explicitly consented delegated renewal.
    // No delegated-family conversion, preset first use, or ancestry mutation.
    for (const mode of ['null-renew','future-renew','null-replace','future-replace','elapsed','revoked','parent-dead','deadline-wait']) {
      const name=`permanent-${mode}-${ctx.tag}`;
      const created=await manage(ctx,owner,workspaceId,{kind:'create_agent_principal',name});
      if(created.status!==200 || !created.body.principal_id) fail('permanent_create_control');
      const principal={principal_id:created.body.principal_id};
      const side=await adminSide(ctx,{owner,workspaceId},`permanent-${mode}`,{renewalPrincipalIds:[principal.principal_id]});
      const device=id();await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${owner.userId}::uuid,'Permanent fixture')`;
      const minted=await manage(ctx,owner,workspaceId,{kind:'mint_agent_token',principal_id:principal.principal_id,
        run_id:id(),task_id:id(),epoch:1,device_id:device,ttl_ms:120000,scopes:['post_signal']});
      if(minted.status!==200 || !minted.body.agent_token) fail('permanent_ordinary_mint');
      const root={principal:principal.principal_id,token:minted.body.token_id,raw:minted.body.agent_token};
      const [binding]=await observer`SELECT renewal_grant_id FROM swarm.agent_tokens WHERE token_id=${root.token}::uuid`;
      root.grant=binding.renewal_grant_id;
      if(!mode.includes('replace') && (await use(root.raw)).status!==200) fail('permanent_actual_first_use');
      await observer`UPDATE swarm.renewal_grants SET suspended_at=clock_timestamp(),
        connection_expires_at=CASE WHEN ${mode.startsWith('future')} THEN clock_timestamp()+interval '1 hour'
          WHEN ${mode==='elapsed'} THEN clock_timestamp()-interval '1 second'
          WHEN ${mode==='deadline-wait'} THEN clock_timestamp()+interval '3 seconds' ELSE NULL END
        WHERE renewal_grant_id=${root.grant}::uuid`;
      if(mode==='revoked') await observer`UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp() WHERE renewal_grant_id=${root.grant}::uuid`;
      if(mode==='parent-dead') await observer`UPDATE swarm.admin_grants SET state='revoked',revoked_at=clock_timestamp() WHERE grant_id=${side.grant}::uuid`;
      const before=await family(root);
      const command=mode.includes('replace') ? {kind:'admin_replace_undelivered_seat_credential',grant_id:side.grant,
        workspace_id:workspaceId,principal_id:root.principal,credential_id:root.token,recipient_connection_id:side.connection}
        : renewCommand(side,root);
      let pending;
      if(mode==='deadline-wait') {
        await observer.begin(async tx=>{
          const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
          await tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id=${root.grant}::uuid FOR UPDATE`;
          pending=side.invoke(command,{worker:true});
          check('permanent-deadline-observed-family-wait',await waitForBlocked(observer,Number(pid),async()=>true,2000)!==null);
          await new Promise(resolve=>setTimeout(resolve,3200));
        });
      } else pending=side.invoke(command,{worker:true});
      const result=await pending;
      const positive=mode.startsWith('null') || mode.startsWith('future');
      check(`permanent-${mode}-delivery`,positive ? result.result.status===200 && result.calls===1 && result.delivery!==null
        : result.result.status===403 && result.calls===0);
      if(!positive) check(`permanent-${mode}-no-effects`,await family(root)===before);
    }
  } else if (scenario==='delegated-local-selector-compatibility') {
    const issued=await admin.invoke(renewCommand(admin,seat),{worker:true});
    if(issued.result.status!==200 || !issued.delivery || (await use(issued.delivery.credential)).status!==200) fail('legal_used_child_control');
    const child=issued.delivery.credential_id;
    await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      const old5=await tx`SELECT token_id FROM swarm.discover_local_target_ids(${workspaceId}::uuid,NULL::uuid,ARRAY[]::uuid[],ARRAY[${seat.token}::uuid],false)`;
      const old6=await tx`SELECT token_id FROM swarm.discover_local_target_ids(${workspaceId}::uuid,NULL::uuid,ARRAY[]::uuid[],ARRAY[${seat.token}::uuid],false,NULL::uuid)`;
      const revoking=await tx`SELECT token_id FROM swarm.discover_local_target_ids(${workspaceId}::uuid,NULL::uuid,ARRAY[]::uuid[],ARRAY[${seat.token}::uuid],false,NULL::uuid,true)`;
      check('old-five-six-callers-retain-proof-closure',JSON.stringify(old5)===JSON.stringify(old6) && !old5.some(t=>t.token_id===child));
      check('revocation-selector-includes-legal-used-child',revoking.some(t=>t.token_id===child) && revoking.some(t=>t.token_id===seat.token));
    });
    const [roles]=await observer`SELECT has_function_privilege('swarm_command','swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)','EXECUTE') AS command,
      NOT has_function_privilege('authenticated','swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)','EXECUTE') AS human_denied,
      NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname LIKE '%oauth%' AND
        has_function_privilege(r.oid,'swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)','EXECUTE')) AS oauth_denied`;
    check('internal-selector-command-only-roles',roles.command && roles.human_denied && roles.oauth_denied);
  } else if (scenario==='delegated-local-revocation-closure') {
    const issued=await admin.invoke(renewCommand(admin,seat),{worker:true});
    if(issued.result.status!==200 || !issued.delivery || (await use(issued.delivery.credential)).status!==200) fail('legal_used_child_control');
    const child=issued.delivery.credential_id;
    const revoke={kind:'admin_revoke_seat_credential',grant_id:admin.grant,workspace_id:workspaceId,
      principal_id:seat.principal,credential_id:seat.token,reason_code:'owner_requested'};
    let pending;
    await observer.begin(async tx=>{
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT token_id FROM swarm.agent_tokens WHERE token_id=${child}::uuid FOR UPDATE`;
      pending=admin.invoke(revoke);
      check('used-direct-child-observed-wait',await waitForBlocked(observer,Number(pid),p=>ownedWait(observer,p,{tokens:[child]},Number(pid)),3500)!==null);
      let blocked=false;
      try { await observer.begin(async probe=>{
        await probe`SELECT principal_id FROM swarm.agent_principals WHERE principal_id=${seat.principal}::uuid FOR SHARE NOWAIT`;
      }); } catch(error) { blocked=sqlstate(error)==='55P03'; }
      check('principal-update-preheld-before-used-child',blocked);
    });
    const revoked=await pending;
    const rows=await observer`SELECT token_id,revoked_at FROM swarm.agent_tokens WHERE token_id=ANY(${[seat.token,child]}::uuid[])`;
    check('credential-revoke-ends-both-legal-tokens',revoked.result.status===200 && rows.length===2 && rows.every(t=>t.revoked_at!==null));
    check('credential-lineage-tombstone',(await observer`SELECT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z
      JOIN swarm.agent_tokens t ON t.lineage_id=z.target_id WHERE z.kind='lineage' AND t.token_id=${seat.token}::uuid) AS ok`)[0].ok);
    // Seat revocation must also end a genuinely ungranted legacy credential.
    const residual=await provision(admin,'residual'),run=id(),device=id(),token=id(),lineage=id();
    const raw=`swm_agt_${base64url(randomBytes(32))}`,hash=new Uint8Array(createHash('sha256').update(raw).digest());
    await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${owner.userId}::uuid,'Residual fixture')`;
    await observer`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES(${run}::uuid,${residual.principal}::uuid,${device}::uuid)`;
    await observer`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id,recipient_connection_id)
      VALUES(${token}::uuid,${residual.principal}::uuid,${run}::uuid,${id()}::uuid,1,${observer.json(['post_signal'])},${hash},clock_timestamp()+interval '1 hour',${lineage}::uuid,${admin.connection}::uuid)`;
    if((await use(raw)).status!==200) fail('ungranted_residual_runtime_control');
    const extra=[];
    for(const mode of ['active-family','prior-grant']) {
      // Canonical legacy rows, including a historically revoked family with
      // an uncleared current root. No trigger is disabled or ancestry edited.
      const familyId=id(),runId=id(),tokenId=id(),lineageId=id();
      const secret=`swm_agt_${base64url(randomBytes(32))}`,digest=new Uint8Array(createHash('sha256').update(secret).digest());
      await observer`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id)
        VALUES(${runId}::uuid,${residual.principal}::uuid,${device}::uuid)`;
      await observer`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,
        horizon_expires_at,bound_device_id,created_by,revoked_at)
        VALUES(${familyId}::uuid,${workspaceId}::uuid,${residual.principal}::uuid,${runId}::uuid,'standing',NULL,NULL,
          ${device}::uuid,${owner.userId}::uuid,CASE WHEN ${mode==='prior-grant'} THEN clock_timestamp() ELSE NULL END)`;
      await observer`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,
        expires_at,lineage_id,renewal_grant_id,recipient_connection_id)
        VALUES(${tokenId}::uuid,${residual.principal}::uuid,${runId}::uuid,${id()}::uuid,1,${observer.json(['post_signal'])},
          ${digest},clock_timestamp()+interval '1 hour',${lineageId}::uuid,${familyId}::uuid,${admin.connection}::uuid)`;
      if(mode==='active-family' && (await use(secret)).status!==200) fail('second_active_family_control');
      extra.push(tokenId);
    }

    const ended=await admin.invoke({kind:'admin_revoke_seat',grant_id:admin.grant,workspace_id:workspaceId,
      principal_id:residual.principal,reason_code:'owner_requested'});
    const [facts]=await observer`SELECT t.revoked_at IS NOT NULL AS ended,
      EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='token' AND z.target_id=t.token_id) AS token_tomb,
      EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='lineage' AND z.target_id=t.lineage_id) AS lineage_tomb,
      NOT EXISTS(SELECT 1 FROM swarm.renewal_grants g WHERE g.principal_id=t.principal_id AND g.revoked_at IS NULL) AS grants_ended
      FROM swarm.agent_tokens t WHERE t.token_id=${token}::uuid`;
    check('seat-revoke-ends-ungranted-residual-and-all-grants',ended.result.status===200 && facts.ended && facts.token_tomb && facts.lineage_tomb && facts.grants_ended);
    check('residual-no-longer-authenticates',(await use(raw)).status===403);
    const [extraEffects]=await observer`SELECT count(*)=2 AND bool_and(t.revoked_at IS NOT NULL) AS ended,
      bool_and(EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='lineage' AND z.target_id=t.lineage_id)) AS tombs
      FROM swarm.agent_tokens t WHERE token_id=ANY(${extra}::uuid[])`;
    check('all-active-and-prior-grant-residuals-ended',extraEffects.ended && extraEffects.tombs);

    const lateAdmin=await adminSide(ctx,{owner,workspaceId},'revoke-final-fence');
    const late=await provision(lateAdmin,'late-revoke');
    await observer`UPDATE swarm.admin_grants SET expires_at=clock_timestamp()+interval '3 seconds'
      WHERE grant_id=${lateAdmin.grant}::uuid`;
    const before=await family(late);let latePending;
    await observer.begin(async tx=>{
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      await tx`LOCK TABLE swarm.admin_command_results IN SHARE MODE`;
      latePending=lateAdmin.invoke({kind:'admin_revoke_seat',grant_id:lateAdmin.grant,workspace_id:workspaceId,
        principal_id:late.principal,reason_code:'owner_requested'});
      check('revocation-final-ledger-wait-observed',await waitForBlocked(observer,Number(pid),async()=>true,2000)!==null);
      await new Promise(resolve=>setTimeout(resolve,3200));
    });
    const lateResult=await latePending;
    check('final-admin-expiry-rolls-back-revocation',lateResult.result.status!==200 && await family(late)===before
      && (await observer`SELECT revoked_at IS NULL AS live FROM swarm.agent_principals WHERE principal_id=${late.principal}::uuid`)[0].live);

  } else if (scenario==='delegated-local-parent-reversal') {
    const other=await human(ctx,'m3-other');await member(ctx,workspaceId,other,'admin');
    const second=await adminSide(ctx,{owner:other,workspaceId},'m3-second');
    await provision(second,'second');
    // Start the higher-parent owner first. On the old path it holds its own
    // high parent while waiting on low; the low owner then waits back on high.
    const [low,high]=[admin,second].sort((a,b)=>a.grant.localeCompare(b.grant));
    await high.arm();await low.arm();
    let release,ready,pid;
    const held=new Promise(r=>{ready=r;}),released=new Promise(r=>{release=r;});
    const blocker=observer.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`SELECT set_config('lock_timeout','30s',true)`;
      pid=Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await tx`SELECT grant_id FROM swarm.admin_grants WHERE grant_id=${low.grant}::uuid FOR UPDATE`;
      ready();await released;
    });
    await held;
    let a,b;
    failures.codes.length=0;failures.recording=true;
    try {
      a=settleSide(high.start());
      const first=await waitForBlocked(observer,pid,async()=>true,3500);
      check('higher-owner-waits-before-foreign-parent',first!==null);
      if (first===null) fail('higher_parent_not_parked');
      b=settleSide(low.start());
      const deadline=Date.now()+3500;let secondBlocked=false;
      while(Date.now()<deadline && !secondBlocked) {
        const rows=await observer`SELECT pid FROM pg_stat_activity WHERE pid<>${first}::int
          AND (${pid}::int=ANY(pg_blocking_pids(pid)) OR ${first}::int=ANY(pg_blocking_pids(pid)))`;
        secondBlocked=rows.length===1;
        if (!secondBlocked) await new Promise(r=>setTimeout(r,20));
      }
      check('reverse-owner-reaches-same-parent-union',secondBlocked);
    } finally {release();await blocker;}
    const results=await Promise.all([a,b]);failures.recording=false;
    check('two-owner-actual-delegated-commands-commit',results.every(r=>r.ok));
    check('no-parent-reversal-deadlock',failures.codes.length===0);
    check('both-exact-writes',await principalLive(ctx,workspaceId,high.name) && await principalLive(ctx,workspaceId,low.name));
    check('both-oauth-audits-committed',JSON.stringify([...await high.audit(),...await low.audit()])===JSON.stringify(['committed','committed']));
  } else if (scenario==='delegated-local-renewal-budget') {
    const foreignOwner=await human(ctx,'foreign-workspace'),foreignWorkspace=await workspace(ctx,foreignOwner,false);
    let foreignCall,completed;
    await observer.begin(async tx=>{
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${foreignWorkspace.workspaceId}::uuid FOR UPDATE`;
      foreignCall=admin.invoke({kind:'admin_create_seat',grant_id:admin.grant,workspace_id:foreignWorkspace.workspaceId,
        name:`foreign-${ctx.tag}`,model:null,transport:'local'});
      completed=await Promise.race([foreignCall,new Promise(resolve=>setTimeout(()=>resolve(null),2500))]);
      const [{n}]=await observer`SELECT count(*)::int AS n FROM pg_stat_activity a
        WHERE ${pid}=ANY(pg_blocking_pids(a.pid)) AND a.wait_event_type='Lock'`;
      check('delegated-foreign-request-holds-no-victim-lock',n===0);
    });
    const foreignResponse=await foreignCall;
    check('delegated-foreign-refusal-completes-before-victim-unlocks',completed!==null && foreignResponse.result.status===403 && foreignResponse.calls===0);

    const ownerEdit=await manage(ctx,owner,workspaceId,{kind:'set_connection_expiry',connection_kind:'renewal',grant_id:seat.grant,connection_expires_at:null});
    check('same-target-human-owner-policy-positive',ownerEdit.status===200);
    const before=await family(seat);
    const foreign=await admin.invoke({...renewCommand(admin,seat),recipient_connection_id:id()},{worker:true});
    const broadened=await admin.invoke({...renewCommand(admin,seat),worker_scope_names:['post_signal','acquire']},{worker:true});
    const humanOnly=await admin.invoke({kind:'set_connection_expiry',connection_kind:'renewal',grant_id:seat.grant,connection_expires_at:null});
    check('recipient-scope-and-human-boundaries',foreign.result.status===403 && foreign.result.body.error==='recipient_runtime_required' && broadened.result.status===403 && broadened.result.body.error==='worker_scope_forbidden' && humanOnly.result.status===403 && humanOnly.result.body.error==='human_confirmation_required' && !foreign.calls && !broadened.calls);
    check('boundary-refusals-spend-nothing',await family(seat)===before);
    const winner=await Promise.all([admin.invoke(renewCommand(admin,seat),{worker:true}),admin.invoke(renewCommand(admin,seat),{worker:true})]);
    const committed=winner.filter(r=>r.result.status===200 && r.calls===1),refused=winner.filter(r=>r.result.status===403 && r.calls===0);
    check('concurrent-renewal-one-delivered-successor',committed.length===1 && refused.length===1);
    if (committed.length!==1) fail('budget_successor_control');
    let current={...seat,token:committed[0].delivery.credential_id,raw:committed[0].delivery.credential};
    check('winner-usable-on-independent-read-connection',(await use(current.raw)).status===200);
    const next=await admin.invoke(renewCommand(admin,current),{worker:true});
    check('last-budget-unit-delivered',next.result.status===200 && next.calls===1);
    if (!next.delivery) fail('last_budget_control');
    current={...seat,token:next.delivery.credential_id,raw:next.delivery.credential};
    await use(current.raw);
    const exhaustedBefore=await family(seat),exhausted=await admin.invoke(renewCommand(admin,current),{worker:true});
    check('budget-exhaustion-denies-without-delivery',exhausted.result.status===403 && exhausted.calls===0 && exhausted.result.body.error==='renewal_successors_exhausted');
    check('budget-exhaustion-no-family-or-spend-effect',await family(seat)===exhaustedBefore);
    const [g]=await observer`SELECT successors_used,successors_stranded FROM swarm.renewal_grants WHERE renewal_grant_id=${seat.grant}::uuid`;
    const [t]=await observer`SELECT count(*)::int AS n FROM swarm.agent_tokens WHERE renewal_grant_id=${seat.grant}::uuid`;
    check('exact-committed-successor-accounting',g.successors_used===2 && g.successors_stranded===0 && t.n===3);
  } else if (scenario==='delegated-local-parent-deadline' || scenario==='delegated-local-parent-narrowing') {
    const before=await family(seat);let pending,pid;
    await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      pid=Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await tx`SELECT grant_id FROM swarm.admin_grants WHERE grant_id=${admin.grant}::uuid FOR UPDATE`;
      pending=admin.invoke(renewCommand(admin,seat),{worker:true});
      check('actual-renewal-waits-before-parent-check',await waitForBlocked(observer,pid,async()=>true,3500)!==null);
      if (scenario==='delegated-local-parent-deadline') {
        await tx`UPDATE swarm.admin_grants SET expires_at=clock_timestamp()+interval '200 milliseconds'
          WHERE grant_id=${admin.grant}::uuid`;
        await tx`SELECT pg_sleep(0.25)`;
      } else await tx`UPDATE swarm.admin_grants SET scope_names=array_remove(scope_names,'seats:renew')
        WHERE grant_id=${admin.grant}::uuid`;
    });
    const result=await pending;
    check('post-wait-parent-policy-current',result.result.status===403 && result.calls===0 && result.result.body.error==='grant_inactive');
    check('expired-or-narrowed-parent-no-credential-or-spend',await family(seat)===before);
  } else {
    out.stage='forced-rollback';
    const before=await family(seat),fn=`m3_rollback_${ctx.tag}`;
    const commandId=id();let rolled;
    try {
      await observer.unsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture serialization' USING ERRCODE='40001'; END $$`);
      await observer.unsafe(`CREATE TRIGGER ${fn} AFTER INSERT ON swarm.agent_tokens FOR EACH ROW WHEN (NEW.predecessor_token_id='${seat.token}'::uuid) EXECUTE FUNCTION public.${fn}()`);
      rolled=await admin.invoke(renewCommand(admin,seat),{worker:true,commandId});
    } finally {
      await observer.unsafe(`DROP TRIGGER IF EXISTS ${fn} ON swarm.agent_tokens`);
      await observer.unsafe(`DROP FUNCTION IF EXISTS public.${fn}()`);
    }
    check('actual-worker-transaction-serialization-rollback',rolled.result.status===503 && rolled.calls===0 && await family(seat)===before);
    const [success]=await observer`SELECT
      (SELECT count(*) FROM swarm.events WHERE command_id=${commandId})::int AS workspace_events,
      (SELECT count(*) FROM swarm.admin_events WHERE command_id=${commandId} AND type<>'AdminActionRecorded')::int AS success_events,
      (SELECT count(*) FROM swarm.admin_command_results WHERE command_id=${commandId} AND response->>'status'='200')::int AS success_replies`;
    check('rollback-no-success-event-or-credential-reply',success.workspace_events===0 && success.success_events===0 && success.success_replies===0);
    // An independent parent's SHARE lock must only serialize the real child
    // mutation; the implementation must not open a second DB connection while
    // holding its own plan. The mutation completes immediately after release.
    let pending,pid;
    await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      pid=Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await tx`SELECT grant_id FROM swarm.admin_grants WHERE grant_id=${admin.grant}::uuid FOR SHARE`;
      pending=admin.invoke(renewCommand(admin,seat),{worker:true});
      check('actual-child-mutation-waits-on-cross-connection-parent',await waitForBlocked(observer,pid,async()=>true,3500)!==null);
    });
    const control=await pending;
    check('parent-wait-releases-without-self-deadlock',control.result.status===200 && control.calls===1);
    if (!control.delivery) fail('post_rollback_control');
    let current={...seat,token:control.delivery.credential_id,raw:control.delivery.credential};
    await use(current.raw);
    // Native child mutation must finish while a DIFFERENT connection retains
    // parent SHARE. A new internal connection taking incompatible parent locks
    // would wait on itself here; releasing the fixture early would hide it.
    let nativePending,nativeWhileHeld;
    await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`SELECT grant_id FROM swarm.admin_grants WHERE grant_id=${admin.grant}::uuid FOR SHARE`;
      nativePending=ctx.command.handleRequest(new Request('http://127.0.0.1/functions/v1/command',{
        method:'POST',headers:{authorization:`Bearer ${current.raw}`,'content-type':'application/json'},
        body:JSON.stringify({command_id:id(),client_version:ctx.clientVersion,workspace_id:workspaceId,
          stream:{kind:'workspace'},command:{kind:'renew_agent_token'}})}));
      nativeWhileHeld=await Promise.race([nativePending,new Promise(resolve=>setTimeout(()=>resolve(null),3500))]);
      check('native-child-mutation-finishes-while-cross-connection-parent-held',nativeWhileHeld!==null && nativeWhileHeld.status===200);
    });
    const nativeResponse=nativeWhileHeld ?? await nativePending,nativeBody=await nativeResponse.json();
    if (typeof nativeBody.agent_token!=='string') fail('native_parent_share_control');
    current={...seat,token:nativeBody.token_id,raw:nativeBody.agent_token};
    check('cross-connection-child-remains-usable',(await use(current.raw)).status===200);
    const liveBefore=await family(seat);
    // This is a trusted backend policy reduction under the production role,
    // never a caller UUID masquerading as a new cryptographic authority.
    await observer.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      pid=Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await tx`SELECT grant_id FROM swarm.admin_grants WHERE grant_id=${admin.grant}::uuid FOR UPDATE`;
      pending=admin.invoke(renewCommand(admin,current),{worker:true});
      check('renewal-blocked-before-parent-policy-reduction',await waitForBlocked(observer,pid,async()=>true,3500)!==null);
      await tx`UPDATE swarm.admin_grants SET state='revoked',revoked_at=clock_timestamp(),reason_code='test_parent_removed'
        WHERE grant_id=${admin.grant}::uuid`;
    });
    const denied=await pending;
    check('fresh-parent-denial-after-wait',denied.result.status===403 && denied.calls===0 && denied.result.body.error==='grant_inactive');
    check('parent-removal-no-renewal-or-budget-effect',await family(seat)===liveBefore);
    check('removed-parent-child-unusable',(await use(current.raw)).status!==200);
    // Same-invocation native human removal reaches the actual workspace command
    // and revokes the other member's family before membership is removed.
    const keeper=await human(ctx,'m3-keeper');await member(ctx,workspaceId,keeper,'owner');
    keeper.identity.interactiveAuthAtSeconds=Number((await observer`SELECT extract(epoch FROM clock_timestamp()) AS seconds`)[0].seconds);
    const removed=await manage(ctx,keeper,workspaceId,{kind:'remove_member',user_id:owner.userId,landing_authority_successor_user_id:keeper.userId});
    check('human-removal-through-real-command',removed.status===200 && removed.body.status==='accepted');
    const [terminal]=await observer`SELECT m.revoked_at IS NOT NULL AS removed,g.revoked_at IS NOT NULL AS revoked,
      EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='renewal_grant' AND z.target_id=g.renewal_grant_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens t WHERE t.renewal_grant_id=g.renewal_grant_id AND t.revoked_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child WHERE child.predecessor_token_id=t.token_id
            AND child.first_used_at IS NOT NULL AND child.revoked_at IS NULL)) AS all_tokens_revoked
      FROM swarm.memberships m JOIN swarm.renewal_grants g ON g.workspace_id=m.workspace_id
      WHERE m.workspace_id=${workspaceId}::uuid AND m.user_id=${owner.userId}::uuid AND g.renewal_grant_id=${seat.grant}::uuid`;
    check('membership-and-hidden-parent-family-atomic',terminal.removed && terminal.revoked && terminal.all_tokens_revoked);
  }
  return {checks};
}

/** Compatibility owns the old ordinary mint wire and the existing policy
 * setter/read/ledger boundary. It does not simulate a newer client default. */
async function ordinaryLocalPolicyScenario(ctx) {
  const {observer}=ctx,checks=[];
  const check=(name,ok)=>checks.push({name,ok:ok===true});
  const owner=await human(ctx,'compat-owner'),other=await human(ctx,'compat-admin');
  const {workspaceId}=await workspace(ctx,owner,false);await member(ctx,workspaceId,other,'admin');
  const created=await manage(ctx,owner,workspaceId,{kind:'create_agent_principal',name:`compat-${ctx.tag}`});
  if (created.status!==200 || typeof created.body.principal_id!=='string') fail('compat_principal_control');
  const device=id();await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${owner.userId}::uuid,'compat fixture')`;
  const minted=await manage(ctx,owner,workspaceId,{kind:'mint_agent_token',principal_id:created.body.principal_id,
    run_id:id(),task_id:id(),epoch:1,device_id:device,scopes:['post_signal'],
    renewal_kind:'timeboxed',renewal_horizon_ms:30*86400000});
  if (minted.status!==200 || typeof minted.body.agent_token!=='string') fail('compat_old_wire_mint');
  check('same-invocation-positive',minted.status===200 && minted.body.status==='accepted'
    && (await observer`SELECT EXISTS(SELECT 1 FROM swarm.agent_tokens WHERE token_id=${minted.body.token_id}::uuid) AS ok`)[0]?.ok===true);
  check('actual-old-wire-is-permanent-default',minted.body.grant_kind==='standing' && minted.body.horizon_expires_at===null && minted.body.successors_remaining===null);
  check('actual-mint-truthful-null-policy',Object.hasOwn(minted.body,'connection_expires_at') && minted.body.connection_expires_at===null && Object.hasOwn(minted.body,'connection_expired_at') && minted.body.connection_expired_at===null);
  const [g]=await observer`SELECT g.* FROM swarm.renewal_grants g JOIN swarm.agent_tokens t USING(renewal_grant_id) WHERE t.token_id=${minted.body.token_id}::uuid`;
  check('old-default-does-not-persist-technical-horizon',g.kind==='standing' && g.horizon_expires_at===null && g.max_successors===null);
  const read=await ctx.load('supabase/functions/read/index.ts','read');
  let credential=minted.body.agent_token;
  const readPolicy=async()=>{
    const response=await read.handleRequest(new Request('http://127.0.0.1/functions/v1/read',{
      method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},
      body:JSON.stringify({resource:'renewal_grants',workspace_id:workspaceId})}));
    return {status:response.status,body:await response.json()};
  };
  const first=await readPolicy();
  check('existing-agent-read-truthful-null-policy',first.status===200 && first.body.grants.length===1 && first.body.grants[0].connection_expires_at===null && first.body.grants[0].connection_expired_at===null);
  await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second'
    WHERE token_id=${minted.body.token_id}::uuid`;
  const renewalResponse=await ctx.command.handleRequest(new Request('http://127.0.0.1/functions/v1/command',{
    method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},
    body:JSON.stringify({command_id:id(),client_version:ctx.clientVersion,workspace_id:workspaceId,
      stream:{kind:'workspace'},command:{kind:'renew_agent_token'}})}));
  const renewed=await renewalResponse.json();
  check('old-wire-family-silent-expired-proof-renewal',renewalResponse.status===200 && renewed.status==='accepted' && typeof renewed.agent_token==='string'
    && renewed.grant_kind==='standing' && renewed.connection_expires_at===null && renewed.connection_expired_at===null);
  if (typeof renewed.agent_token!=='string') fail('compat_silent_renewal_control');
  credential=renewed.agent_token;
  check('silently-renewed-credential-usable',(await readPolicy()).status===200);
  const policy=expiry=>({kind:'set_connection_expiry',connection_kind:'renewal',grant_id:g.renewal_grant_id,connection_expires_at:expiry});
  const earlier=new Date(Date.now()+120000).toISOString(),later=new Date(Date.now()+240000).toISOString();
  const chosen=await manage(ctx,owner,workspaceId,policy(earlier));
  check('valid-stale-human-owner-may-choose-date',chosen.status===200 && chosen.body.connection_expires_at===earlier && chosen.body.previous_connection_expires_at===null);
  const chosenRead=await readPolicy();
  check('existing-read-reports-owner-canonical-date',chosenRead.status===200 && chosenRead.body.grants[0]?.connection_expires_at===earlier);
  const agentAttempt=await ctx.command.handleRequest(new Request('http://127.0.0.1/functions/v1/command',{
    method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},
    body:JSON.stringify({command_id:id(),client_version:ctx.clientVersion,workspace_id:workspaceId,stream:{kind:'workspace'},command:policy(null)})}));
  check('agent-cannot-edit-owner-policy',agentAttempt.status===403);
  const foreign=await manage(ctx,other,workspaceId,policy(null));
  check('role-only-admin-cannot-edit-owner-policy',foreign.status===403);
  const extended=await manage(ctx,owner,workspaceId,policy(later)),cleared=await manage(ctx,owner,workspaceId,policy(null));
  check('future-date-extension-and-clear',extended.status===200 && extended.body.previous_connection_expires_at===earlier && cleared.status===200 && cleared.body.previous_connection_expires_at===later && cleared.body.connection_expires_at===null);
  const after=await readPolicy();
  check('read-after-clear-uses-canonical-policy',after.status===200 && after.body.grants[0]?.connection_expires_at===null);
  const [receipts]=await observer`SELECT count(*)::int AS n FROM swarm.idempotency_keys WHERE workspace_id=${workspaceId}::uuid
    AND principal_id=${owner.userId} AND response ? 'previous_connection_expires_at'`;
  check('actual-policy-before-after-ledger',receipts.n===3);
  await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
    WHERE renewal_grant_id=${g.renewal_grant_id}::uuid`;
  const elapsed=await manage(ctx,owner,workspaceId,policy(null));
  check('elapsed-date-cannot-clear-or-revive',elapsed.status===403 && (await readPolicy()).status!==200);
  const [persisted]=await observer`SELECT connection_expires_at<clock_timestamp() AS elapsed FROM swarm.renewal_grants WHERE renewal_grant_id=${g.renewal_grant_id}::uuid`;
  check('terminal-policy-preserved',persisted.elapsed===true);
  return {checks};
}


/** Resume owns the cross-owner human W/admin A cycle. Fixtures mint through
 * real command/worker paths; only persisted clock/pause state is aged directly.
 * The existing X2 boundary observes every rejected transaction, so retries
 * cannot turn a deadlock into an apparently successful assertion. */
/** Exact historical Allow regression. The worker token is issued and retired by
 * real delegated commands on an ordinary, parentless principal. The competing
 * writer is the AS lifecycle on a dedicated real issuer session, not edge SQL.
 * Test-audit owner: this harness; baseline c2185eadd41d29f324fbc90e5192e07748c6ff58.
 * Source authoring is not a measured baseline-red/head-green result. */
async function localAllowRetiredParentScenario(ctx,scenario) {
  const {observer,failures,out}=ctx,checks=[];
  const check=(name,ok)=>checks.push({name,ok:ok===true});
  const owner=await human(ctx,'allow-owner');
  const {workspaceId}=await workspace(ctx,owner,false);
  const created=await manage(ctx,owner,workspaceId,{kind:'create_agent_principal',name:`allow-${ctx.tag}`});
  if(created.status!==200 || !created.body.principal_id) fail('allow_principal_control');
  const principal=created.body.principal_id;
  const admin=await adminSide(ctx,{owner,workspaceId},'allow-issuer');
  const issued=await admin.invoke({kind:'admin_provision_seat',grant_id:admin.grant,workspace_id:workspaceId,
    principal_id:principal,recipient_connection_id:admin.connection,worker_scope_names:['post_signal'],
    bearer_seconds:120,horizon_seconds:600,max_successors:2},{worker:true});
  if(issued.result.status!==200 || issued.calls!==1 || !issued.delivery) fail('allow_provision_control');
  const token=issued.delivery.credential_id;
  const [binding]=await observer`SELECT t.run_id,t.renewal_grant_id,t.parent_admin_grant_id AS parent,
    p.parent_admin_grant_id AS principal_parent FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
    WHERE t.token_id=${token}::uuid`;
  check('legal-parentless-principal-token-parent',binding?.parent===admin.grant && binding.principal_parent===null);
  const connection={kind:'local',connection_id:token,grant_id:binding.run_id,principal_id:principal,operations:['read']};
  const allow=c=>manage(ctx,owner,workspaceId,{kind:'household_permissions',purpose:'shared',content_role:'reader',connection:c});
  check('same-invocation-positive',(await allow(connection)).body?.status==='committed');
  const revoked=await admin.invoke({kind:'admin_revoke_seat_credential',grant_id:admin.grant,workspace_id:workspaceId,
    principal_id:principal,credential_id:token,reason_code:'human_revoke'});
  if(revoked.result.status!==200 || revoked.result.body?.status!=='accepted') fail('allow_retirement_control');
  check('real-retired-token-active-parent',(await observer`SELECT t.revoked_at IS NOT NULL AND a.state='active'
    AND a.revoked_at IS NULL AS ok FROM swarm.agent_tokens t JOIN swarm.admin_grants a ON a.grant_id=t.parent_admin_grant_id
    WHERE t.token_id=${token}::uuid`)[0]?.ok===true);

  // Target came through openLockOrderTarget's Docker/TLS binding, unchanged.
  // Never alter a role/password/membership or reset session authorization.
  const {createRequire}=await import('node:module');
  const require=createRequire(new URL('../../services/mcp-auth/package.json',import.meta.url));
  const {Client}=require('pg');
  const {AdminTransactionCoordinator,scopedAdminPool}=await import('../../services/mcp-auth/src/admin-transaction.js');
  const {AdminTokenLifecycle,adminTokenLifetime}=await import('../../services/mcp-auth/src/admin-lifecycle.js');
  const {verifyAdminProof,admitAdminProof}=await import('../../services/mcp-auth/src/admin-dpop.js');
  const {createPostgresAdapter}=await import('../../services/mcp-auth/src/postgres-adapter.js');
  const clients=new Set(),closed=[];
  let issuerPid=null,holdParent=null,parentSeen=null;
  const pool={connect:async()=>{
    const raw=new Client({connectionString:ctx.issuerTarget.url,ssl:ctx.issuerTarget.ssl});
    clients.add(raw);
    try {
      await raw.connect();
      await raw.query('SET SESSION AUTHORIZATION commonswarm_admin_issuer');
      const identity=(await raw.query(`SELECT session_user,current_user,rolsuper FROM pg_roles WHERE rolname=session_user`)).rows[0];
      if(identity?.session_user!=='commonswarm_admin_issuer' || identity.current_user!==identity.session_user || identity.rolsuper!==false)
        fail('issuer_session_identity');
      const memberships=(await raw.query(`SELECT r.rolname,m.admin_option,m.inherit_option,m.set_option
        FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member=current_user::regrole ORDER BY r.rolname`)).rows;
      if(memberships.length!==2 || memberships.some((r,i)=>r.rolname!==['commonswarm_oauth_runtime','swarm_command'][i]
        || r.admin_option || r.inherit_option || !r.set_option)) fail('issuer_membership_contract');
      for(const role of ['commonswarm_oauth_runtime','swarm_command']) {
        await raw.query('BEGIN');await raw.query(`SET LOCAL ROLE ${role}`);
        if((await raw.query('SELECT current_user')).rows[0]?.current_user!==role) fail('issuer_set_role');
        await raw.query('ROLLBACK');
      }
      let denied=false;
      try { await raw.query('SET ROLE swarm_admin'); } catch(error) { denied=sqlstate(error)==='42501'; }
      if(!denied) fail('issuer_unrelated_role_admitted');
      check('issuer-real-session-and-set-only-roles',true);
      return {processID:raw.processID,end:()=>raw.end(),release:()=>{
        clients.delete(raw);closed.push(raw.end().catch(()=>{}));
      },query:async(sql,values)=>{
        const result=await raw.query(sql,values);
        // Pause only after the real lifecycle account() acquired its R locks.
        if(holdParent && /FROM swarm\.admin_grants WHERE owner_user_id=\$1 ORDER BY grant_id FOR UPDATE/u.test(sql)) {
          issuerPid=raw.processID;parentSeen.open();await holdParent.opened;
        }
        return result;
      }};
    } catch(error) {clients.delete(raw);await raw.end().catch(()=>{});throw error;}
  }};
  const response=()=>{
    const headers=new Map();return {statusCode:204,headersSent:false,destroyed:false,
      setHeader:(k,v)=>headers.set(k,v),getHeaderNames:()=>[...headers.keys()],removeHeader:k=>headers.delete(k),
      writeHead(){},write(){return true;},end(){},flushHeaders(){}};
  };
  const gate=()=>{let open;const opened=new Promise(resolve=>{open=resolve;});return {open,opened};};
  const coordinator=new AdminTransactionCoordinator(pool,{adminIssuanceEnabled:true});
  const {oauth,kid}=admin.issuerFixture;
  const lifecycle=new AdminTokenLifecycle({activeKid:kid});
  const Adapter=createPostgresAdapter(scopedAdminPool()),artifact=new Adapter('AuthorizationCode');
  const code=id(),hash=createHash('sha256').update(code).digest('base64url');
  const [candidate]=await observer`SELECT * FROM commonswarm_oauth.admin_grant_bindings WHERE admin_grant_id=${admin.grant}::uuid`;
  const capability={kind:'token',owner:owner.userId,proof:null};
  const proof=async nonce=>verifyAdminProof({method:'POST',headers:{dpop:await oauth.sign({typ:'dpop+jwt',alg:'ES256',jwk:oauth.jwk},
    {htm:'POST',htu:'https://mcp.commonswarm.com/token',iat:Math.floor(Date.now()/1000),jti:id(),...(nonce?{nonce}:{})},oauth.keys.privateKey)}},candidate.jkt);
  try {
    let nonce;
    try {await admitAdminProof(pool,await proof());} catch(error) {if(error.code!=='use_dpop_nonce') throw error;nonce=error.nonce;}
    capability.proof=await admitAdminProof(pool,await proof(nonce));
    const setupResponse=response();
    const setup=await coordinator.run(setupResponse,async()=>{
      await artifact.upsert(code,{grantId:candidate.provider_grant_id,clientId:candidate.client_id,jkt:candidate.jkt,
        resource:candidate.resource,iat:Math.floor(Date.now()/1000)},120);
      setupResponse.end();
    },capability);
    // Coordinator requires a staged response even for fixture artifact setup.
    if(setup.outcome!=='committed') fail('issuer_artifact_setup');
    const issue=async(rollback=false)=>{
      const requestCapability={...capability,proof:await admitAdminProof(pool,await proof(nonce))};
      const res=response();
      const result=await coordinator.run(res,async scope=>{
        issuerPid=scope.physical.processID;
        const unit=await lifecycle.prepareToken({binding:candidate,model:'AuthorizationCode',hash,consumed_at:null},
          {resource:candidate.resource,client_id:candidate.client_id});
        await artifact.consume(code);
        const now=Math.floor(Date.now()/1000);
        const claims={...oauth.claims,...lifecycle.claims({grantId:candidate.provider_grant_id}),
          jti:id(),iat:now,exp:now+adminTokenLifetime(unit.binding,now)};
        const access=await oauth.sign({typ:'at+jwt',alg:'ES256',kid},claims,admin.issuerFixture.signing.privateKey);
        await lifecycle.recordToken({access_token:access,token_type:'DPoP'});
        if(rollback) throw Object.assign(new Error('fixture rollback'),{code:'V17_ROLLBACK'});
        res.end();
      },requestCapability);
      if(result.cause && failures.recording) {failures.codes.push(sqlstate(result.cause));
        if(sqlstate(result.cause)==='40P01') failures.deadlocks.push(deadlockEdges(result.cause));}
      return result;
    };
    const state=async()=>JSON.stringify({token:(await observer`SELECT revoked_at,first_used_at FROM swarm.agent_tokens WHERE token_id=${token}::uuid`)[0],
      approvals:await observer`SELECT consent_receipt_id,revoked_at FROM swarm.household_content_connections WHERE connection_id=${token}::uuid`});
    const before=await state();
    const issuerState=async()=>JSON.stringify((await observer`SELECT a.projection,a.seq,b.generation,b.initial_issued_at,
      (SELECT count(*) FROM swarm.admin_events e WHERE e.owner_user_id=a.owner_user_id) AS events,
      (SELECT count(*) FROM commonswarm_oauth.admin_oauth_audit x WHERE x.admin_grant_id=b.admin_grant_id) AS audits,
      (SELECT count(*) FROM commonswarm_oauth.admin_access_issuances i WHERE i.admin_grant_id=b.admin_grant_id) AS issuances
      FROM swarm.admin_accounts a JOIN commonswarm_oauth.admin_grant_bindings b USING(owner_user_id)
      WHERE b.admin_grant_id=${admin.grant}::uuid`)[0]);
    const beforeIssuer=await issuerState();
    let replayRefused=false;
    try {await admitAdminProof(pool,capability.proof);} catch(error) {replayRefused=error.code==='invalid_dpop_proof';}
    check('real-dpop-replay-refused',replayRefused);
    // Genuine lifecycle rollback is checked before the race, on the same artifact.
    const unrelated=await workspace(ctx,owner,false);
    holdParent=gate();parentSeen=gate();
    const rollback=issue(true);
    const rollbackReached=await Promise.race([parentSeen.opened.then(()=>true),rollback.then(()=>false)]);
    if(!rollbackReached) fail('issuer_rollback_parent_not_reached');
    const progress=manage(ctx,owner,unrelated.workspaceId,{kind:'create_agent_principal',name:`unrelated-${ctx.tag}`});
    const progressed=await Promise.race([progress,new Promise(resolve=>setTimeout(()=>resolve(null),1500))]);
    check('same-owner-unrelated-workspace-progress',progressed?.status===200 && progressed.body?.status==='accepted');
    holdParent.open();
    check('issuer-lifecycle-rollback',(await rollback).cause?.code==='V17_ROLLBACK');
    await progress;holdParent=null;parentSeen=null;
    check('rollback-no-worker-or-approval-change',await state()===before);
    check('rollback-restores-issuer-account-events-audit-ledger',await issuerState()===beforeIssuer);
    const [unconsumed]=await observer`SELECT consumed_at FROM commonswarm_oauth.provider_artifacts WHERE model='AuthorizationCode' AND artifact_id_hash=${hash}`;
    check('rollback-restores-provider-artifact',unconsumed?.consumed_at===null);
    failures.codes.length=0;failures.deadlocks.length=0;failures.recording=true;
    let allowing,issuing,allowPid=null;
    out.stage='allow-issuer-race';
    if(scenario.endsWith('issuer-first')) {
      holdParent=gate();parentSeen=gate();
      issuing=issue();
      const reached=await Promise.race([parentSeen.opened.then(()=>true),issuing.then(()=>false)]);
      if(!reached) fail('issuer_parent_not_reached');
      allowing=allow(connection);
      allowPid=await waitForBlocked(observer,issuerPid,async pid=>ownedWait(observer,pid,{parents:[admin.grant]}),2500);
      check('allow-waits-on-actual-issuer-parent',allowPid!==null);
      holdParent.open();
    } else {
      await observer.begin(async tx=>{
        const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
        allowing=allow(connection);
        allowPid=await waitForBlocked(observer,Number(pid),async()=>true,2500);
        if(allowPid===null) fail('allow_workspace_not_reached');
        issuing=issue();
        const waiting=await waitForBlocked(observer,allowPid,async pid=>pid===issuerPid && ownedWait(observer,pid,{parents:[admin.grant]}),2500);
        check('issuer-waits-on-allow-preheld-parent',waiting===issuerPid && issuerPid!==null);
      });
    }
    const [allowed,issuedResult]=await Promise.all([allowing,issuing]);
    failures.recording=false;
    check('retired-allow-refused',allowed.status===200 && allowed.body?.status==='refused' && allowed.body?.reason==='connection_access_refused');
    check('real-issuer-lifecycle-committed',issuedResult.outcome==='committed');
    check('no-cycle-or-retry',failures.codes.length===0);
    check('retired-credential-not-revived',await state()===before);
    out.race_witness={allow_pid:allowPid,issuer_pid:issuerPid,workspace_id:workspaceId,parent_id:admin.grant,
      sqlstates:[...failures.codes],deadlock_edges:[...failures.deadlocks]};
    // Invalid selectors retain the owning permission writer's refusal; no JWT,
    // SQL messages or credentials enter the result. Hosted IDs never name T.
    for(const [name,c] of [['malformed',{...connection,connection_id:'invalid'}],
      ['unknown',{...connection,connection_id:id()}],['wrong-principal',{...connection,principal_id:id()}],
      ['hosted',{...connection,kind:'hosted',connection_id:id()}]]) {
      const r=await allow(c);check(`refusal-${name}`,r.status===200 && r.body?.status==='refused');
    }
    const foreign=await human(ctx,'allow-foreign');
    await member(ctx,workspaceId,foreign,'member');
    const fp=await manage(ctx,foreign,workspaceId,{kind:'create_agent_principal',name:`foreign-${ctx.tag}`});
    const foreignDevice=id();
    await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${foreignDevice}::uuid,${foreign.userId}::uuid,'Allow fixture')`;
    const fm=await manage(ctx,foreign,workspaceId,{kind:'mint_agent_token',principal_id:fp.body?.principal_id,
      device_id:foreignDevice,run_id:id(),task_id:id(),epoch:1,scopes:['post_signal']});
    if(fm.status!==200 || !fm.body?.token_id) fail('allow_foreign_fixture');
    let foreignAttempt;
    await observer.begin(async tx=>{
      await tx`SELECT user_id FROM swarm.users WHERE user_id=${foreign.userId}::uuid FOR UPDATE`;
      foreignAttempt=allow({...connection,connection_id:fm.body.token_id});
      const refused=await Promise.race([foreignAttempt,new Promise(resolve=>setTimeout(()=>resolve(null),1500))]);
      check('foreign-token-no-foreign-owner-lock',refused?.status===200 && refused.body?.reason==='connection_access_refused');
    });
    await foreignAttempt;
    const otherPrincipal=await manage(ctx,owner,unrelated.workspaceId,{kind:'create_agent_principal',name:`other-${ctx.tag}`});
    const otherDevice=id();await observer`INSERT INTO swarm.devices(device_id,user_id,label)
      VALUES(${otherDevice}::uuid,${owner.userId}::uuid,'Other workspace fixture')`;
    const otherToken=await manage(ctx,owner,unrelated.workspaceId,{kind:'mint_agent_token',principal_id:otherPrincipal.body?.principal_id,
      device_id:otherDevice,run_id:id(),task_id:id(),epoch:1,scopes:['post_signal']});
    if(otherToken.status!==200 || !otherToken.body?.token_id) fail('allow_other_workspace_fixture');
    const wrongWorkspace=await allow({...connection,connection_id:otherToken.body.token_id});
    check('wrong-workspace-normal-refusal',wrongWorkspace.status===200 && wrongWorkspace.body?.reason==='connection_access_refused');
    check('all-denials-no-revival',await state()===before);
    return {checks};
  } finally {
    holdParent?.open();failures.recording=false;
    await Promise.all([...clients].map(c=>c.end().catch(()=>{})));
    await Promise.all(closed.map(p=>p.catch(()=>{})));
  }
}

async function localResumeScenario(ctx,scenario) {
  const {observer,failures}=ctx,checks=[];
  const check=(name,ok)=>checks.push({name,ok:ok===true});
  const owner=await human(ctx,'resume-owner'),manager=await human(ctx,'resume-manager');
  const {workspaceId}=await workspace(ctx,owner,false);
  await member(ctx,workspaceId,manager,'admin');
  const read=await ctx.load('supabase/functions/read/index.ts','read');
  const use=async raw=>{
    const response=await read.handleRequest(new Request('http://127.0.0.1/functions/v1/read',{
      method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},
      body:JSON.stringify({resource:'renewal_grants',workspace_id:workspaceId})}));
    return response.status;
  };
  const resume=s=>manage(ctx,manager,workspaceId,{kind:'resume_renewal_grant',renewal_grant_id:s.grant});
  const state=async s=>JSON.stringify((await observer`SELECT resumed_at,resumed_by,resume_count
    FROM swarm.renewal_grants WHERE renewal_grant_id=${s.grant}::uuid`)[0]);
  const pause=async s=>observer`UPDATE swarm.renewal_grants SET suspended_at=clock_timestamp()
    WHERE renewal_grant_id=${s.grant}::uuid`;
  const mint=async(label,admin=null,principal=null)=>{
    if (!principal) {
      const created=await manage(ctx,owner,workspaceId,{kind:'create_agent_principal',name:`resume-${label}-${ctx.tag}`});
      if(created.status!==200 || !created.body.principal_id) fail('resume_human_principal_control');
      principal=created.body.principal_id;
    }
    let token,raw;
    if(admin) {
      const issued=await admin.invoke({kind:'admin_provision_seat',grant_id:admin.grant,workspace_id:workspaceId,
        principal_id:principal,recipient_connection_id:admin.connection,worker_scope_names:['post_signal'],
        bearer_seconds:120,horizon_seconds:600,max_successors:2},{worker:true});
      if(issued.result.status!==200 || issued.calls!==1 || !issued.delivery) fail('resume_legal_delegated_mint');
      token=issued.delivery.credential_id;raw=issued.delivery.credential;
    } else {
      const device=id();await observer`INSERT INTO swarm.devices(device_id,user_id,label)
        VALUES(${device}::uuid,${owner.userId}::uuid,'resume fixture')`;
      const issued=await manage(ctx,owner,workspaceId,{kind:'mint_agent_token',principal_id:principal,
        run_id:id(),task_id:id(),epoch:1,device_id:device,scopes:['post_signal']});
      if(issued.status!==200 || !issued.body.agent_token) fail('resume_ordinary_mint');
      token=issued.body.token_id;raw=issued.body.agent_token;
    }
    const [binding]=await observer`SELECT t.renewal_grant_id AS grant,p.parent_admin_grant_id AS principal_parent,
      t.parent_admin_grant_id AS token_parent FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
      WHERE t.token_id=${token}::uuid`;
    check(`legal-null-principal-parent-${label}`,binding.principal_parent===null && binding.token_parent===(admin?.grant ?? null));
    return {principal,token,raw,grant:binding.grant};
  };
  const renewed=async s=>{
    const response=await ctx.command.handleRequest(new Request('http://127.0.0.1/functions/v1/command',{
      method:'POST',headers:{authorization:`Bearer ${s.raw}`,'content-type':'application/json'},
      body:JSON.stringify({command_id:id(),client_version:ctx.clientVersion,workspace_id:workspaceId,
        stream:{kind:'workspace'},command:{kind:'renew_agent_token'}})}));
    const body=await response.json();
    if(response.status!==200 || !body.agent_token) fail('resume_successor_control');
    return {...s,token:body.token_id,raw:body.agent_token};
  };
  if(scenario==='local-resume-parent-order') {
    const admin=await adminSide(ctx,{owner,workspaceId},'resume-admin');
    const seat=await mint('delegated',admin);
    check('same-invocation-positive',await use(seat.raw)===200);
    await pause(seat);
    await admin.arm();
    let pending,creating,humanPid;
    failures.codes.length=0;failures.recording=true;
    await observer.begin(async tx=>{
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      // SHARE parks human W UPDATE but does not take A. Start the human first:
      // baseline gets W ahead of admin then requests its A; fixed preholds A.
      await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
      pending=resume(seat);
      humanPid=await waitForBlocked(observer,Number(pid),async()=>true,3500);
      check('human-resume-witnessed-wait-on-workspace',humanPid!==null);
      if(humanPid===null) fail('resume_workspace_not_parked');
      creating=settleSide(admin.start());
      const adminPid=await waitForBlocked(observer,humanPid,async()=>true,3500);
      check('delegated-create-waits-on-human-preheld-parent',adminPid!==null);
      if(adminPid!==null) {
        const [witness]=await observer`SELECT query ILIKE '%swarm.admin_grants%' AS parent_wait
          FROM pg_stat_activity WHERE pid=${adminPid}::int`;
        check('actual-admin-A-wait-witness',witness?.parent_wait===true);
      }
    });
    const resumed=await pending,created=await creating;
    failures.recording=false;
    check('both-real-cross-owner-commands-complete',resumed.status===200 && created.ok);
    check('no-deadlock-or-retry-masking',failures.codes.length===0);
    check('exact-resume-and-admin-write',(await observer`SELECT resume_count=1 AND resumed_by=${manager.userId}::uuid
      AND NOT suspension_active AS ok FROM swarm.renewal_grants WHERE renewal_grant_id=${seat.grant}::uuid`)[0]?.ok===true
      && await principalLive(ctx,workspaceId,admin.name));
    check('delegated-create-audit-committed',JSON.stringify(await admin.audit())===JSON.stringify(['committed']));
    // Cross a precommitted deadline while SQL itself waits on A. A command-only
    // regression would miss the SQL clock bug after command planning is fixed.
    await pause(seat);
    await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '4 seconds'
      WHERE renewal_grant_id=${seat.grant}::uuid`;
    const before=await state(seat);let sqlResume;
    await observer.begin(async tx=>{
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT grant_id FROM swarm.admin_grants WHERE grant_id=${admin.grant}::uuid FOR UPDATE`;
      sqlResume=observer.begin(async call=>{
        await call`SET LOCAL ROLE swarm_command`;
        return (await call`SELECT swarm.resume_renewal_grant(${workspaceId}::uuid,${seat.grant}::uuid,${manager.userId}::uuid) AS refusal`)[0];
      });
      check('SQL-resume-witnessed-parent-wait',await waitForBlocked(observer,Number(pid),async()=>true,3500)!==null);
      check('deadline-still-future-at-observed-wait',(await observer`SELECT connection_expires_at>clock_timestamp() AS ok
        FROM swarm.renewal_grants WHERE renewal_grant_id=${seat.grant}::uuid`)[0]?.ok===true);
      await tx`SELECT pg_sleep(greatest(0,extract(epoch FROM (connection_expires_at-clock_timestamp())))+0.05)
        FROM swarm.renewal_grants WHERE renewal_grant_id=${seat.grant}::uuid`;
    });
    const denied=await sqlResume;
    check('deadline-crossing-denied-with-no-resume',denied.refusal==='renewal_grant_revoked' && await state(seat)===before);
    // Independent parent controls each retain a fresh same-invocation positive.
    for(const policy of ['revoked','narrowed']) {
      const side=await adminSide(ctx,{owner,workspaceId},`resume-${policy}`);
      const s=await mint(policy,side);check(`live-before-${policy}`,await use(s.raw)===200);await pause(s);
      const before=await state(s);
      if(policy==='revoked') await observer`UPDATE swarm.admin_grants SET state='revoked',revoked_at=clock_timestamp()
        WHERE grant_id=${side.grant}::uuid`;
      else await observer`UPDATE swarm.admin_grants SET worker_scope_ceiling=ARRAY[]::text[] WHERE grant_id=${side.grant}::uuid`;
      const result=await resume(s);
      check(`current-${policy}-parent-denies-without-resume`,result.status===403 && await state(s)===before);
    }
  } else {
    const positive=await mint('positive');await use(positive.raw);await pause(positive);
    check('same-invocation-positive',(await resume(positive)).status===200);
    // Installed SQL under the production role owns the refusal-code contract.
    // Each terminal family was legally minted and genuinely used before closure.
    for(const mode of ['revoked-cascade','elapsed','terminal-marker','grant-tombstone']) {
      const closed=await mint(mode);
      if(await use(closed.raw)!==200) fail('terminal_actual_first_use');
      await pause(closed);
      if(mode==='revoked-cascade') await observer`UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp()
        WHERE renewal_grant_id=${closed.grant}::uuid`;
      if(mode==='elapsed') await observer`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
        WHERE renewal_grant_id=${closed.grant}::uuid`;
      if(mode==='terminal-marker') await observer`UPDATE swarm.renewal_grants SET connection_expired_at=clock_timestamp()
        WHERE renewal_grant_id=${closed.grant}::uuid`;
      if(mode==='grant-tombstone') await observer`INSERT INTO swarm.revocation_tombstones(kind,target_id)
        VALUES('renewal_grant',${closed.grant}::uuid)`;
      if(mode==='revoked-cascade') check('real-grant-cascade-ended-used-token',
        (await observer`SELECT revoked_at IS NOT NULL AS ended FROM swarm.agent_tokens WHERE token_id=${closed.token}::uuid`)[0].ended);
      const before=await state(closed);
      const [result]=await observer.begin(async tx=>{
        await tx`SET LOCAL ROLE swarm_command`;
        return tx`SELECT swarm.resume_renewal_grant(${workspaceId}::uuid,${closed.grant}::uuid,${manager.userId}::uuid) AS reason`;
      });
      check(`${mode}-exact-terminal-refusal`,result.reason==='renewal_grant_revoked' && await state(closed)===before);
    }
    for(const mode of ['expired-unused','expired-used','pending','retired-history']) {
      const root=await mint(mode);let current=root;
      if(mode!=='expired-unused') {
        if(await use(current.raw)!==200) fail('resume_first_use_control');
        if(mode==='pending' || mode==='retired-history') current=await renewed(current);
        if(mode==='retired-history') {
          if(await use(current.raw)!==200) fail('resume_middle_use_control');
          current=await renewed(current);
          if(await use(current.raw)!==200) fail('resume_current_use_control');
        }
      }
      await observer`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second'
        WHERE renewal_grant_id=${root.grant}::uuid`;
      await pause(current);const before=await state(current);
      let result;
      if(mode==='retired-history') {
        // An unrelated family on the SAME principal must not join the plan.
        const sibling=await mint('sibling',null,root.principal);let pending,whileHeld;
        await observer.begin(async tx=>{
          const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
          await tx`SELECT token_id FROM swarm.agent_tokens WHERE token_id=ANY(${[root.token,sibling.token]}::uuid[]) FOR UPDATE`;
          pending=resume(current);
          whileHeld=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve(null),2500))]);
          const [{n}]=await observer`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`;
          check('retired-history-and-sibling-tokens-not-locked',whileHeld?.status===200 && n===0);
        });
        result=await pending;
      } else result=await resume(current);
      check(`${mode}-eligibility-and-effect`,mode==='expired-unused'
        ? result.status===403 && await state(current)===before
        : result.status===200 && (await observer`SELECT resume_count=1 AND NOT suspension_active AS ok
            FROM swarm.renewal_grants WHERE renewal_grant_id=${current.grant}::uuid`)[0]?.ok===true);
    }
    // Unauthorized family selectors must finish while a victim is locked.
    const foreign=await human(ctx,'resume-outsider');await member(ctx,workspaceId,foreign,'member');
    const victim=await mint('victim');await pause(victim);let pending,whileHeld;
    await observer.begin(async tx=>{
      await tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id=${victim.grant}::uuid FOR UPDATE`;
      pending=manage(ctx,foreign,workspaceId,{kind:'resume_renewal_grant',renewal_grant_id:victim.grant});
      whileHeld=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve(null),2500))]);
      check('foreign-owner-refused-before-family-lock',whileHeld?.status===403);
    });
    await pending;
  }
  return {checks};
}

if (typeof Deno !== 'undefined' && import.meta.main) await denoMain();


function deadlockEdges(error) {
  if(sqlstate(error)!=='40P01' || typeof error.detail!=='string') return [];
  return [...error.detail.matchAll(/Process (\d+) waits for [^;]+; blocked by process (\d+)\./g)]
    .map(match=>[Number(match[1]),Number(match[2])]);
}
// Match a tuple wait to run-owned UUIDs; a transaction wait is sufficient only
// for a gate whose sole row lock is the named row (never for a multi-row actor).
async function ownedWait(sql, pid, targets, singleRowGate = null) {
  const rows=await sql`SELECT tableoid::oid AS rel,ctid::text AS tid FROM swarm.users WHERE user_id=ANY(${targets.users ?? []}::uuid[])
    UNION ALL SELECT tableoid::oid,ctid::text FROM swarm.admin_grants WHERE grant_id=ANY(${targets.parents ?? []}::uuid[])
    UNION ALL SELECT tableoid::oid,ctid::text FROM swarm.workspaces WHERE workspace_id=ANY(${targets.workspaces ?? []}::uuid[])
    UNION ALL SELECT tableoid::oid,ctid::text FROM swarm.streams WHERE stream_id=ANY(${targets.streams ?? []}::uuid[])
    UNION ALL SELECT tableoid::oid,ctid::text FROM swarm.hosted_mcp_grants WHERE grant_id=ANY(${targets.grants ?? []}::uuid[])
    UNION ALL SELECT tableoid::oid,ctid::text FROM swarm.agent_tokens WHERE token_id=ANY(${targets.tokens ?? []}::uuid[])`;
  const locks=await sql`SELECT relation::oid AS rel,page,tuple FROM pg_locks WHERE pid=${pid}::int AND locktype='tuple'`;
  if(rows.some(row=>locks.some(lock=>Number(lock.rel)===Number(row.rel) && row.tid===`(${lock.page},${lock.tuple})`))) return true;
  if(singleRowGate===null || rows.length!==1) return false;
  return (await sql`SELECT EXISTS(SELECT 1 FROM pg_locks waiting JOIN pg_locks holder
    ON holder.locktype='transactionid' AND holder.transactionid=waiting.transactionid
    WHERE waiting.pid=${pid}::int AND waiting.locktype='transactionid' AND NOT waiting.granted
      AND holder.pid=${singleRowGate}::int AND holder.granted) AS ok`)[0]?.ok===true;
}

// These scenarios own the two V15 defects at real command/loader boundaries.
// Setup, queue timeouts and parser failures are inconclusive, never a red witness.
async function hostedOwnerRemovalScenario(ctx) {
  const {observer,failures}=ctx,checks=[];
  const check=(name,ok)=>checks.push({name,ok:ok===true});
  const {authenticateHostedGrantCapability}=await ctx.load('supabase/functions/_shared/hosted-seat-auth.ts');
  const fixture=async (label,options={})=>{
    const admin=await human(ctx,`prefix-admin-${label}`),owner=options.owner ?? await human(ctx,`prefix-owner-${label}`);
    const w=options.workspace ?? await workspace(ctx,options.ownedWorkspace?owner:admin,false);
    if(!options.workspace && !options.ownedWorkspace) await member(ctx,w.workspaceId,owner,'member');
    const selected=options.selected ?? [w.workspaceId];
    const grantId=id(),providerGrantId=`provider-${grantId}`,digest='07'.repeat(32);
    for(const command of [
      {kind:'begin_hosted_mcp_grant',grant_id:grantId,provider_grant_id:providerGrantId,owner_user_id:owner.userId,
        home_workspace_id:w.workspaceId,client_id:`prefix-${ctx.tag}`,resource:'https://mcp.commonswarm.com/mcp',
        selected_workspace_ids:selected,manifest_digest:digest,interaction_ref:`interaction-${grantId}`},
      ...selected.filter(workspace_id=>!options.pending || workspace_id!==w.workspaceId).map(workspace_id=>({kind:'consent_hosted_mcp_workspace',grant_id:grantId,workspace_id,owner_user_id:owner.userId,
        manifest_digest:digest,consent_receipt_id:id()})),
      ...options.pending ? [] : [{kind:'activate_hosted_mcp_grant',grant_id:grantId}],
    ]) {const result=await manage(ctx,owner,command.kind==='consent_hosted_mcp_workspace'?command.workspace_id:w.workspaceId,command);if(result.status!==200) fail('prefix_genuine_grant_setup');}
    const provider={active:true};
    const capability=await ctx.db.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      return await authenticateHostedGrantCapability(tx,{grantId,ownerUserId:owner.userId,providerGrantId,
        workspaceId:w.workspaceId,tool:'claim_hosted_seat',providerStatus:async()=>provider});
    });
    if(!capability && !options.pending) fail('prefix_capability_setup');
    const body={command_id:id(),client_version:ctx.clientVersion,workspace_id:w.workspaceId,
      stream:{kind:'workspace'},command:{kind:'claim_hosted_seat',name:`prefix-${label}-${ctx.tag}`}};
    const claim=()=>ctx.command.handleHostedCommand(body,capability);
    const remove=async()=>{
      const [clock]=await observer`SELECT extract(epoch FROM clock_timestamp())::float8 AS seconds`;
      return await manage(ctx,{...admin,identity:{...admin.identity,interactiveAuthAtSeconds:Number(clock.seconds)}},
        w.workspaceId,{kind:'remove_member',user_id:owner.userId});
    };
    return {...w,owner,admin,grantId,providerGrantId,provider,capability,body,claim,remove,digest};
  };
  const sequential=await fixture('sequential');
  const admitted=await sequential.claim();check('same-invocation-positive',admitted.status===200);
  check('sequential-remove',(await sequential.remove()).status===200);
  check('removed-owner-replay-denied',(await sequential.claim()).status===403);
  check('removed-owner-fresh-name-denied',(await ctx.command.handleHostedCommand({...sequential.body,command_id:id(),
    command:{kind:'claim_hosted_seat',name:`denied-${ctx.tag}`}},sequential.capability)).status===403);
  const freshCapability=await ctx.db.begin(async tx=>{
    await tx`SET LOCAL ROLE swarm_command`;
    return await authenticateHostedGrantCapability(tx,{grantId:sequential.grantId,ownerUserId:sequential.owner.userId,
      providerGrantId:sequential.providerGrantId,workspaceId:sequential.workspaceId,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})});
  });
  check('removed-owner-new-capability-denied',freshCapability===null);
  const rollback=await fixture('rollback');
  const originalBegin=ctx.db.begin,marker={};
  ctx.db.begin=function(...args) {
    const operation=args.pop();
    return originalBegin.apply(this,[...args,async tx=>{await operation(tx);throw marker;}]);
  };
  try {await rollback.remove().catch(()=>{});} finally {ctx.db.begin=originalBegin;}
  check('removal-rollback-retains-member',(await observer`SELECT revoked_at IS NULL AS ok FROM swarm.memberships
    WHERE workspace_id=${rollback.workspaceId}::uuid AND user_id=${rollback.owner.userId}::uuid`)[0]?.ok===true);
  check('removal-rollback-retains-claim-authority',(await rollback.claim()).status===200);
  const revoked=await fixture('provider-revoked');let pending;
  await observer.begin(async gate=>{
    const [{pid}]=await gate`SELECT pg_backend_pid() AS pid`;
    await gate`SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=${revoked.grantId}::uuid FOR SHARE`;
    pending=revoked.claim();
    if(await waitForBlocked(observer,Number(pid),async()=>true,3500)===null) fail('provider_revoke_queue_inconclusive');
    revoked.provider.active=false;
  });
  check('provider-revoked-after-wait-denied',(await pending).status===403);
  check('provider-revoked-no-seat-or-receipt',(await observer`SELECT
    NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats WHERE grant_id=${revoked.grantId}::uuid)
    AND NOT EXISTS(SELECT 1 FROM swarm.idempotency_keys WHERE principal_kind='hosted_grant'
      AND principal_id=${revoked.grantId} AND command_id=${revoked.body.command_id}) AS ok`)[0]?.ok===true);
  for(const kind of ['management','admin']) {
    const f=await fixture(`alone-${kind}`,{ownedWorkspace:kind==='admin'}),claimed=await f.claim();
    if(claimed.status!==200) fail('alone_claim_setup');
    const [seat]=await observer`SELECT principal_id FROM swarm.hosted_mcp_seats WHERE seat_id=${claimed.body.seat_id}::uuid`;
    let result;
    if(kind==='admin') {
      const side=await adminSide(ctx,{owner:f.owner,workspaceId:f.workspaceId},'alone-admin');
      result=(await side.invoke({kind:'admin_revoke_seat',grant_id:side.grant,workspace_id:f.workspaceId,
        principal_id:seat.principal_id,reason_code:'owner_requested'})).result;
    } else result=await manage(ctx,f.owner,f.workspaceId,{kind:'revoke_hosted_mcp_seat',grant_id:f.grantId,seat_id:claimed.body.seat_id});
    check(`${kind}-alone-commits`,result.status===200);
    check(`${kind}-alone-terminal-denial`,(await f.claim()).status===403);
  }
  // Both real authority entrypoints, both orders. Each fixture owns all UUIDs.
  for(const order of ['claim-first','remove-first','management-first','management-remove-first','management-admin-first','admin-first']) {
    const isAdmin=order==='management-admin-first' || order==='admin-first';
    const isManagement=order.startsWith('management') || order==='admin-first';
    const reverse=order==='remove-first' || order==='management-remove-first' || order==='admin-first';
    const f=await fixture(order,{ownedWorkspace:isAdmin});let first,second;
    const prior=isManagement ? await f.claim() : null;
    if(prior && prior.status!==200) fail('prefix_management_positive');
    const seat=prior ? (await observer`SELECT principal_id FROM swarm.hosted_mcp_seats WHERE seat_id=${prior.body.seat_id}::uuid`)[0] : null;
    const side=isAdmin ? await adminSide(ctx,{owner:f.owner,workspaceId:f.workspaceId},`prefix-${order}`) : null;
    const adminCommand=side ? {kind:'admin_revoke_seat',grant_id:side.grant,workspace_id:f.workspaceId,
      principal_id:seat.principal_id,reason_code:'owner_requested'} : null;
    const managementId=id();
    const management=()=>ctx.command.handleHostedManagementCommand({command_id:managementId,client_version:ctx.clientVersion,
      workspace_id:f.workspaceId,stream:{kind:'workspace'},
      command:{kind:'revoke_hosted_mcp_seat',grant_id:f.grantId,seat_id:prior.body.seat_id}},f.owner.identity);
    const other=side ? async()=>{const r=await side.invoke(adminCommand);return {...r.result,commandId:r.commandId};} : f.remove;
    // Rollback at the existing transaction boundary, then prove actual authority remains.
    if(isManagement) {
      const state=async()=>JSON.stringify({
        seats:await observer`SELECT hs.revoked_at,p.revoked_at AS principal_revoked_at,h.revoked_at AS handle_revoked_at
          FROM swarm.hosted_mcp_seats hs JOIN swarm.agent_principals p USING(principal_id)
          JOIN swarm.hosted_mcp_seat_handles h USING(seat_id) WHERE hs.seat_id=${prior.body.seat_id}::uuid ORDER BY h.handle`,
        consent:await observer`SELECT revoked_at FROM swarm.hosted_mcp_grant_workspaces
          WHERE grant_id=${f.grantId}::uuid AND workspace_id=${f.workspaceId}::uuid`,
        receipts:await observer`SELECT command_id FROM swarm.idempotency_keys WHERE workspace_id=${f.workspaceId}::uuid ORDER BY command_id`,
        audit:await observer`SELECT command_kind,outcome FROM swarm.audit_log WHERE workspace_id=${f.workspaceId}::uuid ORDER BY command_kind,outcome`,
        adminAudit:side ? await observer`SELECT request_id,outcome FROM commonswarm_oauth.admin_oauth_audit
          WHERE admin_grant_id=${side.grant}::uuid ORDER BY request_id,outcome` : [],
        tombstone:await observer`SELECT kind,target_id FROM swarm.revocation_tombstones
          WHERE target_id=ANY(${[prior.body.seat_id,seat.principal_id]}::uuid[]) ORDER BY kind,target_id`,
      });
      const before=await state();
      const begin=ctx.db.begin,marker={};let reached=false;
      ctx.db.begin=function(...args){const op=args.pop();return begin.apply(this,[...args,async tx=>{const r=await op(tx);reached ||= r?.status===200 || r?.result?.status===200;throw marker;}]);};
      try {await (isAdmin?other:management)().catch(()=>{});} finally {ctx.db.begin=begin;}
      check(`${order}-rollback-reached`,reached);
      check(`${order}-rollback-restores-seat-consent-ledgers`,before===await state());
      if(side) check(`${order}-rollback-admin-authority`,(await side.invoke({kind:'admin_read_metadata',grant_id:side.grant})).result.status===200);
      check(`${order}-rollback-usable-authority`,(await f.claim()).status===200);
    }
    failures.codes.length=0;failures.recording=true;
    await observer.begin(async gate=>{
      const [{pid}]=await gate`SELECT pg_backend_pid() AS pid`;
      await gate`SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=${f.grantId}::uuid FOR SHARE`;
      first=(reverse?other():isManagement?management():f.claim()).catch(error=>({thrown:sqlstate(error)}));
      const firstPid=await waitForBlocked(observer,Number(pid),p=>ownedWait(observer,p,{grants:[f.grantId]},Number(pid)),3500);
      if(firstPid===null) fail('prefix_first_owned_G_queue_inconclusive');
      second=(reverse?isManagement?management():f.claim():other()).catch(error=>({thrown:sqlstate(error)}));
      const secondPid=await waitForBlocked(observer,firstPid,p=>ownedWait(observer,p,
        {users:[f.owner.userId],workspaces:[f.workspaceId],streams:[f.streamId]}),3500);
      if(secondPid===null) fail('prefix_second_owned_U_W_S_queue_inconclusive');
      check(`${order}-owned-row-blocker-graph`,true);
    });
    const results=await Promise.all([first,second]);failures.recording=false;
    check(`${order}-no-sqlstate`,failures.codes.length===0 && results.every(r=>!r.thrown));
    check(`${order}-authority-entrypoint-committed`,results[reverse?0:1].status===200);
    if(isManagement) check(`${order}-management-committed`,results[reverse?1:0].status===200);
    if(isAdmin) {
      const adminResult=results[reverse?0:1];
      check(`${order}-admin-audit`,(await observer`SELECT outcome FROM commonswarm_oauth.admin_oauth_audit
        WHERE admin_grant_id=${side.grant}::uuid AND request_id=${adminResult.commandId}`).some(r=>r.outcome==='committed'));
    }
    if(isManagement) {
      check(`${order}-management-receipt-and-audit`,(await observer`SELECT EXISTS(
        SELECT 1 FROM swarm.idempotency_keys WHERE principal_id=${f.owner.userId} AND command_id=${managementId})
        AND EXISTS(SELECT 1 FROM swarm.audit_log WHERE workspace_id=${f.workspaceId}::uuid
          AND actor_user=${f.owner.userId}::uuid AND command_kind='revoke_hosted_mcp_seat' AND outcome IN ('accepted','replayed')) AS ok`)[0]?.ok===true);
      check(`${order}-consent-revoked-by-authority-entrypoint`,(await observer`SELECT revoked_at IS NOT NULL AS ok FROM swarm.hosted_mcp_grant_workspaces
        WHERE grant_id=${f.grantId}::uuid AND workspace_id=${f.workspaceId}::uuid`)[0]?.ok===true);
    }
    if(prior) check(`${order}-seat-handle-principal-closed`,(await observer`SELECT hs.revoked_at IS NOT NULL
      AND p.revoked_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seat_handles h WHERE h.seat_id=hs.seat_id AND h.revoked_at IS NULL) AS ok
      FROM swarm.hosted_mcp_seats hs JOIN swarm.agent_principals p USING(principal_id) WHERE hs.seat_id=${prior.body.seat_id}::uuid`)[0]?.ok===true);
    check(`${order}-terminal-claim-denial`,(await f.claim()).status===403);
  }
  // Same owner, two selected workspaces; G2 uses W2 while G1's one-W action waits.
  for(const pendingGrant of [false,true]) {
    const owner=await human(ctx,`same-owner-${pendingGrant}`),admin=await human(ctx,`same-admin-${pendingGrant}`);
    const w1=await workspace(ctx,admin,false),w2=await workspace(ctx,admin,false);
    await member(ctx,w1.workspaceId,owner,'member');await member(ctx,w2.workspaceId,owner,'member');
    const g1=await fixture(`W1-${pendingGrant}`,{owner,workspace:w1,selected:[w1.workspaceId,w2.workspaceId],pending:pendingGrant});
    const g2=await fixture(`W2-${pendingGrant}`,{owner,workspace:w2});
    const seat=pendingGrant?null:await g1.claim();let action,progress;
    await observer.begin(async gate=>{
      const [{pid}]=await gate`SELECT pg_backend_pid() AS pid`;
      await gate`SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=${g1.grantId}::uuid FOR SHARE`;
      action=manage(ctx,owner,w1.workspaceId,pendingGrant
        ? {kind:'consent_hosted_mcp_workspace',grant_id:g1.grantId,workspace_id:w1.workspaceId,owner_user_id:owner.userId,manifest_digest:g1.digest,consent_receipt_id:id()}
        : {kind:'revoke_hosted_mcp_seat',grant_id:g1.grantId,seat_id:seat.body.seat_id});
      if(await waitForBlocked(observer,Number(pid),p=>ownedWait(observer,p,{grants:[g1.grantId]},Number(pid)),3500)===null) fail('same_owner_G1_queue_inconclusive');
      progress=g2.claim();const result=await Promise.race([progress,new Promise(resolve=>setTimeout(()=>resolve(null),1500))]);
      check(`same-owner-W2-${pendingGrant}-commits-before-release`,result?.status===200);
      check(`same-owner-W2-${pendingGrant}-seat-principal-receipt`,(await observer`SELECT EXISTS(
        SELECT 1 FROM swarm.hosted_mcp_seats hs JOIN swarm.agent_principals p USING(principal_id)
        WHERE hs.grant_id=${g2.grantId}::uuid AND p.revoked_at IS NULL) AND EXISTS(
        SELECT 1 FROM swarm.idempotency_keys WHERE principal_id=${g2.grantId} AND command_id=${g2.body.command_id}) AS ok`)[0]?.ok===true);
    });
    check(`same-owner-W1-${pendingGrant}-commits`,(await action).status===200);await progress;
  }
  return {checks};
}

async function floorFirstUseScenario(ctx) {
  const {observer}=ctx,checks=[];
  const check=(name,ok)=>checks.push({name,ok:ok===true});
  if(typeof ctx.floorUrl!=='string') fail('floor_module_missing');
  const floor=await import(ctx.floorUrl);
  const read=await ctx.load('supabase/functions/read/index.ts','read');
  const owner=await human(ctx,'floor-owner');const {workspaceId}=await workspace(ctx,owner,false);
  const request=async(raw,command)=>{
    const response=await ctx.command.handleRequest(new Request('http://127.0.0.1/functions/v1/command',{
      method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},
      body:JSON.stringify({command_id:id(),client_version:ctx.clientVersion,workspace_id:workspaceId,stream:{kind:'workspace'},command})}));
    return {status:response.status,body:await response.json()};
  };
  const use=async raw=>(await read.handleRequest(new Request('http://127.0.0.1/functions/v1/read',{
    method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},
    body:JSON.stringify({resource:'renewal_grants',workspace_id:workspaceId})}))).status;
  const chain=async label=>{
    const created=await manage(ctx,owner,workspaceId,{kind:'create_agent_principal',name:`floor-${label}-${ctx.tag}`});
    if(created.status!==200) fail('floor_principal_setup');
    const device=id();await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${owner.userId}::uuid,'floor fixture')`;
    const t=await manage(ctx,owner,workspaceId,{kind:'mint_agent_token',principal_id:created.body.principal_id,
      run_id:id(),task_id:id(),epoch:1,device_id:device,scopes:['post_signal']});
    if(t.status!==200 || await use(t.body.agent_token)!==200) fail('floor_T_use');
    const c=await request(t.body.agent_token,{kind:'renew_agent_token'});
    if(c.status!==200 || await use(c.body.agent_token)!==200) fail('floor_C_use');
    const x=await request(c.body.agent_token,{kind:'renew_agent_token'});
    if(x.status!==200) fail('floor_X_issue');
    const rows=await observer`SELECT token_id,predecessor_token_id,renewal_grant_id,lineage_id,first_used_at,token_hash
      FROM swarm.agent_tokens WHERE token_id=ANY(${[t.body.token_id,c.body.token_id,x.body.token_id]}::uuid[])`;
    const T=rows.find(r=>r.token_id===t.body.token_id),C=rows.find(r=>r.token_id===c.body.token_id),X=rows.find(r=>r.token_id===x.body.token_id);
    if(!T?.first_used_at || !C?.first_used_at || X?.first_used_at!==null || C.predecessor_token_id!==T.token_id ||
      X.predecessor_token_id!==C.token_id || rows.some(r=>r.renewal_grant_id!==T.renewal_grant_id || r.lineage_id!==T.lineage_id)) fail('floor_real_chain_binding');
    return {T,C,X,raw:x.body.agent_token};
  };
  const invoke=async(s,rollback=false)=>{
    const marker={};
    try {return await observer.begin('isolation level read committed',async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`SELECT set_config('search_path','swarm, pg_catalog',true),set_config('lock_timeout','5s',true),set_config('statement_timeout','10s',true)`;
      const row=await floor.loadAgentCredential(tx,s.X.token_hash);
      const valid=row!==null && !await floor.agentCredentialRevoked(tx,row,null);
      if(rollback) throw marker;
      return valid;
    });} catch(error) {if(error===marker) return true;throw error;}
  };
  const sequential=await chain('sequential');check('same-invocation-positive',await invoke(sequential));
  const rollback=await chain('rollback');await invoke(rollback,true);
  check('floor-first-use-rollback',(await observer`SELECT first_used_at IS NULL AS ok FROM swarm.agent_tokens WHERE token_id=${rollback.X.token_id}::uuid`)[0]?.ok===true);
  const revoke=async s=>{
    const [clock]=await observer`SELECT extract(epoch FROM clock_timestamp())::float8 AS seconds`;
    return await manage(ctx,{...owner,identity:{...owner.identity,interactiveAuthAtSeconds:Number(clock.seconds)}},workspaceId,
      {kind:'revoke_agent_token',token_id:s.T.token_id});
  };
  check('sequential-head-revoke',(await revoke(sequential)).status===200);
  check('committed-head-denies-floor',!await invoke(sequential));
  const head=await chain('head-head');
  ctx.failures.codes.length=0;ctx.failures.recording=true;
  const headResults=await Promise.all([use(head.raw),revoke(head)]);
  ctx.failures.recording=false;
  check('head-head-no-sqlstate',ctx.failures.codes.length===0 && [200,401,403].includes(headResults[0]) && headResults[1].status===200);
  check('head-head-terminal-denial',await use(head.raw)!==200);
  const raced=await chain('race');let old,newer,oldPid,newPid;const states=[],graphs=[];
  ctx.failures.codes.length=0;ctx.failures.deadlocks.length=0;ctx.failures.recording=true;
  let heldC=false;
  await observer.begin(async gate=>{
    const [{pid}]=await gate`SELECT pg_backend_pid() AS pid`;
    await gate`SELECT token_id FROM swarm.agent_tokens WHERE token_id=${raced.X.token_id}::uuid FOR UPDATE`;
    old=invoke(raced).catch(error=>{states.push(sqlstate(error));graphs.push(deadlockEdges(error));return false;});
    oldPid=await waitForBlocked(observer,Number(pid),p=>ownedWait(observer,p,{tokens:[raced.X.token_id]},Number(pid)),3500);
    if(oldPid===null) fail('floor_owned_X_queue_inconclusive');
    newer=revoke(raced).catch(()=>null);
    // Head may queue directly on the gate or behind old's tuple lock. Both
    // require the exact owned X tuple, with the corresponding blocker edge.
    const deadline=Date.now()+3500;
    while(Date.now()<deadline && newPid==null) {
      const rows=await observer`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE pid<>${oldPid} AND (${oldPid}=ANY(pg_blocking_pids(pid)) OR ${Number(pid)}=ANY(pg_blocking_pids(pid)))`;
      if(rows.length===1 && await ownedWait(observer,Number(rows[0].pid),{tokens:[raced.X.token_id]})) newPid=Number(rows[0].pid);
      if(newPid==null) await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(newPid==null) fail('head_owned_X_queue_inconclusive');
    // C belongs only to this new chain. Old is parked before reaching C;
    // head is the only other transaction using it. NOWAIT rolls back its savepoint.
    await observer.begin(async probe=>{
      try {await probe.savepoint(async sp=>{await sp`SELECT token_id FROM swarm.agent_tokens
        WHERE token_id=${raced.C.token_id}::uuid FOR UPDATE NOWAIT`;});}
      catch(error) {if(sqlstate(error)!=='55P03') throw error;heldC=true;}
    });
    if(!heldC) fail('head_owned_C_not_held_inconclusive');
  });
  await Promise.all([old,newer]);ctx.failures.recording=false;
  states.push(...ctx.failures.codes);graphs.push(...ctx.failures.deadlocks);
  const cycle=graphs.some(edges=>edges.some(([a,b])=>a===oldPid && b===newPid) &&
    edges.some(([a,b])=>a===newPid && b===oldPid));
  const incompatible=heldC && cycle && states.length===1 && states[0]==='40P01';
  // Diagnostic only: no historical deadlock can satisfy the required support gate.
  return {checks,floor_compatibility:incompatible?'INCOMPATIBLE':states.length?'INCONCLUSIVE':'UNPROVEN',
    required_compatibility:'BLOCKED',sqlstates:states,legacy_diagnostic:{held_C:heldC,identified_cycle:cycle}};
}


/** Canonical first use uses the selected public read handler. The existing
 * management fixture supplies the human context for revocation; this case
 * claims consumer locking/rollback, never JWT or initial consent admission. */
async function activeFloorCanonicalScenario(ctx,scenario) {
  const {observer}=ctx,checks=[];
  const check=(name,ok)=>checks.push({name,ok:ok===true});
  const read=await ctx.load('supabase/functions/read/index.ts','read');
  const owner=await human(ctx,'active-floor');
  const {workspaceId}=await workspace(ctx,owner,false);
  const use=async raw=>{
    const response=await read.handleRequest(new Request('http://127.0.0.1/functions/v1/read',{
      method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},
      body:JSON.stringify({resource:'renewal_grants',workspace_id:workspaceId})}));
    return response.status;
  };
  const renew=async raw=>{
    const response=await ctx.command.handleRequest(new Request('http://127.0.0.1/functions/v1/command',{
      method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},
      body:JSON.stringify({command_id:id(),client_version:ctx.clientVersion,workspace_id:workspaceId,
        stream:{kind:'workspace'},command:{kind:'renew_agent_token'}})}));
    const body=await response.json();
    if(response.status!==200 || typeof body.agent_token!=='string') fail('active_floor_renew_control');
    return body;
  };
  const chain=async label=>{
    const made=await manage(ctx,owner,workspaceId,{kind:'create_agent_principal',name:`af-${label}-${ctx.tag}`});
    if(made.status!==200) fail('active_floor_principal_control');
    const device=id();
    await observer`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${owner.userId}::uuid,'active floor')`;
    const t=await manage(ctx,owner,workspaceId,{kind:'mint_agent_token',principal_id:made.body.principal_id,
      run_id:id(),task_id:id(),epoch:1,device_id:device,scopes:['post_signal']});
    if(t.status!==200 || await use(t.body.agent_token)!==200) fail('active_floor_root_use');
    const c=await renew(t.body.agent_token);
    if(await use(c.agent_token)!==200) fail('active_floor_successor_use');
    const x=await renew(c.agent_token);
    const rows=await observer`SELECT token_id,predecessor_token_id,first_used_at,renewal_grant_id,lineage_id
      FROM swarm.agent_tokens WHERE token_id=ANY(${[t.body.token_id,c.token_id,x.token_id]}::uuid[])`;
    const T=rows.find(row=>row.token_id===t.body.token_id),C=rows.find(row=>row.token_id===c.token_id),X=rows.find(row=>row.token_id===x.token_id);
    if(rows.length!==3 || !T.first_used_at || !C.first_used_at || X.first_used_at!==null ||
      C.predecessor_token_id!==T.token_id || X.predecessor_token_id!==C.token_id ||
      rows.some(row=>row.renewal_grant_id!==T.renewal_grant_id || row.lineage_id!==T.lineage_id)) fail('active_floor_chain_binding');
    return {T,C,X,raw:x.agent_token};
  };
  const revoke=async fixture=>{
    const [clock]=await observer`SELECT extract(epoch FROM clock_timestamp())::float8 AS seconds`;
    return await manage(ctx,{...owner,identity:{...owner.identity,interactiveAuthAtSeconds:Number(clock.seconds)}},
      workspaceId,{kind:'revoke_agent_token',token_id:fixture.T.token_id});
  };
  const positive=await chain('positive');
  check('same-invocation-positive',await use(positive.raw)===200);
  const sequential=await chain('sequential');
  check('sequential-revoke', (await revoke(sequential)).status===200);
  check('sequential-terminal-denial',[401,403].includes(await use(sequential.raw)));
  check('sequential-no-denied-adoption',(await observer`SELECT first_used_at IS NULL AS ok FROM swarm.agent_tokens WHERE token_id=${sequential.X.token_id}::uuid`)[0].ok);
  const raced=await chain('raced');
  const firstUseFirst=scenario.endsWith('use-first');
  const states=[];
  const settle=promise=>promise.catch(error=>{states.push(sqlstate(error));return null;});
  let first,second,firstPid,secondPid,gatePid;
  await observer.begin(async gate=>{
    gatePid=Number((await gate`SELECT pg_backend_pid() AS pid`)[0].pid);
    await gate`SELECT token_id FROM swarm.agent_tokens WHERE token_id=${raced.X.token_id}::uuid FOR UPDATE`;
    first=settle(firstUseFirst ? use(raced.raw) : revoke(raced));
    firstPid=await waitForBlocked(observer,gatePid,pid=>ownedWait(observer,pid,{tokens:[raced.X.token_id]},gatePid));
    if(firstPid===null) fail('active_floor_first_owned_queue_inconclusive');
    second=settle(firstUseFirst ? revoke(raced) : use(raced.raw));
    const deadline=Date.now()+3500;
    while(Date.now()<deadline && secondPid==null) {
      const rows=await observer`SELECT pid FROM pg_stat_activity WHERE pid<>${firstPid}::int
        AND (${gatePid}::int=ANY(pg_blocking_pids(pid)) OR ${firstPid}::int=ANY(pg_blocking_pids(pid)))`;
      for(const row of rows) if(await ownedWait(observer,Number(row.pid),{tokens:[raced.T.token_id,raced.C.token_id,raced.X.token_id],users:[owner.userId],workspaces:[workspaceId]})) secondPid=Number(row.pid);
      if(secondPid==null) await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(secondPid==null) fail('active_floor_second_owned_queue_inconclusive');
  });
  const results=await Promise.all([first,second]);
  const used=firstUseFirst ? results[0] : results[1],revoked=firstUseFirst ? results[1] : results[0];
  check('both-owned-distinct-pids',firstPid>0 && secondPid>0 && firstPid!==secondPid && gatePid!==firstPid && gatePid!==secondPid);
  check('no-race-sqlstate',states.length===0);
  check('revoke-committed',revoked?.status===200);
  check('ordered-first-use-result',firstUseFirst ? used===200 : [401,403].includes(used));
  if(!firstUseFirst) check('denied-first-use-rolls-back-adoption',(await observer`SELECT first_used_at IS NULL AS ok FROM swarm.agent_tokens WHERE token_id=${raced.X.token_id}::uuid`)[0].ok);
  check('terminal-denial',[401,403].includes(await use(raced.raw)));
  return {checks,sqlstates:states,canonical_witness:{first_pid:firstPid,second_pid:secondPid,gate_pid:gatePid,
    workspace_id:workspaceId,token_ids:[raced.T.token_id,raced.C.token_id,raced.X.token_id],order:firstUseFirst?'use-first':'revoke-first'}};
}
