import { open, unlink } from "node:fs/promises";
import { hostname } from "node:os";

const lockPath = process.argv[2];
if (!lockPath) throw new Error("lock path is required");

const handle = await open(lockPath, "wx", 0o600);
await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(),
  createdAt: Date.now(), startTime: Date.now() - process.uptime() * 1_000 }), "utf8");
process.stdout.write("ready\n");
process.stdin.resume();

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await handle.close();
  await unlink(lockPath).catch(() => undefined);
}

process.stdin.once("end", async () => {
  await cleanup();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});
