/** Seat admin, agent side: the agent reads its own admin access and sends the commands a grant allows. */
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bindSessionProof } from "./session-proof.js";
import { sessionProofOf } from "./session-context.js";
import { AgentSetupError, assertPrivateLocation, openProfileCredential, profileTarget, profileWorkspaceSession, readAgentProfile,
  refusePendingConnectProfile, selectAgentWorkspace } from "./agent-profile.js";
import { assertWorkspaceName, CommandHttpError, CommandTransportError, newCommandId, ThinCommandClient, type CommandHttpResponse, type SeatAdminCommand,
  type SeatAdminCreateSeatCommand } from "./command-client.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "./agent-credential-input.js";
import type { AgentConnectionEnvelope } from "./agent-onboarding-contract.js";
import { checkedHostSessionId } from "./agent-receive.js";
import { CONNECT_PROFILE_FILES } from "./connect-profile-files.js";
import { deleteSecureJsonFile, writeSecureJsonFileExclusive } from "./storage.js";
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
  command: SeatAdminCommand | SeatAdminCreateSeatCommand; commandId: string; signal?: AbortSignal }): Promise<CommandHttpResponse> {
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

/* ---- create-seat: a new seat the grantor owns, delivered once to this caller's private file ---- */

const SEAT_NAME_MAX = 80;
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
const SEAT_TOKEN = /^swm_agt_[A-Za-z0-9_-]{43}$/u;
const SEAT_CONNECTION_FILE = "seat-connection.json";

/** The server's name rule: 1 to 80 characters, no control or direction characters. */
export function seatAdminSeatName(value: string | undefined): string {
  const name = (value ?? "").trim();
  if (name.length === 0) throw new Error("A seat name is required.");
  if (name.length > SEAT_NAME_MAX) throw new Error(`A seat name may be at most ${SEAT_NAME_MAX} characters.`);
  if (CONTROL.test(name)) throw new Error("A seat name may not contain control characters.");
  return name;
}

/** Where the new seat's credential goes: a connection file, or a profile set up from one. */
export type SeatDestination =
  | { kind: "connection"; path: string }
  | { kind: "setup"; profilePath: string; connectionPath: string; hostSessionId: string };

async function refuseExisting(path: string): Promise<void> {
  const present = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (present) throw new AgentSetupError("seat_destination_exists", `${path} already exists. Choose a new path; no seat was created.`);
}

/** Every local check runs before the request, so a seat is never created that this host can't save. */
export async function prepareSeatDestination(o: { connectionFile?: string; setupProfile?: string; seatHostSessionId?: string;
  callerProfile: string }): Promise<SeatDestination> {
  if ((o.connectionFile === undefined) === (o.setupProfile === undefined)) {
    throw new AgentSetupError("seat_destination_required", "Pass exactly one of --out-connection-file or --setup-profile.");
  }
  if (o.connectionFile !== undefined) {
    const path = await assertPrivateLocation(o.connectionFile);
    await refuseExisting(path);
    return { kind: "connection", path };
  }
  // The new seat's own host session, never this agent's: the seat is a different agent.
  if (o.seatHostSessionId === undefined) {
    throw new AgentSetupError("setup_host_session_required", "--setup-profile needs --seat-host-session-id with the new seat's session id, or manual.");
  }
  const hostSessionId = checkedHostSessionId(o.seatHostSessionId);
  const profilePath = await assertPrivateLocation(o.setupProfile!);
  if (dirname(profilePath) === dirname(await assertPrivateLocation(o.callerProfile))) {
    throw new AgentSetupError("profile_conflict", "Put the new seat's profile in its own directory, not this agent's.");
  }
  await refusePendingConnectProfile(profilePath);
  const connectionPath = join(dirname(profilePath), SEAT_CONNECTION_FILE);
  for (const path of [profilePath, join(dirname(profilePath), CONNECT_PROFILE_FILES.credential), connectionPath]) await refuseExisting(path);
  return { kind: "setup", profilePath, connectionPath, hostSessionId };
}

/** The seat exists, but its credential was not saved. Repeating the request id replaces the unused credential. */
export class SeatAdminDeliveryFailed extends Error {
  constructor(readonly commandId: string, readonly principalId: string) {
    super(`Seat ${principalId} was created, but its credential could not be saved. Run the same command again with --request-id ${commandId} to replace the unused credential.`);
    this.name = "SeatAdminDeliveryFailed";
  }
}

/** The connection file is saved; profile setup from it failed and can be run again. */
export class SeatAdminSetupFailed extends Error {
  constructor(readonly principalId: string, readonly connectionFile: string, reason: string) {
    super(`Seat ${principalId} was created and its connection file saved at ${connectionFile}, but setup failed: ${reason} Run cswarm setup --connection-file ${connectionFile} with the same --profile and --host-session-id.`);
    this.name = "SeatAdminSetupFailed";
  }
}

export interface CreatedSeat {
  principal_id: string;
  name: string;
  workspace_id: string;
  connection_file?: string;
  profile_path?: string;
}

/**
 * Creates the seat and writes its first credential into a new 0600 file (never over an existing one). The token is
 * read from the raw answer here and goes only into that file: the answer itself is never returned, printed or logged.
 */
export async function createSeatAdminSeat(input: { target: CloudTarget; token: string; fetcher: typeof fetch; workspaceId: string;
  name: string; commandId: string; destination: SeatDestination; signal?: AbortSignal;
  writeFile?: (path: string, serialized: string) => Promise<void>;
  setup?: (options: { connectionFile: string; profilePath: string; hostSessionId: string }) => Promise<unknown> }): Promise<CreatedSeat> {
  const answer = await sendSeatAdminCommand({ target: input.target, token: input.token, fetcher: input.fetcher, workspaceId: input.workspaceId,
    command: { kind: "create_agent_seat", name: input.name }, commandId: input.commandId, signal: input.signal }) as unknown as Record<string, unknown>;
  const field = (key: string) => typeof answer[key] === "string" ? answer[key] as string : "";
  const seat = { principal_id: field("principal_id").toLowerCase(), run_id: field("run_id").toLowerCase(), token_id: field("token_id").toLowerCase(),
    workspace_id: field("workspace_id").toLowerCase(), expires_at: field("expires_at") };
  const agentToken = field("agent_token");
  if (![seat.principal_id, seat.run_id, seat.token_id].every(id => UUID.test(id)) || seat.workspace_id !== input.workspaceId.toLowerCase()
    || Number.isNaN(Date.parse(seat.expires_at))) throw new Error("The server's answer did not describe a new seat.");
  // No token means nothing to save; asking again with the same request id replaces an unused one.
  if (!SEAT_TOKEN.test(agentToken)) throw new SeatAdminDeliveryFailed(input.commandId, seat.principal_id);
  const connection: AgentConnectionEnvelope = { version: 1, url: input.target.url, anon_key: input.target.anonKey,
    workspace_id: seat.workspace_id, principal_id: seat.principal_id,
    credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: seat.principal_id, run_id: seat.run_id,
      token_id: seat.token_id, agent_token: agentToken, expires_at: seat.expires_at } };
  const file = input.destination.kind === "connection" ? input.destination.path : input.destination.connectionPath;
  try {
    await (input.writeFile ?? ((path: string, serialized: string) => writeSecureJsonFileExclusive(path, serialized)))(file, JSON.stringify(connection));
  } catch {
    throw new SeatAdminDeliveryFailed(input.commandId, seat.principal_id);
  }
  const created = { principal_id: seat.principal_id, name: input.name, workspace_id: seat.workspace_id };
  if (input.destination.kind === "connection") return { ...created, connection_file: file };
  const destination = input.destination;
  try {
    const setup = input.setup ?? (async (options: { connectionFile: string; profilePath: string; hostSessionId: string }) =>
      (await import("./agent-setup.js")).setupAgent(options));
    await setup({ connectionFile: file, profilePath: destination.profilePath, hostSessionId: destination.hostSessionId });
  } catch (error) {
    throw new SeatAdminSetupFailed(seat.principal_id, file, error instanceof AgentSetupError ? error.message : "the new seat could not sign in.");
  }
  // The profile's credential store now holds the token; the connection file is a second copy.
  await deleteSecureJsonFile(file).catch(() => undefined);
  return { ...created, profile_path: destination.profilePath };
}
