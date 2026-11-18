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
    search.value = state.query; search.placeholder = "Find people and agents"; search.autocomplete = "off"; search.spellcheck = false;
    search.setAttribute("aria-label", "Find people and agents"); search.dataset.pdFocus = "page-search";
    search.addEventListener("input", () => nav.onQuery?.(search.value)); head.append(search);
  }
  const filters = make("div", "pd-page-filters"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Show roster");
  // The sample workspace has no invites to show, so it has no Invites filter.
  const choices = [["all", "Members"], ["people", "People"], ["agents", "Agents"], ...(model.sample ? [] : [["invites", "Invites"]])] as Array<[NonNullable<PeopleDialogState["filter"]>, string]>;
  if (model.sample && state.filter === "invites") state.filter = "all";
  for (const [value, label] of choices) {
    const filter = make("button", "", label); filter.type = "button"; filter.dataset.pdFocus = `filter-${value}`;
    filter.setAttribute("aria-pressed", String((state.filter ?? "all") === value));
    if (value === "invites" && model.invites.length) {
      const count = make("span", "pd-filter-count", String(model.invites.length)); count.dataset.invitesCount = "";
      filter.append(" ", count); filter.setAttribute("aria-label", `Invites, ${model.invites.length} waiting`);
    }
    filter.addEventListener("click", () => { state.filter = value; render(); }); filters.append(filter);
  }
  head.insertBefore(filters, head.querySelector("input"));
  const host = make("div", "pd-page-main");
  const actions = make("div", "pd-page-actions");
  if (nav.invite && !model.sample && model.people.some(person => person.own && person.role !== "member")) {
    const invite = make("button", "pd-page-primary", "Add people"); invite.type = "button";
    invite.dataset.peoplePageInvite = ""; invite.dataset.pdFocus = "page-invite";
    invite.addEventListener("click", () => nav.invite?.()); actions.append(invite);
  }
  if (nav.addAgentHref && !model.sample) {
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
