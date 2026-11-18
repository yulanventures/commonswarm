/**
 * People & agents: what a tab shows when it has no rows to show, or could not load them. Every tab
 * answers the same four ways: loading, empty, could not load (with Retry), or its rows. Pure.
 */
import type { PeopleTab } from "./tabs";

/** The roster read (people and agents arrive together). Invites have their own failure flag. */
export type PeopleRead = "pending" | "ready" | "failed";
export type PeopleTabState = "rows" | "loading" | "empty" | "error" | "no-match";
export interface PeopleTabView {
  state: PeopleTabState;
  /** What the tab says in place of rows, or above them when a refresh failed. Empty for "rows" and "no-match". */
  message: string;
  /** Could not load: Retry is offered. */
  retry: boolean;
  /** Rows from the last good read are still shown under the message. */
  rows: boolean;
}

const NOUN: Record<PeopleTab, string> = { people: "People", agents: "Agents", invites: "Invites" };
const EMPTY: Record<PeopleTab, string> = { people: "No people yet.", agents: "No agents yet.", invites: "No invites waiting." };

export function peopleTabView(input: { tab: PeopleTab; read: PeopleRead; invitesFailed: boolean; shown: number; searching: boolean }): PeopleTabView {
  const { tab, read, shown, searching } = input;
  const failed = tab === "invites" ? input.invitesFailed : read === "failed";
  // A failed read can leave rows from the part that did arrive. They stay, under a line that says so.
  if (failed) return { state: "error", message: shown > 0 ? "This list may be out of date." : `${NOUN[tab]} could not load.`, retry: true, rows: shown > 0 };
  if (shown > 0) return { state: "rows", message: "", retry: false, rows: true };
  // The search line already says nothing matched.
  if (searching) return { state: "no-match", message: "", retry: false, rows: false };
  if (read === "pending") return { state: "loading", message: "Loading…", retry: false, rows: false };
  return { state: "empty", message: EMPTY[tab], retry: false, rows: false };
}
