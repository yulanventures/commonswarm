import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openProfileCredential, profileTarget, readAgentProfile, readProfileCredential, type AgentProfile } from "../cloud/agent-profile.js";
import { CommandHttpError, newCommandId, ThinCommandClient, type PostSignalCommand } from "../cloud/command-client.js";
import { CONNECT_PROFILE_FILES } from "../cloud/connect-profile-files.js";
import {
  DELIVERY_KINDS, DELIVERY_SESSION_PROOF_CODES, DeliveryCommandClient, DeliveryHttpError,
  DeliveryProtocolError, H0_SEAT_CLAIM_REFUSED_CODE, type DeliveryRow,
} from "../cloud/delivery.js";
import { RenewalRefused, type AgentCredentialSession } from "../cloud/renewal.js";
import { managedAckInput } from "../cloud/session-ack.js";
import { AgentSessionClient } from "../cloud/session-client.js";
import { newSessionBinding } from "../cloud/session-context.js";
import type { AgentSessionProof, SessionProvider } from "../cloud/session-contract.js";
import { AgentSessionError } from "../cloud/session-errors.js";
import { AgentSessionManager } from "../cloud/session-manager.js";
import { generateSessionKey, isSessionUuid } from "../cloud/session-proof.js";
import { AGENT_SESSION_PROOF_REFUSAL_CODES } from "../cloud/session-wire.js";
import { followErrorEnvelope, readAgentSignalDirectory } from "../cloud/signals.js";
import { AuthorityLostError, type Clock, type CloudPort, type IdGenerator, type IncomingMessage, type ReplyCommand, type ReplyTarget } from "./ports.js";

export type UnsupportedSeatKind = "hosted" | "link_joined" | "turn_only";
export type CloudLinkErrorCode =
  | "seat_unsupported" | "session_not_managed" | "seat_busy" | "delivery_unrecognized"
  | "command_id_conflict" | "open_aborted" | "open_failed" | "cloud_request_failed";

const SEAT_MESSAGES: Readonly<Record<UnsupportedSeatKind, string>> = {
  hosted: "Hosted seats cannot use the local engine cloud link.",
  link_joined: "Link-joined seats cannot use the local engine cloud link.",
  turn_only: "Turn-only seats cannot use the local engine cloud link.",
};
const ERROR_MESSAGES: Readonly<Record<Exclude<CloudLinkErrorCode, "seat_unsupported">, string>> = {
  session_not_managed: "Managed sessions are not enabled for this seat; the seat's owner must enable management first.",
  seat_busy: "Another live execution session holds this seat and did not lapse in time.",
  delivery_unrecognized: "Delivery claim returned an unrecognized message kind or shape.",
  command_id_conflict: "Reply command id conflicted with different content on the server.",
  open_aborted: "Opening the cloud link was aborted.",
  open_failed: "Could not open the managed cloud link for this seat.",
  cloud_request_failed: "The cloud request failed.",
};
const NON_RETRYABLE = new Set<CloudLinkErrorCode>([
  "seat_unsupported", "session_not_managed", "seat_busy", "delivery_unrecognized", "command_id_conflict", "open_aborted",
]);

export class CloudLinkError extends Error {
  readonly code: CloudLinkErrorCode;
  readonly seatKind?: UnsupportedSeatKind;
  readonly serverReason?: string;
  readonly retryable: boolean;
  constructor(code: "seat_unsupported", seatKind: UnsupportedSeatKind);
  constructor(code: Exclude<CloudLinkErrorCode, "seat_unsupported">, serverReason?: string);
  constructor(code: CloudLinkErrorCode, detail?: UnsupportedSeatKind | string) {
    super(code === "seat_unsupported" ? SEAT_MESSAGES[detail as UnsupportedSeatKind] : ERROR_MESSAGES[code]);
    this.name = "CloudLinkError";
    this.code = code;
    if (code === "seat_unsupported") this.seatKind = detail as UnsupportedSeatKind;
    else if (typeof detail === "string" && detail.length > 0) this.serverReason = detail;
    this.retryable = !NON_RETRYABLE.has(code);
  }
}

