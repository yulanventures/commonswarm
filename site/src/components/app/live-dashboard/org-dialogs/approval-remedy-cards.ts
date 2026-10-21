import { type OrgMembersScreenProps, type OrgRosterFilter, renderOrgMembersScreen } from './org-members-screen.js';
import {
  type ChannelIcon, type ChannelMembersModalProps, type ChannelVisibility, type CreateChannelModalProps,
  type OrganizationCrudModalProps, renderChannelMembersModal, renderCreateChannelModal, renderOrganizationCrudModal,
} from './workspace-channel-dialogs.js';

export interface ApprovalCardData {
  approval_id: string; org_id: string; org_slug?: string; workspace_id?: string | null; workspace_slug?: string | null;
  channel_id?: string | null; channel_slug?: string | null; requested_by_agent_identity_id: string; agent_display_name?: string;
  owner_user_id: string; owner_display_name?: string; action_kind: string; action_summary?: string;
  target_scope: Record<string, unknown>; payload: Record<string, unknown>;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  decided_by?: string | null; decided_at?: string | null; expires_at?: string | null; created_at: string;
}
export type OrgApprovalRequest = ApprovalCardData;
export interface WorkspaceSelectorChoiceItem { org_id: string; org_slug: string; workspace_id: string; workspace_slug: string; selector: string; }
export interface RefusalRemedyData {
  code: string; missing: string;
  scope: { org?: string | null; workspace?: string | null; channel?: string | null; seat_id?: string | null };
  remedy_url: string; mcp_tool: string; cli_command: string; choices?: WorkspaceSelectorChoiceItem[];
}

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
export const dis = (c: boolean) => (c ? 'disabled' : '');
export const bdg = (t: string, c = '') => `<span class="badge${c ? ` ${c}` : ''}">${t}</span>`;
export const fld = (l: string, c: string) => `<label class="field">${l}${c}</label>`;
export const inp = (n: string, v: unknown, d = false, ex = '') => `<input type="text" name="${n}" value="${esc(v)}"${ex} ${dis(d)}>`;
export const opt = (v: unknown, s: boolean, t: string) => `<option value="${esc(v)}" ${s ? 'selected' : ''}>${t}</option>`;
export const rad = (n: string, v: string, c: boolean, h: string) => `<label class="check-field"><input type="radio" name="${n}" value="${v}" ${c ? 'checked' : ''}><span>${h}</span></label>`;
export const btn = (c: string, a: string, t: string, d = false) => `<button type="button" class="button${c ? ` ${c}` : ''}" data-action="${a}" ${dis(d)}>${t}</button>`;
export const act = (b: string) => `<div class="actions">${b}</div>`;
export const fset = (l: string, b: string) => `<fieldset class="transfer-fieldset"><legend>${l}</legend>${b}</fieldset>`;
export const dlg = (id: string, h2: string, b: string, body: string, ex = '') => `<dialog open aria-modal="true" aria-labelledby="dlg-title-${id}" class="spec-card dialog-surface" data-dialog="${id}"${ex}><div class="dialog-heading"><h2 id="dlg-title-${id}">${h2}</h2>${b}</div>${body}</dialog>`;

export const SAFE_REMEDY_URL_FALLBACK = 'https://commonswarm.com/app';
const ALLOWED_HTTPS_ORIGINS = new Set(['https://commonswarm.com', 'https://www.commonswarm.com']);

