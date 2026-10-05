import { catchUpGreeting, type CatchUpVM } from "./home-catchup";
import { railAgentName } from "./home-rail";
import type { RailVM } from "./home-types";
import type { WorkspaceShellVM } from "./home-shell";

/** Fields refreshed in place never decide whether to replace navigation controls. */
export function homeStructureKey(vm: RailVM | WorkspaceShellVM | CatchUpVM): string {
  return JSON.stringify(vm, function (key, value) {
    if (key === "now" || key === "when") return undefined;
    // Detail can also change its measured sentence; the rail updates it in place.
    if (key === "detail" && "word" in this && "fix" in this) return undefined;
    if (key === "what" && this.kind === "agent-fix") return undefined;
    return value;
  });
}

export interface HomeFocusIdentity { region: string; kind: string; id: string; action?: string }
/** Tuple encoding keeps ids containing punctuation distinct; row position is never an identity. */
export function homeFocusKey(identity: HomeFocusIdentity): string {
  return JSON.stringify([identity.region, identity.kind, identity.id, identity.action ?? ""]);
}
export function homeFocusTargetKey(requested: string, available: readonly string[], heading: string): string {
  return available.includes(requested) ? requested : heading;
}

/** Add identities at the integration boundary without changing the shared builders' API. */
function markFocusKeys(root: HTMLElement, region: string): void {
  for (const element of root.querySelectorAll<HTMLElement>("a[href], button, h1, h2, [tabindex]")) {
    const needs = element.closest<HTMLElement>("[data-needs-you]");
    const latest = element.closest<HTMLElement>("[data-latest-id]");
    const context = element.closest<HTMLElement>("[data-home-phone-bar], [data-home-workspace-header], [data-home-workspace-nav]");
    let kind: string; let id: string; let action: string | undefined;
    if (element.id) { kind = "element"; id = element.id; }
    else if (needs) { kind = "needs"; id = needs.dataset.needsYou!; action = element.dataset.primary; }
    else if (latest) { kind = "latest"; id = latest.dataset.latestId!; }
    else if (element.hasAttribute("data-rail-workspace") || element.hasAttribute("data-workspace-id")) {
      kind = "workspace"; id = element.dataset.railWorkspace ?? element.dataset.workspaceId!;
    } else if (element.hasAttribute("data-rail-person")) { kind = "person"; id = element.dataset.railPerson!; }
    else if (element.hasAttribute("data-rail-agent")) { kind = "agent"; id = element.dataset.railAgent!; }
    else if (element.hasAttribute("data-home-pane")) {
      kind = "pane"; id = element.dataset.homePane!; action = context?.dataset.homeWorkspaceNav;
    } else if (element.matches("[data-roster-open], .hm-phone-bar__people")) {
      kind = "people"; id = context?.hasAttribute("data-home-phone-bar") ? "phone" : "header";
    } else if (element.matches("a[href]")) { kind = "link"; id = element.getAttribute("href")!; }
    else { kind = "control"; id = element.className; }
    element.dataset.homeFocusKey = homeFocusKey({ region, kind, id, action });
  }
}

/** Replace only on a structural change. An open menu closes and focus returns to its trigger. */
export function replaceHomeRegion(slot: HTMLElement, region: string, children: HTMLElement[], fallback?: HTMLElement | null): void {
  const doc = slot.ownerDocument;
  const active = doc.activeElement as HTMLElement | null;
  const hadFocus = !!active && slot.contains(active);
  let requested = active?.dataset.homeFocusKey ?? "";
  if (hadFocus) {
    const openMenu = slot.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]');
    if (openMenu) requested = openMenu.dataset.homeFocusKey ?? requested;
  }
  for (const child of children) markFocusKeys(child, region);
  slot.replaceChildren(...children);
  if (!hadFocus) return;
  const visible = (element: HTMLElement) => !element.closest("[hidden]") && element.getClientRects().length > 0;
  const controls = Array.from(slot.querySelectorAll<HTMLElement>("[data-home-focus-key]")).filter(visible);
  const heading = controls.find(element => element.matches("h1, h2"));
  const key = homeFocusTargetKey(requested, controls.map(element => element.dataset.homeFocusKey!), heading?.dataset.homeFocusKey ?? "");
  const target = controls.find(element => element.dataset.homeFocusKey === key) ?? fallback ?? slot;
  if (target.matches("h1, h2") || target === slot) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/** Polls keep current measured details in titles and accessible names without replacing buttons. */
export function refreshHomeRailTimes(slot: HTMLElement, vm: RailVM): void {
  const agents = [...(vm.people?.groups.flatMap(group => group.agents) ?? []), ...(vm.people?.other ?? [])];
  for (const row of slot.querySelectorAll<HTMLElement>("[data-rail-agent]")) {
    const agent = agents.find(agent => agent.id === row.dataset.railAgent);
    if (!agent) continue;
    row.setAttribute("aria-label", railAgentName(agent));
    const status = row.querySelector<HTMLElement>(".hm-status");
    if (status) {
      status.title = agent.state.detail;
      status.setAttribute("aria-label", [agent.state.word, agent.state.detail, agent.state.attention ? agent.state.fix.sentence : ""].filter(Boolean).join(". "));
    }
  }
}

/** The greeting and timestamps are text nodes, so a clock tick cannot detach the focused H1. */
export function refreshHomeCatchUpTimes(slot: HTMLElement, vm: CatchUpVM): void {
  const heading = slot.querySelector<HTMLElement>(".hm-catchup-title");
  if (heading) heading.textContent = catchUpGreeting(vm.now, vm.viewerFirstName);
  for (const row of slot.querySelectorAll<HTMLElement>("[data-latest-id]")) {
    const item = vm.latest.find(item => item.id === row.dataset.latestId);
    const time = row.querySelector<HTMLElement>("time");
    if (item && time) time.textContent = item.when;
  }
  for (const row of slot.querySelectorAll<HTMLElement>("[data-needs-you], .hm-catchup-needs-preview")) {
    const item = vm.needsYou.find(item => row.dataset.needsYou === item.id || row.getAttribute("aria-labelledby") === `hm-catchup-needs-${item.id}`);
    const eyebrow = row.querySelector<HTMLElement>(".hm-eyebrow, .hm-catchup-needs-eyebrow");
    if (item && eyebrow) eyebrow.textContent = `Needs you · ${item.workspace.name} · ${item.when}`;
    const what = row.querySelector<HTMLElement>(".hm-needs-title, .hm-catchup-needs-what");
    if (item?.kind === "agent-fix" && what) what.textContent = item.what;
  }
}
