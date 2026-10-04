import type {
  HouseholdAttribution, HouseholdContent, HouseholdListPatch, HouseholdOutcome,
  HouseholdPatch, HouseholdRevisionRef,
} from '../../../src/protocol/household-object-events.js';
import { HOUSEHOLD_CONTENT_OPERATIONS, type HouseholdContentOperation, type HouseholdContentRole } from '../../../src/protocol/household-object-policy.js';
import { escapeMessageHtml, renderMessageMarkdown } from './message-markdown.js';

/** Authorized presentation data only: no storage paths, credentials or signed URLs.
 * The integration caller loads each page through the authenticated content routes.
 */
export interface HouseholdVersionView {
  revision: HouseholdRevisionRef;
  title: string;
  author: HouseholdAttribution;
  occurred_at_server: number;
  live: boolean;
  content: HouseholdContent | null;
}
export interface HouseholdObjectView {
  object_id: string;
  kind: HouseholdContent['kind'];
  current: HouseholdVersionView;
  history: readonly HouseholdVersionView[];
  /** null means the returned page is complete; never infer that from its length. */
  next_history_cursor: string | null;
}
export interface HouseholdWorkspaceView {
  workspace_id: string;
  name: string;
  audience: readonly string[];
  viewer_user_id: string;
  content_role: HouseholdContentRole | null;
  /** The consented connection ceiling, supplied by the authenticated caller. */
  operations: readonly HouseholdContentOperation[];
  objects: readonly HouseholdObjectView[];
}
export interface HouseholdConflictView {
  workspace_id: string;
  object_id: string;
  draft_id: string;
  owner_user_id: string;
  base: HouseholdVersionView;
  current: HouseholdVersionView;
  proposed: HouseholdContent;
}
export interface HouseholdSaveRequest {
  request_id: string;
  workspace_id: string;
  object_id: string;
  base: HouseholdRevisionRef;
  patch: HouseholdPatch;
}
type SaveOutcome = Exclude<HouseholdOutcome, { status: 'released' }> | { status: 'unknown' };
export interface HouseholdActions {
  save(request: HouseholdSaveRequest): Promise<SaveOutcome>;
  readRevision(revision: HouseholdRevisionRef): Promise<HouseholdContent>;
  recoverDraft(workspaceId: string, draftId: string): Promise<HouseholdConflictView>;
  readHistory?(workspaceId: string, objectId: string, cursor: string): Promise<{
    revisions: readonly HouseholdVersionView[]; next_cursor: string | null;
  }>;
}
export type HouseholdSaveState = 'idle' | 'saving' | SaveOutcome['status'];
export interface HouseholdObjectsState {
  workspace: HouseholdWorkspaceView;
  selected_id: string | null;
  opened_version: HouseholdVersionView | null;
  proposed: HouseholdContent | null;
  conflict: HouseholdConflictView | null;
  draft_id: string | null;
  conflict_current: HouseholdRevisionRef | null;
  save_state: HouseholdSaveState;
  notice: string;
}
const esc = escapeMessageHtml;
const sameRef = (a: HouseholdRevisionRef, b: HouseholdRevisionRef): boolean =>
  a.workspace_id === b.workspace_id && a.object_id === b.object_id && a.token === b.token;
const bound = (ref: HouseholdRevisionRef, workspaceId: string, objectId: string): boolean =>
  ref.workspace_id === workspaceId && ref.object_id === objectId && !!ref.token;
