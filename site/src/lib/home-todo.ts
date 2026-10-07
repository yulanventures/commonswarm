// The To-do view (UI-SPEC.md 3.4; lane T). A pure DOM builder: (doc, vm, callbacks) => HTMLElement.
// User and agent text goes in through textContent or an input value only. Controls render only
// where TodoVM.may allows them and never in sample mode; a hidden control makes no claim why.
import type { AgentVM, Id, PersonVM, PickOptionVM, TodoVM } from "./home-types";
import { agentOrb, choiceChips, lockIcon, notice, personAvatar } from "./home-primitives";
import { personTint } from "./home-names";
import { assignOptions, assignPicker, commentSegments, personNames, tagLabel, tagOptions, tagPicker, tagsInBody, type AssignFacts,
  type PickerPeople } from "./home-pickers";
import { TODO_RESULT_UNKNOWN, TODO_SAVE_FAILED, isAgent, personName, todoAssigneeLabel, todoMetaLine, todoStartChoice, todoStatus, todoSteerLine, whenStamp,
  type TodoCopyContext, type TodoNotice, type TodoStartMode } from "./home-todo-copy";

/** Local to lane T: what the view needs beyond TodoVM (home-types.ts has no type for it). */
export interface TodoViewVM {
  workspace: { name: string; todosHref: string; homeHref: string };
  view: { kind: "loading" } | { kind: "not-found" } | { kind: "ready"; todo: TodoVM };
  now: number; timeZone?: string;
  /** The assignee's receive sentence from agent-status, shown under the Start now receipt. */
  receive?: string | null;
  /** The notice outcome of the last Start now write (SERVER-PLAN A9 `notices[].status`); null or
   * absent when this page did not make that write. The status line never claims a message
   * without it or a delivery record. */
  notice?: TodoNotice | null;
  people: PickerPeople; facts?: AssignFacts;
  /** Other open to-dos in this workspace, for "Waiting on: another to-do". */
  openTodos: { id: Id; title: string }[];
  save: "idle" | "saving" | "failed" | "unknown";
}
export type TodoGateInput = { kind: "todo"; todoId: Id } | { kind: "time"; date: string; time: string } | { kind: "note"; note: string };
/** Dates and times are the native inputs' local values ("2026-10-09", "21:00"); integration converts. */
export type TodoStartInput = { mode: "queue" } | { mode: "now" } | { mode: "gated"; gate: TodoGateInput } | { mode: "at"; date: string; time: string };
export interface TodoViewCallbacks {
  back?: (event: MouseEvent) => void;
  complete: (done: boolean) => void;
  assign: (option: PickOptionVM) => void;
  setStart: (input: TodoStartInput) => void;
  comment: (body: string, tags: { id: Id; label: string }[]) => void;
}

export const TODO_LOADING = "Loading this to-do…";
/** Under the comment field when a tag delivers: the server sends each tagged person or agent a
 * note ("Mentioned you in a comment.", household-todo-policy.ts). When a tag only highlights, the
 * picker's own footer says so instead. */
