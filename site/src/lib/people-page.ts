import type { PeopleDialogModel, PeopleDialogPage, PeopleDialogState } from "./people-dialog-view";

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
  if (nav.onQuery) {
    const search = make("input", "dashboard__roster-dialog-search pd-page-search"); search.type = "search";
    search.value = state.query; search.placeholder = "Find a person or agent…"; search.autocomplete = "off"; search.spellcheck = false;
    search.setAttribute("aria-label", "Filter people and agents"); search.dataset.pdFocus = "page-search";
    search.addEventListener("input", () => nav.onQuery?.(search.value)); head.append(search);
  }
  const filters = make("div", "pd-page-filters"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Show roster");
  for (const [value, label] of [["all", "All"], ["people", "People"], ["agents", "Agents"]] as const) {
    const filter = make("button", "", label); filter.type = "button"; filter.dataset.pdFocus = `filter-${value}`;
    filter.setAttribute("aria-pressed", String((state.filter ?? "all") === value));
    filter.addEventListener("click", () => { state.filter = value; render(); }); filters.append(filter);
  }
  head.append(filters);
  const host = make("div", "pd-page-main");
  const actions = make("div", "pd-page-actions");
  if (nav.invite && !model.sample && model.people.some(person => person.own && person.role !== "member")) {
    const invite = make("button", "pd-page-primary", "Invite someone"); invite.type = "button";
    invite.dataset.peoplePageInvite = ""; invite.dataset.pdFocus = "page-invite";
    invite.addEventListener("click", () => nav.invite?.()); actions.append(invite);
  }
  if (nav.addAgentHref && !model.sample) {
    const add = make("a", "pd-page-secondary", "Connect new agent"); add.href = nav.addAgentHref;
    add.dataset.peoplePageAddAgent = ""; add.dataset.pdFocus = "page-add-agent";
    if (nav.navigate) add.addEventListener("click", event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); nav.navigate?.(add.href, event);
    }); actions.append(add);
  }
  if (actions.childElementCount) titleRow.after(actions);
  const help = make("details", "pd-roles"); help.append(make("summary", "", "About roles & removal"));
  const definitions = make("dl", "pd-roles-list");
  for (const [term, text] of [["Owner", "manages people and agents, and can change anyone’s role."],
    ["Admin", "manages people and agents, except owners."], ["Member", "posts here and manages their own agents."],
    ["Agent", "belongs to the person who added it. They, an owner or an admin can remove it."]]) {
    const entry = make("div", ""); entry.append(make("dt", "", term), make("dd", "", text)); definitions.append(entry);
  }
  help.append(definitions, make("p", "pd-page-note", "Removed local agents can be added again. Their history stays here."));
  const footer = make("footer", "pd-context-footer"); footer.append(help);
  if (nav.workspacesHref) {
    const switcher = make("a", "pd-page-back", "Switch workspace"); switcher.href = nav.workspacesHref; switcher.dataset.pdFocus = "page-workspaces";
    if (nav.navigate) switcher.addEventListener("click", event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); nav.navigate?.(switcher.href, event);
    }); footer.append(switcher);
  }
  context.append(head, host, footer);
  const side = make("div", "pd-page-side");
  const empty = make("div", "pd-profile-empty"); empty.dataset.peopleEmpty = "";
  empty.append(make("h2", "", "People & their agents"), make("p", "pd-muted", "Choose someone to see their profile and access here."));
  side.append(empty); page.append(context, side);
  return { page, host, side };
}
