import type { HouseholdAttribution, HouseholdRevisionRef } from '../../../src/protocol/household-object-events.js';
import { HOUSEHOLD_LOCAL_SEAT } from '../../../src/protocol/household-tool-registry.js';
import { householdAttribution, type HouseholdWorkspaceView } from './household-objects-view.js';
import { escapeMessageHtml } from './message-markdown.js';

type Call = (command: Record<string, unknown>, requestId: string) => Promise<Record<string, unknown>>;

export interface WorkspaceDefinitionCertification {
  readonly revision: HouseholdRevisionRef;
  readonly certified_by: string | { readonly user_id?: string };
  readonly certified_at: number | string;
}

export type WorkspaceDefinitionCertificationState = 'certified' | 'proposal_pending' | 'proposed';

export interface WorkspaceDefinitionSummary {
  readonly object_id: string;
  readonly term: string;
  readonly revision: HouseholdRevisionRef;
  readonly certification: WorkspaceDefinitionCertification | WorkspaceDefinitionCertificationState | null;
}

export interface WorkspaceDefinitionVersion {
  readonly revision: HouseholdRevisionRef;
  readonly term: string;
  readonly meaning: string;
  readonly source: string;
  readonly author: HouseholdAttribution;
  readonly occurred_at_server: number;
}

export interface WorkspaceDefinitionCertifiedVersion {
  readonly revision: HouseholdRevisionRef;
  readonly term: string;
  readonly meaning: string;
  readonly source: string;
  readonly certified_by: string | { readonly user_id?: string };
  readonly certified_at: number | string;
}

export interface WorkspaceDefinitionReadView {
  readonly object_id: string;
  readonly current: WorkspaceDefinitionVersion;
  readonly certified: WorkspaceDefinitionCertifiedVersion | null;
  readonly proposal_pending: boolean;
}

export interface WorkspaceDefinitionsViewData {
  readonly can_edit: boolean;
  readonly query: string;
  readonly definitions: readonly WorkspaceDefinitionSummary[];
  readonly opened: WorkspaceDefinitionReadView | null;
  readonly creating: boolean;
  readonly busy: boolean;
  readonly notice: string;
  readonly names?: HouseholdWorkspaceView['names'];
}

const esc = escapeMessageHtml;
const seat = HOUSEHOLD_LOCAL_SEAT;

const REFUSAL_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  definition_term_taken: 'A definition with this term already exists in this workspace.',
  definition_not_current: 'A newer version was saved since you opened this definition. Reloaded the latest version for review.',
  human_confirmation_required: 'Only a workspace member can certify a definition.',
  content_read_only: 'This action was refused because you have reader access.',
  content_consent_required: 'Confirm Lists & docs access before changing definitions.',
  patch_base_mismatch: 'This definition changed since you loaded it. Reload it to review.',
  revision_not_found: 'The version you started from is no longer available. Reload to review.',
  object_quota_reached: 'This workspace reached its list and document limit.',
  storage_quota_reached: 'The workspace storage limit is full.',
});

export function workspaceDefinitionRefusalNotice(reason: unknown, fallback = 'Could not save definition.'): string {
  return typeof reason === 'string' && REFUSAL_NOTICES[reason] ? REFUSAL_NOTICES[reason] : fallback;
}

function certifierUserId(certifiedBy: string | { readonly user_id?: string }): string {
  if (typeof certifiedBy === 'string') return certifiedBy;
  return typeof certifiedBy?.user_id === 'string' ? certifiedBy.user_id : 'member';
}

function certifierLabel(
  certifiedBy: string | { readonly user_id?: string },
  names?: HouseholdWorkspaceView['names'],
): string {
  const userId = certifierUserId(certifiedBy);
  return names?.people[userId] ?? `Person ${userId}`;
}

function toTimestampMs(value: number | string): number {
  return typeof value === 'number' ? value : Date.parse(String(value));
}

