import { constants as fsConstants, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CloudTarget } from "./config.js";

// Renamed from "io.ridge.coswarm" with the CommonSwarm rename. An install that predates
// the rename keeps its old keychain record; nothing reads it, so that install reports
// "not logged in" until `cswarm login` runs once. No migration is attempted on purpose.
const KEYCHAIN_SERVICE = "com.commonswarm.cli";
const LOCK_STALE_MS = 60_000;
/** Longer than a local owner-record write, including a paused process. */
export const HOST_ID_LOCK_INCOMPLETE_GRACE_MS = 2_000;
const LOCK_TIMEOUT_MS = 30_000;
const MAX_KEYCHAIN_RECORD_BYTES = 126;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_PENDING_COMMANDS = 32;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,72}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FALLBACK_WARNING =
  "⚠ no OS keychain found. Storing the rotating refresh credential in a 0600 file under a 0700 directory. This is less protected than a keychain.";

export interface CredentialRecord {
  version: 1;
  refreshToken: string;
  generation: number;
  deviceId: string;
  userId: string;
}

export interface PendingCommandRecord {
  commandId: string;
  kind: string;
  createdAt: number;
}

export interface CredentialProfile {
  version: 1;
  userId: string | null;
  workspaceId: string | null;
  email?: string | null;
  principalId?: string | null;
  principalName?: string | null;
  pendingCommands: Record<string, PendingCommandRecord>;
}

export interface PendingProfileStore {
  readProfile(): Promise<CredentialProfile>;
  writeProfile(profile: CredentialProfile): Promise<void>;
  withLock<T>(work: () => Promise<T>): Promise<T>;
}

export interface CredentialStore extends PendingProfileStore {
  readonly kind: "keychain" | "file";
  readonly location: string;
  read(): Promise<CredentialRecord | null>;
  write(record: CredentialRecord): Promise<void>;
  delete(): Promise<void>;
}

export interface CredentialStoreOptions {
  target: CloudTarget;
  stateDirectory?: string;
  forceFile?: boolean;
  allowFileFallback?: boolean;
  platform?: NodeJS.Platform;
  warn?: (message: string) => void;
  securityPath?: string;
}

/**
 * Local store rejected a JSON file that exceeded its byte ceiling.
 * Callers classify with `isStoredRecordOversized`, never with the message.
 */
export class StoredRecordOversizedError extends Error {
  readonly name = "StoredRecordOversizedError";

  constructor() {
    super("stored record is larger than this store accepts");
  }
}

/** D-053: identity only. A same-worded Error is not this failure. */
export function isStoredRecordOversized(error: unknown): boolean {
  return error instanceof StoredRecordOversizedError;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function defaultCredentialStateDirectory(): string {
  // Renamed from ~/.coswarm with the CommonSwarm rename; the old directory is not read.
  return join(homedir(), ".cswarm", "credentials.d");
}

function mode(statMode: number): number {
  return statMode & 0o777;
}

function assertOwnedByCurrentUser(uid: number): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error("credential path is not owned by the current user");
  }
}

