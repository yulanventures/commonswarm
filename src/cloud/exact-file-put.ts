/** Durable, non-secret resume state for an explicitly identified file put. */
import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { H0_REQUEST_ID_RE } from "../h0/verbs.js";
import { ensureSecureStateDirectory, readSecureJsonFileIfPresent, withFileLock, writeSecureJsonFile } from "./storage.js";
import { FILE_MAX_VERSION_BYTES, FileTransportError, allowedExtensionList, contentTypeForName, fileVersionCommit, fileVersionCreate, onceRetried, putObject, sha256Hex, type FileVersionCommitResult } from "./files.js";
import type { CloudTarget } from "./config.js";

const NAMESPACE = "1c20a85c-ff0f-4c85-90a3-83d83cfda936";
const RECORD_LIFETIME_MS = 3 * 60 * 60 * 1000;
const MAX_RECORDS = 200;
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
}
type Phase = "prepared" | "created" | "putting" | "uploaded" | "committed";
interface RecordFile {
  request_id: string; name: string; sha256: string; size: number; if_version: number | null;
  file_id: string; version_id: string; create_command_id: string; commit_command_id: string;
  phase: Phase; updated_at: number; result: FileVersionCommitResult | null;
}
export interface PreparedPut { input: ExactPutInput; record: RecordFile; path: string; existed: boolean; conflict_check: ConflictCheck; contentType: string }
export interface PutResult { result: FileVersionCommitResult; outcome: PutOutcome; conflict_check: ConflictCheck }

function recordPath(input: ExactPutInput): string {
  const key = `${input.workspaceId}\0${input.principalId}\0${input.requestId}`;
  return join(input.stateDir, `${createHash("sha256").update(key).digest("hex")}.json`);
}
async function prune(dir: string, now: number): Promise<void> {
  const names = (await readdir(dir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  const rows = await Promise.all(names.map(async name => {
    const raw = await readSecureJsonFileIfPresent(join(dir, name), 8192);
    const saved = raw === null ? null : JSON.parse(raw) as Partial<RecordFile>;
    return { name, updated: typeof saved?.updated_at === "number" ? saved.updated_at : 0 };
  }));
  rows.sort((a, b) => b.updated - a.updated);
  await Promise.all(rows.filter((row, index) => index >= MAX_RECORDS - 1 || now - row.updated > RECORD_LIFETIME_MS)
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
    await prune(input.stateDir, now);
    const raw = await readSecureJsonFileIfPresent(path, 8192);
    const prior = raw === null ? null : JSON.parse(raw) as RecordFile;
    if (prior && (prior.request_id !== input.requestId || prior.name !== input.name || prior.sha256 !== sha256 ||
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
  prepared.record.phase = value;
  prepared.record.updated_at = (prepared.input.now ?? Date.now)();
  prepared.record.result = result;
  await writeSecureJsonFile(prepared.path, JSON.stringify(prepared.record));
}
export async function executeExactPut(prepared: PreparedPut): Promise<PutResult> {
  const { input, record } = prepared;
  if (record.phase === "committed" && record.result) return { result: record.result, outcome: "replayed", conflict_check: prepared.conflict_check };
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
  const put = await onceRetried(async () => {
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
  const result = await onceRetried(() => fileVersionCommit({ ...send, commandId: record.commit_command_id }, {
    fileId: created.file_id, versionId: created.version_id, sha256: record.sha256,
  }));
  await phase(prepared, "committed", result);
  return { result, outcome: prepared.existed || put === "already_exists" ? "replayed" : "committed",
    conflict_check: prepared.conflict_check };
}
