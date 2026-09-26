import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";
import { lsofStdoutConsumer, type StdoutConsumerAdapter, type StdoutConsumerState } from "./stdout-consumer.js";
import { arrivalHostIdFileState, arrivalMachineHash, arrivalWatchLockIdentity, arrivalWatchLockPath } from "./cloud/arrival-watch.js";
import { WAKE_LEASE_STALE_LABEL, printedCommand, sanitizeWakeHostLabel } from "./cloud/wake-lease-constants.js";
import { verifiedLiveSessionContexts } from "./cloud/live-session-context.js";
import type { ServerSessionStatus } from "./cloud/session-client.js";
import type { AgentWakeLease } from "./cloud/wake-lease.js";
export { lsofStdoutConsumer } from "./stdout-consumer.js";
export type { StdoutConsumerAdapter, StdoutConsumerState } from "./stdout-consumer.js";
import type { BrainTopicSnapshot } from "./cloud/brain.js";
import type { CloudTarget } from "./cloud/config.js";
import {
  FileBrainDigestStore,
  listenerPaths,
  queryListenerControl,
  readListenerStatusIfPresent,
  type ListenerPaths,
  type ListenerStatus,
} from "./listener/index.js";

export interface ResumeIdentity {
  displayName: string;
  principalId: string;
  sessionStatus?: ServerSessionStatus;
}

export interface ProcessRow {
  pid: number;
  command: string;
}

export interface ProcessTableAdapter {
  list(): Promise<readonly ProcessRow[]>;
}

export interface ProcessTableCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * A process's whole argv appears in this output, so the table has no useful
 * size bound: one agent that passes an 80 KB prompt as a command-line argument
 * contributes an 80 KB row. It is therefore read as a stream and never through
 * a fixed stdout buffer.
 */
export const DEFAULT_PROCESS_TABLE_COMMAND: ProcessTableCommand = {
  file: "ps",
  args: ["-axo", "pid=,command="],
};

/** Typed so callers classify by class, never by the text of a message. */
export class ProcessTableError extends Error {
  readonly code = "process_table_unavailable";

  constructor(
    readonly command: ProcessTableCommand,
    readonly detail: string,
  ) {
    super(
      `could not read the host process table with ${command.file}: ${detail}`,
    );
    this.name = "ProcessTableError";
  }
}

export type ParentState = "parent_alive" | "parent_is_init" | "parent_missing" | "cannot_determine";
export interface ParentProcessAdapter {
  inspect(pid: number): Promise<ParentState>;
}

export interface NotifyWatcher {
  pid: number;
  matchedBy: Array<"agent_token_file" | "principal_id">;
  stdout: StdoutConsumerState;
  parent: ParentState;
}

export interface ResumeListenerInspection {
  checkedDirectory: string;
  status: ListenerStatus | null;
  source: "live_process" | "recorded_file" | "not_found";
}

export interface ResumeInboxCount {
  count: number;
  exact: boolean;
}

export interface ResumeInspection {
  identity: ResumeIdentity;
  listener: ResumeListenerInspection;
  watchers: NotifyWatcher[];
  brain: {
    digest: string | null;
    highWaterFile: string;
  };
  inbox: ResumeInboxCount;
  sessionContexts?: { paths: string[]; verificationUnavailable: boolean; managed: boolean | null;
    verificationRefused?: boolean; verificationServiceError?: boolean };
  wakeLease?: { lease: AgentWakeLease | null; localWatcherId: string | null; unavailable?: boolean; machineIdUnavailable?: boolean; hostIdFileState?: "present" | "missing" | "unreadable"; hostIdDirectory?: string };
  target: CloudTarget;
  workspaceId: string;
  credentialFile: string;
  installedVersion: string;
  stateDirectory?: string;
}

export interface ResumeInspectionAdapters {
  readIdentity(): Promise<ResumeIdentity>;
  readBrainTopics(): Promise<readonly BrainTopicSnapshot[]>;
  readInboxCount(
    principalId: string,
    instanceDirectory: string,
  ): Promise<ResumeInboxCount>;
  readWakeLease?: () => Promise<AgentWakeLease | null>;
  processTable?: ProcessTableAdapter;
  stdoutConsumer?: StdoutConsumerAdapter;
  parentProcess?: ParentProcessAdapter;
  queryStatus?: (
    paths: ListenerPaths,
    command: "status",
  ) => Promise<ListenerStatus>;
  readStatus?: (paths: ListenerPaths) => Promise<ListenerStatus | null>;
}

