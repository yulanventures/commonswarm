#!/usr/bin/env node
/**
 * Persistent task-browser controller for site releases.
 *
 * This is the ONLY component that launches, probes and closes the headless
 * task browser used by docs/evidence/2026-10-02-site-release/SITE-RELEASE.md.
 *
 *   start --state-dir DIR --executable PATH
 *       Starts one detached controller process. The controller creates a fresh
 *       mode-0700 profile inside DIR, launches the bundled Chromium as ITS OWN
 *       child, and serves an authenticated control socket at DIR/control.sock.
 *   probe --state-dir DIR [URL ...]
 *       Asks the controller to prove that its child browser is alive and its
 *       loopback DevTools endpoint answers as HeadlessChrome; each URL is opened
 *       in a new target, observed, and closed. No second browser is launched.
 *   close --state-dir DIR
 *       Idempotent. The controller stops its own child, removes the exact
 *       profile it created, and exits. If the controller and browser are both
 *       already gone, close passes. It never signals a process it did not
 *       launch and never runs ps, pgrep, lsof or any setuid tool.
 *
 * Ownership model: the controller is the browser's parent and signals it only
 * through its ChildProcess handle. A parent keeps an unreaped child's PID, so
 * the PID cannot be reused under it, and Node ignores kill() after the child
 * has exited. The controller's liveness is its listening socket: the kernel
 * closes it when the process dies, so ECONNREFUSED/ENOENT means "gone".
 *
 * Browser evidence is optional in the plan. probe exits 3 with
 * TASK_BROWSER_PROBE=NOT_PROVED on any browser failure; callers record that and
 * never roll back public bytes because of it.
 *
 * Output is fixed KEY=value lines. The token never leaves the 0600 state file.
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  accessSync, closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, chmodSync, writeSync, unlinkSync,
} from "node:fs";
import { createServer, createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STATE_FILE = "task-browser.json";
export const EXIT_FILE = "controller-exit.json";
export const SOCKET_FILE = "control.sock";
export const CONTROLLER_LOG = "controller.log";
export const BROWSER_LOG = "chromium.log";
export const PROFILE_PATTERN = /^profile-[A-Za-z0-9]{6}$/;
const MAX_REQUEST_BYTES = 65536;
const EXIT_NOT_PROVED = 3;

export class ControllerError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

function emit(lines) {
  process.stdout.write(lines.map((line) => line + "\n").join(""));
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** A private, canonical, task-owned directory; refuse anything else. */
export function validateStateDir(stateDir) {
  if (typeof stateDir !== "string" || !isAbsolute(stateDir) || stateDir === "/") {
    throw new ControllerError("invalid-state-dir");
  }
  const info = lstatSync(stateDir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ControllerError("invalid-state-dir");
  if (realpathSync(stateDir) !== stateDir) throw new ControllerError("invalid-state-dir", "not canonical");
  if ((info.mode & 0o777) !== 0o700) throw new ControllerError("invalid-state-dir", "mode must be 0700");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ControllerError("invalid-state-dir", "not owned by this user");
  }
  const home = resolve(homedir());
  if (stateDir === home) throw new ControllerError("invalid-state-dir");
  return stateDir;
}

/** Bundled Chromium only: inside the allowed root, never /Applications. */
export function validateExecutable(executable, allowedRoot) {
  if (typeof executable !== "string" || !isAbsolute(executable)) throw new ControllerError("invalid-executable");
  // Playwright's bundle is "Google Chrome for Testing.app" inside its cache;
  // the installed browser is "Google Chrome.app" under an Applications folder.
  const forbidden = (path) => path === "/Applications" || path.startsWith("/Applications/") ||
    path.includes(`${sep}Applications${sep}`) || path.includes(`${sep}Google Chrome.app${sep}`);
  if (forbidden(executable)) throw new ControllerError("invalid-executable", "installed browser refused");
  const real = realpathSync(executable);
  if (forbidden(real)) throw new ControllerError("invalid-executable", "installed browser refused");
  const root = realpathSync(allowedRoot);
  if (forbidden(root) || root === "/" || root === resolve(homedir())) {
    throw new ControllerError("invalid-executable", "allowed root refused");
  }
  if (!real.startsWith(root + sep)) throw new ControllerError("invalid-executable", "outside allowed root");
  const info = statSync(real);
  if (!info.isFile()) throw new ControllerError("invalid-executable");
  accessSync(real, constants.X_OK);
  return real;
}

