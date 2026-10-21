import {
  type OrgRole,
  type OrgRosterMemberItem,
  type PrincipalKind,
  ORG_ROLE_LABELS,
  REVOCATION_SCOPE_DISCLOSURE,
} from './org-members-screen.js';

export type WorkspaceMoveTransferMode = 'all' | 'owners_only';
export type ChannelVisibility = 'workspace' | 'private';
export type ChannelRole = 'owner' | 'member';
export type NotifyPref = 'all' | 'mentions' | 'mute';

export const LOGO_RENDITION_SIZES = [64, 128, 256] as const;
export const LOGO_MAX_BYTES = 1_048_576;
export const LOGO_ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;

export const NOTIFY_PREF_OPTIONS: ReadonlyArray<{ id: NotifyPref; label: string; description: string }> = [
  { id: 'all', label: 'All activity', description: 'Every message and signal in this channel' },
  { id: 'mentions', label: 'Mentions & replies', description: 'Direct @mentions, replies, and approvals' },
  { id: 'mute', label: 'Mute channel', description: 'No push or badge wakes' },
] as const;

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

export function isTypedDeleteMatch(expectedName: string, typedValue: string): boolean {
  const exp = expectedName.trim();
  return exp.length > 0 && typedValue.trim() === exp;
}

export function validateOrgLogoUpload(input: {
  actorRole: OrgRole;
  mimeType: string;
  sizeBytes: number;
  svgText?: string;
}): { ok: boolean; error?: string; sanitizedSvg?: string } {
  if (input.actorRole !== 'owner' && input.actorRole !== 'admin') {
    return { ok: false, error: 'ORG_LOGO_REQUIRES_ADMIN_OR_OWNER' };
  }
  if (!LOGO_ALLOWED_MIMES.includes(input.mimeType as (typeof LOGO_ALLOWED_MIMES)[number])) {
    return { ok: false, error: 'UNSUPPORTED_LOGO_MIME_TYPE' };
  }
  if (input.sizeBytes <= 0 || input.sizeBytes > LOGO_MAX_BYTES) {
    return { ok: false, error: 'LOGO_EXCEEDS_1MB_LIMIT' };
  }
  if (input.mimeType === 'image/svg+xml' && input.svgText != null) {
    const sanitized = input.svgText
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(?:href|xlink:href)\s*=\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*')/gi, '');
    return { ok: true, sanitizedSvg: sanitized };
  }
  return { ok: true };
}

export interface WorkspaceMembersPanelProps {
  org_slug: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  actor_role: OrgRole;
  workspace_members: OrgRosterMemberItem[];
  org_candidates: OrgRosterMemberItem[];
}

export function renderWorkspaceMembersPanel(props: WorkspaceMembersPanelProps): string {
  const canManage = props.actor_role === 'owner' || props.actor_role === 'admin';
  const rows = props.workspace_members
    .map((m) => {
      const isAgent = m.principal_kind === 'agent';
      return `<div class="ws-member-row" data-member-id="${esc(m.principal_id)}">
        <span class="avatar ${isAgent ? 'agent' : ''} small">${esc(m.initials)}</span>
        <div class="ws-member-copy">
          <strong>${esc(m.display_name)} <span class="badge">${isAgent ? 'Agent' : 'Person'}</span> <span class="badge">${esc(ORG_ROLE_LABELS[m.role])}</span></strong>
          <small class="meta">${esc(m.handle)}${isAgent ? ` · ${m.active_seat_id ? `Active seat ${esc(m.active_seat_id)} (closes immediately on removal)` : 'No active seat'}` : ''}</small>
        </div>
        <button type="button" class="button danger" data-action="ws-remove-member" data-member-id="${esc(m.principal_id)}" ${!canManage ? 'disabled' : ''}>Remove</button>
      </div>`;
    })
    .join('');
  const opts = props.org_candidates
    .map((c) => `<option value="${esc(c.principal_id)}">${esc(c.display_name)} (${c.principal_kind === 'agent' ? 'Agent' : 'Person'})</option>`)
    .join('');

  return `<section class="spec-card ws-members-panel" data-workspace-slug="${esc(props.workspace_slug)}" aria-label="Workspace members">
    <div class="dialog-heading"><h2>Workspace Members · ${esc(props.workspace_name)}</h2><span class="badge">${props.workspace_members.length} assigned</span></div>
    <div class="ws-add-bar sample-row">
      <select id="ws-candidate-select" class="ws-select" ${!canManage || !opts ? 'disabled' : ''}>${opts || '<option value="">All org members in workspace</option>'}</select>
      <button type="button" class="button primary" data-action="ws-add-member" ${!canManage || !opts ? 'disabled' : ''}>+ Add to workspace</button>
    </div>
    <div class="ws-member-list">${rows}</div>
    <div class="notice" role="note"><strong>Agent seat cascade</strong><p>${esc(REVOCATION_SCOPE_DISCLOSURE)}.</p></div>
  </section>`;
}

