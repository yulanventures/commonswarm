/** Durable, non-secret resume state for an explicitly identified file put. */
import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { H0_REQUEST_ID_RE } from "../h0/verbs.js";
import { ensureSecureStateDirectory, readSecureJsonFileIfPresent, withFileLock, writeSecureJsonFile } from "./storage.js";
import { FILE_MAX_VERSION_BYTES, FileCommandRefused, FileTransportError, allowedExtensionList, contentTypeForName, fileVersionCommit, fileVersionCreate, onceRetried, putObject, sha256Hex, type FileVersionCommitResult } from "./files.js";
import type { CloudTarget } from "./config.js";

const NAMESPACE = "1c20a85c-ff0f-4c85-90a3-83d83cfda936";
const RECORD_LIFETIME_MS = 3 * 60 * 60 * 1000;
const MAX_RECORDS = 200;
const TERMINAL_COMMIT_CODES = new Set([
  "file_version_precondition_failed", "file_commit_conflict", "file_size_exceeds_declaration",
  "file_not_found", "file_version_cap", "command_id_conflict",
]);
export type PutOutcome = "committed" | "replayed";
export type ConflictCheck = "available" | "unavailable";
export class RequestIdConflict extends Error {
  override name = "RequestIdConflict";
  readonly code = "request_id_conflict";
  constructor() { super("This request id was already used for different file content or arguments."); }
}
export class FilePutPreflightError extends Error {
  override name = "FilePutPreflightError";
  constructor(readonly code: string, message: string) { super(message); }
}
export function exactPutStateDir(profilePath: string): string { return join(dirname(profilePath), "file-put-resume"); }
export function uuidV5(name: string): string {
  const bytes = Buffer.from(NAMESPACE.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(bytes).update(name).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export interface ExactPutInput {
  target: CloudTarget; workspaceId: string; principalId: string; credential: string;
  stateDir: string; requestId: string; name: string; bytes: Uint8Array;
  ifVersion?: number; fetcher?: typeof fetch; now?: () => number;
  onPhasePersisted?: (phase: Phase) => void;
}
type Phase = "prepared" | "created" | "putting" | "uploaded" | "committed" | "refused";
const PHASE_ORDER: Record<Phase, number> = { prepared: 0, created: 1, putting: 2, uploaded: 3, committed: 4, refused: 4 };
type TerminalRefusal = { status: number; code: string };
interface RecordFile {
  request_id: string; name: string; sha256: string; size: number; if_version: number | null;
  file_id: string; version_id: string; create_command_id: string; commit_command_id: string;
  phase: Phase; updated_at: number; result: FileVersionCommitResult | null; refusal?: TerminalRefusal;
}
export interface PreparedPut { input: ExactPutInput; record: RecordFile; path: string; existed: boolean; conflict_check: ConflictCheck; contentType: string }
export interface PutResult { result: FileVersionCommitResult; outcome: PutOutcome; conflict_check: ConflictCheck }

function recordPath(input: ExactPutInput): string {
  const key = `${input.workspaceId}\0${input.principalId}\0${input.requestId}`;
  return join(input.stateDir, `${createHash("sha256").update(key).digest("hex")}.json`);
}
async function prune(dir: string, now: number, preserve: string): Promise<void> {
  const names = (await readdir(dir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  const rows = await Promise.all(names.map(async name => {
    try {
      const raw = await readSecureJsonFileIfPresent(join(dir, name), 8192);
      const saved = raw === null ? null : JSON.parse(raw) as Partial<RecordFile>;
      if (raw !== null && (typeof saved?.updated_at !== "number" || !Number.isFinite(saved.updated_at))) throw new Error("invalid record");
      return { name, updated: saved?.updated_at ?? 0 };
    } catch {
      process.stderr.write(`cswarm: skipped unreadable file put resume record ${name}\n`);
      await unlink(join(dir, name)).catch(() => undefined);
      return null;
    }
  })).then(rows => rows.filter((row): row is { name: string; updated: number } => row !== null));
  rows.sort((a, b) => b.updated - a.updated);
  await Promise.all(rows.filter((row, index) => row.name !== preserve && (index >= MAX_RECORDS - 1 || now - row.updated > RECORD_LIFETIME_MS))
    .map(row => unlink(join(dir, row.name)).catch(() => undefined)));
}
/** Preflight and persist before the command edge or Storage is contacted. */
export async function prepareExactPut(input: ExactPutInput): Promise<PreparedPut> {
  if (!H0_REQUEST_ID_RE.test(input.requestId)) throw new FilePutPreflightError("request_id_invalid", "The request id is invalid.");
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > FILE_MAX_VERSION_BYTES) {
    throw new FilePutPreflightError("file_too_large", `The file must contain 1 to ${FILE_MAX_VERSION_BYTES} bytes.`);
  }
  const contentType = contentTypeForName(input.name);
  if (contentType === null) throw new FilePutPreflightError("file_type_refused", `The name needs an allowed extension: ${allowedExtensionList()}`);
  if (input.ifVersion !== undefined && (!Number.isSafeInteger(input.ifVersion) || input.ifVersion < 0)) {
    throw new FilePutPreflightError("if_version_invalid", "if_version must be a nonnegative integer.");
  }
  const sha256 = sha256Hex(input.bytes);
  const identity = [input.workspaceId, input.principalId, input.requestId, input.name.toLowerCase(), sha256].join("\0");
  const path = recordPath(input);
  await ensureSecureStateDirectory(input.stateDir);
  const now = (input.now ?? Date.now)();
  return await withFileLock(input.stateDir, "file-put-resume", async () => {
    await prune(input.stateDir, now, basename(path));
    const raw = await readSecureJsonFileIfPresent(path, 8192);
    const prior = raw === null ? null : JSON.parse(raw) as RecordFile;
    if (prior && (prior.request_id !== input.requestId || prior.name.toLowerCase() !== input.name.toLowerCase() || prior.sha256 !== sha256 ||
        prior.size !== input.bytes.byteLength || prior.if_version !== (input.ifVersion ?? null))) throw new RequestIdConflict();
    const record: RecordFile = prior ?? {
      request_id: input.requestId, name: input.name, sha256, size: input.bytes.byteLength,
      if_version: input.ifVersion ?? null, file_id: uuidV5(`${identity}\0file`),
      version_id: uuidV5(`${identity}\0version`), create_command_id: uuidV5(`${identity}\0create`),
      commit_command_id: uuidV5(`${identity}\0commit`), phase: "prepared", updated_at: now, result: null,
    };
    if (!prior) await writeSecureJsonFile(path, JSON.stringify(record));
    return { input, record, path, existed: prior !== null, conflict_check: prior ? "available" : "unavailable", contentType };
  });
}

async function phase(prepared: PreparedPut, value: Phase, result: FileVersionCommitResult | null = null): Promise<void> {
  if (PHASE_ORDER[value] < PHASE_ORDER[prepared.record.phase]) return;
  prepared.record.phase = value;
  prepared.record.updated_at = (prepared.input.now ?? Date.now)();
  prepared.record.result = result;
  await writeSecureJsonFile(prepared.path, JSON.stringify(prepared.record));
  prepared.input.onPhasePersisted?.(value);
}
export async function executeExactPut(prepared: PreparedPut): Promise<PutResult> {
  const { input, record } = prepared;
  if (record.phase === "committed" && record.result) return { result: record.result, outcome: "replayed", conflict_check: prepared.conflict_check };
  if (record.phase === "refused" && record.refusal) throw new FileCommandRefused(record.refusal.status, record.refusal.code, `The service refused this file put (${record.refusal.code}).`);
  const priorPut = record.phase === "putting" || record.phase === "uploaded";
  const send = { target: input.target, workspaceId: input.workspaceId, credential: input.credential, fetcher: input.fetcher };
  const created = await onceRetried(() => fileVersionCreate({ ...send, commandId: record.create_command_id }, {
    fileId: record.file_id, versionId: record.version_id, name: record.name,
    declaredSizeBytes: record.size, contentType: prepared.contentType,
    ...(record.if_version === null ? {} : { ifVersion: record.if_version }),
  }));
  await phase(prepared, "created");
  // Persist before sending: a killed process cannot know whether Storage wrote
  // the object. Only a later attempt may let a refused PUT reach the commit.
  await phase(prepared, "putting");
  let attempted = false;
  await onceRetried(async () => {
    const replayedPut = priorPut || attempted;
    attempted = true;
    try {
      return await putObject(input.target, created.upload_path, input.bytes, prepared.contentType, input.fetcher, true);
    } catch (error) {
      if (replayedPut && error instanceof FileTransportError) return "already_exists";
      throw error;
    }
  });
  await phase(prepared, "uploaded");
  let result: FileVersionCommitResult;
  try {
    result = await onceRetried(() => fileVersionCommit({ ...send, commandId: record.commit_command_id }, {
      fileId: created.file_id, versionId: created.version_id, sha256: record.sha256,
    }));
  } catch (error) {
    if (error instanceof FileCommandRefused && TERMINAL_COMMIT_CODES.has(error.code)) {
      record.refusal = { status: error.status, code: error.code };
      await phase(prepared, "refused");
    }
    throw error;
  }
  await phase(prepared, "committed", result);
  // Storage can prove bytes existed, not that commit happened before this call.
  // The command response has no replay marker, so only a saved commit may say replayed.
  return { result, outcome: "committed",
    conflict_check: prepared.conflict_check };
}
