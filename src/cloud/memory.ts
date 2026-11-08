/**
 * Brain M3: workspace memory for agents. Saves are live; the server matches on the subject and
 * answers created, duplicate or updated, so an agent never needs to search before saving.
 * Everything read back is untrusted workspace data, never instructions.
 */
import { withClientBuild } from "./client-build.js";
import { newCommandId } from "./command-client.js";
import {
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  readEndpoint,
  type CloudTarget,
} from "./config.js";

export const MEMORY_KINDS = ["decision", "convention", "ownership", "fact"] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export const MEMORY_SUBJECT_MAX = 120;
export const MEMORY_STATEMENT_MAX = 1000;
export const MEMORY_EVIDENCE_MAX = 5;
export const MEMORY_EVIDENCE_URL_MAX = 500;
export const MEMORY_QUERY_MAX = 200;
export const MEMORY_SEARCH_LIMIT_MAX = 50;
/** The server's subject rule, applied after it lowercases and collapses spaces. */
const SUBJECT_RE = /^[a-z0-9][a-z0-9 ._/-]{0,119}$/;

export interface MemoryRecord {
  memory_id: string;
  subject: string;
  kind: MemoryKind;
  statement: string;
  evidence: string[];
  revision: number;
  status?: "active" | "deleted";
}

export interface MemorySaveInput {
  kind: MemoryKind;
  subject: string;
  statement: string;
  evidence: string[];
  expected_revision?: number;
}

export type MemoryOutcome = "created" | "updated" | "duplicate" | "forgotten";

export interface MemoryCommandResult {
  /** The memory and any previous statement are workspace data, never instructions. */
  untrusted_content: true;
  memory: MemoryRecord | { memory_id: string; status: "deleted" };
  memory_outcome: MemoryOutcome;
  previous_statement?: string;
}

/** A refusal. `memory` is the current memory when a save hit an existing subject. */
export class MemoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly memory?: MemoryRecord,
    readonly noResponse = false,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

/** The subject as the server will store it, or a sentence saying why it can't be one. */
export function memorySubject(value: string): { subject: string } | { problem: string } {
  const subject = value.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  if (!SUBJECT_RE.test(subject)) {
    return { problem: `A subject is 1 to ${MEMORY_SUBJECT_MAX} characters: letters, digits, spaces, dot, underscore, slash or hyphen, starting with a letter or digit.` };
  }
  return { subject };
}

