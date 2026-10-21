export interface ApprovalCardData {
  approval_id: string;
  org_id: string;
  org_slug?: string;
  workspace_id?: string | null;
  workspace_slug?: string | null;
  channel_id?: string | null;
  channel_slug?: string | null;
  requested_by_agent_identity_id: string;
  agent_display_name?: string;
  owner_user_id: string;
  owner_display_name?: string;
  action_kind: string;
  action_summary?: string;
  target_scope: Record<string, unknown>;
  payload: Record<string, unknown>;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  decided_by?: string | null;
  decided_at?: string | null;
  expires_at?: string | null;
  created_at: string;
}

export interface WorkspaceSelectorChoiceItem {
  org_id: string;
  org_slug: string;
  workspace_id: string;
  workspace_slug: string;
  selector: string;
}

export interface RefusalRemedyData {
  code: string;
  missing: string;
  scope: {
    org?: string | null;
    workspace?: string | null;
    channel?: string | null;
    seat_id?: string | null;
  };
  remedy_url: string;
  mcp_tool: string;
  cli_command: string;
  choices?: WorkspaceSelectorChoiceItem[];
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

export function buildApprovalCliCommand(approvalId: string, decision: 'approve' | 'reject' = 'approve'): string {
  return decision === 'approve'
    ? `cswarm org confirm ${approvalId}`
    : `cswarm org confirm ${approvalId} --reject`;
}

export function buildApprovalMcpCall(approvalId: string, decision: 'approve' | 'reject' = 'approve') {
  return {
    mcp_tool: 'org_confirm_action',
    arguments: {
      approval_id: approvalId,
      decision,
    },
  };
}

export function renderInlineApprovalCard(card: ApprovalCardData): string {
  const isPending = card.state === 'pending';
  const approveCli = buildApprovalCliCommand(card.approval_id, 'approve');
  const rejectCli = buildApprovalCliCommand(card.approval_id, 'reject');
  const mcpCall = buildApprovalMcpCall(card.approval_id, 'approve');
  const scopeLabel = [
    card.org_slug ?? card.org_id,
    card.workspace_slug ?? card.workspace_id,
    card.channel_slug ? `#${card.channel_slug}` : card.channel_id,
  ]
    .filter(Boolean)
    .join(' / ');

  const stateBadgeClass =
    card.state === 'approved' ? 'badge good' : card.state === 'rejected' ? 'badge danger-badge' : 'badge';

  return `<article class="spec-card approval-card" data-approval-id="${esc(card.approval_id)}" data-approval-state="${esc(card.state)}" aria-label="Owner approval request">
    <div class="dialog-heading">
      <div>
        <h2>Owner Approval Request · <code>${esc(card.action_kind)}</code></h2>
        <p class="meta">Requested by agent <strong>${esc(card.agent_display_name ?? card.requested_by_agent_identity_id)}</strong> (<code>${esc(card.requested_by_agent_identity_id)}</code>) on behalf of owner <strong>${esc(card.owner_display_name ?? card.owner_user_id)}</strong></p>
      </div>
      <span class="${stateBadgeClass}" data-approval-status-badge="${esc(card.state)}">${esc(card.state.toUpperCase())}</span>
    </div>

    <dl class="approval-dl">
      <dt>Action</dt>
      <dd>${esc(card.action_summary ?? card.action_kind)}</dd>
      <dt>Target scope</dt>
      <dd><code>${esc(scopeLabel || JSON.stringify(card.target_scope))}</code></dd>
      <dt>Approver required</dt>
      <dd>Live Organization Owner (<code>${esc(card.owner_display_name ?? card.owner_user_id)}</code>)</dd>
      <dt>Standing validity</dt>
      <dd>${card.expires_at ? esc(card.expires_at) : 'No artificial session timeout · resolves on owner decision'}</dd>
    </dl>

    <div class="parity-command-box">
      <div class="parity-row">
        <span class="meta">Confirm via CLI</span>
        <code data-approval-cli="${esc(card.approval_id)}">${esc(approveCli)}</code>
        <button type="button" class="button" data-copy-cmd="${esc(approveCli)}">Copy CLI</button>
      </div>
      <div class="parity-row">
        <span class="meta">Confirm via MCP tool</span>
        <code data-approval-mcp="${esc(card.approval_id)}">${esc(mcpCall.mcp_tool)} ${esc(JSON.stringify(mcpCall.arguments))}</code>
        <button type="button" class="button" data-copy-cmd="${esc(mcpCall.mcp_tool)}">Copy MCP</button>
      </div>
    </div>

    <div class="sample-row approval-actions">
      <button type="button" class="button primary" data-action="approve-request" data-approval-id="${esc(card.approval_id)}" ${!isPending ? 'disabled' : ''}>Approve</button>
      <button type="button" class="button danger" data-action="reject-request" data-approval-id="${esc(card.approval_id)}" data-reject-cli="${esc(rejectCli)}" ${!isPending ? 'disabled' : ''}>Reject</button>
    </div>
  </article>`;
}

export function renderActionableRefusalBanner(refusal: RefusalRemedyData): string {
  const scopeParts = [
    refusal.scope.org ? `org=${refusal.scope.org}` : null,
    refusal.scope.workspace ? `workspace=${refusal.scope.workspace}` : null,
    refusal.scope.channel ? `channel=${refusal.scope.channel}` : null,
    refusal.scope.seat_id ? `seat=${refusal.scope.seat_id}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const choicesHtml =
    refusal.choices && refusal.choices.length > 0
      ? `<div class="refusal-choices" data-refusal-choices="true">
          <small class="meta">Reachable qualified workspace selectors:</small>
          <div class="sample-row">
            ${refusal.choices
              .map(
                (c) => `<button type="button" class="button" data-select-workspace-choice="${esc(c.selector)}" data-copy-cmd="${esc(c.selector)}"><code>${esc(c.selector)}</code></button>`,
              )
              .join('')}
          </div>
        </div>`
      : '';

  return `<aside class="notice refusal-remedy-banner" role="alert" data-refusal-code="${esc(refusal.code)}" aria-label="Actionable refusal remedy">
    <div class="dialog-heading">
      <strong>Refused: <code>${esc(refusal.code)}</code> (missing: <code>${esc(refusal.missing)}</code>)</strong>
      ${scopeParts ? `<span class="badge">${esc(scopeParts)}</span>` : ''}
    </div>
    <p>Resolve in web UI: <a href="${esc(refusal.remedy_url)}" data-remedy-url="${esc(refusal.remedy_url)}">${esc(refusal.remedy_url)}</a></p>
    <div class="parity-command-box">
      <div class="parity-row">
        <span class="meta">MCP tool remedy</span>
        <code data-refusal-mcp="${esc(refusal.mcp_tool)}">${esc(refusal.mcp_tool)}</code>
        <button type="button" class="button" data-copy-cmd="${esc(refusal.mcp_tool)}">Copy MCP tool</button>
      </div>
      <div class="parity-row">
        <span class="meta">CLI command remedy</span>
        <code data-refusal-cli="${esc(refusal.cli_command)}">${esc(refusal.cli_command)}</code>
        <button type="button" class="button" data-copy-cmd="${esc(refusal.cli_command)}">Copy CLI command</button>
      </div>
    </div>
    ${choicesHtml}
  </aside>`;
}
