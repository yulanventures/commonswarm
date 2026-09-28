import { createHash, randomUUID } from "node:crypto";

import { RESOURCE } from "./provider.js";

function stableUuid(...parts) {
  const bytes = createHash("sha256").update(parts.join("\0")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function workspaceManifest(workspaceIds) {
  const selectedWorkspaceIds = [...new Set(workspaceIds)].sort();
  const manifestDigest = createHash("sha256")
    .update(JSON.stringify(selectedWorkspaceIds))
    .digest("hex");
  return { selectedWorkspaceIds, manifestDigest };
}

function input(workspaceId, commandId, command) {
  return { workspace_id: workspaceId, stream: { kind: "workspace" }, command_id: commandId, command };
}

function stepFor(body) {
  const kind = body.command.kind;
  return {
    kind: kind === "begin_hosted_mcp_grant" ? "begin"
      : kind === "consent_hosted_mcp_workspace" ? "consent"
      : kind === "activate_hosted_mcp_grant" ? "activate"
      : kind === "revoke_hosted_mcp_grant" ? "revoke_grant"
      : "revoke_seat",
    workspaceId: body.workspace_id,
    commandId: body.command_id,
    receiptId: body.command.consent_receipt_id ?? null,
  };
}

export function createPostgresConsentProgress(pool) {
  return {
    async isComplete(interactionUid, step) {
      const result = await pool.query(
        `SELECT completed_at IS NOT NULL AS complete
           FROM commonswarm_oauth.consent_orchestration
          WHERE interaction_uid = $1 AND step_kind = $2 AND workspace_id = $3::uuid`,
        [interactionUid, step.kind, step.workspaceId],
      );
      return result.rows[0]?.complete === true;
    },
    async start(interactionUid, step) {
      const result = await pool.query(
        `INSERT INTO commonswarm_oauth.consent_orchestration
          (interaction_uid, step_kind, workspace_id, command_id, receipt_id)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid)
         ON CONFLICT (interaction_uid, step_kind, workspace_id) DO UPDATE SET
           updated_at = statement_timestamp()
         WHERE commonswarm_oauth.consent_orchestration.command_id = EXCLUDED.command_id
           AND commonswarm_oauth.consent_orchestration.receipt_id IS NOT DISTINCT FROM EXCLUDED.receipt_id
         RETURNING command_id`,
        [interactionUid, step.kind, step.workspaceId, step.commandId, step.receiptId],
      );
      if (result.rowCount !== 1) throw new Error("consent progress binding changed");
    },
    async complete(interactionUid, step) {
      await pool.query(
        `UPDATE commonswarm_oauth.consent_orchestration
            SET completed_at = statement_timestamp(), last_error_code = NULL,
                updated_at = statement_timestamp()
          WHERE interaction_uid = $1 AND step_kind = $2 AND workspace_id = $3::uuid
            AND command_id = $4::uuid`,
        [interactionUid, step.kind, step.workspaceId, step.commandId],
      );
    },
    async fail(interactionUid, step, code) {
      await pool.query(
        `UPDATE commonswarm_oauth.consent_orchestration
            SET last_error_code = $1, updated_at = statement_timestamp()
          WHERE interaction_uid = $2 AND step_kind = $3 AND workspace_id = $4::uuid
            AND command_id = $5::uuid`,
        [String(code).slice(0, 128), interactionUid, step.kind, step.workspaceId, step.commandId],
      );
    },
  };
}

export function createConsentOrchestrator({ command, progress }) {
  if (typeof command !== "function") throw new TypeError("command callback is required");
  async function execute(interactionRef, body, identity) {
    const step = stepFor(body);
    if (await progress?.isComplete(interactionRef, step)) return;
    await progress?.start(interactionRef, step);
    try {
      // This callback is the lane-2 handleHostedManagementCommand binding. It
      // receives the verified human identity, never a bearer, cookie, hosted
      // capability, or tool-dispatch state.
      const result = await command(body, identity);
      if (!result || result.status !== 200 || result.body?.ok === false) {
        const error = new Error("CommonSwarm consent command did not complete");
        error.code = "consent_command_failed";
        error.commandKind = body.command.kind;
        throw error;
      }
      await progress?.complete(interactionRef, step);
    } catch (error) {
      await progress?.fail(interactionRef, step, error?.code ?? "command_failed");
      throw error;
    }
  }
  return {
    async activate({ interactionRef, providerGrantId, clientId, identity, workspaceIds, homeWorkspaceId, grantId = randomUUID() }) {
      if (!identity?.identityVerified || typeof identity.userId !== "string") {
        throw new Error("verified human identity required");
      }
      const { selectedWorkspaceIds, manifestDigest } = workspaceManifest(workspaceIds);
      if (!selectedWorkspaceIds.includes(homeWorkspaceId)) throw new Error("home workspace must be selected");
      const commands = [input(homeWorkspaceId, stableUuid(grantId, "begin"), {
        kind: "begin_hosted_mcp_grant",
        grant_id: grantId,
        provider_grant_id: providerGrantId,
        owner_user_id: identity.userId,
        home_workspace_id: homeWorkspaceId,
        client_id: clientId,
        resource: RESOURCE,
        selected_workspace_ids: selectedWorkspaceIds,
        manifest_digest: manifestDigest,
        interaction_ref: interactionRef,
      })];
      for (const workspaceId of selectedWorkspaceIds) {
        commands.push(input(workspaceId, stableUuid(grantId, "consent", workspaceId), {
          kind: "consent_hosted_mcp_workspace",
          grant_id: grantId,
          workspace_id: workspaceId,
          owner_user_id: identity.userId,
          manifest_digest: manifestDigest,
          consent_receipt_id: stableUuid(grantId, "receipt", workspaceId),
        }));
      }
      commands.push(input(homeWorkspaceId, stableUuid(grantId, "activate"), {
        kind: "activate_hosted_mcp_grant",
        grant_id: grantId,
      }));

      for (const body of commands) {
        await execute(interactionRef, body, identity);
      }
      return { grantId, manifestDigest, selectedWorkspaceIds };
    },

    async revoke({ interactionRef, grantId, homeWorkspaceId, identity }) {
      if (!identity?.identityVerified || typeof identity.userId !== "string") {
        throw new Error("verified human identity required");
      }
      await execute(interactionRef, input(homeWorkspaceId, stableUuid(grantId, "revoke"), {
        kind: "revoke_hosted_mcp_grant",
        grant_id: grantId,
      }), identity);
      return { grantId };
    },
  };
}