export interface WorkspaceMoveModalProps {
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  source_org_id: string;
  source_org_slug: string;
  source_org_name: string;
  target_orgs: Array<{ org_id: string; slug: string; display_name: string; actor_is_owner: boolean }>;
  selected_target_org_id: string;
  transfer_members: WorkspaceMoveTransferMode;
  affected_non_owner_count: number;
  affected_agent_seat_count: number;
}

export function renderWorkspaceMoveModal(props: WorkspaceMoveModalProps): string {
  const target = props.target_orgs.find((o) => o.org_id === props.selected_target_org_id) ?? props.target_orgs[0];
  const targetSlug = target?.slug ?? 'target-org';
  const dualOwnerOk = Boolean(target?.actor_is_owner);
  const cliCmd = `cswarm workspace move ${props.source_org_slug}/${props.workspace_slug} --to-org ${targetSlug} --transfer-members ${props.transfer_members}`;
  const orgOpts = props.target_orgs
    .map((o) => `<option value="${esc(o.org_id)}" ${o.org_id === props.selected_target_org_id ? 'selected' : ''}>${esc(o.display_name)} (${esc(o.slug)})</option>`)
    .join('');

  return `<section class="spec-card dialog-surface" data-dialog="move-workspace" aria-label="Move workspace">
    <div class="dialog-heading"><h2>Move Workspace · ${esc(props.workspace_name)}</h2><span class="badge">org_move_workspace</span></div>
    <label class="field">Destination organization<select id="move-ws-target-org">${orgOpts}</select></label>
    <fieldset class="transfer-fieldset">
      <legend>Member &amp; agent transfer policy (<code>transfer_members</code>)</legend>
      <label class="check-field"><input type="radio" name="transfer_members" value="all" ${props.transfer_members === 'all' ? 'checked' : ''}><span><strong>Transfer all (<code>all</code>)</strong> — grants destination org memberships and keeps grants &amp; seats.</span></label>
      <label class="check-field"><input type="radio" name="transfer_members" value="owners_only" ${props.transfer_members === 'owners_only' ? 'checked' : ''}><span><strong>Transfer owners only (<code>owners_only</code>)</strong> — only destination Owners keep access.</span></label>
    </fieldset>
    <div class="notice" role="alert" data-move-warning="true">
      <strong>Non-transferred principals lose grants &amp; active seats immediately</strong>
      <p>Non-transferred members/agents (${props.affected_non_owner_count} principals, ${props.affected_agent_seat_count} active seats) lose workspace/channel grants and active seats in this workspace; history is preserved.</p>
      <code>${esc(cliCmd)}</code>
    </div>
    ${!dualOwnerOk ? '<p class="dialog-error" role="alert">ORG_MOVE_REQUIRES_DUAL_OWNER</p>' : ''}
    <div class="actions"><button type="button" class="button primary" data-action="submit-move-workspace" ${!dualOwnerOk ? 'disabled' : ''}>Move workspace</button></div>
  </section>`;
}

export interface OrganizationCrudModalProps {
  mode: 'create' | 'rename' | 'delete';
  org_id?: string;
  org_slug: string;
  org_name: string;
  actor_role: OrgRole;
  typed_delete_input?: string;
}

export function renderOrganizationCrudModal(props: OrganizationCrudModalProps): string {
  const canDelete = props.actor_role === 'owner';
  const canEdit = props.actor_role === 'owner' || props.actor_role === 'admin';
  const deleteMatches = isTypedDeleteMatch(props.org_name, props.typed_delete_input ?? '');
  return `<section class="spec-card dialog-surface" data-dialog="org-crud" data-org-crud-mode="${esc(props.mode)}">
    <div class="dialog-heading"><h2>${props.mode === 'create' ? 'Create Organization' : props.mode === 'rename' ? `Rename ${esc(props.org_name)}` : `Delete ${esc(props.org_name)}`}</h2></div>
    <label class="field">Organization name<input type="text" value="${esc(props.org_name)}" ${!canEdit && props.mode !== 'create' ? 'disabled' : ''}></label>
    <label class="field">Organization slug<input type="text" value="${esc(props.org_slug)}" ${!canEdit && props.mode !== 'create' ? 'disabled' : ''}></label>
    <div class="typed-delete-box">
      <label class="field">Type <code>${esc(props.org_name)}</code> to confirm delete<input type="text" value="${esc(props.typed_delete_input ?? '')}"></label>
      <button type="button" class="button primary danger" data-action="confirm-delete-org" ${!canDelete || !deleteMatches ? 'disabled' : ''}>Delete Organization</button>
    </div>
  </section>`;
}

