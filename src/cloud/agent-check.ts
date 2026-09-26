import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SignalRecord } from "./command-client.js";
import {
  compareSignalCursor, parseSignalRecord, readAgentSignalDirectory, readAgentSignalPage,
  SignalReadTimeoutError, signalAddressesAgent, type SignalCursor, type SignalDirectory,
} from "./signals.js";
import {
  FileLockTimeoutError,
  readSecureJsonFileIfPresent,
  withFileLock,
  writeSecureJsonFile,
} from "./storage.js";
import {
  AgentSetupError, ONBOARDING_UUID, openProfileCredential, privatePath,
  profileTarget, profileSessionContext, readAgentProfile, type AgentProfile,
} from "./agent-profile.js";
import { bindSessionProof } from "./session-proof.js";
import { sessionProofOf } from "./session-context.js";
import { quoteAgentArgument } from "./agent-onboarding-contract.js";
import { AGENT_CHECK_TIMEOUT_MS } from "./agent-check-budget.js";
import { DeliveryCommandClient, DeliveryHttpError } from "./delivery.js";

export {
  AGENT_CHECK_OUTPUT_ALLOWANCE_MS,
  AGENT_CHECK_STARTUP_ALLOWANCE_MS,
  AGENT_CHECK_TIMEOUT_MS,
  HOST_HOOK_TIMEOUT_SECONDS,
} from "./agent-check-budget.js";
export const AGENT_CHECK_PAGE_SIZE = 20;
export const AGENT_CHECK_PREVIEW_CHARS = 1_000;
export const AGENT_CHECK_BODY_BUDGET = 4_000;
export const AGENT_CHECK_CACHE_LIMIT = 200;
export const AGENT_CHECK_ACK_BATCH_LIMIT = AGENT_CHECK_PAGE_SIZE;
export const AGENT_CHECK_ACK_MIN_REMAINING_MS = 50;
export const AGENT_CHECK_ACK_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const AGENT_CHECK_ACK_RETRY_BASE_MS = 250;
export const AGENT_CHECK_ACK_RETRY_MAX_MS = 60_000;

export interface AgentCheckMessage {
  id: string;
  from: string;
  from_kind: SignalRecord["from_kind"];
  sender_owner_relation: string;
  kind: SignalRecord["kind"];
  body: string;
  truncated: boolean;
  attachment_count: number;
  created_at: string;
  full_text_command?: string;
}

export interface AgentCheckResult {
  checked: true;
  cached: false;
  messages: AgentCheckMessage[];
  has_more: boolean;
  next_action: string | null;
  /**
   * WHICH workspace was checked, by id and by the name a person uses. Item D: `check` is the
   * verb an agent runs every turn, so it is the surface most likely to be the only thing in a
   * transcript naming the workspace. `workspace_name` is null when the deployment does not send
   * one; the id is always present.
   */
  workspace_id: string;
  workspace_name: string | null;
}

interface CheckState {
  version: 1;
  cursor: SignalCursor | null;
  /** A bounded cache of presented messages, not delivery ACKs. The service remains authoritative. */
  messages: SignalRecord[];
  /** Only rows that were successfully presented and locally committed enter this retry queue. */
  pending_observed_ids?: string[];
  /** Rotates transient retries so one slow row cannot starve later mail. */
  pending_observed_next?: number;
  pending_observed_retries?: Record<string, { attempts: number; first_at: number; next_at?: number }>;
}

function queuedRetries(state: CheckState, ids: string[]): CheckState["pending_observed_retries"] {
  const queued = new Set(ids);
  return Object.fromEntries(Object.entries(state.pending_observed_retries ?? {})
    .filter(([id]) => queued.has(id)));
}

function checkTimeoutError(): AgentSetupError {
  return new AgentSetupError(
    "check_timeout",
    "The message check timed out. Try cswarm check again; the inbox was not proved empty.",
  );
}

