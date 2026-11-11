/** A small right-click menu: one open at a time, placed at the pointer (or under the row when opened from the
 *  keyboard), kept inside the viewport, and driven like a native menu (arrows, Home/End, Enter/Space, Escape, Tab). */

export interface ContextMenuItem {
  label: string;
  run: () => void;
  /** Draws the item in the danger colour. */
  danger?: boolean;
}

/** null separates groups. */
export type ContextMenuEntries = Array<ContextMenuItem | null>;

let closeOpen: (() => void) | null = null;

export function closeContextMenu(): void {
  closeOpen?.();
}

/** Opens a menu for `anchor`. A keyboard-opened contextmenu event (Shift+F10, the Menu key) has no pointer
 *  position, so the menu sits under the anchor instead. Focus returns to `anchor` when the menu closes without
 *  running an item. */
export function openContextMenu(event: MouseEvent, anchor: HTMLElement, entries: ContextMenuEntries, label: string): void {
  const items = entries.filter((entry): entry is ContextMenuItem => entry !== null);
  if (!items.length) return;
  event.preventDefault();
  closeContextMenu();
  const doc = anchor.ownerDocument;
  const menu = doc.createElement("div");
  menu.className = "cs-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  menu.dataset.contextMenu = "";
  const buttons: HTMLButtonElement[] = [];
  let ran = false;
  const finish = (refocus: boolean): void => {
    if (closeOpen !== close) return;
    closeOpen = null;
    menu.remove();
    doc.removeEventListener("pointerdown", onOutside, true);
    doc.removeEventListener("scroll", onScroll, true);
    doc.defaultView?.removeEventListener("resize", onDismiss);
    doc.defaultView?.removeEventListener("blur", onDismiss);
    anchor.removeAttribute("data-context-open");
    if (refocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const close = (): void => finish(false);
  const onOutside = (pointer: Event): void => { if (!menu.contains(pointer.target as Node)) finish(false); };
  const onDismiss = (): void => finish(false);
  // Close on a scroll only when the anchor itself moved: the page, or a pane that contains it. Another pane
  // scrolling (a feed updating behind the menu) or the menu's own list leaves it open where it belongs.
  const onScroll = (scroll: Event): void => {
    const target = scroll.target;
    if (target === doc || target === doc.documentElement || target === doc.body ||
      (target instanceof Node && target !== menu && target.contains(anchor))) finish(false);
  };
  let lastWasSeparator = true;
  for (const entry of entries) {
    if (entry === null) {
      if (!lastWasSeparator) { const rule = doc.createElement("div"); rule.className = "cs-context-menu__separator"; rule.setAttribute("role", "separator"); menu.append(rule); }
      lastWasSeparator = true;
      continue;
    }
    lastWasSeparator = false;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "cs-context-menu__item";
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.textContent = entry.label;
    if (entry.danger) button.dataset.danger = "";
    button.addEventListener("click", () => { if (ran) return; ran = true; finish(false); entry.run(); });
    buttons.push(button);
    menu.append(button);
  }
  if (menu.lastElementChild?.getAttribute("role") === "separator") menu.lastElementChild.remove();
  const move = (to: number): void => { const next = buttons[(to + buttons.length) % buttons.length]; next?.focus({ preventScroll: true }); };
  menu.addEventListener("keydown", key => {
    const at = buttons.indexOf(doc.activeElement as HTMLButtonElement);
    if (key.key === "ArrowDown") move(at + 1);
    else if (key.key === "ArrowUp") move(at < 0 ? -1 : at - 1);
    else if (key.key === "Home") move(0);
    else if (key.key === "End") move(-1);
    else if ((key.key === "Enter" || key.key === " ") && at >= 0) buttons[at]?.click();
    else if (key.key === "Escape") finish(true);
    else if (key.key === "Tab") finish(true);
    else if (key.key.length === 1 && /\S/.test(key.key)) {
      const letter = key.key.toLowerCase();
      const order = [...buttons.slice(at + 1), ...buttons.slice(0, at + 1)];
      order.find(button => button.textContent?.toLowerCase().startsWith(letter))?.focus({ preventScroll: true });
    } else return;
    key.preventDefault();
    key.stopPropagation();
  });
  menu.addEventListener("contextmenu", inner => inner.preventDefault());
  /* Inside an open modal (the phone navigation drawer) the menu must live in that dialog: everything
     outside a modal dialog is inert. */
  (anchor.closest<HTMLElement>("dialog[open]") ?? anchor.closest("live-dashboard") ?? doc.body).append(menu);
  closeOpen = close;
  anchor.dataset.contextOpen = "";
  const view = doc.defaultView;
  const viewportWidth = view?.innerWidth ?? 1024;
  const viewportHeight = view?.innerHeight ?? 768;
  const fromKeyboard = event.detail === 0 && event.clientX === 0 && event.clientY === 0;
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = fromKeyboard ? rect.left + 8 : event.clientX;
  let top = fromKeyboard ? rect.bottom + 4 : event.clientY;
  if (left + width > viewportWidth - 8) left = Math.max(8, viewportWidth - 8 - width);
  if (top + height > viewportHeight - 8) top = Math.max(8, (fromKeyboard ? rect.top - 4 : top) - height);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  doc.addEventListener("pointerdown", onOutside, true);
  doc.addEventListener("scroll", onScroll, true);
  view?.addEventListener("resize", onDismiss);
  view?.addEventListener("blur", onDismiss);
  menu.addEventListener("focusout", focus => {
    if (!ran && focus.relatedTarget instanceof Node && !menu.contains(focus.relatedTarget)) finish(false);
  });
  move(0);
}
