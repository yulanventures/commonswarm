import { type OrgRole, type OrgRosterMemberItem, type PrincipalKind, ORG_ROLE_LABELS, REVOCATION_SCOPE_DISCLOSURE } from './org-members-screen.js';
import { esc, dis, bdg, fld, inp, opt, rad, btn, act, fset, dlg, createOrgDialogsController, mountOrgDialogsController } from './approval-remedy-cards.js';
export { createOrgDialogsController, mountOrgDialogsController };
export type WorkspaceMoveTransferMode = 'all' | 'owners_only';
export type ChannelVisibility = 'workspace' | 'private';
export type ChannelRole = 'owner' | 'member';
export type NotifyPref = 'all' | 'mentions' | 'mute';
export type ChannelIcon = '#' | 'lock' | 'bolt' | 'shield' | 'book' | 'hash' | 'spark';
export const LOGO_RENDITION_SIZES = [64, 128, 256] as const;
export const LOGO_MAX_BYTES = 1_048_576;
export const LOGO_ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
export const SVG_STATIC_GEOMETRY_ALLOWLIST = 'svg,g,path,rect,circle,ellipse,line,polyline,polygon,defs,lineargradient,radialgradient,stop,clippath,title,desc'.split(',');
const ALLOWED_SVG_TAGS = new Set<string>(SVG_STATIC_GEOMETRY_ALLOWLIST);
export const CHANNEL_ICON_OPTIONS: ReadonlyArray<{ id: ChannelIcon; label: string }> = [
 { id: '#', label: '# Hash' }, { id: 'lock', label: 'Lock' }, { id: 'bolt', label: 'Bolt' }, { id: 'shield', label: 'Shield' }, { id: 'book', label: 'Book' },
];
export const NOTIFY_PREF_OPTIONS: ReadonlyArray<{ id: NotifyPref; label: string; description: string }> = [
 { id: 'all', label: 'All activity', description: 'Every message and signal in this channel' },
 { id: 'mentions', label: 'Mentions & replies', description: 'Direct @mentions, replies, and approvals' },
 { id: 'mute', label: 'Mute channel', description: 'No push or badge wakes' },
];
const UNSAFE_SVG_RE = /<\/?[a-z0-9_-]+:|(?:^|[\s"'/])[a-z0-9_-]+:[a-z0-9_-]+\s*=|\bxmlns\s*=\s*(?!(?:"http:\/\/www\.w3\.org\/2000\/svg"|'http:\/\/www\.w3\.org\/2000\/svg'))|<\s*\/?\s*(?:script|foreignobject|iframe|object|embed|image|use|animate|set|handler|listener)\b|(?:^|[\s"'/])(?:on[a-z]+|href)\s*=|xlink:href|javascript:|data:|@import|url\s*\(|=\s*(?:"[^"]*(?:&#|&[a-z0-9]+;)[^"]*"|'[^']*(?:&#|&[a-z0-9]+;)[^']*'|[^\s>]*?(?:&#|&[a-z0-9]+;))|<![a-z[]|<\?/i;
export const isTypedDeleteMatch = (e: string, t: string): boolean => Boolean(e.trim() && t.trim() === e.trim());
export function validateOrgLogoUpload(i: { actorRole: OrgRole; mimeType: string; sizeBytes: number; svgText?: string }): { ok: boolean; error?: string; sanitizedSvg?: string } {
 if (i.actorRole !== 'owner' && i.actorRole !== 'admin') return { ok: false, error: 'ORG_LOGO_REQUIRES_ADMIN_OR_OWNER' };
 if (!LOGO_ALLOWED_MIMES.includes(i.mimeType as (typeof LOGO_ALLOWED_MIMES)[number])) return { ok: false, error: 'UNSUPPORTED_LOGO_MIME_TYPE' };
 if (i.sizeBytes <= 0 || i.sizeBytes > LOGO_MAX_BYTES) return { ok: false, error: 'LOGO_EXCEEDS_1MB_LIMIT' };
 if (i.mimeType !== 'image/svg+xml') return { ok: true };
 const raw = (i.svgText ?? '').trim(), tags = [...raw.matchAll(/<\/?([a-zA-Z0-9_-]+)/g)].map((m) => m[1]!.toLowerCase());
 if (!raw || UNSAFE_SVG_RE.test(raw) || !tags.includes('svg')) return { ok: false, error: 'Unsafe SVG content refused' };
 return tags.every((t) => ALLOWED_SVG_TAGS.has(t)) ? { ok: true, sanitizedSvg: raw } : { ok: false, error: 'Disallowed SVG element' };
}
interface WsCtx { org_slug: string; workspace_slug: string; workspace_name: string; }
export interface WorkspaceMembersPanelProps extends WsCtx { workspace_id: string; actor_role: OrgRole; workspace_members: OrgRosterMemberItem[]; org_candidates: OrgRosterMemberItem[]; selected_candidate_id?: string; }
export function renderWorkspaceMembersPanel(p: WorkspaceMembersPanelProps): string {
 const can = p.actor_role === 'owner' || p.actor_role === 'admin', selId = p.selected_candidate_id ?? p.org_candidates[0]?.principal_id;
 const rows = p.workspace_members.map((m) => {
  const ag = m.principal_kind === 'agent';
  return `<div class="ws-member-row" data-member-id="${esc(m.principal_id)}"><span class="avatar ${ag ? 'agent' : ''} small">${esc(m.initials)}</span><div class="ws-member-copy"><strong>${esc(m.display_name)} ${bdg(ag ? 'Agent' : 'Person')} ${bdg(esc(ORG_ROLE_LABELS[m.role]))}</strong><small class="meta">${esc(m.handle)}${ag ? ` · ${m.active_seat_id ? `Active seat ${esc(m.active_seat_id)} (closes immediately on removal)` : 'No active seat'}` : ''}</small></div><button type="button" class="button danger" data-action="ws-remove-member" data-member-id="${esc(m.principal_id)}" ${dis(!can)}>Remove</button></div>`; }).join('');
 const opts = p.org_candidates.map((c) => opt(c.principal_id, c.principal_id === selId, `${esc(c.display_name)} (${c.principal_kind === 'agent' ? 'Agent' : 'Person'})`)).join('');
 return `<section class="spec-card ws-members-panel" data-workspace-slug="${esc(p.workspace_slug)}" aria-label="Workspace members"><div class="dialog-heading"><h2>Workspace Members · ${esc(p.workspace_name)}</h2>${bdg(`${p.workspace_members.length} assigned`)}</div><div class="ws-add-bar sample-row"><select id="ws-candidate-select" name="ws_candidate_id" class="ws-select" ${dis(!can || !opts)}>${opts || '<option value="">All org members in workspace</option>'}</select>${btn('primary', 'ws-add-member', '+ Add to workspace', !can || !opts)}</div><div class="ws-member-list">${rows}</div><div class="notice" role="note"><strong>Agent seat cascade</strong><p>${esc(REVOCATION_SCOPE_DISCLOSURE)}.</p></div></section>`;
}
export interface CreateWorkspaceModalProps extends WsCtx { org_id?: string; org_name?: string; organizations?: Array<{ org_id: string; slug: string; display_name: string }>; actor_role?: OrgRole; }
export function renderCreateWorkspaceModal(p: CreateWorkspaceModalProps): string {
 const orgs = p.organizations?.length ? p.organizations : [{ org_id: p.org_id ?? 'org-1', slug: p.org_slug, display_name: p.org_name ?? p.org_slug }];
 const sel = orgs.find((o) => o.slug === p.org_slug || (p.org_id && o.org_id === p.org_id)) ?? orgs[0]!, orgSlug = sel.slug || p.org_slug || 'org';
 const can = !p.actor_role || p.actor_role === 'owner' || p.actor_role === 'admin';
 const orgOpts = orgs.map((o) => opt(o.slug, o.slug === orgSlug, `${esc(o.display_name)} (${esc(o.slug)})`)).join('');
 return dlg('create-workspace', 'Create Workspace', bdg('org_create_workspace'), `${fld('Organization', `<select name="org_slug" ${dis(!can)}>${orgOpts}</select>`)}${fld('Workspace name', inp('workspace_name', p.workspace_name, !can))}${fld('Workspace slug (<code>[a-z0-9-]</code>)', inp('workspace_slug', p.workspace_slug, !can, ' pattern="[a-z0-9-]+"'))}<div class="notice" role="note"><strong>Default channel</strong><p>Provisions default <code>#general</code> channel automatically.</p><code>${esc(`cswarm workspace create ${p.workspace_slug || 'new-workspace'} --org ${orgSlug}`)}</code></div>${act(btn('primary', 'submit-create-workspace', 'Create workspace', !can))}`, ' aria-label="Create workspace"');
}
export interface WorkspaceMoveModalProps { workspace_id: string; workspace_slug: string; workspace_name: string; source_org_id: string; source_org_slug: string; source_org_name: string; target_orgs: Array<{ org_id: string; slug: string; display_name: string; actor_is_owner: boolean }>; selected_target_org_id: string; transfer_members: WorkspaceMoveTransferMode; affected_non_owner_count: number; affected_agent_seat_count: number; }
export function renderWorkspaceMoveModal(p: WorkspaceMoveModalProps): string {
 const t = p.target_orgs.find((o) => o.org_id === p.selected_target_org_id) ?? p.target_orgs[0], ok = Boolean(t?.actor_is_owner);
 const cli = `cswarm workspace move ${p.source_org_slug}/${p.workspace_slug} --to-org ${t?.slug ?? 'target-org'} --transfer-members ${p.transfer_members}`;
 const opts = p.target_orgs.map((o) => opt(o.org_id, o.org_id === p.selected_target_org_id, `${esc(o.display_name)} (${esc(o.slug)})`)).join('');
 return dlg('move-workspace', `Move Workspace · ${esc(p.workspace_name)}`, bdg('org_move_workspace'), `${fld('Destination organization', `<select id="move-ws-target-org" name="move_ws_target_org">${opts}</select>`)}${fset('Member &amp; agent transfer policy (<code>transfer_members</code>)', `${rad('transfer_members', 'all', p.transfer_members === 'all', '<strong>Transfer all (<code>all</code>)</strong> — grants destination org memberships and keeps grants &amp; seats.')}${rad('transfer_members', 'owners_only', p.transfer_members === 'owners_only', '<strong>Transfer owners only (<code>owners_only</code>)</strong> — only destination Owners keep access.')}`)}<div class="notice" role="alert" data-move-warning="true"><strong>Non-transferred principals lose grants &amp; active seats immediately</strong><p>Non-transferred principals (${p.affected_non_owner_count} principals, ${p.affected_agent_seat_count} active seats) lose grants and active seats; history is preserved.</p><code>${esc(cli)}</code></div>${!ok ? '<p class="dialog-error" role="alert">ORG_MOVE_REQUIRES_DUAL_OWNER</p>' : ''}${act(btn('primary', 'submit-move-workspace', 'Move workspace', !ok))}`, ' aria-label="Move workspace"');
}
export interface OrganizationCrudModalProps { mode: 'create' | 'rename' | 'delete'; org_id?: string; org_slug: string; org_name: string; initial_workspace_name?: string; actor_role: OrgRole; typed_delete_input?: string; }
export function renderOrganizationCrudModal(p: OrganizationCrudModalProps): string {
 const canDel = p.actor_role === 'owner', canEdit = canDel || p.actor_role === 'admin', delOk = isTypedDeleteMatch(p.org_name, p.typed_delete_input ?? '');
 const title = p.mode === 'create' ? 'Create Organization' : p.mode === 'rename' ? `Rename ${esc(p.org_name)}` : `Delete ${esc(p.org_name)}`;
 const body = p.mode === 'delete'
  ? `<div class="typed-delete-box">${fld(`Type <code>${esc(p.org_name)}</code> to confirm delete`, inp('typed_delete_input', p.typed_delete_input ?? '', !canDel, ` data-delete-confirm-target="${esc(p.org_name)}"`))}${act(btn('primary danger', 'confirm-delete-org', 'Delete organization', !canDel || !delOk))}</div>`
  : `${fld('Organization display name', inp('org_display_name', p.org_name, p.mode === 'rename' && !canEdit))}${fld('Organization slug (<code>[a-z0-9-]</code>)', inp('org_slug', p.org_slug, p.mode === 'rename' && !canEdit, ' pattern="[a-z0-9-]+"'))}${p.mode === 'create' ? `${fld('Initial workspace name', inp('initial_workspace_name', p.initial_workspace_name ?? 'General'))}${act(btn('primary', 'submit-create-org', 'Create organization'))}` : act(btn('primary', 'submit-rename-org', 'Save changes', !canEdit))}`;
 return dlg('org-crud', title, '', body, ` data-org-crud-mode="${esc(p.mode)}"`);
}
export interface OrgLogoUploadModalProps { org_id: string; org_slug: string; org_name: string; actor_role: OrgRole; current_logo_key?: string | null; upload_error?: string | null; sanitized_svg?: string | null; }
export function renderOrgLogoUploadModal(p: OrgLogoUploadModalProps): string {
 const can = p.actor_role === 'owner' || p.actor_role === 'admin', init = (p.org_name.trim()[0] || 'O').toUpperCase();
 const prev = LOGO_RENDITION_SIZES.map((px) => `<div class="logo-rendition-box" data-rendition-size="${px}"><div class="logo-rendition-frame">${esc(init)}</div><small class="meta">${px}×${px}px</small><code>orgs/${esc(p.org_id)}/logo/${px}.webp</code></div>`).join('');
 return dlg('org-logo-upload', `Organization Logo · ${esc(p.org_name)}`, bdg('64 / 128 / 256px'), `<div class="logo-dropzone"><strong>Drop PNG, JPEG, WebP, or SVG (&lt;= 1 MB)</strong><input type="file" name="org_logo_file" accept="image/png,image/jpeg,image/webp,image/svg+xml" ${dis(!can)}></div><p class="dialog-error" data-logo-error="true" role="alert" ${p.upload_error ? '' : 'hidden'}>${esc(p.upload_error ?? '')}</p><div class="logo-rendition-grid">${prev}</div>${act(btn('primary', 'submit-logo-upload', 'Save organization logo', !can || Boolean(p.upload_error)))}`);
}
export interface CreateChannelModalProps extends WsCtx { step: 1 | 2 | 3; private_channels_enabled: boolean; visibility: ChannelVisibility; channel_slug: string; channel_name?: string; channel_icon?: ChannelIcon; topic: string; guidelines: string; available_principals: Array<{ principal_id: string; principal_kind: PrincipalKind; display_name: string; role: OrgRole }>; selected_principal_ids: string[]; }
export function renderCreateChannelModal(p: CreateChannelModalProps): string {
 const isPriv = p.visibility === 'private', selIcon = p.channel_icon ?? (isPriv ? 'lock' : '#'), canCreate = p.step === 3 && (p.visibility === 'workspace' || p.private_channels_enabled);
 const privBadge = `<span class="badge${p.private_channels_enabled ? ' good' : ''}" data-private-gate="${p.private_channels_enabled ? 'enabled' : 'disabled'}">PRIVATE_CHANNELS_ENABLED: ${p.private_channels_enabled ? 'true' : 'false (fail-closed)'}</span>`;
 const steps = ([[1, '1. Visibility'], [2, '2. Name & Guidelines'], [3, '3. Members & Agents']] as const).map(([n, l]) => `<button type="button" class="step-pill ${p.step === n ? 'active' : ''}" data-step-indicator="${n}" aria-current="${p.step === n ? 'step' : 'false'}">${esc(l)}</button>`).join('');
 const iconOpts = CHANNEL_ICON_OPTIONS.map((ic) => opt(ic.id, selIcon === ic.id, esc(ic.label))).join('');
 const checklist = p.available_principals.map((m) => `<label class="check-field"><input type="checkbox" name="channel_member_id" value="${esc(m.principal_id)}" ${p.selected_principal_ids.includes(m.principal_id) ? 'checked' : ''}><span>${esc(m.display_name)} (${m.principal_kind === 'agent' ? 'Agent' : 'Person'})</span></label>`).join('');
 const pane = (n: number, b: string) => `<fieldset class="channel-step-pane" data-step-pane="${n}" ${p.step !== n ? 'hidden' : ''}>${b}</fieldset>`;
 const vopt = (v: string, s: boolean, t: string, m = '', d = false) => `<label class="visibility-option ${s ? 'selected' : ''}"><input type="radio" name="channel_visibility" value="${v}" ${s ? 'checked' : ''} ${dis(d)}><div><strong>${t}</strong>${m}</div></label>`;
 return dlg('create-channel', `Create Channel in ${esc(p.workspace_name)}`, privBadge, `<div class="step-progress">${steps}</div>${pane(1, `${vopt('workspace', !isPriv, '# Public Workspace Channel (<code>visibility="workspace"</code>)')}${vopt('private', isPriv, 'Lock Private Channel (<code>visibility="private"</code>)', '<p class="meta">Joined-room boundary: only invited members/agents can read messages, files, search, or wakes.</p>', !p.private_channels_enabled)}<div class="notice" role="note" data-private-channel-rules="true"><p>Private channels require an explicit channel <code>owner</code> invite and cannot flip to public later (<code>PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC</code>). Non-empty public channels cannot flip to private in-place (<code>CHANNEL_HAS_PUBLIC_HISTORY</code>).</p></div>`)}${pane(2, `${fld('Channel icon (<code>channel_icon</code>)', `<select name="channel_icon">${iconOpts}</select>`)}${fld('Channel name', inp('channel_slug', p.channel_name ?? p.channel_slug))}${fld('Topic', inp('channel_topic', p.topic))}${fld('Guidelines / Purpose', `<textarea name="channel_guidelines" rows="2">${esc(p.guidelines)}</textarea>`)}`)}${pane(3, `<div class="channel-initial-members">${checklist}</div><code data-channel-cli-preview="true">cswarm channel create ${esc(p.channel_slug || 'new-channel')} --workspace ${esc(p.org_slug)}/${esc(p.workspace_slug)} --visibility ${esc(p.visibility)}</code>`)}${act(`${btn('', 'prev-channel-step', 'Back', p.step === 1)}${p.step < 3 ? btn('primary', 'next-channel-step', 'Next step') : ''}${btn(p.step === 3 ? 'primary' : '', 'submit-create-channel', 'Create channel', !canCreate)}`)}`, ` data-current-step="${p.step}"`);
}
export interface ChannelMembersModalProps { org_slug: string; workspace_slug: string; channel_id: string; channel_slug: string; visibility: ChannelVisibility; actor_channel_role: ChannelRole | null; actor_org_role: OrgRole; notify_pref: NotifyPref; members: Array<{ principal_id: string; principal_kind: PrincipalKind; display_name: string; channel_role: ChannelRole; notify_pref: NotifyPref }>; typed_delete_input?: string; invite_handle?: string; }
export function renderChannelMembersModal(p: ChannelMembersModalProps): string {
const isPriv = p.visibility === 'private', canInvite = !isPriv || p.actor_channel_role === 'owner', delOk = isTypedDeleteMatch(p.channel_slug, p.typed_delete_input ?? '');
 const radios = NOTIFY_PREF_OPTIONS.map((o) => rad('channel_notify_pref', o.id, p.notify_pref === o.id, `<strong>${esc(o.label)} (<code>${o.id}</code>)</strong> — ${esc(o.description)}`)).join('');
 const rows = p.members.map((m) => `<div class="ws-member-row"><span><strong>${esc(m.display_name)}</strong> ${bdg(esc(m.channel_role))}</span><small class="meta">Notify: ${esc(m.notify_pref)}</small></div>`).join('');
 return dlg('channel-members-prefs', `${isPriv ? 'Lock' : '#'} ${esc(p.channel_slug)} · Members &amp; Notifications`, '', `${fset('Notification preference (<code>all | mentions | mute</code>)', radios)}<div class="ws-member-list">${rows}</div><div class="ws-add-bar sample-row">${inp('channel_invite_handle', p.invite_handle ?? '', !canInvite, ' id="channel-invite-input" placeholder="Person or agent handle"')}${btn('primary', 'channel-invite-submit', 'Invite to channel', !canInvite)}</div>${isPriv && !canInvite ? `<p class="dialog-error" role="alert" data-private-owner-gate="blocked">PRIVATE_CHANNEL_OWNER_REQUIRED: Only a live channel <code>owner</code> can invite to a private channel (org role <code>${esc(p.actor_org_role)}</code> cannot self-join or invite).</p>` : ''}<div class="typed-delete-box">${fld(`Type <code>${esc(p.channel_slug)}</code> to confirm delete`, inp('typed_delete_input', p.typed_delete_input ?? '', false, ` data-delete-confirm-target="${esc(p.channel_slug)}"`))}${btn('primary danger', 'confirm-delete-channel', `Delete #${esc(p.channel_slug)}`, !delOk)}</div>`);
}