export interface ResumeInspectionOptions {
  target: CloudTarget;
  workspaceId: string;
  credentialFile: string;
  credentialPathAliases?: readonly string[];
  installedVersion: string;
  stateDirectory?: string;
  sessionCredential?: string;
  sessionTokenFile?: string;
}

function execFileText(
  file: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function parseProcessRow(line: string): ProcessRow | null {
  const match = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, command: match[2]! };
}

/** Enough of a failing command's own output to report it, and no more. */
const PROCESS_TABLE_STDERR_MAX_CHARS = 2_000;

/**
 * Host process inventory without a shell, so command text is never executed.
 *
 * Read line by line as the child writes, so no fixed buffer can overflow. Pass
 * `retain` to drop rows the caller cannot use before they are held in memory:
 * the table is unbounded, but the rows worth keeping are few.
 */
export function systemProcessTable(
  options: {
    command?: ProcessTableCommand;
    retain?: (command: string) => boolean;
  } = {},
): ProcessTableAdapter {
  const command = options.command ?? DEFAULT_PROCESS_TABLE_COMMAND;
  const retain = options.retain ?? ((): boolean => true);
  return {
    list() {
      return new Promise<readonly ProcessRow[]>((resolve, reject) => {
        const child = spawn(command.file, [...command.args], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const rows: ProcessRow[] = [];
        let pending = "";
        let stderr = "";
        let settled = false;
        const fail = (detail: string): void => {
          if (settled) return;
          settled = true;
          child.stdout.destroy();
          reject(new ProcessTableError(command, detail));
        };
        /* `retain` is caller-supplied. A throw inside a stream handler is an
         * uncaught exception that leaves this promise pending forever, which
         * is the failure mode the whole change exists to remove, so it is
         * turned into a rejection. The reason is a fixed word, never the
         * thrown message (D-053). */
        const take = (line: string): boolean => {
          const row = parseProcessRow(line);
          if (row === null) return true;
          try {
            if (retain(row.command)) rows.push(row);
          } catch {
            fail("its row filter threw");
            return false;
          }
          return true;
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (settled) return;
          const lines = (pending + chunk).split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!take(line)) return;
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          /* A hard cap: a chunk is truncated to what is left, so a child that
           * writes megabytes to stderr cannot be buffered in full. */
          const room = PROCESS_TABLE_STDERR_MAX_CHARS - stderr.length;
          if (room > 0) stderr += chunk.slice(0, room);
        });
        /* Without these a stream error is an unhandled 'error' event, which
         * crashes the process instead of failing this read. */
        child.stdout.on("error", () => fail("its output stream failed"));
        child.stderr.on("error", () => fail("its error stream failed"));
        child.on("error", (error) => fail(error.name));
        child.on("close", (code, signal) => {
          if (settled) return;
          if (pending.length > 0 && !take(pending)) return;
          if (signal !== null) {
            fail(`it was stopped by ${signal}`);
            return;
          }
          if (code !== 0) {
            const trailer = stderr.trim().length > 0
              ? `: ${stderr.trim().slice(0, PROCESS_TABLE_STDERR_MAX_CHARS)}`
              : "";
            fail(`it exited ${code}${trailer}`);
            return;
          }
          settled = true;
          resolve(rows);
        });
      });
    },
  };
}

/** Classify a ps parent row without depending on the host process table. */
export function parseParentProcessOutput(
  output: string,
  checkAlive: (pid: number) => void = (pid) => process.kill(pid, 0),
): ParentState {
  const parent = Number(output.trim());
  if (!Number.isSafeInteger(parent) || parent <= 0) return "cannot_determine";
  if (parent === 1) return "parent_is_init";
  try {
    checkAlive(parent);
    return "parent_alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "parent_missing";
    if (code === "EPERM") return "parent_alive";
    return "cannot_determine";
  }
}

/** A missing or init parent is independent evidence when stdout is unproved. */
export function systemParentProcess(adapters: {
  ps?: (pid: number) => Promise<string>;
  checkAlive?: (pid: number) => void;
} = {}): ParentProcessAdapter {
  return {
    async inspect(pid) {
      let output: string;
      try {
        output = adapters.ps
          ? await adapters.ps(pid)
          : await execFileText("ps", ["-o", "ppid=", "-p", String(pid)]);
      } catch {
        return "cannot_determine";
      }
      return parseParentProcessOutput(output, adapters.checkAlive);
    },
  };
}

