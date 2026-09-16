import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

export function summarize(values, budgetMs) {
  const p50 = percentile(values, 0.50);
  const p95 = percentile(values, 0.95);
  const max = values.length === 0 ? null : Math.max(...values);
  const headroom = p95 === null || p95 === 0 ? null : budgetMs / p95;
  return { runs: values.length, p50, p95, max, headroom,
    gate: headroom === null ? "NOT RUN" : headroom >= 2 ? "PASS" : "FAIL" };
}

async function copyPrivateDirectory(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error("profile directory contains a symbolic link");
    if (entry.isDirectory()) await copyPrivateDirectory(from, to);
    else if (entry.isFile()) {
      await writeFile(to, await readFile(from), { mode: 0o600, flag: "wx" });
      await chmod(to, 0o600);
    }
  }
}

export async function makePrivateProfileCopy(profilePath, options = {}) {
  const sourceProfile = resolve(profilePath);
  const sourceDirectory = dirname(sourceProfile);
  const info = await lstat(sourceProfile);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("profile must be a regular file");
  const root = await mkdtemp(join(options.tempParent ?? tmpdir(), "cswarm-timeout-table-"));
  await chmod(root, 0o700);
  const copyDirectory = join(root, "profile");
  try {
    await copyPrivateDirectory(sourceDirectory, copyDirectory);
    const copyProfile = join(copyDirectory, basename(sourceProfile));
    const parsed = JSON.parse(await readFile(copyProfile, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.url !== "string" ||
        typeof parsed.credential_file !== "string") throw new Error("profile has no URL or credential file");
    const credentialName = basename(parsed.credential_file);
    parsed.credential_file = join(copyDirectory, credentialName);
    // A copied durable artifact must not renew. Renewal supersedes the original
    // credential on the server, and the successor would be deleted with this copy.
    // expires_at is optional in the artifact grammar; without it, bearer() uses the
    // presented token and never enters renewal.
    const credentialRaw = await readFile(parsed.credential_file, "utf8");
    try {
      const artifact = JSON.parse(credentialRaw);
      if (artifact && typeof artifact === "object" && !Array.isArray(artifact) &&
          Object.hasOwn(artifact, "expires_at")) {
        delete artifact.expires_at;
        await writeFile(parsed.credential_file, JSON.stringify(artifact), { mode: 0o600 });
      }
    } catch {
      // Legacy bare tokens are deliberately not JSON and already cannot auto-renew.
    }
    await writeFile(copyProfile, JSON.stringify(parsed), { mode: 0o600 });
    await chmod(copyProfile, 0o600);
    return {
      root,
      profilePath: copyProfile,
      profile: parsed,
      async remove() { await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function withPrivateProfile(profilePath, run, options = {}) {
  const copy = await makePrivateProfileCopy(profilePath, options);
  try { return await run(copy); }
  finally { await copy.remove(); }
}

export async function runChild(command, args, options = {}) {
  const started = performance.now();
  return await new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", options.capture ? "pipe" : "ignore", options.capture ? "pipe" : "ignore"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr?.on("data", chunk => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({
      code: code ?? (signal ? 128 : 1),
      signal,
      durationMs: performance.now() - started,
      stdout,
      stderr,
    }));
  });
}

export function clientInvocation(client, args) {
  return /\.(?:cjs|mjs|js)$/.test(client)
    ? { command: process.execPath, args: [resolve(client), ...args] }
    : { command: resolve(client), args };
}

export async function readJsonLines(path) {
  const raw = await readFile(path, "utf8").catch(error => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
}
