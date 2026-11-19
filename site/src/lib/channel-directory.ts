/** The full readable channel list. Route and command ownership stays with the dashboard. */
export interface DirectoryChannel {
  id: string;
  slug: string;
  description: string | null;
  href: string;
  archived: boolean;
  unread: boolean | null;
  manageable: boolean;
  /** True when the viewer is a live member, false when browsing an unjoined public channel, omitted on legacy reads. */
  joined?: boolean;
}

export function renderChannelDirectory(
  host: HTMLElement,
  rows: readonly DirectoryChannel[],
  query: string,
  pending: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
  actions: {
    open: (id: string) => void;
    unarchive: (id: string, button: HTMLButtonElement) => void;
    join?: (id: string, button: HTMLButtonElement) => void;
  },
): number {
  const doc = host.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const el = doc.createElement(tag); el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const focused = host.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.channelDirectoryAction : undefined;
  const term = query.trim().toLocaleLowerCase();
  const matches = rows.filter(row => !term || `#${row.slug}\n${row.description ?? ""}`.toLocaleLowerCase().includes(term));
  const content = doc.createDocumentFragment();
  for (const archived of [false, true]) {
    const group = matches.filter(row => row.archived === archived);
    if (!group.length) continue;
    const section = node("section", "cm-directory-group");
    const title = node("h3", "cm-directory-group-title", archived ? "Archived channels" : "Active channels");
    title.id = `cm-directory-${archived ? "archived" : "active"}`;
    section.setAttribute("aria-labelledby", title.id);
    const list = node("ul", "cm-directory-rows");
    for (const row of group) {
      const item = node("li", "cm-directory-row");
      item.dataset.channelDirectoryRow = row.id;
      /* The channel's name is how it is opened: the name and its description are one link. There is no separate
         "Open" beside every row. Letting the link compute its name from its contents keeps the channel name first,
         includes its description once, and matches the visible text (WCAG 2.5.3). */
      const copy = node("a", "cm-directory-copy");
      copy.href = row.href;
      copy.dataset.channelDirectoryAction = `open:${row.id}`;
      copy.addEventListener("click", event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); actions.open(row.id);
      });
      const name = node("span", "cm-directory-name", `#${row.slug}`);
      copy.append(name);
      if (!archived && row.unread === true) {
        const unread = node("span", "cm-directory-unread");
        unread.setAttribute("role", "img"); unread.setAttribute("aria-label", "Unread");
        name.append(unread);
      }
      if (row.description) {
        const description = node("span", "cm-directory-description", row.description);
        copy.append(" ", description);
      }
      const controls = node("div", "cm-directory-actions");
      if (!archived && row.joined === false && actions.join) {
        const join = node("button", "cm-directory-join", pending.has(row.id) ? "Joining…" : "Join");
        join.type = "button"; join.disabled = pending.has(row.id);
        join.setAttribute("aria-label", `Join #${row.slug}`);
        join.dataset.channelDirectoryAction = `join:${row.id}`;
        if (pending.has(row.id)) join.setAttribute("aria-busy", "true");
        join.addEventListener("click", () => actions.join?.(row.id, join));
        controls.append(join);
      } else if (!archived && row.joined === true) {
        const joined = node("span", "cm-directory-joined", "Joined");
        joined.dataset.channelDirectoryJoined = row.id;
        controls.append(joined);
      }
      if (archived && row.manageable) {
        const unarchive = node("button", "cm-directory-unarchive", "Unarchive");
        unarchive.type = "button"; unarchive.disabled = pending.has(row.id);
        unarchive.setAttribute("aria-label", `Unarchive #${row.slug}`);
        unarchive.dataset.channelDirectoryAction = `unarchive:${row.id}`;
        if (pending.has(row.id)) unarchive.setAttribute("aria-busy", "true");
        unarchive.addEventListener("click", () => actions.unarchive(row.id, unarchive));
        controls.append(unarchive);
      }
      item.append(copy);
      if (controls.childElementCount) item.append(controls);
      const error = errors.get(row.id);
      if (error) { const message = node("p", "cm-directory-error", error); message.setAttribute("role", "alert"); item.append(message); }
      list.append(item);
    }
    section.append(title, list); content.append(section);
  }
  host.replaceChildren(content);
  if (focused) {
    const target = [...host.querySelectorAll<HTMLElement>("[data-channel-directory-action]")]
      .find(el => el.dataset.channelDirectoryAction === focused)
      ?? [...host.querySelectorAll<HTMLElement>("[data-channel-directory-action]")]
        .find(el => el.dataset.channelDirectoryAction === focused.replace(/^(?:unarchive|join):/, "open:"));
    target?.focus({ preventScroll: true });
  }
  return matches.length;
}