export interface OrgLogoUploadModalProps {
  org_id: string;
  org_slug: string;
  org_name: string;
  actor_role: OrgRole;
  current_logo_key?: string | null;
}

export function renderOrgLogoUploadModal(props: OrgLogoUploadModalProps): string {
  const canUpload = props.actor_role === 'owner' || props.actor_role === 'admin';
  const initial = (props.org_name.trim()[0] || 'O').toUpperCase();
  const previews = LOGO_RENDITION_SIZES.map(
    (px) => `<div class="logo-rendition-box" data-rendition-size="${px}"><div class="logo-rendition-frame">${esc(initial)}</div><small class="meta">${px}×${px}px</small><code>orgs/${esc(props.org_id)}/logo/${px}.webp</code></div>`,
  ).join('');
  return `<section class="spec-card dialog-surface" data-dialog="org-logo-upload">
    <div class="dialog-heading"><h2>Organization Logo · ${esc(props.org_name)}</h2><span class="badge">64 / 128 / 256px</span></div>
    <div class="logo-dropzone"><strong>Drop PNG, JPEG, WebP, or SVG (&lt;= 1 MB)</strong><input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" ${!canUpload ? 'disabled' : ''}></div>
    <div class="logo-rendition-grid">${previews}</div>
    <div class="actions"><button type="button" class="button primary" data-action="submit-logo-upload" ${!canUpload ? 'disabled' : ''}>Save organization logo</button></div>
  </section>`;
}

export interface CreateChannelModalProps {
  org_slug: string;
  workspace_slug: string;
  workspace_name: string;
  step: 1 | 2 | 3;
  private_channels_enabled: boolean;
  visibility: ChannelVisibility;
  channel_slug: string;
  channel_icon?: 'hash' | 'lock' | 'spark' | 'book';
  topic: string;
  guidelines: string;
  available_principals: Array<{ principal_id: string; principal_kind: PrincipalKind; display_name: string; role: OrgRole }>;
  selected_principal_ids: string[];
}

export function renderCreateChannelModal(props: CreateChannelModalProps): string {
  const isPrivate = props.visibility === 'private';
  const privBadge = props.private_channels_enabled
    ? '<span class="badge good" data-private-gate="enabled">PRIVATE_CHANNELS_ENABLED: true</span>'
    : '<span class="badge" data-private-gate="disabled">PRIVATE_CHANNELS_ENABLED: false (fail-closed)</span>';
  const steps = ([[1, '1. Visibility'], [2, '2. Name & Guidelines'], [3, '3. Members & Agents']] as const)
    .map(([n, label]) => `<span class="step-pill ${props.step === n ? 'active' : ''}" data-step-indicator="${n}">${esc(label)}</span>`)
    .join('');
  const checklist = props.available_principals
    .map((p) => `<label class="check-field"><input type="checkbox" value="${esc(p.principal_id)}" ${props.selected_principal_ids.includes(p.principal_id) ? 'checked' : ''}><span>${esc(p.display_name)} (${p.principal_kind === 'agent' ? 'Agent' : 'Person'})</span></label>`)
    .join('');

  return `<section class="spec-card dialog-surface" data-dialog="create-channel" data-current-step="${props.step}">
    <div class="dialog-heading"><h2>Create Channel in ${esc(props.workspace_name)}</h2>${privBadge}</div>
    <div class="step-progress">${steps}</div>
    <div class="channel-step-pane" data-step-pane="1" ${props.step !== 1 ? 'hidden' : ''}>
      <label class="visibility-option ${!isPrivate ? 'selected' : ''}"><input type="radio" name="channel_visibility" value="workspace" ${!isPrivate ? 'checked' : ''}><div><strong># Public Workspace Channel (<code>visibility="workspace"</code>)</strong></div></label>
      <label class="visibility-option ${isPrivate ? 'selected' : ''}"><input type="radio" name="channel_visibility" value="private" ${isPrivate ? 'checked' : ''} ${!props.private_channels_enabled ? 'disabled' : ''}><div><strong>Lock Private Channel (<code>visibility="private"</code>)</strong><p class="meta">Joined-room boundary: only invited members/agents can read messages, files, search, or wakes.</p></div></label>
      <div class="notice" role="note" data-private-channel-rules="true">
        <p>Private channels require an explicit channel <code>owner</code> invite and cannot flip to public later (<code>PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC</code>). Non-empty public channels cannot flip to private in-place (<code>CHANNEL_HAS_PUBLIC_HISTORY</code>).</p>
      </div>
    </div>
    <div class="channel-step-pane" data-step-pane="2" ${props.step !== 2 ? 'hidden' : ''}>
      <label class="field">Channel slug<input type="text" value="${esc(props.channel_slug)}"></label>
      <label class="field">Guidelines &amp; topic<textarea rows="2">${esc(props.guidelines || props.topic)}</textarea></label>
    </div>
    <div class="channel-step-pane" data-step-pane="3" ${props.step !== 3 ? 'hidden' : ''}>
      <div class="channel-initial-members">${checklist}</div>
      <code>cswarm channel create ${esc(props.channel_slug || 'new-channel')} --workspace ${esc(props.org_slug)}/${esc(props.workspace_slug)} --visibility ${esc(props.visibility)}</code>
    </div>
    <div class="actions">
      <button type="button" class="button" data-action="channel-step-back" ${props.step === 1 ? 'disabled' : ''}>Back</button>
      <button type="button" class="button" data-action="channel-step-next" ${props.step === 3 ? 'hidden' : ''}>Next</button>
      <button type="button" class="button primary" data-action="channel-create-submit" ${isPrivate && !props.private_channels_enabled ? 'disabled' : ''}>Create</button>
    </div>
  </section>`;
}

