// Assign picker and tag picker (UI-SPEC.md 2.4; lane T). The assign picker is a row of single-choice
// chips (Todo canvas); the tag picker is a listbox under the comment field. The pure parts (options,
// captions, keyboard models, @ parsing) are exported and tested in node; the builders put user text
// in through textContent only. The chips use a roving tab stop; the tag field keeps focus and points
// at the active row with aria-activedescendant.
import type { AgentVM, CapsuleVM, Id, PersonVM, PickOptionVM } from "./home-types";
import { agentOrb, capsule, personAvatar } from "./home-primitives";

export const PICK_PERSON_CAPTION = "Person · no line order";
export const PICK_DISCONNECTED_CAPTION = "Disconnected · nothing moves until it reconnects";
export const PICK_NOT_PICKING_UP_CAPTION = "Not picking up · nothing moves until it checks its messages";
export const TAG_HIGHLIGHT_FOOTER = "A tag here highlights the name. To ask them directly, write in chat.";
const ROLE_WORD: Readonly<Record<PersonVM["role"], string>> = { owner: "Owner", admin: "Admin", member: "Member" };
const OTHER_GROUP = "other";

/** Who can be picked: each person with their agents, plus agents whose owner left. */
export interface PickerPeople { groups: CapsuleVM[]; other?: AgentVM[] }
/** Facts the assign captions need. An unknown line count is left out; a measured zero shows "0 in line". */
export interface AssignFacts { lineCount?: (agentId: Id) => number | null; goesAsRequest?: (agentId: Id) => boolean }

/** You and your agents first, then everyone else by name. Input order is kept for agents. */
export function orderedGroups(groups: CapsuleVM[]): CapsuleVM[] {
  return [...groups].sort((a, b) => Number(b.person.you) - Number(a.person.you) || a.person.name.localeCompare(b.person.name));
}
/** First names, or full names where two people share one (UI-SPEC 2.3). Status lines, comments
 * and the picker trigger use the same names so "Sam Lee" stays "Sam Lee" after it is picked. */
export function personNames(groups: CapsuleVM[]): Map<Id, string> {
  const counts = new Map<string, number>();
  for (const { person } of groups) counts.set(person.firstName, (counts.get(person.firstName) ?? 0) + 1);
  return new Map(groups.map(({ person }) => [person.id, (counts.get(person.firstName) ?? 0) > 1 ? person.name : person.firstName]));
}
/** The picker labels: `personNames`, with "Tom (you)" for the viewer. */
export function personPickLabels(groups: CapsuleVM[]): Map<Id, string> {
  const names = personNames(groups);
  return new Map(groups.map(({ person }) => [person.id, person.you ? `${names.get(person.id)} (you)` : names.get(person.id)!]));
}

function disconnectedCaption(agent: AgentVM): string {
  return agent.state.word === "Not picking up" ? PICK_NOT_PICKING_UP_CAPTION : PICK_DISCONNECTED_CAPTION;
}
/** Caption under an agent in the assign picker. The owner is named through `names` by id
 * (`personNames`, UI-SPEC 2.3), so "Sam Lee" and "Sam Ortiz" stay apart; `ownerFirstName` is
 * the fallback when the id is not in `names`. */
export function assignAgentCaption(agent: AgentVM, facts: AssignFacts = {}, names?: ReadonlyMap<Id, string>): string {
  const owner = (agent.ownerId && names?.get(agent.ownerId)) || agent.ownerFirstName;
  if (!agent.yours && owner && facts.goesAsRequest?.(agent.id)) {
    const request = `Goes to ${owner} as a request`;
    return agent.state.kind === "disconnected" ? `${request} · ${agent.state.word}` : request;
  }
  if (agent.state.kind === "disconnected") return disconnectedCaption(agent);
  const count = facts.lineCount?.(agent.id);
  return typeof count === "number" ? `${agent.state.word} · ${count} in line` : agent.state.word;
}