function commandHasFlagValue(
  command: string,
  flag: string,
  values: readonly string[],
): boolean {
  for (const value of values) {
    const marker = `${flag} ${value}`;
    let start = command.indexOf(marker);
    while (start !== -1) {
      const before = start === 0 ? " " : command[start - 1]!;
      const afterIndex = start + marker.length;
      const after = afterIndex >= command.length ? " " : command[afterIndex]!;
      if (/\s/.test(before) && /\s/.test(after)) return true;
      start = command.indexOf(marker, start + 1);
    }
  }
  return false;
}

function isNotifyCommand(command: string): boolean {
  return /(?:^|\s)inbox(?:\s|$)/.test(command) &&
    /(?:^|\s)--notify(?:\s|$)/.test(command);
}

/** Find only notify processes for this credential path or authenticated principal. */
export async function findNotifyWatchers(options: {
  credentialPaths: readonly string[];
  principalId: string;
  processTable?: ProcessTableAdapter;
  processTableCommand?: ProcessTableCommand;
  stdoutConsumer?: StdoutConsumerAdapter;
  parentProcess?: ParentProcessAdapter;
}): Promise<NotifyWatcher[]> {
  const processTable = options.processTable ?? systemProcessTable({
    retain: isNotifyCommand,
    ...(options.processTableCommand
      ? { command: options.processTableCommand }
      : {}),
  });
  const stdoutConsumer = options.stdoutConsumer ?? lsofStdoutConsumer();
  const parentProcess = options.parentProcess ?? systemParentProcess();
  const rows = await processTable.list();
  const matches = rows.flatMap((row): Array<Pick<NotifyWatcher, "pid" | "matchedBy">> => {
    if (!isNotifyCommand(row.command)) return [];
    const matchedBy: NotifyWatcher["matchedBy"] = [];
    if (commandHasFlagValue(row.command, "--agent-token-file", options.credentialPaths)) {
      matchedBy.push("agent_token_file");
    }
    if (commandHasFlagValue(row.command, "--principal-id", [options.principalId])) {
      matchedBy.push("principal_id");
    }
    return matchedBy.length === 0 ? [] : [{ pid: row.pid, matchedBy }];
  });
  const unique = [...new Map(matches.map((row) => [row.pid, row])).values()]
    .sort((left, right) => left.pid - right.pid);
  return await Promise.all(unique.map(async (row) => ({
    ...row,
    stdout: await stdoutConsumer.inspect(row.pid),
    parent: await parentProcess.inspect(row.pid),
  })));
}

/** Query a live process, then read its file without rewriting stale state. */
export async function readOnlyListenerInspection(
  paths: ListenerPaths,
  adapters: Pick<ResumeInspectionAdapters, "queryStatus" | "readStatus"> = {},
): Promise<ResumeListenerInspection> {
  const query = adapters.queryStatus ?? queryListenerControl;
  const read = adapters.readStatus ?? readListenerStatusIfPresent;
  try {
    return {
      checkedDirectory: paths.instanceDirectory,
      status: await query(paths, "status"),
      source: "live_process",
    };
  } catch {
    const status = await read(paths);
    return {
      checkedDirectory: paths.instanceDirectory,
      status,
      source: status === null ? "not_found" : "recorded_file",
    };
  }
}

