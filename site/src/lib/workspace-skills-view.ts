import { escapeMessageHtml } from './message-markdown.js';
import type { WorkspaceSkillSummary, WorkspaceSkillSuggestion, WorkspaceSkillView } from '../../../src/protocol/workspace-skills.js';

type Call = (command: Record<string, unknown>, requestId: string) => Promise<Record<string, unknown>>;

export interface WorkspaceSkillsViewData {
  readonly cap: number;
  readonly ttl_days: number;
  readonly can_edit: boolean;
  readonly skills: readonly WorkspaceSkillSummary[];
  readonly suggestions: readonly WorkspaceSkillSuggestion[];
  readonly opened_skill?: WorkspaceSkillView | null;
  readonly notice?: string;
  /** Where the list read stands. "ready" is the only state that may say there are no skills. Absent means ready. */
  readonly load?: 'loading' | 'ready' | 'failed' | 'unavailable';
  /** Whether the Add skill form is open, and which suggestions have their instructions showing. */
  readonly add_open?: boolean;
  readonly open_suggestions?: readonly string[];
}

const esc = escapeMessageHtml;

export function renderWorkspaceSkillsHtml(data: WorkspaceSkillsViewData): string {
  // How many of the allowed skills exist, said once there is at least one. The line that used to sit here ("Hints,
  // never gates · 0/20 · 60d expiry") spoke to the people who built Skills, not to the people who use them.
  const countHtml = data.skills.length > 0 ? `
      <p class="hh-skills-count" data-skills-count>${data.skills.length} of ${data.cap}</p>` : '';
  const load = data.load ?? 'ready';
  const ready = load === 'ready';
  // Saved skills come first. Only a read that answered may say there are none.
  const listHtml = !ready ? '' : data.skills.length === 0
    ? '<p data-skills-empty>No shared skills yet.</p>'
    : `<ul class="hh-list" data-skills-list>
        ${data.skills.map((skill) => {
          const isOpened = data.opened_skill?.skill_id === skill.skill_id;
          const tidyBadge = skill.stale_removal_candidate ? ' · <strong>Tidy: consider removing</strong>' : '';
          return `<li data-skill-id="${esc(skill.skill_id)}">
            <div>
              <strong>${esc(skill.title)}</strong> — <span>${esc(skill.when_to_use)}</span>
            </div>
            <div>
              <small>${esc(skill.used_label)} · ${esc(skill.unused_label)}${tidyBadge}</small>
            </div>
            ${isOpened && data.opened_skill ? `<pre class="hh-markdown" data-skill-body>${esc(data.opened_skill.body)}</pre>` : ''}
            <div>
              <button type="button" data-skill-action="read" data-skill-target="${esc(skill.skill_id)}">${isOpened ? 'Refresh' : 'Read'}</button>
              ${data.can_edit ? `<button type="button" data-skill-action="delete" data-skill-target="${esc(skill.skill_id)}">Delete</button>` : ''}
            </div>
          </li>`;
        }).join('')}
      </ul>`;

  // Add skill is one press away, under the saved skills: the three fields open on demand.
  const formHtml = ready && data.can_edit
    ? `<details class="hh-skills-add" data-skills-add${data.add_open ? ' open' : ''}>
      <summary>Add skill</summary>
      <form class="hh-editor" data-skill-form>
        <input type="text" name="title" maxlength="120" placeholder="Title" aria-label="Title" required data-skill-input-title />
        <input type="text" name="when_to_use" maxlength="200" placeholder="When to use (one line)" aria-label="When to use" required data-skill-input-when />
        <textarea name="body" rows="3" maxlength="1500" placeholder="Procedure or pitfall (general wording, no @handles or emails)" aria-label="Procedure or pitfall" required data-skill-input-body></textarea>
        <p class="hh-skills-rule" data-skills-rule>Use a new skill within 14 days to keep it. After its first use, it expires ${data.ttl_days} days after its last use or edit.</p>
        <div>
          <button type="submit" data-skill-action="save">Add skill</button>
        </div>
      </form>
    </details>`
    : '';

  // Suggestions follow, one title each. A suggestion's instructions show when its title is pressed.
  const openSuggestions = new Set(data.open_suggestions ?? []);
  const suggestionsHtml = ready && data.can_edit && data.suggestions.length > 0
    ? `<div class="hh-skills-suggestions" data-skills-suggestions>
        <h4>Suggested from recent tasks</h4>
        <ul class="hh-list">
          ${data.suggestions.map((s) => `
            <li data-suggestion-id="${esc(s.suggestion_id)}">
              <details data-suggestion-more="${esc(s.suggestion_id)}"${openSuggestions.has(s.suggestion_id) ? ' open' : ''}>
                <summary><strong>${esc(s.title)}</strong></summary>
                <div><small>${esc(s.when_to_use)}</small></div>
                <p>${esc(s.body)}</p>
              </details>
              <div>
                <button type="button" data-skill-action="keep" data-skill-target="${esc(s.suggestion_id)}">Keep</button>
                <button type="button" data-skill-action="dismiss" data-skill-target="${esc(s.suggestion_id)}">Dismiss</button>
              </div>
            </li>
          `).join('')}
        </ul>
      </div>`
    : '';

  // A read that failed says so and offers Retry; it never claims the workspace has no skills.
  const failedHtml = load === 'failed'
    ? `<p class="hh-status" role="alert" data-skills-failed>Could not load workspace skills.</p>
       <div><button type="button" data-skill-action="retry">Retry</button></div>`
    : load === 'loading' ? '<p class="hh-status" role="status" data-skills-loading>Loading skills…</p>' : '';

  const noticeHtml = data.notice
    ? `<p class="hh-status" role="status" data-skills-notice>${esc(data.notice)}</p>`
    : '';

  return `<header>
      <h3>Skills</h3>${countHtml}
    </header>
    ${noticeHtml}
    ${failedHtml}
    ${listHtml}
    ${formHtml}
    ${suggestionsHtml}`;
}