export async function withAgentDeadline<T>(
  timeoutMs: number,
  run: (fetcher: typeof fetch, signal: AbortSignal) => Promise<T>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(checkTimeoutError());
    }, timeoutMs);
  });
  const bounded = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    controller.signal.throwIfAborted();
    const result = await fetcher(input, {
      ...init, redirect: "error",
      signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
    });
    controller.signal.throwIfAborted();
    return result;
  }) as typeof fetch;
  try {
    const result = await Promise.race([run(bounded, controller.signal), timeout]);
    if (controller.signal.aborted) throw checkTimeoutError();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw checkTimeoutError();
    throw error;
  } finally { clearTimeout(timer!); }
}

export function assertProfileIdentity(profile: AgentProfile, directory: SignalDirectory): void {
  if (directory.identity?.credential_valid !== true ||
      directory.identity.principal_id !== profile.principal_id ||
      directory.identity.workspace_id !== profile.workspace_id ||
      !directory.agents.some(agent => agent.principal_id === profile.principal_id && agent.owner_user_id === directory.identity?.owner_user_id)) {
    throw new AgentSetupError("authenticated_identity_mismatch", "The service did not confirm this agent and workspace. No messages were shown. Ask for the correct connection file.");
  }
}

function checkStatePath(profilePath: string, hostSessionId?: string): string {
  // The same profile's hook and explicit checks share presentation state. Session
  // identity gates the hook, not pagination; restarting must not replay the feed.
  return join(dirname(profilePath), "check.json");
}

async function readCheckState(path: string): Promise<CheckState> {
  const raw = await readSecureJsonFileIfPresent(path, 16 * 1024 * 1024);
  if (raw === null) return { version: 1, cursor: null, messages: [] };
  let state: CheckState;
  try { state = JSON.parse(raw); } catch { throw new AgentSetupError("check_state_invalid", "The message cursor is damaged. Restore the check state before continuing."); }
  if (!state || state.version !== 1 || !Array.isArray(state.messages) || state.messages.length > AGENT_CHECK_CACHE_LIMIT ||
      (state.pending_observed_ids !== undefined && (!Array.isArray(state.pending_observed_ids) ||
        state.pending_observed_ids.length > AGENT_CHECK_CACHE_LIMIT ||
        state.pending_observed_ids.some(id => typeof id !== "string" || !ONBOARDING_UUID.test(id)))) ||
      (state.pending_observed_next !== undefined &&
        (!Number.isSafeInteger(state.pending_observed_next) || state.pending_observed_next < 0)) ||
      (state.pending_observed_retries !== undefined &&
        (typeof state.pending_observed_retries !== "object" || state.pending_observed_retries === null ||
          Object.entries(state.pending_observed_retries).some(([id, retry]) =>
            !ONBOARDING_UUID.test(id) || !retry || !Number.isSafeInteger(retry.attempts) ||
            retry.attempts < 0 || !Number.isFinite(retry.first_at) ||
            (retry.next_at !== undefined && !Number.isFinite(retry.next_at))))) ||
      (state.cursor !== null && (!state.cursor || !ONBOARDING_UUID.test(state.cursor.id) || !Number.isFinite(Date.parse(state.cursor.created_at))))) {
    throw new AgentSetupError("check_state_invalid", "The message cursor is damaged. Restore the check state before continuing.");
  }
  try { state.messages = state.messages.map(row => parseSignalRecord(row)); }
  catch { throw new AgentSetupError("check_state_invalid", "The saved messages are damaged. Restore the check state before continuing."); }
  state.pending_observed_retries = queuedRetries(state, state.pending_observed_ids ?? []);
  return state;
}

