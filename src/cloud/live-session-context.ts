import type { CloudTarget } from "./config.js";
import { AgentSessionClient } from "./session-client.js";
import {
  assertLocalSessionBinding,
  listSessionContextFiles,
  readSessionContext,
  sessionProofOf,
} from "./session-context.js";

/** Only a secure local file matching the authenticated seat and the server's live session is named live. */
export async function verifiedLiveSessionContexts(input: {
  target: CloudTarget;
  workspaceId: string;
  principalId: string;
  credential: string;
  tokenFile?: string;
  hostSessionId?: string;
  checkManagementWithoutFiles?: boolean;
}): Promise<{ paths: string[]; verificationUnavailable: boolean; managed: boolean | null }> {
  const contexts = (await listSessionContextFiles(input.workspaceId, input.principalId)).filter(({ context }) => {
    if (sessionProofOf(context) === null) return false;
    try {
      assertLocalSessionBinding(context, {
        target: input.target,
        flagWorkspaceId: input.workspaceId,
        tokenPrincipalId: input.principalId,
        ...(input.tokenFile === undefined ? {} : { tokenFile: input.tokenFile }),
        ...(input.hostSessionId === undefined ? {} : { hostSessionId: input.hostSessionId }),
      });
      return true;
    } catch {
      return false;
    }
  });
  if (contexts.length === 0 && !input.checkManagementWithoutFiles) {
    return { paths: [], verificationUnavailable: false, managed: null };
  }
  try {
    const server = await new AgentSessionClient({ target: input.target, timeoutMs: 5_000 }).readStatus({
      credential: input.credential,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
    });
    const paths: string[] = [];
    for (const { path, context } of contexts) {
      if (!server.is_live || server.session_id !== context.session_id || server.generation !== context.generation) continue;
      try {
        const current = await readSessionContext(path);
        if (current.session_id === context.session_id && current.generation === context.generation &&
            current.session_key === context.session_key && sessionProofOf(current) !== null) paths.push(path);
      } catch { /* The file disappeared or changed after the first read. */ }
    }
    return { paths, verificationUnavailable: false, managed: server.managed_at !== null };
  } catch {
    return { paths: [], verificationUnavailable: true, managed: null };
  }
}