export type TimerSet = (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
export type TimerClear = (timer: ReturnType<typeof setTimeout>) => void;

export interface OpenCloudLinkOptions {
  readonly profilePath: string;
  readonly onAuthorityLost: () => void;
  readonly takeoverWaitMs: number;
  readonly pollMinMs: number;
  readonly pollMaxMs: number;
  readonly takeoverRetryMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  readonly setTimer?: TimerSet;
  readonly clearTimer?: TimerClear;
  readonly generateId?: IdGenerator;
  readonly provider?: SessionProvider;
  readonly hostLabel?: string | null;
  readonly hostSessionId?: string;
  readonly signal?: AbortSignal;
}

export interface CloudLinkHandle {
  readonly port: CloudPort;
  readonly generation: number;
  readonly sessionId: string;
  close(): Promise<void>;
}

const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,72}$/;
const PROOF_CODES: ReadonlySet<string> = new Set([...DELIVERY_SESSION_PROOF_CODES, ...AGENT_SESSION_PROOF_REFUSAL_CODES]);
const LINK_MARKERS = [CONNECT_PROFILE_FILES.attemptMarker, CONNECT_PROFILE_FILES.complete, CONNECT_PROFILE_FILES.pending] as const;

function validateDurations(o: OpenCloudLinkOptions) {
  const takeoverRetryMs = o.takeoverRetryMs ?? o.pollMinMs;
  if (!Number.isFinite(o.takeoverWaitMs) || o.takeoverWaitMs < 0) throw new RangeError("Invalid takeoverWaitMs");
  if (!Number.isFinite(o.pollMinMs) || o.pollMinMs <= 0) throw new RangeError("Invalid pollMinMs");
  if (!Number.isFinite(o.pollMaxMs) || o.pollMaxMs < o.pollMinMs) throw new RangeError("Invalid pollMaxMs");
  if (!Number.isFinite(takeoverRetryMs) || takeoverRetryMs <= 0) throw new RangeError("Invalid takeoverRetryMs");
  if (o.requestTimeoutMs !== undefined && (!Number.isFinite(o.requestTimeoutMs) || o.requestTimeoutMs <= 0)) throw new RangeError("Invalid requestTimeoutMs");
  return { takeoverWaitMs: o.takeoverWaitMs, takeoverRetryMs, pollMinMs: o.pollMinMs, pollMaxMs: o.pollMaxMs };
}

async function hasLinkJoinMarker(profile: AgentProfile): Promise<boolean> {
  const dir = dirname(profile.credential_file);
  for (const name of LINK_MARKERS) {
    try { await lstat(join(dir, name)); return true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return true; }
  }
  return false;
}

function waitWithAbort(ms: number, signals: readonly (AbortSignal | undefined)[], setTimer: TimerSet, clearTimer: TimerClear): Promise<boolean> {
  if (signals.some((s) => s?.aborted)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      for (const s of signals) s?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    for (const s of signals) s?.addEventListener("abort", onAbort, { once: true });
    timer = setTimer(() => finish(true), ms);
  });
}

function mapDeliveryRow(row: DeliveryRow): IncomingMessage {
  const s = row.signal;
  if (!DELIVERY_KINDS.has(s.kind) || s.reaction !== undefined || s.system_alert !== undefined || !s.id || !row.leaseId || typeof s.body !== "string" || s.body.length === 0) {
    throw new CloudLinkError("delivery_unrecognized");
  }
  const replyTarget: ReplyTarget = s.thread_root_id !== undefined && s.thread_root_id !== null
    ? typeof s.thread_root_id === "string" && s.thread_root_id.length > 0
      ? { kind: "thread", threadRootId: s.thread_root_id }
      : (() => { throw new CloudLinkError("delivery_unrecognized"); })()
    : { kind: "private", inReplyTo: s.id };
  return { id: s.id, text: s.body, leaseId: row.leaseId, replyTarget };
}

