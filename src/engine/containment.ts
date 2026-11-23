// Limit: a descendant that leaves the process group (starts its own session)
// cannot be found by pgid, so containment proves the recorded process group is
// gone rather than every possible descendant.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RECORD_FILE = "harness.json";
const MAX_RECORD_BYTES = 4096, MAX_PID = 2_147_483_647, PS_MAX_BUFFER = 8 * 1024 * 1024;
const PS_ENV: NodeJS.ProcessEnv = { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" };
export type ContainmentErrorCode = "containment_unsupported" | "containment_failed" | "containment_unsafe";
export type ContainmentOutcome = "none" | "already_gone" | "killed" | "reused_pid_no_signal";
export interface HarnessRecord { readonly version: 1; readonly pid: number; readonly pgid: number; readonly startedAt: number; readonly recordedAt: number; }
export interface RecordHarnessOptions { readonly dir: string; readonly pid: number; readonly lookupTimeoutMs: number; }
export interface ClearHarnessRecordOptions { readonly dir: string; }
export interface ContainPreviousOptions { readonly dir: string; readonly graceMs: number; readonly lookupTimeoutMs: number; }
export interface ContainPreviousResult { readonly outcome: ContainmentOutcome; }
const ERROR_MESSAGES: Readonly<Record<ContainmentErrorCode, string>> = {
  containment_unsupported: "Harness containment is not supported on this platform",
  containment_failed: "Previous harness could not be verified or contained",
  containment_unsafe: "Harness containment location or options are unsafe",
};
export class ContainmentError extends Error {
  readonly code: ContainmentErrorCode;
  constructor(code: ContainmentErrorCode) { super(ERROR_MESSAGES[code]); this.name = "ContainmentError"; this.code = code; }
}
const errnoCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : undefined;
const isValidPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && pid <= MAX_PID;
const assertPlatform = (): void => { if (process.platform !== "darwin" && process.platform !== "linux") throw new ContainmentError("containment_unsupported"); };
const assertPositiveMs = (v: number): void => { if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new ContainmentError("containment_unsafe"); };
function fail(code: ContainmentErrorCode): never { throw new ContainmentError(code); }

async function openPrivateDir(dir: string): Promise<FileHandle> {
  if (typeof dir !== "string" || dir.length === 0 || dir.includes("\0") || !isAbsolute(dir)) fail("containment_unsafe");
  let handle: FileHandle;
  try { handle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)); }
  catch { fail("containment_unsafe"); }
  try {
    const st = await handle.stat();
    if (!st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) fail("containment_unsafe");
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    throw err instanceof ContainmentError ? err : new ContainmentError("containment_unsafe");
  }
}

async function runPs(args: readonly string[], lookupTimeoutMs: number): Promise<string> {
  const opts = { encoding: "utf8" as const, timeout: lookupTimeoutMs, maxBuffer: PS_MAX_BUFFER, env: PS_ENV };
  try { return (await execFileAsync("/bin/ps", [...args], opts)).stdout; } catch (err) {
    if (process.platform === "linux" && errnoCode(err) === "ENOENT") return (await execFileAsync("/usr/bin/ps", [...args], opts)).stdout;
    throw err;
  }
}

