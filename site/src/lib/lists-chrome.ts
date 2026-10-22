/** Move the existing channel controls; their state and listeners remain with their owners. */
export function createListsChrome(root: HTMLElement): (lists: boolean, files: boolean) => void {
  const homes = new Map<HTMLElement, Comment>();
  return (lists, files) => {
    const head = root.querySelector<HTMLElement>(".dashboard__objects-view .dashboard__lists-head");
    const active = lists && head !== null;
    for (const selector of ["[data-refresh]", "[data-channel-description]"]) {
      const node = root.querySelector<HTMLElement>(selector);
      if (!node) continue;
      let home = homes.get(node);
      if (active && !home) {
        home = root.ownerDocument.createComment("Lists chrome home");
        node.before(home);
        homes.set(node, home);
      }
      if (active && head) {
        if (node.parentElement !== head) head.append(node);
      } else if (home?.parentNode && node.previousSibling !== home) {
        home.after(node);
      }
    }
    const channel = root.querySelector<HTMLElement>(".dashboard__channel");
    const legacy = channel?.querySelector<HTMLElement>(".dashboard__channel-head");
    if (legacy) legacy.hidden = active || files;
    channel?.setAttribute("aria-labelledby", active ? "dashboard-lists-title"
      : files ? "dashboard-files-title" : "dashboard-channel-title");
  };
}
