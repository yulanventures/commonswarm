/* Modal presentation only. No route, permission, identity or account state. */
export function connectDrawer(parts, callbacks = {}) {
  const { root, rail, workspace, parking, context, dialog, opener, closeButton,
    products, railProducts, phoneProducts, account, desktopAccount, phoneAccount, drawerAccount, move } = parts;
  const doc = root.ownerDocument, media = doc.defaultView.matchMedia('(max-width:52rem)');
  const previousInert = new Map();
  let opened = false, returnFocus = null;
  const focusables = () => [...dialog.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]')]
    .filter(el => el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[hidden],[inert]'));
  function position(reason) {
    move(opened ? phoneProducts : railProducts, products, reason);
    move(opened ? drawerAccount : media.matches ? phoneAccount : desktopAccount, account, reason);
  }
  function finish(reason, restoreFocus = true) {
    if (!opened) return;
    opened = false; opener.setAttribute('aria-expanded', 'false');
    for (const [element, value] of previousInert) element.inert = value;
    previousInert.clear(); move(parking, context, reason); position(reason);
    if (restoreFocus) {
      const target = returnFocus?.isConnected && returnFocus.getClientRects().length ? returnFocus
        : media.matches ? opener : products.querySelector('a[href],button:not(:disabled)');
      target?.focus({ preventScroll: true });
    }
    returnFocus = null; callbacks.onClose?.(reason);
  }
  function close(reason = 'host', restoreFocus = true) {
    if (!opened) return;
    callbacks.beforeClose?.(reason);
    if (dialog.open) dialog.close();
    finish(reason, restoreFocus);
  }
  function open() {
    if (!media.matches || opened || !root.isConnected) return false;
    returnFocus = doc.activeElement; callbacks.beforeOpen?.();
    move(dialog, context, 'open'); opened = true; position('open');
    try { dialog.showModal(); }
    catch (error) { finish('unavailable'); throw error; }
    for (const element of [rail, workspace, parking]) { previousInert.set(element, element.inert); element.inert = true; }
    opener.setAttribute('aria-expanded', 'true'); closeButton.focus(); callbacks.onOpen?.(); return true;
  }
  function change() { if (!media.matches && opened) close('resize'); position('resize'); }
  function cancel(event) { event.preventDefault(); close('escape'); }
  function closed() {
    // A previous close event may arrive after the same dialog has reopened.
    if (!dialog.open) finish('native-close');
  }
  function backdrop(event) {
    if (event.target !== dialog) return;
    const b = dialog.getBoundingClientRect();
    if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) close('backdrop');
  }
  function trap(event) {
    if (!opened || event.key !== 'Tab') return;
    const items = focusables(), first = items[0], last = items.at(-1);
    if (!first) { event.preventDefault(); closeButton.focus(); return; }
    if (event.shiftKey && (doc.activeElement === first || !dialog.contains(doc.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (doc.activeElement === last || !dialog.contains(doc.activeElement))) { event.preventDefault(); first.focus(); }
  }
  const closeFromButton = () => close('button');
  opener.addEventListener('click', open); closeButton.addEventListener('click', closeFromButton);
  dialog.addEventListener('cancel', cancel); dialog.addEventListener('close', closed);
  dialog.addEventListener('click', backdrop); dialog.addEventListener('keydown', trap);
  media.addEventListener('change', change); position('initial-layout');
  return { open, close, isOpen: () => opened, destroy() {
    close('destroy', false); media.removeEventListener('change', change);
    opener.removeEventListener('click', open); closeButton.removeEventListener('click', closeFromButton);
    dialog.removeEventListener('cancel', cancel); dialog.removeEventListener('close', closed);
    dialog.removeEventListener('click', backdrop); dialog.removeEventListener('keydown', trap);
  } };
}
