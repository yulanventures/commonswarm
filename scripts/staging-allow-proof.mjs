#!/usr/bin/env node
// Staging proof for issue #186: one real Allow and one concurrent double Allow
// of a local agent connection through the deployed hosted path, with the
// agent's own Lists read before and after. Prints statuses only; never prints
// a credential. Run after `npm run build` from the repository root, on the
// host that holds the test owner's CLI session and the agent's seat profile:
//
//   node scripts/staging-allow-proof.mjs --human-profile <dir> --seat-profile <dir> \
//     --workspace-id <uuid> --expected-staging-origin https://api.commonswarm.com \
//     --staging-address 157.90.159.116 --staging-ca <public-ca.pem> \
//     --staging-ca-sha256 <64-hex-digest> \
//     [--purpose shared|personal] [--out <report.json>]
//
// Measure the CA file's SHA-256 on c1-staging from
// /root/c1-staging-origin-ca/ca.crt and record it in the approved window receipt.
// Copy only that public certificate to the invoking host as <public-ca.pem>.
// The digest is checked before profiles or transport are accessed. Only this CA
// is trusted for the pinned connection; NODE_EXTRA_CA_CERTS is ignored.
//
// COMMONSWARM_EXPECTED_STAGING_ORIGIN may supply the required expected origin.
// Target and seat URLs must match it before credential refresh or any request.
// Use a fresh connection; PASS covers HTTP checks only. Execute all emitted
// database_checks separately before accepting the release proof.
//
// The human profile directory is the CLI credential store of the signed-in test
// owner (target.json plus the profile files, 0700/0600, as live-ordinary-controls
// uses). The seat profile directory holds the agent's profile.json and credential.
import { constants } from 'node:fs';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { Agent, request } from 'node:https';
import { connect } from 'node:tls';

