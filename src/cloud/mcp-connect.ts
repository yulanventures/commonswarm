import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { constants, lstatSync, rmdirSync, type Stats } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { AGENT_CREDENTIAL_MESSAGE_D088, AgentCredentialInputError } from "./agent-credential-input.js";
import { parseAgentCredentialInput } from "./agent-credential-input.js";
import { AgentSetupError, ONBOARDING_MAX_FILE_BYTES, assertPrivateLocation, privatePath, readAgentProfile, readProfileCredential, saveAgentProfile, type AgentProfile } from "./agent-profile.js";
import { deleteSecureJsonFile, ensureSecureStateDirectory, readSecureJsonFileIfPresent, withFileLock, writeSecureJsonFile, writeSecureJsonFileExclusive } from "./storage.js";
import { ONBOARDING_UUID, type AgentConnectionEnvelope } from "./agent-onboarding-contract.js";
import { type CloudTarget } from "./config.js";
import { quoteAgentArgument } from "./agent-onboarding-contract.js";
import { ThinCommandClient } from "./command-client.js";
import { H0_REGISTRATION_NAME_MAX } from "../h0/verbs.js";
import { REGISTER_NO_SEAT_THIS_ATTEMPT, REGISTER_EXISTING_SEAT_REFUSALS } from "./mcp-register-refusals.js";
import { CONNECT_PROFILE_FILES, reservedConnectProfileName, reservedConnectProfileNames } from "./connect-profile-files.js";

const JOIN_CODE = /^swm_join_[A-Za-z0-9_-]{43}$/;
const SEAT_TOKEN = /^swm_agt_[A-Za-z0-9_-]{43}$/;
export const MCP_REGISTER_TIMEOUT_MS = 10_000;
const OUTCOME_UNKNOWN = "The register outcome is unknown. Run the same cswarm mcp connect command again with the same code. If recovery fails, ask the operator to inspect this attempt before starting another connect.";
const PENDING_FILE = CONNECT_PROFILE_FILES.pending;
const COMPLETE_FILE = CONNECT_PROFILE_FILES.complete;

interface PendingConnect { attemptId: string; url: string; name: string; codeHash: string; createdAt: string }
interface CompleteConnect { attemptId: string; url: string; codeHash: string; workspace_id?: string; anon_key?: string; principal_id?: string; run_id?: string }

function parseComplete(raw: string): CompleteConnect | null {
  let value: Record<string, unknown> | null;
  try { value = record(JSON.parse(raw)); } catch { return null; }
  if (!value || typeof value.attemptId !== "string" || !ONBOARDING_UUID.test(value.attemptId) ||
      typeof value.url !== "string" || typeof value.codeHash !== "string" || !/^[0-9a-f]{64}$/.test(value.codeHash) ||
      (value.workspace_id !== undefined && (typeof value.workspace_id !== "string" || !ONBOARDING_UUID.test(value.workspace_id))) ||
      (value.principal_id !== undefined && (typeof value.principal_id !== "string" || !ONBOARDING_UUID.test(value.principal_id))) ||
      (value.run_id !== undefined && (typeof value.run_id !== "string" || !ONBOARDING_UUID.test(value.run_id))) ||
      (value.anon_key !== undefined && typeof value.anon_key !== "string")) return null;
  return value as unknown as CompleteConnect;
}

async function readComplete(path: string, strict = false, inspect: (path: string) => Promise<Stats> = lstat): Promise<CompleteConnect | null> {
  const file = completePath(path);
  if (strict) {
    const info = await inspect(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()))) {
      throw new McpConnectError("connect_complete_unsafe", `The completed connect record at ${file} is unsafe. Inspect that file before retrying.`);
    }
  }
  let raw: string | null;
  try { raw = await readSecureJsonFileIfPresent(file, 4096); }
  catch {
    const info = await lstat(file).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink() && (typeof process.getuid !== "function" || info.uid === process.getuid()) && (info.mode & 0o777) !== 0o600) {
      throw new McpConnectError("connect_complete_mode", `The completed connect record at ${file} needs mode 0600. Run chmod 600 ${quoteAgentArgument(file)}, then rerun the same command.`);
    }
    if (strict && info && (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()))) {
      throw new McpConnectError("connect_complete_unsafe", `The completed connect record at ${file} is unsafe. Inspect that file before retrying.`);
    }
    if (strict) throw new McpConnectError("connect_complete_unsafe", `The completed connect record at ${file} cannot be written safely. Inspect that file before retrying.`);
    process.stderr.write(`Warning: completed connect record at ${file} cannot be read safely; continuing.\n`);
    return null;
  }
  if (raw === null) return null;
  const complete = parseComplete(raw);
  if (!complete) process.stderr.write(`Warning: completed connect record at ${file} is damaged; continuing.\n`);
  return complete;
}

async function checkedOrphan(path: string): Promise<{ principalId: string; raw: string } | null> {
  const file = join(dirname(path), CONNECT_PROFILE_FILES.credential);
  const info = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) !== 0o600) {
    throw new McpConnectError("connect_credential_mode", `The credential at ${file} needs mode 0600. Run chmod 600 ${quoteAgentArgument(file)}, then rerun the same command.`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > ONBOARDING_MAX_FILE_BYTES) {
    throw new McpConnectError("profile_conflict", `The credential at ${file} is not a bounded regular file. Inspect the connection before retrying.`);
  }
  // A killed wx fallback can leave its zero-length exclusive claim. A pending
  // same-code attempt owns the retry; no credential bytes exist to preserve.
  if (info.size === 0) {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new McpConnectError("profile_conflict", `The credential at ${file} is not owned by the current user. Inspect the connection before retrying.`);
    }
    return null;
  }
  let raw: string | null;
  try { raw = await readSecureJsonFileIfPresent(file, ONBOARDING_MAX_FILE_BYTES); }
  catch { throw new McpConnectError("profile_conflict", `The credential at ${file} cannot be read safely. Inspect the connection before retrying.`); }
  if (raw === null) throw new McpConnectError("profile_conflict", `The credential at ${file} disappeared. Run the same command again.`);
  try {
    const parsed = parseAgentCredentialInput(raw, { kind: "file", path: file });
    if (!parsed.durable || !parsed.principalId) throw new Error("missing principal");
    return { principalId: parsed.principalId, raw };
  } catch (error) {
    if (error instanceof AgentCredentialInputError && error.code === "agent_credential_invalid_json") {
      throw new McpConnectError("connect_credential_damaged", damagedCredentialMessage(file));
    }
    throw new McpConnectError("profile_conflict", `The credential at ${file} has no valid principal. Inspect the connection before retrying.`);
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function removeStaleConnectTemps(path: string): Promise<void> {
  const dir = dirname(path);
  for (const entry of await readdir(dir)) {
    const bases = [...CONNECT_PROFILE_FILES.temporaryBases, basename(path)];
    const match = new RegExp(`^(${bases.map(base => base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.(\\d+)\\.[0-9a-f]{12}\\.tmp$`).exec(entry);
    if (!match || processIsAlive(Number(match[2]))) continue;
    const file = join(dir, entry);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new McpConnectError("profile_conflict", `Unsafe temporary file at ${file}. Inspect it before retrying.`);
    }
    await unlink(file);
  }
}

