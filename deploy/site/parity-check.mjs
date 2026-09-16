#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error("Usage: node deploy/site/parity-check.mjs <base-url> [--host <host>] [--ca <file>] [--reference <file>] [--allow-cloudflare-browser-ttl]");
  process.exitCode = 2;
}

const args = process.argv.slice(2);
const baseUrl = args.shift();
let host;
let caPath;
let referencePath = resolve(here, "vercel-reference.json");
let allowCloudflareBrowserTtl = false;

while (args.length > 0) {
  const flag = args.shift();
  if (flag === "--allow-cloudflare-browser-ttl") {
    allowCloudflareBrowserTtl = true;
    continue;
  }
  const value = args.shift();
  if ((flag === "--host" || flag === "--ca" || flag === "--reference") && value) {
    if (flag === "--host") host = value;
    else if (flag === "--ca") caPath = resolve(value);
    else referencePath = resolve(value);
  } else {
    usage();
    process.exit();
  }
}

if (!baseUrl) {
  usage();
  process.exit();
}

const reference = JSON.parse(await readFile(referencePath, "utf8"));
const differences = [];
const allowedDifferences = [];
const ca = caPath ? await readFile(caPath) : undefined;

const policyByExtension = new Map(
  (reference.fingerprintedAssetPolicies ?? []).map((policy) => [policy.extension, policy]),
);
const cloudflareStaticExtensions = new Set([".css", ".js", ".png", ".svg", ".woff2"]);
const vercelCacheControl = "public, max-age=0, must-revalidate";
const cloudflareBrowserCacheControl = "public, max-age=14400";

function get(url, hostOverride) {
  return new Promise((resolveRequest, rejectRequest) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "GET",
      headers: hostOverride ? { host: hostOverride } : undefined,
      servername: hostOverride?.split(":", 1)[0],
      ca,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolveRequest({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", rejectRequest);
    request.end();
  });
}

function allowsCloudflareCacheRewrite(path, name, expected, actual) {
  return allowCloudflareBrowserTtl &&
    name === "cache-control" &&
    expected === vercelCacheControl &&
    actual === cloudflareBrowserCacheControl &&
    cloudflareStaticExtensions.has(extname(new URL(path, baseUrl).pathname));
}

function compare(expected, response) {
  const actual = {
    status: response.statusCode,
    contentType: response.headers["content-type"] ?? null,
    headers: Object.fromEntries(
      reference.recordedHeaders.map((name) => [name, response.headers[name] ?? null]),
    ),
  };

  if (actual.status !== expected.status) {
    differences.push(`${expected.path}: status expected ${expected.status}, got ${actual.status}`);
  }
  if (actual.contentType !== expected.contentType) {
    differences.push(`${expected.path}: content-type expected ${JSON.stringify(expected.contentType)}, got ${JSON.stringify(actual.contentType)}`);
  }
  for (const name of reference.recordedHeaders) {
    if (actual.headers[name] === expected.headers[name]) continue;
    if (allowsCloudflareCacheRewrite(expected.path, name, expected.headers[name], actual.headers[name])) {
      allowedDifferences.push(`${expected.path}: ${name} ${JSON.stringify(actual.headers[name])}`);
      continue;
    }
    differences.push(`${expected.path}: ${name} expected ${JSON.stringify(expected.headers[name])}, got ${JSON.stringify(actual.headers[name])}`);
  }
}

function collectFingerprintedAssets(html, paths) {
  const attribute = /(?:src|href)=["']([^"'<>]+)["']/gi;
  for (const match of html.matchAll(attribute)) {
    const url = new URL(match[1], baseUrl);
    if (url.pathname.startsWith("/_astro/")) paths.add(url.pathname);
  }
}

const fingerprintedPaths = new Set();
for (const expected of reference.routes) {
  let response;
  try {
    response = await get(new URL(expected.path, baseUrl), host);
  } catch (error) {
    differences.push(`${expected.path}: request failed: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  compare(expected, response);
  if (expected.status === 200 && expected.contentType?.startsWith("text/html")) {
    collectFingerprintedAssets(response.body, fingerprintedPaths);
  }
}

if (policyByExtension.size > 0 && fingerprintedPaths.size === 0) {
  differences.push("HTML routes exposed no /_astro assets; hashed-asset parity was not reached");
}

const fingerprintedRoutes = [...fingerprintedPaths].sort().map((path) => {
  const extension = extname(path);
  const policy = policyByExtension.get(extension);
  if (!policy) {
    differences.push(`${path}: no recorded Vercel policy for extension ${extension || "(none)"}`);
    return undefined;
  }
  return { path, status: policy.status, contentType: policy.contentType, headers: policy.headers };
}).filter(Boolean);

for (const expected of fingerprintedRoutes) {
  try {
    compare(expected, await get(new URL(expected.path, baseUrl), host));
  } catch (error) {
    differences.push(`${expected.path}: request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (allowedDifferences.length > 0) {
  console.log(
    `Allowed ${allowedDifferences.length} Cloudflare browser-TTL rewrite(s) on static-extension files.`,
  );
}

const routeCount = reference.routes.length + fingerprintedRoutes.length;
if (differences.length > 0) {
  console.error(`Parity failed with ${differences.length} difference(s):`);
  for (const difference of differences) console.error(`- ${difference}`);
  process.exitCode = 1;
} else {
  console.log(
    `Parity passed for ${routeCount} routes ` +
    `(${reference.routes.length} fixed, ${fingerprintedRoutes.length} discovered assets) against ${baseUrl}.`,
  );
}