/** Assign picker options. Agents whose owner left are not offered: nobody can answer for them. */
export function assignOptions(people: PickerPeople, facts: AssignFacts = {}): PickOptionVM[] {
  const groups = orderedGroups(people.groups); const labels = personPickLabels(groups); const names = personNames(groups);
  return groups.flatMap(({ person, agents }) => [
    { value: person.id, kind: "person" as const, label: labels.get(person.id)!, caption: PICK_PERSON_CAPTION, group: person.id, disabled: !!person.dashed },
    ...agents.map((agent) => ({ value: agent.id, kind: "agent" as const, label: agent.label, caption: assignAgentCaption(agent, facts, names),
      group: person.id, disabled: !!agent.dashed })),
  ]);
}
/** Tag picker options: the status word for agents, the role for people. */
export function tagOptions(people: PickerPeople): PickOptionVM[] {
  const groups = orderedGroups(people.groups); const labels = personPickLabels(groups);
  const agent = (a: AgentVM, group: Id) => ({ value: a.id, kind: "agent" as const, label: a.label, caption: a.state.word, group, disabled: !!a.dashed });
  return [
    ...groups.flatMap(({ person, agents }) => [
      { value: person.id, kind: "person" as const, label: labels.get(person.id)!, caption: ROLE_WORD[person.role], group: person.id, disabled: !!person.dashed },
      ...agents.map((a) => agent(a, person.id)),
    ]),
    ...(people.other ?? []).map((a) => agent(a, OTHER_GROUP)),
  ];
}
export function filterOptions(options: PickOptionVM[], query: string): PickOptionVM[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle)) : options;
}

// ---- Keyboard model (pure) ----
export interface PickerState { open: boolean; active: number | null }
export type PickerEffect = { kind: "select"; option: PickOptionVM } | { kind: "close"; restoreFocus: boolean } | null;
export interface PickerStep { state: PickerState; effect: PickerEffect; handled: boolean }
export const PICKER_CLOSED: PickerState = { open: false, active: null };

function step(options: PickOptionVM[], from: number | null, delta: 1 | -1): number | null {
  const count = options.length;
  if (!options.some((option) => !option.disabled)) return null;
  let index = from === null ? (delta === 1 ? -1 : count) : from;
  for (let tries = 0; tries < count; tries += 1) {
    index = (index + delta + count) % count;
    if (!options[index]!.disabled) return index;
  }
  return null;
}
/** Open on the current value when it can be picked, otherwise on the first option that can. */
export function pickerOpen(options: PickOptionVM[], current: Id | null = null): PickerState {
  const at = options.findIndex((option) => option.value === current && !option.disabled);
  return { open: true, active: at >= 0 ? at : step(options, null, 1) };
}
/** Up and Down move (wrapping, skipping disabled rows), Home and End jump, Enter picks,
 * Escape closes and asks for focus back on the trigger, Tab closes and lets focus move on. */
export function pickerKey(state: PickerState, key: string, options: PickOptionVM[], current: Id | null = null): PickerStep {
  const same = (handled: boolean): PickerStep => ({ state, effect: null, handled });
  if (!state.open) {
    if (key === "ArrowDown" || key === "Enter") return { state: pickerOpen(options, current), effect: null, handled: true };
    if (key === "ArrowUp") return { state: { open: true, active: step(options, null, -1) }, effect: null, handled: true };
    return same(false);
  }
  switch (key) {
    case "ArrowDown": return { state: { open: true, active: step(options, state.active, 1) }, effect: null, handled: true };
    case "ArrowUp": return { state: { open: true, active: step(options, state.active, -1) }, effect: null, handled: true };
    case "Home": return { state: { open: true, active: step(options, null, 1) }, effect: null, handled: true };
    case "End": return { state: { open: true, active: step(options, null, -1) }, effect: null, handled: true };
    case "Enter": {
      const option = state.active === null ? undefined : options[state.active];
      if (!option || option.disabled) return same(true);
      return { state: PICKER_CLOSED, effect: { kind: "select", option }, handled: true };
    }
    case "Escape": return { state: PICKER_CLOSED, effect: { kind: "close", restoreFocus: true }, handled: true };
    case "Tab": return { state: PICKER_CLOSED, effect: { kind: "close", restoreFocus: false }, handled: false };
    default: return same(false);
  }
}
/** A DOM-safe id that stays the same for the same option across renders. */
export function pickerOptionId(prefix: string, option: Pick<PickOptionVM, "kind" | "value">): string {
  return `${prefix}-${option.kind}-${option.value}`.replace(/[^A-Za-z0-9_-]/g, "_");
}
export function activeDescendant(prefix: string, state: PickerState, options: PickOptionVM[]): string | null {
  const option = state.open && state.active !== null ? options[state.active] : undefined;
  return option ? pickerOptionId(prefix, option) : null;
}