async function existingSecureDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`credential directory is not a real directory: ${path}`);
    }
    assertOwnedByCurrentUser(info.uid);
    if (mode(info.mode) !== 0o700) {
      throw new Error(
        `credential directory must be mode 0700 (found ${mode(info.mode).toString(8)}): ${path}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return true;
}

async function secureDirectory(path: string): Promise<void> {
  if (await existingSecureDirectory(path)) return;
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`credential directory is not a real directory: ${path}`);
  }
  assertOwnedByCurrentUser(info.uid);
  if (mode(info.mode) !== 0o700) {
    throw new Error(`credential directory could not be secured to mode 0700: ${path}`);
  }
}

/** Verify or create an owned 0700 state directory for non-credential metadata. */
export async function ensureSecureStateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error("secure state directory must be absolute");
  }
  await secureDirectory(path);
}

async function secureCredentialFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`credential file is not a regular file: ${path}`);
  }
  assertOwnedByCurrentUser(info.uid);
  if (mode(info.mode) !== 0o600) {
    throw new Error(
      `credential file must be mode 0600 (found ${mode(info.mode).toString(8)}): ${path}`,
    );
  }
}

function parseRecord(raw: string): CredentialRecord {
  let value: Partial<CredentialRecord>;
  try {
    if (raw.startsWith("{")) {
      value = JSON.parse(raw) as Partial<CredentialRecord>;
    } else {
      const [version, refreshToken, generation, deviceId, userId, ...extra] =
        raw.split("|");
      if (extra.length > 0) throw new Error("extra compact credential fields");
      value = {
        version: Number(version) as 1,
        refreshToken,
        generation: Number(generation),
        deviceId,
        userId,
      };
    }
  } catch {
    throw new Error("stored credential record is malformed");
  }
  if (
    value.version !== 1 ||
    typeof value.refreshToken !== "string" ||
    value.refreshToken.length < 8 ||
    value.refreshToken.length > 2_048 ||
    /[|\u0000-\u001f\u007f]/.test(value.refreshToken) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation ?? -1) < 0 ||
    typeof value.deviceId !== "string" ||
    !UUID_RE.test(value.deviceId) ||
    typeof value.userId !== "string" ||
    !UUID_RE.test(value.userId)
  ) {
    throw new Error("stored credential record is malformed");
  }
  return value as CredentialRecord;
}

function keychainRecord(record: CredentialRecord): string {
  const validated = parseRecord(JSON.stringify(record));
  const compact = [
    validated.version,
    validated.refreshToken,
    validated.generation,
    validated.deviceId,
    validated.userId,
  ].join("|");
  if (Buffer.byteLength(compact, "utf8") > MAX_KEYCHAIN_RECORD_BYTES) {
    throw new Error(
      "refresh credential is too large for secure macOS Keychain CLI input",
    );
  }
  return compact;
}

function emptyProfile(): CredentialProfile {
  return {
    version: 1,
    userId: null,
    workspaceId: null,
    email: null,
    principalId: null,
    principalName: null,
    pendingCommands: {},
  };
}

function parseProfile(raw: string): CredentialProfile {
  let value: Partial<CredentialProfile>;
  try {
    value = JSON.parse(raw) as Partial<CredentialProfile>;
  } catch {
    throw new Error("stored credential profile is malformed");
  }
  const pending = value.pendingCommands;
  if (
    value.version !== 1 ||
    !(
      value.userId === null ||
      (typeof value.userId === "string" && UUID_RE.test(value.userId))
    ) ||
    !(
      value.workspaceId === null ||
      (typeof value.workspaceId === "string" && UUID_RE.test(value.workspaceId))
    ) ||
    !(
      value.email === undefined ||
      value.email === null ||
      (
        typeof value.email === "string" &&
        value.email.length >= 3 &&
        value.email.length <= 320 &&
        !/[\u0000-\u001f\u007f-\u009f]/.test(value.email)
      )
    ) ||
    !(
      value.principalId === undefined ||
      value.principalId === null ||
      (typeof value.principalId === "string" && UUID_RE.test(value.principalId))
    ) ||
    !(
      value.principalName === undefined ||
      value.principalName === null ||
      (
        typeof value.principalName === "string" &&
        value.principalName.length >= 1 &&
        value.principalName.length <= 80 &&
        /^[a-z0-9._@-]+$/.test(value.principalName)
      )
    ) ||
    !pending ||
    typeof pending !== "object" ||
    Array.isArray(pending) ||
    Object.keys(pending).length > MAX_PENDING_COMMANDS
  ) {
    throw new Error("stored credential profile is malformed");
  }
  for (const [intentHash, record] of Object.entries(pending)) {
    if (
      !SHA256_RE.test(intentHash) ||
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      typeof record.commandId !== "string" ||
      !COMMAND_ID_RE.test(record.commandId) ||
      typeof record.kind !== "string" ||
      record.kind.length < 1 ||
      record.kind.length > 64 ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt < 0
    ) {
      throw new Error("stored credential profile is malformed");
    }
  }
  return value as CredentialProfile;
}

/**
 * One writer per (state directory, name) across processes. Extracted from the credential
 * store because the agent successor record (§2.3 renewal) has to take the same lock: two
 * CLI invocations renewing the same lineage concurrently is exactly the read-rotate-write
 * race that once produced two live credentials.
 */
export class FileLockTimeoutError extends Error {
  readonly name = "FileLockTimeoutError";
  readonly code = "file_lock_timeout";

  constructor(readonly lockName: string, readonly lockPath?: string, readonly ownerPid?: number) {
    super(lockName === "host-id-rotation"
      ? `timed out waiting for the host-id rotation lock at ${lockPath} (owner pid ${ownerPid ?? "unknown"}). Wait for its owner to exit, then retry. If its owner is gone, remove ${lockPath} and retry.`
      : `timed out waiting for the credential refresh lock`);
  }
}

/** Locks this process holds right now: path -> unique owner record. */
const heldFileLocks = new Map<string, { createdAt: number; ownerId: string }>();
let heldFileLockExitHookInstalled = false;

/**
 * process.exit() skips every pending finally, so a hook's hard exit would leave its lock for LOCK_STALE_MS and the
 * next turns would spend their budget waiting. On exit, remove each lock this process still owns, checking the
 * recorded pid and createdAt so a lock another process took after ours is never removed.
 */
function releaseHeldFileLocksSync(): void {
  for (const [lockPath, { createdAt, ownerId }] of heldFileLocks) {
    try {
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; createdAt?: unknown; ownerId?: unknown };
      if (owner.pid === process.pid && owner.createdAt === createdAt && owner.ownerId === ownerId) unlinkSync(lockPath);
    } catch {
      // Missing or unreadable: nothing of ours to remove.
    }
  }
  heldFileLocks.clear();
}

/**
 * The lock's raw content when it names a pid that no longer exists on THIS host, else null. Unknown owners are not dead:
 * a record still being written, one without a host (written before this rule), or one from another host or container
 * (a pid there means nothing here) falls back to the mtime rule. A reused pid or EPERM reads as alive.
 */
async function deadLockOwnerRecord(lockPath: string): Promise<string | null> {
  let raw: string;
  let owner: { pid?: unknown; host?: unknown };
  try {
    raw = await readFile(lockPath, "utf8");
    owner = JSON.parse(raw) as { pid?: unknown; host?: unknown };
  } catch {
    return null;
  }
  if (owner.host !== hostname()) return null;
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid === process.pid) {
    return null;
  }
  try {
    process.kill(owner.pid, 0);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? raw : null;
  }
}

const THIS_PROCESS_START_MS = Date.now() - process.uptime() * 1_000;

/** A successful pid probe does not prove that the recorded process still owns the pid. */
export function pidStartMs(pid: number, runPs: typeof execFileSync = execFileSync): number | null {
  if (pid === process.pid) return THIS_PROCESS_START_MS;
  try {
    const text = runPs("/bin/ps", ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", timeout: 1_000, env: { ...process.env, LC_ALL: "C" } }).trim();
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}

/** Host-id locks copied from another machine or interrupted during creation cannot own this host. */
async function staleHostIdOwnerRecord(lockPath: string, ageMs: number): Promise<string | null> {
  const raw = await readFile(lockPath, "utf8").catch(() => null);
  if (raw === null) return null;
  let owner: { pid?: unknown; host?: unknown; createdAt?: unknown };
  try { owner = JSON.parse(raw) as typeof owner; }
  catch { return ageMs >= HOST_ID_LOCK_INCOMPLETE_GRACE_MS ? raw : null; }
  if (owner?.host !== undefined && owner.host !== hostname()) return raw;
  if (!owner || typeof owner.createdAt !== "number" ||
      !Number.isSafeInteger(owner.createdAt) || typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof (owner as { startTime?: unknown }).startTime !== "number") {
    return ageMs >= HOST_ID_LOCK_INCOMPLETE_GRACE_MS ? raw : null;
  }
  try {
    process.kill(owner.pid, 0);
    const start = pidStartMs(owner.pid);
    return start !== null && Math.abs(start - (owner as { startTime: number }).startTime) > 2_000 ? raw : null;
  }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? raw : null; }
}

async function cleanupDeadHostIdTemps(stateDirectory: string, lockName: string): Promise<void> {
  const prefix = `${lockName}.lock.`;
  for (const name of await readdir(stateDirectory)) {
    const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)\\.[0-9a-f]+\\.tmp$`).exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") await unlink(join(stateDirectory, name)).catch(() => undefined);
    }
  }
}

