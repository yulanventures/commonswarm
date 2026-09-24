import { readEndpoint, type CloudTarget } from "./config.js";

export interface PendingAgentAccess {
  kind: "classic" | "join";
  principal_id: string | null;
  principal_name: string | null;
  join_credential_id: string | null;
  owner_user_id: string;
  issuer_display: string;
  issued_at: string;
  expires_at: string | null;
  seats_used: number | null;
  seat_cap: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

export function parsePendingAccess(value: unknown): PendingAgentAccess[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pending access read returned malformed data");
  const rows = (value as Record<string, unknown>).pending;
  if (!Array.isArray(rows)) throw new Error("pending access read returned malformed data");
  return rows.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pending access read returned malformed row");
    const row = value as Record<string, unknown>;
    const common = uuid(row.owner_user_id) && typeof row.issuer_display === "string" &&
      typeof row.issued_at === "string" && Number.isFinite(Date.parse(row.issued_at)) &&
      (row.expires_at === null || (typeof row.expires_at === "string" && Number.isFinite(Date.parse(row.expires_at))));
    const classic = row.kind === "classic" && uuid(row.principal_id) &&
      typeof row.principal_name === "string" && row.join_credential_id === null &&
      row.seats_used === null && row.seat_cap === null;
    const join = row.kind === "join" && row.principal_id === null && row.principal_name === null &&
      uuid(row.join_credential_id) && Number.isSafeInteger(row.seats_used) &&
      Number.isSafeInteger(row.seat_cap) && Number(row.seats_used) >= 0 &&
      Number(row.seat_cap) > Number(row.seats_used);
    if (!common || (!classic && !join)) throw new Error("pending access read returned malformed row");
    return {
      kind: row.kind as "classic" | "join",
      principal_id: row.principal_id as string | null,
      principal_name: row.principal_name as string | null,
      join_credential_id: row.join_credential_id as string | null,
      owner_user_id: row.owner_user_id as string,
      issuer_display: row.issuer_display as string,
      issued_at: row.issued_at as string,
      expires_at: row.expires_at as string | null,
      seats_used: row.seats_used as number | null,
      seat_cap: row.seat_cap as number | null,
    };
  });
}

export async function readPendingAccess(
  target: CloudTarget,
  bearer: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<PendingAgentAccess[]> {
  const response = await fetcher(readEndpoint(target), {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      apikey: target.anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ resource: "pending_access", workspace_id: workspaceId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`pending access read failed (${response.status})`);
  return parsePendingAccess(await response.json());
}

export async function readPendingAccessOptional(
  target: CloudTarget,
  bearer: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<PendingAgentAccess[] | null> {
  try { return await readPendingAccess(target, bearer, workspaceId, fetcher); }
  catch { return null; }
}

export function pendingAccessAge(issuedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(issuedAt)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