function probeTarget(target: number): "alive" | "esrch" | "eperm" {
  try { process.kill(target, 0); return "alive"; } catch (err) {
    const code = errnoCode(err);
    if (code === "ESRCH") return "esrch";
    if (code === "EPERM") return "eperm";
    fail("containment_failed");
  }
}
function signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try { process.kill(-pgid, signal); } catch (err) { if (errnoCode(err) !== "ESRCH") fail("containment_failed"); }
}
async function readPidStartTime(pid: number, lookupTimeoutMs: number): Promise<number | null> {
  let stdout: string;
  try { stdout = await runPs(["-o", "lstart=", "-p", String(pid)], lookupTimeoutMs); } catch (err) {
    const e = err as { code?: unknown; killed?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
    if (!e.killed && e.signal == null && e.code === 1 && String(e.stdout ?? "").trim() === "" && String(e.stderr ?? "").trim() === "") return null;
    fail("containment_failed");
  }
  const normalized = stdout.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return probeTarget(pid) === "esrch" ? null : fail("containment_failed");
  const parsed = Date.parse(`${normalized} UTC`);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fail("containment_failed");
}
async function listGroupMembers(pgid: number, lookupTimeoutMs: number): Promise<number[]> {
  let stdout: string;
  try { stdout = await runPs(["-ax", "-o", "pid=,pgid="], lookupTimeoutMs); } catch { fail("containment_failed"); }
  const members: number[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(line);
    if (!match) fail("containment_failed");
    if (Number(match[2]) === pgid) members.push(Number(match[1]));
  }
  return members;
}
async function isGroupEmpty(pgid: number, lookupTimeoutMs: number, onEperm: "fail" | "not_empty"): Promise<boolean> {
  const probe = probeTarget(-pgid);
  if (probe === "eperm") return onEperm === "fail" ? fail("containment_failed") : false;
  if (probe === "alive") return false;
  const members = await listGroupMembers(pgid, lookupTimeoutMs);
  const confirm = probeTarget(-pgid);
  if (confirm === "eperm") return onEperm === "fail" ? fail("containment_failed") : false;
  return members.length === 0 && confirm === "esrch";
}
async function waitForGroupEmpty(pgid: number, graceMs: number, lookupTimeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  const maxStep = Math.max(1, Math.floor(graceMs / 10));
  let step = Math.max(1, Math.floor(graceMs / 50));
  for (;;) {
    if (await isGroupEmpty(pgid, lookupTimeoutMs, "not_empty")) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const delayMs = Math.min(remaining, step);
    await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
    step = Math.min(maxStep, step * 2);
  }
}
async function killGroupAndProveEmpty(pgid: number, graceMs: number, lookupTimeoutMs: number): Promise<void> {
  signalGroup(pgid, "SIGTERM");
  if (await waitForGroupEmpty(pgid, graceMs, lookupTimeoutMs)) return;
  signalGroup(pgid, "SIGKILL");
  if (await waitForGroupEmpty(pgid, graceMs, lookupTimeoutMs)) return;
  fail("containment_failed");
}
function parseRecord(raw: string): HarnessRecord {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { fail("containment_failed"); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("containment_failed");
  const r = v as Record<string, unknown>;
  if (r.version !== 1 || !isValidPid(r.pid) || r.pgid !== r.pid ||
      typeof r.startedAt !== "number" || !Number.isSafeInteger(r.startedAt) || r.startedAt <= 0 ||
      typeof r.recordedAt !== "number" || !Number.isSafeInteger(r.recordedAt) || r.recordedAt <= 0) fail("containment_failed");
  return { version: 1, pid: r.pid, pgid: r.pgid, startedAt: r.startedAt, recordedAt: r.recordedAt };
}

async function readHarnessRecord(dir: string): Promise<HarnessRecord | null> {
  let fh: FileHandle;
  try { fh = await open(join(dir, RECORD_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    fail("containment_failed");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || (typeof process.getuid === "function" && st.uid !== process.getuid()) ||
        (st.mode & 0o077) !== 0 || st.size <= 0 || st.size > MAX_RECORD_BYTES) fail("containment_failed");
    return parseRecord(await fh.readFile("utf8"));
  } catch (err) {
    throw err instanceof ContainmentError ? err : new ContainmentError("containment_failed");
  } finally { await fh.close().catch(() => {}); }
}

async function removeHarnessRecord(dir: string): Promise<void> {
  try { await unlink(join(dir, RECORD_FILE)); } catch (err) { if (errnoCode(err) !== "ENOENT") fail("containment_failed"); }
}

export async function recordHarness(options: RecordHarnessOptions): Promise<HarnessRecord> {
  assertPlatform();
  if (!isValidPid(options.pid)) fail("containment_unsafe");
  assertPositiveMs(options.lookupTimeoutMs);
  const dirHandle = await openPrivateDir(options.dir);
  try {
    const recordPath = join(options.dir, RECORD_FILE);
    const existing = await lstat(recordPath).catch((err) => errnoCode(err) === "ENOENT" ? null : fail("containment_unsafe"));
    if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) fail("containment_unsafe");
    const startedAt = await readPidStartTime(options.pid, options.lookupTimeoutMs);
    if (startedAt === null) fail("containment_failed");
    const record: HarnessRecord = { version: 1, pid: options.pid, pgid: options.pid, startedAt, recordedAt: Date.now() };
    const tmpPath = join(options.dir, `.harness.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let fh: FileHandle | null = null;
    let renamed = false;
    try {
      fh = await open(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await fh.chmod(0o600);
      await fh.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await fh.sync();
      await fh.close();
      fh = null;
      await rename(tmpPath, recordPath);
      renamed = true;
      await dirHandle.sync().catch(() => {});
      return record;
    } catch {
      if (fh !== null) await fh.close().catch(() => {});
      if (!renamed) await unlink(tmpPath).catch(() => {});
      fail("containment_failed");
    }
  } finally { await dirHandle.close().catch(() => {}); }
}
export async function clearHarnessRecord(options: ClearHarnessRecordOptions): Promise<void> {
  assertPlatform();
  await (await openPrivateDir(options.dir)).close().catch(() => {});
  await removeHarnessRecord(options.dir);
}
export async function containPrevious(options: ContainPreviousOptions): Promise<ContainPreviousResult> {
  assertPlatform();
  assertPositiveMs(options.graceMs);
  assertPositiveMs(options.lookupTimeoutMs);
  await (await openPrivateDir(options.dir)).close().catch(() => {});
  const record = await readHarnessRecord(options.dir);
  if (record === null) return { outcome: "none" };
  const liveStart = await readPidStartTime(record.pid, options.lookupTimeoutMs);
  if (liveStart !== null) {
    if (liveStart !== record.startedAt) { await removeHarnessRecord(options.dir); return { outcome: "reused_pid_no_signal" }; }
    await killGroupAndProveEmpty(record.pgid, options.graceMs, options.lookupTimeoutMs);
    await removeHarnessRecord(options.dir);
    return { outcome: "killed" };
  }
  if (await isGroupEmpty(record.pgid, options.lookupTimeoutMs, "fail")) {
    await removeHarnessRecord(options.dir);
    return { outcome: "already_gone" };
  }
  if (probeTarget(record.pid) !== "esrch") {
    const recheck = await readPidStartTime(record.pid, options.lookupTimeoutMs);
    if (recheck !== null && recheck !== record.startedAt) { await removeHarnessRecord(options.dir); return { outcome: "reused_pid_no_signal" }; }
  }
  await killGroupAndProveEmpty(record.pgid, options.graceMs, options.lookupTimeoutMs);
  await removeHarnessRecord(options.dir);
  return { outcome: "killed" };
}