// ---- "@" in a text field (pure) ----
/** The "@word" being typed just before the caret; the same rule the composer uses. */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const match = text.slice(0, caret).match(/(?:^|\s)@([^@\s]*)$/);
  if (!match || match.index === undefined) return null;
  return { query: match[1]?.toLocaleLowerCase() ?? "", start: match.index + (match[0].startsWith("@") ? 0 : 1) };
}
export function insertTag(text: string, start: number, caret: number, label: string): { text: string; caret: number } {
  const tag = `@${label} `;
  return { text: `${text.slice(0, start)}${tag}${text.slice(caret)}`, caret: start + tag.length };
}
/** The text a pick writes after "@": the viewer's own "(you)" is for the picker only, not the body. */
export function tagLabel(option: Pick<PickOptionVM, "kind" | "label">): string {
  return option.kind === "person" ? option.label.replace(/ \(you\)$/u, "") : option.label;
}
/** Picked tags still in the body, once each, matched longest first ("@Nikki’s Muse" is not "@Nikki").
 * Tags deleted from the text are dropped. */
export function tagsInBody(body: string, picked: { id: Id; label: string }[]): { id: Id; label: string }[] {
  const seen = new Set<Id>();
  return commentSegments(body, picked).flatMap((piece) => piece.tag && !seen.has(piece.tag.id) ? (seen.add(piece.tag.id), [piece.tag]) : []);
}
const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** Split a comment body into plain text and tag pieces so tags can be highlighted with textContent.
 * A tag counts only as a whole word: "@NikkiNew" and "tom@Nikki" are not "@Nikki". */
export function commentSegments(body: string, tags: { id: Id; label: string }[]): { text: string; tag: { id: Id; label: string } | null }[] {
  const marks = [...tags].sort((a, b) => b.label.length - a.label.length).map((tag) => ({ tag, text: `@${tag.label}` }));
  const out: { text: string; tag: { id: Id; label: string } | null }[] = [];
  const whole = (start: number, end: number) => !WORD_CHAR.test(body[start - 1] ?? "") && !WORD_CHAR.test(body[end] ?? "");
  let plain = ""; let index = 0;
  while (index < body.length) {
    const hit = marks.find((mark) => mark.text.length > 1 && body.startsWith(mark.text, index) && whole(index, index + mark.text.length));
    if (hit) { if (plain) out.push({ text: plain, tag: null }); plain = ""; out.push({ text: hit.text, tag: hit.tag }); index += hit.text.length; }
    else { plain += body[index]; index += 1; }
  }
  if (plain) out.push({ text: plain, tag: null });
  return out;
}

// ---- DOM ----
function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
const isAgentVM = (who: PersonVM | AgentVM): who is AgentVM => "state" in who;
function whoIndex(people: PickerPeople): Map<string, PersonVM | AgentVM> {
  const index = new Map<string, PersonVM | AgentVM>();
  for (const { person, agents } of people.groups) { index.set(`person:${person.id}`, person); for (const agent of agents) index.set(`agent:${agent.id}`, agent); }
  for (const agent of people.other ?? []) index.set(`agent:${agent.id}`, agent);
  return index;
}

/** One option row: orb or avatar, the label, and the caption. Integration reuses it in the
 * composer's mention listbox; `id` and `active` let that listbox keep its own hooks. */
