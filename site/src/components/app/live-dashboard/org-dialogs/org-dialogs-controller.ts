import { type OrgRole, type OrgRosterFilter, buildOrgMemberParityCommands, canChangeOrgRole } from './org-members-screen.js';
import {
  type ChannelIcon, type ChannelVisibility, type CreateChannelModalProps, type NotifyPref,
  isTypedDeleteMatch, validateOrgLogoUpload,
} from './workspace-channel-dialogs.js';
import {
  type OrgDialogsActionResult, type OrgDialogsCommand, type OrgDialogsControllerState, type OrgDialogsMountNode,
  buildApprovalCliCommand, initOrgDialogsState, renderOrgDialogsHtml,
} from './approval-remedy-cards.js';

export type { OrgDialogsActionResult, OrgDialogsCommand, OrgDialogsControllerState, OrgDialogsMountNode };

export function createOrgDialogsController(init: OrgDialogsControllerState) {
  const s = initOrgDialogsState(init);
  let rootEl: OrgDialogsMountNode | null = null, trigEl: OrgDialogsMountNode | null = null;
  const html = () => renderOrgDialogsHtml(s);
  const up = () => { if (rootEl) rootEl.innerHTML = html(); return s; };
  const setDis = (act: string, dis: boolean) => {
    const b = rootEl?.querySelector?.(`[data-action="${act}"]`);
    if (b) { b.disabled = dis; if (dis) b.setAttribute?.('disabled', ''); else b.removeAttribute?.('disabled'); }
  };
  const tx = (kind: string, mcp_tool: string, cli_command: string, payload: Record<string, unknown>) => {
    const cmd: OrgDialogsCommand = { kind, mcp_tool, cli_command, payload };
    s.lastCommand = cmd;
    const res = s.onAction?.(cmd);
    if (res && res.ok === false) { if (res.refusal) s.refusals = [...(s.refusals ?? []), res.refusal]; up(); return { ok: false as const, res }; }
    return { ok: true as const, res };
  };
  const chCli = (c: CreateChannelModalProps) => `cswarm channel create ${c.channel_slug || 'new-channel'} --workspace ${c.org_slug}/${c.workspace_slug} --visibility ${c.visibility}`;
  const findM = (id: string) => s.members?.members.find((x) => x.principal_id === id);
  const ctrl = {
    getState: () => s, renderToHtml: html,
    openDialog(id: string, t?: OrgDialogsMountNode | null) {
      trigEl = t ?? null; s.activeDialog = id; up();
      rootEl?.querySelector?.(`[data-dialog="${id}"] button:not([disabled]),[data-dialog="${id}"] input:not([disabled]),[data-dialog="${id}"] select:not([disabled])`)?.focus?.();
      return s;
    },
    closeDialog(id?: string) {
      if (s.members?.pending_removal && (!id || id === 'confirm-remove-org-member')) s.members = { ...s.members, pending_removal: null };
      else s.activeDialog = id ? `closed:${id}` : null;
      up(); trigEl?.focus?.(); return s;
    },
    selectMember(id: string) { if (s.members) s.members = { ...s.members, selected_principal_id: id, pending_removal: null, mobileView: 'detail', mobile_view: 'detail' }; return up(); },
    backToMemberList() {
      if (s.members) s.members = { ...s.members, mobileView: 'list', mobile_view: 'list' };
      up(); if (s.members?.selected_principal_id) rootEl?.querySelector?.(`.member-row[data-member-id="${s.members.selected_principal_id}"]`)?.focus?.();
      return s;
    },
    setFilter(f: OrgRosterFilter) { if (s.members) s.members = { ...s.members, active_filter: f }; return up(); },
    setDetailTab(tab: 'profile' | 'skills') { if (s.members) s.members = { ...s.members, active_detail_tab: tab }; return up(); },
    toggleCreationMenu() { if (s.members) s.members = { ...s.members, creation_menu_open: !s.members.creation_menu_open }; return up(); },
    changeMemberRole(id: string, role: OrgRole) {
      const m = findM(id);
      if (!s.members || !m || !canChangeOrgRole(s.members.actor_role, m.role, role)) return s;
      const c = buildOrgMemberParityCommands(s.members.org_slug, s.members.current_workspace_slug, { ...m, role });
      if (tx('org_set_member_role', c.mcp_member_role, c.cli_member_role, { principal_id: id, role }).ok) m.role = role;
      return up();
    },
    addWorkspaceGrant(id: string, wsId?: string) {
      const m = findM(id), w = s.members?.available_workspaces.find((x) => (wsId ? x.workspace_id === wsId : !m?.workspace_grants.some((g) => g.workspace_id === x.workspace_id)));
      if (!s.members || !m || !w) return s;
      const c = buildOrgMemberParityCommands(s.members.org_slug, w.slug, m);
      if (tx('org_assign_workspace_member', c.mcp_workspace_grant, c.cli_workspace_grant, { principal_id: id, workspace_id: w.workspace_id }).ok) {
        m.workspace_grants = [...m.workspace_grants, { workspace_id: w.workspace_id, workspace_slug: w.slug, workspace_name: w.name, role: m.role }];
      }
      return up();
    },
    revokeWorkspaceGrant(id: string, wsId: string) {
      const m = findM(id), g = m?.workspace_grants.find((x) => x.workspace_id === wsId);
      if (!s.members || !m || !g) return s;
      const c = buildOrgMemberParityCommands(s.members.org_slug, g.workspace_slug, m);
      if (tx('org_remove_workspace_member', c.mcp_workspace_revoke, c.cli_workspace_revoke, { principal_id: id, workspace_id: wsId }).ok) {
        if (g.active_seat_id && m.active_seat_id === g.active_seat_id) m.active_seat_id = m.active_seat_workspace_slug = null;
        m.workspace_grants = m.workspace_grants.filter((x) => x.workspace_id !== wsId);
      }
      return up();
    },
    requestRemoveFromOrg(scope: 'workspace' | 'organization' = 'organization', t?: OrgDialogsMountNode | null) {
      trigEl = t ?? null;
      if (s.members) s.members = { ...s.members, pending_removal: { principal_id: s.members.selected_principal_id ?? s.members.members[0]?.principal_id ?? '', scope } };
      return up();
    },
    cancelRemoveFromOrg() { if (s.members) s.members = { ...s.members, pending_removal: null }; up(); trigEl?.focus?.(); return s; },
    confirmRemoveFromOrg() {
      const rem = s.members?.pending_removal, m = findM(rem?.principal_id ?? '');
      if (!s.members || !rem || !m) return s;
      const c = buildOrgMemberParityCommands(s.members.org_slug, s.members.current_workspace_slug, m), isOrg = rem.scope === 'organization';
      if (!tx(isOrg ? 'org_remove_member' : 'org_remove_workspace_member', isOrg ? c.mcp_org_remove : c.mcp_workspace_revoke, isOrg ? c.cli_org_remove : c.cli_workspace_revoke, { principal_id: m.principal_id, scope: rem.scope, workspace_id: s.members.current_workspace_id }).ok) return s;
      if (isOrg) {
        const next = s.members.members.filter((x) => x.principal_id !== m.principal_id);
        s.members = { ...s.members, members: next, selected_principal_id: next[0]?.principal_id ?? null, pending_removal: null };
      } else {
        const wid = s.members.current_workspace_id, wSlug = s.members.current_workspace_slug, g = m.workspace_grants.find((x) => x.workspace_id === wid || x.workspace_slug === wSlug);
        if ((g?.active_seat_id && m.active_seat_id === g.active_seat_id) || m.active_seat_workspace_slug === wSlug) m.active_seat_id = m.active_seat_workspace_slug = null;
        m.workspace_grants = m.workspace_grants.filter((x) => x.workspace_id !== wid && x.workspace_slug !== wSlug);
        s.members = { ...s.members, pending_removal: null };
      }
      return up();
    },
    setChannelStep(step: 1 | 2 | 3) { if (s.createChannel) s.createChannel = { ...s.createChannel, step }; return up(); },
    updateChannelDraft(p: Partial<CreateChannelModalProps>, inPlace = false) {
      if (!s.createChannel) return s;
      s.createChannel = { ...s.createChannel, ...p };
      if (inPlace && rootEl?.querySelector) {
        const code = rootEl.querySelector('[data-channel-cli-preview]');
        if (code) code.textContent = chCli(s.createChannel);
        return s;
      }
      return up();
    },
    setOrgDeleteInput(v: string, inPlace = false) {
      if (!s.orgCrud) return s;
      s.orgCrud = { ...s.orgCrud, typed_delete_input: v };
      const d = s.orgCrud.actor_role !== 'owner' || !isTypedDeleteMatch(s.orgCrud.org_name, v);
      return inPlace && rootEl?.querySelector ? (setDis('confirm-delete-org', d), s) : up();
    },
    setChannelDeleteInput(v: string, inPlace = false) {
      if (!s.channelMembers) return s;
      s.channelMembers = { ...s.channelMembers, typed_delete_input: v };
      return inPlace && rootEl?.querySelector ? (setDis('confirm-delete-channel', !isTypedDeleteMatch(s.channelMembers.channel_slug, v)), s) : up();
    },
    validateLogoUpload(input: { mimeType: string; sizeBytes: number; svgText?: string }) {
      const res = validateOrgLogoUpload({ actorRole: s.logoUpload?.actor_role ?? s.members?.actor_role ?? 'owner', ...input });
      if (s.logoUpload) s.logoUpload = { ...s.logoUpload, upload_error: res.ok ? null : (res.error ?? 'Invalid logo'), sanitized_svg: res.sanitizedSvg ?? null };
      up(); return res;
    },
    decideApproval(id: string, d: 'approve' | 'reject') {
      const c = (s.approvals ?? []).find((a) => a.approval_id === id);
      if (!c || c.state !== 'pending') return s;
      const r = tx('org_confirm_action', 'org_confirm_action', buildApprovalCliCommand(id, d), { approval_id: id, decision: d });
      if (r.ok) { c.state = d === 'approve' ? 'approved' : 'rejected'; c.decided_by = r.res?.decided_by ?? c.owner_user_id; c.decided_at = r.res?.decided_at ?? new Date().toISOString(); }
      return up();
    },
    mount(root: OrgDialogsMountNode) {
      rootEl = root; up();
      if (typeof root.addEventListener !== 'function') return ctrl;
      const find = (ev: { target?: OrgDialogsMountNode | null }, a: string): OrgDialogsMountNode | null => {
        for (let cur = ev.target ?? null; cur && cur !== root; cur = cur.parentElement ?? null) if (cur.getAttribute?.(a) != null) return cur;
        return null;
      };
      const openInv = (actId: string, t: OrgDialogsMountNode | null) => {
        if (s.members) s.members = { ...s.members, creation_menu_open: false };
        tx(actId, 'org_invite_member', `cswarm org invite --org ${s.members?.org_slug ?? 'org'}`, { action: actId });
        ctrl.openDialog(actId, t);
      };
      root.addEventListener('click', (ev) => {
        const cp = find(ev, 'data-copy-cmd');
        if (cp) {
          const cmd = cp.getAttribute?.('data-copy-cmd') ?? null;
          s.lastCopiedCommand = cmd;
          if (cmd) (globalThis as { navigator?: { clipboard?: { writeText?(t: string): unknown } } }).navigator?.clipboard?.writeText?.(cmd);
          return;
        }
        const tabEl = find(ev, 'data-detail-tab'); if (tabEl) return void ctrl.setDetailTab(tabEl.getAttribute?.('data-detail-tab') as 'profile' | 'skills');
        const ca = find(ev, 'data-creation-action'); if (ca) return void openInv(ca.getAttribute?.('data-creation-action') ?? 'invite-person', ca);
        const ae = find(ev, 'data-action'), a = ae?.getAttribute?.('data-action'), mid = ae?.getAttribute?.('data-member-id') ?? s.members?.selected_principal_id ?? '';
        if (a === 'toggle-creation-menu') return void ctrl.toggleCreationMenu();
        if (a === 'invite-person' || a === 'connect-grant-agent') return void openInv(a, ae);
        if (a === 'member-list-back') return void ctrl.backToMemberList();
        if (a === 'close-dialog') return void ctrl.closeDialog(ae?.getAttribute?.('data-dialog-id') ?? find(ev, 'data-dialog')?.getAttribute?.('data-dialog') ?? undefined);
        if (a === 'open-remove-org' || a === 'remove-from-org') return void ctrl.requestRemoveFromOrg('organization', ae);
        if (a === 'open-remove-workspace') return void ctrl.requestRemoveFromOrg('workspace', ae);
        if (a === 'cancel-remove-member' || a === 'cancel-remove-from-org') return void ctrl.cancelRemoveFromOrg();
        if (a === 'confirm-remove-member' || a === 'confirm-remove-from-org') return void ctrl.confirmRemoveFromOrg();
        if (a === 'add-workspace-grant') return void ctrl.addWorkspaceGrant(mid, root.querySelector?.(`[data-add-workspace-for="${mid}"]`)?.value);
        if (a === 'revoke-workspace-grant') return void ctrl.revokeWorkspaceGrant(mid, ae?.getAttribute?.('data-workspace-id') ?? '');
        if (a === 'ws-add-member' && s.workspaceMembers?.org_candidates[0]) {
          const cand = s.workspaceMembers.org_candidates[0];
          if (tx('org_assign_workspace_member', 'org_assign_workspace_member', `cswarm org members grant ${cand.principal_id}`, { principal_id: cand.principal_id }).ok) {
            s.workspaceMembers = { ...s.workspaceMembers, workspace_members: [...s.workspaceMembers.workspace_members, cand], org_candidates: s.workspaceMembers.org_candidates.slice(1) }; up();
          }
          return;
        }
        if (a === 'ws-remove-member' && s.workspaceMembers) {
          if (tx('org_remove_workspace_member', 'org_remove_workspace_member', `cswarm org members revoke ${mid}`, { principal_id: mid }).ok) {
            s.workspaceMembers = { ...s.workspaceMembers, workspace_members: s.workspaceMembers.workspace_members.filter((x) => x.principal_id !== mid) }; up();
          }
          return;
        }
        if ((a === 'next-channel-step' || a === 'prev-channel-step') && s.createChannel) return void ctrl.setChannelStep(Math.max(1, Math.min(3, s.createChannel.step + (a === 'next-channel-step' ? 1 : -1))) as 1 | 2 | 3);
        if (a === 'submit-create-channel' && s.createChannel) return void tx('channel_create', 'channel_create', chCli(s.createChannel), { ...s.createChannel });
        if (a === 'confirm-delete-org' && s.orgCrud && isTypedDeleteMatch(s.orgCrud.org_name, s.orgCrud.typed_delete_input ?? '')) return void tx('org_delete', 'org_delete', `cswarm org delete ${s.orgCrud.org_slug} --confirm ${s.orgCrud.org_slug}`, { org_slug: s.orgCrud.org_slug });
        if (a === 'confirm-delete-channel' && s.channelMembers && isTypedDeleteMatch(s.channelMembers.channel_slug, s.channelMembers.typed_delete_input ?? '')) return void tx('channel_archive', 'channel_archive', `cswarm channel archive ${s.channelMembers.channel_slug}`, { channel_id: s.channelMembers.channel_id });
        if (a === 'approve-request' || a === 'reject-request') return void ctrl.decideApproval(ae?.getAttribute?.('data-approval-id') ?? '', a === 'approve-request' ? 'approve' : 'reject');
        const st = find(ev, 'data-step-indicator'); if (st) return void ctrl.setChannelStep(Number(st.getAttribute?.('data-step-indicator')) as 1 | 2 | 3);
        const fl = find(ev, 'data-roster-filter'); if (fl) return void ctrl.setFilter(fl.getAttribute?.('data-roster-filter') as OrgRosterFilter);
        const me = find(ev, 'data-member-id'); if (me && !a) return void ctrl.selectMember(me.getAttribute?.('data-member-id') ?? '');
      });
      root.addEventListener('input', (ev) => {
        const t = ev.target, v = t?.value ?? '', n = t?.name ?? (t?.getAttribute?.('data-action') === 'change-org-role' ? 'member_org_role' : '');
        if (n === 'channel_slug') ctrl.updateChannelDraft({ channel_slug: v, channel_name: v }, true);
        else if (n === 'channel_topic') ctrl.updateChannelDraft({ topic: v }, true);
        else if (n === 'channel_guidelines') ctrl.updateChannelDraft({ guidelines: v }, true);
        else if (n === 'channel_icon') ctrl.updateChannelDraft({ channel_icon: v as ChannelIcon });
        else if (n === 'channel_visibility') ctrl.updateChannelDraft({ visibility: v as ChannelVisibility });
        else if (n === 'channel_member_id' && s.createChannel) {
          const cur = s.createChannel.selected_principal_ids;
          ctrl.updateChannelDraft({ selected_principal_ids: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] }, true);
        } else if (n === 'channel_notify_pref' && s.channelMembers) {
          s.channelMembers = { ...s.channelMembers, notify_pref: v as NotifyPref };
          tx('channel_set_notify_pref', 'channel_set_notify_pref', `cswarm channel notify ${v}`, { notify_pref: v });
        } else if (n === 'member_org_role') ctrl.changeMemberRole(t?.getAttribute?.('data-member-id') ?? s.members?.selected_principal_id ?? '', v as OrgRole);
        else if (n === 'typed_delete_input') {
          const trg = t?.getAttribute?.('data-delete-confirm-target');
          if (s.orgCrud && trg === s.orgCrud.org_name) ctrl.setOrgDeleteInput(v, true);
          else if (s.channelMembers && trg === s.channelMembers.channel_slug) ctrl.setChannelDeleteInput(v, true);
        }
      });
      root.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          if (s.members?.pending_removal) ctrl.cancelRemoveFromOrg();
          else if (s.members?.creation_menu_open) ctrl.toggleCreationMenu();
          else if (s.activeDialog) ctrl.closeDialog(s.activeDialog);
        } else if (ev.key === 'Tab' && (s.activeDialog || s.members?.pending_removal) && root.querySelectorAll) {
          const items = [...root.querySelectorAll('dialog[open] button:not([disabled]),dialog[open] input:not([disabled]),dialog[open] select:not([disabled]),dialog[open] textarea:not([disabled])')];
          if (items.length) {
            const first = items[0]!, last = items[items.length - 1]!;
            if (ev.shiftKey && ev.target === first) { ev.preventDefault?.(); last.focus?.(); }
            else if (!ev.shiftKey && ev.target === last) { ev.preventDefault?.(); first.focus?.(); }
          }
        }
      });
      return ctrl;
    },
  };
  return ctrl;
}
export const mountOrgDialogsController = (root: OrgDialogsMountNode, init: OrgDialogsControllerState) => createOrgDialogsController(init).mount(root);
