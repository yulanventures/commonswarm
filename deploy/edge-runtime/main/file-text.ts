/** Internal PDF text gateway (MCP parity 1b). Not a public function: it is served by main
 * on FILE_TEXT_PATH only, outside /functions/v1, so Kong never forwards to it.
 *
 * Every request must come from a loopback peer (the real socket address, never a header)
 * AND carry the token shared only by main and the mcp function. Both are checked before
 * the body is read or any worker exists. At most ONE parser isolate is alive at a time,
 * counted until the runtime no longer lists it (not merely until it answered); excess work
 * gets a fixed busy answer, never a queue. The parser gets the bounded bytes and nothing
 * else: no env, no token, no caller headers, network/filesystem/process access denied. */

export const FILE_TEXT_PATH = "/__internal/file-text";
export const FILE_TEXT_TOKEN_ENV = "SWARM_FILE_TEXT_TOKEN";
export const FILE_TEXT_TOKEN_HEADER = "x-commonswarm-file-text";
export const FILE_TEXT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const FILE_TEXT_BODY_DEADLINE_MS = 5_000;
/** The parser returns at most 512 KiB of text; JSON escaping and fields stay well under this. */
const FILE_TEXT_MAX_RESULT_BYTES = 4 * 1024 * 1024;
const TOKEN_MIN_LENGTH = 32;

export const FILE_TEXT_WORKER_LIMITS = Object.freeze({
  memoryLimitMb: 48,
  cpuTimeSoftLimitMs: 2_000,
  cpuTimeHardLimitMs: 4_000,
  workerTimeoutMs: 10_000,
});

/** Deno permission sets: an empty deny list denies everything of that kind. (An empty
 * allow list would allow everything, so none is used.) */
export const FILE_TEXT_PERMISSIONS = Object.freeze({
  allowAll: false,
  denyNet: [] as string[],
  denyRead: [] as string[],
  denyWrite: [] as string[],
  denyRun: [] as string[],
  denyEnv: [] as string[],
  denySys: [] as string[],
  denyFfi: [] as string[],
});

interface ParserWorker { key: string; fetch(request: Request): Promise<Response> }
export interface FileTextGatewayDeps {
  token: string | null | undefined;
  servicePath: string;
  workers: {
    create(options: Record<string, unknown>): Promise<ParserWorker>;
    memStats(): Promise<Map<string, unknown> | Record<string, unknown>>;
  };
  isWorkerLimitError: (error: unknown) => boolean;
  log?: (line: string) => void;
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const notFound = () => json(404, { error: "not_found" });

export function isLoopbackPeer(hostname: string | null | undefined): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "::ffff:127.0.0.1";
}

function sameToken(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let index = 0; index < b.length; index++) diff |= (a[index] ?? 0) ^ b[index]!;
  return diff === 0;
}

/** Read at most `max` bytes before `deadlineMs`; null when the body is larger or late. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, declared: number, max: number, deadlineMs: number): Promise<Uint8Array | null> {
  if (stream === null) return null;
  const out = new Uint8Array(declared);
  const reader = stream.getReader();
  const timer = setTimeout(() => { reader.cancel().catch(() => {}); }, deadlineMs);
  let used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (used + value.length > declared || used + value.length > max) return null;
      out.set(value, used);
      used += value.length;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return used === declared ? out : null;
}

async function readResult(response: Response): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      used += value.length;
      if (used > FILE_TEXT_MAX_RESULT_BYTES) return null;
      parts.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(used);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return typeof parsed.text === "string" && typeof parsed.truncated === "boolean" &&
      Number.isSafeInteger(parsed.pages_read) && Number.isSafeInteger(parsed.page_count)
      ? { text: parsed.text, truncated: parsed.truncated, pages_read: parsed.pages_read, page_count: parsed.page_count }
      : null;
  } catch {
    return null;
  }
}

export function createFileTextGateway(deps: FileTextGatewayDeps) {
  const token = typeof deps.token === "string" && deps.token.length >= TOKEN_MIN_LENGTH ? deps.token : null;
  // The one live parser: reserved synchronously before any await, released only when the
  // runtime no longer lists its isolate (or when creating it failed).
  let live: { key: string | null } | null = null;

  async function slotFree(): Promise<boolean> {
    const held = live;
    if (held === null) return true;
    if (held.key === null) return false;
    let present: Map<string, unknown> | Record<string, unknown>;
    try { present = await deps.workers.memStats(); } catch { return false; }
    const alive = present instanceof Map ? present.has(held.key) : Object.hasOwn(present, held.key);
    if (!alive && live === held) live = null;
    return live === null;
  }

  return async function handleFileText(request: Request, peerHostname: string | null | undefined): Promise<Response> {
    const discard = () => { request.body?.cancel().catch(() => {}); };
    if (token === null || !isLoopbackPeer(peerHostname) || request.method !== "POST" ||
        !sameToken(request.headers.get(FILE_TEXT_TOKEN_HEADER) ?? "", token)) {
      discard();
      return notFound();
    }
    const declared = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > FILE_TEXT_MAX_INPUT_BYTES) {
      discard();
      return json(413, { error: "pdf_too_large" });
    }
    if (!(await slotFree()) || live !== null) {
      discard();
      return json(503, { error: "busy" });
    }
    const slot: { key: string | null } = { key: null };
    live = slot;
    let held = false;
    const started = Date.now();
    let outcome = "unreadable";
    try {
      const bytes = await readBounded(request.body, declared, FILE_TEXT_MAX_INPUT_BYTES, FILE_TEXT_BODY_DEADLINE_MS);
      if (bytes === null) { outcome = "input_refused"; return json(413, { error: "pdf_too_large" }); }
      const worker = await deps.workers.create({
        servicePath: deps.servicePath,
        envVars: [],
        noModuleCache: false,
        forceCreate: true,
        allowRemoteModules: false,
        permissions: FILE_TEXT_PERMISSIONS,
        ...FILE_TEXT_WORKER_LIMITS,
      });
      slot.key = worker.key;
      held = true;
      // A fresh request: the parser never sees the caller's headers, token or URL.
      const response = await worker.fetch(new Request("http://file-text.internal/", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: bytes as Uint8Array<ArrayBuffer>,
      }));
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return json(422, { error: "pdf_unreadable" });
      }
      const result = await readResult(response);
      if (result === null) return json(422, { error: "pdf_unreadable" });
      outcome = "ok";
      return json(200, result);
    } catch (error) {
      if (deps.isWorkerLimitError(error)) {
        outcome = "too_complex";
        return json(422, { error: "pdf_too_complex" });
      }
      return json(422, { error: "pdf_unreadable" });
    } finally {
      if (!held && live === slot) live = null;
      // Fixed fields only: never bytes, text, paths or parser messages.
      deps.log?.(JSON.stringify({ event: "file_text", outcome, ms: Date.now() - started }));
    }
  };
}
