#!/usr/bin/env node
/* Runs the test files named in a list file: node scripts/run-test-list.mjs <list> [--list-only] [node --test flags...]
 * The list holds one path per line; blank lines and lines starting with # are ignored.
 * Files run in list order. A path with a glob character is expanded in place (matches sorted) and
 * a file already named earlier is not repeated.
 * Any other path must exist, and no path may appear twice; otherwise exit 1.
 * --list-only prints the expanded file set in run order, one per line and runs nothing.
 * Node-args mode: node scripts/run-test-list.mjs -- [node --test flags and files/globs...]
 * passes its arguments to node --test literally (the p1-cli package script keeps its glob this way).
 *
 * Temp ownership: each real run creates one private run directory under the resolved OS temp
 * parent and points only the child's TMPDIR at it (HOME is never touched). After the child has
 * been reaped (close) the runner SIGKILLs any remainder of the group this run created, then
 * removes exactly that directory only once that group is proven unable to run more code — it
 * has left the process table, or only zombies remain in it (see waitForGroupQuiesce). That
 * removal happens on pass, failure, spawn failure (a synchronous spawn throw included),
 * SIGINT/SIGTERM/SIGHUP to the runner, and SIGKILL of the child. If the proof cannot be
 * obtained within the bound, the directory is retained and the run exits nonzero instead of
 * deleting under possible writers. Cleanup refuses anything that is not still the exact
 * directory this run created. Limit: if the runner itself is SIGKILLed or crashes, no JS
 * cleanup can execute; that case belongs to an outer owner, not this process. There is no
 * kill guarantee for a process that leaves the owned group (its own setsid). */
import { execFile, spawn } from "node:child_process";
import { existsSync, globSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GLOB = /[*?[\]{}]/;
const RUN_PREFIX = "cswarm-test-run-";
// The known caller (scripts/run-gates.sh) escalates a gate-group TERM to KILL after 2 s.
// That KILL reaches this runner but not the detached child group this run creates, so signal
// teardown is sized to finish inside the caller's grace: at most SHUTDOWN_GRACE_MS for the
// group to exit on the forwarded signal, then SIGKILL, then at most GROUP_QUIESCE_MS more
// to prove the group quiesced (every status probe inside that window is bounded by the
// time remaining in it) before the run root is removed or retained. There is no teardown
// at all if the runner itself is SIGKILLed first (see the header limit).
const SHUTDOWN_GRACE_MS = 800;
const GROUP_QUIESCE_MS = 700;
const GROUP_POLL_MS = 20;
const GROUP_PROBE_INTERVAL_MS = 100;
const GROUP_PROBE_TIMEOUT_MS = 150;

export function parseList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function checkList(entries, exists = existsSync) {
  const problems = [];
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) duplicates.add(entry);
    seen.add(entry);
  }
  for (const entry of duplicates) problems.push(`duplicate entry: ${entry}`);
  for (const entry of seen) {
    if (!GLOB.test(entry) && !exists(entry)) problems.push(`missing file: ${entry}`);
  }
  return problems;
}

export function expand(entries) {
  const files = new Set();
  for (const entry of entries) {
    if (GLOB.test(entry)) for (const match of globSync(entry).sort()) files.add(match);
    else files.add(entry);
  }
  return [...files];
}

function createRunRoot() {
  // Resolve first: the temp parent itself may be a symlink (macOS /tmp -> /private/tmp).
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, RUN_PREFIX));
  const entry = lstatSync(root);
  return { parent, root, identity: { dev: entry.dev, ino: entry.ino, uid: entry.uid } };
}