function isoStamp(value: number | string): string {
  const date = new Date(toTimestampMs(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'Time unavailable';
}

function localStamp(value: number | string): string {
  const date = new Date(toTimestampMs(value));
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Time unavailable';
}

function summaryStatusLabel(item: WorkspaceDefinitionSummary): 'Certified' | 'Proposal pending' | 'Proposed' {
  if (typeof item.certification === 'string') {
    if (item.certification === 'certified') return 'Certified';
    if (item.certification === 'proposal_pending') return 'Proposal pending';
    return 'Proposed';
  }
  if (item.certification && item.certification.revision?.token === item.revision?.token) {
    return 'Certified';
  }
  return item.certification ? 'Proposal pending' : 'Proposed';
}

export function renderWorkspaceDefinitionsHtml(state: WorkspaceDefinitionsViewData): string {
  const { definitions, opened, can_edit, creating, busy, notice, names } = state;

  const listHtml = definitions.length
    ? `<ul data-def-list>${definitions.map((item) => {
        const selected = !creating && opened?.object_id === item.object_id;
        const statusLabel = summaryStatusLabel(item);
        return `<li><button type="button" data-def-action="select" data-def-target="${esc(item.object_id)}"${busy ? ' disabled' : ''}${selected ? ' aria-current="true"' : ''}><span>${esc(item.term)}</span><span class="hh-def-badge">${statusLabel}</span></button></li>`;
      }).join('')}</ul>`
    : '<p class="hh-empty-note" data-def-empty>No certified or proposed definitions yet.</p>';

  const createControls = can_edit
    ? `<div class="hh-create-bar">
        <div class="hh-create-actions">
          <button type="button" data-def-action="new"${busy ? ' disabled' : ''}${creating ? ' aria-current="true"' : ''}>+ New definition</button>
        </div>
      </div>`
    : '';

  let detailHtml = '<p>Select a definition to inspect its meaning, source and certification, or create a new one.</p>';

  if (creating && can_edit) {
    detailHtml = `<form class="hh-editor hh-def-form" data-def-create-form>
      <h4>New definition</h4>
      <label>Term
        <input type="text" name="term" maxlength="80" placeholder="e.g. Monthly spend" required data-def-input-term${busy ? ' disabled' : ''} />
      </label>
      <label>Meaning
        <textarea name="meaning" rows="3" maxlength="2000" placeholder="Plain-language meaning for people and agents…" required data-def-input-meaning${busy ? ' disabled' : ''}></textarea>
      </label>
      <label>Source or how to compute
        <textarea name="source" rows="2" maxlength="2000" placeholder="Where this comes from or how to calculate it (optional)…" data-def-input-source${busy ? ' disabled' : ''}></textarea>
      </label>
      <div class="hh-def-form-actions">
        <button type="submit" class="dashboard__button--primary" data-def-action="create"${busy ? ' disabled' : ''}>Create definition</button>
        <button type="button" data-def-action="cancel-create"${busy ? ' disabled' : ''}>Cancel</button>
      </div>
    </form>`;
  } else if (opened) {
    const { current, certified, proposal_pending } = opened;
    const badgeState = !proposal_pending && certified
      ? 'certified'
      : certified
        ? 'pending'
        : 'proposed';
    const badgeLabel = badgeState === 'certified'
      ? 'Certified'
      : badgeState === 'pending'
        ? 'Proposal pending'
        : 'Proposed';

    const certifiedMeta = certified
      ? `<p class="hh-def-certified-meta" data-def-certified-meta>Certified by ${esc(certifierLabel(certified.certified_by, names))} · <time datetime="${esc(isoStamp(certified.certified_at))}">${esc(localStamp(certified.certified_at))}</time></p>`
      : '';

    const diffHtml = proposal_pending && certified
      ? `<section class="hh-conflict hh-def-diff" aria-label="Proposal comparison" data-def-diff>
          <h4>Review proposed update against certified version</h4>
          <div class="hh-comparison">
            <section aria-label="Certified version">
              <h5>Certified (active for agents)</h5>
              <dl class="hh-def-fields">
                <dt>Term</dt><dd>${esc(certified.term)}</dd>
                <dt>Meaning</dt><dd>${esc(certified.meaning)}</dd>
                <dt>Source</dt><dd>${esc(certified.source || '—')}</dd>
              </dl>
            </section>
            <section aria-label="Proposed version">
              <h5>Proposed (${esc(householdAttribution(current.author, names))})</h5>
              <dl class="hh-def-fields">
                <dt>Term</dt><dd>${esc(current.term)}</dd>
                <dt>Meaning</dt><dd>${esc(current.meaning)}</dd>
                <dt>Source</dt><dd>${esc(current.source || '—')}</dd>
              </dl>
            </section>
          </div>
        </section>`
      : '';

    const certifyBarHtml = proposal_pending && can_edit
      ? `<div class="hh-def-certify-bar" data-def-certify-bar>
          <p>${certified
            ? 'Agents continue answering from the certified version until a member certifies this proposal.'
            : 'Uncertified proposal. Certify it so agents can answer questions using this definition.'}</p>
          <button type="button" class="dashboard__button--primary" data-def-action="certify" data-def-target="${esc(opened.object_id)}" data-def-revision="${esc(current.revision.token)}"${busy ? ' disabled' : ''}>${certified ? 'Certify proposed version' : 'Certify definition'}</button>
        </div>`
      : '';

    const editFormHtml = can_edit
      ? `<details class="hh-def-edit">
          <summary>Edit definition</summary>
          <form class="hh-editor hh-def-form" data-def-update-form>
            <label>Term
              <input type="text" name="term" maxlength="80" value="${esc(current.term)}" required data-def-edit-term${busy ? ' disabled' : ''} />
            </label>
            <label>Meaning
              <textarea name="meaning" rows="3" maxlength="2000" required data-def-edit-meaning${busy ? ' disabled' : ''}>${esc(current.meaning)}</textarea>
            </label>
            <label>Source or how to compute
              <textarea name="source" rows="2" maxlength="2000" data-def-edit-source${busy ? ' disabled' : ''}>${esc(current.source)}</textarea>
            </label>
            <div class="hh-def-form-actions">
              <button type="submit" class="dashboard__button--primary" data-def-action="update"${busy ? ' disabled' : ''}>Save changes</button>
            </div>
          </form>
        </details>`
      : '';

    detailHtml = `<div class="hh-def-head">
        <h3>${esc(current.term)}</h3>
        <span class="hh-def-badge hh-def-badge--${badgeState}" data-def-status>${badgeLabel}</span>
      </div>
      <p>${esc(householdAttribution(current.author, names))} · <time datetime="${esc(isoStamp(current.occurred_at_server))}">${esc(localStamp(current.occurred_at_server))}</time></p>
      ${certifiedMeta}
      <dl class="hh-def-fields">
        <dt>Meaning</dt><dd>${esc(current.meaning)}</dd>
        <dt>Source</dt><dd>${esc(current.source || '—')}</dd>
      </dl>
      ${diffHtml}
      ${certifyBarHtml}
      ${editFormHtml}`;
  }

  return `<header>
      <div class="hh-workspace-identity">
        <p class="hh-eyebrow">Certified terms</p>
        <h3>Definitions</h3>
      </div>
    </header>
    <p role="status" aria-live="polite" aria-atomic="true" class="hh-status" data-def-notice>${esc(notice)}</p>
    <div class="hh-layout">
      <nav aria-label="Workspace definitions">
        ${createControls}
        ${listHtml}
      </nav>
      <article aria-label="Selected definition">
        ${detailHtml}
      </article>
    </div>`;
}

export function mountWorkspaceDefinitions(
  hostParent: HTMLElement,
  afterNode: HTMLElement,
  canEdit: boolean,
  call: Call,
  names?: HouseholdWorkspaceView['names'],
): () => void {
  const doc = hostParent.ownerDocument;
  const container = doc.createElement('section');
  container.className = 'household-objects household-definitions';
  container.setAttribute('aria-label', 'Workspace definitions');
  container.dataset.householdDefinitions = '';
  container.hidden = true;
  hostParent.insertBefore(container, afterNode.nextSibling);

  let disposed = false;
  let state: WorkspaceDefinitionsViewData = {
    can_edit: canEdit,
    query: '',
    definitions: [],
    opened: null,
    creating: false,
    busy: false,
    notice: '',
    names,
  };

  const tool = (name: string, args: Record<string, unknown>, requestId = crypto.randomUUID()) =>
    call({ kind: 'household_tool', tool: name, arguments: { seat, ...args } }, requestId);

  const paint = () => {
    if (disposed) return;
    container.innerHTML = renderWorkspaceDefinitionsHtml(state);
  };

  const readDefinition = async (objectId: string): Promise<WorkspaceDefinitionReadView | null> => {
    const res = await tool('definition_read', { object_id: objectId });
    if (res.status !== 'ok' || !res.current) return null;
    return {
      object_id: String(res.object_id ?? objectId),
      current: res.current as WorkspaceDefinitionVersion,
      certified: (res.certified as WorkspaceDefinitionCertifiedVersion | null) ?? null,
      proposal_pending: Boolean(res.proposal_pending),
    };
  };

  const refresh = async (notice = '', selectObjectId?: string | null) => {
    try {
      const entries: WorkspaceDefinitionSummary[] = [];
      let offset = 0;
      for (;;) {
        const res = await tool('definitions_search', { offset, limit: 100 });
        if (disposed) return;
        if (res.status !== 'ok' || !Array.isArray(res.definitions)) {
          // If definitions_search is not yet available on the server, keep section hidden cleanly.
          if (container.hidden) return;
          state = { ...state, busy: false, notice: notice || 'Definitions could not be loaded.' };
          paint();
          return;
        }
        entries.push(...(res.definitions as WorkspaceDefinitionSummary[]));
        if (res.next_offset === null || res.next_offset === undefined) break;
        const nextOffset = Number(res.next_offset);
        if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) break;
        offset = nextOffset;
      }
      container.hidden = false;
      const targetId = selectObjectId !== undefined
        ? selectObjectId
        : (state.opened?.object_id ?? entries[0]?.object_id ?? null);
      const opened = targetId && entries.some((entry) => entry.object_id === targetId)
        ? await readDefinition(targetId).catch(() => null)
        : null;
      if (disposed) return;
      state = {
        ...state,
        definitions: entries,
        opened,
        creating: false,
        busy: false,
        notice,
      };
      paint();
    } catch {
      if (disposed || container.hidden) return;
      state = { ...state, busy: false, notice: 'Definitions could not be loaded.' };
      paint();
    }
  };

  const onClick = (event: Event) => {
    const targetEl = event.target as { closest?: <T extends Element>(selector: string) => T | null } | null;
    const btn = typeof targetEl?.closest === 'function' ? targetEl.closest<HTMLButtonElement>('button[data-def-action]') : null;
    if (!btn || !container.contains(btn) || btn.disabled || state.busy) return;
    const action = btn.dataset.defAction;
    const target = btn.dataset.defTarget ?? '';
    if (action === 'new' && state.can_edit) {
      state = { ...state, creating: true, notice: '' };
      paint();
    } else if (action === 'cancel-create') {
      state = { ...state, creating: false, notice: '' };
      paint();
    } else if (action === 'select' && target) {
      state = { ...state, busy: true, creating: false, notice: '' };
      paint();
      void (async () => {
        const opened = await readDefinition(target).catch(() => null);
        if (disposed) return;
        state = {
          ...state,
          busy: false,
          opened: opened ?? state.opened,
          notice: opened ? '' : 'Could not load definition.',
        };
        paint();
      })();
    } else if (action === 'certify' && target && state.can_edit && state.opened?.object_id === target) {
      const revision = state.opened.current.revision;
      state = { ...state, busy: true, notice: 'Certifying…' };
      paint();
      void (async () => {
        const res = await call(
          { kind: 'household_definition_certify', object_id: target, revision },
          crypto.randomUUID(),
        ).catch(() => ({ status: 'unknown' }));
        if (disposed) return;
        if (res.status === 'committed') {
          await refresh('Certified.', target);
        } else if (res.reason === 'definition_not_current') {
          await refresh(workspaceDefinitionRefusalNotice('definition_not_current'), target);
        } else {
          state = {
            ...state,
            busy: false,
            notice: workspaceDefinitionRefusalNotice(res.reason, 'Could not certify definition.'),
          };
          paint();
        }
      })();
    }
  };

  const onSubmit = (event: Event) => {
    const targetEl = event.target as HTMLFormElement | null;
    const form = typeof targetEl?.matches === 'function' ? targetEl : null;
    if (!form || !container.contains(form) || state.busy || !state.can_edit) return;
    if (form.matches('[data-def-create-form]')) {
      event.preventDefault();
      const term = form.querySelector<HTMLInputElement>('[data-def-input-term]')?.value.replace(/[\r\n]+/g, ' ').trim() ?? '';
      const meaning = form.querySelector<HTMLTextAreaElement>('[data-def-input-meaning]')?.value.trim() ?? '';
      const source = form.querySelector<HTMLTextAreaElement>('[data-def-input-source]')?.value.trim() ?? '';
      if (!term || !meaning) {
        state = { ...state, notice: 'Enter both a term and its meaning.' };
        paint();
        return;
      }
      const baseSlug = term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'definition';
      let objectId = `def-${baseSlug}`;
      let suffix = 2;
      while (state.definitions.some((entry) => entry.object_id === objectId)) {
        objectId = `def-${baseSlug}-${suffix++}`;
      }
      const requestId = crypto.randomUUID();
      state = { ...state, busy: true, notice: 'Creating definition…' };
      paint();
      void (async () => {
        const res = await tool(
          'definition_create',
          { request_id: requestId, object_id: objectId, term, meaning, source },
          requestId,
        ).catch(() => ({ status: 'unknown' }));
        if (disposed) return;
        if (res.status === 'committed') {
          await refresh('Definition created as a proposal. Certify it when ready.', String(res.object_id ?? objectId));
        } else {
          state = {
            ...state,
            busy: false,
            notice: workspaceDefinitionRefusalNotice(res.reason, 'Could not create definition.'),
          };
          paint();
        }
      })();
    } else if (form.matches('[data-def-update-form]') && state.opened) {
      event.preventDefault();
      const opened = state.opened;
      const term = form.querySelector<HTMLInputElement>('[data-def-edit-term]')?.value.replace(/[\r\n]+/g, ' ').trim() ?? '';
      const meaning = form.querySelector<HTMLTextAreaElement>('[data-def-edit-meaning]')?.value.trim() ?? '';
      const source = form.querySelector<HTMLTextAreaElement>('[data-def-edit-source]')?.value.trim() ?? '';
      if (!term || !meaning) {
        state = { ...state, notice: 'Enter both a term and its meaning.' };
        paint();
        return;
      }
      const requestId = crypto.randomUUID();
      state = { ...state, busy: true, notice: 'Saving changes…' };
      paint();
      void (async () => {
        const res = await tool(
          'definition_update',
          {
            request_id: requestId,
            object_id: opened.object_id,
            base: opened.current.revision,
            before: {
              term: opened.current.term,
              meaning: opened.current.meaning,
              source: opened.current.source,
            },
            after: { term, meaning, source },
          },
          requestId,
        ).catch(() => ({ status: 'unknown' }));
        if (disposed) return;
        if (res.status === 'committed') {
          await refresh('Saved.', opened.object_id);
        } else {
          state = {
            ...state,
            busy: false,
            notice: workspaceDefinitionRefusalNotice(res.reason, 'Could not save definition changes.'),
          };
          paint();
        }
      })();
    }
  };

  container.addEventListener('click', onClick);
  container.addEventListener('submit', onSubmit);
  paint();
  void refresh();

  return () => {
    disposed = true;
    container.removeEventListener('click', onClick);
    container.removeEventListener('submit', onSubmit);
    container.remove();
  };
}
