/** Project one real roster node; never clone its controls or replace the native navigation drawer. */
export function createPeopleContext(app: HTMLElement, getShell: () => {
  root: HTMLElement; slots: { context: HTMLElement };
} | null, navigation: HTMLElement | null) {
  const doc = app.ownerDocument;
  const phone = doc.defaultView!.matchMedia("(max-width: 52rem)");
  let roster: HTMLElement | null = null;
  let home: Comment | null = null;
  let priorHidden = navigation?.hidden ?? false;
  const move = (parent: Node, before: Node | null = null) => {
    if (!roster || roster === before || (roster.parentNode === parent && roster.nextSibling === before)) return;
    const active = doc.activeElement as HTMLElement | null;
    const held = active && roster.contains(active) ? active : null;
    const range = held instanceof HTMLInputElement ? [held.selectionStart, held.selectionEnd] : null;
    parent.insertBefore(roster, before);
    if (held?.getClientRects().length && !held.closest("[hidden], [inert]")) {
      held.focus({ preventScroll: true });
      if (range && range[0] !== null && range[1] !== null) try { (held as HTMLInputElement).setSelectionRange(range[0], range[1]); } catch { /* non-text input */ }
    }
  };
  const arrange = () => {
    const shell = getShell(); if (!shell || !roster || !home) return;
    shell.root.dataset.peopleComposition = "";
    if (navigation) navigation.hidden = phone.matches ? priorHidden : true;
    if (phone.matches) { if (home.parentNode) move(home.parentNode, home.nextSibling); }
    else move(shell.slots.context);
  };
  const clear = () => {
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
      home = doc.createComment("People context home"); node.before(home); phone.addEventListener("change", arrange); arrange();
    },
    clear,
  };
}
