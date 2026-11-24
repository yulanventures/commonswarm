import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type SeatLockErrorCode = "seat_locked" | "seat_lock_unsafe" | "seat_lock_unavailable" | "seat_lock_unsupported";

const ERROR_MESSAGES: Readonly<Record<SeatLockErrorCode, string>> = {
  seat_locked: "Seat lock is held by another runner",
  seat_lock_unsafe: "Seat lock location or identity is unsafe",
  seat_lock_unavailable: "Seat lock could not be acquired",
  seat_lock_unsupported: "Seat lock is not supported on this runtime",
};

export class SeatLockError extends Error {
  readonly code: SeatLockErrorCode;
  constructor(code: SeatLockErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SeatLockError";
    this.code = code;
  }
}

export interface SeatLockIdentity {
  readonly deployment: string;
  readonly workspaceId: string;
  readonly principalId: string;
}

export interface AcquireSeatLockOptions extends SeatLockIdentity {
  readonly root: string;
}

export interface SeatLockHandle {
  readonly key: string;
  release(): void;
}

type SqliteStmt = { get(): unknown };
type SqliteDb = { exec(sql: string): void; prepare(sql: string): SqliteStmt; close(): void };
type SqliteCtor = new (location: string, options?: { readonly timeout?: number }) => SqliteDb;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNSAFE_ERRNOS = new Set(["ELOOP", "EMLINK", "ENOTDIR", "EISDIR"]);
const activeLocks = new Set<string>();

const errnoCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;

const isSqliteLocked = (err: unknown): boolean => {
  const code = typeof err === "object" && err !== null ? (err as { errcode?: unknown }).errcode : null;
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6);
};

function readJournalMode(db: SqliteDb): string {
  const row = db.prepare("PRAGMA journal_mode").get();
  const mode = typeof row === "object" && row !== null ? (row as { journal_mode?: unknown }).journal_mode : null;
  if (typeof mode !== "string" || mode.length === 0) throw new SeatLockError("seat_lock_unavailable");
  return mode.toLowerCase();
}

const closeDb = (db: SqliteDb): void => {
  try { db.exec("ROLLBACK;"); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
};

export function seatLockKey({ deployment, workspaceId, principalId }: SeatLockIdentity): string {
  let url: URL;
  try { url = new URL(deployment); } catch { throw new SeatLockError("seat_lock_unsafe"); }
  const ws = typeof workspaceId === "string" ? workspaceId.toLowerCase() : "";
  const pr = typeof principalId === "string" ? principalId.toLowerCase() : "";
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null" || url.username || url.password || !UUID_RE.test(ws) || !UUID_RE.test(pr)) {
    throw new SeatLockError("seat_lock_unsafe");
  }
  const origin = url.origin.toLowerCase().replace(/\/+$/, "");
  return createHash("sha256").update(`seat-lock-v1\0${origin}\0${ws}\0${pr}`).digest("hex");
}

async function verifyNode(
  path: string,
  flags: number,
  mode: number | undefined,
  kind: "dir" | "file",
  fixMode: number | null,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, flags, mode);
  } catch (err) {
    const code = errnoCode(err);
    throw new SeatLockError(code && UNSAFE_ERRNOS.has(code) ? "seat_lock_unsafe" : "seat_lock_unavailable");
  }
  try {
    const st = await handle.stat();
    const okKind = kind === "dir" ? st.isDirectory() : st.isFile();
    if (!okKind || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
      throw new SeatLockError("seat_lock_unsafe");
    }
    const badMode = kind === "dir" ? (st.mode & 0o077) !== 0 : (st.mode & 0o777) !== 0o600;
    if (badMode) {
      if (fixMode !== null) await handle.chmod(fixMode);
      else throw new SeatLockError("seat_lock_unsafe");
    }
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDir(dirPath: string): Promise<void> {
  let created = false;
  try {
    const st = await lstat(dirPath);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SeatLockError("seat_lock_unsafe");
  } catch (err) {
    if (err instanceof SeatLockError) throw err;
    if (errnoCode(err) !== "ENOENT") throw new SeatLockError("seat_lock_unsafe");
    try { created = (await mkdir(dirPath, { recursive: true, mode: 0o700 })) !== undefined; }
    catch { throw new SeatLockError("seat_lock_unavailable"); }
  }
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  await verifyNode(dirPath, flags, undefined, "dir", created ? 0o700 : null);
}

async function ensureLockFile(filePath: string): Promise<void> {
  let existed = true;
  try {
    const st = await lstat(filePath);
    if (st.isSymbolicLink() || !st.isFile()) throw new SeatLockError("seat_lock_unsafe");
  } catch (err) {
    if (err instanceof SeatLockError) throw err;
    if (errnoCode(err) === "ENOENT") existed = false;
    else throw new SeatLockError("seat_lock_unavailable");
  }
  const flags = constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);
  await verifyNode(filePath, flags, 0o600, "file", existed ? null : 0o600);
}

