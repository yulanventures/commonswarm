import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControllerError, guardProfilePath, removeProfile } from "../scripts/site-task-browser.mjs";

// The controller is exercised only against a fake browser executable written
// here: no real Chromium or installed Chrome is ever launched by this suite.
const SCRIPT = join(process.cwd(), "scripts/site-task-browser.mjs");

function makeRoot(): string {
  const root = realpathSync(mkdtempSync("/private/tmp/site-task-browser-"));
  assert.match(root, /^\/private\/tmp\/site-task-browser-[A-Za-z0-9]{6}$/);
  return root;
}
function cleanup(root: string) {
  assert.match(root, /^\/private\/tmp\/site-task-browser-[A-Za-z0-9]{6}$/);
  const result = spawnSync("rm", ["-rf", "--", root], { encoding: "utf8" });
  assert.equal(result.status, 0, `guarded cleanup refused ${root}: ${result.stderr}`);
}

const FAKE = String.raw`
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const args = process.argv.slice(2);
const mode = process.env.FAKE_CHROME_MODE || "normal";
if (process.env.FAKE_CHROME_RECORD) fs.writeFileSync(process.env.FAKE_CHROME_RECORD, JSON.stringify({ pid: process.pid, args }));
if (mode === "exit-early") process.exit(1);
process.on("SIGTERM", () => { if (mode !== "ignore-term") process.exit(0); });
const profile = args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
const targets = new Map();
let next = 0;
let port = 0;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (url.pathname === "/json/version") {
    const browser = mode === "not-headless" ? "Chrome/140.0.0.0" : "HeadlessChrome/140.0.0.0";
    return json({ Browser: browser, "User-Agent": "Mozilla/5.0 " + browser,
      webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/browser/fake" });
  }
  if (url.pathname === "/json/new") {
    if (request.method !== "PUT") return json({ error: "PUT required" }, 405);
    const target = { id: "T" + (++next), url: decodeURIComponent(url.search.slice(1)), title: "" };
    targets.set(target.id, target);
    if (mode !== "url-fails") setTimeout(() => { target.title = "Loaded page"; }, 50);
    return json(target);
  }
  if (url.pathname === "/json/list") return json([...targets.values()]);
  if (url.pathname.startsWith("/json/close/")) { targets.delete(url.pathname.slice(12)); response.end("Target is closing"); return; }
  json({}, 404);
});
if (mode === "never-listen") setInterval(() => {}, 1000);
else server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  fs.writeFileSync(path.join(profile, "DevToolsActivePort"), port + "\n/devtools/browser/fake");
  if (mode === "exit-after-ready") setTimeout(() => process.exit(0), 1500);
});
`;

interface Fixture { root: string; stateDir: string; browserRoot: string; executable: string; record: string }
function fixture(): Fixture {
  const root = makeRoot();
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const browserRoot = join(root, "bundled");
  // Same shape as Playwright's real macOS bundle name, which must be accepted.
  const macos = join(browserRoot, "chromium-1", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(browserRoot, "chromium-1", "Google Chrome.app"));
  const executable = join(macos, "headless-fake");
  writeFileSync(executable, `#!${process.execPath}\n${FAKE}`, { mode: 0o755 });
  return { root, stateDir, browserRoot, executable, record: join(root, "fake-record.json") };
}

function cli(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8", env: { ...process.env, ...env }, timeout: 90000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}
function start(f: Fixture, mode = "normal", extra: string[] = []) {
  return cli(["start", "--state-dir", f.stateDir, "--executable", f.executable, "--allowed-root", f.browserRoot,
    "--term-grace-ms", "300", ...extra], { FAKE_CHROME_MODE: mode, FAKE_CHROME_RECORD: f.record });
}
const close = (f: Fixture) => cli(["close", "--state-dir", f.stateDir]);
const probe = (f: Fixture, ...urls: string[]) => cli(["probe", "--state-dir", f.stateDir, ...urls]);
function state(f: Fixture) {
  return JSON.parse(readFileSync(join(f.stateDir, "task-browser.json"), "utf8")) as Record<string, unknown>;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function waitFor(check: () => boolean, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, "condition not reached in time");
    await new Promise((done) => setTimeout(done, 50));
  }
}
function finish(f: Fixture) {
  try { close(f); } finally { cleanup(f.root); }
}