export function tagOptionRow(doc: Document, option: PickOptionVM, opts: { id?: string; active?: boolean; who?: PersonVM | AgentVM } = {}): HTMLElement {
  const row = node(doc, "div", "hm-pick-option");
  row.setAttribute("role", "option");
  if (opts.id) row.id = opts.id;
  row.setAttribute("aria-selected", String(!!opts.active));
  if (option.disabled) row.setAttribute("aria-disabled", "true");
  row.dataset.pickValue = option.value; row.dataset.pickKind = option.kind;
  const who = opts.who;
  // The measured state colours the caption (a disconnected agent's caption reads in the offline ink).
  if (who && isAgentVM(who)) row.dataset.pickState = who.state.kind;
  const mark = who ? (isAgentVM(who) ? agentOrb(doc, who, { size: 28, badge: true }) : personAvatar(doc, who, 28))
    : node(doc, "span", "hm-pick-letter", option.label.trim().slice(0, 1).toLocaleUpperCase() || "?");
  mark.setAttribute("aria-hidden", "true");
  const copy = node(doc, "span", "hm-pick-copy");
  copy.append(node(doc, "span", "hm-pick-label", option.label), node(doc, "span", "hm-pick-caption", option.caption));
  row.append(mark, copy);
  return row;
}

/** What a picker popover shows. `id` prefixes every element id; `footer` sits under the listbox.
 * `heading` shows `label` as a visible band above the list and names the listbox with it. */
export interface PickerListVM { id: string; label: string; options: PickOptionVM[]; people: PickerPeople; footer?: string | null; heading?: boolean }

function groupHead(doc: Document, people: PickerPeople, group: Id, headId: string): HTMLElement {
  const head = node(doc, "div", "hm-pick-group-head"); head.id = headId;
  const capsuleVM = people.groups.find((entry) => entry.person.id === group);
  if (capsuleVM) {
    const pill = capsule(doc, capsuleVM, { compact: true }); pill.setAttribute("aria-hidden", "true");
    const labels = personPickLabels(people.groups);
    head.append(pill, node(doc, "span", "hm-pick-group-name", labels.get(group) ?? capsuleVM.person.name));
  } else head.append(node(doc, "span", "hm-pick-group-name", "Other agents"));
  return head;
}

/** The popover: a listbox grouped by person, then an optional footer outside the listbox. */
export function pickerList(doc: Document, vm: PickerListVM, state: PickerState, onPick: (option: PickOptionVM) => void): HTMLElement {
  const pop = node(doc, "div", "hm-picker-pop"); pop.dataset.pickerPop = vm.id;
  const list = node(doc, "div", "hm-pick-list"); list.id = `${vm.id}-listbox`;
  list.setAttribute("role", "listbox");
  if (vm.heading) {
    // The same name as aria-label, now visible: the band at the top of the card.
    const head = node(doc, "div", "hm-pick-heading", vm.label); head.id = `${vm.id}-heading`;
    list.setAttribute("aria-labelledby", head.id); pop.append(head);
  } else list.setAttribute("aria-label", vm.label);
  const who = whoIndex(vm.people);
  let group: HTMLElement | null = null; let groupId: Id | null = null;
  vm.options.forEach((option, index) => {
    if (!group || option.group !== groupId) {
      groupId = option.group; group = node(doc, "div", "hm-pick-group"); group.setAttribute("role", "group");
      const headId = `${vm.id}-group-${option.group}`.replace(/[^A-Za-z0-9_-]/g, "_");
      group.setAttribute("aria-labelledby", headId);
      group.append(groupHead(doc, vm.people, option.group, headId)); list.append(group);
    }
    const row = tagOptionRow(doc, option, { id: pickerOptionId(vm.id, option), active: state.active === index, who: who.get(`${option.kind}:${option.value}`) });
    if (state.active === index) row.dataset.active = "";
    row.addEventListener("pointerdown", (event) => event.preventDefault());
    row.addEventListener("click", () => { if (!option.disabled) onPick(option); });
    group!.append(row);
  });
  pop.append(list);
  if (vm.footer) pop.append(node(doc, "p", "hm-pick-footer", vm.footer));
  pop.hidden = !state.open;
  return pop;
}

export interface AssignPickerVM extends PickerListVM { current: string; currentValue: Id | null; labelledBy?: string; sample?: boolean; disabled?: boolean }

