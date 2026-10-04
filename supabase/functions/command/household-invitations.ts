/** Recipient-only join; called before workspace routing, within the authenticated
 * command transaction. No delegated credential can enter this boundary. */
import type postgres from 'npm:postgres@3.4.9';
import { parseHumanInviteCommand, decideHumanInvite, HOUSEHOLD_JOIN_DISCLOSURE, HOUSEHOLD_JOIN_CONSENT_VERSION,
  reduceAdminAuthority, canonicalAdminJson, adminEffectiveCapabilities, adminGrantManifest, adminManifestValid } from '../_shared/protocol.js';
import type { AdminAccountState, AdminAccountEvent, AdminGrant } from '../_shared/admin-authority.d.ts';
import type { HumanInviteCommand, HumanInviteFacts, HumanInviteDecision } from '../_shared/household-invitations.d.ts';
type Sql = postgres.TransactionSql<Record<string, unknown>>;
export interface InviteHuman { user_id: string; email: string | null; verified: boolean }
const date = (n: number) => new Date(n);
const hash = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const digest = async (value: unknown) => Array.from(await hash(canonicalAdminJson(value)), b => b.toString(16).padStart(2,'0')).join('');
const unavailable = () => ({ status: 403, body: { status: 'refused', reason: 'invitation_unavailable' } });
export async function humanInvitationTransaction(tx: Sql, commandId: string, value: unknown, human: InviteHuman | null) {
  const command = parseHumanInviteCommand(value) as HumanInviteCommand | null;
  if (!human?.verified) return { status: 403, body: { error: 'human_sign_in_required' } };
  if (!command || !/^[A-Za-z0-9_-]{1,128}$/.test(commandId)) return { status: 400, body: { error: 'invalid_request' } };
  const delegated = command.invitation.source === 'delegated';
  // First resolve without locks. Then follow the routine writer's lock order:
  // grantor user, account, grants, workspace, stream, invitation. Re-read under locks.
  const rows = delegated
    ? await tx`SELECT invitation_id,workspace_id,owner_user_id AS inviter,recipient_user_id FROM swarm.admin_routine_invitations
        WHERE invitation_id=${command.invitation.source === 'delegated' ? command.invitation.invitation_id : ''}::uuid AND recipient_user_id=${human.user_id}::uuid AND invitation_kind='member'`
    : await tx`SELECT invitation_id,workspace_id,created_by AS inviter FROM swarm.invitations
        WHERE token_hash=${await hash(command.invitation.source === 'link' ? command.invitation.token : '')}`;
  const located = rows[0];
  if (!located) return unavailable();
  const workspaceId = String(located.workspace_id), invitationId = String(located.invitation_id), inviter = String(located.inviter);
  let account: { stream_id: string; seq: number | string; projection: AdminAccountState } | undefined;
  let grant: AdminGrant | undefined;
  if (delegated) {
    await tx`SELECT user_id FROM swarm.users WHERE user_id=${inviter}::uuid FOR UPDATE`;
    [account] = await tx<{ stream_id: string; seq: number | string; projection: AdminAccountState }[]>`SELECT stream_id,seq,projection FROM swarm.admin_accounts WHERE owner_user_id=${inviter}::uuid FOR UPDATE`;
    const grants = await tx`SELECT * FROM swarm.admin_grants WHERE owner_user_id=${inviter}::uuid ORDER BY grant_id FOR UPDATE`;
    const [bound] = await tx`SELECT parent_admin_grant_id FROM swarm.admin_routine_invitations WHERE invitation_id=${invitationId}::uuid`;
    const durable = grants.find(g => g.grant_id === bound?.parent_admin_grant_id);
    if (durable && account && account.projection.grants[String(durable.grant_id)]?.manifest_digest === durable.manifest_digest) grant = { ...account.projection.grants[String(durable.grant_id)], ...durable,
      expires_at: new Date(durable.expires_at as string).getTime(), refresh_deadline: new Date(durable.refresh_deadline as string).getTime() } as AdminGrant;
  }
  const [workspace] = await tx`SELECT name,archived_at FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid FOR UPDATE`;
  const [stream] = await tx`SELECT stream_id,head_seq FROM swarm.streams WHERE workspace_id=${workspaceId}::uuid AND kind='workspace' FOR UPDATE`;
  if (!workspace || !stream || workspace.archived_at !== null) return unavailable();
  const [invite] = delegated
    ? await tx`SELECT *,recipient_user_id AS accepted_by FROM swarm.admin_routine_invitations WHERE invitation_id=${invitationId}::uuid FOR UPDATE`
    : await tx`SELECT *,consumed_at AS accepted_at,consumed_by AS accepted_by FROM swarm.invitations WHERE invitation_id=${invitationId}::uuid FOR UPDATE`;
  if (!invite) return unavailable();
  const [member] = await tx`SELECT revoked_at FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid AND user_id=${human.user_id}::uuid FOR SHARE`;
  const [sender] = await tx`SELECT role,revoked_at FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid AND user_id=${inviter}::uuid FOR SHARE`;
  const [boundary] = await tx`SELECT purpose FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
  const audience = await tx`SELECT u.display_name,m.role FROM swarm.memberships m JOIN swarm.users u USING(user_id)
    WHERE m.workspace_id=${workspaceId}::uuid AND m.revoked_at IS NULL ORDER BY m.user_id LIMIT 25`;
  const [clock] = await tx`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now`;
  const now = Number(clock!.now), expiresAt = new Date(invite.expires_at as string).getTime();
  const previewDigest = await digest({ invitation_id: invitationId, workspace_id: workspaceId, name: workspace.name,
    head_seq: String(stream.head_seq), audience, purpose: boundary?.purpose ?? 'unconfirmed', expires_at: expiresAt,
    consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION });
  const created = grant ? await tx`SELECT grant_id,scope_names FROM swarm.admin_created_workspaces WHERE workspace_id=${workspaceId}::uuid` : [];
  const parentLive = !delegated || !!(grant && adminManifestValid(adminGrantManifest(grant), now, false) && grant.state === 'active' && grant.expires_at > now && grant.refresh_deadline > now &&
    !grant.withdrawn_workspace_ids.includes(workspaceId) && grant.target_rules.recipient_user_ids.includes(human.user_id) &&
    adminEffectiveCapabilities(grant, grant.scope_names).includes('admin_invite_member') &&
    (grant.workspace_ids.includes(workspaceId) || grant.workspace_selector === 'owned_and_selected' && sender?.role === 'owner' ||
      created[0]?.grant_id === grant.grant_id && (created[0].scope_names as string[]).includes('invites:create') && grant.created_workspace_policy.scope_names.includes('invites:create')));
  const facts: HumanInviteFacts = { human: true, identity_verified: human.verified,
    recipient_matches: delegated ? invite.recipient_user_id === human.user_id : !!human.email && String(invite.email).trim().toLowerCase() === human.email.trim().toLowerCase(),
    invitation_kind: delegated ? invite.invitation_kind as 'member' : 'member', role: delegated ? String((invite.projection as Record<string, unknown>).role) : String(invite.role),
    personal_boundary: boundary?.purpose !== 'shared', inviter_can_invite: !!sender && sender.revoked_at === null && ['owner','admin'].includes(String(sender.role)),
    parent_live: parentLive, now, expires_at: expiresAt, revoked_at: invite.revoked_at === null ? null : new Date(invite.revoked_at as string).getTime(),
    accepted_at: invite.accepted_at === null ? null : new Date(invite.accepted_at as string).getTime(), accepted_by: invite.accepted_by as string | null,
    user_id: human.user_id, member_live: !!member && member.revoked_at === null, preview_digest: previewDigest };
  const requestDigest = await digest(command.invitation.source === 'link' ? { ...command, invitation: { source: 'link', invitation_id: invitationId } } : command);
  const [prior] = await tx`SELECT request_hash,response FROM swarm.idempotency_keys WHERE principal_kind='user' AND principal_id=${human.user_id} AND command_id=${commandId}`;
  if (command.action === 'accept' && prior && prior.request_hash !== requestDigest) return { status: 409, body: { error: 'command_id_conflict' } };
  const decision = decideHumanInvite(command, facts) as HumanInviteDecision;
  if (decision.status === 'refused') return { status: decision.reason === 'review_changed' ? 409 : 403, body: decision };
  const [currentContent] = await tx`SELECT content_role FROM swarm.household_member_content_roles WHERE workspace_id=${workspaceId}::uuid AND user_id=${human.user_id}::uuid AND revoked_at IS NULL`;
  const receipt = { status: 'joined', workspace_id: workspaceId, workspace_name: String(workspace.name), invitation_id: invitationId,
    content_role: decision.status === 'join' && command.action === 'accept' ? command.content_role : currentContent?.content_role ?? null,
    agents_provisioned_by_join: false, next_action: 'Open the workspace. Create your own personal space if you want one. Authorize your own agents separately.' };
  if (decision.status === 'already_joined') return { status: 200, body: prior ? prior.response as Record<string, unknown> : receipt };
  if (decision.status === 'preview') return { status: 200, body: { status: 'preview', workspace_id: workspaceId, workspace_name: String(workspace.name),
    invitation_id: invitationId, audience, expires_at: expiresAt, disclosure: HOUSEHOLD_JOIN_DISCLOSURE, consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION, preview_digest: previewDigest } };
  if (command.action !== 'accept') throw new Error('join without consent');
  // No role elevation or adopted seat. Existing invitation count reserved this slot.
  await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role,invited_by,joined_at,revoked_at)
    VALUES(${workspaceId}::uuid,${human.user_id}::uuid,'member',${inviter}::uuid,${date(now)},NULL)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='member',invited_by=excluded.invited_by,joined_at=excluded.joined_at,revoked_at=NULL`;
  if (delegated) await tx`UPDATE swarm.admin_routine_invitations SET accepted_at=${date(now)} WHERE invitation_id=${invitationId}::uuid`;
  else await tx`UPDATE swarm.invitations SET consumed_at=${date(now)},consumed_by=${human.user_id}::uuid WHERE invitation_id=${invitationId}::uuid`;
  let seq = Number(stream.head_seq);
  const events = [ ...(!delegated ? [{ type: 'InvitationAccepted', payload: { invitation_id: invitationId, consumed_by: human.user_id, consumed_at: now } }] : []),
    { type: 'MemberJoined', payload: { user_id: human.user_id, role: 'member', invited_by: inviter, joined_at: now } } ];
  for (const event of events) await tx`INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,actor_agent_principal,actor_run,occurred_at_server,payload)
    VALUES(${workspaceId}::uuid,${String(stream.stream_id)}::uuid,${++seq},${crypto.randomUUID()}::uuid,${commandId},${event.type},1,${human.user_id}::uuid,NULL,NULL,${date(now)},${tx.json(event.payload)})`;
  await tx`UPDATE swarm.streams SET head_seq=${seq} WHERE stream_id=${String(stream.stream_id)}::uuid`;
  if (delegated && account && grant) {
    const event: AdminAccountEvent = { stream_kind: 'account',owner_user_id: inviter,stream_id: account.stream_id,seq: Number(account.seq)+1,
      event_id: crypto.randomUUID(),command_id: commandId,type: 'AdminMemberInvitationAccepted',schema_version: 1,actor_user: human.user_id,
      actor_agent_principal: null,actor_run: null,admin_identity_id: null,grant_id: grant.grant_id,grant_manifest_digest: grant.manifest_digest,
      occurred_at_server: now,payload: { invitation_id: invitationId, recipient_user_id: human.user_id, accepted_at: now } };
    const next = reduceAdminAuthority(account.projection, event);
    await tx`INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event) VALUES(${inviter}::uuid,${event.seq},${event.event_id}::uuid,${commandId},${tx.json(event as unknown as postgres.JSONValue)})`;
    await tx`UPDATE swarm.admin_accounts SET seq=${event.seq},projection=${tx.json(next as unknown as postgres.JSONValue)} WHERE owner_user_id=${inviter}::uuid`;
  }
  await tx`SELECT set_config('cswarm.household_actor',${human.user_id},true),set_config('cswarm.household_request',${commandId},true),set_config('cswarm.household_digest',${requestDigest},true)`;
  await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
    VALUES(${workspaceId}::uuid,${human.user_id}::uuid,${command.content_role},${crypto.randomUUID()}::uuid,${date(now)})
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET content_role=excluded.content_role,content_consent_id=excluded.content_consent_id,confirmed_at=excluded.confirmed_at,revoked_at=NULL`;
  await tx`INSERT INTO swarm.idempotency_keys(principal_kind,principal_id,command_id,workspace_id,stream_id,request_hash,response)
    VALUES('user',${human.user_id},${commandId},${workspaceId}::uuid,${String(stream.stream_id)}::uuid,${requestDigest},${tx.json(receipt)})`;
  return { status: 200, body: receipt };
}
