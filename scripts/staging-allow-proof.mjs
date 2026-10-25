#!/usr/bin/env node
// Staging proof for issue #186: one real Allow and one concurrent double Allow
// of a local agent connection through the deployed hosted path, with the
// agent's own Lists read before and after. Prints statuses only; never prints
// a credential. Run after `npm run build` from the repository root, on the
// host that holds the test owner's CLI session and the agent's seat profile:
//
//   node scripts/staging-allow-proof.mjs --human-profile <dir> --seat-profile <dir> \
//     --workspace-id <uuid> [--purpose shared|personal] [--out <report.json>]
//
// The human profile directory is the CLI credential store of the signed-in test
// owner (target.json plus the profile files, 0700/0600, as live-ordinary-controls
// uses). The seat profile directory holds the agent's profile.json and credential.
import { constants } from 'node:fs';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
for (const k of ['human-profile', 'seat-profile', 'workspace-id']) if (!args[k]) fail(`--${k} is required`);
if (!UUID.test(args['workspace-id'])) fail('--workspace-id must be a UUID');
const purpose = args.purpose ?? 'shared';
if (!['shared', 'personal'].includes(purpose)) fail('--purpose must be shared or personal');
const REQUEST_MS = 30_000;
// Local credentials select identity; the seat field only satisfies the shared tool schema.
const LOCAL_SEAT = 'seat_0000000000000000000000';

function fail(message) { process.stderr.write(`FAIL: ${message}\n`); process.exit(1); }
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
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > 131_072) fail(`${path} must be an owned 0600 file`);
    return JSON.parse((await fd.readFile()).toString('utf8'));
  } finally { await fd.close(); }
}
async function post(url, bearer, anonKey, body) {
  const started = Date.now();
  const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(REQUEST_MS),
    headers: { authorization: `Bearer ${bearer}`, apikey: anonKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await response.json(); } catch { /* non-JSON refusals carry no code */ }
  const data = json && typeof json === 'object' && !Array.isArray(json) ? json : {};
  return { http: response.status, status: typeof data.status === 'string' ? data.status : null,
    reason: typeof (data.reason ?? data.error) === 'string' ? (data.reason ?? data.error) : null, ms: Date.now() - started, body: data };
}
const strip = ({ body, ...rest }) => rest;

const { cloudTarget, commandEndpoint, CLIENT_PROTOCOL_VERSION } = await import('../dist/cloud/config.js');
const { withClientBuild } = await import('../dist/cloud/client-build.js');
const { credentialStore } = await import('../dist/cloud/storage.js');
const { refreshedCredential } = await import('../dist/cloud/auth.js');
const { readAgentProfile, readProfileCredential } = await import('../dist/cloud/agent-profile.js');

const humanDir = args['human-profile'], seatDir = args['seat-profile'], workspaceId = args['workspace-id'];
const targetFile = await privateJson(join(humanDir, 'target.json'));
if (typeof targetFile.url !== 'string' || typeof targetFile.anon_key !== 'string') fail('target.json must hold url and anon_key');
const target = cloudTarget(targetFile.url, targetFile.anon_key);
const store = await credentialStore({ target, stateDirectory: humanDir, forceFile: true, allowFileFallback: true, warn: () => {} });
const human = await refreshedCredential(target, store, {});
const seat = await readAgentProfile(join(seatDir, 'profile.json'));
if (seat.url !== targetFile.url || seat.workspace_id !== workspaceId) fail('seat profile must point at the same target and workspace');
const agent = await readProfileCredential(seat);
const endpoint = commandEndpoint(target);
const envelope = (command) => withClientBuild({ command_id: randomUUID(), client_version: CLIENT_PROTOCOL_VERSION,
  workspace_id: workspaceId, stream: { kind: 'workspace' }, command });
const asHuman = (command) => post(endpoint, human.accessToken, target.anonKey, envelope(command));
const agentList = () => post(endpoint, agent.token, target.anonKey,
  envelope({ kind: 'household_tool', tool: 'object_list', arguments: { seat: LOCAL_SEAT, offset: 0, limit: 1 } }));