// ---- Assign chips: keyboard model (pure) ----
/** The chip that takes the one tab stop: the recorded assignee when it can be picked, otherwise the first chip that can. */
export function chipStop(options: PickOptionVM[], current: Id | null = null): number | null {
  const at = options.findIndex((option) => option.value === current && !option.disabled);
  return at >= 0 ? at : step(options, null, 1);
}
export interface ChipStep { focus: number | null; select: PickOptionVM | null; handled: boolean }
/** A single-choice group with manual selection: the arrow keys move focus only (wrapping, skipping
 * disabled chips), Home and End jump, Space and Enter pick the focused chip. A pick is a write, so
 * moving never picks. */
export function chipKey(options: PickOptionVM[], from: number | null, key: string): ChipStep {
  const move = (focus: number | null): ChipStep => ({ focus, select: null, handled: true });
  switch (key) {
    case "ArrowRight": case "ArrowDown": return move(step(options, from, 1));
    case "ArrowLeft": case "ArrowUp": return move(step(options, from, -1));
    case "Home": return move(step(options, null, 1));
    case "End": return move(step(options, null, -1));
    case " ": case "Enter": {
      const option = from === null ? undefined : options[from];
      return { focus: from, select: option && !option.disabled ? option : null, handled: true };
    }
    default: return { focus: from, select: null, handled: false };
  }
}

/** The assign picker: every person and agent who can be assigned, as chips grouped in their
 * person's capsule (Todo canvas). One radiogroup named by the panel heading; each chip is a
 * role="radio" button with one roving tab stop, and aria-checked marks the recorded assignee.
 * The chip shows the short name inside its owner's capsule; its accessible name is the full
 * label ("Your Claude"), and the caption the old list showed is its description. In sample mode,
 * or without permission, it is plain text. */
export function assignPicker(doc: Document, vm: AssignPickerVM, onPick: (option: PickOptionVM) => void): HTMLElement {
  const root = node(doc, "div", "hm-picker"); root.dataset.assignPicker = vm.id;
  if (vm.sample || vm.disabled) { root.append(node(doc, "span", "hm-picker-value", vm.current)); return root; }
  const group = node(doc, "div", "hm-assign-chips"); group.id = `${vm.id}-group`;
  group.setAttribute("role", "radiogroup");
  if (vm.labelledBy) group.setAttribute("aria-labelledby", vm.labelledBy); else group.setAttribute("aria-label", vm.label);
  const who = whoIndex(vm.people);
  const chips: HTMLButtonElement[] = [];
  let focus = chipStop(vm.options, vm.currentValue);
  const rove = (index: number | null) => {
    focus = index;
    chips.forEach((chip, at) => { chip.tabIndex = at === index ? 0 : -1; });
    if (index !== null) chips[index]?.focus();
  };
  let capsule: HTMLElement | null = null; let capsuleGroup: Id | null = null;
  vm.options.forEach((option, index) => {
    if (!capsule || option.group !== capsuleGroup) {
      capsuleGroup = option.group; capsule = node(doc, "div", "hm-assign-capsule"); group.append(capsule);
    }
    const id = pickerOptionId(vm.id, option);
    const chip = node(doc, "button", "hm-assign-chip"); chip.type = "button"; chip.id = id;
    chip.setAttribute("role", "radio"); chip.setAttribute("aria-checked", String(option.value === vm.currentValue));
    chip.setAttribute("aria-label", option.label); chip.setAttribute("aria-describedby", `${id}-caption`);
    chip.tabIndex = index === focus ? 0 : -1;
    chip.dataset.pickValue = option.value; chip.dataset.pickKind = option.kind;
    if (option.disabled) chip.setAttribute("aria-disabled", "true");
    const person = who.get(`${option.kind}:${option.value}`);
    if (person && isAgentVM(person)) chip.dataset.pickState = person.state.kind;
    // Inside the owner's capsule the owner badge would repeat what the capsule already says.
    const mark = person ? (isAgentVM(person) ? agentOrb(doc, person, { size: 28, badge: false }) : personAvatar(doc, person, 28))
      : node(doc, "span", "hm-pick-letter", option.label.trim().slice(0, 1).toLocaleUpperCase() || "?");
    mark.setAttribute("aria-hidden", "true");
    const shown = person && isAgentVM(person) ? person.nestedLabel || option.label : option.label;
    const caption = node(doc, "span", "hm-assign-caption", option.caption); caption.id = `${id}-caption`;
    chip.append(mark, node(doc, "span", "hm-assign-name", shown), caption);
    chip.addEventListener("click", () => { if (option.disabled) return; rove(index); onPick(option); });
    chip.addEventListener("keydown", (event) => {
      const result = chipKey(vm.options, index, event.key);
      if (!result.handled) return;
      event.preventDefault();
      if (result.select) onPick(result.select);
      else if (result.focus !== index) rove(result.focus);
    });
    chips.push(chip); capsule!.append(chip);
  });
  root.append(group);
  return root;
}