async function cleanConnectTemps(path: string): Promise<void> {
  await withFileLock(dirname(path), CONNECT_PROFILE_FILES.setupLock.slice(0, -5), async () => removeStaleConnectTemps(path));
}

function codeHash(code: string, attemptId: string): string {
  return createHmac("sha256", attemptId).update(code).digest("hex");
}

function sameCode(code: string, pending: PendingConnect): boolean {
  return timingSafeEqual(Buffer.from(codeHash(code, pending.attemptId), "hex"), Buffer.from(pending.codeHash, "hex"));
}

function pendingPath(profilePath: string): string { return join(dirname(profilePath), PENDING_FILE); }
function completePath(profilePath: string): string { return join(dirname(profilePath), COMPLETE_FILE); }
function clearCommand(profilePath: string): string { return `cswarm mcp connect --clear-pending --profile ${quoteAgentArgument(profilePath)}`; }
function damagedProfileMessage(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `The profile file at ${path} is damaged. Run mv ${quoteAgentArgument(path)} ${quoteAgentArgument(`${path}.damaged-${stamp}`)}, then run the same command again.`;
}

function damagedCredentialMessage(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `The credential file at ${path} is damaged. Run mv ${quoteAgentArgument(path)} ${quoteAgentArgument(`${path}.damaged-${stamp}`)}, then run the same command again.`;
}

function isPermissionError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM";
}

async function wrongModeAncestor(path: string, inspect: (path: string) => Promise<Stats> = lstat, ownerUid = typeof process.getuid === "function" ? process.getuid() : undefined): Promise<string | null> {
  for (let dir = path; ; dir = dirname(dir)) {
    const info = await inspect(dir).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink() &&
        (ownerUid === undefined || info.uid === ownerUid) && (info.mode & 0o700) !== 0o700) return dir;
    if (dirname(dir) === dir) break;
  }
  return null;
}

