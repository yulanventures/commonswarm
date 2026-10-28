/** Presentation only: the same resource nodes become a native modal sheet on phones. */
export function createChannelDetails(app: HTMLElement) {
  const doc = app.ownerDocument;
  const frame = app.querySelector<HTMLElement>(".hm-frame");
  const side = app.querySelector<HTMLElement>("[data-home-side-slot]");
  const media = doc.defaultView!.matchMedia("(max-width: 52rem)");
  const dialog = doc.createElement("dialog"); dialog.className = "cs-details-sheet";
  dialog.setAttribute("aria-label", "Details");
  const originalId = side?.id, originalLabel = side?.getAttribute("aria-label");
  const anchor = doc.createComment("Workspace details");
  let mounted = false, expanded = true, enabled = false, opener: HTMLElement | null = null;
  const triggers = () => app.querySelectorAll<HTMLElement>("[data-channel-details-toggle]");
  const sync = () => {
    if (!frame || !side || !mounted) return;
    frame.toggleAttribute("data-channel-details-collapsed", !enabled || media.matches || !expanded);
    for (const trigger of triggers()) {
      trigger.setAttribute("aria-expanded", String(enabled && (media.matches ? dialog.open : expanded)));
      trigger.setAttribute("aria-controls", media.matches ? dialog.id : side.id);
    }
  };
  const restoreSide = () => { if (side && anchor.parentNode) anchor.after(side); };
  const close = (focus = true) => {
    if (dialog.open) dialog.close();
    restoreSide();
    if (!media.matches) expanded = false;
    sync();
    if (focus) {
      const target = opener?.isConnected && opener.getClientRects().length ? opener : [...triggers()].find(node => node.getClientRects().length);
      target?.focus({ preventScroll: true });
    }
  };
  const click = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-channel-details-close]")) { close(); return; }
    const trigger = target?.closest<HTMLElement>("[data-channel-details-toggle]");
    if (!trigger || !side || !enabled) return;
    opener = trigger;
    if (media.matches) {
      if (dialog.open) { close(); return; }
      dialog.append(side); dialog.showModal(); sync();
      side.querySelector<HTMLElement>("[data-channel-details-close]")?.focus({ preventScroll: true });
    } else { expanded = !expanded; sync(); }
  };
  const resize = () => { if (dialog.open) { dialog.close(); restoreSide(); } sync(); };
  const cancel = (event: Event) => { event.preventDefault(); close(); };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !media.matches && expanded && side?.contains(doc.activeElement)) {
      event.preventDefault(); close();
    }
  };
  const navigate = (event: MouseEvent) => {
    if (media.matches && (event.target as Element | null)?.closest("a[href]")) close(false);
  };
  return {
    set(active: boolean) {
      if (!frame || !side || !active && !mounted) return;
      if (!mounted) {
        side.before(anchor); side.id = "cs-channel-details"; side.setAttribute("aria-label", "Details");
        dialog.id = "cs-channel-details-sheet"; app.append(dialog);
        app.addEventListener("click", click); app.addEventListener("keydown", keydown);
        side.addEventListener("click", navigate); dialog.addEventListener("cancel", cancel);
        mounted = true;
      }
      if (enabled && !active && dialog.open) close(false);
      if (active) media.addEventListener("change", resize); else media.removeEventListener("change", resize);
      frame.toggleAttribute("data-channel-details-active", active);
      enabled = active; sync();
    },
    sync,
    destroy() {
      if (!mounted) return;
      if (dialog.open) dialog.close(); restoreSide();
      app.removeEventListener("click", click); app.removeEventListener("keydown", keydown);
      side?.removeEventListener("click", navigate); dialog.removeEventListener("cancel", cancel);
      media.removeEventListener("change", resize); dialog.remove(); anchor.remove();
      frame?.removeAttribute("data-channel-details-collapsed");
      frame?.removeAttribute("data-channel-details-active");
      if (side) {
        if (originalId) side.id = originalId; else side.removeAttribute("id");
        if (originalLabel) side.setAttribute("aria-label", originalLabel); else side.removeAttribute("aria-label");
      }
      mounted = false; enabled = false;
    },
  };
}
