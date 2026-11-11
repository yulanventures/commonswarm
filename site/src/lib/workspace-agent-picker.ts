import type { Session } from "@supabase/supabase-js";
import { addableAccountAgents, buildWorkspaceAgentChoice, type AccountAgent } from "./account-agents";
import { addAgentToWorkspace, myAccountAgents } from "./commonswarm";
import { identityDisplayLabel } from "./identity-label";

const mounts = new WeakMap<HTMLElement, () => void>();

/** The existing human membership flow, shared by onboarding and People & agents. */
export function mountWorkspaceAgentPicker(host: HTMLElement, options: {
  session: Session;
  workspaceId: string;
  orgId: string;
  isCurrent: () => boolean;
  added: (agent: AccountAgent) => Promise<void>;
}): void {
  mounts.get(host)?.();
  let disposed = false;
  mounts.set(host, () => { disposed = true; });
  const current = () => !disposed && host.isConnected && options.isCurrent();
  const doc = host.ownerDocument;
  const notice = doc.createElement("p");
  notice.className = "workspace-agent-picker__notice";
  notice.setAttribute("role", "status");
  notice.tabIndex = -1;
  const list = doc.createElement("div");
  list.className = "workspace-agent-picker__list";
  host.classList.add("workspace-agent-picker");
  host.replaceChildren(notice, list);
  const action = (text: string, run: () => void): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "workspace-agent-picker__retry";
    button.textContent = text;
    button.addEventListener("click", run);
    return button;
  };
  const refreshAdded = async (agent: AccountAgent, label: string): Promise<void> => {
    try {
      await options.added(agent);
      if (current()) {
        notice.textContent = `${label} added.`;
        if (doc.activeElement === doc.body) notice.focus({ preventScroll: true });
      }
    } catch {
      if (!current()) return;
      notice.textContent = `${label} added. Couldn't refresh the workspace.`;
      const retry = action("Refresh workspace", () => {
        if (!current()) return;
        retry.remove();
        notice.textContent = `${label} added. Checking the workspace…`;
        void refreshAdded(agent, label);
      });
      notice.append(" ", retry);
    }
  };
  const load = async (): Promise<void> => {
    if (!current()) return;
    const restoreFocus = host.contains(doc.activeElement);
    host.dataset.agentPickerState = "loading";
    notice.textContent = "Loading your agents…";
    list.replaceChildren();
    try {
      const choices = addableAccountAgents(await myAccountAgents(), options.workspaceId, options.orgId);
      if (!current()) return;
      host.dataset.agentPickerState = "ready";
      notice.textContent = choices.length ? "" : "No agents to add to this workspace.";
      for (const agent of choices) {
        const label = identityDisplayLabel(agent, choices);
        // Retain the command identity if a response is lost; a new list load creates a new attempt.
        const commandId = crypto.randomUUID();
        const { row, button } = buildWorkspaceAgentChoice(doc, { ...agent, name: label }, () => {
          if (!current() || button.disabled) return;
          button.disabled = true;
          notice.textContent = `Adding ${label}…`;
          void (async () => {
            try {
              await addAgentToWorkspace(options.session, commandId, options.workspaceId, agent.id);
            } catch {
              if (!current()) return;
              notice.textContent = `Couldn't add ${label}. Try again.`;
              button.disabled = false;
              return;
            }
            if (!current()) return;
            button.textContent = "Added";
            button.setAttribute("aria-label", `${label} added.`);
            notice.textContent = `${label} added.`;
            if (doc.activeElement === button || doc.activeElement === doc.body) notice.focus({ preventScroll: true });
            await refreshAdded(agent, label);
          })();
        });
        list.append(row);
      }
      if (restoreFocus && doc.activeElement === doc.body) (list.querySelector<HTMLElement>("button") ?? notice).focus();
    } catch {
      if (!current()) return;
      host.dataset.agentPickerState = "error";
      notice.textContent = "Couldn't load your agents.";
      notice.append(" ", action("Retry", () => { void load(); }));
    }
  };
  void load();
}
