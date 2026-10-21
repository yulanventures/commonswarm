import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;
type Role = "owner" | "admin" | "member";

export const FILE_WORKSPACE_MAX_NAMES = 5000;
export const FILE_WORKSPACE_MIN_NAMES = 1;
export const FILE_WORKSPACE_MAX_NAMES_CEILING = 1000000;
export const SET_WORKSPACE_FILE_LIMIT_KIND = "set_workspace_file_limit";
export const WORKSPACE_FILE_LIMIT_RANGE_MESSAGE =
  `file_max_names must be an integer from ${FILE_WORKSPACE_MIN_NAMES} to ${FILE_WORKSPACE_MAX_NAMES_CEILING}`;

export interface SetWorkspaceFileLimitCommand {
  kind: typeof SET_WORKSPACE_FILE_LIMIT_KIND;
  file_max_names: number;
}

export interface WorkspaceFileLimitActor {
  kind: "user" | "agent";
  id: string;
  role?: Role | null;
}

export type WorkspaceFileLimitRefusal = { status: number; error: string; message: string; reason: string };
export type WorkspaceFileLimitOutcome =
  | { ok: true; body: { workspace_id: string; file_max_names: number } }
  | { ok: false; refusal: WorkspaceFileLimitRefusal }
  | { ok: "replay"; stored: Record<string, unknown> };
export type WorkspaceFileLimitLedgerRecheck = () => Promise<{ hit: "stored"; stored: Record<string, unknown> } | { hit: "conflict" } | null>;

export function isValidWorkspaceFileMaxNames(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) &&
    v >= FILE_WORKSPACE_MIN_NAMES && v <= FILE_WORKSPACE_MAX_NAMES_CEILING;
}

export function resolveWorkspaceFileMaxNames(v: unknown): number {
  const r = v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>).file_max_names ?? (v as Record<string, unknown>).max_file_names
    : v;
  return isValidWorkspaceFileMaxNames(r) ? r : FILE_WORKSPACE_MAX_NAMES;
}

export function workspaceFileCountRefusalMessage(max = FILE_WORKSPACE_MAX_NAMES): string {
  return `this workspace already has ${max} file names; the purge frees a name 30 days after its tombstone — tombstoning alone does not`;
}

function exactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const a = Object.keys(v).sort(), b = [...keys].sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

const KIND = SET_WORKSPACE_FILE_LIMIT_KIND;

export function validateSetWorkspaceFileLimitCommand(cmd: Record<string, unknown>):
  | { ok: true; command: SetWorkspaceFileLimitCommand }
  | { ok: false; status: number; reason: string } {
  if (cmd.kind !== KIND) return { ok: false, status: 400, reason: "unknown workspace file limit command kind" };
  if (exactKeys(cmd, ["kind", "reset"]) && cmd.reset === true) return { ok: true, command: { kind: KIND, file_max_names: FILE_WORKSPACE_MAX_NAMES } };
  if (!exactKeys(cmd, ["kind", "file_max_names"]) || !isValidWorkspaceFileMaxNames(cmd.file_max_names)) return { ok: false, status: 400, reason: WORKSPACE_FILE_LIMIT_RANGE_MESSAGE };
  return { ok: true, command: { kind: KIND, file_max_names: cmd.file_max_names } };
}

const refuse = (status: number, error: string, message: string, reason = error): WorkspaceFileLimitOutcome => ({ ok: false, refusal: { status, error, message, reason } });
const OWNER_MSG = "changing the workspace file limit requires the Owner role";

export async function setWorkspaceFileLimit(
  tx: Sql, workspaceId: string, actor: WorkspaceFileLimitActor, cmd: SetWorkspaceFileLimitCommand, ledgerRecheck?: WorkspaceFileLimitLedgerRecheck,
): Promise<WorkspaceFileLimitOutcome> {
  if (!cmd || cmd.kind !== KIND || !isValidWorkspaceFileMaxNames(cmd.file_max_names)) return refuse(400, "file_limit_invalid", WORKSPACE_FILE_LIMIT_RANGE_MESSAGE);
  if (actor.kind !== "user") return refuse(403, "forbidden", "changing the workspace file limit requires an interactive human Owner credential", "credential_kind_forbidden");
  if (actor.role !== undefined && actor.role !== "owner") return refuse(403, "forbidden", OWNER_MSG, "not_workspace_owner");
  const [ws] = await tx<{ workspace_id: string; archived_at?: unknown; role?: string | null }[]>`
    SELECT w.workspace_id, w.archived_at,
      (SELECT m.role FROM swarm.memberships AS m WHERE m.workspace_id = w.workspace_id AND m.user_id = ${actor.id}::uuid AND m.revoked_at IS NULL LIMIT 1) AS role
    FROM swarm.workspaces AS w WHERE w.workspace_id = ${workspaceId}::uuid FOR UPDATE OF w
  `;
  if (!ws) return refuse(403, "forbidden", "workspace not found", "workspace_not_found");
  if (ledgerRecheck) {
    const s = await ledgerRecheck();
    if (s?.hit === "conflict") return refuse(409, "command_id_conflict", "this command id was already used with a different request", "command id conflict");
    if (s !== null) return { ok: "replay", stored: s.stored };
  }
  if ((ws.role !== undefined ? ws.role : (actor.role ?? null)) !== "owner") return refuse(403, "forbidden", OWNER_MSG, "not_workspace_owner");
  if (ws.archived_at !== null && ws.archived_at !== undefined) return refuse(409, "workspace_already_archived", "workspace is already closed");
  const [row] = await tx<{ workspace_id: string; file_max_names?: number }[]>`
    UPDATE swarm.workspaces SET file_max_names = ${cmd.file_max_names} WHERE workspace_id = ${workspaceId}::uuid AND archived_at IS NULL RETURNING workspace_id, file_max_names
  `;
  return { ok: true, body: { workspace_id: row?.workspace_id ?? workspaceId, file_max_names: resolveWorkspaceFileMaxNames(row?.file_max_names ?? cmd.file_max_names) } };
}

export function legacyAcceptRefusalMessage(reason: string): string {
  if (reason === "invitation_recipient_mismatch") return "This invitation is for a different verified email. Nothing was changed.";
  if (reason === "invitation_predates_removal") return "This invitation was issued before the member was removed. Nothing was changed.";
  return "Open the invitation in /invite and review it as yourself.";
}

export function stampMillis(v: Date | string | null | undefined): number {
  return v instanceof Date ? v.getTime() : typeof v === "string" ? new Date(v).getTime() : Number.NaN;
}
