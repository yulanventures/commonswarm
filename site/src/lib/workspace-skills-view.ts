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
}

const esc = escapeMessageHtml;

export function renderWorkspaceSkillsHtml(data: WorkspaceSkillsViewData): string {
  const countText = `${data.skills.length}/${data.cap}`;
  const suggestionsHtml = data.can_edit && data.suggestions.length > 0
    ? `<div class="hh-skills-suggestions" data-skills-suggestions>
        <h4>Suggested from recent tasks</h4>
        <ul class="hh-list">
          ${data.suggestions.map((s) => `
            <li data-suggestion-id="${esc(s.suggestion_id)}">
              <strong>${esc(s.title)}</strong>
              <div><small>${esc(s.when_to_use)}</small></div>
              <p>${esc(s.body)}</p>
              <div>
                <button type="button" data-skill-action="keep" data-skill-target="${esc(s.suggestion_id)}">Keep</button>
                <button type="button" data-skill-action="dismiss" data-skill-target="${esc(s.suggestion_id)}">Dismiss</button>
              </div>
            </li>
          `).join('')}
        </ul>
      </div>`
    : '';

  const listHtml = data.skills.length === 0
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

  const formHtml = data.can_edit
    ? `<form class="hh-editor" data-skill-form>
        <h4>Add skill</h4>
        <input type="text" name="title" maxlength="120" placeholder="Title" required data-skill-input-title />
        <input type="text" name="when_to_use" maxlength="200" placeholder="When to use (one line)" required data-skill-input-when />
        <textarea name="body" rows="3" maxlength="1500" placeholder="Procedure or pitfall (general wording, no @handles or emails)" required data-skill-input-body></textarea>
        <div>
          <button type="submit" data-skill-action="save">Add skill</button>
        </div>
      </form>`
    : '';

  const noticeHtml = data.notice
    ? `<p class="hh-status" role="status" data-skills-notice>${esc(data.notice)}</p>`
    : '';

  return `<header>
      <p class="hh-eyebrow">Hints, never gates · ${esc(countText)} · ${data.ttl_days}d expiry</p>
      <h3>Skills</h3>
    </header>
    ${noticeHtml}
    ${suggestionsHtml}
    ${listHtml}
    ${formHtml}`;
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
  };

  const paint = () => {
    if (disposed) return;
    container.innerHTML = renderWorkspaceSkillsHtml(state);
  };

  const refresh = async (notice = '', opened?: WorkspaceSkillView | null) => {
    const res = await call({ kind: 'household_skills', action: 'list' }, crypto.randomUUID());
    if (disposed || res.status !== 'ok') return;
    state = {
      cap: typeof res.cap === 'number' ? res.cap : 20,
      ttl_days: typeof res.ttl_days === 'number' ? res.ttl_days : 60,
      can_edit: canEdit,
      skills: Array.isArray(res.skills) ? res.skills as WorkspaceSkillSummary[] : [],
      suggestions: Array.isArray(res.suggestions) ? res.suggestions as WorkspaceSkillSuggestion[] : [],
      opened_skill: opened !== undefined ? opened : state.opened_skill,
      notice,
    };
    paint();
  };

  const onClick = (event: Event) => {
    const btn = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-skill-action]') : null;
    if (!btn || !container.contains(btn) || btn.disabled) return;
    const action = btn.dataset.skillAction;
    const target = btn.dataset.skillTarget ?? '';
    if (action === 'read' && target) {
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
        await refresh('Skill saved.', res.skill as WorkspaceSkillView);
      } else {
        state = { ...state, notice: `Could not save skill (${String(res.reason ?? 'check wording')}).` };
        paint();
      }
    })();
  };

  container.addEventListener('click', onClick);
  container.addEventListener('submit', onSubmit);
  void refresh();

  return () => {
    disposed = true;
    container.removeEventListener('click', onClick);
    container.removeEventListener('submit', onSubmit);
    container.remove();
  };
}