export const TODO_TAG_NOTE = "A tag sends that person or agent a note that you mentioned them.";
const GATE_KINDS: { kind: TodoGateInput["kind"]; label: string }[] = [
  { kind: "todo", label: "Another to-do" }, { kind: "time", label: "A date and time" }, { kind: "note", label: "A note" },
];

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(doc: Document, text: string, className: string, type: "button" | "submit" = "button"): HTMLButtonElement {
  const element = node(doc, "button", className, text); element.type = type; return element;
}
function field(doc: Document, label: string, input: HTMLElement): HTMLLabelElement {
  const wrap = node(doc, "label", "hm-todo-field"); wrap.append(node(doc, "span", "hm-todo-field-label", label), input); return wrap;
}
function input(doc: Document, type: string, value = ""): HTMLInputElement {
  const element = node(doc, "input", "hm-todo-input"); element.type = type; element.value = value; return element;
}
function backIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", stroke: "currentColor",
    "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(name, value);
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M10 3L5 8l5 5");
  svg.append(path); return svg;
}
/** Local date and time input values for an ISO moment (the browser's own zone, like the inputs). */
function localInputs(iso: string | null | undefined): { date: string; time: string } {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return { date: "", time: "" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}` };
}
const mark = (doc: Document, who: PersonVM | AgentVM, size = 28) => isAgent(who) ? agentOrb(doc, who, { size, badge: true }) : personAvatar(doc, who, size);
/** The colour set of a tagged name, as its avatar shows it ("none" when the name is not in the workspace). */
function tagHue(id: Id, vm: TodoViewVM): string {
  for (const { person, agents } of vm.people.groups) {
    if (person.id === id) return String(personTint(person.id, person.you) ?? "none");
    const agent = agents.find((entry) => entry.id === id);
    if (agent) return String(personTint(agent.ownerId, agent.yours) ?? "none");
  }
  const other = vm.people.other?.find((entry) => entry.id === id);
  return other ? String(personTint(other.ownerId, other.yours) ?? "none") : "none";
}
function authorName(who: PersonVM | AgentVM, names: ReadonlyMap<Id, string>): string {
  if (isAgent(who)) return who.label;
  return who.you ? `${personName(who, names)} (you)` : personName(who, names);
}

/** A recorded agent tag also highlights under the agent's own name ("@Muse" for "Nikki’s Muse"),
 * as the Todo canvas shows it. Display only: what a comment sends is still `tagsInBody`. */
function displayTags(tags: { id: Id; label: string }[], vm: TodoViewVM): { id: Id; label: string }[] {
  const agents = [...vm.people.groups.flatMap((group) => group.agents), ...(vm.people.other ?? [])];
  const aliases = tags.flatMap((tag) => {
    const agent = agents.find((entry) => entry.id === tag.id);
    return agent && agent.name && agent.name !== tag.label ? [{ id: tag.id, label: agent.name }] : [];
  });
  return [...tags, ...aliases];
}

/** The back link and meta line. A sample to-do has no doors, so its back line is plain text. */
function topBar(doc: Document, vm: TodoViewVM, callbacks: TodoViewCallbacks, meta: string | null, sample = false): HTMLElement {
  const top = node(doc, "div", "hm-todo-top");
  const where = `${vm.workspace.name} · To-dos`;
  if (sample) top.append(node(doc, "p", "hm-todo-where", where));
  else {
    const back = node(doc, "a", "hm-todo-back"); back.href = vm.workspace.todosHref; back.dataset.todoBack = "";
    back.append(backIcon(doc), node(doc, "span", "", where));
    if (callbacks.back) back.addEventListener("click", (event) => callbacks.back!(event));
    top.append(back);
  }
  if (meta) top.append(node(doc, "p", "hm-todo-meta", meta));
  return top;
}

function gateEditor(doc: Document, todo: TodoVM, vm: TodoViewVM, callbacks: TodoViewCallbacks): HTMLFormElement {
  const form = node(doc, "form", "hm-todo-editor"); form.dataset.todoGateEditor = "";
  const set = node(doc, "fieldset", "hm-todo-gate"); set.append(node(doc, "legend", "", "Waiting on"));
  const others = vm.openTodos.filter((other) => other.id !== todo.id);
  const kinds = GATE_KINDS.filter((entry) => entry.kind !== "todo" || others.length);
  const gate = todo.start?.mode === "gated" ? todo.start.gate : null;
  let chosen: TodoGateInput["kind"] = gate && kinds.some((entry) => entry.kind === gate.kind) ? gate.kind : kinds[0]!.kind;
  const radios = node(doc, "div", "hm-todo-gate-kinds");
  const groups = new Map<TodoGateInput["kind"], HTMLElement>();
  const select = node(doc, "select", "hm-todo-input"); select.dataset.gateTodo = "";
  select.append(Object.assign(node(doc, "option", "", "Choose a to-do"), { value: "" }));
  for (const other of others) { const option = node(doc, "option", "", other.title); option.value = other.id; select.append(option); }
  if (gate?.kind === "todo") select.value = gate.todo.id;
  const times = localInputs(gate?.kind === "time" ? gate.at : null);
  const date = input(doc, "date", times.date); date.dataset.gateDate = "";
  const time = input(doc, "time", times.time); time.dataset.gateTime = "";
  const note = input(doc, "text", gate?.kind === "note" ? gate.note : ""); note.dataset.gateNote = ""; note.maxLength = 200;
  const todoGroup = node(doc, "div", "hm-todo-gate-field"); todoGroup.append(field(doc, "Another to-do", select));
  const timeGroup = node(doc, "div", "hm-todo-gate-field hm-todo-when"); timeGroup.append(field(doc, "Date", date), field(doc, "Time", time));
  const noteGroup = node(doc, "div", "hm-todo-gate-field"); noteGroup.append(field(doc, "Note", note));
  groups.set("todo", todoGroup); groups.set("time", timeGroup); groups.set("note", noteGroup);
  const show = () => {
    for (const [kind, group] of groups) {
      group.hidden = kind !== chosen;
      for (const control of group.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) { control.disabled = kind !== chosen; control.required = kind === chosen; }
    }
  };
  for (const entry of kinds) {
    const label = node(doc, "label", "hm-todo-gate-kind"); const radio = input(doc, "radio", entry.kind);
    radio.name = `hm-todo-gate-${todo.id}`; radio.checked = entry.kind === chosen;
    radio.addEventListener("change", () => { if (radio.checked) { chosen = entry.kind; show(); } });
    label.append(radio, node(doc, "span", "", entry.label)); radios.append(label);
  }
  set.append(radios, ...kinds.map((entry) => groups.get(entry.kind)!));
  form.append(set, button(doc, "Save", "hm-todo-save", "submit"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const value: TodoGateInput = chosen === "todo" ? { kind: "todo", todoId: select.value }
      : chosen === "time" ? { kind: "time", date: date.value, time: time.value } : { kind: "note", note: note.value.trim() };
    if (value.kind === "note" && !value.note) { note.focus(); return; }
    callbacks.setStart({ mode: "gated", gate: value });
  });
  show();
  return form;
}

function atEditor(doc: Document, todo: TodoVM, callbacks: TodoViewCallbacks): HTMLFormElement {
  const form = node(doc, "form", "hm-todo-editor"); form.dataset.todoAtEditor = "";
  const set = node(doc, "fieldset", "hm-todo-gate"); set.append(node(doc, "legend", "", "Joins the line at"));
  const times = localInputs(todo.start?.mode === "at" ? todo.start.at : null);
  const date = input(doc, "date", times.date); date.required = true; date.dataset.atDate = "";
  const time = input(doc, "time", times.time); time.required = true; time.dataset.atTime = "";
  const row = node(doc, "div", "hm-todo-gate-field hm-todo-when"); row.append(field(doc, "Date", date), field(doc, "Time", time));
  set.append(row); form.append(set, button(doc, "Save", "hm-todo-save", "submit"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (form.reportValidity()) callbacks.setStart({ mode: "at", date: date.value, time: time.value });
  });
  return form;
}


function assignedPanel(doc: Document, todo: TodoVM, vm: TodoViewVM, callbacks: TodoViewCallbacks, ctx: TodoCopyContext): HTMLElement {
  const panel = node(doc, "section", "hm-todo-panel"); panel.dataset.todoAssigned = "";
  const headId = `hm-todo-${todo.id}-assigned`.replace(/[^A-Za-z0-9_-]/g, "_");
  const head = node(doc, "h2", "hm-todo-panel-title", "Assigned to"); head.id = headId;
  panel.setAttribute("aria-labelledby", headId);
  if (vm.save === "saving") panel.setAttribute("aria-busy", "true");
  const finished = todo.state === "done" || todo.state === "dropped";
  const options = assignOptions(vm.people, vm.facts);
  const current = todo.assignee ? (todo.assignee.kind === "agent" ? todo.assignee.agent.id : todo.assignee.person.id) : null;
  panel.append(head, assignPicker(doc, { id: `${headId}-picker`, label: "Assign to", options, people: vm.people, current: todoAssigneeLabel(todo, ctx.names),
    currentValue: current, labelledBy: headId, sample: todo.sample, disabled: !todo.may.assign || finished }, callbacks.assign));

  const choice = todoStartChoice(todo);
  if (choice) {
    const editors = node(doc, "div", "hm-todo-editors");
    const gate = gateEditor(doc, todo, vm, callbacks); const at = atEditor(doc, todo, callbacks);
    const reveal = (mode: TodoStartMode | null) => { gate.hidden = mode !== "gated"; at.hidden = mode !== "at"; };
    reveal(choice.value);
    const chips = choiceChips(doc, choice, (mode) => {
      reveal(mode);
      if (mode === "queue" || mode === "now") callbacks.setStart({ mode });
    });
    chips.classList.add("hm-todo-start"); chips.dataset.todoStart = "";
    editors.append(gate, at);
    panel.append(chips, editors);
  }

  // Every state has a status line, "Not assigned yet." included (UI-SPEC 3.4).
  const copy = todoStatus(todo, ctx);
  const status = node(doc, "div", "hm-todo-status"); status.dataset.todoStatus = ""; status.setAttribute("role", "status");
  status.append(node(doc, "p", "hm-todo-status-line", copy.line), ...copy.more.map((line) => node(doc, "p", "hm-todo-status-more", line)));
  panel.append(status);
  if (copy.warning) panel.append(notice(doc, copy.warning, "warning"));
  if (vm.save === "failed") panel.append(notice(doc, TODO_SAVE_FAILED, "danger"));
  if (vm.save === "unknown") panel.append(notice(doc, TODO_RESULT_UNKNOWN, "warning"));
  // Todo canvas: a padlock line closes the panel. It says what the server enforces (only the agent's
  // owner steers its line), so it shows only with the start chips, which render only for that owner.
  if (choice && todo.assignee?.kind === "agent") {
    const steer = node(doc, "p", "hm-todo-steer"); steer.dataset.todoSteer = "";
    steer.append(lockIcon(doc, "hm-todo-steer-icon"), node(doc, "span", "", todoSteerLine(todo.assignee.agent, ctx.names)));
    panel.append(steer);
  }
  return panel;
}

function commentsSection(doc: Document, todo: TodoVM, vm: TodoViewVM, callbacks: TodoViewCallbacks, ctx: TodoCopyContext): HTMLElement {
  const section = node(doc, "section", "hm-todo-comments"); section.dataset.todoComments = "";
  const headId = `hm-todo-${todo.id}-comments`.replace(/[^A-Za-z0-9_-]/g, "_");
  const head = node(doc, "h2", "hm-todo-panel-title", "Comments"); head.id = headId; section.setAttribute("aria-labelledby", headId);
  section.append(head);
  if (!todo.comments.length) section.append(node(doc, "p", "hm-todo-quiet", "No comments yet."));
  else {
    const list = node(doc, "ol", "hm-comments");
    for (const comment of todo.comments) {
      const item = node(doc, "li", "hm-comment"); item.dataset.commentId = comment.id;
      const avatar = mark(doc, comment.author, 36); avatar.setAttribute("aria-hidden", "true");
      const body = node(doc, "div", "hm-comment-main");
      const line = node(doc, "p", "hm-comment-head");
      line.append(node(doc, "span", "hm-comment-author", authorName(comment.author, ctx.names ?? new Map())));
      const stamp = whenStamp(comment.at, ctx);
      if (stamp) { const time = node(doc, "time", "hm-comment-time", stamp); time.dateTime = comment.at; line.append(time); }
      const text = node(doc, "p", "hm-comment-text");
      for (const piece of commentSegments(comment.body, displayTags(comment.tags, vm))) {
        if (!piece.tag) { text.append(doc.createTextNode(piece.text)); continue; }
        const tag = node(doc, "mark", "hm-tag", piece.text); tag.dataset.hue = tagHue(piece.tag.id, vm); text.append(tag);
      }
      body.append(line, text); item.append(avatar, body); list.append(item);
    }
    section.append(list);
  }
  if (todo.sample || !todo.may.comment) return section;
  const form = node(doc, "form", "hm-comment-form"); form.dataset.todoCommentForm = "";
  const area = node(doc, "textarea", "hm-todo-input hm-comment-input"); area.rows = 1; area.dataset.todoComment = "";
  const picked: { id: Id; label: string }[] = [];
  const picker = tagPicker(doc, area, { id: `${headId}-tags`, label: `Tag someone in ${vm.workspace.name}`, options: tagOptions(vm.people), people: vm.people, tagDelivers: todo.tagDelivers },
    (option) => picked.push({ id: option.value, label: tagLabel(option) }));
  // Todo canvas: the tag card sits in the flow between the comments and the field, so it never covers
  // the comments it belongs to; the field and Post share one row under it.
  const fieldWrap = node(doc, "div", "hm-comment-field"); fieldWrap.append(field(doc, "Add a comment", area), button(doc, "Post", "hm-todo-save hm-comment-post", "submit"));
  form.append(picker, fieldWrap);
  if (todo.tagDelivers) {
    const help = node(doc, "p", "hm-comment-help", TODO_TAG_NOTE); help.id = `${headId}-help`;
    area.setAttribute("aria-describedby", help.id); form.append(help);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = area.value.trim();
    if (!text) { area.focus(); return; }
    callbacks.comment(text, tagsInBody(text, picked));
  });
  section.append(form);
  return section;
}

/** Build the whole To-do view for one state: loading, not found, or a to-do. */
export function todoView(doc: Document, vm: TodoViewVM, callbacks: TodoViewCallbacks): HTMLElement {
  const root = node(doc, "article", "hm-todo"); root.dataset.homeTodo = vm.view.kind;
  const ctx: TodoCopyContext = { now: vm.now, timeZone: vm.timeZone, receive: vm.receive ?? null, notice: vm.notice ?? null,
    names: personNames(vm.people.groups) };
  if (vm.view.kind === "loading") {
    root.setAttribute("aria-busy", "true");
    const title = node(doc, "h1", "hm-todo-title", TODO_LOADING); title.tabIndex = -1;
    root.append(topBar(doc, vm, callbacks, null), title);
    return root;
  }
  if (vm.view.kind === "not-found") {
    const title = node(doc, "h1", "hm-todo-title", `Nothing with this link in ${vm.workspace.name}.`); title.tabIndex = -1;
    const home = node(doc, "a", "hm-todo-link", vm.workspace.name); home.href = vm.workspace.homeHref;
    const line = node(doc, "p", "hm-todo-quiet"); line.append(home);
    root.append(title, line);
    return root;
  }
  const todo = vm.view.todo;
  root.dataset.todoState = todo.state;
  const head = node(doc, "header", "hm-todo-head");
  const titleId = `hm-todo-${todo.id}-title`.replace(/[^A-Za-z0-9_-]/g, "_");
  const title = node(doc, "h1", "hm-todo-title", todo.title); title.id = titleId; title.tabIndex = -1;
  root.setAttribute("aria-labelledby", titleId);
  // Todo canvas: the box sits left of the title, and the notes run under the title.
  const checkable = !todo.sample && todo.may.complete && todo.state !== "dropped";
  if (checkable) {
    const label = node(doc, "label", "hm-todo-done");
    const box = input(doc, "checkbox"); box.className = "hm-todo-done-box"; box.checked = todo.state === "done"; box.dataset.todoComplete = "";
    box.addEventListener("change", () => callbacks.complete(box.checked));
    label.append(box, node(doc, "span", "hm-todo-done-text", "Mark done"));
    head.append(label);
  }
  const copy = node(doc, "div", "hm-todo-head-copy");
  if (!checkable && (todo.state === "done" || todo.state === "dropped")) copy.append(node(doc, "span", "hm-todo-word", todo.state === "done" ? "Done" : "Dropped"));
  copy.append(title);
  if (todo.notes.trim()) copy.append(node(doc, "p", "hm-todo-notes", todo.notes));
  head.append(copy);
  root.append(topBar(doc, vm, callbacks, todoMetaLine(todo, ctx), todo.sample), head);
  root.append(assignedPanel(doc, todo, vm, callbacks, ctx), commentsSection(doc, todo, vm, callbacks, ctx));
  return root;
}
