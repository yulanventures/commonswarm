/**
 * Add an agent invite: mint a join credential, show the paste once, revoke it.
 *
 * AgentConnect does not import this file statically. It calls loadLinkJoin()
 * from h0-link-join-flag.ts, and that function imports this file only inside
 * the branch where the build-time flag is on. A default site build drops the
 * branch, so this file is not in that build.
 */
import type { Session } from "@supabase/supabase-js";
import { h0AgentPaste } from "../../../src/h0/paste";
import {
  AGENT_JOIN_SEAT_CAP_MAX,
  AGENT_JOIN_SEAT_CAP_MIN,
  joinInviteResultLead,
  mintAgentJoinCredentialCommand,
  revokeAgentJoinCredentialCommand,
} from "../../../src/protocol/agent-join-limits";
import { h0AgentDocumentUrl } from "../../../src/protocol/h0-agent-document-url";
import { CLIENT_PROTOCOL_VERSION, deployment, uuid } from "./commonswarm";

const COMMAND_TIMEOUT_MS = 30_000;
const WITHHELD_MESSAGE =
  "The invite was created, but this page refused to show the message. Revoke it here. The credential was not shown.";

export const JOIN_INVITE_REVOKED_MESSAGE =
  "This invite is revoked. It can no longer be used to join.";

export class JoinInviteError extends Error {
  override name = "JoinInviteError";
}

export class JoinInviteWithheld extends JoinInviteError {
  override name = "JoinInviteWithheld";
  constructor(readonly joinCredentialId: string, message: string) {
    super(message);
  }
}

export class JoinInviteAlreadyRevoked extends JoinInviteError {
  override name = "JoinInviteAlreadyRevoked";
  constructor() {
    super(JOIN_INVITE_REVOKED_MESSAGE);
  }
}

export interface JoinInviteReveal {
  paste: string | null;
  inviteId: string;
  documentUrl: string;
  lead: string;
  withheld: boolean;
}

export interface LinkJoinApi {
  workspaceId(): string;
  session(): Promise<Session | null>;
  tryBegin(): boolean;
  end(): void;
  setMintPending(pending: boolean): void;
  showInvite(reveal: JoinInviteReveal): void;
  formError(message: string | null): void;
  note(message: string): void;
  markRevoked(message: string, inviteId: string): void;
  inviteId(): string | null;
}

interface DeploymentTarget {
  url: string;
  anonKey: string;
}