async function unownedAncestor(path: string, inspect: (path: string) => Promise<Stats> = lstat, ownerUid = typeof process.getuid === "function" ? process.getuid() : undefined,
  probeTraversal: (path: string) => Promise<void> = dir => access(dir, constants.X_OK)): Promise<string | null> {
  for (let dir = path; ; dir = dirname(dir)) {
    const info = await inspect(dir).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink() && ownerUid !== undefined && info.uid !== ownerUid) {
      const denied = await probeTraversal(dir).then(() => false, isPermissionError);
      if (denied) return dir;
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

export async function classifyDirectoryFailure(path: string, error: unknown, inspect: (path: string) => Promise<Stats> = lstat,
  ownerUid = typeof process.getuid === "function" ? process.getuid() : undefined,
  probeTraversal: (path: string) => Promise<void> = dir => access(dir, constants.X_OK)): Promise<never> {
  if (isPermissionError(error)) {
    const wrong = await wrongModeAncestor(path, inspect, ownerUid);
    if (wrong) throw directoryModeError(wrong);
    const unowned = await unownedAncestor(path, inspect, ownerUid, probeTraversal);
    if (unowned) throw new McpConnectError("connect_directory_unowned", `The directory at ${unowned} is not owned by the current user. Ask its owner to repair access, then rerun the same command.`);
  }
  if (isPermissionError(error)) throw new McpConnectError("connect_state_unavailable", `The connect directory at ${path} cannot be used safely. Inspect its access and rerun the same command.`);
  throw error;
}

function directoryModeError(dir: string): McpConnectError {
  return new McpConnectError("connect_directory_mode", `The connect directory at ${dir} needs mode 0700. Run chmod 700 ${quoteAgentArgument(dir)}, then rerun the same command.`);
}

async function privateConnectLocation(path: string): Promise<string> {
  try { return await assertPrivateLocation(path); }
  catch (error) {
    if (!isPermissionError(error)) throw error;
    let wrongAncestor: string | null = null;
    try { wrongAncestor = await wrongModeAncestor(dirname(privatePath(path))); } catch { /* Keep the original path refusal. */ }
    if (wrongAncestor) throw directoryModeError(wrongAncestor);
    return await classifyDirectoryFailure(dirname(privatePath(path)), error);
  }
}

async function readPending(profilePath: string): Promise<PendingConnect | null> {
  let raw: string | null;
  try { raw = await readSecureJsonFileIfPresent(pendingPath(profilePath), 4096); }
  catch {
    const info = await lstat(pendingPath(profilePath)).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink() && (typeof process.getuid !== "function" || info.uid === process.getuid()) && (info.mode & 0o777) !== 0o600) {
      throw new McpConnectError("connect_pending_mode", `The connect record at ${pendingPath(profilePath)} needs mode 0600. Run chmod 600 ${quoteAgentArgument(pendingPath(profilePath))}, then rerun the same command.`);
    }
    throw new McpConnectError("connect_pending_unreadable", `The connect record at ${pendingPath(profilePath)} cannot be read safely. Inspect it and ask the operator to check the attempt before clearing it with ${clearCommand(profilePath)}.`);
  }
  if (raw === null) return null;
  const value = parsePending(raw);
  if (!value) {
    throw new McpConnectError("connect_pending_invalid", `The connect record at ${pendingPath(profilePath)} is damaged. Inspect it and ask the operator to check the attempt before clearing it with ${clearCommand(profilePath)}.`);
  }
  return value;
}

function parsePending(raw: string): PendingConnect | null {
  let value: Record<string, unknown> | null;
  try { value = record(JSON.parse(raw)); } catch { value = null; }
  if (!value || Object.keys(value).sort().join() !== ["attemptId", "url", "name", "codeHash", "createdAt"].sort().join() ||
      typeof value.attemptId !== "string" || !ONBOARDING_UUID.test(value.attemptId) ||
      typeof value.url !== "string" || typeof value.name !== "string" ||
      typeof value.codeHash !== "string" || !/^[0-9a-f]{64}$/.test(value.codeHash) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    return null;
  }
  return value as unknown as PendingConnect;
}

export class McpConnectError extends AgentSetupError {
  constructor(code: string, message: string) { super(code, message); }
}

export async function mintMcpCode(target: CloudTarget, accessToken: string, workspaceId: string, fetcher: typeof fetch = fetch): Promise<{ code: string; expires_at: string }> {
  const result = await new ThinCommandClient(target, fetcher).sendConnect({
    credential: accessToken, workspaceId,
    command: { kind: "mint_agent_join_credential", seat_cap: 1, ttl_hours: 1 },
  });
  const body = result.response;
  if (body.status !== "accepted" || typeof body.join_credential !== "string" ||
      !JOIN_CODE.test(body.join_credential) || typeof body.expires_at !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(body.expires_at) ||
      Number.isNaN(Date.parse(body.expires_at))) {
    throw new McpConnectError("mcp_code_mint_failed", "The code was not issued. Try again from your signed-in terminal.");
  }
  return { code: body.join_credential, expires_at: body.expires_at };
}

export function renderMcpCode(result: { code: string; expires_at: string }, target: CloudTarget): string {
  return `Connect code (shown once): ${result.code}\nExpires: ${result.expires_at}\nOn the agent host run: cswarm mcp connect --url ${target.url} --anon-key ${target.anonKey}\nGive the code to the person at the agent host.\n`;
}

function terminalEcho(on: boolean): void {
  const result = spawnSync("stty", [on ? "echo" : "-echo"], { stdio: ["inherit", "ignore", "ignore"], timeout: 2_000 });
  if (result.status !== 0) throw new McpConnectError("terminal_unavailable", "A terminal with hidden input is required.");
}

export interface HiddenTerminal {
  isTTY: boolean;
  input: NodeJS.ReadableStream;
  echo(on: boolean): void;
  write(value: string): void;
  signals: { on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown; off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown };
  exit(code: number): void;
}

/** A plain pipe or redirect is refused. A same-user pseudo-terminal wrapper is not detected. */
export async function readHiddenJoinCode(terminal: HiddenTerminal = {
  isTTY: Boolean(process.stdin.isTTY), input: process.stdin, echo: terminalEcho,
  write: value => process.stderr.write(value), signals: process, exit: code => process.exit(code),
}, cleanupOnSignal?: () => void): Promise<string> {
  if (!terminal.isTTY) throw new McpConnectError("terminal_required", "Run mcp connect in a terminal to enter the code privately. A plain pipe or redirect is refused; a pseudo-terminal wrapper is not detected.");
  terminal.echo(false);
  let restored = false;
  const restore = () => { if (!restored) { terminal.echo(true); restored = true; } };
  const removeSignals = () => {
    terminal.signals.off("SIGINT", onInterrupt);
    terminal.signals.off("SIGTERM", onTerminate);
  };
  const interrupted = (status: number) => {
    try { restore(); }
    finally {
      removeSignals();
      try { cleanupOnSignal?.(); } catch { /* Cleanup cannot replace the exit. */ }
      terminal.exit(status);
    }
  };
  function onInterrupt() { interrupted(130); }
  function onTerminate() { interrupted(143); }
  terminal.signals.on("SIGINT", onInterrupt);
  terminal.signals.on("SIGTERM", onTerminate);
  try {
    terminal.write("Connect code: ");
    const input = createInterface({ input: terminal.input, terminal: false });
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        input.once("line", line => { settled = true; line.trim() ? resolve(line) : reject(new McpConnectError("code_missing", "No code was entered. Run mcp connect again.")); });
        input.once("close", () => { if (!settled) reject(new McpConnectError("code_missing", "No code was entered. Run mcp connect again.")); });
      });
    } finally { input.close(); }
  } finally {
    removeSignals();
    restore();
    terminal.write("\n");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export interface McpConnectOptions {
  target: CloudTarget;
  profilePath?: string;
  name?: string;
  readCode?: () => Promise<string>;
  fetcher?: typeof fetch;
  saveProfile?: typeof saveAgentProfile;
  writeCompletion?: typeof writeSecureJsonFile;
  inspectCompletion?: (path: string) => Promise<Stats>;
  checkProfileAccess?: typeof access;
  terminal?: HiddenTerminal;
  removeEmptyDirectory?: typeof rmdir;
}

/** Clear local connect records. A credential may be the only copy of a live seat. */
export async function clearMcpConnect(profilePath: string, removeFile: typeof unlink = unlink): Promise<{ completedProfile: string | null; credentialPresent: boolean; emptyClaimPresent: boolean; profilePresent: boolean; removed: "pending record" | "completion record" | "pending record and completion record" | "nothing" }> {
  const path = await privateConnectLocation(profilePath);
  const dir = dirname(path);
  if (!await pathExists(dir)) return { completedProfile: null, credentialPresent: false, emptyClaimPresent: false, profilePresent: false, removed: "nothing" };
  try { await ensureSecureStateDirectory(dir); }
  catch {
    const info = await lstat(dir).catch(() => null);
    if (info?.isDirectory() && (typeof process.getuid !== "function" || info.uid === process.getuid()) && (info.mode & 0o777) !== 0o700) {
      throw new McpConnectError("connect_directory_mode", `The connect directory at ${dir} needs mode 0700. Run chmod 700 ${quoteAgentArgument(dir)}, then run ${clearCommand(path)}.`);
    }
    throw new McpConnectError("connect_clear_unsafe", `The connect directory at ${dir} cannot be read safely.`);
  }
  return await withFileLock(dir, CONNECT_PROFILE_FILES.connectLock.slice(0, -5), async () => {
    const hadPending = await pathExists(pendingPath(path));
    const hadComplete = await pathExists(completePath(path));
    if (!hadPending && !hadComplete) return { completedProfile: null, credentialPresent: await pathExists(join(dir, CONNECT_PROFILE_FILES.credential)), emptyClaimPresent: await emptyClaimAt(join(dir, CONNECT_PROFILE_FILES.credential)), profilePresent: await pathExists(path), removed: "nothing" as const };
    await cleanConnectTemps(path);
    const credential = join(dir, CONNECT_PROFILE_FILES.credential);
    let completedProfile: string | null = null;
    for (const entry of await readdir(dir)) {
      if (reservedConnectProfileName(entry)) continue;
      const candidate = join(dir, entry);
      try {
        if (candidate === path) {
          const info = await lstat(candidate);
          if (info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) !== 0o600) {
            throw new McpConnectError("connect_profile_mode", `The profile at ${candidate} needs mode 0600. Run chmod 600 ${quoteAgentArgument(candidate)}, then rerun the same command.`);
          }
        }
        const raw = await readSecureJsonFileIfPresent(candidate, ONBOARDING_MAX_FILE_BYTES);
        if (raw === null) continue;
        const hostSessionId = record(JSON.parse(raw))?.host_session_id;
        const profile = await readAgentProfile(candidate, typeof hostSessionId === "string" ? hostSessionId : undefined);
        if (profile.credential_file === credential) {
          const credentialInfo = await lstat(credential).catch(() => null);
          if (credentialInfo?.isFile() && !credentialInfo.isSymbolicLink() && (credentialInfo.mode & 0o777) !== 0o600) {
            throw new McpConnectError("connect_credential_mode", `The credential at ${credential} needs mode 0600. Run chmod 600 ${quoteAgentArgument(credential)}, then rerun the same command.`);
          }
          await readProfileCredential(profile);
          completedProfile = candidate;
        }
      } catch (error) {
        if (error instanceof McpConnectError) throw error;
        // A damaged or unrelated file is not a complete profile.
      }
    }
    let removedPending = false;
    let removedComplete = false;
    for (const file of [pendingPath(path), completePath(path)]) {
      try {
        const info = await lstat(file);
        if ((typeof process.getuid === "function" && info.uid !== process.getuid()) || (!info.isFile() && !info.isSymbolicLink())) {
          throw new McpConnectError("connect_clear_unsafe", `Cannot clear unsafe file at ${file}.`);
        }
        await removeFile(file);
        if (file === pendingPath(path)) removedPending = true;
        else removedComplete = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (hadPending ? !removedPending : !removedComplete) throw new McpConnectError("connect_pending_missing", `There is no interrupted connect record to clear at ${pendingPath(path)}.`);
    return { completedProfile, credentialPresent: await pathExists(credential), emptyClaimPresent: await emptyClaimAt(credential), profilePresent: await pathExists(path),
      removed: removedPending && removedComplete ? "pending record and completion record" : removedPending ? "pending record" : "completion record" };
  });
}

async function emptyClaimAt(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return info !== null && info.isFile() && !info.isSymbolicLink() && info.size === 0;
}

async function defaultPendingProfile(target: CloudTarget, code: string): Promise<string | null> {
  const base = join(homedir(), ".cswarm", "agents");
  let entries: string[];
  try { entries = await readdir(base); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (["ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      const wrongAncestor = isPermissionError(error) ? await wrongModeAncestor(base) : null;
      if (wrongAncestor) throw directoryModeError(wrongAncestor);
      if (isPermissionError(error)) await classifyDirectoryFailure(base, error);
      const info = await lstat(base).catch(() => null);
      if (info?.isDirectory() && !info.isSymbolicLink() && (typeof process.getuid !== "function" || info.uid === process.getuid()) && (info.mode & 0o777) !== 0o700) {
        throw new McpConnectError("connect_directory_mode", `The default connect directory at ${base} needs mode 0700. Run chmod 700 ${quoteAgentArgument(base)}, then rerun the same command.`);
      }
      throw new McpConnectError("connect_state_unavailable", `The default connect directory at ${base} cannot be read. Inspect its access and rerun the same command.`);
    }
    throw error;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!/^mcp-[0-9a-f-]{36}$/.test(entry)) continue;
    const path = join(base, entry, "profile.json");
    try {
      await ensureSecureStateDirectory(dirname(path));
      const complete = await readComplete(path);
      if (complete?.url === target.url && complete.codeHash === codeHash(code, complete.attemptId)) {
        if (await pathExists(path) && !await completedProfileAt(path) &&
            !(await repairableProfileAt(path) && await emptyClaimAt(path))) {
          throw new McpConnectError("connect_profile_damaged", damagedProfileMessage(path));
        }
        matches.push(path);
      }
      const pending = await readPending(path);
      if (pending?.url === target.url && sameCode(code, pending) && !matches.includes(path)) matches.push(path);
      if (!pending) {
        const profileInfo = await lstat(path).catch(() => null);
        if (profileInfo?.isFile() && !profileInfo.isSymbolicLink() && (profileInfo.mode & 0o777) !== 0o600) {
          throw new McpConnectError("connect_profile_mode", `The profile at ${path} needs mode 0600. Run chmod 600 ${quoteAgentArgument(path)}, then rerun the same command.`);
        }
        const credential = join(dirname(path), CONNECT_PROFILE_FILES.credential);
        const credentialInfo = await lstat(credential).catch(() => null);
        if (credentialInfo?.isFile() && !credentialInfo.isSymbolicLink() && (credentialInfo.mode & 0o777) !== 0o600) {
          throw new McpConnectError("connect_credential_mode", `The credential at ${credential} needs mode 0600. Run chmod 600 ${quoteAgentArgument(credential)}, then rerun the same command.`);
        }
      }
    } catch (error) {
      if (error instanceof McpConnectError && (error.code === "connect_profile_mode" || error.code === "connect_credential_mode" || error.code === "connect_profile_damaged" || error.code === "connect_complete_mode")) throw error;
      // A mode error does not hide owned, readable content. Inspect it without trusting
      // that mode for a retry; the user must repair the mode before the same attempt runs.
      let raw: string | null = null;
      let fileMode: number | null = null;
      let directoryMode: number | null = null;
      try {
        const dirInfo = await lstat(dirname(path));
        if (!dirInfo.isDirectory() && !dirInfo.isSymbolicLink()) continue;
        if (dirInfo.isSymbolicLink()) throw new Error("linked directory");
        if (typeof process.getuid === "function" && dirInfo.uid !== process.getuid()) throw new Error("unowned directory");
        directoryMode = dirInfo.mode & 0o777;
        if ((directoryMode & 0o100) === 0) {
          throw new McpConnectError("connect_directory_mode", `The connect directory at ${dirname(path)} needs mode 0700. Run chmod 700 ${quoteAgentArgument(dirname(path))}, then rerun the same command.`);
        }
        const fileInfo = await lstat(pendingPath(path));
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("unsafe pending file");
        if (typeof process.getuid === "function" && fileInfo.uid !== process.getuid()) throw new Error("unowned pending file");
        fileMode = fileInfo.mode & 0o777;
        if (fileInfo.size > 4096) throw new Error("oversized pending file");
        raw = await readFile(pendingPath(path), "utf8");
        if (Buffer.byteLength(raw, "utf8") > 4096) throw new Error("oversized pending file");
      } catch (error) {
        if (error instanceof McpConnectError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (directoryMode !== null && directoryMode !== 0o700 &&
              (await pathExists(path) || await pathExists(join(dirname(path), CONNECT_PROFILE_FILES.credential)) || await pathExists(completePath(path)))) {
            throw new McpConnectError("connect_directory_mode", `The connect directory at ${dirname(path)} needs mode 0700. Run chmod 700 ${quoteAgentArgument(dirname(path))}, then rerun the same command.`);
          }
          continue;
        }
        if (directoryMode !== null && directoryMode !== 0o700) {
          throw new McpConnectError("connect_directory_mode", `The connect directory at ${dirname(path)} needs mode 0700. Run chmod 700 ${quoteAgentArgument(dirname(path))}, then rerun the same command.`);
        }
        if (fileMode !== null && fileMode !== 0o600) {
          throw new McpConnectError("connect_pending_mode", `The connect record at ${pendingPath(path)} needs mode 0600. Run chmod 600 ${quoteAgentArgument(pendingPath(path))}, then rerun the same command.`);
        }
        throw new McpConnectError("connect_pending_unreadable", `The possible connect record at ${pendingPath(path)} cannot be read or excluded. Inspect it and ask the operator to check the attempt before clearing it with ${clearCommand(path)}.`);
      }
      let loose: Record<string, unknown> | null = null;
      try { loose = record(JSON.parse(raw)); } catch { /* Unknown target must stay blocked. */ }
      if (typeof loose?.url === "string" && loose.url !== target.url) continue;
      if (directoryMode !== 0o700 || fileMode !== 0o600) {
        const fixes = [directoryMode !== 0o700 ? `chmod 700 ${quoteAgentArgument(dirname(path))}` : null,
          fileMode !== 0o600 ? `chmod 600 ${quoteAgentArgument(pendingPath(path))}` : null].filter(Boolean).join(" and ");
        throw new McpConnectError("connect_pending_mode", `The possible connect record at ${pendingPath(path)} has the wrong mode. Run ${fixes}, then rerun the same command.`);
      }
      const candidate = parsePending(raw);
      if (candidate && !sameCode(code, candidate)) continue;
      const damaged = loose;
      if (typeof damaged?.url === "string" && damaged.url !== target.url) continue;
      if (damaged?.url === target.url) {
        throw new McpConnectError("connect_pending_invalid", `The connect record at ${pendingPath(path)} is damaged. Inspect it and ask the operator to check the attempt before clearing it with ${clearCommand(path)}.`);
      }
      throw new McpConnectError("connect_pending_unreadable", `The possible connect record at ${pendingPath(path)} cannot be parsed or excluded. Inspect it and ask the operator to check the attempt before clearing it with ${clearCommand(path)}.`);
    }
  }
  if (matches.length > 1) throw new McpConnectError("connect_pending_ambiguous", "More than one interrupted connect matches this code. Use --profile with the intended path.");
  return matches[0] ?? null;
}

export interface McpConnectResult { profile: string; principal_id: string; install: string }

function connectedResult(path: string, principalId: string): McpConnectResult {
  const claude = `claude mcp add --scope user --transport stdio cswarm -- cswarm mcp --profile ${quoteAgentArgument(path)}`;
  const codex = `[mcp_servers.cswarm]\ncommand = "cswarm"\nargs = ["mcp", "--profile", ${JSON.stringify(path)}]`;
  return { profile: path, principal_id: principalId, install: `${claude}\n${codex}` };
}

async function completedProfileAt(path: string): Promise<boolean> {
  if (!await pathExists(path)) return false;
  const profileInfo = await lstat(path);
  if (profileInfo.isFile() && !profileInfo.isSymbolicLink() && (profileInfo.mode & 0o777) !== 0o600) {
    throw new McpConnectError("connect_profile_mode", `The profile at ${path} needs mode 0600. Run chmod 600 ${quoteAgentArgument(path)}, then rerun the same command.`);
  }
  try {
    const raw = await readSecureJsonFileIfPresent(path, ONBOARDING_MAX_FILE_BYTES);
    const hostSessionId = raw === null ? undefined : record(JSON.parse(raw))?.host_session_id;
    const profile = await readAgentProfile(path, typeof hostSessionId === "string" ? hostSessionId : undefined);
    const credentialInfo = await lstat(profile.credential_file).catch(() => null);
    if (credentialInfo?.isFile() && !credentialInfo.isSymbolicLink() && (credentialInfo.mode & 0o777) !== 0o600) {
      throw new McpConnectError("connect_credential_mode", `The credential at ${profile.credential_file} needs mode 0600. Run chmod 600 ${quoteAgentArgument(profile.credential_file)}, then rerun the same command.`);
    }
    await readProfileCredential(profile);
    return true;
  } catch (error) {
    if (error instanceof McpConnectError) throw error;
    return false;
  }
}

async function repairableProfileAt(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return info !== null && info.isFile() && !info.isSymbolicLink() && info.size <= ONBOARDING_MAX_FILE_BYTES &&
    (info.mode & 0o777) === 0o600 && (typeof process.getuid !== "function" || info.uid === process.getuid());
}

/** Strategist ruling (2026-09-24): the printed lines name the profile path only; no id, code or token. */
export function renderMcpConnect(result: McpConnectResult): string {
  return `Profile: ${result.profile}\n${result.install}\n`;
}

export async function connectMcp(options: McpConnectOptions): Promise<McpConnectResult> {
  if (!options.readCode && !(options.terminal?.isTTY ?? process.stdin.isTTY)) throw new McpConnectError("terminal_required", "Run mcp connect in a terminal to enter the code privately. A plain pipe or redirect is refused; a pseudo-terminal wrapper is not detected.");
  const endpoint = new URL(options.target.url);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) {
    throw new McpConnectError("connect_url_invalid", "Use an HTTPS deployment URL or a loopback test URL.");
  }
  if (options.profilePath === undefined) {
    const name = options.name ?? "MCP agent";
    if (name.trim().length < 1 || name.length > H0_REGISTRATION_NAME_MAX) {
      throw new McpConnectError("connect_name_invalid", `Use a display name of 1 to ${H0_REGISTRATION_NAME_MAX} characters.`);
    }
    const code = (await (options.readCode ?? (() => readHiddenJoinCode(options.terminal)))()).trim();
    if (!code) throw new McpConnectError("code_missing", "No code was entered. Run mcp connect again.");
    if (!JOIN_CODE.test(code)) throw new McpConnectError("join_credential_invalid", "The connect code is invalid. Nothing was sent.");
    const match = await defaultPendingProfile(options.target, code);
    return await connectMcp({ ...options, profilePath: match ?? join(homedir(), ".cswarm", "agents", `mcp-${randomUUID()}`, "profile.json"), readCode: async () => code });
  }
  const path = await privateConnectLocation(options.profilePath);
  if (/swm_(?:join|agt)_/.test(path)) throw new McpConnectError("profile_path_invalid", "Use a profile path that contains no credential text.");
  if (reservedConnectProfileName(basename(path))) {
    throw new McpConnectError("profile_path_reserved", `The profile path uses a reserved file name. Choose another basename. Reserved names: ${reservedConnectProfileNames()}.`);
  }
  const profileDir = dirname(path);
  // mkdir's return value is undefined when the directory already existed.
  let createdDirectory: boolean;
  try { createdDirectory = (await mkdir(profileDir, { recursive: true, mode: 0o700 })) !== undefined; }
  catch (error) {
    const wrongAncestor = isPermissionError(error) ? await wrongModeAncestor(profileDir) : null;
    if (wrongAncestor) throw directoryModeError(wrongAncestor);
    return await classifyDirectoryFailure(profileDir, error);
  }
  const createdInfo = createdDirectory ? await lstat(profileDir) : null;
  const cleanupOnSignal = () => {
    if (!createdInfo) return;
    try {
      const current = lstatSync(profileDir);
      if (current.dev === createdInfo.dev && current.ino === createdInfo.ino) rmdirSync(profileDir);
    } catch { /* The registration error or signal exit must survive cleanup failure. */ }
  };
  try {
    try { await ensureSecureStateDirectory(profileDir); }
    catch (error) {
      const wrongAncestor = isPermissionError(error) ? await wrongModeAncestor(profileDir) : null;
      if (wrongAncestor) throw directoryModeError(wrongAncestor);
      if (isPermissionError(error)) await classifyDirectoryFailure(profileDir, error);
      const info = await lstat(profileDir).catch(() => null);
      if (info?.isDirectory() && !info.isSymbolicLink() && (typeof process.getuid !== "function" || info.uid === process.getuid()) && (info.mode & 0o777) !== 0o700) {
        throw new McpConnectError("connect_directory_mode", `The connect directory at ${profileDir} needs mode 0700. Run chmod 700 ${quoteAgentArgument(profileDir)}, then rerun the same command.`);
      }
      throw new McpConnectError("connect_state_unavailable", `The connect directory at ${profileDir} cannot be used safely. Inspect the path and rerun the same command.`);
    }
    await withFileLock(profileDir, CONNECT_PROFILE_FILES.connectLock.slice(0, -5), async () => { await cleanConnectTemps(path); });
    try { await (options.checkProfileAccess ?? access)(dirname(path), constants.W_OK); }
    catch (error) { await classifyDirectoryFailure(dirname(path), error); }
    const pending = await readPending(path);
    if (pending) {
      const credential = join(profileDir, CONNECT_PROFILE_FILES.credential);
      const info = await lstat(credential).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) !== 0o600) {
        throw new McpConnectError("connect_credential_mode", `The credential at ${credential} needs mode 0600. Run chmod 600 ${quoteAgentArgument(credential)}, then rerun the same command.`);
      }
    }
    // A pending record is the sole exception for an orphan credential.
    if (!pending && await pathExists(path)) {
      if (await completedProfileAt(path) || !await repairableProfileAt(path) || !await readComplete(path)) {
        throw new McpConnectError("profile_exists", "This directory already holds a profile. Use a new --profile path for a new agent.");
      }
    }
    if (!pending && await pathExists(join(profileDir, CONNECT_PROFILE_FILES.credential)) && !await pathExists(completePath(path))) {
      throw new McpConnectError("profile_exists", await emptyClaimAt(join(profileDir, CONNECT_PROFILE_FILES.credential))
        ? "This directory holds an empty claim file without a profile. Keep the file and use a new --profile path for a new agent."
        : "This directory holds a credential without a profile. Keep the credential and use a new --profile path for a new agent.");
    }
    const name = options.name ?? "MCP agent";
    if (name.trim().length < 1 || name.length > H0_REGISTRATION_NAME_MAX) {
      throw new McpConnectError("connect_name_invalid", `Use a display name of 1 to ${H0_REGISTRATION_NAME_MAX} characters.`);
    }
    if (pending && (pending.url !== options.target.url || pending.name !== name)) {
      if (await completedProfileAt(path)) throw new McpConnectError("connect_pending_mismatch", "This directory already holds a working profile. Use a new --profile path for a new agent.");
      throw new McpConnectError("connect_pending_mismatch", `The record at ${pendingPath(path)} belongs to another target or agent name. Rerun with the original target and name; ask the operator to inspect the attempt before clearing it with ${clearCommand(path)}.`);
    }
    if (pending) process.stderr.write(`Resuming interrupted connect at ${path}.\n`);
    const code = (await (options.readCode ?? (() => readHiddenJoinCode(options.terminal, cleanupOnSignal)))()).trim();
    if (!code) throw new McpConnectError("code_missing", "No code was entered. Run mcp connect again.");
    if (!JOIN_CODE.test(code)) throw new McpConnectError("join_credential_invalid", "The connect code is invalid. Nothing was sent.");
    if (pending && !sameCode(code, pending)) {
      if (await completedProfileAt(path)) throw new McpConnectError("connect_code_mismatch", "This directory already holds a working profile. Use a new --profile path for a new agent.");
      throw new McpConnectError("connect_code_mismatch", `The record at ${pendingPath(path)} belongs to another code. Rerun with the original code; ask the operator to inspect the attempt before clearing it with ${clearCommand(path)}.`);
    }
    return await withFileLock(profileDir, CONNECT_PROFILE_FILES.connectLock.slice(0, -5), async () => {
      await cleanConnectTemps(path);
      const current = await readPending(path);
      const complete = await readComplete(path, current !== null, options.inspectCompletion);
      if (!current && complete?.url === options.target.url && complete.codeHash === codeHash(code, complete.attemptId) &&
          (!await pathExists(path) || (await repairableProfileAt(path) && !await completedProfileAt(path)))) {
        return await withFileLock(profileDir, CONNECT_PROFILE_FILES.setupLock.slice(0, -5), async () => {
          if (await completedProfileAt(path) || (await pathExists(path) && !await repairableProfileAt(path))) {
            throw new McpConnectError("profile_exists", "This directory already holds a profile. Use a new --profile path for a new agent.");
          }
          const profileState = await pathExists(path) ? await emptyClaimAt(path) ? "an empty profile.json claim file" : "damaged profile.json" : "no profile.json";
          const credentialPath = join(profileDir, CONNECT_PROFILE_FILES.credential);
          const credentialState = await emptyClaimAt(credentialPath) ? "an empty claim file at credential.json" :
            await pathExists(credentialPath) ? CONNECT_PROFILE_FILES.credential : `no ${CONNECT_PROFILE_FILES.credential}`;
          const state = `This directory has ${credentialState}, ${profileState}, and ${completePath(path)}.`;
          const newPath = `Use --profile <new path> for a new agent.`;
          if (!complete.workspace_id || !complete.anon_key || !complete.principal_id || complete.anon_key !== options.target.anonKey) {
            throw new McpConnectError("connect_completion_incomplete", `${state} The completion record cannot rebuild the profile. ${newPath}`);
          }
          let orphan: { principalId: string; raw: string } | null;
          try { orphan = await checkedOrphan(path); }
          catch (error) {
            if (error instanceof McpConnectError && error.code === "connect_credential_mode") throw error;
            throw new McpConnectError("connect_completion_incomplete", `${state} The credential cannot rebuild the profile. ${newPath}`);
          }
          if (!orphan) throw new McpConnectError("connect_completion_incomplete", `${state} ${await emptyClaimAt(credentialPath) ? "The empty claim file has no credential." : "The credential is missing."} ${newPath}`);
          if (orphan.principalId !== complete.principal_id) {
            throw new McpConnectError("connect_completion_principal_mismatch", `The credential at ${join(profileDir, CONNECT_PROFILE_FILES.credential)} belongs to a different principal than ${completePath(path)}. The profile was not rebuilt. Use --profile <new path> for a new agent.`);
          }
          const restored: AgentProfile = { version: 1, url: complete.url, anon_key: complete.anon_key,
            workspace_id: complete.workspace_id, principal_id: orphan.principalId,
            credential_file: join(profileDir, CONNECT_PROFILE_FILES.credential) };
          if (await pathExists(path)) await writeSecureJsonFile(path, JSON.stringify(restored));
          else await writeSecureJsonFileExclusive(path, JSON.stringify(restored));
          return connectedResult(path, orphan.principalId);
        });
      }
      if ((!current && await pathExists(path)) || (!current && await pathExists(join(profileDir, CONNECT_PROFILE_FILES.credential)))) {
        throw new McpConnectError("profile_exists", "This profile path already holds a connection. Choose a new profile path.");
      }
      if (pending?.attemptId !== current?.attemptId) {
        throw new McpConnectError("connect_pending_changed", "The interrupted connect changed while entering the code. Run mcp connect again.");
      }
      if (current && await pathExists(path)) {
        try {
          await completedProfileAt(path);
          const profile = await readAgentProfile(path);
          if (profile.url !== options.target.url) throw new Error("wrong profile target");
          const credential = await readProfileCredential(profile);
          try { await (options.writeCompletion ?? writeSecureJsonFile)(completePath(path), JSON.stringify({ attemptId: current.attemptId, url: current.url, codeHash: current.codeHash,
            workspace_id: profile.workspace_id, anon_key: profile.anon_key, principal_id: profile.principal_id,
            ...(credential.runId ? { run_id: credential.runId } : {}) } satisfies CompleteConnect)); }
          catch { throw new McpConnectError("connect_complete_write_failed", `The working profile at ${path} was kept, but the completion record at ${completePath(path)} could not be written. Inspect the completion record and rerun the same command.`); }
          await deleteSecureJsonFile(pendingPath(path));
          return connectedResult(path, profile.principal_id);
        } catch (error) {
          if (error instanceof McpConnectError) throw error;
          throw new McpConnectError("connect_profile_damaged", damagedProfileMessage(path));
        }
      }
      let orphanPrincipalId: string | undefined;
      if (current) orphanPrincipalId = (await checkedOrphan(path))?.principalId;
      const attemptId = current?.attemptId ?? randomUUID();
      if (!current) await writeSecureJsonFile(pendingPath(path), JSON.stringify({ attemptId, url: options.target.url, name, codeHash: codeHash(code, attemptId), createdAt: new Date().toISOString() } satisfies PendingConnect));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MCP_REGISTER_TIMEOUT_MS);
      let redirected = false;
      const headersChannel = channel("undici:request:headers");
      const onHeaders = (value: unknown) => {
        const event = value as { request?: { origin?: string; path?: string; method?: string }; response?: { statusCode?: number } };
        if (event.request?.origin === options.target.url && event.request.path === "/functions/v1/h0/register" &&
            event.request.method === "POST" && (event.response?.statusCode ?? 0) >= 300 && (event.response?.statusCode ?? 0) < 400) redirected = true;
      };
      headersChannel.subscribe(onHeaders);
      let response: Response;
      try {
        response = await (options.fetcher ?? fetch)(`${options.target.url}/functions/v1/h0/register`, {
          method: "POST", headers: { "content-type": "application/json", apikey: options.target.anonKey },
          body: JSON.stringify({ joinCredential: code, attemptId, name }), signal: controller.signal, redirect: "error",
        });
      } catch {
        clearTimeout(timer);
        if (redirected) throw new McpConnectError("register_redirected", OUTCOME_UNKNOWN);
        throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
      } finally { headersChannel.unsubscribe(onHeaders); }
      try {
        let body: Record<string, unknown> | null;
        try { body = record(await response.json()); }
        catch { body = null; }
        clearTimeout(timer);
        if (response.status >= 300 && response.status < 400) throw new McpConnectError("register_redirected", OUTCOME_UNKNOWN);
        if (!response.ok) {
          const errorCode = body?.error;
          if (typeof errorCode === "string" && (REGISTER_NO_SEAT_THIS_ATTEMPT[errorCode] === response.status || REGISTER_EXISTING_SEAT_REFUSALS[errorCode] === response.status)) {
            const message = current && REGISTER_NO_SEAT_THIS_ATTEMPT[errorCode] === response.status
              ? errorCode === "upgrade_required"
                ? "Update cswarm and run the same mcp connect command again with the same code. The earlier attempt's outcome is unknown; ask the operator to inspect it if recovery fails."
                : errorCode === "principal_limit_reached"
                  ? "The workspace is at its agent limit, and no seat exists for this attempt. Free a seat and run the same mcp connect command again with the same code."
                : errorCode === "forbidden"
                  ? "The code is unknown, expired or no longer valid; the earlier attempt's outcome is unknown. Ask the operator to inspect it before clearing the pending record."
                : `The request was refused (${errorCode}); the earlier attempt's outcome is unknown. Ask the operator to inspect it before clearing the pending record.`
              : current && errorCode === "registration_token_already_used" ? "The server reports that this seat's token was used. Ask the operator to inspect the attempt before clearing the pending record."
              : current && errorCode === "registration_seat_revoked" ? `The server reports that this seat is no longer active. Clear its local record with ${clearCommand(path)} before a fresh connect.`
              : errorCode === "upgrade_required" ? "Update cswarm and run mcp connect again; this attempt created no seat."
              : errorCode === "principal_limit_reached" ? "The workspace has no free agent seat; this attempt created no seat. Ask the operator."
              : errorCode === "not_found" || errorCode === "method_not_allowed" ? "Check --url; this attempt created no seat."
              : REGISTER_EXISTING_SEAT_REFUSALS[errorCode] === response.status ? "The server reports that this code was already used. Ask the operator to inspect its seats before requesting a new code."
              : errorCode === "forbidden" ? "This code is unknown, expired or no longer valid; this attempt created no seat. Ask the operator for a new code."
              : "The request was refused; this attempt created no seat. Ask the operator for a new code.";
            if (!current && (REGISTER_NO_SEAT_THIS_ATTEMPT[errorCode] === response.status || errorCode === "join_credential_seat_cap_reached")) await deleteSecureJsonFile(pendingPath(path));
            throw new McpConnectError(errorCode, message);
          }
          throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
        }
        if (body?.status !== "accepted") throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
        if (typeof body.workspace_id !== "string" || !ONBOARDING_UUID.test(body.workspace_id) ||
            typeof body.principal_id !== "string" || !ONBOARDING_UUID.test(body.principal_id) ||
            typeof body.run_id !== "string" || !ONBOARDING_UUID.test(body.run_id) ||
            typeof body.token_id !== "string" || !ONBOARDING_UUID.test(body.token_id) ||
            typeof body.agent_token !== "string" || !SEAT_TOKEN.test(body.agent_token) ||
            typeof body.expires_at !== "string" || Number.isNaN(Date.parse(body.expires_at))) {
          throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
        }
        const connection: AgentConnectionEnvelope = {
          version: 1, url: options.target.url, anon_key: options.target.anonKey,
          workspace_id: body.workspace_id, principal_id: body.principal_id,
          credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: body.principal_id,
            run_id: body.run_id, token_id: body.token_id, agent_token: body.agent_token, expires_at: body.expires_at },
        };
        // The orphan was validated before POST; a changed file is checked again by saveAgentProfile.
        if (orphanPrincipalId && orphanPrincipalId !== connection.principal_id) {
          throw new McpConnectError("profile_conflict", "The saved credential belongs to another agent. Inspect the connection before retrying.");
        }
        // saveAgentProfile owns the 0700 directory and 0600 file writes. The profile is intentionally unbound.
        await (options.saveProfile ?? saveAgentProfile)(path, connection, undefined, undefined, true, current !== null, orphanPrincipalId);
        try { await (options.writeCompletion ?? writeSecureJsonFile)(completePath(path), JSON.stringify({ attemptId, url: options.target.url, codeHash: codeHash(code, attemptId),
          workspace_id: connection.workspace_id, anon_key: connection.anon_key, principal_id: connection.principal_id, run_id: body.run_id } satisfies CompleteConnect)); }
        catch { throw new McpConnectError("connect_complete_write_failed", `The profile at ${path} is saved and usable, but the completion record at ${completePath(path)} was not written. Inspect that record and run the same command again to finish the connect.`); }
        await deleteSecureJsonFile(pendingPath(path));
        return connectedResult(path, body.principal_id);
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof McpConnectError && error.code !== "register_outcome_unknown") throw error;
        throw new McpConnectError("register_outcome_unknown", OUTCOME_UNKNOWN);
      }
    });
  } finally {
    if (createdInfo) {
      try {
        const current = await lstat(profileDir);
        if (current.dev === createdInfo.dev && current.ino === createdInfo.ino) await (options.removeEmptyDirectory ?? rmdir)(profileDir);
      } catch { /* Cleanup must never replace a refusal or revoke instruction. */ }
    }
  }
}
