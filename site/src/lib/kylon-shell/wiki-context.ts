/** Wiki presentation: retain controller nodes and every workspace/resource door. */
export function createWikiContext(app: HTMLElement, getShell: () => {
  root: HTMLElement; slots: { context: HTMLElement; rail: HTMLElement; phoneHeader: HTMLElement };
} | null) {
  const doc = app.ownerDocument, phone = doc.defaultView!.matchMedia("(max-width: 52rem)");
  type Home = { node: HTMLElement; mark: Comment; kind: "index" | "navigation" | "header" | "resources" };
  type Focus = { node: HTMLElement; key?: string; id: string; kind: Home["kind"] | "tools"; range: [number | null, number | null] | null };
  let homes: Home[] = [], panel: HTMLElement | null = null;
  let tools: HTMLDetailsElement | null = null, commands: HTMLElement | null = null;
  let enabled = false, refreshing = false, arrangedPhone = phone.matches, remembered: Focus | null = null;
  const visible = (node: HTMLElement | null): node is HTMLElement => !!node?.isConnected && !!node.getClientRects().length &&
    !node.closest("[hidden], [inert], details:not([open]) > :not(summary)");
  const held = (): Focus | null => {
    const node = doc.activeElement as HTMLElement | null, home = homes.find(home => node && home.node.contains(node));
    if (!node || !home && !tools?.contains(node)) return null;
    return { node, key: node.dataset.homeFocusKey, id: node.id, kind: home?.kind ?? "tools",
      range: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? [node.selectionStart, node.selectionEnd] : null };
  };
  const focusIn = () => { remembered = held(); };
  const remember = () => { const focus = held(); if (focus) remembered = focus; };
  const focusOut = (event: FocusEvent) => {
    if (tools?.open && event.relatedTarget && !tools.contains(event.relatedTarget as Node)) tools.open = false;
    if (!remembered || event.target !== remembered.node) return;
    // A media query may hide desktop parking before its change callback runs.
    if (event.relatedTarget || phone.matches === arrangedPhone || remembered.node.getClientRects().length) remembered = null;
  };
  const outsidePointer = (event: PointerEvent) => {
    if (!homes.some(home => home.node.contains(event.target as Node))) remembered = null;
    if (tools?.open && !tools.contains(event.target as Node)) tools.open = false;
  };
  const escapeTools = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !tools?.open || !tools.contains(event.target as Node) || event.defaultPrevented) return;
    event.preventDefault(); tools.open = false; tools.querySelector("summary")?.focus();
  };
  const observe = (active: boolean) => {
    const method = active ? "addEventListener" : "removeEventListener";
    doc[method]("focusin", focusIn, true); doc[method]("focusout", focusOut, true);
    doc[method]("pointerdown", outsidePointer, true); doc[method]("keydown", escapeTools);
    for (const type of ["input", "keyup", "select", "selectionchange"]) doc[method](type, remember, true);
  };
  const recover = (focus: Focus | null) => {
    if (!focus || doc.activeElement !== doc.body && doc.activeElement !== focus.node) return;
    const keyed = focus.key ? Array.from(app.querySelectorAll<HTMLElement>("[data-home-focus-key]")).find(node => node.dataset.homeFocusKey === focus.key && visible(node)) : null;
    const identified = focus.id ? Array.from(app.querySelectorAll<HTMLElement>("[id]")).find(node => node.id === focus.id && visible(node)) : null;
    const summary = tools?.querySelector<HTMLElement>("summary") ?? null;
    const reader = app.querySelector<HTMLElement>("[data-brain-title]");
    const target = visible(focus.node) ? focus.node : keyed ?? identified ??
      (focus.kind === "index" && visible(reader) ? reader : null) ?? (visible(summary) ? summary : null) ??
      Array.from(app.querySelectorAll<HTMLElement>("#dashboard-wiki-title, .cs-org-phone-bar > button, .cs-kylon-workspace-menu .hm-menu__trigger")).find(visible);
    if (!target || doc.activeElement === target) return;
    target.focus({ preventScroll: true });
    if (target === focus.node && focus.range && focus.range[0] !== null && focus.range[1] !== null)
      try { (target as HTMLInputElement).setSelectionRange(focus.range[0], focus.range[1]); } catch { /* Non-text control. */ }
  };
  const restoreNodes = () => {
    for (const home of homes) if (home.node.isConnected && home.mark.parentNode &&
      (home.node.parentNode !== home.mark.parentNode || home.node.previousSibling !== home.mark))
      home.mark.parentNode.insertBefore(home.node, home.mark.nextSibling);
  };
  const arrange = () => {
    const shell = getShell(); if (!enabled || refreshing || !shell || !panel || !tools || !commands) return;
    const focus = held() ?? (phone.matches !== arrangedPhone && doc.activeElement === doc.body && remembered?.node.isConnected ? remembered : null);
    shell.root.dataset.wikiComposition = "";
    const dock = phone.matches ? shell.slots.phoneHeader : shell.slots.rail;
    const anchor = dock.lastElementChild;
    if (tools.parentNode !== dock) dock.insertBefore(tools, anchor);
    for (const home of homes) {
      const original = phone.matches && (home.kind === "index" || home.kind === "header");
      const parent = original ? home.mark.parentNode : home.kind === "index" ? panel : commands;
      const before = original ? home.mark.nextSibling : null;
      if (parent && home.node !== before && (home.node.parentNode !== parent || home.node.nextSibling !== before)) parent.insertBefore(home.node, before);
    }
    arrangedPhone = phone.matches; recover(focus); focusIn();
  };
  const disclosure = (label: string) => {
    const node = doc.createElement("details"), summary = doc.createElement("summary");
    node.className = "cs-wiki-tools"; summary.textContent = "⋯"; summary.tabIndex = 0;
    summary.setAttribute("aria-label", label); summary.title = label;
    commands = doc.createElement("div"); commands.className = "cs-wiki-tools-panel";
    const heading = doc.createElement("p"); heading.className = "cs-wiki-tools-title"; heading.textContent = label;
    commands.append(heading); node.append(summary, commands); return node;
  };
  const clear = () => {
    if (!enabled) return;
    const focus = held(); observe(false); remembered = null; phone.removeEventListener("change", arrange);
    restoreNodes(); for (const home of homes) home.mark.remove(); homes = [];
    panel?.remove(); tools?.remove(); panel = null; tools = null; commands = null; enabled = false;
    getShell()?.root.removeAttribute("data-wiki-composition"); recover(focus);
  };
  return {
    set(active: boolean) {
      if (!active) { clear(); return; }
      const shell = getShell(); if (!shell) return;
      const index = app.querySelector<HTMLElement>(".dashboard__brain-index");
      if (enabled && homes.find(home => home.kind === "index")?.node !== index) clear();
      if (enabled) { arrange(); return; }
      const nodes = [["index", index], ["navigation", app.querySelector<HTMLElement>("[data-home-rail-slot]")],
        ["header", app.querySelector<HTMLElement>("[data-home-workspace-shell]")],
        ["resources", app.querySelector<HTMLElement>("[data-home-side-slot]")]] as const;
      if (nodes.some(([, node]) => !node?.parentNode)) return;
      panel = doc.createElement("section"); panel.className = "cs-wiki-context"; panel.setAttribute("aria-label", "Wiki context");
      tools = disclosure("Workspace tools"); shell.slots.context.append(panel);
      homes = nodes.map(([kind, node]) => { const mark = doc.createComment("Wiki " + kind + " home"); node!.before(mark); return { kind, node: node!, mark }; });
      enabled = true; arrangedPhone = phone.matches; observe(true); focusIn(); phone.addEventListener("change", arrange); arrange();
    },
    refresh(replace: () => void) {
      if (!enabled || refreshing) { replace(); return; }
      const focus = held(); refreshing = true; restoreNodes();
      try { replace(); } finally {
        refreshing = false;
        if (homes.some(home => !home.node.isConnected || !home.mark.isConnected)) { clear(); this.set(true); }
        else arrange();
        recover(focus);
      }
    },
    clear,
  };
}
