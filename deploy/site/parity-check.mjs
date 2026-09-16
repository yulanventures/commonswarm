#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error("Usage: node deploy/site/parity-check.mjs <base-url> [--host <host>] [--ca <file>] [--dist <directory>] [--reference <file>]");
  process.exitCode = 2;
}

const args = process.argv.slice(2);
const baseUrl = args.shift();
let host;
let caPath;
let distPath = resolve(here, "../../site/dist");
let referencePath = resolve(here, "vercel-reference.json");

while (args.length > 0) {
  const flag = args.shift();
  const value = args.shift();
  if ((flag === "--host" || flag === "--ca" || flag === "--dist" || flag === "--reference") && value) {
    if (flag === "--host") host = value;
    else if (flag === "--ca") caPath = resolve(value);
    else if (flag === "--dist") distPath = resolve(value);
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
const ca = caPath ? await readFile(caPath) : undefined;

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}

const policyByExtension = new Map(
  (reference.fingerprintedAssetPolicies ?? []).map((policy) => [policy.extension, policy]),
);
const fingerprintedFiles = (await filesBelow(resolve(distPath, "_astro")))
  .map((path) => relative(distPath, path).split(sep).join("/"))
  .sort();
const fingerprintedRoutes = fingerprintedFiles.map((file) => {
  const extension = extname(file);
  const policy = policyByExtension.get(extension);
  if (!policy) {
    throw new Error(`No recorded Vercel policy for fingerprinted asset extension ${extension || "(none)"}: ${file}`);
  }
  return {
    path: `/${file}`,
    status: policy.status,
    contentType: policy.contentType,
    headers: policy.headers,
  };
});
const routes = [...reference.routes, ...fingerprintedRoutes];

function get(url, hostOverride) {
  return new Promise((resolveRequest, rejectRequest) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "GET",
      headers: hostOverride ? { host: hostOverride } : undefined,
      servername: hostOverride?.split(":", 1)[0],
      ca,
    }, (response) => {
      response.resume();
      response.on("end", () => resolveRequest(response));
    });
    request.on("error", rejectRequest);
    request.end();
  });
}

for (const expected of routes) {
  let response;
  try {
    response = await get(new URL(expected.path, baseUrl), host);
  } catch (error) {
    differences.push(`${expected.path}: request failed: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

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
    if (actual.headers[name] !== expected.headers[name]) {
      differences.push(`${expected.path}: ${name} expected ${JSON.stringify(expected.headers[name])}, got ${JSON.stringify(actual.headers[name])}`);
    }
  }
}

if (differences.length > 0) {
  console.error(`Parity failed with ${differences.length} difference(s):`);
  for (const difference of differences) console.error(`- ${difference}`);
  process.exitCode = 1;
} else {
  console.log(`Parity passed for ${routes.length} routes (${reference.routes.length} fixed, ${fingerprintedRoutes.length} build assets) against ${baseUrl}.`);
}