export async function withFileLock<T>(
  stateDirectory: string,
  lockName: string,
  work: () => Promise<T>,
  options: { timeoutMs?: number; stalePolicy?: "host-id"; publishLink?: typeof link;
    onBeforeStaleMove?: () => Promise<void> } = {},
): Promise<T> {
  await secureDirectory(stateDirectory);
  const lockPath = join(stateDirectory, `${lockName}.lock`);
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > LOCK_TIMEOUT_MS) {
    throw new Error("credential refresh lock timeout is invalid");
  }
  const deadline = Date.now() + timeoutMs;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  let createdAt = 0;
  const ownerId = randomBytes(8).toString("hex");
  while (handle === null) {
    try {
      createdAt = Date.now();
      if (options.stalePolicy === "host-id") {
        const tempPath = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
        const temp = await open(tempPath, "wx", 0o600);
        try {
          const record = JSON.stringify({ pid: process.pid, host: hostname(),
            createdAt, startTime: THIS_PROCESS_START_MS, ownerId });
          await temp.writeFile(record, "utf8");
          await temp.sync();
          try {
            await (options.publishLink ?? link)(tempPath, lockPath);
            handle = temp;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EEXIST" && await readFile(lockPath, "utf8").catch(() => null) === record) {
              handle = temp; // A retransmitted LINK published our complete record.
            } else if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(code ?? "")) {
              const final = await open(lockPath, "wx", 0o600);
              try {
                await final.writeFile(record, "utf8");
                await final.sync();
                handle = final;
              } catch (writeError) {
                await final.close();
                await unlink(lockPath).catch(() => undefined);
                throw writeError;
              }
            } else throw error;
          }
        } catch (error) {
          await temp.close();
          throw error;
        } finally { await unlink(tempPath).catch(() => undefined); }
        if (handle !== temp) await temp.close();
      } else {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), createdAt, ownerId }), "utf8");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockInfo = await stat(lockPath).catch(() => null);
      if (lockInfo && options.stalePolicy !== "host-id" && Date.now() - lockInfo.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      let deadRecord = lockInfo ? options.stalePolicy === "host-id"
        ? await staleHostIdOwnerRecord(lockPath, Date.now() - lockInfo.mtimeMs)
        : await deadLockOwnerRecord(lockPath) : null;
      if (deadRecord !== null) {
        // Serialize stale contenders, then move the stale inode out of the publication path.
        // Never unlink the publication path after deciding from an earlier read.
        const reclaimPath = `${lockPath}.reclaim`;
        const gateOwnerPath = join(reclaimPath, "owner.json");
        let gateCreated = false;
        try {
          await mkdir(reclaimPath, { mode: 0o700 });
          gateCreated = true;
          const ownerFile = await open(gateOwnerPath, "wx", 0o600);
          try {
            await ownerFile.writeFile(JSON.stringify({ pid: process.pid, host: hostname(),
              createdAt: Date.now(), startTime: THIS_PROCESS_START_MS, ownerId }));
            await ownerFile.sync();
          } finally { await ownerFile.close(); }
        }
        catch (gateError) {
          if ((gateError as NodeJS.ErrnoException).code !== "EEXIST") {
            if (gateCreated) {
              await unlink(gateOwnerPath).catch(() => undefined);
              await rmdir(reclaimPath).catch(() => undefined);
            }
            throw gateError;
          }
          const gateInfo = await stat(reclaimPath).catch(() => null);
          const gateOwner = await readFile(gateOwnerPath, "utf8").catch(() => null);
          let abandoned = false;
          if (gateOwner !== null) {
            try {
              const owner = JSON.parse(gateOwner) as { pid: number; host: string; startTime: number };
              if (owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
                try {
                  process.kill(owner.pid, 0);
                  const start = pidStartMs(owner.pid);
                  abandoned = start !== null && Math.abs(start - owner.startTime) > 2_000;
                } catch (error) { abandoned = (error as NodeJS.ErrnoException).code === "ESRCH"; }
              }
            } catch { /* Incomplete record gets a grace period. */ }
          } else if (gateInfo && Date.now() - gateInfo.mtimeMs >= HOST_ID_LOCK_INCOMPLETE_GRACE_MS) {
            abandoned = true;
          }
          if (abandoned) {
            const movedGate = `${reclaimPath}.${process.pid}.${randomBytes(8).toString("hex")}.stale`;
            await rename(reclaimPath, movedGate).catch(error => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
            await rm(movedGate, { recursive: true, force: true });
          }
          if (Date.now() >= deadline) throw new FileLockTimeoutError(lockName, reclaimPath);
          await delay(25);
          continue;
        }
        try {
          const freshInfo = await stat(lockPath).catch(() => null);
          const stillStale = freshInfo && (options.stalePolicy === "host-id"
            ? await staleHostIdOwnerRecord(lockPath, Date.now() - freshInfo.mtimeMs)
            : await deadLockOwnerRecord(lockPath));
          if (stillStale === deadRecord) {
            await options.onBeforeStaleMove?.();
            const moved = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.stale`;
            const movedOwner = await rename(lockPath, moved).then(() => true).catch(error => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              return false;
            });
            if (!movedOwner) continue;
            if (await readFile(moved, "utf8").catch(() => null) === deadRecord) {
              await unlink(moved).catch(() => undefined);
            } else {
              await link(moved, lockPath).catch(() => undefined);
              throw new Error("host-id lock owner changed during stale takeover");
            }
          }
        } finally {
          await unlink(gateOwnerPath).catch(() => undefined);
          await rmdir(reclaimPath).catch(() => undefined);
        }
        continue;
      }
      if (Date.now() >= deadline) {
        const owner = await readFile(lockPath, "utf8").then(raw => JSON.parse(raw) as { pid?: number }).catch(() => null);
        throw new FileLockTimeoutError(lockName, lockPath, owner?.pid);
      }
      await delay(25 + randomBytes(1)[0]! % 75);
    }
  }

  heldFileLocks.set(lockPath, { createdAt, ownerId });
  if (!heldFileLockExitHookInstalled) {
    heldFileLockExitHookInstalled = true;
    process.on("exit", releaseHeldFileLocksSync);
  }
  try {
    if (options.stalePolicy === "host-id") await cleanupDeadHostIdTemps(stateDirectory, lockName);
    return await work();
  } finally {
    heldFileLocks.delete(lockPath);
    await handle.close();
    // Remove only our own record: if another process took the path over (a stale rule fired while we ran), its lock stays.
    const current = await readFile(lockPath, "utf8").catch(() => null);
    const ours = current === null ? false : (() => {
      try {
        const owner = JSON.parse(current) as { pid?: unknown; createdAt?: unknown; ownerId?: unknown };
        return owner.pid === process.pid && owner.createdAt === createdAt && owner.ownerId === ownerId;
      } catch {
        return false;
      }
    })();
    if (ours) await unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Atomic 0600 replace. It guarantees no torn reader, not mutual exclusion — callers that
 * read-then-write must hold withFileLock around both halves.
 */
export async function writeSecureJsonFile(
  path: string,
  serialized: string,
): Promise<void> {
  await secureDirectory(dirname(path));
  try {
    await secureCredentialFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await chmod(path, 0o600);
  await secureCredentialFile(path);
}

/** Reads a 0600-verified JSON file, or null when it has never been written. */
export async function readSecureJsonFile(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  const directory = dirname(path);
  const info = await lstat(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (info === null) await secureDirectory(directory);
  else {
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`credential directory is not a real directory: ${directory}`);
    assertOwnedByCurrentUser(info.uid);
    if (mode(info.mode) !== 0o700) await chmod(directory, 0o700);
    await secureDirectory(directory);
  }
  try {
    await secureCredentialFile(path);
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      throw new StoredRecordOversizedError();
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Read an owned 0600 JSON file without creating its missing parent directory. */
export async function readSecureJsonFileIfPresent(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  if (!await existingSecureDirectory(dirname(path))) return null;
  try {
    await secureCredentialFile(path);
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      throw new StoredRecordOversizedError();
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Removes a secure JSON file, tolerating one that was never written. */
export async function deleteSecureJsonFile(path: string): Promise<void> {
  await secureDirectory(dirname(path));
  try {
    await secureCredentialFile(path);
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function run(
  executable: string,
  args: string[],
  input?: string,
  detached = false,
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(`${input}\n`);
    else child.stdin.end();
  });
}

async function securityAvailable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

abstract class LockedCredentialStore implements CredentialStore {
  abstract readonly kind: "keychain" | "file";
  abstract readonly location: string;
  abstract read(): Promise<CredentialRecord | null>;
  abstract write(record: CredentialRecord): Promise<void>;
  abstract delete(): Promise<void>;
  private readonly profilePath: string;

  constructor(
    protected readonly stateDirectory: string,
    private readonly lockName: string,
  ) {
    this.profilePath = join(stateDirectory, `${lockName}.profile.json`);
  }

  async readProfile(): Promise<CredentialProfile> {
    let raw: string | null;
    try {
      raw = await readSecureJsonFile(this.profilePath, MAX_PROFILE_BYTES);
    } catch (error) {
      if (isStoredRecordOversized(error)) {
        throw new Error("stored credential profile is malformed");
      }
      throw error;
    }
    return raw === null ? emptyProfile() : parseProfile(raw);
  }

  async writeProfile(profile: CredentialProfile): Promise<void> {
    const serialized = JSON.stringify(parseProfile(JSON.stringify(profile)));
    if (Buffer.byteLength(serialized, "utf8") > MAX_PROFILE_BYTES) {
      throw new Error("stored credential profile is too large");
    }
    await writeSecureJsonFile(this.profilePath, serialized);
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    return await withFileLock(this.stateDirectory, this.lockName, work);
  }
}

class MacKeychainStore extends LockedCredentialStore {
  readonly kind = "keychain" as const;
  readonly location = "macOS Keychain";
  private readonly account: string;

  constructor(
    stateDirectory: string,
    profileId: string,
    private readonly securityPath: string,
  ) {
    super(stateDirectory, profileId);
    this.account = `refresh:${profileId}`;
  }

  async read(): Promise<CredentialRecord | null> {
    const result = await run(this.securityPath, [
      "find-generic-password",
      "-a",
      this.account,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    if (result.code === 44) return null;
    if (result.code !== 0) {
      throw new Error("unable to read the refresh credential from macOS Keychain");
    }
    return parseRecord(result.stdout.trimEnd());
  }

  async write(record: CredentialRecord): Promise<void> {
    const serialized = keychainRecord(record);
    const result = await run(
      this.securityPath,
      [
        "add-generic-password",
        "-U",
        "-a",
        this.account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ],
      // macOS `security -w` prompts twice. A detached child has no controlling
      // TTY, so both prompts consume this pipe instead of exposing or blocking
      // on an interactive refresh-token prompt.
      `${serialized}\n${serialized}`,
      true,
    );
    if (result.code !== 0) {
      throw new Error("unable to write the refresh credential to macOS Keychain");
    }
  }

  async delete(): Promise<void> {
    const result = await run(this.securityPath, [
      "delete-generic-password",
      "-a",
      this.account,
      "-s",
      KEYCHAIN_SERVICE,
    ]);
    if (result.code !== 0 && result.code !== 44) {
      throw new Error("unable to delete the refresh credential from macOS Keychain");
    }
  }
}

class SecureFileStore extends LockedCredentialStore {
  readonly kind = "file" as const;
  readonly location: string;

  constructor(
    stateDirectory: string,
    profileId: string,
    private readonly warn: (message: string) => void,
  ) {
    super(stateDirectory, profileId);
    this.location = join(stateDirectory, `${profileId}.json`);
  }

  private warning(): void {
    this.warn(`${FALLBACK_WARNING} Path: ${this.location}`);
  }

  async read(): Promise<CredentialRecord | null> {
    this.warning();
    const raw = await readSecureJsonFile(this.location, MAX_PROFILE_BYTES);
    return raw === null ? null : parseRecord(raw);
  }

  async write(record: CredentialRecord): Promise<void> {
    this.warning();
    await writeSecureJsonFile(this.location, JSON.stringify(record));
  }

  async delete(): Promise<void> {
    this.warning();
    await deleteSecureJsonFile(this.location);
  }
}

export async function credentialStore(
  options: CredentialStoreOptions,
): Promise<CredentialStore> {
  const stateDirectory = options.stateDirectory ??
    defaultCredentialStateDirectory();
  const platform = options.platform ?? process.platform;
  const securityPath = options.securityPath ?? "/usr/bin/security";
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));

  if (
    !options.forceFile &&
    platform === "darwin" &&
    await securityAvailable(securityPath)
  ) {
    return new MacKeychainStore(
      stateDirectory,
      options.target.profileId,
      securityPath,
    );
  }

  const allowed = options.allowFileFallback ??
    process.env.SWARM_ALLOW_INSECURE_STORE !== "0";
  if (!allowed) {
    throw new Error(
      "no OS keychain is available and the secure-file fallback is disabled",
    );
  }
  if (platform === "win32") {
    throw new Error(
      "no supported OS keychain is available and file permissions cannot be verified on this platform",
    );
  }
  return new SecureFileStore(stateDirectory, options.target.profileId, warn);
}

export async function agentSignalPendingStore(options: {
  target: CloudTarget;
  principalId: string;
  stateDirectory?: string;
}): Promise<PendingProfileStore> {
  if (!UUID_RE.test(options.principalId)) {
    throw new Error("agent principal id must be a UUID");
  }
  const configured = options.stateDirectory ??
    process.env.SWARM_AGENT_STATE_DIR ??
    (process.env.XDG_STATE_HOME
      ? join(process.env.XDG_STATE_HOME, "cswarm", "agent-pending")
      : join(homedir(), ".cswarm", "agent-state"));
  if (!isAbsolute(configured)) {
    throw new Error("agent pending state directory must be an absolute path");
  }
  const store = new SecureFileStore(
    configured,
    `agent-${options.target.profileId}-${options.principalId.toLowerCase()}`,
    () => undefined,
  );
  await store.withLock(async () => {
    await store.readProfile();
  });
  return store;
}