/**
 * The only deletion this controller performs: the exact profile it created.
 * Refuses /, the home directory, empty values, symlinks, and any path that is
 * not a direct profile-XXXXXX child of the validated state directory.
 */
export function guardProfilePath(stateDir, profile) {
  if (typeof profile !== "string" || profile === "" || !isAbsolute(profile)) {
    throw new ControllerError("profile-refused", "empty or relative");
  }
  const home = resolve(homedir());
  if (profile === "/" || resolve(profile) === home || resolve(profile) === stateDir) {
    throw new ControllerError("profile-refused", "protected path");
  }
  if (resolve(profile) !== profile || dirname(profile) !== stateDir || !PROFILE_PATTERN.test(basename(profile))) {
    throw new ControllerError("profile-refused", "not a task profile");
  }
  return profile;
}

export function removeProfile(stateDir, profile) {
  guardProfilePath(stateDir, profile);
  let info;
  try {
    info = lstatSync(profile);
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ControllerError("profile-refused", "not a directory");
  if (realpathSync(profile) !== profile) throw new ControllerError("profile-refused", "not canonical");
  rmSync(profile, { recursive: true, force: false });
  if (existsSync(profile)) throw new ControllerError("profile-refused", "still present");
  return "removed";
}

function writePrivateJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function readPrivateJson(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) {
    throw new ControllerError("state-refused");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new ControllerError("state-refused");
  return JSON.parse(readFileSync(path, "utf8"));
}

function readOptionalJson(path) {
  try {
    return readPrivateJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseOptions(argv) {
  const options = { urls: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new ControllerError("usage", `${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--state-dir") options.stateDir = next();
    else if (arg === "--executable") options.executable = next();
    else if (arg === "--allowed-root") options.allowedRoot = next();
    else if (arg === "--max-lifetime-seconds") options.maxLifetimeSeconds = Number(next());
    else if (arg === "--startup-timeout-seconds") options.startupTimeoutSeconds = Number(next());
    else if (arg === "--term-grace-ms") options.termGraceMs = Number(next());
    else if (arg.startsWith("--")) throw new ControllerError("usage", `unknown option ${arg}`);
    else options.urls.push(arg);
  }
  for (const key of ["maxLifetimeSeconds", "startupTimeoutSeconds", "termGraceMs"]) {
    if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key] <= 0)) {
      throw new ControllerError("usage", `${key} must be a positive integer`);
    }
  }
  return options;
}

export function validateProbeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ControllerError("invalid-url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new ControllerError("invalid-url");
  if (parsed.username || parsed.password) throw new ControllerError("invalid-url");
  return parsed.href;
}

async function loopbackJson(endpoint, path, method = "GET") {
  const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new ControllerError("endpoint-down", `status ${response.status}`);
  return response.json();
}

async function verifyEndpoint(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await loopbackJson(endpoint, "/json/version");
  const ws = String(version.webSocketDebuggerUrl ?? "");
  const headless = String(version.Browser ?? "").startsWith("HeadlessChrome/") ||
    String(version["User-Agent"] ?? "").includes("HeadlessChrome/");
  if (!ws.startsWith(`ws://127.0.0.1:${port}/devtools/browser/`) || !headless) {
    throw new ControllerError("endpoint-not-owned");
  }
  return endpoint;
}

/* ------------------------------------------------------------------ serve */

async function serve(options) {
  const stateDir = validateStateDir(options.stateDir);
  const executable = validateExecutable(options.executable,
    options.allowedRoot ?? join(homedir(), "Library/Caches/ms-playwright"));
  const startupMs = (options.startupTimeoutSeconds ?? 20) * 1000;
  const lifetimeMs = (options.maxLifetimeSeconds ?? 18000) * 1000;
  const termGraceMs = options.termGraceMs ?? 10000;
  const statePath = join(stateDir, STATE_FILE);
  const socketPath = join(stateDir, SOCKET_FILE);
  const exitPath = join(stateDir, EXIT_FILE);
  for (const path of [statePath, socketPath, exitPath]) {
    if (existsSync(path)) throw new ControllerError("state-exists");
  }
  const profile = mkdtempSync(join(stateDir, "profile-"));
  chmodSync(profile, 0o700);
  guardProfilePath(stateDir, profile);
  const token = randomBytes(32).toString("hex");
  const state = {
    version: 1, phase: "starting", controller_pid: process.pid,
    controller_started_at: new Date().toISOString(), browser_pid: null, browser_started_at: null,
    executable_path: executable, profile_dir: profile, socket_path: socketPath, endpoint: null, token,
  };

  let browser = null;
  let browserExit = null;
  let shuttingDown = null;
  const browserExited = new Promise((done) => { browserExit = done; });

  async function stopBrowser() {
    if (!browser || browser.exitCode !== null || browser.signalCode !== null) return true;
    const exited = () => browser.exitCode !== null || browser.signalCode !== null;
    // ChildProcess.kill() targets only this controller's own unreaped child.
    browser.kill("SIGTERM");
    await Promise.race([browserExited, sleep(termGraceMs)]);
    if (!exited()) {
      browser.kill("SIGKILL");
      await Promise.race([browserExited, sleep(5000)]);
    }
    return exited();
  }

  const server = createServer({ allowHalfOpen: false });
  function shutdown(reason) {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      const gone = await stopBrowser();
      let profileState = "retained";
      if (gone) {
        try {
          profileState = removeProfile(stateDir, profile);
        } catch {
          profileState = "refused";
        }
      }
      const record = { reason, browser_started: browser !== null, browser_exited: gone,
        profile: profileState, finished_at: new Date().toISOString() };
      writePrivateJson(exitPath, record);
      return record;
    })();
    return shuttingDown;
  }

  async function finish(reason) {
    const record = await shutdown(reason);
    if (!record.browser_exited) {
      // Keep serving: only this live parent can still prove ownership.
      shuttingDown = null;
      try { unlinkSync(exitPath); } catch { /* retried by the next close */ }
      return record;
    }
    // Stop accepting; the in-flight close reply still completes. Removing the
    // socket makes every later connect fail with ENOENT ("controller gone").
    server.close();
    try {
      if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
    } catch { /* already removed */ }
    return record;
  }

  const cleanExit = (record) => record.browser_exited && (record.profile === "removed" || record.profile === "absent");
  function finishAndExit(reason) {
    void finish(reason).then((record) => {
      if (record.browser_exited) process.exit(cleanExit(record) ? 0 : 1);
    });
  }

  async function probe(urls) {
    if (!browser || browser.exitCode !== null || browser.signalCode !== null) {
      return { ok: false, reason: "browser-gone" };
    }
    let endpoint;
    try {
      endpoint = await verifyEndpoint(new URL(state.endpoint).port);
      if (endpoint !== state.endpoint) return { ok: false, reason: "endpoint-not-owned" };
    } catch (error) {
      return { ok: false, reason: error?.code === "endpoint-not-owned" ? "endpoint-not-owned" : "endpoint-down" };
    }
    const results = [];
    for (const url of urls) {
      let status = "NOT_PROVED";
      let target = null;
      try {
        target = await loopbackJson(endpoint, `/json/new?${encodeURIComponent(url)}`, "PUT");
        const requested = new URL(url);
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const list = await loopbackJson(endpoint, "/json/list");
          const seen = list.find((item) => item.id === target.id);
          if (seen?.url && seen.title && seen.title !== seen.url &&
            new URL(seen.url).origin === requested.origin) {
            status = "LOADED";
            break;
          }
          await sleep(250);
        }
      } catch {
        status = "NOT_PROVED";
      } finally {
        if (target?.id && /^[A-Za-z0-9-]+$/.test(target.id)) {
          try { await fetch(`${endpoint}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }); } catch { /* best effort */ }
        }
      }
      results.push({ url, status });
    }
    const ok = results.every((item) => item.status === "LOADED");
    return { ok, reason: ok ? "" : "url-not-loaded", endpoint, results };
  }

  const expectedToken = Buffer.from(token, "utf8");
  server.on("connection", (socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.setTimeout(60000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      buffered += chunk;
      if (buffered.length > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      const reply = (value) => socket.end(JSON.stringify(value) + "\n");
      let request;
      try {
        request = JSON.parse(buffered.slice(0, newline));
      } catch {
        reply({ ok: false, reason: "bad-request" });
        return;
      }
      const offered = Buffer.from(String(request?.token ?? ""), "utf8");
      if (offered.length !== expectedToken.length || !timingSafeEqual(offered, expectedToken)) {
        reply({ ok: false, reason: "unauthorized" });
        return;
      }
      if (request.op === "probe") {
        let urls;
        try {
          urls = (Array.isArray(request.urls) ? request.urls : []).map(validateProbeUrl);
        } catch {
          reply({ ok: false, reason: "invalid-url" });
          return;
        }
        reply(await probe(urls));
      } else if (request.op === "close") {
        const record = await finish("close");
        const value = { ok: cleanExit(record),
          reason: record.browser_exited ? `profile-${record.profile}` : "browser-still-alive", record };
        if (!record.browser_exited) { reply(value); return; }
        socket.end(JSON.stringify(value) + "\n", () => process.exit(cleanExit(record) ? 0 : 1));
      } else {
        reply({ ok: false, reason: "bad-request" });
      }
    });
  });

  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(socketPath, () => { server.off("error", fail); done(); });
  });
  chmodSync(socketPath, 0o600);
  writePrivateJson(statePath, state);

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => finishAndExit(`signal-${signal}`));
  }
  const lifetime = setTimeout(() => finishAndExit("lifetime"), lifetimeMs);
  lifetime.unref();

  const browserLog = openSync(join(stateDir, BROWSER_LOG), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  const args = [
    "--headless", "--no-sandbox", `--user-data-dir=${profile}`, "--password-store=basic", "--use-mock-keychain",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--no-first-run", "--no-default-browser-check", "about:blank",
  ];
  browser = spawn(executable, args, { stdio: ["ignore", browserLog, browserLog], detached: false });
  closeSync(browserLog);
  browser.once("exit", () => {
    browserExit();
    if (!shuttingDown) finishAndExit("browser-exited");
  });
  browser.once("error", () => {
    browserExit();
    if (!shuttingDown) finishAndExit("browser-spawn-failed");
  });
  state.browser_pid = browser.pid ?? null;
  state.browser_started_at = new Date().toISOString();
  writePrivateJson(statePath, state);

  // Chromium writes the chosen port to DevToolsActivePort in its profile.
  const deadline = Date.now() + startupMs;
  let endpoint = null;
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
      if (/^[1-9][0-9]{0,4}$/.test(port)) endpoint = await verifyEndpoint(port);
      if (endpoint) break;
    } catch { /* not ready yet */ }
    await sleep(100);
  }
  if (!endpoint) {
    if (!shuttingDown) finishAndExit("startup-timeout");
    return;
  }
  state.endpoint = endpoint;
  state.phase = "ready";
  writePrivateJson(statePath, state);
}

/* ----------------------------------------------------------------- client */

function request(socketPath, message, timeoutMs) {
  return new Promise((done, fail) => {
    const socket = createConnection(socketPath);
    let buffered = "";
    const timer = setTimeout(() => { socket.destroy(); fail(new ControllerError("controller-timeout")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("data", (chunk) => { buffered += chunk; });
    socket.on("error", (error) => { clearTimeout(timer); fail(error); });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        done(JSON.parse(buffered));
      } catch {
        fail(new ControllerError("bad-response"));
      }
    });
  });
}

/** Resolves true when nothing listens on the controller socket. */
function controllerGone(socketPath) {
  return new Promise((done, fail) => {
    const socket = createConnection(socketPath);
    socket.on("connect", () => { socket.destroy(); done(false); });
    socket.on("error", (error) => {
      if (error?.code === "ENOENT" || error?.code === "ECONNREFUSED") done(true);
      else fail(error);
    });
  });
}

function loadState(stateDir) {
  const state = readOptionalJson(join(stateDir, STATE_FILE));
  if (state === null) return null;
  if (state.version !== 1 || typeof state.token !== "string" || state.socket_path !== join(stateDir, SOCKET_FILE)) {
    throw new ControllerError("state-refused");
  }
  guardProfilePath(stateDir, state.profile_dir);
  return state;
}

/** Existence probe only: signal 0 delivers nothing. ESRCH is the only "gone". */
function pidGone(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function start(options) {
  const stateDir = validateStateDir(options.stateDir);
  validateExecutable(options.executable, options.allowedRoot ?? join(homedir(), "Library/Caches/ms-playwright"));
  for (const name of [STATE_FILE, SOCKET_FILE, EXIT_FILE]) {
    if (existsSync(join(stateDir, name))) throw new ControllerError("state-exists");
  }
  const logFd = openSync(join(stateDir, CONTROLLER_LOG), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  const passthrough = [];
  for (const [flag, key] of [["--executable", "executable"], ["--allowed-root", "allowedRoot"],
    ["--max-lifetime-seconds", "maxLifetimeSeconds"], ["--startup-timeout-seconds", "startupTimeoutSeconds"],
    ["--term-grace-ms", "termGraceMs"]]) {
    if (options[key] !== undefined) passthrough.push(flag, String(options[key]));
  }
  // detached: the controller leaves the block's process group, so ending a
  // marked block never stops it; only close (or its lifetime cap) does.
  const controller = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--state-dir", stateDir, ...passthrough],
    { detached: true, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  let controllerExited = false;
  controller.once("exit", () => { controllerExited = true; });
  const deadline = Date.now() + ((options.startupTimeoutSeconds ?? 20) + 10) * 1000;
  while (Date.now() < deadline) {
    if (existsSync(join(stateDir, EXIT_FILE)) || controllerExited) break;
    const state = existsSync(join(stateDir, STATE_FILE)) ? loadState(stateDir) : null;
    if (state?.phase === "ready") {
      const reply = await request(state.socket_path, { token: state.token, op: "probe", urls: [] }, 15000);
      if (reply.ok) {
        controller.unref();
        emit([`TASK_BROWSER=STARTED`, `TASK_BROWSER_ENDPOINT=${reply.endpoint}`]);
        return 0;
      }
      break;
    }
    await sleep(100);
  }
  // Startup failed: stop only the controller this command launched; its
  // handler stops its own browser child and removes its profile.
  if (!controllerExited && controller.exitCode === null && controller.signalCode === null) {
    controller.kill("SIGTERM");
    await new Promise((done) => { controller.once("exit", done); setTimeout(done, 20000).unref(); });
  }
  controller.unref();
  emit(["TASK_BROWSER=FAILED reason=startup"]);
  return 1;
}

async function probeCommand(options) {
  const fail = (reason) => { emit([`TASK_BROWSER_PROBE=NOT_PROVED reason=${reason}`]); return EXIT_NOT_PROVED; };
  let stateDir;
  let state;
  try {
    stateDir = validateStateDir(options.stateDir);
    state = loadState(stateDir);
  } catch {
    return fail("no-task-browser");
  }
  if (!state || state.phase !== "ready") return fail("no-task-browser");
  let urls;
  try {
    urls = options.urls.map(validateProbeUrl);
  } catch {
    return fail("invalid-url");
  }
  let reply;
  try {
    reply = await request(state.socket_path, { token: state.token, op: "probe", urls }, 45000 + urls.length * 35000);
  } catch (error) {
    return fail(error?.code === "ENOENT" || error?.code === "ECONNREFUSED" ? "controller-gone" : "controller-unreachable");
  }
  const lines = [];
  for (const item of reply.results ?? []) lines.push(`probe_url=${item.status} ${item.url}`);
  if (!reply.ok) {
    emit(lines);
    return fail(/^[a-z-]+$/.test(String(reply.reason)) ? reply.reason : "browser-check-failed");
  }
  emit([...lines, `TASK_BROWSER_ENDPOINT=${reply.endpoint}`, "TASK_BROWSER_PROBE=PASS"]);
  return 0;
}

async function closeCommand(options) {
  const stop = (reason) => {
    emit([`TASK_BROWSER_CLOSE=STOP reason=${reason}; nothing signalled; retain private staging for HezLead`]);
    return 1;
  };
  if (typeof options.stateDir !== "string" || !isAbsolute(options.stateDir)) return stop("invalid-state-dir");
  if (!existsSync(options.stateDir)) {
    emit(["TASK_BROWSER_CLOSE=PASS state=no-state-dir"]);
    return 0;
  }
  let stateDir;
  let state;
  let exitRecord;
  try {
    stateDir = validateStateDir(options.stateDir);
    state = loadState(stateDir);
    exitRecord = readOptionalJson(join(stateDir, EXIT_FILE));
  } catch (error) {
    return stop(error instanceof ControllerError ? error.code : "state-unreadable");
  }
  if (state === null) {
    // Nothing reached the point of launching; a controller that died before
    // writing state never spawned a browser (state precedes the spawn).
    emit(["TASK_BROWSER_CLOSE=PASS state=never-started"]);
    return 0;
  }
  let gone;
  try {
    gone = await controllerGone(state.socket_path);
  } catch {
    return stop("controller-unreachable");
  }
  if (!gone) {
    let reply;
    try {
      reply = await request(state.socket_path, { token: state.token, op: "close" }, 60000);
    } catch {
      return stop("controller-close-failed");
    }
    if (!reply.ok) return stop(/^[a-z-]+$/.test(String(reply.reason)) ? reply.reason : "controller-close-failed");
    const deadline = Date.now() + 15000;
    while (!(await controllerGone(state.socket_path))) {
      if (Date.now() > deadline) return stop("controller-still-running");
      await sleep(100);
    }
    exitRecord = readOptionalJson(join(stateDir, EXIT_FILE));
    if (!exitRecord?.browser_exited) return stop("browser-exit-unproved");
    if (existsSync(state.profile_dir)) return stop("profile-still-present");
    emit(["TASK_BROWSER_CLOSE=PASS state=closed"]);
    return 0;
  }
  // Controller gone. Its exit record proves its child exited; otherwise the
  // recorded browser PID must be absent (signal-0 existence probe, ESRCH).
  if (!(exitRecord?.browser_exited === true || state.browser_pid === null || pidGone(state.browser_pid))) {
    return stop("controller-gone-browser-pid-present");
  }
  try {
    removeProfile(stateDir, state.profile_dir);
  } catch {
    return stop("profile-refused");
  }
  emit(["TASK_BROWSER_CLOSE=PASS state=already-gone"]);
  return 0;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    const options = parseOptions(rest);
    if (command === "start") return await start(options);
    if (command === "serve") { await serve(options); return null; }
    if (command === "probe") return await probeCommand(options);
    if (command === "close") return await closeCommand(options);
    throw new ControllerError("usage");
  } catch (error) {
    const code = error instanceof ControllerError ? error.code : error?.code === "ENOENT" ? "missing-path" : "unexpected";
    emit([`TASK_BROWSER=FAILED reason=${code}`]);
    return command === "probe" ? EXIT_NOT_PROVED : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const status = await main(process.argv.slice(2));
  if (status !== null) process.exit(status);
}
