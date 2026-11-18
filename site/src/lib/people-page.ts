import type { PeopleDialogModel, PeopleDialogPage, PeopleDialogState } from "./people-dialog-view";
import { peopleSearchLabel, peopleTab, peopleTabAction, peopleTabs } from "./people/tabs";

/** Page-only composition. The dialog renderer and all authority callbacks remain their owners. */
export function buildPeoplePage(doc: Document, model: PeopleDialogModel, state: PeopleDialogState,
  nav: PeopleDialogPage, render: () => void) {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const element = doc.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const page = make("section", "pd-page"); page.dataset.peoplePage = "";
  page.setAttribute("aria-labelledby", "pd-page-title");
  const context = make("section", "pd-page-context"); context.dataset.peopleContext = "";
  const head = make("header", "pd-page-head");
  const back = make("a", "pd-page-back", "← Back"); back.href = nav.homeHref || "#"; back.dataset.pdFocus = "page-back";
  back.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (nav.back) { event.preventDefault(); nav.back(event); }
    else if (nav.navigate) { event.preventDefault(); nav.navigate(back.href, event); }
  });
  const title = make("h1", "", "People & agents"); title.id = "pd-page-title"; title.tabIndex = -1;
  const titleRow = make("div", "pd-page-title-row"); titleRow.append(title, back); head.append(titleRow);
  const tab = peopleTab(model, state.tab); state.tab = tab;
  // Tabs first, then the open tab's search and its one main action.
  const tabs = make("div", "pd-page-filters"); tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "Show");
  for (const info of peopleTabs(model, tab)) {
    const choice = make("button", "", info.label); choice.type = "button"; choice.dataset.pdFocus = `tab-${info.id}`; choice.dataset.peopleTab = info.id;
    choice.setAttribute("aria-pressed", String(info.selected)); choice.setAttribute("aria-label", info.name);
    if (info.count !== null) { const count = make("span", "pd-filter-count", String(info.count)); count.dataset.tabCount = info.id;
      choice.append(doc.createTextNode(" "), count); }
    choice.addEventListener("click", () => { state.tab = info.id; render(); }); tabs.append(choice);
  }
  head.append(tabs);
  if (nav.onQuery) {
    const search = make("input", "dashboard__roster-dialog-search pd-page-search"); search.type = "search";
    search.value = state.query; search.placeholder = peopleSearchLabel(tab); search.autocomplete = "off"; search.spellcheck = false;
    search.setAttribute("aria-label", peopleSearchLabel(tab)); search.dataset.pdFocus = "page-search";
    search.addEventListener("input", () => nav.onQuery?.(search.value)); head.append(search);
  }
  const host = make("div", "pd-page-main");
  const actions = make("div", "pd-page-actions");
  const action = peopleTabAction(tab, { sample: model.sample, mayInvite: model.people.some(person => person.own && person.role !== "member") });
  if (action === "invite" && nav.invite) {
    const invite = make("button", "pd-page-primary", "Invite a person"); invite.type = "button";
    invite.dataset.peoplePageInvite = ""; invite.dataset.pdFocus = "page-invite";
    invite.addEventListener("click", () => nav.invite?.()); actions.append(invite);
  }
  if (action === "add-agent" && nav.addAgentHref) {
    const add = make("a", "pd-page-secondary", "Add an agent"); add.href = nav.addAgentHref;
    add.dataset.peoplePageAddAgent = ""; add.dataset.pdFocus = "page-add-agent";
    if (nav.navigate) add.addEventListener("click", event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); nav.navigate?.(add.href, event);
    }); actions.append(add);
  }
  if (actions.childElementCount) head.append(actions);
  const footer = make("footer", "pd-context-footer");
  if (nav.workspacesHref) {
    const switcher = make("a", "pd-page-back", "Switch workspace"); switcher.href = nav.workspacesHref; switcher.dataset.pdFocus = "page-workspaces";
    if (nav.navigate) switcher.addEventListener("click", event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); nav.navigate?.(switcher.href, event);
    }); footer.append(switcher);
  }
  context.append(head, host, footer);
  const side = make("div", "pd-page-side");
  page.append(context, side);
  return { page, host, side };
}
