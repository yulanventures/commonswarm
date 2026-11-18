/**
 * People & agents: the tabs. Which tabs there are, what each counts, which one is open, and the one
 * main action each offers. Pure; the view draws them. The open tab lives in the dialog's state, so the
 * dialog reopens on the tab last used in this page session.
 * Admins counts the people who can manage the workspace and the admin access given to agents.
 */
import type { PeopleRead } from "./states";
export type PeopleTab = "people" | "agents" | "invites" | "admins";
export const PEOPLE_TAB_DEFAULT: PeopleTab = "agents";

interface TabModel { people: readonly { role?: string }[]; agents: readonly unknown[]; invites: readonly unknown[]; sample: boolean; read?: PeopleRead; pendingFailed?: boolean;
  adminAccess?: { read: PeopleRead; grants: readonly unknown[] } }
/** `count` is null while it is not known: nothing has arrived and the read is still out or failed. A tab never says 0 for that. */
export interface PeopleTabInfo { id: PeopleTab; label: string; count: number | null; selected: boolean; name: string }

const LABELS: Record<PeopleTab, string> = { people: "People", agents: "Agents", invites: "Invites", admins: "Admins" };
const isTab = (value: unknown): value is PeopleTab => value === "people" || value === "agents" || value === "invites" || value === "admins";

/** A stored or requested value as a tab, or null when it is not one. */
export function parsePeopleTab(value: unknown): PeopleTab | null { return isTab(value) ? value : null; }

/** The tab to show: the requested one when it exists here, otherwise Agents. The sample workspace has no Invites and no Admins. */
export function peopleTab(model: Pick<TabModel, "sample">, requested: unknown): PeopleTab {
  const tab = parsePeopleTab(requested) ?? PEOPLE_TAB_DEFAULT;
  return (tab === "invites" || tab === "admins") && model.sample ? PEOPLE_TAB_DEFAULT : tab;
}

/** The tabs in order, each with its count and its accessible name ("Invites, 3 waiting"). */
export function peopleTabs(model: TabModel, requested: unknown): PeopleTabInfo[] {
  const open = peopleTab(model, requested);
  const managers = model.people.filter((person) => person.role === "owner" || person.role === "admin").length;
  const counts: Record<PeopleTab, number> = { people: model.people.length, agents: model.agents.length, invites: model.invites.length,
    admins: managers + (model.adminAccess?.grants.length ?? 0) };
  const ids: PeopleTab[] = model.sample ? ["people", "agents"] : ["people", "agents", "invites", "admins"];
  const read = model.sample ? "ready" : model.read ?? "ready";
  // Admins adds two reads together, so it shows a count only once both have arrived.
  const unknown = (id: PeopleTab) => id === "admins" ? read !== "ready" || (model.adminAccess?.read ?? "ready") !== "ready"
    : counts[id] === 0 && (read === "pending" || (id === "invites" ? !!model.pendingFailed : read === "failed"));
  return ids.map((id) => unknown(id) ? { id, label: LABELS[id], count: null, selected: id === open, name: LABELS[id] }
    : { id, label: LABELS[id], count: counts[id], selected: id === open,
      name: id === "invites" ? `Invites, ${counts[id]} waiting` : `${LABELS[id]}, ${counts[id]}` });
}

/** The tab a person or an agent lives on: opening one from a link or from another profile shows its tab. */
export function peopleTabOf(kind: "person" | "agent"): PeopleTab { return kind === "person" ? "people" : "agents"; }

/** The search field's label on each tab. */
export function peopleSearchLabel(tab: PeopleTab): string {
  return tab === "people" ? "Find a person" : tab === "agents" ? "Find an agent" : tab === "invites" ? "Find an invite" : "Find an admin";
}

/** The one main action a tab offers. Inviting needs an owner or an admin; the sample workspace offers neither. */
export function peopleTabAction(tab: PeopleTab, viewer: { mayInvite: boolean; sample: boolean }): "invite" | "add-agent" | null {
  if (viewer.sample) return null;
  if (tab === "agents") return "add-agent";
  if (tab === "admins") return null;
  return viewer.mayInvite ? "invite" : null;
}

/** What a search that found nothing, or something, says on each tab. */
export function peopleSearchResult(tab: PeopleTab, shown: number): string {
  const noun = tab === "people" ? (shown === 1 ? "person" : "people") : tab === "agents" ? (shown === 1 ? "agent" : "agents")
    : tab === "invites" ? (shown === 1 ? "invite" : "invites") : (shown === 1 ? "admin" : "admins");
  return `${shown} ${noun}${shown === 0 ? ". No matches. Try another name." : ""}`;
}