export function householdCanUpdate(workspace: HouseholdWorkspaceView): boolean {
  return workspace.content_role === 'editor' && workspace.operations.includes('read') && workspace.operations.includes('update');
}
function authorizedWorkspace(input: HouseholdWorkspaceView): HouseholdWorkspaceView {
  const workspace = structuredClone(input);
  if (!workspace.content_role || !workspace.operations.includes('read')) workspace.objects = [];
  // Fail closed on mixed-workspace/object pages, rather than displaying a partial history.
  workspace.objects = workspace.objects.filter((object) => bound(object.current.revision, workspace.workspace_id, object.object_id)
    && (object.current.content === null || object.current.content.kind === object.kind)
    && object.history.every((version) => bound(version.revision, workspace.workspace_id, object.object_id)
      && (version.content === null || version.content.kind === object.kind)));
  return workspace;
}
export function createHouseholdObjectsState(workspace: HouseholdWorkspaceView): HouseholdObjectsState {
  return { workspace: authorizedWorkspace(workspace), selected_id: null, opened_version: null, proposed: null,
    conflict: null, draft_id: null, conflict_current: null, save_state: 'idle', notice: '' };
}
export function selectedHouseholdObject(state: HouseholdObjectsState): HouseholdObjectView | null {
  return state.workspace.objects.find((object) => object.object_id === state.selected_id) ?? null;
}
export function householdAttribution(author: HouseholdAttribution): string {
  return author.principal_id === null ? `Person ${author.user_id}` : `Agent ${author.principal_id} for ${author.user_id}`;
}
function stamp(time: number): string {
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'Time unavailable';
}
/** Use the existing audited Markdown subset, but remove its generated links.
 * HTML, images, agent instructions and URLs remain inert text, with no fetches.
 */