/** Collect the reconnect facts in the same order the command renders them. */
export async function inspectResume(
  options: ResumeInspectionOptions,
  adapters: ResumeInspectionAdapters,
): Promise<ResumeInspection> {
  const identity = await adapters.readIdentity();
  const principalId = identity.principalId.toLowerCase();
  const paths = listenerPaths({
    profileId: options.target.profileId,
    workspaceId: options.workspaceId,
    principalId,
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
  });
  const listener = await readOnlyListenerInspection(paths, adapters);
  const watchers = await findNotifyWatchers({
    credentialPaths: options.credentialPathAliases ?? [options.credentialFile],
    principalId,
    ...(adapters.processTable ? { processTable: adapters.processTable } : {}),
    ...(adapters.stdoutConsumer ? { stdoutConsumer: adapters.stdoutConsumer } : {}),
    ...(adapters.parentProcess ? { parentProcess: adapters.parentProcess } : {}),
  });
  const topics = await adapters.readBrainTopics();
  const digestStore = new FileBrainDigestStore(paths.instanceDirectory, principalId);
  const digest = await digestStore.preview(topics);
  const inbox = await adapters.readInboxCount(principalId, paths.instanceDirectory);
  const sessionContexts = options.sessionCredential === undefined ? undefined :
    await verifiedLiveSessionContexts({ target: options.target, workspaceId: options.workspaceId,
      principalId, credential: options.sessionCredential,
      ...(identity.sessionStatus === undefined ? {} : { serverStatus: identity.sessionStatus }),
      checkManagementWithoutFiles: true,
      ...(options.sessionTokenFile === undefined ? {} : { tokenFile: options.sessionTokenFile }) });
  let leaseUnavailable = false;
  const lease = adapters.readWakeLease
    ? await adapters.readWakeLease().catch(() => { leaseUnavailable = true; return null; })
    : null;
  const wakeLease = adapters.readWakeLease
    ? { lease,
        unavailable: leaseUnavailable,
        machineIdUnavailable: await arrivalMachineHash() === null,
        hostIdDirectory: dirname(arrivalWatchLockPath(options.target, options.workspaceId, principalId)),
        hostIdFileState: await arrivalHostIdFileState(arrivalWatchLockPath(
          options.target, options.workspaceId, principalId)),
        localWatcherId: await arrivalWatchLockIdentity(arrivalWatchLockPath(
          options.target, options.workspaceId, principalId)) }
    : undefined;
  return {
    identity: { ...identity, principalId },
    listener,
    watchers,
    brain: { digest, highWaterFile: digestStore.location },
    inbox,
    ...(sessionContexts ? { sessionContexts } : {}),
    ...(wakeLease ? { wakeLease } : {}),
    target: options.target,
    workspaceId: options.workspaceId,
    credentialFile: options.credentialFile,
    installedVersion: options.installedVersion,
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
  };
}

function safeText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 2_000);
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commonCommandArgs(report: ResumeInspection): string {
  return [
    "--agent-token-file",
    shellArg(report.credentialFile),
    "--url",
    shellArg(report.target.url),
    "--anon-key",
    shellArg(report.target.anonKey),
    "--workspace-id",
    report.workspaceId,
  ].join(" ");
}

function watcherNextStep(report: ResumeInspection): string {
  if (report.sessionContexts?.managed === false) {
    return printedCommand("start one watcher under a live Monitor.",
      `cswarm inbox --notify ${commonCommandArgs(report)}`);
  }
  return report.sessionContexts?.paths.length
    ? "start one watcher under the live host session with its verified context path listed above."
    : "start one watcher from this seat's live host session after its context is verified.";
}

function restartCommand(report: ResumeInspection, status: ListenerStatus): string {
  const common = commonCommandArgs(report);
  const stateDir = report.stateDirectory ? ` --state-dir ${shellArg(report.stateDirectory)}` : "";
  const start = [
    "cswarm listen start",
    common,
    `--provider ${shellArg(status.provider)}`,
    `--permissions ${shellArg(status.permissionMode ?? "allow")}`,
    "--route main",
  ].join(" ");
  return `cswarm listen stop ${common}${stateDir} --wait && ${start}${stateDir}`;
}

function watcherState(watcher: NotifyWatcher): StdoutConsumerState {
  if (watcher.stdout === "live_reader" || watcher.stdout === "orphaned") return watcher.stdout;
  if (watcher.parent === "parent_is_init" || watcher.parent === "parent_missing") return "orphaned";
  if (watcher.stdout === "cannot_determine" || watcher.parent === "cannot_determine") return "cannot_determine";
  return watcher.stdout;
}

function watcherStateLine(watcher: NotifyWatcher): string {
  const matched = watcher.matchedBy.map((value) =>
    value === "agent_token_file" ? "credential path" : "principal id"
  ).join(" and ");
  const state = watcher.stdout === "live_reader"
    ? "stdout has a live pipe reader"
    : watcher.stdout === "orphaned"
    ? "ORPHAN: stdout pipe has no reader"
    : watcher.stdout === "not_pipe"
    ? "stdout is not a pipe; the dead-reader check does not apply"
    : "stdout reader cannot be determined on this host";
  const orphanPrefix = watcher.stdout === "live_reader" ? "" : "ORPHAN: ";
  const parent = watcher.parent === "parent_is_init" ? `${orphanPrefix}parent PID is 1`
    : watcher.parent === "parent_missing" ? `${orphanPrefix}parent process no longer exists`
    : watcher.parent === "parent_alive" ? "parent process is live"
    : "parent process cannot be determined";
  return `- PID ${watcher.pid}: ${state}; ${parent}; matched ${matched}.`;
}

