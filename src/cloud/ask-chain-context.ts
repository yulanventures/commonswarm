import { dirname, join } from "node:path";
import { AgentSetupError, ONBOARDING_UUID, privatePath, profileScopeKey } from "./agent-profile.js";
import { readSecureJsonFileIfPresent, withFileLock, writeSecureJsonFile } from "./storage.js";

const HANDLED_ASK_LIMIT = 200;

interface HandledAskContext {
  version: 1;
  ask_signal_ids: string[];
}

export const ASK_PARENT_CONTEXT_SENTENCE =
  "No single ask was shown in this turn, so this ask has no declared parent; pass parent_signal_id explicitly.";

export const ASK_PARENT_CLI_SENTENCE =
  "cswarm: no single ask was shown in this turn, so this ask has no declared parent; use --parent <signal-id> to declare one.\n";

export function handledAskContextPath(profilePath: string, hostSessionId?: string): string {
  return join(dirname(privatePath(profilePath)), `handled-asks-${profileScopeKey(hostSessionId)}.json`);
}

function parseHandledAskContext(raw: string): HandledAskContext {
  let state: unknown;
  try { state = JSON.parse(raw); }
  catch { throw new AgentSetupError("ask_context_invalid", "The handled-ask context is damaged. Run a fresh check before posting another ask."); }
  const value = state as Partial<HandledAskContext> | null;
  const normalized = Array.isArray(value?.ask_signal_ids)
    ? value.ask_signal_ids.map(id => typeof id === "string" ? id.toLowerCase() : id)
    : [];
  if (!value || value.version !== 1 || !Array.isArray(value.ask_signal_ids) ||
      value.ask_signal_ids.length > HANDLED_ASK_LIMIT ||
      value.ask_signal_ids.some(id => typeof id !== "string" || !ONBOARDING_UUID.test(id)) ||
      new Set(normalized).size !== normalized.length) {
    throw new AgentSetupError("ask_context_invalid", "The handled-ask context is damaged. Run a fresh check before posting another ask.");
  }
  return { version: 1, ask_signal_ids: normalized as string[] };
}

async function readHandledAskContext(path: string): Promise<HandledAskContext> {
  const raw = await readSecureJsonFileIfPresent(path, 16 * 1024);
  return raw === null ? { version: 1, ask_signal_ids: [] } : parseHandledAskContext(raw);
}

/** A successful turn presentation replaces the prior turn, including with an empty list. */
export async function replaceHandledAsks(
  profilePath: string,
  hostSessionId: string | undefined,
  signalIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(signalIds.map(id => id.toLowerCase()))];
  if (ids.length > HANDLED_ASK_LIMIT || ids.some(id => !ONBOARDING_UUID.test(id))) {
    throw new AgentSetupError("ask_context_invalid", "The handled-ask context could not be saved. Run a fresh check before posting another ask.");
  }
  const path = handledAskContextPath(profilePath, hostSessionId);
  await withFileLock(dirname(path), `handled-asks-${profileScopeKey(hostSessionId)}`, async () => {
    await writeSecureJsonFile(path, JSON.stringify({ version: 1, ask_signal_ids: ids } satisfies HandledAskContext));
  });
}

/** Channel delivery adds to this turn and is deliberately not cleared by its receipt. */
export async function appendHandledAsk(
  profilePath: string,
  hostSessionId: string,
  signalId: string,
): Promise<void> {
  const id = signalId.toLowerCase();
  if (!ONBOARDING_UUID.test(id)) throw new AgentSetupError("ask_context_invalid", "The delivered ask had an invalid signal id.");
  const path = handledAskContextPath(profilePath, hostSessionId);
  await withFileLock(dirname(path), `handled-asks-${profileScopeKey(hostSessionId)}`, async () => {
    const state = await readHandledAskContext(path);
    const ids = state.ask_signal_ids.includes(id)
      ? state.ask_signal_ids
      : [...state.ask_signal_ids, id].slice(-HANDLED_ASK_LIMIT);
    await writeSecureJsonFile(path, JSON.stringify({ version: 1, ask_signal_ids: ids } satisfies HandledAskContext));
  });
}

export async function handledAskIds(profilePath: string, hostSessionId?: string): Promise<string[]> {
  return (await readHandledAskContext(handledAskContextPath(profilePath, hostSessionId))).ask_signal_ids;
}

export async function defaultAskParent(profilePath: string, hostSessionId?: string): Promise<string | undefined> {
  const ids = await handledAskIds(profilePath, hostSessionId);
  return ids.length === 1 ? ids[0] : undefined;
}
