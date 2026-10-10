/*
 * The plain words for Lists & docs access, in one place.
 *
 * WHAT IS ENFORCED STAYS ELSEWHERE. The purposes, roles and operations are the server's
 * (`household_permissions`, src/protocol/household-object-policy.ts). This file only gives each
 * one a sentence a person can act on, keyed by the enforced value, and a test fails if the
 * enforcement adds a value this file has no words for. It never adds a choice of its own.
 *
 * WHY NOT THE REGISTRY SENTENCES. HOUSEHOLD_CONTENT_CONSENT describes each operation for the
 * agent-facing catalog ("Patch shared objects and reserve replacements against their base
 * revisions."). Those stay true and stay in the tool descriptions; a person approving their own
 * agent reads "Change them".
 */

import {
  HOUSEHOLD_CONTENT_OPERATIONS,
  HOUSEHOLD_CONTENT_ROLES,
  type HouseholdContentOperation,
  type HouseholdContentRole,
} from "../../../src/protocol/household-object-policy";

export type HouseholdPurpose = "shared" | "personal";

/**
 * The purpose decides who can use Lists & docs and whether invitations work: "personal" limits Lists & docs
 * to the owner and blocks invitations, permanently. It does not change messages or ordinary Files; members
 * of the workspace keep posting messages and seeing its files.
 */
export const PURPOSE_QUESTION = "Who can use Lists & docs here?";
export const PURPOSE_COPY: Readonly<Record<HouseholdPurpose, { label: string; detail: string }>> = Object.freeze({
  shared: {
    label: "Me and people I invite",
    detail: "People you invite can join and use Lists & docs. Everyone in this workspace can post messages and see its files.",
  },
  personal: {
    label: "Just me",
    detail:
      "Only you can use Lists & docs here, and invitations to this workspace will not work. This cannot be changed later. People already in it can still post messages and see its files. To share with people later, create another workspace.",
  },
});

/** Creation describes the future audience; the legacy access card describes existing members. */
export const CREATE_PURPOSE_DETAILS: Readonly<Record<HouseholdPurpose, string>> = Object.freeze({
  shared: "You can invite people, and they can use Lists & docs.",
  personal: "Only you can use Lists & docs, and nobody can be invited. This cannot be changed later.",
});

export const CONTENT_ROLE_COPY: Readonly<Record<HouseholdContentRole, { label: string; detail: string }>> = Object.freeze({
  editor: { label: "Editor", detail: "Add and change lists, docs and their files." },
  reader: { label: "Reader", detail: "See lists, docs and their files." },
});

export const CONTENT_OPERATION_LABELS: Readonly<Record<HouseholdContentOperation, string>> = Object.freeze({
  read: "See lists and docs",
  create: "Add new ones",
  update: "Change them",
});

/** Roles and operations in enforcement order, so screens never type their own list. */
export const CONTENT_ROLES: readonly HouseholdContentRole[] = HOUSEHOLD_CONTENT_ROLES;
export const CONTENT_OPERATIONS: readonly HouseholdContentOperation[] = HOUSEHOLD_CONTENT_OPERATIONS;

/**
 * What a refusal from `household_permissions` means for the person, keyed by the server's
 * stable reason code (never by message text). Unknown codes get the honest generic sentence.
 */
const REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  owner_confirmation_required:
    "The workspace owner chooses who can use Lists & docs first. Ask them to open Lists & docs.",
  workspace_boundary_mismatch:
    "This workspace was already set up the other way. Choose the option its owner chose.",
  workspace_access_refused: "You are no longer a member of this workspace. Nothing was changed.",
  human_confirmation_required: "Sign in again, then confirm. Nothing was changed.",
  connection_access_refused:
    "That agent's connection is no longer active. Connect it again from its app, then allow it here.",
  content_consent_required: "Confirm your own access to Lists & docs first. Nothing was changed.",
  invalid_connection_consent: "Choose at least See lists and docs for the agent. Nothing was changed.",
  invalid_request: "Choose both options, then confirm. Nothing was changed.",
  request_id_reused: "That confirmation was already sent. Reload Lists & docs to see the result.",
});

export function accessRefusalMessage(reason: unknown): string {
  return typeof reason === "string" && REFUSALS[reason]
    ? REFUSALS[reason]
    : "CommonSwarm refused this change. Nothing was changed.";
}

/**
 * Hosted approvals last until withdrawn; local approvals end with their key.
 */
export function approvalUntil(expiresAt: string | null | undefined, now = Date.now()): string {
  if (expiresAt === null) return "Allowed until you withdraw it.";
  if (!expiresAt) return "Allowed.";
  const end = new Date(expiresAt);
  if (Number.isNaN(end.getTime())) return "Allowed.";
  if (end.getTime() <= now) return "This approval has ended. Allow it again to let the agent change things.";
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(end);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((end.getTime() - startOfToday.getTime()) / 86_400_000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow"
    : new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(end);
  return `Allowed until ${time} ${day}. Allow it again after that.`;
}

/** Withdrawal has a different owner check from approval. */
export function withdrawRefusalMessage(reason: unknown): string {
  return reason === "connection_access_refused"
    ? "Only the person who connected this agent can withdraw its Lists & docs access. Nothing was changed."
    : accessRefusalMessage(reason);
}

/** History stays on the old identity even when its name is used again. */
export function removedAgentLabel(name: string): string {
  return `${name} (removed)`;
}

export const PERSONAL_PURPOSE_WARNING =
  "Just me cannot be changed later, and nobody can be invited to this workspace. To share with people later, create another workspace.";
