import { createOrgShell } from "./shell.js";

type Navigation = { id: string; label: string; href: string; current: boolean; icon: string };
type Projection = { enabled: boolean; title: string; workspaceName?: string; navigation: Navigation[] };

/** Presentation adapter. The app retains all routes, data, account and action ownership. */
export function createKylonHost(app: HTMLElement, navigate: (href: string) => void) {
  const doc = app.ownerDocument;
  const frame = app.querySelector<HTMLElement>(".hm-frame");
  const context = app.querySelector<HTMLElement>("[data-home-rail-slot]");
  const account = app.querySelector<HTMLElement>("[data-user-menu-root]");
  const accountIcon = account?.querySelector(".dashboard__user-trigger > svg");
  const accountPath = accountIcon?.querySelector("path");
  const originalIcon = { viewBox: accountIcon?.getAttribute("viewBox"), path: accountPath?.getAttribute("d") };
  let shell: ReturnType<typeof createOrgShell> | null = null;
  let key = "";
  let title = "";
  let phoneMenu: { node: HTMLElement; parent: HTMLElement } | null = null;
  let phoneHeading: { node: HTMLElement; parent: HTMLElement } | null = null;
  let menuDock: HTMLElement | null = null;
  const icons = new Map<string, SVGSVGElement>();
  const restoreMenu = () => {
    if (phoneMenu) { phoneMenu.parent.append(phoneMenu.node); phoneMenu = null; }
    if (phoneHeading) { phoneHeading.parent.append(phoneHeading.node); phoneHeading = null; }
  };
  const restore = () => {
    restoreMenu();
    if (accountIcon && originalIcon.viewBox != null) accountIcon.setAttribute("viewBox", originalIcon.viewBox);
    if (accountPath && originalIcon.path != null) accountPath.setAttribute("d", originalIcon.path);
    shell?.destroy(); shell = null; menuDock = null; key = "";
  };

  const closeOverlays = () => {
    for (const menu of app.querySelectorAll<HTMLElement>("[data-user-menu], .hm-menu__list, .hm-channel-menu__panel")) {
      menu.hidden = true;
      for (const trigger of app.querySelectorAll<HTMLElement>("[aria-expanded][aria-controls]")) {
        if (trigger.getAttribute("aria-controls") === menu.id) trigger.setAttribute("aria-expanded", "false");
      }
    }
  };
  const icon = (path: string) => {
    const retained = icons.get(path);
    if (retained) return retained;
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "cs-icon");
    svg.setAttribute("aria-hidden", "true");
    const shape = doc.createElementNS(svg.namespaceURI, "path"); shape.setAttribute("d", path); svg.append(shape);
    icons.set(path, svg); return svg;
  };
  const syncMenu = (active = true) => {
    if (!menuDock) return;
    if (!active) { restoreMenu(); shell!.setTitle(title); return; }
    const node = app.querySelector<HTMLElement>(".hm-phone-bar > .hm-menu") ?? phoneMenu?.node;
    const heading = app.querySelector<HTMLElement>(".hm-phone-bar > .hm-phone-bar__title") ?? phoneHeading?.node;
    const headingDock = shell!.slots.phoneHeader.querySelector(".cs-org-phone-title")!;
    if ((!node || node.parentElement === menuDock) && (!heading || heading.parentElement === headingDock)) return;
    closeOverlays(); restoreMenu();
    if (node) { phoneMenu = { node, parent: node.parentElement! }; menuDock.append(node); }
    if (heading) { phoneHeading = { node: heading, parent: heading.parentElement! }; headingDock.replaceChildren(heading); }
  };

  return {
    sync(vm: Projection) {
      if (!vm.enabled || !frame || !context || !account) {
        if (shell) restore();
        return;
      }
      if (!shell) {
        const parent = frame.parentNode!;
        const anchor = frame.nextSibling;
        shell = createOrgShell(doc, {
          identity: {}, contextLabel: "Workspace navigation", contextScroll: "host",
          nodes: { context, main: frame, account },
          drawerCallbacks: { beforeOpen: closeOverlays, beforeClose: closeOverlays, beforeRelocate: closeOverlays },
        });
        parent.insertBefore(shell.root, anchor);
        if (accountPath) { accountIcon!.setAttribute("viewBox", "0 0 24 24"); accountPath.setAttribute("d", "M20 21v-2a7 7 0 0 0-14 0v2M13 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8"); }
        shell.root.dataset.kylonLiveLayout = "";
        menuDock = doc.createElement("div"); menuDock.className = "cs-kylon-workspace-menu";
        shell.slots.phoneHeader.insertBefore(menuDock, shell.slots.phoneHeader.lastElementChild);
        const mark = doc.createElement("a"); mark.href = "/";
        mark.className = "cs-kylon-brand"; mark.setAttribute("aria-label", "CommonSwarm home");
        const logo = doc.createElement("span"); logo.className = "hm-rail__mark"; logo.setAttribute("aria-hidden", "true");
        mark.append(logo); shell.slots.brand.append(mark);
      }
      // Data/route changes update existing slots; time-only refreshes keep keyboard focus intact.
      const next = JSON.stringify([vm.title, vm.workspaceName, vm.navigation]);
      if (next === key) return;
      key = next;
      shell.closeDrawer("navigation", false);
      shell.setIdentity({ workspaceName: vm.workspaceName });
      title = vm.workspaceName || vm.title;
      shell.setTitle(title);
      shell.setNavigation(vm.navigation.map(item => ({ ...item, iconNode: icon(item.icon), onActivate: (event: MouseEvent) => {
        if (event.defaultPrevented) return;
        event.preventDefault(); shell?.closeDrawer("navigation", false); navigate(item.href);
      } })));
      syncMenu();
    },
    syncMenu,
    suspend() { if (shell) restore(); },
    get mounted() { return shell !== null; },
  };
}
