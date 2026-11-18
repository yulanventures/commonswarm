/**
 * People & agents: the tabs. Which tabs there are, what each counts, which one is open, and the one
 * main action each offers. Pure; the view draws them. The open tab lives in the dialog's state, so the
 * dialog reopens on the tab last used in this page session.
 * (Admins joins when its read ships; see docs/design/2026-11-18-PEOPLE-AND-AGENTS-DIALOG.md.)
 */
export type PeopleTab = "people" | "agents" | "invites";
export const PEOPLE_TAB_DEFAULT: PeopleTab = "agents";

interface TabModel { people: readonly unknown[]; agents: readonly unknown[]; invites: readonly unknown[]; sample: boolean }
export interface PeopleTabInfo { id: PeopleTab; label: string; count: number; selected: boolean; name: string }

const LABELS: Record<PeopleTab, string> = { people: "People", agents: "Agents", invites: "Invites" };
const isTab = (value: unknown): value is PeopleTab => value === "people" || value === "agents" || value === "invites";

/** A stored or requested value as a tab, or null when it is not one. */
export function parsePeopleTab(value: unknown): PeopleTab | null { return isTab(value) ? value : null; }

/** The tab to show: the requested one when it exists here, otherwise Agents. The sample workspace has no Invites. */
export function peopleTab(model: Pick<TabModel, "sample">, requested: unknown): PeopleTab {
  const tab = parsePeopleTab(requested) ?? PEOPLE_TAB_DEFAULT;
  return tab === "invites" && model.sample ? PEOPLE_TAB_DEFAULT : tab;
}

/** The tabs in order, each with its count and its accessible name ("Invites, 3 waiting"). */
export function peopleTabs(model: TabModel, requested: unknown): PeopleTabInfo[] {
  const open = peopleTab(model, requested);
  const counts: Record<PeopleTab, number> = { people: model.people.length, agents: model.agents.length, invites: model.invites.length };
  const ids: PeopleTab[] = model.sample ? ["people", "agents"] : ["people", "agents", "invites"];
  return ids.map((id) => ({ id, label: LABELS[id], count: counts[id], selected: id === open,
    name: id === "invites" ? `Invites, ${counts[id]} waiting` : `${LABELS[id]}, ${counts[id]}` }));
}

/** The tab a person or an agent lives on: opening one from a link or from another profile shows its tab. */
export function peopleTabOf(kind: "person" | "agent"): PeopleTab { return kind === "person" ? "people" : "agents"; }

/** The search field's label on each tab. */
export function peopleSearchLabel(tab: PeopleTab): string {
  return tab === "people" ? "Find a person" : tab === "agents" ? "Find an agent" : "Find an invite";
}

/** The one main action a tab offers. Inviting needs an owner or an admin; the sample workspace offers neither. */
export function peopleTabAction(tab: PeopleTab, viewer: { mayInvite: boolean; sample: boolean }): "invite" | "add-agent" | null {
  if (viewer.sample) return null;
  if (tab === "agents") return "add-agent";
  return viewer.mayInvite ? "invite" : null;
}

/** What a search that found nothing, or something, says on each tab. */
export function peopleSearchResult(tab: PeopleTab, shown: number): string {
  const noun = tab === "people" ? (shown === 1 ? "person" : "people") : tab === "agents" ? (shown === 1 ? "agent" : "agents") : (shown === 1 ? "invite" : "invites");
  return `${shown} ${noun}${shown === 0 ? ". No matches. Try another name." : ""}`;
}
