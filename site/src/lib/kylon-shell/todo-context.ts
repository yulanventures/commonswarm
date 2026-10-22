/** Todo presentation only: move intact host slots; native disclosures keep every original door. */
export function createTodoContext(app: HTMLElement, getShell: () => {
  root: HTMLElement; slots: { context: HTMLElement };
} | null) {
  const doc = app.ownerDocument;
  const phone = doc.defaultView!.matchMedia("(max-width: 52rem)");
  type Home = { node: HTMLElement; mark: Comment; kind: "navigation" | "header" | "resources" };
  let homes: Home[] = [], panel: HTMLElement | null = null;
  let navigation: HTMLDetailsElement | null = null, resources: HTMLDetailsElement | null = null;
  let enabled = false, refreshing = false;
  const visible = (node: HTMLElement | null): node is HTMLElement => !!node?.isConnected &&
    !!node.getClientRects().length && !node.closest("[hidden], [inert], details:not([open]) > :not(summary)");
  const hold = () => {
    const node = doc.activeElement as HTMLElement | null;
    if (!node || !panel?.contains(node) && !homes.some(home => home.node.contains(node))) return null;
    const trigger = node.closest(".hm-menu")?.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]');
    const target = trigger ?? node;
    return { node, key: target.dataset.homeFocusKey, id: target.id,
      kind: homes.find(home => home.node.contains(node))?.kind,
      selection: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? [node.selectionStart, node.selectionEnd] : null };
  };
  const recover = (held: ReturnType<typeof hold>) => {
    if (!held || doc.activeElement !== doc.body && doc.activeElement !== held.node) return;
    const keyed = held.key ? Array.from(app.querySelectorAll<HTMLElement>("[data-home-focus-key]")).find(node =>
      node.dataset.homeFocusKey === held.key && visible(node)) : null;
    const original = visible(held.node) ? held.node : null;
    const identified = held.id ? Array.from(app.querySelectorAll<HTMLElement>("[id]")).find(node => node.id === held.id && visible(node)) : null;
    const summary = (held.kind === "resources" ? resources : navigation)?.querySelector<HTMLElement>("summary") ?? null;
    const fallback = Array.from(app.querySelectorAll<HTMLElement>(
      ".cs-kylon-workspace-menu .hm-menu__trigger, [data-home-route-pane] h1, .cs-org-phone-bar > button")).find(visible);
    const target = original ?? keyed ?? identified ?? (visible(summary) ? summary : null) ?? fallback;
    if (!target) return;
    if (doc.activeElement === target) return;
    target.focus({ preventScroll: true });
    if (target === held.node && held.selection && held.selection[0] !== null && held.selection[1] !== null)
      try { (target as HTMLInputElement).setSelectionRange(held.selection[0], held.selection[1]); } catch { /* Non-text control. */ }
  };
  const restoreNodes = () => {
    for (const home of homes) if (home.mark.parentNode &&
      (home.node.parentNode !== home.mark.parentNode || home.node.previousSibling !== home.mark))
      home.mark.parentNode.insertBefore(home.node, home.mark.nextSibling);
  };
  const arrange = () => {
    const shell = getShell(); if (!enabled || refreshing || !shell || !panel || !navigation || !resources) return;
    const held = hold(); shell.root.dataset.todoComposition = "";
    for (const home of homes) {
      const parent = home.kind === "navigation" ? navigation : home.kind === "resources" ? resources : phone.matches ? home.mark.parentNode : panel;
      const before = home.kind === "header" ? phone.matches ? home.mark.nextSibling : navigation : null;
      if (parent && home.node !== before && (home.node.parentNode !== parent || home.node.nextSibling !== before)) parent.insertBefore(home.node, before);
    }
    recover(held);
  };
  const disclosure = (text: string) => {
    const details = doc.createElement("details"), summary = doc.createElement("summary");
    details.className = "cs-todo-disclosure"; summary.textContent = text;
    // The existing modal owner enumerates [tabindex]; include native summaries in its live trap.
    summary.tabIndex = 0; details.append(summary); return details;
  };
  const clear = () => {
    if (!enabled) return;
    const held = hold(); phone.removeEventListener("change", arrange); restoreNodes();
    for (const home of homes) home.mark.remove(); homes = [];
    panel?.remove(); panel = null; navigation = null; resources = null; enabled = false;
    getShell()?.root.removeAttribute("data-todo-composition"); recover(held);
  };
  return {
    set(active: boolean) {
      if (!active) { clear(); return; }
      if (enabled) { arrange(); return; }
      const shell = getShell(); if (!shell) return;
      const nodes = [
        ["navigation", app.querySelector<HTMLElement>("[data-home-rail-slot]")],
        ["header", app.querySelector<HTMLElement>("[data-home-workspace-shell]")],
        ["resources", app.querySelector<HTMLElement>("[data-home-side-slot]")],
      ] as const;
      if (nodes.some(([, node]) => !node?.parentNode)) return;
      panel = doc.createElement("section"); panel.className = "cs-todo-context"; panel.setAttribute("aria-label", "To-dos context");
      const label = doc.createElement("p"); label.className = "cs-todo-mode"; label.textContent = "To-dos";
      navigation = disclosure("Workspace navigation"); resources = disclosure("Workspace resources");
      panel.append(label, navigation, resources); shell.slots.context.append(panel);
      homes = nodes.map(([kind, node]) => { const mark = doc.createComment("Todo " + kind + " home"); node!.before(mark); return { kind, node: node!, mark }; });
      enabled = true; phone.addEventListener("change", arrange); arrange();
    },
    /** Restore before the original renderer replaces children; then re-project the same slots. */
    refresh(replace: () => void) {
      if (!enabled || refreshing) { replace(); return; }
      const held = hold(); refreshing = true; restoreNodes();
      try { replace(); } finally { refreshing = false; arrange(); recover(held); }
    },
    clear,
  };
}
