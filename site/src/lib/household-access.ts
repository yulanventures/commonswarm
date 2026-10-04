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

export const PURPOSE_COPY: Readonly<Record<HouseholdPurpose, { label: string; detail: string }>> = Object.freeze({
  shared: {
    label: "Me and people I invite",
    detail: "Everyone here can see shared lists, docs and files, including their history.",
  },
  personal: {
    label: "Just me",
    detail: "Private to you. Invitations to it will not work, and this cannot be changed later.",
  },
});

export const CONTENT_ROLE_COPY: Readonly<Record<HouseholdContentRole, { label: string; detail: string }>> = Object.freeze({
  editor: { label: "Editor", detail: "Add and change lists, docs and files." },
  reader: { label: "Reader", detail: "See lists, docs and files, but not change them." },
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
    "The workspace owner chooses who can see this workspace first. Ask them to open Lists & docs.",
  workspace_boundary_mismatch:
    "This workspace was already set up the other way. Choose the option its owner chose.",
  workspace_access_refused: "You are no longer a member of this workspace. Nothing was changed.",
  human_confirmation_required: "Sign in again, then confirm. Nothing was changed.",
  connection_access_refused:
    "That agent's connection is no longer active. Connect it again from its app, then allow it here.",
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
 * The approval's end, as a person reads it. Hosted approvals end after 24 hours today
 * (supabase/functions/command/household-permissions.ts); local ones end with their key.
 */
export function approvalUntil(expiresAt: string | null | undefined, now = Date.now()): string {
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