function shownExpiry(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

/** Seat cap the lead may show. Values outside the server range use the fallback. */
export function shownSeatCap(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fallback;
  if (value < AGENT_JOIN_SEAT_CAP_MIN || value > AGENT_JOIN_SEAT_CAP_MAX) return fallback;
  return value;
}

/** Build the paste from a mint body. The credential never goes into the document URL. */
export function revealFromMintBody(
  body: Record<string, unknown>,
  serviceBaseUrl: string,
): JoinInviteReveal {
  const id = typeof body.join_credential_id === "string" ? body.join_credential_id : "";
  const locator = typeof body.locator === "string" ? body.locator : "";
  const secret = typeof body.join_credential === "string" ? body.join_credential : "";
  const requested = mintAgentJoinCredentialCommand();
  const lead = joinInviteResultLead({
    seatCap: shownSeatCap(body.seat_cap, requested.seat_cap),
    expiresAt: shownExpiry(body.expires_at),
  });
  if (!id) {
    throw new JoinInviteError(
      "The deployment accepted an invite without an id. Nothing is shown.",
    );
  }
  if (!secret) {
    return {
      paste: null,
      inviteId: id,
      documentUrl: "",
      lead: "The credential was not in the response, so it cannot be shown. Revoke the invite if you do not want it used.",
      withheld: true,
    };
  }
  try {
    const documentUrl = h0AgentDocumentUrl(serviceBaseUrl, locator);
    if (documentUrl.toLowerCase().includes(secret.toLowerCase())) {
      throw new JoinInviteWithheld(id, WITHHELD_MESSAGE);
    }
    const paste = h0AgentPaste({ documentUrl, joinCredential: secret });
    return {
      paste,
      inviteId: id,
      documentUrl,
      lead,
      withheld: false,
    };
  } catch (error) {
    if (error instanceof JoinInviteWithheld) throw error;
    throw new JoinInviteWithheld(id, WITHHELD_MESSAGE);
  }
}

async function postAccepted(
  target: DeploymentTarget,
  session: Session,
  commandId: string,
  workspaceId: string,
  command: Record<string, unknown>,
  purpose: "mint" | "revoke",
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${target.url}/functions/v1/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        apikey: target.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command_id: commandId,
        client_version: CLIENT_PROTOCOL_VERSION,
        workspace_id: workspaceId,
        stream: { kind: "workspace" },
        command,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new JoinInviteError(
      purpose === "revoke"
        ? "The request did not reach the deployment, or the answer never came back. The invite may still be active."
        : "The request did not reach the deployment, or the answer never came back. Reload this page before trying again.",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    body = {};
  }
  if (response.status === 409 && body.error === "already_revoked") {
    throw new JoinInviteAlreadyRevoked();
  }
  if (response.status === 401) {
    throw new JoinInviteError(
      purpose === "revoke"
        ? "Your sign-in is no longer valid. The invite was not revoked."
        : "Your sign-in is no longer valid. Sign in again. No invite was created.",
    );
  }
  if (response.status === 403) {
    if (purpose === "mint" && body.error === "join_credential_limit_reached") {
      throw new JoinInviteError(
        "You already have as many live invites as this workspace allows. Revoke one, or wait for one to expire. No new invite was created.",
      );
    }
    throw new JoinInviteError(
      purpose === "revoke"
        ? "CommonSwarm did not revoke this invite."
        : "CommonSwarm did not accept this. Nothing new was added.",
    );
  }
  if (response.status === 400) {
    throw new JoinInviteError(
      purpose === "revoke"
        ? "The deployment did not accept the revoke request. The invite may still be active."
        : "The deployment did not accept the request. Nothing was created.",
    );
  }
  if (response.status !== 200 || body.status !== "accepted") {
    throw new JoinInviteError(
      purpose === "revoke"
        ? `The deployment answered HTTP ${response.status}. The invite may still be active. Try again.`
        : `The deployment answered HTTP ${response.status}. Reload this page before trying again.`,
    );
  }
  return body;
}

export async function mintJoinInvite(input: {
  session: Session;
  workspaceId: string;
  commandId: string;
}): Promise<JoinInviteReveal> {
  const target = deployment();
  if (!target) {
    throw new JoinInviteError("Open commonswarm.com/app and continue on the live site.");
  }
  const body = await postAccepted(
    target,
    input.session,
    input.commandId,
    input.workspaceId,
    mintAgentJoinCredentialCommand(),
    "mint",
  );
  return revealFromMintBody(body, target.url);
}

export async function revokeJoinInvite(input: {
  session: Session;
  workspaceId: string;
  joinCredentialId: string;
  commandId: string;
}): Promise<void> {
  const target = deployment();
  if (!target) {
    throw new JoinInviteError("Open commonswarm.com/app and continue on the live site.");
  }
  let command: Record<string, unknown>;
  try {
    command = revokeAgentJoinCredentialCommand(input.joinCredentialId);
  } catch {
    throw new JoinInviteError("This page cannot revoke this invite.");
  }
  await postAccepted(
    target,
    input.session,
    input.commandId,
    input.workspaceId,
    command,
    "revoke",
  );
}

async function onMint(api: LinkJoinApi): Promise<void> {
  if (!api.tryBegin()) return;
  api.setMintPending(true);
  api.formError(null);
  try {
    const session = await api.session();
    if (!session) {
      api.formError("Your sign-in expired. No invite was created. Sign in again.");
      return;
    }
    const workspaceId = api.workspaceId();
    if (!workspaceId) {
      api.formError("Choose a workspace first. No invite was created.");
      return;
    }
    const reveal = await mintJoinInvite({
      session,
      workspaceId,
      commandId: `web_${uuid()}`,
    });
    api.showInvite(reveal);
  } catch (error) {
    if (error instanceof JoinInviteWithheld) {
      api.showInvite({
        paste: null,
        inviteId: error.joinCredentialId,
        documentUrl: "",
        lead: error.message,
        withheld: true,
      });
      return;
    }
    api.formError(
      error instanceof JoinInviteError
        ? error.message
        : "Something went wrong before an invite was created. Nothing was added.",
    );
  } finally {
    api.setMintPending(false);
    api.end();
  }
}

/** A late result may write only while this id is still the one on screen. */
function inviteStillShown(api: LinkJoinApi, inviteId: string): boolean {
  return api.inviteId() === inviteId;
}

async function onRevoke(api: LinkJoinApi): Promise<void> {
  const id = api.inviteId();
  if (!id) return;
  if (!api.tryBegin()) return;
  try {
    const session = await api.session();
    if (!session) {
      if (inviteStillShown(api, id)) {
        api.note("Your sign-in expired. The invite was not revoked.");
      }
      return;
    }
    const workspaceId = api.workspaceId();
    if (!workspaceId) {
      if (inviteStillShown(api, id)) {
        api.note("Choose a workspace first. The invite was not revoked.");
      }
      return;
    }
    await revokeJoinInvite({
      session,
      workspaceId,
      joinCredentialId: id,
      commandId: `web_${uuid()}`,
    });
    if (!inviteStillShown(api, id)) return;
    api.markRevoked(JOIN_INVITE_REVOKED_MESSAGE, id);
  } catch (error) {
    if (!inviteStillShown(api, id)) return;
    if (error instanceof JoinInviteAlreadyRevoked) {
      api.markRevoked(error.message, id);
      return;
    }
    api.note(
      error instanceof JoinInviteError
        ? error.message
        : "The invite was not revoked.",
    );
  } finally {
    api.end();
  }
}

export function startJoinMint(api: LinkJoinApi): Promise<void> {
  return onMint(api);
}

export function startJoinRevoke(api: LinkJoinApi): Promise<void> {
  return onRevoke(api);
}
