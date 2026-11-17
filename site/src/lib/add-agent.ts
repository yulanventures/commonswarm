/*
 * What the Add an agent panel decides without the DOM: which new agent is this attempt's, and
 * what this browser remembers between visits.
 *
 * THIS ATTEMPT, NOT ANY NEW AGENT. The panel's watch used to accept any agent of the person's that
 * appeared while it was open. The watch runs for connector apps only, so the agent must have
 * joined over the hosted connection, and a typed name must match, ignoring case. With the name
 * left blank the agent names itself, so any new hosted agent of the person's is the best match the
 * browser can make; exact matching needs the server to echo the attempt, which waits for the
 * server change that also adds rename.
 *
 * REMEMBERED HERE ONLY. The last app used and the apps that joined through this panel are kept in
 * this browser's storage, which may be empty or refuse access. An app counts as connected only
 * while the agent that joined through it is still in the workspace roster.
 */

export interface JoinCandidate {
  principalId: string;
  name: string;
  ownerUserId: string | null;
  transport?: string | null;
}

/** The agent this attempt is waiting for, or null. `known` holds the agents present when it began. */
export function joinAttemptMatch<T extends JoinCandidate>(agents: readonly T[], attempt: {
  ownerUserId: string;
  known: ReadonlySet<string>;
  name: string;
}): T | null {
  const wanted = attempt.name.trim().toLocaleLowerCase();
  return agents.find((agent) => agent.ownerUserId === attempt.ownerUserId
    && !attempt.known.has(agent.principalId)
    && agent.transport === "hosted_mcp"
    && (!wanted || agent.name.trim().toLocaleLowerCase() === wanted)) ?? null;
}

type Store = Pick<Storage, "getItem" | "setItem">;

/** This browser's storage, or null where reading it throws (private windows, blocked site data). */
export function addAgentStore(): Store | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const LAST_HOST_KEY = "commonswarm:add-agent:last-host";
const JOINED_KEY = "commonswarm:add-agent:joined";
const JOINED_LIMIT = 50;

interface JoinedRecord { workspaceId: string; hostId: string; principalId: string }

const read = (store: Store | null, key: string): string | null => {
  try { return store?.getItem(key) ?? null; } catch { return null; }
};
const write = (store: Store | null, key: string, value: string): void => {
  try { store?.setItem(key, value); } catch { /* Storage is a convenience; a refusal changes nothing. */ }
};

export function lastHost(store: Store | null): string {
  return read(store, LAST_HOST_KEY) ?? "";
}

export function rememberLastHost(store: Store | null, hostId: string): void {
  if (hostId) write(store, LAST_HOST_KEY, hostId);
}

const joinedRecords = (store: Store | null): JoinedRecord[] => {
  try {
    const parsed: unknown = JSON.parse(read(store, JOINED_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is JoinedRecord => typeof entry?.workspaceId === "string"
        && typeof entry?.hostId === "string" && typeof entry?.principalId === "string")
      : [];
  } catch {
    return [];
  }
};

export function rememberJoinedHost(store: Store | null, record: JoinedRecord): void {
  const rest = joinedRecords(store).filter((entry) => entry.principalId !== record.principalId);
  write(store, JOINED_KEY, JSON.stringify([...rest, record].slice(-JOINED_LIMIT)));
}

/** Apps an agent in this workspace joined through, from this browser, while that agent is still here. */
export function connectedHosts(store: Store | null, workspaceId: string, roster: readonly string[]): string[] {
  const present = new Set(roster);
  return [...new Set(joinedRecords(store)
    .filter((entry) => entry.workspaceId === workspaceId && present.has(entry.principalId))
    .map((entry) => entry.hostId))];
}