export function mountWorkspaceSkills(
  hostParent: HTMLElement,
  afterNode: HTMLElement,
  canEdit: boolean,
  call: Call,
): () => void {
  const doc = hostParent.ownerDocument;
  const container = doc.createElement('section');
  container.className = 'household-objects household-skills';
  container.setAttribute('aria-label', 'Workspace skills');
  container.dataset.householdSkills = '';
  hostParent.insertBefore(container, afterNode.nextSibling);

  let disposed = false;
  let state: WorkspaceSkillsViewData = {
    cap: 20,
    ttl_days: 60,
    can_edit: canEdit,
    skills: [],
    suggestions: [],
    opened_skill: null,
    notice: '',
    load: 'loading',
    add_open: false,
    open_suggestions: [],
  };

  const FIELDS = ['[data-skill-input-title]', '[data-skill-input-when]', '[data-skill-input-body]'] as const;
  /* A redraw replaces the markup. What the person has typed into Add skill is put back, so a refused save, reading a
     skill or a notice never wipes it. A saved skill clears it. */
  const paint = (clearDraft = false) => {
    if (disposed) return;
    const draft = clearDraft ? null : FIELDS.map((field) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(field)?.value ?? '');
    container.innerHTML = renderWorkspaceSkillsHtml(state);
    if (draft) FIELDS.forEach((field, index) => {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(field);
      if (input && draft[index]) input.value = draft[index]!;
    });
  };

  const refresh = async (notice = '', opened?: WorkspaceSkillView | null, clearDraft = false) => {
    try {
      const res = await call({ kind: 'household_skills', action: 'list' }, crypto.randomUUID());
      if (disposed) return;
      if (res.status !== 'ok') {
        // No access to Lists & docs here: say so, and show neither an empty claim nor a form that cannot save.
        state = {
          ...state,
          load: 'unavailable',
          notice: notice || 'Choose Lists & docs access in this workspace to view and edit shared skills.',
        };
        paint();
        return;
      }
      state = {
        load: 'ready',
        add_open: clearDraft ? false : state.add_open,
        open_suggestions: state.open_suggestions,
        cap: typeof res.cap === 'number' ? res.cap : 20,
        ttl_days: typeof res.ttl_days === 'number' ? res.ttl_days : 60,
        can_edit: canEdit,
        skills: Array.isArray(res.skills) ? res.skills as WorkspaceSkillSummary[] : [],
        suggestions: Array.isArray(res.suggestions) ? res.suggestions as WorkspaceSkillSuggestion[] : [],
        opened_skill: opened !== undefined ? opened : state.opened_skill,
        notice,
      };
      paint(clearDraft);
    } catch {
      if (disposed) return;
      // Keep what was already on screen if a later read fails; a first read that fails shows Retry alone.
      state = state.load === 'ready' ? { ...state, notice: 'Could not load workspace skills.' } : { ...state, load: 'failed', notice: '' };
      paint();
    }
  };

  const onClick = (event: Event) => {
    const btn = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-skill-action]') : null;
    if (!btn || !container.contains(btn) || btn.disabled) return;
    const action = btn.dataset.skillAction;
    const target = btn.dataset.skillTarget ?? '';
    if (action === 'retry') {
      state = { ...state, load: 'loading', notice: '' };
      paint();
      void refresh();
    } else if (action === 'read' && target) {
      void (async () => {
        const res = await call({ kind: 'household_skills', action: 'read', skill_id: target, count_use: false }, crypto.randomUUID());
        if (disposed) return;
        if (res.status === 'ok' && res.skill) {
          state = { ...state, opened_skill: res.skill as WorkspaceSkillView, notice: '' };
          paint();
        }
      })();
    } else if (action === 'delete' && target) {
      void (async () => {
        const res = await call({ kind: 'household_skills', action: 'delete', skill_id: target }, crypto.randomUUID());
        if (disposed) return;
        if (res.status === 'committed') {
          await refresh('Skill deleted.', state.opened_skill?.skill_id === target ? null : state.opened_skill);
        } else {
          state = { ...state, notice: `Could not delete skill (${String(res.reason ?? 'error')}).` };
          paint();
        }
      })();
    } else if (action === 'keep' && target) {
      void (async () => {
        const res = await call({ kind: 'household_skills', action: 'keep', suggestion_id: target }, crypto.randomUUID());
        if (disposed) return;
        if (res.status === 'committed') {
          await refresh('Suggestion kept as a workspace skill.');
        }
      })();
    } else if (action === 'dismiss' && target) {
      void (async () => {
        const res = await call({ kind: 'household_skills', action: 'dismiss', suggestion_id: target }, crypto.randomUUID());
        if (disposed) return;
        if (res.status === 'committed') {
          await refresh('Suggestion dismissed.');
        }
      })();
    }
  };

  const onSubmit = (event: Event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !container.contains(form) || !form.matches('[data-skill-form]')) return;
    event.preventDefault();
    const title = form.querySelector<HTMLInputElement>('[data-skill-input-title]')?.value.trim() ?? '';
    const when_to_use = form.querySelector<HTMLInputElement>('[data-skill-input-when]')?.value.trim() ?? '';
    const body = form.querySelector<HTMLTextAreaElement>('[data-skill-input-body]')?.value.trim() ?? '';
    void (async () => {
      const res = await call({ kind: 'household_skills', action: 'save', title, when_to_use, body }, crypto.randomUUID());
      if (disposed) return;
      if (res.status === 'committed') {
        await refresh('Skill saved.', res.skill as WorkspaceSkillView, true);
      } else {
        state = { ...state, notice: `Could not save skill (${String(res.reason ?? 'check wording')}).` };
        paint();
      }
    })();
  };

  /* Opening and closing is remembered, so a redraw does not close what the person opened. "toggle" does not bubble,
     so it is heard on the way down. */
  const onToggle = (event: Event) => {
    const details = event.target instanceof HTMLDetailsElement ? event.target : null;
    if (!details || !container.contains(details)) return;
    if (details.matches('[data-skills-add]')) state = { ...state, add_open: details.open };
    const suggestion = details.dataset.suggestionMore;
    if (suggestion) {
      const open = new Set(state.open_suggestions ?? []);
      if (details.open) open.add(suggestion); else open.delete(suggestion);
      state = { ...state, open_suggestions: [...open] };
    }
  };

  container.addEventListener('click', onClick);
  container.addEventListener('submit', onSubmit);
  container.addEventListener('toggle', onToggle, true);
  paint();
  void refresh();

  return () => {
    disposed = true;
    container.removeEventListener('click', onClick);
    container.removeEventListener('submit', onSubmit);
    container.removeEventListener('toggle', onToggle, true);
    container.remove();
  };
}
