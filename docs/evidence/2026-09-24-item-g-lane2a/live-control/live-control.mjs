// Lead live control for item G lane 2a: run the SHIPPED bundle (copied outside the repo) against a loopback fake
// read service with an empty inbox. Run 1: close only the stdout reader and time the exit. Run 2: SIGTERM.
// Usage: node live-control.mjs <path-to-cswarm-bundle>
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2];
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const credential = JSON.stringify({
  message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.", status: "accepted",
  principal_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  token_id: "33333333-3333-4333-8333-333333333333", run_id: "44444444-4444-4444-8444-444444444444",
  agent_token: `swm_agt_${"A".repeat(43)}`, expires_at: "2030-01-01T00:00:00.000Z",
});

async function run(mode) {
  const root = await mkdtemp(join(tmpdir(), "g2a-live-"));
  let requests = 0; let firstRead; const read = new Promise((r) => { firstRead = r; });
  const server = createServer((req, res) => {
    req.resume(); req.on("end", () => {
      requests += 1;
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 } }));
      firstRead();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const cred = join(root, "agent.json");
  await writeFile(cred, credential, { mode: 0o600 });
  const env = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state") };
  delete env.CSWARM_TEST_NOTIFY_CHECK_MS; delete env.NODE_ENV;
  const child = spawn(bin, ["inbox", "--notify", "--agent-token-file", cred, "--url", url,
    "--anon-key", "anon-live", "--workspace-id", WORKSPACE], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; let stdout = "";
  child.stderr.setEncoding("utf8").on("data", (c) => { stderr += c; });
  child.stdout.setEncoding("utf8").on("data", (c) => { stdout += c; });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const killer = setTimeout(() => child.kill("SIGKILL"), 150_000);
  const early = await Promise.race([read.then(() => null), exited]);
  if (early) {
    clearTimeout(killer); await new Promise((r) => server.close(r)); await rm(root, { recursive: true, force: true });
    return { mode, early_exit: early, requests, stderr: stderr.trim().slice(0, 400) };
  }
  let fd1 = "";
  try { fd1 = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(child.pid), "-d", "1", "-F", "tn"], { encoding: "utf8" }); } catch {}
  if (mode === "orphan-late") await new Promise((r) => setTimeout(r, 5_000));
  const t0 = Date.now();
  if (mode.startsWith("orphan")) child.stdout.destroy(); else child.kill("SIGTERM");
  const result = await exited;
  clearTimeout(killer);
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
  return { mode, fd1_before: fd1.trim().split("\n").join(" "), exit: result, seconds: ((Date.now() - t0) / 1000).toFixed(1),
    requests, stdout_bytes: stdout.length, stderr: stderr.trim() };
}

for (const mode of (process.argv[3] ?? "orphan,sigterm").split(",")) console.log(JSON.stringify(await run(mode)));