export function renderHouseholdContent(content: HouseholdContent | null): string {
  if (!content) return '<p>Content has not been loaded. Open this revision to read it.</p>';
  if (content.kind === 'doc') return `<div class="hh-markdown">${renderMessageMarkdown(content.markdown, { headingOffset: 1 }).replace(/<\/?a\b[^>]*>/gu, '')}</div>`;
  if (content.kind === 'file') return `<dl><dt>File</dt><dd>${esc(content.name)}</dd><dt>Type</dt><dd>${esc(content.media_type)}</dd></dl>`;
  return `<ol class="hh-list">${[...content.items].sort((a, b) => a.order - b.order).map((item) =>
    `<li><span aria-label="${item.checked ? 'Checked' : 'Unchecked'}">${item.checked ? '☑' : '☐'}</span> ${esc(item.text)}</li>`).join('')}</ol>`;
}
const button = (action: string, label: string, value = '', disabled = false): string =>
  `<button type="button" data-hh-action="${action}" data-hh-value="${esc(value)}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
export function renderHouseholdObjectHistory(object: HouseholdObjectView | null, busy = false): string {
  if (!object) return '<p>Select an object to read its history.</p>';
  return `<section class="hh-history" aria-label="Object history"><h3>History</h3>
    <p>Committed revisions remain readable, including retired revisions.</p>
    <ol>${object.history.map((version) => `<li>${button('revision', version.title, version.revision.token, busy)}
      <span>${sameRef(version.revision, object.current.revision) ? 'Current' : version.live ? 'Earlier revision' : 'Retired · retained'}</span>
      <p>${esc(householdAttribution(version.author))} · <time datetime="${esc(stamp(version.occurred_at_server))}">${esc(stamp(version.occurred_at_server))}</time></p>
      <small>Revision ${esc(version.revision.token)}</small></li>`).join('')}</ol>
    ${object.next_history_cursor === null ? '<p>All returned history is shown.</p>' : button('history', 'Load more history', '', busy)}</section>`;
}
export function renderHouseholdConflict(state: HouseholdObjectsState): string {
  const conflict = state.conflict;
  if (!conflict) return state.draft_id ? `<section class="hh-conflict" aria-label="Save conflict"><h3>Someone saved another revision</h3>
    <p>Your draft was retained. Recover it to compare the changes.</p>${button('recover', 'Recover my draft')}</section>` : '';
  if (conflict.owner_user_id !== state.workspace.viewer_user_id || conflict.workspace_id !== state.workspace.workspace_id
    || conflict.object_id !== state.selected_id || !bound(conflict.base.revision, conflict.workspace_id, conflict.object_id)
    || !bound(conflict.current.revision, conflict.workspace_id, conflict.object_id)) return '';
  const canSave = householdCanUpdate(state.workspace) && state.save_state === 'conflict' && conflict.proposed.kind !== 'file';
  return `<section class="hh-conflict" aria-label="Save conflict"><h3>Review the changes</h3>
    <p>Your retained draft is available to you. Compare all three versions before saving again.</p>
    <div class="hh-comparison">${[
      ['Base', conflict.base.content], ['Current', conflict.current.content], ['Your proposed draft', conflict.proposed],
    ].map(([label, content]) => `<section aria-label="${label}"><h4>${label}</h4>${renderHouseholdContent(content as HouseholdContent)}</section>`).join('')}</div>
    <p>Base revision ${esc(conflict.base.revision.token)} · Current revision ${esc(conflict.current.revision.token)}</p>
    ${canSave ? `<label><input type="checkbox" data-hh-review /> I reviewed the current revision and my proposed changes.</label>
    ${button('reviewed-save', 'Save reviewed changes')}` : householdCanUpdate(state.workspace)
      ? '<p>Your proposed draft remains here while the save is checked.</p>'
      : '<p>You can read this draft. Saving requires an editor content role and update permission.</p>'}</section>`;
}
export function renderHouseholdObjects(state: HouseholdObjectsState): string {
  const { workspace } = state;
  const object = selectedHouseholdObject(state);
  const busy = state.save_state === 'saving' || state.save_state === 'pending' || state.save_state === 'unknown';
  const canEdit = householdCanUpdate(workspace) && !busy && state.save_state !== 'conflict';
  const content = state.opened_version?.content ?? object?.current.content ?? null;
  const capabilities = HOUSEHOLD_CONTENT_OPERATIONS.filter((operation) => workspace.operations.includes(operation)
    && (operation === 'read' || workspace.content_role === 'editor'));
  return `<header><p class="hh-eyebrow">Household objects</p><h2>${esc(workspace.name)}</h2>
    <p>Audience: ${esc(workspace.audience.join(', ') || 'Audience has not been loaded')}.</p>
    <p>Content role: <strong>${esc(workspace.content_role ?? 'Not confirmed')}</strong>. Approved operations: ${esc(capabilities.join(', ') || 'none')}.</p>
    <p>Members can read shared objects and retained history. Administration is separate from your content role.</p></header>
    <p role="status" aria-live="polite" aria-atomic="true" class="hh-status">${esc(state.notice)}</p>
    <div class="hh-layout"><nav aria-label="Household objects">${workspace.objects.length ? `<ul>${workspace.objects.map((item) =>
      `<li>${button('select', `${item.current.title} · ${item.kind}`, item.object_id, busy)}</li>`).join('')}</ul>` : '<p>No objects are loaded in this workspace.</p>'}</nav>
    <article aria-label="Selected object">${object ? `<h3>${esc(object.current.title)}</h3>
      <p>${esc(householdAttribution((state.opened_version ?? object.current).author))}</p>
      ${state.opened_version ? '<p>Reading an earlier revision.</p>' : '<p>Current revision</p>'}
      ${renderHouseholdContent(content)}
      ${!content ? button('revision', 'Open current revision', object.current.revision.token, busy) : ''}
      ${canEdit && !state.opened_version && content?.kind === 'doc' ? `<label class="hh-editor">Edit document
        <textarea data-hh-document rows="8">${esc(state.proposed?.kind === 'doc' ? state.proposed.markdown : content.markdown)}</textarea></label>${button('save', 'Save document')}` : ''}
      ${canEdit && !state.opened_version && content?.kind === 'list' ? content.items.map((item) => button('toggle', `${item.checked ? 'Uncheck' : 'Check'} ${item.text}`, item.item_id)).join('') : ''}
      ${!householdCanUpdate(workspace) ? '<p>You can read objects and history. Saving requires an editor content role and update permission.</p>' : ''}
      ${state.opened_version ? button('current', 'Back to current revision', '', busy) : ''}
      ${renderHouseholdConflict(state)}
      ${busy && state.proposed ? `<section aria-label="Unsaved local changes"><h4>Your local changes</h4>${renderHouseholdContent(state.proposed)}</section>` : ''}
      ${state.save_state === 'unknown' || state.save_state === 'pending' ? button('check-save', 'Check this save') : ''}
      ${renderHouseholdObjectHistory(object, busy)}` : '<p>Select a list, document or file to read it.</p>'}</article></div>`;
}

/** Produce an explicit before-value patch. This never silently replaces a newer revision. */
export function householdContentPatch(base: HouseholdContent, proposed: HouseholdContent): HouseholdPatch | null {
  if (base.kind === 'doc' && proposed.kind === 'doc') return { kind: 'doc', splices: [{ start: 0, before: base.markdown, after: proposed.markdown }] };
  if (base.kind !== 'list' || proposed.kind !== 'list') return null;
  if (new Set(proposed.items.map((item) => item.item_id)).size !== proposed.items.length) return null;
  const operations: HouseholdListPatch[] = [];
  const working = [...base.items].sort((a, b) => a.order - b.order).map((item) => ({ ...item }));
  for (const item of [...working]) if (!proposed.items.some((next) => next.item_id === item.item_id)) {
    operations.push({ kind: 'remove', item_id: item.item_id, before_text: item.text, before_checked: item.checked });
    working.splice(working.findIndex((next) => next.item_id === item.item_id), 1);
  }
  const wanted = [...proposed.items].sort((a, b) => a.order - b.order);
  wanted.forEach((item, index) => {
    const found = working.findIndex((next) => next.item_id === item.item_id);
    const after = wanted[index - 1]?.item_id ?? null;
    if (found < 0) {
      operations.push({ kind: 'add', item_id: item.item_id, text: item.text, checked: item.checked, after_item_id: after });
      working.splice(index, 0, { ...item });
    } else {
      const old = working[found]!;
      if (old.text !== item.text || old.checked !== item.checked) operations.push({ kind: 'set', item_id: item.item_id,
        before_text: old.text, before_checked: old.checked, text: item.text, checked: item.checked });
      if (found !== index) {
        operations.push({ kind: 'move', item_id: item.item_id, before_order: found, after_item_id: after });
        working.splice(found, 1); working.splice(index, 0, { ...item });
      }
    }
  });
  return { kind: 'list', operations };
}

/** No transport, storage, automatic retries or browser globals. Async replies are
 * scoped to a workspace generation so switching away and back cannot revive them.
 * These UI guards complement backend enforcement; they do not grant access.
 */
export function createHouseholdObjectsController(workspace: HouseholdWorkspaceView, actions: HouseholdActions,
  requestId: () => string = () => crypto.randomUUID()) {
  let state = createHouseholdObjectsState(workspace);
  let generation = 0;
  let readGeneration = 0;
  let request: HouseholdSaveRequest | null = null;
  const listeners = new Set<(state: HouseholdObjectsState) => void>();
  const publish = () => { for (const listener of listeners) listener(structuredClone(state)); };
  const locked = () => ['saving', 'pending', 'unknown'].includes(state.save_state);
  async function send() {
    if (!request || !householdCanUpdate(state.workspace) || state.save_state === 'saving') return false;
    const active = generation;
    readGeneration++;
    const outgoing = structuredClone(request);
    state.save_state = 'saving'; state.notice = 'Saving. A committed result has not arrived yet.'; publish();
    let outcome: SaveOutcome;
    try { outcome = await actions.save(outgoing); } catch { outcome = { status: 'unknown' }; }
    if (active !== generation) return false;
    if (outcome.status !== 'refused' && outcome.status !== 'unknown' && outcome.object_id !== outgoing.object_id) outcome = { status: 'unknown' };
    if (outcome.status === 'committed' && !bound(outcome.revision, outgoing.workspace_id, outgoing.object_id)) outcome = { status: 'unknown' };
    if (outcome.status === 'conflict' && (!bound(outcome.current, outgoing.workspace_id, outgoing.object_id)
      || sameRef(outcome.current, outgoing.base))) outcome = { status: 'unknown' };
    state.save_state = outcome.status;
    if (outcome.status === 'committed') {
      // Do not manufacture attribution, content or a server timestamp from a receipt.
      state.notice = 'Saved. Reload the object to read the committed revision.';
      state.proposed = null; state.conflict = null; state.draft_id = null; state.conflict_current = null;
      state.workspace.objects = state.workspace.objects.filter((object) => object.object_id !== outgoing.object_id);
      state.selected_id = null; request = null;
    } else if (outcome.status === 'conflict') {
      state.draft_id = outcome.draft_id; state.conflict_current = outcome.current; state.conflict = null; request = null;
      state.notice = 'Another revision was saved first. Your draft was retained. Recover it and review the changes.';
    } else if (outcome.status === 'pending') state.notice = 'This save is pending. Check it again to find out whether it committed.';
    else if (outcome.status === 'refused') { state.notice = `This save was refused (${outcome.reason}). Your local changes remain here.`; request = null; }
    else state.notice = 'The save result is unknown. Your local changes remain here. Check this save before making another change.';
    publish(); return true;
  }
  function stage(proposed: HouseholdContent): boolean {
    const object = selectedHouseholdObject(state);
    if (!object || !householdCanUpdate(state.workspace) || locked() || state.opened_version || state.save_state === 'conflict'
      || proposed.kind !== object.kind || proposed.kind === 'file') return false;
    state.proposed = structuredClone(proposed); return true;
  }
  return {
    getState: () => structuredClone(state),
    subscribe(listener: (state: HouseholdObjectsState) => void) { listeners.add(listener); listener(structuredClone(state)); return () => { listeners.delete(listener); }; },
    switchWorkspace(next: HouseholdWorkspaceView) { generation++; readGeneration++; request = null; state = createHouseholdObjectsState(next); publish(); },
    select(objectId: string) {
      if (locked() || !state.workspace.objects.some((object) => object.object_id === objectId)) return false;
      generation++; readGeneration++; request = null;
      state = { ...state, selected_id: objectId, opened_version: null, proposed: null, conflict: null, draft_id: null,
        conflict_current: null, save_state: 'idle', notice: '' }; publish(); return true;
    },
    stage,
    /** Hydrate an authorized retained-draft receipt after reload or a role change.
     * Recovery is a read; readers may recover their own draft but cannot save it.
     */
    restoreDraft(draftId: string, current: HouseholdRevisionRef) {
      const object = selectedHouseholdObject(state);
      if (!object || locked() || !draftId || !bound(current, state.workspace.workspace_id, object.object_id)) return false;
      readGeneration++; request = null; state.draft_id = draftId; state.conflict_current = structuredClone(current);
      state.conflict = null; state.save_state = 'conflict'; state.notice = 'Your retained draft is available to recover and review.';
      publish(); return true;
    },
    async save(reviewed = false) {
      if (!householdCanUpdate(state.workspace) || locked() || state.opened_version) return false;
      const object = selectedHouseholdObject(state);
      if (!object) return false;
      if (state.save_state === 'conflict' && (!reviewed || !state.conflict)) return false;
      const base = state.conflict?.current ?? object.current;
      const proposed = state.conflict?.proposed ?? state.proposed;
      if (!base.content || !proposed) return false;
      const patch = householdContentPatch(base.content, proposed);
      if (!patch) return false;
      request = { request_id: requestId(), workspace_id: state.workspace.workspace_id, object_id: object.object_id,
        base: structuredClone(base.revision), patch };
      return send();
    },
    async checkSave() { return state.save_state === 'pending' || state.save_state === 'unknown' ? send() : false; },
    async openRevision(token: string) {
      if (locked()) return false;
      const object = selectedHouseholdObject(state);
      const version = object?.history.find((entry) => entry.revision.token === token)
        ?? (object?.current.revision.token === token ? object.current : null);
      if (!object || !version) return false;
      const active = generation, read = ++readGeneration;
      try {
        const content = version.content ?? await actions.readRevision(structuredClone(version.revision));
        if (active !== generation || read !== readGeneration || content.kind !== object.kind) return false;
        if (sameRef(version.revision, object.current.revision)) { object.current.content = structuredClone(content); state.opened_version = null; }
        else state.opened_version = { ...structuredClone(version), content: structuredClone(content) };
        publish(); return true;
      } catch { if (active === generation && read === readGeneration) { state.notice = 'This revision could not be loaded. Try opening it again.'; publish(); } return false; }
    },
    backToCurrent() { if (locked()) return false; readGeneration++; state.opened_version = null; publish(); return true; },
    async recoverDraft() {
      if (!state.draft_id || state.save_state !== 'conflict' || !state.conflict_current) return false;
      const active = generation, read = ++readGeneration, draftId = state.draft_id;
      try {
        const conflict = await actions.recoverDraft(state.workspace.workspace_id, draftId);
        if (active !== generation || read !== readGeneration) return false;
        const object = selectedHouseholdObject(state);
        if (!object || conflict.workspace_id !== state.workspace.workspace_id || conflict.object_id !== object.object_id
          || conflict.owner_user_id !== state.workspace.viewer_user_id || conflict.draft_id !== draftId
          || !bound(conflict.base.revision, state.workspace.workspace_id, object.object_id)
          || !sameRef(conflict.current.revision, state.conflict_current!)
          || conflict.base.content?.kind !== object.kind || conflict.current.content?.kind !== object.kind || conflict.proposed.kind !== object.kind) return false;
        state.conflict = structuredClone(conflict); publish(); return true;
      } catch { if (active === generation && read === readGeneration) { state.notice = 'Your retained draft could not be loaded. Try recovering it again.'; publish(); } return false; }
    },
    async moreHistory() {
      const object = selectedHouseholdObject(state);
      if (!object || locked() || object.next_history_cursor === null || !actions.readHistory) return false;
      const active = generation, read = ++readGeneration;
      try {
        const page = await actions.readHistory(state.workspace.workspace_id, object.object_id, object.next_history_cursor);
        if (active !== generation || read !== readGeneration || page.revisions.some((version) =>
          !bound(version.revision, state.workspace.workspace_id, object.object_id) || (version.content && version.content.kind !== object.kind))) return false;
        object.history = [...object.history, ...structuredClone(page.revisions).filter((version) => !object.history.some((old) => sameRef(old.revision, version.revision)))];
        object.next_history_cursor = page.next_cursor; publish(); return true;
      } catch { if (active === generation && read === readGeneration) { state.notice = 'More history could not be loaded. Try again.'; publish(); } return false; }
    },
  };
}
export type HouseholdObjectsController = ReturnType<typeof createHouseholdObjectsController>;

/** Called explicitly by the future integration writer. Astro function props do
 * not survive static rendering, so callbacks are injected here, never serialized.
 * The shared escaped renderer is also used by all three Astro components.
 */
export function mountHouseholdObjects(root: HTMLElement, controller: HouseholdObjectsController): () => void {
  const unsubscribe = controller.subscribe((state) => {
    const active = root.ownerDocument.activeElement;
    const focused = active instanceof HTMLElement && root.contains(active) ? active : null;
    const action = focused?.dataset.hhAction, value = focused?.dataset.hhValue;
    root.innerHTML = renderHouseholdObjects(state);
    if (focused) {
      const replacement = [...root.querySelectorAll<HTMLButtonElement>('button[data-hh-action]')]
        .find((button) => button.dataset.hhAction === action && button.dataset.hhValue === value && !button.disabled);
      const fallback = root.querySelector<HTMLElement>('article h3') ?? root.querySelector<HTMLElement>('[role="status"]');
      if (replacement) replacement.focus();
      else if (fallback) { fallback.tabIndex = -1; fallback.focus(); }
    }
  });
  const click = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-hh-action]') : null;
    if (!target || !root.contains(target) || target.disabled) return;
    const value = target.dataset.hhValue ?? '';
    switch (target.dataset.hhAction) {
      case 'select': controller.select(value); break;
      case 'revision': void controller.openRevision(value); break;
      case 'current': controller.backToCurrent(); break;
      case 'save': void controller.save(); break;
      case 'check-save': void controller.checkSave(); break;
      case 'recover': void controller.recoverDraft(); break;
      case 'history': void controller.moreHistory(); break;
      case 'reviewed-save': void controller.save(root.querySelector<HTMLInputElement>('[data-hh-review]')?.checked === true); break;
      case 'toggle': {
        const content = selectedHouseholdObject(controller.getState())?.current.content;
        if (content?.kind === 'list' && controller.stage({ kind: 'list', items: content.items.map((item) =>
          item.item_id === value ? { ...item, checked: !item.checked } : item) })) void controller.save();
        break;
      }
    }
  };
  const input = (event: Event) => {
    if (event.target instanceof HTMLTextAreaElement && event.target.matches('[data-hh-document]'))
      controller.stage({ kind: 'doc', markdown: event.target.value });
  };
  root.addEventListener('click', click); root.addEventListener('input', input);
  return () => { unsubscribe(); root.removeEventListener('click', click); root.removeEventListener('input', input); root.replaceChildren(); };
}

/** Synthetic fixture factory; never enabled by default in a product component. */
export function householdObjectsFixture(role: HouseholdContentRole = 'editor'): HouseholdWorkspaceView {
  const author: HouseholdAttribution = { user_id: 'person-a', principal_id: null, run_id: null, connection_id: null, grant_id: null };
  const version = (objectId: string, title: string, content: HouseholdContent, suffix: string): HouseholdVersionView => ({
    revision: { workspace_id: 'fixture-household', object_id: objectId, token: `fixture-revision-${suffix.padEnd(22, '0')}` },
    title, author: { ...author }, occurred_at_server: Date.UTC(2026, 9, 3), live: true, content,
  });
  const doc = version('weekend', 'Weekend notes', { kind: 'doc', markdown: '## Saturday\nBring a picnic. **Check the weather.**' }, 'doc-current');
  const retired = { ...version('weekend', 'Weekend notes', { kind: 'doc', markdown: 'Bring a picnic.' }, 'doc-base'), live: false };
  const list = version('groceries', 'Groceries', { kind: 'list', items: [
    { item_id: 'apples', text: 'Apples', order: 0, checked: false }, { item_id: 'bread', text: 'Bread', order: 1, checked: true },
  ] }, 'list');
  const file = version('guide', 'Appliance guide', { kind: 'file', name: 'oven-guide.pdf', media_type: 'application/pdf' }, 'file');
  doc.author = { ...author, principal_id: 'agent-a', run_id: 'run-a', connection_id: 'connection-a', grant_id: 'grant-a' };
  return { workspace_id: 'fixture-household', name: 'Our household', audience: ['Person A', 'Person B'], viewer_user_id: 'person-a',
    content_role: role, operations: [...HOUSEHOLD_CONTENT_OPERATIONS], objects: [
      { object_id: 'groceries', kind: 'list', current: list, history: [list], next_history_cursor: null },
      { object_id: 'weekend', kind: 'doc', current: doc, history: [retired, doc], next_history_cursor: null },
      { object_id: 'guide', kind: 'file', current: file, history: [file], next_history_cursor: null },
    ] };
}

export function householdConflictFixture(workspace = householdObjectsFixture()): HouseholdConflictView {
  const object = workspace.objects.find((item) => item.object_id === 'weekend');
  if (!object) throw new RangeError('The household fixture document is required');
  return { workspace_id: workspace.workspace_id, object_id: object.object_id, draft_id: 'draft-a', owner_user_id: workspace.viewer_user_id,
    base: structuredClone(object.current), current: { ...structuredClone(object.current),
      revision: { ...object.current.revision, token: 'fixture-revision-conflict-current' },
      author: { user_id: 'person-b', principal_id: null, run_id: null, connection_id: null, grant_id: null },
      occurred_at_server: object.current.occurred_at_server + 60_000,
      content: { kind: 'doc', markdown: 'Bring a picnic. Meet at noon.' } },
    proposed: { kind: 'doc', markdown: 'Bring fruit for the picnic.' } };
}