/** Always fresh: no cooldown, no listener, no background process. */
export async function checkAgentMessages(options: {
  profilePath: string;
  hostSessionId?: string;
  full?: boolean;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Absolute wall-clock deadline (epoch ms) that can only shorten the budget, e.g. a host hook's process deadline. */
  deadlineAtMs?: number;
  /** Cursor advances only after the consumer has accepted the output. */
  present: (result: AgentCheckResult) => Promise<void>;
  /** MCP commits only after the stdio response has been written. */
  deferCursorCommit?: (commit: (lastVisibleId?: string) => Promise<void>) => void;
}): Promise<AgentCheckResult> {
  const startedAt = Date.now();
  const profilePath = privatePath(options.profilePath);
  const profile = await readAgentProfile(profilePath, options.hostSessionId);
  const path = checkStatePath(profilePath, options.hostSessionId);
  const timeoutMs = options.timeoutMs ?? AGENT_CHECK_TIMEOUT_MS;
  const deadlineMs = Math.min(startedAt + timeoutMs, options.deadlineAtMs ?? Number.POSITIVE_INFINITY);
  try {
    const checked = await withFileLock(dirname(path), "check", async () => {
      const state = await readCheckState(path);
      let ackAfterCommit: (() => Promise<void>) | undefined;
      const result = await withAgentDeadline(Math.max(1, deadlineMs - Date.now()), async (bounded, signal) => {
        const managed = await profileSessionContext(profile, options.hostSessionId);
        const fetcher = bindSessionProof(bounded, managed ? sessionProofOf(managed.context) : null);
        const credential = await openProfileCredential(profile, fetcher);
        const token = await credential.bearer();
        const target = profileTarget(profile);
        const [directory, page] = await Promise.all([
          readAgentSignalDirectory(target, token, profile.workspace_id, { fetcher, signal, deadlineMs }),
          readAgentSignalPage(target, { kind: "agent", token }, {
            workspaceId: profile.workspace_id, inbox: true, ascending: true,
            limit: AGENT_CHECK_PAGE_SIZE,
            ...(state.cursor === null ? {} : { after: state.cursor }),
          }, { fetcher, signal, deadlineMs }),
        ]);
        assertProfileIdentity(profile, directory);
        if (!page.capabilities.cursorAfter || page.legacyCursorFallback) {
          throw new AgentSetupError("check_paging_unsupported", "This deployment cannot page the inbox without gaps. Update the service; use cswarm inbox to read it in the meantime.");
        }
        const messages: AgentCheckMessage[] = [];
        const presented: SignalRecord[] = [];
        let budget = AGENT_CHECK_BODY_BUDGET;
        let cursor = state.cursor;
        let consumed = 0;
        for (const row of page.signals) {
          if (row.workspace_id !== profile.workspace_id || !signalAddressesAgent(row, profile.principal_id)) {
            throw new AgentSetupError("check_recipient_mismatch", "The service returned a message for another recipient. The cursor was not changed.");
          }
          const next = { id: row.id, created_at: row.created_at };
          if (cursor && compareSignalCursor(next, cursor) <= 0) {
            throw new AgentSetupError("check_page_order_invalid", "The inbox page is out of order. The cursor was not changed.");
          }
          const body = options.full ? row.body : row.body.slice(0, AGENT_CHECK_PREVIEW_CHARS);
          if (messages.length > 0 && body.length > budget) break;
          messages.push({
            id: row.id, from: row.from, from_kind: row.from_kind,
            sender_owner_relation: row.sender_owner_relation ?? "unknown", kind: row.kind,
            body, truncated: body.length < row.body.length,
            attachment_count: row.attachments?.length ?? 0, created_at: row.created_at,
            ...(body.length < row.body.length ? {
              full_text_command: `cswarm check --profile ${shellQuote(profilePath)}${options.hostSessionId ? ` --host-session-id ${shellQuote(options.hostSessionId)}` : ""} --message-id ${row.id}`,
            } : {}),
          });
          presented.push(row);
          budget -= body.length;
          cursor = next;
          consumed += 1;
        }
        const hasMore = consumed < page.signals.length || page.rawCount >= AGENT_CHECK_PAGE_SIZE;
        /* Blank is UNKNOWN, not a manufactured label — the same rule workspaceLabel() applies
         * in the CLI. Null renders as the id alone, which is always true. */
        const rawName = directory.identity?.workspace_name;
        const result: AgentCheckResult = {
          checked: true, cached: false, messages, has_more: hasMore,
          workspace_id: profile.workspace_id,
          workspace_name: rawName == null || rawName.trim() === "" ? null : rawName,
          next_action: hasMore ? `More messages may remain. Run cswarm check --profile ${shellQuote(profilePath)}${options.hostSessionId ? ` --host-session-id ${shellQuote(options.hostSessionId)}` : ""} again.` : null,
        };
        if (signal.aborted) throw checkTimeoutError();
        // Save the full bodies before showing a preview with its retrieval command. Failure
        // to present can replay messages, but cannot lose them or advance delivery state.
        const cached: CheckState = {
          ...state, messages: [...state.messages.filter(old => !presented.some(row => row.id === old.id)), ...presented].slice(-AGENT_CHECK_CACHE_LIMIT),
        };
        if (presented.length > 0) await writeSecureJsonFile(path, JSON.stringify(cached));
        signal.throwIfAborted();
        await options.present(result);
        const directedIds = presented.filter(row => row.kind === "ask" || row.kind === "note").map(row => row.id);
        const pendingIds = [...new Set([...(state.pending_observed_ids ?? []), ...directedIds])].slice(-AGENT_CHECK_CACHE_LIMIT);
        const ackPending = async () => {
          const committed = await readCheckState(path);
          const queued = committed.pending_observed_ids ?? [];
          const start = queued.length === 0 ? 0 : (committed.pending_observed_next ?? 0) % queued.length;
          const batch = [...queued.slice(start), ...queued.slice(0, start)].slice(0, AGENT_CHECK_ACK_BATCH_LIMIT);
          const removed = new Set<string>();
          const retryUpdates = new Map<string, { attempts: number; first_at: number; next_at: number }>();
          const persist = async (attempt?: { id: string; retry: { attempts: number; first_at: number; next_at: number } }, rotate = false) => {
            await withFileLock(dirname(path), "check", async () => {
              const current = await readCheckState(path);
              const remaining = (current.pending_observed_ids ?? []).filter(value => !removed.has(value));
              const retries = { ...(current.pending_observed_retries ?? {}) };
              for (const [id, retry] of retryUpdates) retries[id] = retry;
              if (attempt) retries[attempt.id] = attempt.retry;
              await writeSecureJsonFile(path, JSON.stringify({ ...current,
                pending_observed_ids: remaining, pending_observed_retries: queuedRetries({ ...current, pending_observed_retries: retries }, remaining),
                ...(rotate ? { pending_observed_next: remaining.length === 0 ? 0 : (start + batch.length) % remaining.length } : {}) }));
            }, { timeoutMs: Math.max(1, Math.floor(deadlineMs - Date.now())) });
            removed.clear();
            retryUpdates.clear();
          };
          for (const id of batch) {
            const now = Date.now();
            const remainingMs = deadlineMs - now;
            if (remainingMs < AGENT_CHECK_ACK_MIN_REMAINING_MS) break;
            const prior = committed.pending_observed_retries?.[id] ?? { attempts: 0, first_at: now };
            if (now - prior.first_at >= AGENT_CHECK_ACK_MAX_AGE_MS) {
              removed.add(id);
              continue;
            }
            if ((prior.next_at ?? 0) > now) continue;
            // Commit before transport: a request that consumes the deadline still counts.
            const attempts = prior.attempts + 1;
            const backoff = Math.min(AGENT_CHECK_ACK_RETRY_MAX_MS,
              AGENT_CHECK_ACK_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8));
            await persist({ id, retry: { attempts, first_at: prior.first_at, next_at: now + remainingMs + backoff } });
            try {
              const client = new DeliveryCommandClient(target, fetcher, {
                deadlineMs: Math.min(AGENT_CHECK_TIMEOUT_MS, Math.max(1, deadlineMs - Date.now())),
              });
              await client.observeUnclaimedAgentDelivery({ workspaceId: profile.workspace_id,
                credential: token, commandId: randomUUID(), signalId: id });
              removed.add(id);
            } catch (error) {
              const terminal = error instanceof DeliveryHttpError &&
                (error.status === 403 || error.status === 404 || error.status === 409 ||
                  (error.status === 400 && error.code === "invalid_request"));
              if (terminal) removed.add(id);
              else if (deadlineMs - Date.now() >= AGENT_CHECK_ACK_MIN_REMAINING_MS)
                retryUpdates.set(id, { attempts, first_at: prior.first_at, next_at: Date.now() + backoff });
            }
          }
          const writeBudgetMs = Math.floor(deadlineMs - Date.now());
          if (writeBudgetMs < AGENT_CHECK_ACK_MIN_REMAINING_MS) return;
          if (batch.length > 0 || removed.size > 0 || retryUpdates.size > 0) await persist(undefined, true);
        };
        if (presented.length > 0) {
          if (options.deferCursorCommit) {
            options.deferCursorCommit((lastVisibleId?: string) => withFileLock(dirname(path), "check", async () => {
              const current = await readCheckState(path);
              const visible = lastVisibleId === undefined ? cursor : presented.find(row => row.id === lastVisibleId);
              const candidate = visible ? { id: visible.id, created_at: visible.created_at } : null;
              if (candidate && (!current.cursor || compareSignalCursor(candidate, current.cursor) > 0)) {
                // Re-read under the lock: another check may have advanced the cursor or
                // cached additional full bodies since this response was prepared.
                const visibleIds = presented.slice(0, presented.findIndex(row => row.id === lastVisibleId) + 1)
                  .filter(row => row.kind === "ask" || row.kind === "note").map(row => row.id);
                const pendingVisibleIds = [...new Set([...(current.pending_observed_ids ?? []), ...visibleIds])]
                  .slice(-AGENT_CHECK_CACHE_LIMIT);
                await writeSecureJsonFile(path, JSON.stringify({ ...current, cursor: candidate,
                  pending_observed_ids: pendingVisibleIds,
                  pending_observed_retries: queuedRetries(current, pendingVisibleIds) }));
              }
            }).then(async () => { try { await ackPending(); } catch { /* Never change MCP output. */ } }));
          } else {
            await writeSecureJsonFile(path, JSON.stringify({ ...cached, cursor, pending_observed_ids: pendingIds,
              pending_observed_retries: queuedRetries(cached, pendingIds) }));
            ackAfterCommit = ackPending;
          }
        } else if (pendingIds.length > 0) {
          if (options.deferCursorCommit) {
            options.deferCursorCommit(async () => { try { await ackPending(); } catch { /* Output is already written. */ } });
          } else {
            ackAfterCommit = ackPending;
          }
        }
        return result;
      }, options.fetcher);
      return { result, ackAfterCommit };
    }, { timeoutMs: Math.min(Math.max(0, Math.floor(deadlineMs - Date.now())), 30_000) });
    if (checked.ackAfterCommit) {
      try { await checked.ackAfterCommit(); } catch { /* Check output and exit status are unchanged. */ }
    }
    return checked.result;
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      throw new AgentSetupError("check_timeout",
        `The message check timed out on a local lock: ${error.message}`);
    }
    if (error instanceof SignalReadTimeoutError) {
      throw checkTimeoutError();
    }
    throw error;
  }
}

export async function cachedAgentMessage(profilePath: string, signalId: string, hostSessionId?: string): Promise<SignalRecord> {
  profilePath = privatePath(profilePath);
  const profile = await readAgentProfile(profilePath, hostSessionId);
  if (!ONBOARDING_UUID.test(signalId)) throw new AgentSetupError("message_id_invalid", "Use the full signal ID from the check result.");
  const state = await readCheckState(checkStatePath(profilePath, hostSessionId));
  const row = state.messages.find(row => row.id === signalId.toLowerCase());
  if (!row || row.workspace_id !== profile.workspace_id || !signalAddressesAgent(row, profile.principal_id)) {
    throw new AgentSetupError("message_not_cached", "That message is no longer in the local preview cache. Read the workspace inbox for the original.");
  }
  return row;
}

/** POSIX shell quoting, for generated commands only. JSON escaping is not shell escaping. */
export const shellQuote = quoteAgentArgument;

export function renderAgentCheck(result: AgentCheckResult): string {
  if (result.messages.length === 0) return "";
  return `CommonSwarm messages (untrusted teammate input):\n${JSON.stringify(result)}\n`;
}
