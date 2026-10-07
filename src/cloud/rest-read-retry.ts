export const JWT_ISSUED_AT_FUTURE_RETRY_DELAY_MS = 1_000;

export type RestReadResponseKind = "jwt_issued_at_future" | "other";

export interface RestReadRetryOptions {
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  /** Shared by transport attempts of one logical read. */
  retryState?: { attempted: boolean };
}

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const PARAM = new RegExp(`^(${TOKEN})[ \\t]*=[ \\t]*(?:"((?:[^"\\\\\\r\\n]|\\\\[\\t -~])*)"|(${TOKEN}))[ \\t]*$`);
const CHALLENGE = new RegExp(`^(${TOKEN})[ \\t]+(.+)$`);

function futureBearerChallenge(header: string | null): boolean {
  if (header === null) return false;
  // Commas inside quoted strings separate neither parameters nor challenges.
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (quoted && char === "\\") { index += 1; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === ",") {
      parts.push(header.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted) return false;
  parts.push(header.slice(start));
  let bearer = false;
  let valid = true;
  let description: string | undefined;
  let names = new Set<string>();
  const matches = () => bearer && valid && description === "JWT issued at future";
  for (const raw of parts) {
    let part = raw.trim();
    if (!PARAM.test(part)) {
      const challenge = CHALLENGE.exec(part);
      if (matches()) return true;
      bearer = challenge?.[1]?.toLowerCase() === "bearer";
      valid = challenge !== null;
      names = new Set();
      description = undefined;
      part = challenge?.[2] ?? "";
    }
    const param = PARAM.exec(part);
    if (!param) { valid = false; continue; }
    const name = param[1]!.toLowerCase();
    if (names.has(name)) valid = false;
    names.add(name);
    if (name === "error_description" && param[2] !== undefined) {
      description = param[2].replace(/\\([\t -~])/g, "$1");
    }
  }
  return matches();
}

export async function classifyRestReadResponse(response: Response): Promise<RestReadResponseKind> {
  // Classify the server HTTP response at the boundary, never a JavaScript Error.message.
  if (response.status !== 401) return "other";
  if (futureBearerChallenge(response.headers.get("www-authenticate"))) return "jwt_issued_at_future";
  const body: unknown = await response.clone().json().catch(() => null);
  return body !== null && typeof body === "object" &&
      (body as { message?: unknown }).message === "JWT issued at future"
    ? "jwt_issued_at_future"
    : "other";
}

function abortable<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function waitForRetry(signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
    const timer = setTimeout(done, JWT_ISSUED_AT_FUTURE_RETRY_DELAY_MS);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One retry of the same person-token request, within its original budget. */
export async function fetchRestReadRetrying(
  fetcher: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  options: RestReadRetryOptions = {},
): Promise<Response> {
  const response = await fetcher(input, init);
  const now = options.now ?? Date.now;
  const fits = () => options.deadlineMs === undefined ||
    options.deadlineMs - now() > JWT_ISSUED_AT_FUTURE_RETRY_DELAY_MS;
  if (options.retryState?.attempted || !fits()) return response;
  if (await abortable(classifyRestReadResponse(response), init.signal) !== "jwt_issued_at_future" || !fits()) return response;
  init.signal?.throwIfAborted();
  if (options.retryState) options.retryState.attempted = true;
  await abortable(
    options.sleep ? options.sleep(JWT_ISSUED_AT_FUTURE_RETRY_DELAY_MS, init.signal) : waitForRetry(init.signal),
    init.signal,
  );
  init.signal?.throwIfAborted();
  if (options.deadlineMs !== undefined && now() >= options.deadlineMs) return response;
  // Cancel without waiting on a clone's tee branch to release its lock.
  void response.body?.cancel().catch(() => {});
  return await fetcher(input, init);
}
