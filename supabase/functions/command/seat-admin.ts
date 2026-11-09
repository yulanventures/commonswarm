/**
 * Seat admin, PR 2a: a person grants or ends admin powers on one of their own agents' seats.
 * Behind SWARM_SEAT_ADMIN (off). Agents can't use a grant yet; that arrives in later PRs, each
 * re-reading the grant row under lock on every action.
 *
 * Lock order, the same as the other account commands: the grantor's user row, their admin
 * account, then the principal (grant) or the grant row (end), then memberships. Ending takes the
 * grant row FOR UPDATE, so an agent action holding it FOR SHARE commits first or sees the end.
 * History is the grantor's admin account stream, as AdminActionRecorded, so "Recorded actions"
 * shows every grant and end. A retried command id returns the grant's current state, never a
 * stored success, so a replay can't outlive a downgrade.
 */
import type postgres from 'npm:postgres@3.4.9';
import { adminDigest } from './admin-delegation.ts';
import {
  decideSeatAdminEnd, decideSeatAdminGrant, parseSeatAdminCommand, reduceAdminAuthority,
} from '../_shared/protocol.js';
import type { AdminAccountEvent, AdminAccountState } from '../_shared/admin-authority.d.ts';
import type { EndDecision, GrantDecision, GrantSeatAdminCommand, SeatAdminCommand, SeatAdminLevel } from '../_shared/seat-admin.d.ts';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
type Result = { status: number; body: Record<string, unknown> };
export interface SeatAdminHuman {
  user_id: string;
  session_binding: string;
  interactive_at_seconds: number | null;
  csrf_verified: boolean;
}

interface GrantRow {
  grant_id: string; owner_user_id: string; principal_id: string; level: SeatAdminLevel; organization_id: string | null;
  scope_names: string[]; workspace_ids: string[]; manifest: { capability_names?: string[] }; manifest_digest: string;
  expires_at: Date | null; state: string; created_at: Date; ended_at: Date | null; end_reason: string | null;
}

const COMMAND_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const WIRE_KEYS = ['command_id', 'stream', 'command', 'client_version', 'client_build', 'resource'];
// The site sends its account resource on every account command; accept that value or nothing.
const ACCOUNT_RESOURCE = 'https://api.commonswarm.com/admin';
const failure = (status: number, error: string): Result => ({ status, body: { error } });

function publicGrant(row: GrantRow, now: number): Record<string, unknown> {
  const expired = row.state === 'active' && row.expires_at !== null && row.expires_at.getTime() <= now;
  return {
    grant_id: row.grant_id, principal_id: row.principal_id, level: row.level, organization_id: row.organization_id,
    scope_names: row.scope_names, workspace_ids: row.workspace_ids, capability_names: row.manifest.capability_names ?? [],
    expires_at: row.expires_at?.toISOString() ?? null, state: expired ? 'expired' : row.state,
    created_at: row.created_at.toISOString(), ended_at: row.ended_at?.toISOString() ?? null, end_reason: row.end_reason,
    manifest_digest: row.manifest_digest,
  };
}

