/*
 * The setup checklist a new workspace opens on.
 *
 * Three steps, each derived from facts the dashboard already reads; nothing here is stored. A
 * step is done when the fact is true now, so a revoked agent or a cancelled invite reopens its
 * step instead of leaving a stale tick.
 *
 *   access  the person's Lists & docs access is confirmed (household_access says ok). For the
 *           owner this is also where the workspace's audience is chosen, which inviting needs.
 *   agent   at least one live agent owned by this person is in the roster.
 *   invite  someone else is a member, or an invitation is pending. Owners and admins only:
 *           they are the people the server lets invite.
 */

export type SetupStepId = "access" | "agent" | "invite";

export interface SetupFacts {
  isOwner: boolean;
  canInvite: boolean;
  /** null while the access read has not answered; the step then shows as not done. */
  accessConfirmed: boolean | null;
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
  const steps: SetupStep[] = [
    facts.isOwner
      ? {
        id: "access",
        title: "Choose who can see it",
        detail: "Shared lists and invites both need this.",
        action: "Choose",
        done: facts.accessConfirmed === true,
      }
      : {
        id: "access",
        title: "Choose your access",
        detail: "Editor or reader, for lists, docs and files.",
        action: "Choose",
        done: facts.accessConfirmed === true,
      },
    {
      id: "agent",
      title: facts.isOwner ? "Connect your first agent" : "Connect your own agents",
      detail: facts.myAgentCount > 0
        ? `${facts.myAgentCount} connected. Add more any time.`
        : "Claude, Muse and others join with one address.",
      action: facts.myAgentCount > 0 ? "Add another" : "Add an agent",
      done: facts.myAgentCount > 0,
    },
  ];
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
