/** Local stdio only: listed when this agent's own seat_admin_self read for the workspace says admin access is on. */
import { H0_REQUEST_ID_RE } from "../h0/verbs.js";
import { seatAdminCommand, type SeatAdminVerb } from "../cloud/seat-admin.js";
import type { SeatAdminCommand } from "../cloud/command-client.js";
import { MCP_ARGUMENT_NAME_ECHO_MAX, requestId, schema, string, uuid } from "./tools.js";
import { WORKSPACE_NAME_MAX_LENGTH } from "../cloud/command-client.js";

const RETRY = "Retry with the same request_id and arguments if the outcome is unknown.";
const name = string(WORKSPACE_NAME_MAX_LENGTH, 1);
const uuidBody = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const leadOrNone = { ...string(uuid.maxLength, 4, `^(?:none|${uuidBody})$`), description: "An agent principal ID, or none to clear the lead." };

/** Each write tool names its verb and the one argument that carries the target. */
export const SEAT_ADMIN_WRITE_TOOLS = [
  { name: "admin_rename_workspace", verb: "rename-workspace", key: "name", description: `Rename this workspace. ${RETRY}`, property: name },
  { name: "admin_set_lead", verb: "set-lead", key: "principal_id", description: `Set or clear this workspace's lead agent. ${RETRY}`, property: leadOrNone },
  { name: "admin_add_agent", verb: "add-agent", key: "principal_id", description: `Add an agent to this workspace. ${RETRY}`, property: uuid },
  { name: "admin_remove_agent", verb: "remove-agent", key: "principal_id", description: `Remove an agent from this workspace. ${RETRY}`, property: uuid },
  { name: "admin_remove_member", verb: "remove-member", key: "user_id", description: `Remove a member from this workspace. ${RETRY}`, property: uuid },
  { name: "admin_revoke_invitation", verb: "revoke-invitation", key: "invitation_id", description: `Revoke an invitation to this workspace. ${RETRY}`, property: uuid },
  { name: "admin_rename_organization", verb: "rename-organization", key: "display_name", description: `Rename this workspace's organization. ${RETRY}`, property: name },
] as const satisfies ReadonlyArray<{ name: string; verb: SeatAdminVerb; key: string; description: string; property: object }>;

export const SEAT_ADMIN_MCP_TOOLS = [
  { name: "admin_status", description: "Show this agent's admin access: level, workspaces or organization, allowed commands and end date.", inputSchema: schema({ workspace_id: uuid }) },
  ...SEAT_ADMIN_WRITE_TOOLS.map(tool => ({ name: tool.name, description: tool.description,
    inputSchema: schema({ [tool.key]: tool.property, request_id: requestId, workspace_id: uuid }, [tool.key, "request_id"]) })),
];

export function isSeatAdminTool(toolName: string): boolean {
  return SEAT_ADMIN_MCP_TOOLS.some(tool => tool.name === toolName);
}

/** Arguments after stdioWorkspaceArguments removed workspace_id. Targets are ids only; nothing is resolved by name. */
export function seatAdminMcpCommand(toolName: string, value: Record<string, unknown>): { command: SeatAdminCommand; requestId: string } | null {
  const tool = SEAT_ADMIN_WRITE_TOOLS.find(row => row.name === toolName);
  const allowed = tool === undefined ? [] : [tool.key, "request_id"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown argument: ${JSON.stringify(key.slice(0, MCP_ARGUMENT_NAME_ECHO_MAX))}.`);
  }
  if (tool === undefined) return null;
  for (const key of allowed) {
    if (typeof value[key] !== "string") throw new Error(`Missing argument: ${key}.`);
  }
  const id = value.request_id as string;
  if (!H0_REQUEST_ID_RE.test(id)) throw new Error("Invalid argument: request_id.");
  try {
    return { command: seatAdminCommand(tool.verb, value[tool.key] as string), requestId: id };
  } catch {
    throw new Error(`Invalid argument: ${tool.key}.`);
  }
}