/** Stable human output: identity, listener, watchers, brain, then inbox. */
export function renderResume(report: ResumeInspection): string {
  const lines = [
    "Identity",
    `You are ${safeText(report.identity.displayName)} (${report.identity.principalId}).`,
    "Next: use this principal for every listener, watcher, brain, and inbox check below.",
    "",
  ];
  if (report.sessionContexts) {
    lines.push(...(report.sessionContexts.verificationRefused
      ? ["Live session context on this host: the service refused this credential (expired or revoked). Renew the agent credential, then resume."]
      : report.sessionContexts.verificationServiceError
      ? ["Live session context on this host: the read service returned an error; try again after it recovers."]
      : report.sessionContexts.verificationUnavailable
      ? ["Live session context on this host: could not verify with the read service; check again when it is reachable."]
      : report.sessionContexts.paths.length === 0
      ? ["Live session context on this host: no live session on this host was verified for this seat."]
      : report.sessionContexts.paths.map(path => `Live session context on this host: ${safeText(path)}`)), "");
  }
  lines.push("Listener");
  const listener = report.listener;
  const status = listener.status;
  if (status === null) {
    lines.push(
      `No listener found under ${safeText(listener.checkedDirectory)} for profile ${report.target.profileId}.`,
      "Next: start one with the original provider used for this seat.",
    );
  } else {
    if (listener.source === "live_process") {
      lines.push(
        `Found under ${safeText(listener.checkedDirectory)}. State: ${status.state}, reported by running PID ${status.pid}.`,
      );
    } else {
      lines.push(
        `Found a status file under ${safeText(listener.checkedDirectory)}. Recorded state: ${status.state}; the control socket did not answer, so a running listener is not established.`,
      );
    }
    const runningVersion = status.cswarmVersion ?? null;
    if (listener.source !== "live_process") {
      lines.push(
        `Running listener cswarm version: cannot determine because the process did not answer; status file recorded ${runningVersion ?? "no version"}; installed CLI: ${report.installedVersion}.`,
        printedCommand("Next: restart the listener because its process did not answer.", restartCommand(report, status)),
      );
    } else if (runningVersion === null) {
      lines.push(
        `Listener cswarm version: cannot determine from this listener; installed CLI: ${report.installedVersion}.`,
        printedCommand("Next: restart it to make the running version reportable.", restartCommand(report, status)),
      );
    } else if (runningVersion !== report.installedVersion) {
      lines.push(
        printedCommand(`VERSION MISMATCH: listener runs ${runningVersion}; installed ${report.installedVersion}. Restart it.`, restartCommand(report, status)),
      );
    } else {
      lines.push(
        `Listener-reported cswarm: ${runningVersion}; installed CLI: ${report.installedVersion}.`,
        "Next: no listener restart is needed for a version change.",
      );
    }
  }

  lines.push(
    "",
    "Notify watchers",
    `Checked process arguments for inbox --notify matching --agent-token-file ${safeText(report.credentialFile)} or --principal-id ${report.identity.principalId}.`,
  );
  if (report.watchers.length === 0) {
    lines.push(
      "Found: 0.",
      `Next: ${watcherNextStep(report)}`,
    );
  } else {
    lines.push(`Found: ${report.watchers.length}.`);
    lines.push(...report.watchers.map(watcherStateLine));
    const orphans = report.watchers.filter((watcher) => watcherState(watcher) === "orphaned");
    if (orphans.length > 0) {
      lines.push(
        printedCommand(`Next: stop the orphan watcher${orphans.length === 1 ? "" : "s"}; CommonSwarm did not kill anything.`,
          `kill ${orphans.map((watcher) => watcher.pid).join(" ")}`),
        `Then ${watcherNextStep(report)}`,
      );
    } else if (report.watchers.some((watcher) => watcherState(watcher) === "cannot_determine")) {
      const unknown = report.watchers.filter((watcher) => watcherState(watcher) === "cannot_determine");
      const evidence = [
        ...(unknown.some((watcher) => watcher.stdout === "cannot_determine") ? ["stdout reader"] : []),
        ...(unknown.some((watcher) => watcher.parent === "cannot_determine") ? ["parent process"] : []),
      ].join(" and ");
      lines.push(
        `Next: verify each unknown ${evidence} in the host Monitor before you start another watcher.`,
      );
    } else {
      lines.push("Next: keep one watcher with a live output surface; do not start a duplicate.");
    }
  }

  if (report.wakeLease) {
    if (report.wakeLease.machineIdUnavailable) {
      lines.push(report.wakeLease.hostIdFileState === "present"
        ? "This command could not read the machine id; a host-id file exists but cannot be verified against this machine."
        : report.wakeLease.hostIdFileState === "missing"
        ? "This command could not read the machine id; no host-id file exists yet."
        : "This command could not read the machine id or verify the host-id file.");
      if (report.wakeLease.hostIdDirectory) lines.push(
        `Keep the host-id state in ${safeText(report.wakeLease.hostIdDirectory)} separate on each machine; sharing that directory across machines is unsupported.`);
    }
    const lease = report.wakeLease.lease;
    lines.push(report.wakeLease.unavailable
      ? "Server wake lease: unavailable; check again when the read service is reachable."
      : lease === null
      ? "Server wake lease: none."
      : `Server wake lease: ${sanitizeWakeHostLabel(lease.host_label)}, generation ${lease.generation}, renewed ${Math.floor(lease.renewed_age_ms / 1000)}s ago; this host holds it: ${report.wakeLease.localWatcherId === lease.watcher_id ? "yes" : "no"}. A renewal does not prove this session reads its mail; observed ACK does. The lease goes stale after ${WAKE_LEASE_STALE_LABEL}.`);
  }

  lines.push(
    "",
    "Brain digest",
    `Checked ${safeText(report.brain.highWaterFile)} without advancing it.`,
  );
  if (report.brain.digest === null) {
    lines.push(
      "No brain topic is new or changed since this principal's digest high-water.",
      "Next: no brain read is needed now.",
    );
  } else {
    lines.push(report.brain.digest.replace(/ Read: cswarm brain get <topic>$/, ""),
      "Next: read any needed topic by name.");
  }

  const inboxCount = report.inbox.exact
    ? String(report.inbox.count)
    : `at least ${report.inbox.count}`;
  lines.push(
    "",
    "Unread inbox",
    `Unread directed asks and notes from the same read used by the hook: ${inboxCount}.`,
    report.inbox.count === 0
      ? "Next: no inbox action is needed now."
      : printedCommand("Next: read them without acknowledging them first.", `cswarm inbox ${commonCommandArgs(report)}`),
    "",
    "Read-only check complete. No cursor, brain high-water, listener status, receipt, acknowledgement, or process was changed.",
  );
  return lines.join("\n");
}

