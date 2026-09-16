#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const distRoot = resolve(repoRoot, "site/dist");
const outputPath = resolve(here, "vercel-reference.json");
const baseUrl = "https://commonswarm.com";
const recordedHeaders = [
  "strict-transport-security",
  "cache-control",
  "content-security-policy",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "location",
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}

function requestPathsFor(relativePath) {
  if (relativePath === "index.html") return ["/", "/index.html"];
  if (relativePath.endsWith("/index.html")) {
    const directory = `/${relativePath.slice(0, -"/index.html".length)}`;
    return [directory, `${directory}/`, `/${relativePath}`];
  }
  return [`/${relativePath}`];
}

const files = (await filesBelow(distRoot))
  .map((path) => relative(distRoot, path).split(sep).join("/"))
  .sort();

const digest = createHash("sha256");
for (const path of files) {
  digest.update(path);
  digest.update("\0");
  digest.update(await readFile(resolve(distRoot, path)));
  digest.update("\0");
}

const routeSources = new Map();
for (const file of files) {
  for (const path of requestPathsFor(file)) {
    const sources = routeSources.get(path) ?? [];
    sources.push({ kind: "artifact", file });
    routeSources.set(path, sources);
  }
}

for (const [path, label] of [
  ["/__commonswarm_missing__", "unknown path"],
  ["/_astro/", "fingerprinted asset directory without index"],
  ["/fonts/", "static directory without index"],
]) {
  const sources = routeSources.get(path) ?? [];
  sources.push({ kind: "case", label });
  routeSources.set(path, sources);
}

const routes = [];
for (const path of [...routeSources.keys()].sort()) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "GET",
    redirect: "manual",
    headers: { "user-agent": "CommonSwarm-Vercel-Parity-Inventory/1.0" },
  });
  await response.arrayBuffer();
  const headers = Object.fromEntries(recordedHeaders.map((name) => [name, response.headers.get(name)]));
  routes.push({
    path,
    sources: routeSources.get(path),
    status: response.status,
    contentType: response.headers.get("content-type"),
    headers,
  });
  await new Promise((done) => setTimeout(done, 550));
}

const mismatches = [];
for (const route of routes) {
  const artifact = route.sources.find((source) => source.kind === "artifact");
  if (artifact && route.status === 404) {
    mismatches.push({
      path: route.path,
      kind: "dist-exists-but-vercel-does-not-serve",
      file: artifact.file,
      status: route.status,
    });
  } else if (!artifact && route.status === 200) {
    mismatches.push({
      path: route.path,
      kind: "vercel-serves-but-dist-does-not-exist",
      status: route.status,
    });
  }
}

const reference = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  origin: baseUrl,
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
  siteBuildSha256: digest.digest("hex"),
  requestMethod: "GET",
  requestIntervalMs: 550,
  recordedHeaders,
  artifactCount: files.length,
  artifacts: files,
  routeCount: routes.length,
  routes,
  mismatches,
};

await writeFile(outputPath, `${JSON.stringify(reference, null, 2)}\n`, "utf8");
console.log(`Wrote ${relative(repoRoot, outputPath)} with ${files.length} artifacts and ${routes.length} routes.`);
