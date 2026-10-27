export interface AccountAgentWorkspace {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
  revokedAt: string | null;
  archivedAt: string | null;
}

export interface AccountAgent {
  id: string;
  name: string;
  model: string | null;
  transport: string;
  revokedAt: string | null;
  workspaces: AccountAgentWorkspace[];
}

/** Account directory follows the shell's pure builders: all user text uses textContent. */
export function buildAccountAgents(doc: Document, agents: readonly AccountAgent[]): HTMLElement {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const element = doc.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const list = node("ul", "account-agents");
  if (!agents.length) {
    const empty = node("p", "account-agents__empty", "No agents yet.");
    return empty;
  }
  for (const agent of agents) {
    const item = node("li", "account-agents__agent");
    const heading = node("div", "account-agents__heading");
    heading.append(node("h3", "account-agents__name", agent.name));
    if (agent.revokedAt) heading.append(node("span", "account-agents__state", "Removed"));
    item.append(heading, node("p", "account-agents__model", [agent.model,
      agent.transport === "hosted_mcp" ? "Connected app" : "Terminal"].filter(Boolean).join(" · ")));
    const workspaces = node("ul", "account-agents__workspaces");
    for (const workspace of agent.workspaces) {
      const row = node("li", "account-agents__workspace");
      if (!agent.revokedAt && !workspace.revokedAt && !workspace.archivedAt) {
        const link = node("a", "account-agents__workspace-name", workspace.name);
        link.href = `/app?w=${encodeURIComponent(workspace.id)}`;
        row.append(link);
      } else row.append(node("span", "account-agents__workspace-name", workspace.name));
      row.append(node("span", "account-agents__org", workspace.orgName));
      if (workspace.revokedAt || workspace.archivedAt) {
        row.append(node("span", "account-agents__state", workspace.revokedAt ? "Removed" : "Archived"));
      }
      workspaces.append(row);
    }
    if (agent.workspaces.length) item.append(workspaces);
    else item.append(node("p", "account-agents__empty", "No workspaces"));
    list.append(item);
  }
  return list;
}

export function addableAccountAgents(agents:readonly AccountAgent[],workspaceId:string,orgId:string):AccountAgent[] {
  return agents.filter(agent=>['local','hosted_mcp'].includes(agent.transport) && agent.revokedAt===null
    && !agent.workspaces.some(w=>w.id===workspaceId && w.revokedAt===null)
    && agent.workspaces.some(w=>w.orgId===orgId && w.archivedAt===null && (agent.transport==='hosted_mcp' || w.revokedAt===null || w.id===workspaceId)));
}
