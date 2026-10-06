/*
 * The setup checklist a new workspace opens on.
 *
 * Only the needed steps, derived from dashboard reads and any unsettled creation setup.
 * A step is done when the fact is true now, so a revoked agent or a cancelled invite reopens its
 * step instead of leaving a stale tick.
 *
 *   access  shown when household_access refuses access or creation permissions did not commit. The owner also
 *           chooses the audience here for workspaces created before that choice was recorded.
 *   agent   at least one live agent owned by this person is in the roster.
 *   invite  someone else is a member, or an invitation is pending. Owners and admins only:
 *           they are the people the server lets invite.
 */

export type SetupStepId = "access" | "agent" | "invite";

export interface SetupFacts {
  isOwner: boolean;
  canInvite: boolean;
  /** null while the read is unknown; creation can still establish that setup is needed. */
  accessConfirmed: boolean | null;
  /** Creation permissions failed; keep setup visible until a read confirms access. */
  accessNeedsSetup?: boolean;
  myAgentCount: number;
  otherMemberCount: number;
  pendingInviteCount: number;
}

export interface SetupStep {
  id: SetupStepId;
  title: string;
  detail: string;
  action: string;
  done: boolean;
}

export function setupSteps(facts: SetupFacts): SetupStep[] {
  const steps: SetupStep[] = [];
  if (facts.accessConfirmed !== true && (facts.accessConfirmed === false || facts.accessNeedsSetup)) steps.push(
    facts.isOwner
      ? {
        id: "access",
        title: "Choose who shares Lists & docs",
        detail: "Shared lists and invitations both need this.",
        action: "Choose",
        done: false,
      }
      : {
        id: "access",
        title: "Choose your access",
        detail: "Editor or reader, for lists, docs and files.",
        action: "Choose",
        done: false,
      },
  );
  steps.push({
    id: "agent",
    title: facts.isOwner ? "Connect your first agent" : "Connect your own agents",
    detail: facts.myAgentCount > 0
      ? `${facts.myAgentCount} connected. Add more any time.`
      : "Claude, Muse and others join with one address.",
    action: facts.myAgentCount > 0 ? "Add another" : "Add an agent",
    done: facts.myAgentCount > 0,
  });
  if (facts.canInvite) {
    const done = facts.otherMemberCount > 0 || facts.pendingInviteCount > 0;
    steps.push({
      id: "invite",
      title: "Invite someone",
      detail: facts.otherMemberCount > 0
        ? "Someone has joined. They connect their own agents."
        : facts.pendingInviteCount > 0
          ? "Invite sent. It stays pending until they join."
          : "They sign in as themselves and bring their own agents.",
      action: done ? "Invite another" : "Invite",
      done,
    });
  }
  return steps;
}

export function setupProgress(steps: readonly SetupStep[]): { done: number; total: number; complete: boolean } {
  const done = steps.filter((step) => step.done).length;
  return { done, total: steps.length, complete: steps.length > 0 && done === steps.length };
}