// Reviewed transport inventory: infrastructure/servers.md (host table and
// c1-staging section), infrastructure/commonswarm.md (Staging). DNS is shared.
const REVIEWED_ADDRESSES = Object.freeze({
  staging: '157.90.159.116', production: Object.freeze(['100.115.66.74', '178.105.29.28']),
});
const credentials = new Set();
function remember(value) {
  if (!value || typeof value !== 'object') return value;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:anon_?key|access_?token|refresh_?token|token)$/i.test(key)
      && typeof entry === 'string' && entry.length) credentials.add(entry);
    else if (entry && typeof entry === 'object') remember(entry);
  }
  return value;
}
function redact(text) {
  for (const secret of [...credentials].sort((a, b) => b.length - a.length)) {
    // Also cover quotes, backslashes and control characters in JSON strings.
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      text = text.split(form).join('[REDACTED]');
    }
  }
  return text;
}
class ProofFailure extends Error {}
function fail(message) { throw new ProofFailure(message); }
let args = {};
async function main() {

  args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []));
  if (!args['staging-ca']) fail('--staging-ca is required');
  if (!/^[0-9a-f]{64}$/i.test(args['staging-ca-sha256'] ?? '')) fail('--staging-ca-sha256 must be a SHA-256 hex digest');
  let stagingCA;
  try {
    const fd = await open(args['staging-ca'], constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await fd.stat();
      if (!s.isFile() || s.size > 131_072) fail('staging CA must be a public PEM certificate');
      stagingCA = await fd.readFile();
    } finally { await fd.close(); }
  } catch { fail('staging CA must be a readable public PEM certificate'); }
  const stagingCADigest = createHash('sha256').update(stagingCA).digest('hex');
  if (stagingCADigest !== args['staging-ca-sha256'].toLowerCase()) fail('staging CA digest mismatch; no requests sent');
  const caPEM = stagingCA.toString('utf8');
  if (/-----BEGIN [^-]*PRIVATE KEY-----/i.test(caPEM)
    || !/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(caPEM)) {
    fail('staging CA must contain only a public PEM certificate');
  }
  try { if (!new X509Certificate(stagingCA).ca) fail('staging CA certificate required'); }
  catch { fail('staging CA certificate required'); }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const k of ['human-profile', 'seat-profile', 'workspace-id']) if (!args[k]) fail(`--${k} is required`);
  if (!UUID.test(args['workspace-id'])) fail('--workspace-id must be a UUID');
  const expectedOriginInput = args['expected-staging-origin'] ?? process.env.COMMONSWARM_EXPECTED_STAGING_ORIGIN;
  if (!expectedOriginInput) fail('--expected-staging-origin or COMMONSWARM_EXPECTED_STAGING_ORIGIN is required');
  const expectedOrigin = stagingOrigin(expectedOriginInput);
  const stagingAddress = args['staging-address'];
  if (!stagingAddress || REVIEWED_ADDRESSES.production.includes(stagingAddress)
    || stagingAddress !== REVIEWED_ADDRESSES.staging) fail('staging address must be the reviewed c1-staging address; no requests sent');
  const purpose = args.purpose ?? 'shared';
  if (!['shared', 'personal'].includes(purpose)) fail('--purpose must be shared or personal');
  const REQUEST_MS = 30_000;
  // Local credentials select identity; the seat field only satisfies the shared tool schema.
  const LOCAL_SEAT = 'seat_0000000000000000000000';

  function stagingOrigin(value) {
    let url;
    try { url = new URL(value); } catch { fail('staging URL must be an HTTPS origin'); }
    if (url.protocol !== 'https:' || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') fail('staging URL must be an HTTPS origin without credentials, path, query or fragment');
    return url.origin;
  }
  async function directory(path) {
    if (await realpath(path) !== path) fail('profile directory must be a real path');
    const s = await lstat(path);
    if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) fail('profile directory must be owned 0700');
  }
  async function privateJson(path) {
    await directory(dirname(path));
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await fd.stat();
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > 131_072) fail('private input must be an owned 0600 file');
      try { return remember(JSON.parse((await fd.readFile()).toString('utf8'))); }
      catch { fail('private_json_invalid'); }
    } finally { await fd.close(); }
  }
  async function post(url, bearer, anonKey, body) {
    const started = Date.now();
    let response;
    try {
      response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(REQUEST_MS),
        headers: { authorization: `Bearer ${bearer}`, apikey: anonKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      // Do not expose request errors: they can contain credential-bearing details.
      return { http: null, status: null, reason: 'request_failed', ms: Date.now() - started, body: {} };
    }
    let json = null; try { json = await response.json(); } catch { /* non-JSON refusals carry no code */ }
    const data = json && typeof json === 'object' && !Array.isArray(json) ? json : {};
    return { http: response.status, status: fixedCode(data.status, ['ok', 'committed', 'refused']),
      reason: fixedCode(data.reason ?? data.error, ['workspace_access_refused', 'content_consent_required', 'service_unavailable']), ms: Date.now() - started, body: data };
  }
  const strip = ({ body, ...rest }) => rest;
  function fixedCode(value, allowed) {
    return value == null ? null : allowed.includes(value) ? value : 'unrecognized_response';
  }
  function id(value) { return typeof value === 'string' && UUID.test(value) ? value : 'invalid_id'; }
  function stamp(value) {
    return value == null ? null : typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ? value : 'invalid_timestamp';
  }
  function operations(value) {
    return Array.isArray(value) ? value.map(v => fixedCode(v, ['read', 'create', 'update'])) : [];
  }
  function approval(value) {
    return value && typeof value === 'object'
      ? { operations: operations(value.operations), expires_at: stamp(value.expires_at) } : null;
  }
  function access(value) {
    return value && typeof value === 'object' ? {
      source: fixedCode(value.source, ['none', 'human', 'inherited', 'explicit']),
      operations: operations(value.operations), restricted: value.restricted === true,
    } : null;
  }

  const humanDir = args['human-profile'], seatDir = args['seat-profile'], workspaceId = args['workspace-id'];
  const targetFile = await privateJson(join(humanDir, 'target.json'));
  if (typeof targetFile.url !== 'string' || typeof targetFile.anon_key !== 'string') fail('target.json must hold url and anon_key');
  if (stagingOrigin(targetFile.url) !== expectedOrigin) fail('target URL differs from expected staging origin; no requests sent');

  const { cloudTarget, commandEndpoint, CLIENT_PROTOCOL_VERSION } = await import('../dist/cloud/config.js');
  const { withClientBuild } = await import('../dist/cloud/client-build.js');
  const { credentialStore } = await import('../dist/cloud/storage.js');
  const { refreshedCredential } = await import('../dist/cloud/auth.js');
  const { readAgentProfile, readProfileCredential } = await import('../dist/cloud/agent-profile.js');

  const target = cloudTarget(targetFile.url, targetFile.anon_key);
  const seat = remember(await readAgentProfile(join(seatDir, 'profile.json')));
  if (id(seat.principal_id) === 'invalid_id') fail('seat_principal_invalid');
  if (stagingOrigin(seat.url) !== expectedOrigin || seat.workspace_id !== workspaceId) fail('seat profile must point at the expected staging origin and workspace; no requests sent');
  // The agent does not release a TLS socket to https.request until its peer is
  // checked. No HTTP headers/body (including refresh credentials) precede this.
  // Host and TLS SNI retain the approved hostname; DNS/proxies are never used.
  const transport = new Agent({ keepAlive: false });
  transport.createConnection = (options, callback) => {
    const socket = connect({ host: stagingAddress, port: options.port,
      servername: new URL(expectedOrigin).hostname, ca: stagingCA, rejectUnauthorized: true });
    const onError = () => callback(new ProofFailure('staging_transport_failed'));
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      if (socket.remoteAddress !== stagingAddress || !socket.authorized) {
        socket.destroy();
        callback(new ProofFailure('staging_peer_refused'));
        return;
      }
      socket.removeListener('error', onError);
      callback(null, socket);
    });
    // Deliberately do not return the socket: the request must await validation.
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== expectedOrigin || url.username || url.password) fail('request URL differs from expected staging origin');
    const headers = new Headers(init.headers);
    for (const key of ['authorization', 'apikey']) {
      const value = headers.get(key);
      if (value) credentials.add(key === 'authorization' ? value.replace(/^Bearer /, '') : value);
    }
    if (typeof init.body === 'string') {
      try { remember(JSON.parse(init.body)); } catch { /* bodies are emitted by the CLI */ }
    }
    return await new Promise((resolve, reject) => {
      const req = request(url, { agent: transport, method: init.method ?? 'GET',
        headers: Object.fromEntries(headers), signal: init.signal ?? AbortSignal.timeout(REQUEST_MS) }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume(); reject(new ProofFailure('staging_redirect_refused')); return;
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.once('error', () => reject(new ProofFailure('staging_response_failed')));
        response.once('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            try { remember(JSON.parse(body)); } catch { /* post handles non-JSON */ }
            resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : body,
              { status: response.statusCode }));
          } catch { reject(new ProofFailure('staging_response_failed')); }
        });
      });
      req.once('error', () => reject(new ProofFailure('staging_request_failed')));
      req.end(init.body);
    });
  };
  const rawStore = await credentialStore({ target, stateDirectory: humanDir, forceFile: true, allowFileFallback: true, warn: () => {} });
  // Refresh can read cached/rotated credentials internally. Track all of them.
  const store = new Proxy(rawStore, { get(object, key) {
    const value = Reflect.get(object, key);
    return typeof value !== 'function' ? value : async (...values) => {
      values.forEach(remember);
      return remember(await value.apply(object, values));
    };
  } });
  const human = remember(await refreshedCredential(target, store, {}));
  const agent = remember(await readProfileCredential(seat));
  const endpoint = commandEndpoint(target);
  const envelope = (command) => withClientBuild({ command_id: randomUUID(), client_version: CLIENT_PROTOCOL_VERSION,
    workspace_id: workspaceId, stream: { kind: 'workspace' }, command });
  const asHuman = (command) => post(endpoint, human.accessToken, target.anonKey, envelope(command));
  const agentList = () => post(endpoint, agent.token, target.anonKey,
    envelope({ kind: 'household_tool', tool: 'object_list', arguments: { seat: LOCAL_SEAT, offset: 0, limit: 1 } }));

  const report = { target: targetFile.url, staging_address: stagingAddress, staging_ca_sha256: stagingCADigest,
    workspace_id: workspaceId, principal_id: seat.principal_id, purpose, steps: {} };
  async function finish(code) {
    const text = redact(JSON.stringify(report, null, 2) + '\n');
    if (args.out) await writeFile(args.out, text, { mode: 0o600, flag: 'wx' });
    process.stdout.write(text);
    process.exit(code);
  }

  const committed = r => r.http === 200 && r.status === 'committed';
  const readOk = r => r.http === 200 && r.status === 'ok';
  const listOk = r => readOk(r) && Array.isArray(r.body.connections);
  // command/index.ts returns household refusals as HTTP 200; a local connection
  // without approval has no content access (household-content-access.ts), so
  // household-integration.ts returns workspace_access_refused before object_list.
  const initialRefused = r => r.http === 200 && r.status === 'refused' && r.reason === 'workspace_access_refused';
  report.steps.agent_read_before = strip(await agentList());
  if (!initialRefused(report.steps.agent_read_before)) {
    report.verdict = 'FAIL: initial agent read must be HTTP 200 refused/workspace_access_refused before Allow';
    await finish(1);
  }
  const connections = await asHuman({ kind: 'household_connections' });
  if (!listOk(connections)) {
    report.steps.household_connections = strip(connections);
    report.verdict = 'FAIL: initial connection-list response must be HTTP 200 ok with connections';
    await finish(1);
  }
  const rows = connections.body.connections;
  const local = rows.find(c => c.kind === 'local' && c.principal_id === seat.principal_id);
  report.steps.household_connections = { ...strip(connections), local_connections: rows.filter(c => c.kind === 'local').length,
    found_seat_connection: Boolean(local), approval_before: approval(local?.approval), effective_access_before: access(local?.effective_access) };
  if (local && [local.connection_id, local.grant_id, local.principal_id].some(v => id(v) === 'invalid_id')) fail('connection_identifiers_invalid');
  if (!local) { report.verdict = 'FAIL: no live local connection for the seat principal in this workspace'; await finish(1); }
  const connection = { kind: 'local', connection_id: local.connection_id, grant_id: local.grant_id, principal_id: local.principal_id, operations: ['read'] };
  report.connection = { connection_id: local.connection_id, grant_id: local.grant_id, renewal_grant_id: local.renewal_grant_id == null ? null : id(local.renewal_grant_id),
    connection_expires_at: stamp(local.connection_expires_at) };
  const allow = () => asHuman({ kind: 'household_permissions', purpose, content_role: 'reader', connection });
  report.steps.single_allow = strip(await allow());
  report.steps.agent_read_after_single = strip(await agentList());
  const [first, second] = await Promise.all([allow(), allow()]);
  report.steps.double_allow = [strip(first), strip(second)];
  report.steps.agent_read_after_double = strip(await agentList());
  const after = await asHuman({ kind: 'household_connections' });
  const localAfter = (Array.isArray(after.body.connections) ? after.body.connections : []).find(c => c.kind === 'local' && c.principal_id === seat.principal_id);
  report.steps.household_connections_after = { ...strip(after), approval_after: approval(localAfter?.approval), effective_access_after: access(localAfter?.effective_access) };
  const checks = {
    initial_authorization_refusal: initialRefused(report.steps.agent_read_before),
    initial_connection_list: listOk(connections),
    final_connection_list: listOk(after),
    single_allow_committed: committed(report.steps.single_allow),
    double_allow_committed: committed(first) && committed(second),
    read_after_single: readOk(report.steps.agent_read_after_single),
    read_after_double: readOk(report.steps.agent_read_after_double),
    permanent_approval: localAfter?.approval != null && localAfter.approval.expires_at === null,
  };
  report.failed_conditions = Object.keys(checks).filter(name => !checks[name]);
  const pass = report.failed_conditions.length === 0;
  report.verdict = pass ? 'PASS' : `FAIL: ${report.failed_conditions.join(', ')}`;
  report.database_checks = [
    '-- exactly one approval row for the connection, permanent and family-bound',
    `SELECT count(*) AS rows, bool_and(expires_at IS NULL) AS permanent, bool_and(renewal_grant_id IS NOT NULL) AS family_bound, bool_and(revoked_at IS NULL) AS live FROM swarm.household_content_connections WHERE connection_id='${local.connection_id}' AND grant_id='${local.grant_id}' AND workspace_id='${workspaceId}' AND principal_id='${local.principal_id}';`,
    '-- three Allow decisions in append-only audit (one single, two concurrent); exactly one had no prior row',
    `SELECT count(*) AS decisions, count(*) FILTER (WHERE detail::jsonb->'before' = 'null'::jsonb) AS first_decisions FROM swarm.audit_log WHERE reason='local_allow_decision' AND workspace_id='${workspaceId}' AND detail::jsonb->'after'->>'connection_id'='${local.connection_id}';`,
    '-- the family points at the approved bearer',
    `SELECT local_content_approval_token_id='${local.connection_id}' AS pointer_set FROM swarm.renewal_grants WHERE renewal_grant_id=(SELECT renewal_grant_id FROM swarm.household_content_connections WHERE connection_id='${local.connection_id}' AND grant_id='${local.grant_id}' AND workspace_id='${workspaceId}' AND principal_id='${local.principal_id}');`,
  ];
  await finish(pass ? 0 : 1);

}
try { await main(); } catch (error) {
  const reason = error instanceof ProofFailure ? error.message : 'proof_failed';
  const text = redact(JSON.stringify({ verdict: 'FAIL', reason }, null, 2) + '\n');
  process.stderr.write(redact(`FAIL: ${reason}\n`));
  if (args.out) {
    try { await writeFile(args.out, text, { mode: 0o600, flag: 'wx' }); }
    catch { process.stderr.write(redact('FAIL: report_write_failed\n')); }
  }
  process.stdout.write(text);
  process.exitCode = 1;
}
