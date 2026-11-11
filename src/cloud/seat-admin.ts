/** Seat admin, agent side: the agent reads its own admin access and sends the seven commands a grant allows. */
import { bindSessionProof } from "./session-proof.js";
import { sessionProofOf } from "./session-context.js";
import { openProfileCredential, profileTarget, profileWorkspaceSession, readAgentProfile, selectAgentWorkspace } from "./agent-profile.js";
import { assertWorkspaceName, CommandHttpError, CommandTransportError, newCommandId, ThinCommandClient, type CommandHttpResponse, type SeatAdminCommand } from "./command-client.js";
import type { CloudTarget } from "./config.js";
import { H0_REQUEST_ID_RE } from "../h0/verbs.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface SeatAdminGrant {
  grant_id: string;
  level: "workspace" | "organization" | "scoped";
  scope_names: string[];
  workspace_ids: string[];
  organization_id: string | null;
  capability_names: string[];
  expires_at: string | null;
}
export type SeatAdminSelf = { enabled: false } | { enabled: true; registry_version: number; grants: SeatAdminGrant[] };

export const SEAT_ADMIN_VERBS = ["rename-workspace", "set-lead", "add-agent", "remove-agent", "remove-member", "revoke-invitation", "rename-organization"] as const;
export type SeatAdminVerb = (typeof SEAT_ADMIN_VERBS)[number];

export class SeatAdminRejected extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SeatAdminRejected";
  }
}

export class SeatAdminOutcomeUnknown extends Error {
  constructor(readonly commandId: string) {
    super("The outcome is unknown.");
    this.name = "SeatAdminOutcomeUnknown";
  }
}

/** The agent's own credential for one profile and workspace; never a person's session. */
export async function openSeatAdminProfile(profilePath: string, hostSessionId: string | undefined, workspaceId: string | undefined) {
  const home = await readAgentProfile(profilePath, hostSessionId);
  const profile = selectAgentWorkspace(home, workspaceId);
  const managed = await profileWorkspaceSession(home, profile, hostSessionId);
  const fetcher = bindSessionProof(fetch, managed ? sessionProofOf(managed.context) : null);
  return {
    profile,
    open: async () => ({ target: profileTarget(profile), token: await (await openProfileCredential(home, fetcher)).bearer(), fetcher }),
  };
}

export async function readSeatAdminSelf(target: CloudTarget, token: string, workspaceId: string, fetcher: typeof fetch = fetch): Promise<SeatAdminSelf> {
  const response = await fetcher(`${target.url}/functions/v1/read`, { method: "POST",
    headers: { apikey: target.anonKey, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ resource: "seat_admin_self", workspace_id: workspaceId }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Admin access read failed (HTTP ${response.status}).`);
  const value = await response.json() as Record<string, unknown>;
  if (value.enabled === false) return { enabled: false };
  if (value.enabled !== true || !Array.isArray(value.grants)) throw new Error("Admin access read returned an invalid answer.");
  return { enabled: true, registry_version: Number(value.registry_version), grants: value.grants as SeatAdminGrant[] };
}

export function seatAdminStatusLines(self: SeatAdminSelf): string[] {
  if (!self.enabled) return ["Admin access is off."];
  if (self.grants.length === 0) return ["No admin access."];
  return self.grants.map(grant => {
    const where = grant.level === "organization" ? `organization ${grant.organization_id}` : `workspaces ${grant.workspace_ids.join(", ")}`;
    return `${grant.level} · ${where} · ${grant.expires_at === null ? "no end date" : `ends ${grant.expires_at}`}`;
  });
}

function uuidArgument(value: string | undefined, label: string): string {
  if (value === undefined || !UUID.test(value)) throw new Error(`Use the full ${label}.`);
  return value.toLowerCase();
}

/** One verb, one command. Targets are ids only; nothing is resolved by name. */
export function seatAdminCommand(verb: SeatAdminVerb, value: string | undefined): SeatAdminCommand {
  switch (verb) {
    case "rename-workspace":
    case "rename-organization": {
      const name = (value ?? "").trim();
      assertWorkspaceName(name);
      return verb === "rename-workspace" ? { kind: "rename_workspace", name } : { kind: "rename_organization", display_name: name };
    }
    case "set-lead":
      return { kind: "set_workspace_lead", principal_id: value?.toLowerCase() === "none" ? null : uuidArgument(value, "agent principal ID or none") };
    case "add-agent": return { kind: "add_agent_to_workspace", principal_id: uuidArgument(value, "agent principal ID") };
    case "remove-agent": return { kind: "remove_agent_from_workspace", principal_id: uuidArgument(value, "agent principal ID") };
    case "remove-member": return { kind: "remove_member", user_id: uuidArgument(value, "user ID") };
    case "revoke-invitation": return { kind: "revoke_invitation", invitation_id: uuidArgument(value, "invitation ID") };
  }
}

export function seatAdminConfirmation(command: SeatAdminCommand): string {
  switch (command.kind) {
    case "rename_workspace": return `Workspace renamed to ${command.name}.`;
    case "rename_organization": return `Organization renamed to ${command.display_name}.`;
    case "set_workspace_lead": return command.principal_id === null ? "Workspace lead cleared." : `Workspace lead set to ${command.principal_id}.`;
    case "add_agent_to_workspace": return `Agent ${command.principal_id} added.`;
    case "remove_agent_from_workspace": return `Agent ${command.principal_id} removed.`;
    case "remove_member": return `Member ${command.user_id} removed.`;
    case "revoke_invitation": return `Invitation ${command.invitation_id} revoked.`;
  }
}

/** A caller's request id becomes the command id, so a repeat after an unknown outcome cannot apply twice. */
export function seatAdminRequestId(value: string | undefined): string {
  if (value === undefined) return newCommandId();
  if (!H0_REQUEST_ID_RE.test(value)) throw new Error("--request-id must be 8 to 72 letters, digits, - or _.");
  return value;
}

/** Sends once and, after a transport failure, once more with the same command id and payload. */
export async function sendSeatAdminCommand(input: { target: CloudTarget; token: string; fetcher: typeof fetch; workspaceId: string;
  command: SeatAdminCommand; commandId: string; signal?: AbortSignal }): Promise<CommandHttpResponse> {
  const client = new ThinCommandClient(input.target, input.fetcher);
  const request = { workspaceId: input.workspaceId, command: input.command, credential: input.token, commandId: input.commandId, signal: input.signal };
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { response } = await client.sendSeatAdmin(request);
      if (response.status !== "accepted") throw new SeatAdminRejected(response.reason ?? "rejected");
      return response;
    } catch (error) {
      // A refusal the server decided (4xx, or a rejected receipt) is final. Anything else (no response, a 5xx, an
      // unreadable success) may have committed: retry once with the same id and payload, then report the id.
      if (error instanceof SeatAdminRejected) throw error;
      if (error instanceof CommandHttpError && error.status < 500) throw error;
      if (attempt === 2 || input.signal?.aborted) throw new SeatAdminOutcomeUnknown(input.commandId);
    }
  }
}