test("start owns one bundled-only browser, probe reuses it, and close is idempotent", async () => {
  const f = fixture();
  try {
    const started = start(f);
    assert.equal(started.status, 0, started.out);
    assert.match(started.out, /^TASK_BROWSER=STARTED\nTASK_BROWSER_ENDPOINT=http:\/\/127\.0\.0\.1:[0-9]+\n$/);
    const saved = state(f);
    assert.equal(statSync(join(f.stateDir, "task-browser.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.stateDir, "control.sock")).mode & 0o777, 0o600);
    assert.match(String(saved.token), /^[0-9a-f]{64}$/);
    assert.ok(!started.out.includes(String(saved.token)), "start must never print the token");
    for (const key of ["controller_pid", "browser_pid", "browser_started_at", "executable_path", "profile_dir"]) {
      assert.ok(saved[key], `state records ${key}`);
    }
    const profile = String(saved.profile_dir);
    assert.match(profile, new RegExp(`^${f.stateDir}/profile-[A-Za-z0-9]{6}$`));
    assert.equal(statSync(profile).mode & 0o777, 0o700);
    const launched = JSON.parse(readFileSync(f.record, "utf8")) as { pid: number; args: string[] };
    assert.equal(launched.pid, saved.browser_pid);
    assert.equal(saved.executable_path, realpathSync(f.executable));
    for (const flag of ["--headless", "--no-sandbox", `--user-data-dir=${profile}`, "--password-store=basic",
      "--use-mock-keychain", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"]) {
      assert.ok(launched.args.includes(flag), `browser launched with ${flag}`);
    }
    // The controller is the browser's parent; it left the caller's process group.
    assert.ok(alive(Number(saved.controller_pid)) && alive(launched.pid));

    const probed = probe(f, "https://commonswarm.com/app");
    assert.equal(probed.status, 0, probed.out);
    assert.match(probed.out, /probe_url=LOADED https:\/\/commonswarm\.com\/app\n/);
    assert.match(probed.out, /TASK_BROWSER_PROBE=PASS/);
    assert.ok(!probed.out.includes(String(saved.token)));
    // A second start never launches a second browser into the same state.
    assert.notEqual(start(f).status, 0);
    assert.equal(JSON.parse(readFileSync(f.record, "utf8")).pid, launched.pid);

    const closed = close(f);
    assert.equal(closed.status, 0, closed.out);
    assert.match(closed.out, /TASK_BROWSER_CLOSE=PASS state=closed/);
    await waitFor(() => !alive(launched.pid));
    assert.ok(!existsSync(profile), "close removes the exact profile it created");
    assert.ok(!existsSync(join(f.stateDir, "control.sock")));
    assert.equal(JSON.parse(readFileSync(join(f.stateDir, "controller-exit.json"), "utf8")).browser_exited, true);

    const again = close(f);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /TASK_BROWSER_CLOSE=PASS state=already-gone/);
    const after = probe(f);
    assert.equal(after.status, 3);
    assert.match(after.out, /TASK_BROWSER_PROBE=NOT_PROVED reason=controller-gone/);
    cleanup(f.root);
    const missing = close(f);
    assert.equal(missing.status, 0, missing.out);
    assert.match(missing.out, /TASK_BROWSER_CLOSE=PASS state=no-state-dir/);
  } finally {
    if (existsSync(f.root)) finish(f);
  }
});

test("close escalates only through the controller's own child handle", async () => {
  const f = fixture();
  try {
    assert.equal(start(f, "ignore-term").status, 0);
    const pid = Number(state(f).browser_pid);
    const closed = close(f);
    assert.equal(closed.status, 0, closed.out);
    await waitFor(() => !alive(pid));
    assert.ok(!existsSync(String(state(f).profile_dir)));
  } finally { finish(f); }
});

test("a browser that exits on its own leaves a passing close and a NOT_PROVED probe", async () => {
  const f = fixture();
  try {
    assert.equal(start(f, "exit-after-ready").status, 0);
    const saved = state(f);
    await waitFor(() => !existsSync(join(f.stateDir, "control.sock")) && !alive(Number(saved.controller_pid)));
    const probed = probe(f, "https://commonswarm.com/app");
    assert.equal(probed.status, 3);
    assert.match(probed.out, /TASK_BROWSER_PROBE=NOT_PROVED reason=controller-gone/);
    const closed = close(f);
    assert.equal(closed.status, 0, closed.out);
    assert.match(closed.out, /TASK_BROWSER_CLOSE=PASS state=already-gone/);
    assert.ok(!existsSync(String(saved.profile_dir)));
  } finally { finish(f); }
});

test("startup failures leave no controller, browser or profile behind", async () => {
  for (const [mode, extra] of [["exit-early", []], ["never-listen", ["--startup-timeout-seconds", "1"]],
    ["not-headless", ["--startup-timeout-seconds", "1"]]] as const) {
    const f = fixture();
    try {
      const started = start(f, mode, [...extra]);
      assert.equal(started.status, 1, `${mode}: ${started.out}`);
      assert.match(started.out, /TASK_BROWSER=FAILED reason=startup/);
      const launched = JSON.parse(readFileSync(f.record, "utf8")) as { pid: number };
      await waitFor(() => !alive(launched.pid));
      await waitFor(() => !existsSync(join(f.stateDir, "control.sock")));
      const closed = close(f);
      assert.equal(closed.status, 0, `${mode}: ${closed.out}`);
      const profiles = spawnSync("find", [f.stateDir, "-maxdepth", "1", "-name", "profile-*"], { encoding: "utf8" });
      assert.equal(profiles.stdout, "", `${mode}: profile removed`);
    } finally { finish(f); }
  }
});

test("close never signals a recorded PID it cannot prove it owns", async () => {
  const f = fixture();
  // A live process this test owns stands in for a reused or orphaned PID.
  const bystander = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    const profile = join(f.stateDir, "profile-AbC123");
    mkdirSync(profile, { mode: 0o700 });
    writeFileSync(join(f.stateDir, "task-browser.json"), JSON.stringify({
      version: 1, phase: "ready", controller_pid: 999999, browser_pid: bystander.pid, executable_path: f.executable,
      profile_dir: profile, socket_path: join(f.stateDir, "control.sock"), endpoint: "http://127.0.0.1:9", token: "a".repeat(64),
    }), { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const closed = close(f);
      assert.equal(closed.status, 1, closed.out);
      assert.match(closed.out, /TASK_BROWSER_CLOSE=STOP reason=controller-gone-browser-pid-present; nothing signalled/);
    }
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(bystander.exitCode, null);
    assert.equal(bystander.signalCode, null, "the unverified PID received no signal");
    assert.ok(existsSync(profile), "unproved ownership retains the profile");
    const probed = probe(f, "https://commonswarm.com/app");
    assert.equal(probed.status, 3);
    assert.match(probed.out, /NOT_PROVED reason=controller-gone/);
  } finally {
    bystander.kill("SIGTERM");
    cleanup(f.root);
  }
});

test("the control socket refuses a wrong token and keeps the browser", async () => {
  const f = fixture();
  try {
    assert.equal(start(f).status, 0);
    const reply = await new Promise<string>((done, fail) => {
      const socket = createConnection(join(f.stateDir, "control.sock"));
      let data = "";
      socket.on("connect", () => socket.write(JSON.stringify({ token: "b".repeat(64), op: "close" }) + "\n"));
      socket.on("data", (chunk) => { data += chunk; });
      socket.on("end", () => done(data));
      socket.on("error", fail);
    });
    assert.equal(JSON.parse(reply).reason, "unauthorized");
    assert.ok(alive(Number(state(f).browser_pid)));
    assert.equal(probe(f).status, 0);
  } finally { finish(f); }
});

test("start refuses installed Chrome, paths outside the bundled root, and unsafe state directories", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "chrome"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(f.browserRoot, "chromium-1", "Google Chrome.app", "chrome"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync(join(outside, "chrome"), join(f.browserRoot, "chromium-1", "linked"));
    const attempts: [string, string][] = [
      ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications"],
      ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", f.browserRoot],
      [join(outside, "chrome"), f.browserRoot],
      [join(f.browserRoot, "chromium-1", "linked"), f.browserRoot],
      [join(f.browserRoot, "chromium-1", "Google Chrome.app", "chrome"), f.browserRoot],
      [f.executable, "/Applications"],
    ];
    for (const [executable, allowedRoot] of attempts) {
      const result = cli(["start", "--state-dir", f.stateDir, "--executable", executable, "--allowed-root", allowedRoot]);
      assert.equal(result.status, 1, `${executable}: ${result.out}`);
      assert.match(result.out, /TASK_BROWSER=FAILED reason=(?:invalid-executable|missing-path)/);
      assert.ok(!existsSync(join(f.stateDir, "task-browser.json")), "nothing launched");
    }
    chmodSync(f.stateDir, 0o755);
    const loose = start(f);
    assert.match(loose.out, /reason=invalid-state-dir/);
    chmodSync(f.stateDir, 0o700);
    symlinkSync(f.stateDir, join(f.root, "state-link"));
    const linked = cli(["start", "--state-dir", join(f.root, "state-link"), "--executable", f.executable,
      "--allowed-root", f.browserRoot]);
    assert.match(linked.out, /reason=invalid-state-dir/);
    assert.ok(!existsSync(f.record), "no browser was launched by a refused start");
  } finally { finish(f); }
});

test("profile deletion guard refuses everything but the task's own profile", () => {
  const root = makeRoot();
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    const refused = ["", "relative/profile-abcdef", "/", homedir(), stateDir, root, join(root, "profile-abcdef"),
      join(stateDir, "profile-abc"), join(stateDir, "other-abcdef"), `${stateDir}/x/../profile-abcdef`];
    for (const profile of refused) {
      assert.throws(() => guardProfilePath(stateDir, profile),
        (error: unknown) => error instanceof ControllerError && error.code === "profile-refused", profile);
    }
    // A symlink with a valid name never leads deletion outside the state dir.
    const victim = join(root, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep"), "x");
    symlinkSync(victim, join(stateDir, "profile-Link12"));
    assert.throws(() => removeProfile(stateDir, join(stateDir, "profile-Link12")), ControllerError);
    assert.ok(existsSync(join(victim, "keep")));
    // Valid-delete control.
    const valid = join(stateDir, "profile-Ok1234");
    mkdirSync(join(valid, "Default"), { recursive: true });
    assert.equal(removeProfile(stateDir, valid), "removed");
    assert.ok(!existsSync(valid));
    assert.equal(removeProfile(stateDir, valid), "absent");
  } finally { cleanup(root); }
});

test("controller source uses no process-table or setuid tools and signals only its own children", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const code = source.replace(/^\s*(?:\/\/|\*|\/\*\*).*$/gm, "");
  assert.doesNotMatch(code, /["'`](?:\/bin\/)?(?:ps|pgrep|pkill|lsof|killall|sudo|su|top)["'`]/);
  assert.doesNotMatch(code, /\bexecSync\b|\bexec\(|shell:\s*true/);
  // process.kill on a number is only ever the signal-0 existence probe.
  assert.deepEqual([...code.matchAll(/process\.kill\(([^)]*)\)/g)].map((m) => m[1]), ["pid, 0"]);
  // Every delivered signal goes through a ChildProcess handle this process spawned.
  assert.deepEqual([...new Set([...code.matchAll(/(\w+)\.kill\(/g)].map((m) => m[1]))].sort(),
    ["browser", "controller", "process"]);
  assert.match(code, /browser = spawn\(executable, args, \{[^}]*detached: false/);
  assert.match(code, /Library\/Caches\/ms-playwright/);
});
