import { configureManagementRuntime } from "./management-runtime.js";

const MANAGEMENT_KINDS = new Set([
  "begin_hosted_mcp_grant", "consent_hosted_mcp_workspace",
  "activate_hosted_mcp_grant", "revoke_hosted_mcp_grant", "revoke_hosted_mcp_seat",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function verified(identity) {
  if (identity?.identityVerified !== true || !UUID.test(identity.userId ?? "")) {
    const error = new Error("verified human identity required");
    error.code = "authentication_required";
    throw error;
  }
}

export async function createProductionManagementBindings(config) {
  if (!config.publicAuthorizationEnabled) return {};
  configureManagementRuntime(config);
  const { db, handleHostedManagementCommand } = await import("./management-command.generated.js");
  return {
    async managementCommand(input, identity) {
      verified(identity);
      if (!MANAGEMENT_KINDS.has(input?.command?.kind)) {
        return { status: 403, body: { error: "forbidden" } };
      }
      return await handleHostedManagementCommand(input, identity);
    },
    async managementWorkspaceReader(identity) {
      verified(identity);
      // The same membership-filtered view and transaction-local claims as the
      // read worker. No pool connection can retain another user's claims.
      return await db.begin("isolation level read committed", async (tx) => {
        await tx`SELECT
          set_config('role', 'swarm_read', true),
          set_config('search_path', 'swarm_read, swarm, pg_catalog', true),
          set_config('lock_timeout', '5s', true),
          set_config('request.jwt.claims', ${JSON.stringify({ sub: identity.userId, role: "authenticated" })}, true)`;
        return await tx`SELECT workspace_id AS id, name
          FROM swarm_read.workspaces ORDER BY name, workspace_id`;
      });
    },
    closeManagement: () => db.end({ timeout: 5 }),
  };
}
