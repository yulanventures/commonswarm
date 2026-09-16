#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
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
  if (relativePath === "index.html") return ["/", "/index.html", "/index.html/"];
  if (relativePath.endsWith("/index.html")) {
    const directory = `/${relativePath.slice(0, -"/index.html".length)}`;
    return [directory, `${directory}/`, `/${relativePath}`, `/${relativePath}/`];
  }
  return [`/${relativePath}`, `/${relativePath}/`];
}

function responseHeaders(response) {
  return Object.fromEntries(recordedHeaders.map((name) => [name, response.headers.get(name)]));
}

function vercelNotFoundBodyShape(body) {
  const hasTerminalNewline = body.endsWith("\n");
  const lines = body.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length !== 5 || lines[0] !== "The page could not be found" ||
      lines[1] !== "" || lines[2] !== "NOT_FOUND" || lines[3] !== "" || !lines[4]) {
    throw new Error(`Vercel returned an unrecognized 404 body shape: ${JSON.stringify(body)}`);
  }
  return {
    kind: "vercel-not-found",
    lineCount: 5,
    firstLine: lines[0],
    codeLine: lines[2],
    blankLineIndexes: [1, 3],
    finalLine: "non-empty-request-id",
    hasTerminalNewline,
  };
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

const fingerprintedFiles = files.filter((file) => file.startsWith("_astro/"));
const stableFiles = files.filter((file) => !file.startsWith("_astro/"));
const routeSources = new Map();
for (const file of stableFiles) {
  for (const path of requestPathsFor(file)) {
    const sources = routeSources.get(path) ?? [];
    sources.push({ kind: "artifact", file });
    routeSources.set(path, sources);
  }
}

for (const [path, label] of [
  ["/__commonswarm_missing__", "unknown path"],
  ["/__commonswarm_missing__.txt/", "missing file path with trailing slash"],
  ["/_astro/", "fingerprinted asset directory without index"],
  ["/fonts/", "static directory without index"],
  ["/.well-known/security.txt", "dotfile-shaped path"],
]) {
  const sources = routeSources.get(path) ?? [];
  sources.push({ kind: "case", label });
  routeSources.set(path, sources);
}

const fingerprintedAssetPolicies = [];
for (const extension of [...new Set(fingerprintedFiles.map(extname))].sort()) {
  const sample = fingerprintedFiles.find((file) => extname(file) === extension);
  const request = async (path) => {
    const response = await fetch(new URL(path, baseUrl), {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "CommonSwarm-Vercel-Parity-Inventory/1.0" },
    });
    await response.arrayBuffer();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      headers: responseHeaders(response),
    };
  };
  const normal = await request(`/${sample}`);
  await new Promise((done) => setTimeout(done, 550));
  const trailingSlash = await request(`/${sample}/`);
  fingerprintedAssetPolicies.push({
    extension,
    pathPattern: `/_astro/*${extension}`,
    ...normal,
    trailingSlash,
    observedFileCount: fingerprintedFiles.filter((file) => extname(file) === extension).length,
  });
  await new Promise((done) => setTimeout(done, 550));
}

const routes = [];
for (const path of [...routeSources.keys()].sort()) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "GET",
    redirect: "manual",
    headers: { "user-agent": "CommonSwarm-Vercel-Parity-Inventory/1.0" },
  });
  const body = response.status === 404 ? await response.text() : (await response.arrayBuffer(), null);
  const route = {
    path,
    sources: routeSources.get(path),
    status: response.status,
    contentType: response.headers.get("content-type"),
    headers: responseHeaders(response),
  };
  if (response.status === 404) route.bodyShape = vercelNotFoundBodyShape(body);
  routes.push(route);
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
for (const policy of fingerprintedAssetPolicies) {
  if (policy.status !== 200) {
    mismatches.push({
      path: policy.pathPattern,
      kind: "dist-assets-exist-but-vercel-does-not-serve",
      status: policy.status,
    });
  }
}

const reference = {
  schemaVersion: 2,
  recordedAt: new Date().toISOString(),
  origin: baseUrl,
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
  siteBuildSha256: digest.digest("hex"),
  requestMethod: "GET",
  requestIntervalMs: 550,
  recordedHeaders,
  artifactCount: files.length,
  stableArtifactCount: stableFiles.length,
  artifacts: stableFiles,
  fingerprintedAssetCountAtRecording: fingerprintedFiles.length,
  fingerprintedAssetPolicies,
  routeCount: routes.length,
  routes,
  mismatches,
};

await writeFile(outputPath, `${JSON.stringify(reference, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${relative(repoRoot, outputPath)} with ${stableFiles.length} stable artifacts, ` +
  `${fingerprintedFiles.length} fingerprinted assets, and ${routes.length} fixed routes.`,
);
