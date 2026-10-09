import type { Workspace } from "./tools.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests use tsx.
import { validSeatName } from "./tools.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests use tsx.
import { HostedToolFailure } from "./tool-errors.ts";

export interface DiscoveryResult {
  context_status: "unselected";
  grant_id: string;
  owner: { user_id: string; display_name: string };
  app: { client_id: string; display_name: string };
  workspaces: Workspace[];
  home_workspace_id: string | null;
  suggested_name: string;
  next_action: "claim_seat";
}

/** Trusted resolver input, never initialize.clientInfo or caller tool arguments.
 * The resolver must check the current provider family and persisted grant/owner
 * bindings. Per-workspace flags are current authorization, not cached consent.
 */
export interface DiscoveryData {
  grant: { id: string; owner_user_id: string; client_id: string; home_workspace_id: string | null; active: boolean };
  subject: string;
  provider_active: boolean;
  owner: { user_id: string; display_name: string };
  // Null means registered metadata is unavailable. It confers no identity label.
  registered_app: { client_id: string; display_name: string; suggested_name: string | null } | null;
  workspaces: ReadonlyArray<Workspace & { consented: boolean; member: boolean; live: boolean; permitted: boolean }>;
}

/** Pure assembly only. No allocation, selection, seat lookup, I/O or renewal. */
export function assembleDiscovery(data: DiscoveryData): DiscoveryResult {
  const { grant, owner, registered_app: app } = data;
  if (!grant.active || !data.provider_active || grant.owner_user_id !== data.subject ||
      owner.user_id !== data.subject || (app !== null && app.client_id !== grant.client_id)) {
    throw new HostedToolFailure("identity_resume_unavailable");
  }
  const workspaces = data.workspaces
    .filter(row => row.consented && row.member && row.live && row.permitted)
    .map(({ id, name }) => ({ id, name }));
  // A trusted mapping may provide a reliable label. Invalid/unreliable labels
  // fall back rather than guessing from client IDs, brand claims or clientInfo.
  const label = app?.suggested_name;
  const suggestedName = validSeatName(label) ? label : "Agent";
  return {
    context_status: "unselected", grant_id: grant.id,
    owner: { user_id: owner.user_id, display_name: owner.display_name },
    app: { client_id: grant.client_id, display_name: app?.display_name ?? "Agent" },
    workspaces,
    home_workspace_id: workspaces.some(row => row.id === grant.home_workspace_id) ? grant.home_workspace_id : null,
    suggested_name: suggestedName, next_action: "claim_seat",
  };
}