export function sanitizeRemedyUrl(raw: string): string {
  const t = String(raw ?? '').trim();
  if (!t) return SAFE_REMEDY_URL_FALLBACK;
  if (t.startsWith('/') && !t.startsWith('//') && !/[\u0000-\u001f\\]/.test(t)) return t;
  try {
    const u = new URL(t);
    if ((u.protocol === 'https:' && ALLOWED_HTTPS_ORIGINS.has(u.origin)) || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) return u.toString();
  } catch { /* fallback */ }
  return SAFE_REMEDY_URL_FALLBACK;
}
export function buildApprovalCliCommand(a: string | { approval_id: string }, d: 'approve' | 'reject' = 'approve'): string {
  const id = typeof a === 'string' ? a : a.approval_id;
  return d === 'approve' ? `cswarm org confirm ${id}` : `cswarm org confirm ${id} --reject`;
}
export function buildApprovalMcpCall(a: string | { approval_id: string }, decision: 'approve' | 'reject' = 'approve') {
  const approval_id = typeof a === 'string' ? a : a.approval_id, args = { approval_id, decision }, serialized = `org_confirm_action ${JSON.stringify(args)}`;
  return { mcp_tool: 'org_confirm_action' as const, arguments: args, serialized, toString: () => serialized };
}
function renderScopeAndPayloadDetails(card: ApprovalCardData): string {
  const m: Record<string, unknown> = { ...(card.target_scope ?? {}), ...(card.payload ?? {}) };
  const pName = m.principal_name ?? m.display_name, pId = m.principal_id ?? m.agent_identity_id ?? m.user_id ?? m.invite_email;
  const role = m.role ?? m.channel_role, targetOrg = m.target_org_slug ?? m.target_org_id ?? m.to_org, tm = m.transfer_members;
  const kv = (a: string, b: string) => `<span class="approval-kv" ${a}>${b}</span>`, pts: string[] = [];
  if (pName || pId) pts.push(kv('data-approval-subject="true"', `Principal: <strong>${pName && pId && pName !== pId ? `${esc(pName)} (<code>${esc(pId)}</code>)` : `<code>${esc(pName ?? pId)}</code>`}</strong>`));
  if (role) pts.push(kv(`data-approval-role="${esc(role)}"`, `Role: <span class="badge">${esc(role)}</span>`));
  if (targetOrg) pts.push(kv(`data-approval-target-org="${esc(targetOrg)}"`, `Destination org: <code>${esc(targetOrg)}</code>`));
  if (tm) pts.push(kv(`data-approval-transfer-mode="${esc(tm)}"`, `Transfer policy: <code>transfer_members=${esc(tm)}</code>`));
  const chips = Object.entries(m).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<code class="approval-kv-chip" data-kv-key="${esc(k)}">${esc(k)}=${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</code>`).join(' ');
  return `<dt>Subject &amp; permissions</dt><dd data-approval-subject-details="true">${pts.length ? pts.join(' · ') : 'Scoped organization action'}${chips ? `<div class="sample-row" style="margin-top:4px">${chips}</div>` : ''}</dd>`;
}

export function renderInlineApprovalCard(c: ApprovalCardData): string {
  const isP = c.state === 'pending', appCli = buildApprovalCliCommand(c.approval_id, 'approve'), rejCli = buildApprovalCliCommand(c.approval_id, 'reject'), mcp = buildApprovalMcpCall(c.approval_id, 'approve').toString();
  const orgS = c.org_slug ?? (c.target_scope?.org as string | undefined) ?? c.org_id, wsS = c.workspace_slug ?? (c.target_scope?.workspace as string | undefined) ?? c.workspace_id, chS = c.channel_slug ? `#${c.channel_slug}` : (c.target_scope?.channel as string | undefined) ?? c.channel_id;
  const loc = [orgS ? `org=${orgS}` : null, wsS ? `workspace=${wsS}` : null, chS ? `channel=${chS}` : null].filter(Boolean), pathStr = [orgS, wsS, chS].filter(Boolean).join(' / ');
  const bCls = c.state === 'approved' ? 'badge good' : c.state === 'rejected' ? 'badge danger-badge' : 'badge';
  return `<article class="spec-card approval-card" data-approval-id="${esc(c.approval_id)}" data-approval-state="${esc(c.state)}" aria-label="Owner approval request"><div class="dialog-heading"><div><h2>Owner Approval Request · <code>${esc(c.action_kind)}</code></h2><p class="meta">Requested by agent <strong>${esc(c.agent_display_name ?? c.requested_by_agent_identity_id)}</strong> (<code>${esc(c.requested_by_agent_identity_id)}</code>) on behalf of owner <strong>${esc(c.owner_display_name ?? c.owner_user_id)}</strong></p></div><span class="${bCls}" data-approval-status-badge="${esc(c.state)}">${esc(c.state.toUpperCase())}</span></div><dl class="approval-dl"><dt>Action</dt><dd>${esc(c.action_summary ?? c.action_kind)}</dd><dt>Location scope</dt><dd><code>${esc(pathStr)}</code> (${loc.map((p) => `<code>${esc(p)}</code>`).join(' · ')})</dd>${renderScopeAndPayloadDetails(c)}<dt>Approver required</dt><dd>Live Organization Owner (<code>${esc(c.owner_display_name ?? c.owner_user_id)}</code>)</dd><dt>Standing validity</dt><dd>${c.expires_at ? esc(c.expires_at) : 'No artificial session timeout · resolves on owner decision'}</dd></dl><div class="parity-command-box"><div class="parity-row"><span class="meta">Confirm via CLI</span><code data-approval-cli="${esc(c.approval_id)}">${esc(appCli)}</code><button type="button" class="button" data-copy-cmd="${esc(appCli)}">Copy CLI</button></div><div class="parity-row"><span class="meta">Confirm via MCP tool</span><code data-approval-mcp="${esc(c.approval_id)}">${esc(mcp)}</code><button type="button" class="button" data-copy-cmd="${esc(mcp)}">Copy MCP</button></div></div><div class="sample-row approval-actions"><button type="button" class="button primary" data-action="approve-request" data-approval-id="${esc(c.approval_id)}" ${!isP ? 'disabled' : ''}>Approve</button><button type="button" class="button danger" data-action="reject-request" data-approval-id="${esc(c.approval_id)}" data-reject-cli="${esc(rejCli)}" ${!isP ? 'disabled' : ''}>Reject</button></div></article>`;
}

export function renderActionableRefusalBanner(refusal: RefusalRemedyData): string {
  const safeRemedyUrl = sanitizeRemedyUrl(refusal.remedy_url);
  const scopeParts = [refusal.scope.org ? `org=${refusal.scope.org}` : null, refusal.scope.workspace ? `workspace=${refusal.scope.workspace}` : null, refusal.scope.channel ? `channel=${refusal.scope.channel}` : null, refusal.scope.seat_id ? `seat=${refusal.scope.seat_id}` : null].filter(Boolean).join(' · ');
  const choicesHtml = refusal.choices?.length ? `<div class="refusal-choices" data-refusal-choices="true"><small class="meta">Reachable qualified workspace selectors:</small><div class="sample-row">${refusal.choices.map((c) => `<button type="button" class="button" data-select-workspace-choice="${esc(c.selector)}" data-copy-cmd="${esc(c.selector)}"><code>${esc(c.selector)}</code></button>`).join('')}</div></div>` : '';
  return `<aside class="notice refusal-remedy-banner" role="alert" data-refusal-code="${esc(refusal.code)}" aria-label="Actionable refusal remedy"><div class="dialog-heading"><strong>Refused: <code>${esc(refusal.code)}</code> (missing: <code>${esc(refusal.missing)}</code>)</strong>${scopeParts ? `<span class="badge">${esc(scopeParts)}</span>` : ''}</div><p>Resolve in web UI: <a href="${esc(safeRemedyUrl)}" data-remedy-url="${esc(safeRemedyUrl)}">${esc(safeRemedyUrl)}</a></p><div class="parity-command-box"><div class="parity-row"><span class="meta">MCP tool remedy</span><code data-refusal-mcp="${esc(refusal.mcp_tool)}">${esc(refusal.mcp_tool)}</code><button type="button" class="button" data-copy-cmd="${esc(refusal.mcp_tool)}">Copy MCP tool</button></div><div class="parity-row"><span class="meta">CLI command remedy</span><code data-refusal-cli="${esc(refusal.cli_command)}">${esc(refusal.cli_command)}</code><button type="button" class="button" data-copy-cmd="${esc(refusal.cli_command)}">Copy CLI command</button></div></div>${choicesHtml}</aside>`;
}

export interface OrgDialogsMountNode {
  innerHTML?: string; parentElement?: OrgDialogsMountNode | null; name?: string; value?: string;
  getAttribute?(name: string): string | null; addEventListener?(type: string, listener: (ev: { target?: OrgDialogsMountNode | null; key?: string }) => void): void;
}
export interface OrgDialogsControllerState {
  members?: OrgMembersScreenProps; createChannel?: CreateChannelModalProps; orgCrud?: OrganizationCrudModalProps;
  channelMembers?: ChannelMembersModalProps; approvals?: ApprovalCardData[]; refusals?: RefusalRemedyData[]; lastCopiedCommand?: string | null;
}
export function createOrgDialogsController(initial: OrgDialogsControllerState) {
  const s: OrgDialogsControllerState = {
    ...initial,
    orgCrud: initial.orgCrud ? { ...initial.orgCrud, typed_delete_input: initial.orgCrud.typed_delete_input ?? '' } : undefined,
    channelMembers: initial.channelMembers ? { ...initial.channelMembers, typed_delete_input: initial.channelMembers.typed_delete_input ?? '' } : undefined,
    approvals: initial.approvals?.map((a) => ({ ...a })) ?? [],
    lastCopiedCommand: null,
  };
  let rootEl: OrgDialogsMountNode | null = null;
  const renderHtml = () => [
    s.members ? renderOrgMembersScreen(s.members) : '', s.createChannel ? renderCreateChannelModal(s.createChannel) : '',
    s.orgCrud ? renderOrganizationCrudModal(s.orgCrud) : '', s.channelMembers ? renderChannelMembersModal(s.channelMembers) : '',
    ...(s.approvals ?? []).map(renderInlineApprovalCard), ...(s.refusals ?? []).map(renderActionableRefusalBanner),
  ].filter(Boolean).join('\n');
  const up = () => { if (rootEl) rootEl.innerHTML = renderHtml(); return s; };
  const ctrl = {
    getState: () => s, renderToHtml: renderHtml,
    selectMember(id: string) { if (s.members) s.members = { ...s.members, selected_principal_id: id, pending_removal: null }; return up(); },
    setFilter(f: OrgRosterFilter) { if (s.members) s.members = { ...s.members, active_filter: f }; return up(); },
    requestRemoveFromOrg(scope: 'workspace' | 'organization' = 'organization') {
      if (s.members) s.members = { ...s.members, pending_removal: { principal_id: s.members.selected_principal_id ?? s.members.members[0]?.principal_id ?? '', scope } };
      return up();
    },
    cancelRemoveFromOrg() { if (s.members) s.members = { ...s.members, pending_removal: null }; return up(); },
    confirmRemoveFromOrg() {
      if (s.members?.pending_removal) {
        const next = s.members.members.filter((m: { principal_id: string }) => m.principal_id !== s.members!.pending_removal!.principal_id);
        s.members = { ...s.members, members: next, selected_principal_id: next[0]?.principal_id ?? null, pending_removal: null };
      }
      return up();
    },
    setChannelStep(step: 1 | 2 | 3) { if (s.createChannel) s.createChannel = { ...s.createChannel, step }; return up(); },
    updateChannelDraft(p: Partial<CreateChannelModalProps>) { if (s.createChannel) s.createChannel = { ...s.createChannel, ...p }; return up(); },
    setOrgDeleteInput(v: string) { if (s.orgCrud) s.orgCrud = { ...s.orgCrud, typed_delete_input: v }; return up(); },
    setChannelDeleteInput(v: string) { if (s.channelMembers) s.channelMembers = { ...s.channelMembers, typed_delete_input: v }; return up(); },
    decideApproval(id: string, d: 'approve' | 'reject') {
      const c = (s.approvals ?? []).find((a) => a.approval_id === id);
      if (c?.state === 'pending') c.state = d === 'approve' ? 'approved' : 'rejected';
      return up();
    },
    mount(root: OrgDialogsMountNode) {
      rootEl = root; up();
      if (typeof root.addEventListener !== 'function') return ctrl;
      root.addEventListener('click', (ev) => {
        const find = (a: string): OrgDialogsMountNode | null => {
          let cur = ev.target ?? null;
          while (cur && cur !== root) { if (cur.getAttribute?.(a) != null) return cur; cur = cur.parentElement ?? null; }
          return null;
        };
        const cp = find('data-copy-cmd'); if (cp) { s.lastCopiedCommand = cp.getAttribute?.('data-copy-cmd') ?? null; return; }
        const ae = find('data-action'), act = ae?.getAttribute?.('data-action');
        if (act === 'open-remove-org' || act === 'remove-from-org') return void ctrl.requestRemoveFromOrg('organization');
        if (act === 'open-remove-workspace') return void ctrl.requestRemoveFromOrg('workspace');
        if (act === 'cancel-remove-member' || act === 'cancel-remove-from-org') return void ctrl.cancelRemoveFromOrg();
        if (act === 'confirm-remove-member' || act === 'confirm-remove-from-org') return void ctrl.confirmRemoveFromOrg();
        if (act === 'next-channel-step' && s.createChannel) return void ctrl.setChannelStep(Math.min(3, s.createChannel.step + 1) as 1 | 2 | 3);
        if (act === 'prev-channel-step' && s.createChannel) return void ctrl.setChannelStep(Math.max(1, s.createChannel.step - 1) as 1 | 2 | 3);
        if (act === 'approve-request' || act === 'reject-request') return void ctrl.decideApproval(ae?.getAttribute?.('data-approval-id') ?? '', act === 'approve-request' ? 'approve' : 'reject');
        const st = find('data-step-indicator'); if (st) return void ctrl.setChannelStep(Number(st.getAttribute?.('data-step-indicator')) as 1 | 2 | 3);
        const fl = find('data-roster-filter'); if (fl) return void ctrl.setFilter(fl.getAttribute?.('data-roster-filter') as OrgRosterFilter);
        const me = find('data-member-id'); if (me && !act) return void ctrl.selectMember(me.getAttribute?.('data-member-id') ?? '');
      });
      root.addEventListener('input', (ev) => {
        const t = ev.target, v = t?.value ?? '';
        if (!t?.name) return;
        if (t.name === 'channel_slug') ctrl.updateChannelDraft({ channel_slug: v, channel_name: v });
        else if (t.name === 'channel_topic') ctrl.updateChannelDraft({ topic: v });
        else if (t.name === 'channel_guidelines') ctrl.updateChannelDraft({ guidelines: v });
        else if (t.name === 'channel_icon') ctrl.updateChannelDraft({ channel_icon: v as ChannelIcon });
        else if (t.name === 'channel_visibility') ctrl.updateChannelDraft({ visibility: v as ChannelVisibility });
        else if (t.name === 'typed_delete_input') {
          const trg = t.getAttribute?.('data-delete-confirm-target');
          if (s.orgCrud && trg === s.orgCrud.org_name) ctrl.setOrgDeleteInput(v);
          else if (s.channelMembers && trg === s.channelMembers.channel_slug) ctrl.setChannelDeleteInput(v);
        }
      });
      root.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && s.members?.pending_removal) ctrl.cancelRemoveFromOrg(); });
      return ctrl;
    },
  };
  return ctrl;
}
export const mountOrgDialogsController = (root: OrgDialogsMountNode, initial: OrgDialogsControllerState) => createOrgDialogsController(initial).mount(root);
