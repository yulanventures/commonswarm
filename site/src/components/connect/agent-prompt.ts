/** The entry prompt stays short. Setup owns validation, storage, and host configuration. */
import { credentialArtifact, type AgentCredential } from "../../lib/agent-connect";
import { SIGNAL_BODY_MAX } from "../../../../supabase/functions/_shared/signal-text";
import { INSTALL_CMD } from "../../lib/install";
import { AGENT_CONNECTION_VERSION, AGENT_MESSAGE_FORMAT_RULE, AGENT_SETUP_HOST_GUIDANCE, MCP_OPERATOR_GUIDE, type AgentConnectionEnvelope } from "../../../../src/cloud/agent-onboarding-contract";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../../../src/cloud/agent-credential-input";
import { encodeAgentConnectionToken } from "../../../../src/cloud/agent-connection-codec";

export interface DashboardPromptInput {
  credential: AgentCredential;
  workspaceId: string;
  workspaceName: string;
  deploymentUrl: string;
  anonKey: string;
}

/** Safe to paste into an assistant: the operator enters the code outside the model turn. */
export function dashboardMcpPrompt(): string {
  const serverName = "cswarm";
  return `${MCP_OPERATOR_GUIDE}\nClaude Code: claude mcp add --scope user --transport stdio ${serverName} -- ${serverName} mcp --profile <path>\nCodex config:\n[mcp_servers.cswarm]\ncommand = "cswarm"\nargs = ["mcp", "--profile", "<path>"]\nUse the exact private path printed by connect.`;
}

export function dashboardAgentConnection(input: DashboardPromptInput): string {
  const envelope: AgentConnectionEnvelope = {
    version: AGENT_CONNECTION_VERSION,
    url: input.deploymentUrl,
    anon_key: input.anonKey,
    workspace_id: input.workspaceId,
    principal_id: input.credential.principalId,
    credential: { ...JSON.parse(credentialArtifact(input.credential)), message: AGENT_CREDENTIAL_MESSAGE_D088 },
  };
  return JSON.stringify(envelope);
}

function setupPrompt(source: string): string {
  return [
    "This fallback passes a credential through the model. For MCP, run cswarm mcp code and cswarm mcp connect in a terminal.",
    "Connect to CommonSwarm. Keep the file private; never echo its contents or put them in commands, logs, URLs, or environment variables.",
    `Use Node.js 22+ and run:

${codeBlock("sh", INSTALL_CMD)}`,
    "The installer reuses a matching build. If its host is blocked, use npm install -g commonswarm.",
    "Confirm cswarm setup --check-version returns setup_version 1; otherwise report that the release needs updating.",
    source,
    `${AGENT_MESSAGE_FORMAT_RULE} (Up to ${SIGNAL_BODY_MAX} characters.)`,
    AGENT_SETUP_HOST_GUIDANCE,
    "Run setup --json. Reuse its --profile and this session's --host-session-id.",
    "Ask once: enable wakeups in this same session, or check at each turn's start and whenever asked? Wake works with Claude Code preview channels or the local Grok Bot gateway; Codex supports turn checks. Explain approval or restart needs. Use cswarm receive configure with the user's choice; reuse a saved choice. Never start another model.",
    "Run cswarm check --profile <saved-profile> --host-session-id <this-session-id> before work. Read brain topics; post intent and reply. Use cswarm setup guide only when needed. Report connection, receive mode, and next step; claim wake only after its idle test passes.",
  ].join("\n\n");
}

export function dashboardAgentFilePrompt(_input: DashboardPromptInput): string {
  return setupPrompt("Import the attached connection JSON. Use your file-writing tool to save it outside repositories in a 0700 directory with file mode 0600.");
}

/** One-paste fallback: one credential and one copy of the public connection data. */
export function dashboardAgentPrompt(input: DashboardPromptInput): string {
  const path = `~/.cswarm/connect-${input.credential.principalId}/connection.json`;
  const token = encodeAgentConnectionToken(dashboardAgentConnection(input));
  return `${setupPrompt(`Save this connection token with your file-writing tool to ${path}. Keep all characters unchanged. Set its directory to 0700 and the file to 0600. If damaged, use “Use a setup file” in CommonSwarm; do not repair credentials or paste them into chat.`)}\n\n${token}`;
}

/** Keep machine input out of Markdown prose, including embedded fence characters. */
function codeBlock(language: string, text: string): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}

/**
 * What a copy out of the prompt block must place on the clipboard.
 *
 * A manual selection copy hands the target application BOTH `text/plain` and `text/html`. A
 * Markdown-aware client converts that HTML rather than taking the plain text, and the conversion
 * escapes every underscore as `\_` and rewrites a bare URL as a Markdown link — which is exactly
 * the damage the code fences exist to prevent, arriving by a route the fences cannot reach
 * (measured on a real hand-off, 2026-09-08). The block therefore writes plain text itself and
 * suppresses the HTML flavour. A partial selection stays a partial selection; an empty one, which
 * is what a keyboard copy with no range produces, falls back to the whole prompt.
 */
export function promptCopyPayload(selectionText: string, fullPrompt: string): string {
  return selectionText.trim().length > 0 ? selectionText : fullPrompt;
}