async function clock(tx: Sql): Promise<number> {
  const [row] = await tx<{ now: number }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`;
  return row!.now;
}

/** Locks the account owner's user row and admin account, creating the account on first use. */
async function lockAccount(tx: Sql, owner: string) {
  await tx`SELECT user_id FROM swarm.users WHERE user_id = ${owner}::uuid FOR NO KEY UPDATE`; // Lock order: lockPrincipalName in command/index.ts.
  await tx`INSERT INTO swarm.admin_accounts(owner_user_id, stream_id) VALUES (${owner}::uuid, ${crypto.randomUUID()}::uuid)
    ON CONFLICT(owner_user_id) DO NOTHING`;
  const [account] = await tx<{ stream_id: string; seq: string | number; projection: AdminAccountState }[]>`
    SELECT stream_id, seq, projection FROM swarm.admin_accounts WHERE owner_user_id = ${owner}::uuid FOR UPDATE`;
  return account!;
}

async function record(tx: Sql, owner: string, account: Awaited<ReturnType<typeof lockAccount>>, actor: string, commandId: string,
  now: number, payload: Record<string, unknown>): Promise<void> {
  const event: AdminAccountEvent = {
    stream_kind: 'account', owner_user_id: owner, stream_id: account.stream_id, seq: Number(account.seq) + 1,
    event_id: crypto.randomUUID(), command_id: commandId, type: 'AdminActionRecorded', schema_version: 1,
    occurred_at_server: now, actor_user: actor, actor_agent_principal: null, actor_run: null,
    admin_identity_id: null, grant_id: null, grant_manifest_digest: null,
    payload: { audit_record_id: crypto.randomUUID(), grant_id: null, admin_identity_id: null, connection_id: null,
      related_event_ids: [], policy_check: { result: payload.reason_code ?? 'passed', buckets: [] }, ...payload },
  };
  await tx`INSERT INTO swarm.admin_events(owner_user_id, seq, event_id, command_id, event)
    VALUES (${owner}::uuid, ${event.seq}, ${event.event_id}::uuid, ${commandId}, ${tx.json(event as unknown as postgres.JSONValue)})`;
  const projection = reduceAdminAuthority(account.projection, event);
  await tx`UPDATE swarm.admin_accounts SET seq = ${event.seq}, projection = ${tx.json(projection as unknown as postgres.JSONValue)}
    WHERE owner_user_id = ${owner}::uuid`;
  account.seq = event.seq;
  account.projection = projection;
}

async function grantFacts(tx: Sql, c: GrantSeatAdminCommand, human: SeatAdminHuman) {
  const [principal] = await tx<{ owner_user_id: string; revoked: boolean }[]>`
    SELECT owner_user_id, revoked_at IS NOT NULL AS revoked FROM swarm.agent_principals
    WHERE principal_id = ${c.principal_id}::uuid FOR UPDATE`;
  const workspaces: Record<string, { grantor_live_owner: boolean; agent_live_member: boolean; archived: boolean }> = {};
  for (const id of c.workspace_ids) { // sorted by the parser, so locks are taken in one order
    const [w] = await tx<{ archived: boolean }[]>`SELECT archived_at IS NOT NULL AS archived FROM swarm.workspaces
      WHERE workspace_id = ${id}::uuid FOR SHARE`;
    if (!w) continue;
    const owner = await tx`SELECT 1 FROM swarm.memberships WHERE workspace_id = ${id}::uuid AND user_id = ${human.user_id}::uuid
      AND role = 'owner' AND revoked_at IS NULL FOR SHARE`;
    // No row lock here: the command role has only a SELECT policy on this table, so FOR SHARE would
    // filter every row. The principal row is held FOR UPDATE above, and every agent action re-reads
    // membership live under its own locks; the grant is a point-in-time check.
    const member = await tx`SELECT 1 FROM swarm.agent_workspace_memberships WHERE workspace_id = ${id}::uuid
      AND principal_id = ${c.principal_id}::uuid AND revoked_at IS NULL`;
    workspaces[id] = { grantor_live_owner: owner.length === 1, agent_live_member: member.length === 1, archived: w.archived };
  }
  let organization: { grantor_live_owner: boolean; archived: boolean } | null = null;
  if (c.organization_id !== null) {
    const [o] = await tx<{ r: { archived: boolean; owner: boolean } | null }[]>`
      SELECT swarm.seat_admin_org_owner(${c.organization_id}::uuid, ${human.user_id}::uuid) AS r`;
    if (o?.r) organization = { grantor_live_owner: o.r.owner, archived: o.r.archived };
  }
  return { principal: principal ?? null, workspaces, organization };
}

/** The active grant for this agent at this level and target, if any, locked. */
async function activeGrant(tx: Sql, c: GrantSeatAdminCommand): Promise<GrantRow | undefined> {
  const [row] = await tx<GrantRow[]>`SELECT * FROM swarm.seat_admin_grants
    WHERE principal_id = ${c.principal_id}::uuid AND state = 'active' AND level = ${c.level}
      AND (${c.level} = 'scoped'
        OR (${c.level} = 'workspace' AND workspace_ids[1] = ${c.workspace_ids[0] ?? null}::uuid)
        OR (${c.level} = 'organization' AND organization_id = ${c.organization_id}::uuid))
    FOR UPDATE`;
  return row;
}

export async function seatAdminTransaction(tx: Sql, input: Record<string, unknown>, human: SeatAdminHuman): Promise<Result> {
  const stream = input.stream as Record<string, unknown> | null;
  if (typeof input.command_id !== 'string' || !COMMAND_ID.test(input.command_id) || !stream || stream.kind !== 'account'
    || Object.keys(stream).length !== 1 || Object.keys(input).some(key => !WIRE_KEYS.includes(key))
    || (input.resource !== undefined && input.resource !== ACCOUNT_RESOURCE)) return failure(400, 'invalid_request');
  const command = parseSeatAdminCommand(input.command) as SeatAdminCommand | null;
  if (!command) return failure(400, 'invalid_request');
  const commandId = input.command_id;
  const actorKey = `human:${human.user_id}`;
  const requestDigest = await adminDigest(input);

  // The account the history belongs to: the grantor's. An end may come from another owner of a covered target.
  let owner = human.user_id;
  if (command.kind === 'end_seat_admin') {
    const [row] = await tx<{ owner_user_id: string }[]>`SELECT owner_user_id FROM swarm.seat_admin_grants WHERE grant_id = ${command.grant_id}::uuid`;
    if (!row) return failure(404, 'not_found');
    owner = row.owner_user_id;
  }
  const account = await lockAccount(tx, owner);

  const [prior] = await tx<{ request_digest: string; response: Result }[]>`SELECT request_digest, response
    FROM swarm.admin_command_results WHERE owner_user_id = ${owner}::uuid AND actor_key = ${actorKey} AND command_id = ${commandId}`;
  if (prior) {
    if (prior.request_digest !== requestDigest) return failure(409, 'command_id_conflict');
    if (prior.response.status !== 200) return prior.response;
    // A settled grant or end replays as the grant's current state, re-read now.
    const grantId = command.kind === 'end_seat_admin' ? command.grant_id
      : (prior.response.body.seat_admin_grant as { grant_id?: string } | undefined)?.grant_id;
    const [row] = await tx<GrantRow[]>`SELECT * FROM swarm.seat_admin_grants WHERE grant_id = ${grantId ?? null}::uuid`;
    return row ? { status: 200, body: { status: 'accepted', seat_admin_grant: publicGrant(row, await clock(tx)) } } : failure(404, 'not_found');
  }

  const finish = async (result: Result) => {
    await tx`INSERT INTO swarm.admin_command_results(owner_user_id, actor_key, command_id, request_digest, response)
      VALUES (${owner}::uuid, ${actorKey}, ${commandId}, ${requestDigest}, ${tx.json(result as unknown as postgres.JSONValue)})`;
    return result;
  };

  if (command.kind === 'grant_seat_admin') {
    const facts = await grantFacts(tx, command, human);
    let existing = await activeGrant(tx, command);
    const now = await clock(tx); // after every lock wait
    if (existing && existing.expires_at !== null && existing.expires_at.getTime() <= now) {
      await tx`UPDATE swarm.seat_admin_grants SET state = 'expired', ended_at = ${existing.expires_at}, end_reason = 'expired'
        WHERE grant_id = ${existing.grant_id}::uuid`;
      existing = undefined;
    }
    const decision = decideSeatAdminGrant(command, {
      now, actor: { kind: 'human', user_id: human.user_id, interactive_at_seconds: human.interactive_at_seconds,
        csrf_verified: human.csrf_verified, session_bound: /^[0-9a-f]{64}$/u.test(human.session_binding) },
      principal: facts.principal, workspaces: facts.workspaces, organization: facts.organization, existing_active: existing !== undefined,
    }) as GrantDecision;
    const target = { level: command.level, principal_id: command.principal_id, scope_names: command.scope_names,
      workspace_ids: command.workspace_ids, organization_id: command.organization_id,
      expires_at: command.expires_at === null ? null : new Date(command.expires_at).toISOString() };
    if (!decision.ok) {
      await record(tx, owner, account, human.user_id, commandId, now, { action: 'grant_seat_admin', target_kind: 'seat_admin_grant',
        target_id: null, workspace_id: null, ...target, manifest_digest: null, request_digest: requestDigest, outcome: 'refused',
        reason_code: decision.reason, next_action: 'none', recovery_kind: 'human' });
      const status = decision.reason === 'human_confirmation_required' ? 401 : decision.reason === 'seat_admin_exists' ? 409
        : ['invalid_request', 'invalid_expiry', 'scope_forbidden'].includes(decision.reason) ? 400 : 403;
      return await finish(failure(status, decision.reason));
    }
    const grantId = crypto.randomUUID();
    const digest = await adminDigest(decision.manifest);
    const [row] = await tx<GrantRow[]>`INSERT INTO swarm.seat_admin_grants (grant_id, owner_user_id, principal_id, level, organization_id,
        registry_version, scope_names, workspace_ids, manifest, manifest_digest, expires_at, created_at)
      VALUES (${grantId}::uuid, ${owner}::uuid, ${command.principal_id}::uuid, ${command.level}, ${command.organization_id}::uuid, 3,
        ${command.scope_names}::text[], ${command.workspace_ids}::uuid[], ${tx.json(decision.manifest as unknown as postgres.JSONValue)},
        ${digest}, ${command.expires_at === null ? null : new Date(command.expires_at)}, ${new Date(now)})
      RETURNING *`;
    await record(tx, owner, account, human.user_id, commandId, now, { action: 'grant_seat_admin', target_kind: 'seat_admin_grant',
      target_id: grantId, workspace_id: null, ...target, manifest_digest: digest, request_digest: requestDigest, outcome: 'accepted',
      reason_code: null, next_action: 'none', recovery_kind: 'none' });
    return await finish({ status: 200, body: { status: 'accepted', seat_admin_grant: publicGrant(row!, now) } });
  }

  // end_seat_admin
  const [grant] = await tx<GrantRow[]>`SELECT * FROM swarm.seat_admin_grants WHERE grant_id = ${command.grant_id}::uuid FOR UPDATE`;
  let ownsCovered = false;
  if (grant && grant.owner_user_id !== human.user_id) {
    const [hit] = grant.level === 'organization'
      ? await tx<{ ok: boolean }[]>`SELECT coalesce((swarm.seat_admin_org_owner(${grant.organization_id}::uuid, ${human.user_id}::uuid)->>'owner')::boolean, false) AS ok`
      : await tx<{ ok: boolean }[]>`SELECT EXISTS(SELECT 1 FROM swarm.memberships WHERE workspace_id = ANY(${grant.workspace_ids}::uuid[])
          AND user_id = ${human.user_id}::uuid AND role = 'owner' AND revoked_at IS NULL) AS ok`;
    ownsCovered = hit?.ok === true;
  }
  const now = await clock(tx);
  const decision = decideSeatAdminEnd({ actor: { kind: 'human', user_id: human.user_id, csrf_verified: human.csrf_verified },
    grant: grant ? { owner_user_id: grant.owner_user_id, state: grant.state, level: grant.level } : null,
    actor_owns_covered_target: ownsCovered }) as EndDecision;
  if (!decision.ok) {
    // Someone with no say over this grant learns nothing about it, not even that it exists.
    if (decision.reason === 'not_found') return failure(404, 'not_found');
    return await finish(failure(decision.reason === 'human_confirmation_required' ? 401 : 403, decision.reason));
  }
  let ended = grant!;
  if (!decision.already_ended) {
    const rows = await tx<GrantRow[]>`UPDATE swarm.seat_admin_grants SET state = 'downgraded', ended_at = ${new Date(now)},
        end_reason = 'owner_downgrade' WHERE grant_id = ${grant!.grant_id}::uuid RETURNING *`;
    ended = rows[0]!;
    await record(tx, owner, account, human.user_id, commandId, now, { action: 'end_seat_admin', target_kind: 'seat_admin_grant',
      target_id: grant!.grant_id, workspace_id: null, level: grant!.level, principal_id: grant!.principal_id,
      manifest_digest: grant!.manifest_digest, request_digest: requestDigest, outcome: 'accepted', reason_code: null,
      next_action: 'none', recovery_kind: 'none' });
  }
  return await finish({ status: 200, body: { status: 'accepted', seat_admin_grant: publicGrant(ended, now) } });
}
