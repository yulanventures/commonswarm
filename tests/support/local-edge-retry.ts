/**
 * Narrow retry helper for local `supabase functions serve` in CI tests.
 *
 * Production runs `deploy/edge-runtime/main/index.ts`, which wraps user-worker
 * `create + fetch` in `withWorkerRetiredRetry` (one transparent retry when Deno
 * edge-runtime retires an aged user worker mid-request). Local `supabase
 * functions serve` uses Supabase CLI's stock dev router without that wrapper,
 * so heavy bursts like T-10 occasionally receive a dev-router HTTP 500
 * (`WorkerAlreadyRetired`) before our command function ever runs.
 *
 * This helper mirrors production's single-retry budget for idempotent
 * `command_id` requests and strictly refuses to retry any response produced by
 * `supabase/functions/command/index.ts` (which always sets `error`, `status`,
 * or `ok`).
 */

export interface LocalEdgeRawResponse {
  status: number;
  text: string;
  body: Record<string, unknown> | null;
}

export function extractPhaseLogs(before: string, after: string): string {
  if (after.startsWith(before)) return after.slice(before.length);
  return after;
}

export function isLocalEdgeWorkerRetiredResponse(
  response: LocalEdgeRawResponse,
  phaseLogs: string,
): boolean {
  if (response.status !== 500) return false;
  const trimmed = response.text.trim();
  if (trimmed.length === 0) {
    return phaseLogs.includes("WorkerAlreadyRetired");
  }
  const body = response.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response.text.includes("WorkerAlreadyRetired") || phaseLogs.includes("WorkerAlreadyRetired");
  }
  if (
    Object.hasOwn(body, "error") ||
    Object.hasOwn(body, "status") ||
    Object.hasOwn(body, "ok")
  ) {
    return false;
  }
  if (typeof body.code !== "string") return false;
  const messageText = typeof body.message === "string"
    ? body.message
    : typeof body.msg === "string"
    ? body.msg
    : null;
  if (messageText === null) return false;
  return messageText.includes("WorkerAlreadyRetired") || phaseLogs.includes("WorkerAlreadyRetired");
}

export function parseLocalEdgeJsonBody(text: string): Record<string, unknown> | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export async function withLocalEdgeWorkerRetiredRetry(
  attempt: () => Promise<LocalEdgeRawResponse>,
  readLogs: () => string,
): Promise<LocalEdgeRawResponse> {
  const logsBefore = readLogs();
  const first = await attempt();
  const phaseLogs = extractPhaseLogs(logsBefore, readLogs());
  if (!isLocalEdgeWorkerRetiredResponse(first, phaseLogs)) {
    return first;
  }
  return await attempt();
}