export interface TagPickerVM { id: string; label: string; options: PickOptionVM[]; people: PickerPeople; tagDelivers: boolean }

/** Wire a comment field to the tag picker, opened by "@". Returns the popover to place after the
 * field. A pick writes "@Label " into the text and reports the option; when tags do not deliver,
 * the footer says the tag only highlights the name. */
export function tagPicker(doc: Document, field: HTMLInputElement | HTMLTextAreaElement, vm: TagPickerVM, onPick: (option: PickOptionVM) => void): HTMLElement {
  field.setAttribute("role", "combobox"); field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-haspopup", "listbox"); field.setAttribute("aria-controls", `${vm.id}-listbox`);
  field.setAttribute("aria-expanded", "false");
  const footer = vm.tagDelivers ? null : TAG_HIGHLIGHT_FOOTER;
  let state: PickerState = PICKER_CLOSED; let shown: PickOptionVM[] = [];
  const list = (): PickerListVM => ({ id: vm.id, label: vm.label, options: shown, people: vm.people, footer, heading: true });
  const holder = node(doc, "div", "hm-tag-picker");
  let pop = pickerList(doc, list(), state, (option) => choose(option)); holder.append(pop);
  const render = () => {
    const opening = state.open && field.getAttribute("aria-expanded") !== "true";
    const next = pickerList(doc, list(), state, (option) => choose(option)); pop.replaceWith(next); pop = next;
    field.setAttribute("aria-expanded", String(state.open));
    // The card sits in the flow above the field (Todo canvas), so opening it pushes the field down:
    // keep the field the person is typing in on screen.
    if (opening) field.scrollIntoView?.({ block: "nearest" });
    const id = activeDescendant(vm.id, state, shown);
    if (id) field.setAttribute("aria-activedescendant", id); else field.removeAttribute("aria-activedescendant");
    if (id) doc.getElementById(id)?.scrollIntoView?.({ block: "nearest" });
  };
  const refresh = () => {
    const search = mentionQuery(field.value, field.selectionStart ?? field.value.length);
    shown = search ? filterOptions(vm.options, search.query) : [];
    state = search && shown.length ? pickerOpen(shown) : PICKER_CLOSED; render();
  };
  const choose = (option: PickOptionVM) => {
    const caret = field.selectionStart ?? field.value.length; const search = mentionQuery(field.value, caret);
    if (search) { const next = insertTag(field.value, search.start, caret, tagLabel(option)); field.value = next.text; field.setSelectionRange(next.caret, next.caret); }
    state = PICKER_CLOSED; shown = []; render(); field.focus(); onPick(option);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  field.addEventListener("input", refresh);
  // A re-render restores the draft and its caret without an input event, then gives focus back:
  // open on what is already typed, so "Thanks. @" still shows its list.
  field.addEventListener("focus", refresh);
  field.addEventListener("keydown", (event) => {
    if (!state.open) return;
    const key = (event as KeyboardEvent).key;
    const result = pickerKey(state, key, shown);
    if (result.handled) event.preventDefault();
    if (result.handled && key === "Escape") event.stopPropagation();
    state = result.state; render();
    if (result.effect?.kind === "select") choose(result.effect.option);
  });
  field.addEventListener("blur", () => { if (state.open) { state = PICKER_CLOSED; render(); } });
  return holder;
}