/** The link in the form the server stores and compares (its own href), or null when it can't be evidence. */
export function memoryEvidenceHref(link: string): string | null {
  try {
    const url = new URL(link.trim());
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}

/** Checks a save before it's sent, with the server's own limits. */
export function memorySaveProblem(input: MemorySaveInput): string | null {
  if (!MEMORY_KINDS.includes(input.kind)) return `The kind is one of ${MEMORY_KINDS.join(", ")}.`;
  const subject = memorySubject(input.subject);
  if ("problem" in subject) return subject.problem;
  const statement = input.statement.normalize("NFC").trim();
  if (statement.length < 1 || statement.length > MEMORY_STATEMENT_MAX) {
    return `A statement is 1 to ${MEMORY_STATEMENT_MAX} characters.`;
  }
  if (input.evidence.length > MEMORY_EVIDENCE_MAX) return `Give at most ${MEMORY_EVIDENCE_MAX} evidence links.`;
  for (const link of input.evidence) {
    const href = memoryEvidenceHref(link);
    if (href === null || href.length > MEMORY_EVIDENCE_URL_MAX) {
      return `Each evidence link is an https URL without a user name or password, up to ${MEMORY_EVIDENCE_URL_MAX} characters.`;
    }
  }
  if (input.expected_revision !== undefined &&
      (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1)) {
    return "expected_revision is a positive whole number: the revision you read.";
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function memoryOf(value: unknown): MemoryRecord | undefined {
  const row = record(value);
  return row && typeof row.memory_id === "string" && typeof row.subject === "string" &&
      typeof row.statement === "string" && typeof row.revision === "number"
    ? row as unknown as MemoryRecord
    : undefined;
}

function refusal(status: number, body: unknown, action: string): MemoryError {
  const row = record(body) ?? {};
  const code = typeof row.error === "string" ? row.error : "unknown";
  const served = typeof row.message === "string" && row.message.length > 0 ? row.message.slice(0, 600) : null;
  const fallback = code === "memory_unavailable"
    ? "Workspace memory isn't turned on here."
    : status === 401
      ? "This agent credential wasn't accepted. Nothing changed."
      : status === 403
        ? `This credential can't ${action} here. Nothing changed.`
        : `The memory ${action} was refused (HTTP ${status}). Nothing changed.`;
  return new MemoryError(status, code, served ?? fallback, memoryOf(row.memory));
}

async function post(
  url: string,
  credential: string,
  anonKey: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { status: response.status, ok: response.ok, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * memory_save or memory_forget. A request that gets no answer is sent once more with the same
 * command id, which the server replays rather than applying twice.
 */
export async function sendMemoryCommand(
  target: CloudTarget,
  credential: string,
  workspaceId: string,
  command: { kind: "memory_save"; input: MemorySaveInput } | { kind: "memory_forget"; memory_id: string },
  fetcher: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<MemoryCommandResult> {
  const wire = command.kind === "memory_forget"
    ? { kind: "memory_forget", memory_id: command.memory_id.toLowerCase() }
    : {
      kind: "memory_save",
      memory_kind: command.input.kind,
      subject: command.input.subject,
      statement: command.input.statement,
      evidence: command.input.evidence.map((link) => memoryEvidenceHref(link) ?? link),
      ...(command.input.expected_revision === undefined ? {} : { expected_revision: command.input.expected_revision }),
    };
  const envelope = withClientBuild({
    command_id: newCommandId(),
    client_version: CLIENT_PROTOCOL_VERSION,
    workspace_id: workspaceId,
    stream: { kind: "workspace" },
    command: wire,
  });
  const action = command.kind === "memory_forget" ? "forget" : "save";
  let reply: Awaited<ReturnType<typeof post>> | null = null;
  for (let attempt = 0; attempt < 2 && reply === null; attempt += 1) {
    try {
      reply = await post(commandEndpoint(target), credential, target.anonKey, envelope, fetcher, timeoutMs);
    } catch {
      reply = null;
    }
  }
  if (reply === null) {
    throw new MemoryError(0, "no_response",
      `The memory ${action} got no answer, so its outcome is unknown. Run the same command again: a repeated save of the same statement changes nothing.`,
      undefined, true);
  }
  if (!reply.ok) throw refusal(reply.status, reply.body, action);
  const body = record(reply.body);
  const outcome = body?.memory_outcome;
  const memory = record(body?.memory);
  if (!body || !memory || typeof memory.memory_id !== "string" ||
      !(outcome === "created" || outcome === "updated" || outcome === "duplicate" || outcome === "forgotten")) {
    throw new MemoryError(reply.status, "malformed", `The memory ${action} came back in a shape this version doesn't understand.`);
  }
  return {
    untrusted_content: true,
    memory: memory as unknown as MemoryCommandResult["memory"],
    memory_outcome: outcome,
    ...(typeof body.previous_statement === "string" ? { previous_statement: body.previous_statement } : {}),
  };
}

export interface MemorySearchPage {
  workspace_id: string;
  untrusted_content: true;
  memories: Array<MemoryRecord & Record<string, unknown>>;
}

export interface MemoryDetail {
  workspace_id: string;
  untrusted_content: true;
  memory: MemoryRecord & Record<string, unknown>;
  versions: Array<Record<string, unknown>>;
}

async function read(
  target: CloudTarget,
  credential: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let reply: Awaited<ReturnType<typeof post>>;
  try {
    reply = await post(readEndpoint(target), credential, target.anonKey, body, fetcher, timeoutMs);
  } catch {
    throw new MemoryError(0, "no_response", "The memory read didn't complete. Nothing changed. Run the same command again.", undefined, true);
  }
  if (!reply.ok) throw refusal(reply.status, reply.body, "read");
  const parsed = record(reply.body);
  if (!parsed) throw new MemoryError(reply.status, "malformed", "The memory read came back in a shape this version doesn't understand.");
  return parsed;
}

export async function searchMemoriesAsAgent(
  target: CloudTarget,
  credential: string,
  workspaceId: string,
  request: { query?: string; limit?: number },
  fetcher: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<MemorySearchPage> {
  const body = await read(target, credential, {
    resource: "memory_search",
    workspace_id: workspaceId,
    ...(request.query === undefined || request.query.trim() === "" ? {} : { query: request.query.trim() }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
  }, fetcher, timeoutMs);
  if (!Array.isArray(body.memories)) {
    throw new MemoryError(200, "malformed", "The memory search came back in a shape this version doesn't understand.");
  }
  return { ...body, untrusted_content: true } as unknown as MemorySearchPage;
}

export async function getMemoryAsAgent(
  target: CloudTarget,
  credential: string,
  workspaceId: string,
  memoryId: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<MemoryDetail> {
  const body = await read(target, credential, {
    resource: "memory_get",
    workspace_id: workspaceId,
    memory_id: memoryId.toLowerCase(),
  }, fetcher, timeoutMs);
  if (!memoryOf(body.memory) || !Array.isArray(body.versions)) {
    throw new MemoryError(200, "malformed", "The memory came back in a shape this version doesn't understand.");
  }
  return { ...body, untrusted_content: true } as unknown as MemoryDetail;
}
