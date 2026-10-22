/** Project one real roster node; never clone its controls or replace the native navigation drawer. */
export function createPeopleContext(app: HTMLElement, getShell: () => {
  root: HTMLElement; slots: { context: HTMLElement };
} | null, navigation: HTMLElement | null) {
  const doc = app.ownerDocument;
  const phone = doc.defaultView!.matchMedia("(max-width: 52rem)");
  let roster: HTMLElement | null = null;
  let home: Comment | null = null;
  let priorHidden = navigation?.hidden ?? false;
  type Focus = { node: HTMLElement; range: readonly [number | null, number | null] | null };
  let remembered: Focus | null = null;
  let ownsFocus = false;
  let arrangedPhone = phone.matches;
  const snapshot = (node: HTMLElement): Focus => ({ node, range:
    node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? [node.selectionStart, node.selectionEnd] : null });
  const current = (): Focus | null => {
    const node = doc.activeElement as HTMLElement | null;
    return node && roster?.contains(node) ? snapshot(node) : null;
  };
  const focusIn = () => { remembered = current(); ownsFocus = remembered !== null; };
  const remember = () => { if (ownsFocus) remembered = current() ?? remembered; };
  const focusOut = (event: FocusEvent) => {
    // An outside pointer/focus may already have relinquished this target. Never re-arm it here.
    if (!ownsFocus || !remembered || event.target !== remembered.node) return;
    if (!event.relatedTarget && phone.matches !== arrangedPhone && !remembered.node.getClientRects().length)
      remembered = snapshot(remembered.node);
    else { remembered = null; ownsFocus = false; }
  };
  const outsidePointer = (event: PointerEvent) => {
    if (!roster?.contains(event.target as Node)) { remembered = null; ownsFocus = false; }
  };
  const observeFocus = (active: boolean) => {
    const method = active ? "addEventListener" : "removeEventListener";
    doc[method]("focusin", focusIn, true);
    doc[method]("focusout", focusOut, true);
    doc[method]("pointerdown", outsidePointer, true);
    for (const event of ["input", "keyup", "select", "selectionchange"]) doc[method](event, remember, true);
  };
  const move = (parent: Node, before: Node | null = null, breakpoint = false) => {
    if (!roster || roster === before || (roster.parentNode === parent && roster.nextSibling === before)) return;
    // CSS can hide desktop parking before the MQL callback, leaving BODY active by this point.
    const held = current() ?? (breakpoint && ownsFocus && doc.activeElement === doc.body && remembered?.node.isConnected &&
      roster.contains(remembered.node) ? remembered : null);
    parent.insertBefore(roster, before);
    if (held?.node.getClientRects().length && !held.node.closest("[hidden], [inert]") &&
      (doc.activeElement === doc.body || doc.activeElement === held.node)) {
      held.node.focus({ preventScroll: true });
      if (held.range && held.range[0] !== null && held.range[1] !== null)
        try { (held.node as HTMLInputElement).setSelectionRange(held.range[0], held.range[1]); } catch { /* non-text input */ }
    }
  };
  const arrange = () => {
    const shell = getShell(); if (!shell || !roster || !home) return;
    shell.root.dataset.peopleComposition = "";
    if (navigation) navigation.hidden = phone.matches ? priorHidden : true;
    const breakpoint = phone.matches !== arrangedPhone;
    if (phone.matches) { if (home.parentNode) move(home.parentNode, home.nextSibling, breakpoint); }
    else move(shell.slots.context, null, breakpoint);
    arrangedPhone = phone.matches; focusIn();
  };
  const clear = () => {
    observeFocus(false); remembered = null; ownsFocus = false;
    phone.removeEventListener("change", arrange);
    if (roster && navigation) navigation.hidden = priorHidden;
    if (home?.parentNode) move(home.parentNode, home.nextSibling);
    home?.remove(); home = null; roster = null;
    getShell()?.root.removeAttribute("data-people-composition");
  };
  return {
    set(node: HTMLElement | null) {
      if (node === roster) { arrange(); return; }
      clear(); if (!node) return;
      roster = node; priorHidden = navigation?.hidden ?? false;
      home = doc.createComment("People context home"); node.before(home);
      arrangedPhone = phone.matches; observeFocus(true); focusIn();
      phone.addEventListener("change", arrange); arrange();
    },
    clear,
  };
}