/** Machine form mirrors the five human sections and keeps watcher commands out. */
export function resumeJson(report: ResumeInspection): Record<string, unknown> {
  return {
    identity: {
      display_name: report.identity.displayName,
      principal_id: report.identity.principalId,
    },
    ...(report.sessionContexts ? { live_session_context_paths: report.sessionContexts.paths,
      live_session_context_verification_unavailable: report.sessionContexts.verificationUnavailable } : {}),
    listener: {
      found: report.listener.status !== null,
      checked_directory: report.listener.checkedDirectory,
      source: report.listener.source,
      state: report.listener.status?.state ?? null,
      pid: report.listener.status?.pid ?? null,
      running_cswarm_version: report.listener.source === "live_process"
        ? report.listener.status?.cswarmVersion ?? null
        : null,
      installed_cswarm_version: report.installedVersion,
      version_mismatch: report.listener.source === "live_process" &&
        report.listener.status?.cswarmVersion !== null &&
        report.listener.status?.cswarmVersion !== undefined &&
        report.listener.status.cswarmVersion !== report.installedVersion,
    },
    notify_watchers: report.watchers.map((watcher) => ({
      pid: watcher.pid,
      matched_by: watcher.matchedBy,
      stdout: watcher.stdout,
      parent: watcher.parent,
      state: watcherState(watcher),
    })),
    ...(report.wakeLease ? { ...(report.wakeLease.unavailable ? { wake_lease_error: "unavailable" } : {}),
      ...(report.wakeLease.machineIdUnavailable ? { host_machine_id_unavailable: true } : {}),
      host_id_file_state: report.wakeLease.hostIdFileState ?? null,
      wake_lease: report.wakeLease.lease === null ? null : {
      host_label: sanitizeWakeHostLabel(report.wakeLease.lease.host_label),
      generation: report.wakeLease.lease.generation,
      renewed_age_ms: report.wakeLease.lease.renewed_age_ms,
      held_by_this_host: report.wakeLease.localWatcherId === report.wakeLease.lease.watcher_id,
      renewal_is_mail_observation: false,
    } } : {}),
    brain: {
      high_water_file: report.brain.highWaterFile,
      high_water_advanced: false,
      digest: report.brain.digest,
    },
    unread_inbox: report.inbox,
    read_only: true,
  };
}
