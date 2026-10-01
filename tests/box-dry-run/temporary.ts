import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const root = realpathSync(tmpdir());
const runPrefix = "commonswarm-box-dry-run-";
const owned = new Map<string, { prefix: string; identity?: { dev: number; ino: number } }>();
const refused = new Set<string>();
// Resolve the host command before any fixture PATH can be used. The Mac host
// puts its rm guard first; cleanup never falls back to an unguarded command.
const located = spawnSync("/bin/sh", ["-c", "command -v rm"], { encoding: "utf8", env: process.env });
assert.equal(located.status, 0, located.stderr);
const remover = located.stdout.trim();
assert.ok(isAbsolute(remover), "host rm must resolve to an absolute path");
if (process.platform === "darwin") {
  assert.equal(resolve(remover), join(userInfo().homedir, ".local/bin/rm"), "host rm guard must be first in PATH");
}

// Keep the caller's prefix for normal-cleanup validation, but put every
// mkdtemp-owned directory in one discoverable, invocation-owned namespace.
export function createTemporary(prefix: string): string {
  assert.equal(realpathSync(dirname(resolve(prefix))), root, "temporary parent must be the resolved OS temp directory");
  const name = basename(prefix);
  assert.match(name, /^[A-Za-z0-9-]+-$/);
  const registration: { prefix: string; identity?: { dev: number; ino: number } } = { prefix: name };
  const path = mkdtempSync(join(root, name.startsWith(runPrefix) ? name : runPrefix + name));
  owned.set(path, registration); // before metadata checks or any caller setup
  const entry = lstatSync(path);
  registration.identity = { dev: entry.dev, ino: entry.ino };
  return path;
}

export function removeTemporary(path: string, prefix: string): void {
  const absolute = resolve(path);
  assert.equal(owned.has(absolute), true, `REFUSE cleanup of unowned temporary: ${absolute}`);
  const registration = owned.get(absolute)!;
  assert.ok(registration.prefix.startsWith(prefix), `temporary prefix differs: ${absolute}`);
  assert.equal(realpathSync(dirname(absolute)), root);
  assert.ok(basename(absolute).startsWith(runPrefix));
  assert.equal(refused.has(absolute), false, `guarded cleanup previously refused: ${absolute}`);
  const entry = lstatSync(absolute, { throwIfNoEntry: false });
  if (entry) {
    assert.equal(entry.isDirectory() && !entry.isSymbolicLink(), true, `REFUSE replaced temporary: ${absolute}`);
    assert.deepEqual({ dev: entry.dev, ino: entry.ino }, registration.identity, `REFUSE replaced temporary: ${absolute}`);
    const removed = spawnSync(remover, ["-R", "-f", "--", absolute], { encoding: "utf8", env: process.env });
    if (removed.status !== 0 || existsSync(absolute)) {
      refused.add(absolute);
      throw new Error(`guarded cleanup refused ${absolute}: ${removed.stderr || removed.error?.message || `exit ${removed.status}`}`);
    }
  }
  owned.delete(absolute);
}

// A caller can catch setup errors and continue the suite. Remove that setup's
// allocations immediately, rather than accumulating them until process exit.
export function withTemporarySetup<T>(setup: () => T): T {
  const before = new Set(owned.keys());
  try { return setup(); }
  catch (error) {
    for (const [path, registration] of owned) if (!before.has(path)) removeTemporary(path, registration.prefix);
    throw error;
  }
}

function cleanRemaining(): boolean {
  let ok = true;
  for (const [path, registration] of owned) {
    if (refused.has(path)) { ok = false; continue; }
    try { removeTemporary(path, registration.prefix); }
    catch (error) { ok = false; process.stderr.write(`${String(error)}\n`); }
  }
  return ok;
}

process.once("exit", () => { if (!cleanRemaining()) process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (!cleanRemaining()) process.exit(1);
    // Preserve interruption as interruption, including the OS signal status.
    process.kill(process.pid, signal);
  });
}