const report = { target: targetFile.url, workspace_id: workspaceId, principal_id: seat.principal_id, purpose, steps: {} };
async function finish(code) {
  const text = JSON.stringify(report, null, 2) + '\n';
  if (args.out) await writeFile(args.out, text, { mode: 0o600, flag: 'wx' });
  process.stdout.write(text);
  process.exit(code);
}

report.steps.agent_read_before = strip(await agentList());
const connections = await asHuman({ kind: 'household_connections' });
const rows = Array.isArray(connections.body.connections) ? connections.body.connections : [];
const local = rows.find(c => c.kind === 'local' && c.principal_id === seat.principal_id);
report.steps.household_connections = { ...strip(connections), local_connections: rows.filter(c => c.kind === 'local').length,
  found_seat_connection: Boolean(local), approval_before: local?.approval ?? null, effective_access_before: local?.effective_access ?? null };
if (!local) { report.verdict = 'FAIL: no live local connection for the seat principal in this workspace'; await finish(1); }
const connection = { kind: 'local', connection_id: local.connection_id, grant_id: local.grant_id, principal_id: local.principal_id, operations: ['read'] };
report.connection = { connection_id: local.connection_id, grant_id: local.grant_id, renewal_grant_id: local.renewal_grant_id ?? null,
  connection_expires_at: local.connection_expires_at ?? null };
const allow = () => asHuman({ kind: 'household_permissions', purpose, content_role: 'reader', connection });
report.steps.single_allow = strip(await allow());
report.steps.agent_read_after_single = strip(await agentList());
const [first, second] = await Promise.all([allow(), allow()]);
report.steps.double_allow = [strip(first), strip(second)];
report.steps.agent_read_after_double = strip(await agentList());
const after = await asHuman({ kind: 'household_connections' });
const localAfter = (Array.isArray(after.body.connections) ? after.body.connections : []).find(c => c.kind === 'local' && c.principal_id === seat.principal_id);
report.steps.household_connections_after = { ...strip(after), approval_after: localAfter?.approval ?? null, effective_access_after: localAfter?.effective_access ?? null };
const committed = r => r.http === 200 && r.status === 'committed';
const readOk = r => r.http === 200 && r.status === 'ok';
const pass = committed(report.steps.single_allow) && committed(first) && committed(second)
  && readOk(report.steps.agent_read_after_single) && readOk(report.steps.agent_read_after_double)
  && localAfter?.approval !== null && localAfter?.approval?.expires_at === null;
report.verdict = pass ? 'PASS' : 'FAIL: see steps';
report.database_checks = [
  '-- exactly one approval row for the connection, permanent and family-bound',
  `SELECT count(*) AS rows, bool_and(expires_at IS NULL) AS permanent, bool_and(renewal_grant_id IS NOT NULL) AS family_bound, bool_and(revoked_at IS NULL) AS live FROM swarm.household_content_connections WHERE connection_id='${local.connection_id}' AND grant_id='${local.grant_id}' AND workspace_id='${workspaceId}' AND principal_id='${local.principal_id}';`,
  '-- three Allow decisions in append-only audit (one single, two concurrent); exactly one had no prior row',
  `SELECT count(*) AS decisions, count(*) FILTER (WHERE detail::jsonb->'before' = 'null'::jsonb) AS first_decisions FROM swarm.audit_log WHERE reason='local_allow_decision' AND workspace_id='${workspaceId}' AND detail::jsonb->'after'->>'connection_id'='${local.connection_id}';`,
  '-- the family points at the approved bearer',
  `SELECT local_content_approval_token_id='${local.connection_id}' AS pointer_set FROM swarm.renewal_grants WHERE renewal_grant_id=(SELECT renewal_grant_id FROM swarm.household_content_connections WHERE connection_id='${local.connection_id}' AND grant_id='${local.grant_id}' AND workspace_id='${workspaceId}' AND principal_id='${local.principal_id}');`,
];
await finish(pass ? 0 : 1);
