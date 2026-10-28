import { connectDrawer } from './drawer.js';
let sequence = 0;
const node = (doc, tag, className, text) => { const el = doc.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
const button = (doc, label, d) => { const el = node(doc, 'button', 'cs-icon-button'); el.type = 'button'; el.setAttribute('aria-label', label); const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'cs-icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); const path = doc.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); el.append(svg); return el; };
function placeholder(doc) {
  const mark = node(doc, 'span', 'cs-org-logo'); mark.setAttribute('aria-hidden', 'true');
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'cs-icon');
  const path = doc.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'); svg.append(path); mark.append(svg); return mark;
}
/** Display-only host projection. Nodes are moved, never cloned. No raw authority state. */
export function createOrgShell(doc, options = {}) {
  let prefix; do { prefix = `cs-org-shell-${++sequence}`; } while (doc.getElementById(prefix));
  const root = node(doc, 'div', 'cs-ui cs-org-shell'); root.id = prefix; root.dataset.csTheme = 'shell';
  const records = [], recorded = new Set(), released = doc.createDocumentFragment();
  const callbacks = options.drawerCallbacks || {};
  function move(slot, child, reason) {
    if (child.parentNode === slot) return;
    callbacks.beforeRelocate?.({ node: child, from: child.parentNode, to: slot, reason });
    slot.append(child);
  }
  function mount(slot, child, reason = 'mount') {
    if (!child) return;
    if (!recorded.has(child)) { records.push({ child, parent: child.parentNode, next: child.nextSibling }); recorded.add(child); }
    move(slot, child, reason);
  }
  const rail = node(doc, 'aside', 'cs-org-rail'), brand = node(doc, 'div', 'cs-org-brand'), railProducts = node(doc, 'div', 'cs-org-rail-products');
  rail.setAttribute('aria-label', 'Application navigation');
  const desktopAccount = node(doc, 'div', 'cs-org-rail-account'), account = node(doc, 'div', 'cs-org-account-slot');
  const products = node(doc, 'nav', 'cs-org-products'); products.setAttribute('aria-label', 'Product');
  let identities = new Map();
  products.tabIndex = -1;
  function setNavigation(items = []) {
    const active = doc.activeElement, focused = products.contains(active) ? active.closest('.cs-org-product') : null;
    const focusedKey = focused ? identities.get(focused) : undefined;
    const replacements = new Map(), content = doc.createDocumentFragment();
    for (const item of items) {
      const el = node(doc, item.href ? 'a' : 'button', 'cs-org-product');
      if (item.href) el.href = item.href; else { el.type = 'button'; el.disabled = typeof item.onActivate !== 'function'; }
      if (item.id) el.dataset.kylonId = String(item.id);
      el.title = item.label; if (item.current) el.setAttribute('aria-current', 'page');
      if (item.iconNode) mount(el, item.iconNode, 'navigation');
      else { const initial = node(doc, 'span', '', item.label.slice(0, 1)); initial.setAttribute('aria-hidden', 'true'); el.append(initial); }
      el.append(node(doc, 'span', 'cs-org-product-label', item.label));
      if (typeof item.onActivate === 'function') el.addEventListener('click', event => {
        if (item.href && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
        item.onActivate(event, item);
      });
      replacements.set(item.id ?? item, el); content.append(el);
    }
    products.replaceChildren(content); identities = new Map([...replacements].map(([key, element]) => [element, key]));
    if (focused && !focused.isConnected && doc.activeElement === doc.body) {
      const target = replacements.get(focusedKey);
      (target && !target.disabled ? target : products).focus({ preventScroll: true });
    }
  }
  setNavigation(options.navigation); railProducts.append(products); desktopAccount.append(account); mount(brand, options.nodes?.brand); rail.append(brand, railProducts, desktopAccount);
  const parking = node(doc, 'div', 'cs-org-context-parking'), context = node(doc, 'aside', 'cs-org-context');
  const contextLabel = options.contextLabel || 'Workspace navigation'; context.setAttribute('aria-label', contextLabel);
  const heading = node(doc, 'div', 'cs-org-drawer-heading'), drawerTitle = node(doc, 'h2', '', contextLabel); drawerTitle.id = `${prefix}-title`;
  const closeButton = button(doc, 'Close navigation', 'M6 6l12 12M18 6L6 18'); heading.append(drawerTitle, closeButton);
  const identitySlot = node(doc, 'div', 'cs-org-identity-slot');
  function setIdentity(identity = {}) {
    identity ||= {};
    const hadFocus = identitySlot.contains(doc.activeElement);
    const action = typeof identity.onActivate === 'function';
    const identityEl = node(doc, action ? 'button' : 'div', 'cs-org-identity');
    if (action) { identityEl.type = 'button'; identityEl.addEventListener('click', event => identity.onActivate(event)); }
    if (identity.logoNode) mount(identityEl, identity.logoNode, 'identity'); else identityEl.append(placeholder(doc));
    const copy = node(doc, 'span', 'cs-org-identity-copy');
    copy.append(node(doc, 'strong', '', identity.organizationName || 'Workspaces'));
    if (identity.workspaceName) copy.append(node(doc, 'small', '', identity.workspaceName));
    identityEl.append(copy);
    identitySlot.replaceChildren(identityEl);
    if (hadFocus && action && doc.activeElement === doc.body) identityEl.focus();
  }
  setIdentity(options.identity);
  const phoneProducts = node(doc, 'div', 'cs-org-phone-products'), contextBody = node(doc, 'div', 'cs-org-context-body');
  contextBody.dataset.scroll = options.contextScroll === 'pane' ? 'pane' : 'host';
  const drawerAccount = node(doc, 'div', 'cs-org-drawer-account'), contextScroll = node(doc, 'div', 'cs-org-context-scroll');
  contextScroll.append(identitySlot, phoneProducts, contextBody); context.append(heading, contextScroll, drawerAccount); parking.append(context);
  const workspace = node(doc, 'div', 'cs-org-workspace'), phoneBar = node(doc, 'nav', 'cs-org-phone-bar');
  phoneBar.setAttribute('aria-label', 'Workspace controls');
  const opener = button(doc, 'Open navigation', 'M4 6h16M4 12h16M4 18h16'); opener.setAttribute('aria-controls', `${prefix}-drawer`); opener.setAttribute('aria-expanded', 'false');
  const phoneTitle = node(doc, 'div', 'cs-org-phone-title'), phoneAccount = node(doc, 'div', 'cs-org-phone-account');
  function setTitle(title = '') { phoneTitle.textContent = title; phoneTitle.title = title; }
  setTitle(options.title); phoneBar.append(opener, phoneTitle, phoneAccount);
  const main = node(doc, 'div', 'cs-org-main-slot'); workspace.append(phoneBar, main);
  const dialog = node(doc, 'dialog', 'cs-org-drawer'); dialog.id = `${prefix}-drawer`; dialog.setAttribute('aria-labelledby', drawerTitle.id);
  root.append(rail, parking, workspace, dialog);
  mount(contextBody, options.nodes?.context); mount(main, options.nodes?.main); mount(account, options.nodes?.account);
  const drawer = connectDrawer({ root, rail, workspace, parking, context, dialog, opener, closeButton,
    products, railProducts, phoneProducts, account, desktopAccount, phoneAccount, drawerAccount, move }, callbacks);
  return { root, slots: { rail, products, brand, context: contextBody, identity: identitySlot, main, account, phoneHeader: phoneBar },
    openDrawer: drawer.open, closeDrawer: drawer.close, isDrawerOpen: drawer.isOpen,
    setIdentity, setNavigation, setTitle, mount,
    destroy() {
      drawer.destroy();
      for (const { child, parent, next } of records.reverse()) {
        const target = parent || released;
        callbacks.beforeRelocate?.({ node: child, from: child.parentNode, to: target, reason: 'destroy' });
        target.insertBefore(child, next?.parentNode === target ? next : null);
      }
      root.remove(); return released;
    }
  };
}