export type SeatLockProbeState = "held" | "free" | "absent" | "unavailable";

export async function probeSeatLock(options: AcquireSeatLockOptions): Promise<SeatLockProbeState> {
  if (typeof options.root !== "string" || options.root.includes("\0") || !isAbsolute(options.root)) {
    throw new SeatLockError("seat_lock_unsafe");
  }
  const key = seatLockKey(options);
  const rootDir = resolve(options.root);
  const lockPath = join(rootDir, "locks", `${key}.lock`);
  if (activeLocks.has(lockPath)) return "held";

  let st;
  try {
    st = await lstat(lockPath);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    throw new SeatLockError(code && UNSAFE_ERRNOS.has(code) ? "seat_lock_unsafe" : "seat_lock_unavailable");
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new SeatLockError("seat_lock_unsafe");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new SeatLockError("seat_lock_unsafe");
  if ((st.mode & 0o777) !== 0o600) throw new SeatLockError("seat_lock_unsafe");

  let DatabaseSync: SqliteCtor;
  try {
    const mod = (await import("node:sqlite")) as { DatabaseSync?: unknown };
    if (typeof mod.DatabaseSync !== "function") throw new Error("missing");
    DatabaseSync = mod.DatabaseSync as SqliteCtor;
  } catch {
    return "unavailable";
  }

  let db: SqliteDb | null = null;
  try {
    db = new DatabaseSync(lockPath, { timeout: 0 });
    if (readJournalMode(db) !== "delete") return "unavailable";
    db.exec("BEGIN EXCLUSIVE;");
    return "free";
  } catch (err) {
    if (isSqliteLocked(err)) return "held";
    return "unavailable";
  } finally {
    if (db !== null) closeDb(db);
  }
}

export async function acquireSeatLock(options: AcquireSeatLockOptions): Promise<SeatLockHandle> {
  if (typeof options.root !== "string" || options.root.includes("\0") || !isAbsolute(options.root)) {
    throw new SeatLockError("seat_lock_unsafe");
  }
  const key = seatLockKey(options);
  const rootDir = resolve(options.root);
  const locksDir = join(rootDir, "locks");
  const lockPath = join(locksDir, `${key}.lock`);
  if (activeLocks.has(lockPath)) throw new SeatLockError("seat_locked");
  activeLocks.add(lockPath);

  let lockedDb: SqliteDb;
  try {
    let DatabaseSync: SqliteCtor;
    try {
      const mod = (await import("node:sqlite")) as { DatabaseSync?: unknown };
      if (typeof mod.DatabaseSync !== "function") throw new Error("missing");
      DatabaseSync = mod.DatabaseSync as SqliteCtor;
    } catch { throw new SeatLockError("seat_lock_unsupported"); }
    await ensurePrivateDir(rootDir);
    await ensurePrivateDir(locksDir);
    await ensureLockFile(lockPath);
    let db: SqliteDb | null = null;
    try {
      db = new DatabaseSync(lockPath, { timeout: 0 });
      if (readJournalMode(db) !== "delete") throw new SeatLockError("seat_lock_unavailable");
      db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
      if (readJournalMode(db) !== "delete") throw new SeatLockError("seat_lock_unavailable");
      lockedDb = db;
    } catch (err) {
      if (db !== null) closeDb(db);
      if (err instanceof SeatLockError) throw err;
      throw new SeatLockError(isSqliteLocked(err) ? "seat_locked" : "seat_lock_unavailable");
    }
  } catch (err) {
    activeLocks.delete(lockPath);
    throw err;
  }
  let released = false;
  return {
    key,
    release(): void {
      if (released) return;
      released = true;
      activeLocks.delete(lockPath);
      closeDb(lockedDb);
    },
  };
}