function removeRunRoot({ parent, root, identity }) {
  try {
    if (!root || root === "/" || root === homedir()) throw new Error("refusing unsafe run root");
    if (dirname(root) !== parent || !basename(root).startsWith(RUN_PREFIX)) {
      throw new Error("run root is outside its owned parent");
    }
    const entry = lstatSync(root, { throwIfNoEntry: false });
    if (!entry) return true;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("run root was replaced");
    if (entry.dev !== identity.dev || entry.ino !== identity.ino || entry.uid !== identity.uid) {
      throw new Error("run root identity changed");
    }
    if (realpathSync(root) !== root) throw new Error("run root path no longer resolves to itself");
    // fs.rm removes inner symlink entries without following them.
    rmSync(root, { recursive: true, force: true });
    if (existsSync(root)) throw new Error("run root still exists after removal");
    return true;
  } catch (error) {
    console.error(`run-test-list: cleanup failed for ${root}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function signalChildGroup(child, signal) {
  if (!child || child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      // Negative pid: only the process group this run created (detached child).
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone; fall through to the literal child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already reaped.
  }
}

function probeExec(file, args, timeoutMs) {
  return new Promise((resolveProbe) => {
    execFile(file, args, { timeout: Math.max(1, timeoutMs), maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolveProbe({ error, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}

// Positive status evidence for only the group this run created: pgrep lists
// members by that pgid, then ps reports pgid/state for just those pids (no
// command or environment columns, no other processes). The probe processes run
// in the runner's own group, never the owned one, so they cannot list
// themselves. Every returned pgid must match the owned pgid and every row must
// parse, otherwise the answer is "unknown", never a success.
async function ownedGroupStatus(pgid, budgetMs) {
  const eachMs = Math.max(1, Math.floor(budgetMs / 2));
  const members = await probeExec("pgrep", ["-g", String(pgid)], eachMs);
  if (members.error) {
    // pgrep exit 1 with no output is its documented "no processes matched".
    if (members.error.code === 1 && !members.error.killed && members.stdout.trim() === "") return "absent";
    return "unknown";
  }
  const pids = members.stdout.split(/\s+/).filter(Boolean);
  if (pids.length === 0 || pids.length > 4096 || pids.some((pid) => !/^[1-9][0-9]*$/.test(pid))) return "unknown";
  const states = await probeExec("ps", ["-o", "pgid=,state=", "-p", pids.join(",")], eachMs);
  if (states.error) return "unknown";
  const rows = states.stdout
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  // A member that vanished between the two probes makes the rows stop lining
  // up with the listed pids; that says nothing positive about the rest.
  if (rows.length !== pids.length) return "unknown";
  let sawLive = false;
  for (const row of rows) {
    const parts = row.split(/\s+/);
    if (parts.length !== 2 || Number(parts[0]) !== pgid || !parts[1]) return "unknown";
    if (parts[1][0] !== "Z") sawLive = true;
  }
  return sawLive ? "live" : "zombies-only";
}

async function waitForGroupQuiesce(child) {
  // True only on positive evidence the owned group can run no more code: the
  // direct child is already reaped (close), kill(-pgid, 0) reports ESRCH
  // (every member has left the process table), or the group-restricted probe
  // finds no members or only zombies (a zombie runs no code and cannot
  // recreate files, but keeps kill(-pgid, 0) succeeding on Linux and macOS).
  // A live member, EPERM, a failed or unparseable probe, or expiry of the
  // bound is not quiescence: the caller then retains the run root and fails
  // the run. No child (a setup or spawn failure before any group existed)
  // and win32 (no detached group is created) need no such evidence, so those
  // runs still clean up.
  if (!child || child.pid === undefined || process.platform === "win32") return true;
  const pgid = child.pid;
  const startedAt = Date.now();
  const deadline = startedAt + GROUP_QUIESCE_MS;
  let lastProbeAt = startedAt;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") return true;
      // EPERM or anything unexpected: present or unknown, never success.
    }
    const now = Date.now();
    const remainingMs = deadline - now;
    if (remainingMs <= 0) return false;
    const probeDue = now - lastProbeAt >= GROUP_PROBE_INTERVAL_MS;
    const finalProbeDue = remainingMs <= GROUP_PROBE_TIMEOUT_MS && now - lastProbeAt >= GROUP_POLL_MS;
    if (probeDue || finalProbeDue) {
      lastProbeAt = Date.now();
      const status = await ownedGroupStatus(pgid, Math.min(GROUP_PROBE_TIMEOUT_MS, remainingMs));
      if (status === "absent" || status === "zombies-only") return true;
      continue;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(GROUP_POLL_MS, remainingMs)));
  }
}

async function runNodeTest(args) {
  const tsx = import.meta.resolve("tsx");
  let owned;
  try {
    owned = createRunRoot();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  // Everything below runs under one outer finally that owns the run root from the moment
  // it exists, so a setup failure or a synchronous spawn throw (for example E2BIG, which
  // libuv reports by throwing rather than through the 'error' event) cannot leak it. The
  // child may be undefined on those paths; every teardown step tolerates that.
  let child;
  let status = 1;
  let spawnError = null;
  let interruptSignal = null;
  let graceTimer;
  let cleaned = false;
  // Stays true until a group this run created fails to prove quiescence, so a
  // no-child setup or spawn failure still removes its run root below.
  let groupQuiesced = true;
  const onSignal = (signal) => {
    if (interruptSignal) {
      signalChildGroup(child, "SIGKILL");
      return;
    }
    interruptSignal = signal;
    signalChildGroup(child, signal);
    graceTimer = setTimeout(() => signalChildGroup(child, "SIGKILL"), SHUTDOWN_GRACE_MS);
    graceTimer.unref?.();
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  const onSighup = () => onSignal("SIGHUP");
  try {
    const env = { ...process.env, TMPDIR: owned.root };
    if (process.platform === "win32") {
      env.TMP = owned.root;
      env.TEMP = owned.root;
    }
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("SIGHUP", onSighup);
    try {
      status = await new Promise((resolvePromise) => {
        child = spawn(process.execPath, ["--import", tsx, "--test", ...args], {
          stdio: "inherit",
          detached: process.platform !== "win32",
          env,
        });
        let settled = false;
        const settle = (value) => {
          if (!settled) {
            settled = true;
            resolvePromise(value);
          }
        };
        child.once("error", (error) => {
          spawnError = error;
          settle(1);
        });
        // close, not exit: the child is reaped and its stdio is drained.
        child.once("close", (code) => settle(code ?? 1));
      });
    } catch (error) {
      // A synchronous spawn throw rejects the promise above. It is a failed run, never a
      // success, and teardown below still runs.
      spawnError = error instanceof Error ? error : new Error(String(error));
      status = 1;
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
      // Nothing from this run's group may recreate files after the reaped child. Kill the
      // remainder, then require (bounded) proof the group quiesced before deletion.
      signalChildGroup(child, "SIGKILL");
      try {
        groupQuiesced = await waitForGroupQuiesce(child);
      } catch {
        // A probe that throws unexpectedly is not quiescence evidence.
        groupQuiesced = false;
      }
    }
  } catch (error) {
    // Setup before the spawn (env, signal handlers) failed. The finally below still
    // removes the run root (no group exists to quiesce), and the run stays nonzero.
    if (!spawnError) spawnError = error instanceof Error ? error : new Error(String(error));
    status = 1;
  } finally {
    // Deletion requires owned-group quiescence evidence. Without it the root is
    // retained and the run fails below (cleaned stays false) instead of deleting
    // under possible writers.
    if (groupQuiesced) {
      cleaned = removeRunRoot(owned);
    } else {
      cleaned = false;
      console.error(
        `run-test-list: owned process group ${child?.pid} did not quiesce within ${GROUP_QUIESCE_MS}ms; retaining ${owned.root}`,
      );
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGHUP", onSighup);
  }
  if (spawnError) console.error(spawnError.message);
  if (!cleaned) return status !== 0 ? status : 1;
  if (interruptSignal) {
    // Preserve interruption as a signal death, after cleanup has completed.
    process.kill(process.pid, interruptSignal);
    return 1;
  }
  return status;
}

async function main(argv) {
  const [listPath, ...rest] = argv;
  if (!listPath) {
    console.error("usage: run-test-list.mjs <list-file> [--list-only] [node --test flags...] | run-test-list.mjs -- [node --test args...]");
    return 2;
  }
  if (listPath === "--") {
    if (rest.length === 0) {
      console.error("usage: run-test-list.mjs -- [node --test flags and files/globs...]");
      return 2;
    }
    return runNodeTest(rest);
  }
  const listOnly = rest.includes("--list-only");
  const flags = rest.filter((flag) => flag !== "--list-only");
  if (!existsSync(listPath)) {
    console.error(`list file not found: ${listPath}`);
    return 1;
  }
  const entries = parseList(readFileSync(listPath, "utf8"));
  if (entries.length === 0) {
    console.error(`list is empty: ${listPath}`);
    return 1;
  }
  const problems = checkList(entries);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`${listPath}: ${problem}`);
    return 1;
  }
  if (listOnly) {
    console.log(expand(entries).join("\n"));
    return 0;
  }
  const files = expand(entries);
  if (files.length === 0) {
    console.error(`${listPath}: no test files matched`);
    return 1;
  }
  return runNodeTest([...flags, ...files]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
