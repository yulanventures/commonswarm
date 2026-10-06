// The To-dos pane (UI-SPEC.md 3.3 and 3.4; lane T). Open to-dos first; done and dropped ones show
// only under "All" (ruling R5). A pure DOM builder; titles go in through textContent only.
// Sample mode renders no actions and no doors (UI-SPEC 2 and 3.3): no filter, no checkbox, no
// row link, no "+ Add a to-do".
import type { Id, TodoVM } from "./home-types";
import { notice } from "./home-primitives";
import { TODO_RESULT_UNKNOWN, TODO_SAVE_FAILED, todoSubline, type TodoCopyContext } from "./home-todo-copy";

export type TodoFilter = "open" | "all";
export interface TodoListRow { todo: TodoVM; href: string }
/** Local to lane T. `rows: null` is the loading state. `mayAdd` comes from the server. `names` is
 * home-pickers `personNames` for this workspace, so shared first names stay apart. */
export interface TodoListVM { filter: TodoFilter; rows: TodoListRow[] | null; now: number; timeZone?: string; sample: boolean; mayAdd: boolean;
  save?: "idle" | "saving" | "failed" | "unknown"; names?: ReadonlyMap<Id, string> }
export interface TodoListCallbacks { filter: (filter: TodoFilter) => void; complete: (todo: TodoVM, done: boolean) => void; add: (title: string) => void }

export const TODOS_LOADING = "Checking to-dos…";
const rank = (todo: TodoVM) => todo.state === "done" ? 1 : todo.state === "dropped" ? 2 : 0;
/** Open and doing first, then done, then dropped; input order is kept inside each group.
 * "open" keeps only open and doing to-dos. */
export function todoListOrder<T extends { todo: TodoVM }>(rows: T[], filter: TodoFilter): T[] {
  const kept = filter === "open" ? rows.filter((row) => rank(row.todo) === 0) : rows;
  return kept.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row.todo) - rank(b.row.todo) || a.index - b.index).map(({ row }) => row);
}

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function row(doc: Document, entry: TodoListRow, vm: TodoListVM, callbacks: TodoListCallbacks, ctx: TodoCopyContext): HTMLLIElement {
  const { todo } = entry;
  const item = node(doc, "li", "hm-todo-row"); item.dataset.todoRow = todo.id; item.dataset.todoState = todo.state;
  if (!vm.sample && todo.may.complete && todo.state !== "dropped") {
    const box = node(doc, "input", "hm-todo-check"); box.type = "checkbox"; box.checked = todo.state === "done";
    box.setAttribute("aria-label", `Mark ‘${todo.title}’ done`); box.dataset.todoComplete = todo.id;
    box.addEventListener("change", () => callbacks.complete(todo, box.checked));
    const hit = node(doc, "label", "hm-todo-check-hit"); hit.append(box); item.append(hit);
  } else item.append(node(doc, "span", "hm-todo-check-hit"));
  const copy = node(doc, "div", "hm-todo-row-copy");
  const title = vm.sample ? node(doc, "span", "hm-todo-row-title", todo.title) : Object.assign(node(doc, "a", "hm-todo-row-title", todo.title), { href: entry.href });
  title.title = todo.title;
  copy.append(title, node(doc, "span", "hm-todo-row-sub", todoSubline(todo, ctx)));
  item.append(copy);
  return item;
}

function addControl(doc: Document, callbacks: TodoListCallbacks): HTMLElement {
  const wrap = node(doc, "div", "hm-todos-add");
  const open = node(doc, "button", "hm-todos-add-open", "+ Add a to-do"); open.type = "button"; open.dataset.todoAdd = "";
  const form = node(doc, "form", "hm-todos-add-form"); form.hidden = true;
  const label = node(doc, "label", "hm-todo-field"); const title = node(doc, "input", "hm-todo-input"); title.type = "text"; title.required = true;
  label.append(node(doc, "span", "hm-todo-field-label", "Title"), title);
  const save = node(doc, "button", "hm-todo-save", "Add"); save.type = "submit";
  const cancel = node(doc, "button", "hm-todo-cancel", "Cancel"); cancel.type = "button";
  const actions = node(doc, "div", "hm-todos-add-actions"); actions.append(save, cancel);
  form.append(label, actions);
  open.addEventListener("click", () => { open.hidden = true; form.hidden = false; title.focus(); });
  cancel.addEventListener("click", () => { form.hidden = true; open.hidden = false; title.value = ""; open.focus(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = title.value.trim();
    if (!text) { title.focus(); return; }
    callbacks.add(text);
  });
  wrap.append(open, form);
  return wrap;
}

/** The To-dos pane with its H1, the Open / All filter, the rows, and "+ Add a to-do". */
export function todosPane(doc: Document, vm: TodoListVM, callbacks: TodoListCallbacks): HTMLElement {
  const ctx: TodoCopyContext = { now: vm.now, timeZone: vm.timeZone, names: vm.names };
  const pane = node(doc, "section", "hm-todos"); pane.dataset.homeTodos = vm.filter;
  const head = node(doc, "header", "hm-todos-head");
  const title = node(doc, "h1", "hm-todos-title", "To-dos"); title.id = "hm-todos-title"; title.tabIndex = -1;
  pane.setAttribute("aria-labelledby", title.id);
  head.append(title);
  if (!vm.sample) {
    const filters = node(doc, "div", "hm-todos-filter"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Show");
    for (const [value, text] of [["open", "Open"], ["all", "All"]] as const) {
      const choice = node(doc, "button", "hm-todos-filter-button", text); choice.type = "button"; choice.dataset.todoFilter = value;
      choice.setAttribute("aria-pressed", String(vm.filter === value));
      choice.addEventListener("click", () => { if (vm.filter !== value) callbacks.filter(value); });
      filters.append(choice);
    }
    head.append(filters);
  }
  pane.append(head);
  if (!vm.rows) {
    pane.setAttribute("aria-busy", "true"); pane.append(node(doc, "p", "hm-todo-quiet", TODOS_LOADING));
    return pane;
  }
  const rows = todoListOrder(vm.rows, vm.filter);
  if (!rows.length) pane.append(node(doc, "p", "hm-todo-quiet", vm.filter === "open" ? "Nothing open here." : "No to-dos here yet."));
  else {
    const list = node(doc, "ul", "hm-todo-rows");
    for (const entry of rows) list.append(row(doc, entry, vm, callbacks, ctx));
    pane.append(list);
  }
  if (!vm.sample && vm.mayAdd) pane.append(addControl(doc, callbacks));
  if (vm.save === "failed") pane.append(notice(doc, TODO_SAVE_FAILED, "danger"));
  if (vm.save === "unknown") pane.append(notice(doc, TODO_RESULT_UNKNOWN, "warning"));
  return pane;
}
