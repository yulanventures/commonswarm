/**
 * People & agents: the Admins tab. Who can manage this workspace: the people with the owner or admin role, and the
 * admin access given to agents. Pure.
 *
 * Agent rows are grants on record, not a statement of what an agent can do right now: a grant stays listed after its
 * giver loses their role or the agent leaves the workspace, so an owner can find it and end it. The server checks
 * authority again each time the access is used. A row is drawn from the read's own names; its agent need not be in
 * the roster any more.
 */
import type { PeopleRead } from "./states";

export type PeopleAdminLevel = "workspace" | "organization" | "scoped";
export interface PeopleAdminGrant {
  grantId: string;
  principalId: string;
  agentName: string;
  /** The person who gave the access, and their name when the read has it. */
  giverId: string;
  giverName: string | null;
  level: PeopleAdminLevel;
  expiresAt: string | null;
  /** The server would accept this viewer ending it. Remove is offered only then; the command still decides. */
  mayEnd: boolean;
}
export interface PeopleAdminAccess {
  read: PeopleRead;
  /** True: every grant on record for this workspace (the viewer is an owner). False: only what the viewer gave. */
  all: boolean;
  grants: PeopleAdminGrant[];
  /** A refusal or an unknown outcome to show on a grant's row, by grant id. */
  notices?: Record<string, string>;
}
/** How far ending a grant reaches, for the confirmation's question. Only a workspace grant ends here alone. */
export const peopleAdminCoverage = (grant: Pick<PeopleAdminGrant, "level">, workspaceName: string): string =>
  grant.level === "workspace" ? workspaceName : grant.level === "organization" ? "this organization" : "every workspace it covers";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVELS: readonly string[] = ["workspace", "organization", "scoped"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * swarm_read.workspace_seat_admin_grants answers null when the viewer is not a live owner of the workspace (the
 * caller then lists only what the viewer gave), and {grants: [...]} otherwise. Anything else is a failed read:
 * a list of who holds admin access is never guessed from a malformed answer.
 */
export function parseWorkspaceAdminGrants(raw: unknown): PeopleAdminGrant[] | null {
  if (raw === null) return null;
  if (!record(raw) || !Array.isArray(raw.grants)) throw new Error("Admin access could not be read.");
  return raw.grants.map((row): PeopleAdminGrant => {
    if (!record(row) || typeof row.grant_id !== "string" || !ID.test(row.grant_id) || typeof row.principal_id !== "string" || !ID.test(row.principal_id)
      || typeof row.agent_name !== "string" || !row.agent_name || typeof row.owner_user_id !== "string" || !ID.test(row.owner_user_id)
      || typeof row.level !== "string" || !LEVELS.includes(row.level) || typeof row.may_end !== "boolean"
      || !(row.expires_at === null || (typeof row.expires_at === "string" && Number.isFinite(Date.parse(row.expires_at)))))
      throw new Error("Admin access could not be read.");
    return { grantId: row.grant_id.toLowerCase(), principalId: row.principal_id.toLowerCase(), agentName: row.agent_name,
      giverId: row.owner_user_id.toLowerCase(), giverName: typeof row.owner_display === "string" && row.owner_display.trim() ? row.owner_display.trim() : null,
      level: row.level as PeopleAdminLevel, expiresAt: row.expires_at as string | null, mayEnd: row.may_end };
  });
}

/**
 * The read is not on this server yet: its migration has not been applied. The page then lists what the viewer gave,
 * under the heading that says so, instead of failing. Any other refusal is a failed read.
 */
export function workspaceAdminGrantsNotDeployed(status: number, code: unknown): boolean {
  return status === 404 || code === "PGRST202" || code === "42883";
}

export const peopleAdminLevelName = (level: PeopleAdminLevel): string =>
  level === "workspace" ? "Workspace admin" : level === "organization" ? "Organization admin" : "Scoped admin";

const day = (iso: string): string => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(iso));

/** The line under an agent's name: what was given, who gave it, and when it ends. */
export function peopleAdminDetail(grant: PeopleAdminGrant, viewerId: string): string {
  // A missing name says nothing about whether the grantor is a member here, so the line does not guess.
  const giver = grant.giverId === viewerId.toLowerCase() ? "granted by you" : grant.giverName ? `granted by ${grant.giverName}` : "grantor name unavailable";
  return `${peopleAdminLevelName(grant.level)} · ${giver} · ${grant.expiresAt ? `ends ${day(grant.expiresAt)}` : "no end date"}`;
}

/** The section's heading says whether the list is everything or only the viewer's own. */
export const peopleAdminHeading = (access: Pick<PeopleAdminAccess, "all">): string =>
  access.all ? "Admin access given to agents" : "Admin access you gave to agents";
/** Ended and expired grants drop out of the list, so the empty line speaks of active grants only. */
export const peopleAdminEmpty = (access: Pick<PeopleAdminAccess, "all">): string =>
  access.all ? "No active admin grants for agents here." : "No active admin grants from you here.";

/** The people who can manage the workspace. */
export const peopleAdminPeople = <P extends { role?: string }>(people: readonly P[]): P[] =>
  people.filter((person) => person.role === "owner" || person.role === "admin");