export interface ChannelMembersModalProps {
  org_slug: string;
  workspace_slug: string;
  channel_id: string;
  channel_slug: string;
  visibility: ChannelVisibility;
  actor_channel_role: ChannelRole | null;
  actor_org_role: OrgRole;
  notify_pref: NotifyPref;
  members: Array<{ principal_id: string; principal_kind: PrincipalKind; display_name: string; channel_role: ChannelRole; notify_pref: NotifyPref }>;
  typed_delete_input?: string;
}

export function renderChannelMembersModal(props: ChannelMembersModalProps): string {
  const isPrivate = props.visibility === 'private';
  const canInvite = !isPrivate || props.actor_channel_role === 'owner';
  const deleteMatches = isTypedDeleteMatch(props.channel_slug, props.typed_delete_input ?? '');
  const radios = NOTIFY_PREF_OPTIONS.map(
    (opt) => `<label class="check-field"><input type="radio" name="channel_notify_pref" value="${opt.id}" ${props.notify_pref === opt.id ? 'checked' : ''}><span><strong>${esc(opt.label)} (<code>${opt.id}</code>)</strong> — ${esc(opt.description)}</span></label>`,
  ).join('');
  const rows = props.members
    .map((m) => `<div class="ws-member-row"><span><strong>${esc(m.display_name)}</strong> <span class="badge">${esc(m.channel_role)}</span></span><small class="meta">Notify: ${esc(m.notify_pref)}</small></div>`)
    .join('');

  return `<section class="spec-card dialog-surface" data-dialog="channel-members-prefs">
    <div class="dialog-heading"><h2>${isPrivate ? 'Lock' : '#'} ${esc(props.channel_slug)} · Members &amp; Notifications</h2></div>
    <fieldset class="transfer-fieldset"><legend>Notification preference (<code>all | mentions | mute</code>)</legend>${radios}</fieldset>
    <div class="ws-member-list">${rows}</div>
    <div class="ws-add-bar sample-row">
      <input type="text" id="channel-invite-input" placeholder="Person or agent handle" ${!canInvite ? 'disabled' : ''}>
      <button type="button" class="button primary" data-action="channel-invite-submit" ${!canInvite ? 'disabled' : ''}>Invite to channel</button>
    </div>
    ${isPrivate && !canInvite ? `<p class="dialog-error" role="alert" data-private-owner-gate="blocked">PRIVATE_CHANNEL_OWNER_REQUIRED: Only a live channel <code>owner</code> can invite to a private channel (org role <code>${esc(props.actor_org_role)}</code> cannot self-join or invite).</p>` : ''}
    <div class="typed-delete-box">
      <label class="field">Type <code>${esc(props.channel_slug)}</code> to confirm delete<input type="text" value="${esc(props.typed_delete_input ?? '')}"></label>
      <button type="button" class="button primary danger" data-action="confirm-delete-channel" ${!deleteMatches ? 'disabled' : ''}>Delete #${esc(props.channel_slug)}</button>
    </div>
  </section>`;
}
