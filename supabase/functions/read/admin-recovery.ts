import type postgres from "npm:postgres@3.4.9";
import { adminReadRequest, parseAdminRecoveryPage, type AdminReadRequest } from "./admin-recovery-contract.ts";

export { adminReadRequest };
export type { AdminReadRequest };

/** Narrow SECURITY DEFINER read; never assume swarm_command or read private tables. */
export async function readAdminRecovery(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  body: AdminReadRequest,
): Promise<Record<string, unknown>> {
  const rows = await tx<{ result: Record<string, unknown> }[]>`
    SELECT swarm_read.admin_recovery_page(
      ${body.resource}, ${body.workspace_id}::uuid, ${body.limit}, ${body.before}
    ) AS result
  `;
  if (!rows[0]?.result) throw new Error("admin recovery read returned no page");
  if (rows[0].result.error === "forbidden") return { error: "forbidden" };
  return { ...parseAdminRecoveryPage(rows[0].result) };
}