function buildPostSignal(cmd: ReplyCommand): PostSignalCommand {
  const base = { kind: "post_signal" as const, signal_kind: "note" as const, body: cmd.body, to_user_id: null, to_agent_principal_id: null, about: null };
  return cmd.replyTarget.kind === "thread"
    ? { ...base, in_reply_to: null, thread_root_id: cmd.replyTarget.threadRootId }
    : { ...base, in_reply_to: cmd.replyTarget.inReplyTo, ...(cmd.status !== undefined ? { reply_status: cmd.status } : {}) };
}

export async function openCloudLink(options: OpenCloudLinkOptions): Promise<CloudLinkHandle> {
  const { takeoverWaitMs, takeoverRetryMs, pollMinMs, pollMaxMs } = validateDurations(options);
  const rawFetch = options.fetch ?? globalThis.fetch;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const setTimer: TimerSet = options.setTimer ?? globalThis.setTimeout;
  const clearTimer: TimerClear = options.clearTimer ?? globalThis.clearTimeout;
  const generateId: IdGenerator = options.generateId ?? randomUUID;
  const nextCommandId = () => { const id = generateId(); return COMMAND_ID_RE.test(id) ? id : newCommandId(); };
  const nextSessionId = () => { const id = generateId(); return isSessionUuid(id) ? id.toLowerCase() : randomUUID(); };

  let profile: AgentProfile;
  try { profile = await readAgentProfile(options.profilePath); } catch { throw new CloudLinkError("open_failed"); }
  if (await hasLinkJoinMarker(profile)) throw new CloudLinkError("seat_unsupported", "link_joined");
  let initialCredential: Awaited<ReturnType<typeof readProfileCredential>>;
  try { initialCredential = await readProfileCredential(profile); } catch { throw new CloudLinkError("open_failed"); }
  const target = profileTarget(profile);

  try {
    const dir = await readAgentSignalDirectory(target, initialCredential.token, profile.workspace_id, {
      fetcher: rawFetch, ...(options.requestTimeoutMs !== undefined ? { deadlineMs: options.requestTimeoutMs } : {}),
    });
    if (dir.identity && (dir.identity.principal_id.toLowerCase() !== profile.principal_id.toLowerCase() || dir.identity.workspace_id.toLowerCase() !== profile.workspace_id.toLowerCase())) {
      throw new CloudLinkError("open_failed");
    }
    const self = dir.agents.find((a) => a.principal_id.toLowerCase() === profile.principal_id.toLowerCase());
    if (self?.transport === "hosted_mcp") throw new CloudLinkError("seat_unsupported", "hosted");
    if (self?.turn_only === true) throw new CloudLinkError("seat_unsupported", "turn_only");
  } catch (err) {
    if (err instanceof CloudLinkError) throw err;
    const slug = followErrorEnvelope(err).error;
    if (slug === "transport_unavailable") throw new CloudLinkError("seat_unsupported", "hosted");
    if (slug === H0_SEAT_CLAIM_REFUSED_CODE) throw new CloudLinkError("seat_unsupported", "link_joined");
    throw new CloudLinkError("open_failed");
  }

  const sessionId = nextSessionId();
  const sessionKey = generateSessionKey();
  const draftContext = newSessionBinding({
    target, workspaceId: profile.workspace_id, principalId: profile.principal_id,
    provider: options.provider ?? "claude", mode: "interactive",
    hostSessionId: options.hostSessionId ?? `engine-${sessionId}`,
    tokenFile: profile.credential_file, hostLabel: options.hostLabel ?? null,
    sessionId, sessionKey, acquireCommandId: nextCommandId(),
  });
  const sessionClient = new AgentSessionClient({
    target, fetcher: rawFetch, ...(options.requestTimeoutMs !== undefined ? { timeoutMs: options.requestTimeoutMs } : {}),
  });

  const deadline = clock.now() + takeoverWaitMs;
  let generation: number;
  let acquireCommandId = draftContext.acquire_command_id;
  while (true) {
    if (options.signal?.aborted) throw new CloudLinkError("open_aborted");
    try {
      generation = (await sessionClient.acquire({
        credential: initialCredential.token, workspaceId: profile.workspace_id, context: draftContext, commandId: acquireCommandId,
      })).generation;
      break;
    } catch (err) {
      if (err instanceof AgentSessionError && err.code === "session_not_managed") throw new CloudLinkError("session_not_managed", err.message);
      if (err instanceof AgentSessionError && err.code === "session_conflict") {
        const remaining = deadline - clock.now();
        if (remaining <= 0) throw new CloudLinkError("seat_busy");
        if (!(await waitWithAbort(Math.min(takeoverRetryMs, remaining), [options.signal], setTimer, clearTimer))) throw new CloudLinkError("open_aborted");
        acquireCommandId = nextCommandId();
        continue;
      }
      throw new CloudLinkError("open_failed");
    }
  }

  const acquiredContext = { ...draftContext, generation, enforcement: "enabled" as const };
  const proof: AgentSessionProof = { session_id: sessionId, generation, key: sessionKey };
  let authorityLost = false, closed = false, lastClaimEmpty = false, nextPollWaitMs = pollMinMs;
  let closePromise: Promise<void> | null = null;
  let credentialSession: AgentCredentialSession | null = null;
  const authorityAbort = new AbortController();
  const closeAbort = new AbortController();

  const loseAuthority = (): never => {
    if (!authorityLost) {
      authorityLost = true;
      manager.stopTimers();
      authorityAbort.abort();
      try { options.onAuthorityLost(); } catch { /* ignore */ }
    }
    throw new AuthorityLostError();
  };
  const assertAuthority = (): void => { if (authorityLost || manager.dispatchState() !== "running") loseAuthority(); };
  const isProofRefusal = (err: unknown): boolean =>
    authorityLost || err instanceof AuthorityLostError ||
    (err instanceof DeliveryHttpError && PROOF_CODES.has(err.code)) ||
    (err instanceof CommandHttpError && err.code !== undefined && PROOF_CODES.has(err.code)) ||
    (err instanceof RenewalRefused && PROOF_CODES.has(err.code));
  const getBearer = async (): Promise<string> => {
    assertAuthority();
    if (credentialSession === null) return initialCredential.token;
    try { return await credentialSession.bearer(); }
    catch (err) { if (isProofRefusal(err)) loseAuthority(); throw new CloudLinkError("cloud_request_failed"); }
  };

  const manager = new AgentSessionManager({
    client: sessionClient, credential: () => getBearer(), workspaceId: profile.workspace_id,
    contextPath: "", context: acquiredContext, now: () => clock.now(), setTimer, clearTimer,
    onDispatchStop: () => { try { loseAuthority(); } catch { /* expected */ } },
  });
  manager.start();

  const boundFetch = manager.boundFetcher(rawFetch);
  const guardedFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (authorityLost) throw new AuthorityLostError();
    return await boundFetch(input, init);
  }) as typeof fetch;
  const renewalFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const res = await guardedFetch(input, init);
    if (!res.ok && (res.status === 401 || res.status === 409)) {
      try {
        const parsed = JSON.parse(await res.clone().text()) as Record<string, unknown>;
        if (typeof parsed?.error === "string" && PROOF_CODES.has(parsed.error)) loseAuthority();
      } catch (err) { if (err instanceof AuthorityLostError) throw err; }
    }
    return res;
  }) as typeof fetch;

  try { credentialSession = await openProfileCredential(profile, renewalFetch); }
  catch {
    manager.stopTimers();
    await sessionClient.release(initialCredential.token, profile.workspace_id, proof).catch(() => {});
    throw new CloudLinkError("open_failed");
  }

  const deliveryClient = new DeliveryCommandClient(target, guardedFetch, {
    now: () => clock.now(), ...(options.requestTimeoutMs !== undefined ? { deadlineMs: options.requestTimeoutMs } : {}),
  });
  const commandClient = new ThinCommandClient(
    target, guardedFetch, options.requestTimeoutMs !== undefined ? { signalRequestTimeoutMs: options.requestTimeoutMs } : {},
  );

  const port: CloudPort = {
    async claim(signal?: AbortSignal): Promise<IncomingMessage | null> {
      assertAuthority();
      while (!closed && !signal?.aborted) {
        assertAuthority();
        if (lastClaimEmpty) {
          const waitMs = nextPollWaitMs;
          nextPollWaitMs = Math.min(nextPollWaitMs * 2, pollMaxMs);
          const ok = await waitWithAbort(waitMs, [signal, authorityAbort.signal, closeAbort.signal], setTimer, clearTimer);
          assertAuthority();
          if (!ok || closed || signal?.aborted) return null;
        }
        const bearer = await getBearer();
        assertAuthority();
        let res;
        try {
          res = await deliveryClient.claimAgentInbox({
            workspaceId: profile.workspace_id, credential: bearer, commandId: nextCommandId(),
            listenerInstanceId: sessionId, expectedPrincipalId: profile.principal_id, route: "listener",
          });
        } catch (err) {
          if (isProofRefusal(err)) loseAuthority();
          if (err instanceof DeliveryHttpError && err.code === H0_SEAT_CLAIM_REFUSED_CODE) throw new CloudLinkError("seat_unsupported", "link_joined");
          if (err instanceof DeliveryProtocolError) throw new CloudLinkError("delivery_unrecognized");
          throw new CloudLinkError("cloud_request_failed");
        }
        assertAuthority();
        if (res.deliveries.length === 0) { lastClaimEmpty = true; continue; }
        lastClaimEmpty = false;
        nextPollWaitMs = pollMinMs;
        return mapDeliveryRow(res.deliveries[0]!);
      }
      return null;
    },
    async markSeen(messageId: string, leaseId: string): Promise<void> {
      const bearer = await getBearer();
      assertAuthority();
      try {
        await deliveryClient.ackAgentDelivery({
          workspaceId: profile.workspace_id, credential: bearer, commandId: nextCommandId(),
          signalId: messageId, leaseId, listenerInstanceId: sessionId, outcome: "observed",
          lastErrorCode: null, surfaced: true,
          managedAck: managedAckInput({
            context: acquiredContext, proof, injectionSucceeded: true,
            observedHostSessionId: acquiredContext.host_session_id, hostIdentityTrusted: true,
          }),
        });
      } catch (err) { if (isProofRefusal(err)) loseAuthority(); throw new CloudLinkError("cloud_request_failed"); }
    },
    async postReply(command: ReplyCommand): Promise<void> {
      const bearer = await getBearer();
      assertAuthority();
      try {
        await commandClient.sendSignal({
          workspaceId: profile.workspace_id, credential: bearer, commandId: command.commandId,
          command: buildPostSignal(command), signal: authorityAbort.signal,
        });
      } catch (err) {
        if (isProofRefusal(err)) loseAuthority();
        if (err instanceof CommandHttpError && err.code === "command_id_conflict") throw new CloudLinkError("command_id_conflict");
        throw new CloudLinkError("cloud_request_failed");
      }
    },
  };

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closed = true;
    closeAbort.abort();
    manager.stopTimers();
    closePromise = (async () => {
      if (authorityLost) return;
      try { await sessionClient.release(credentialSession?.current ?? initialCredential.token, profile.workspace_id, proof, nextCommandId()); }
      catch { /* best-effort bounded release; never throw */ }
    })();
    return closePromise;
  };
  return { port, generation, sessionId, close };
}
