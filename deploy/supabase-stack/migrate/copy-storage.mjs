import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

// Forward only: the hosted project is never a copy destination (Strategist ruling 9084e3e1).
const direction = process.argv[2];
if (direction !== "forward") {
  throw new Error("copy direction must be forward; the hosted project is never a destination");
}
const artifactDir = process.env.MIGRATION_ARTIFACT_DIR;
const migrationEnvPath = process.env.COMMONSWARM_MIGRATION_ENV_FILE;
if (!artifactDir || !migrationEnvPath) {
  throw new Error("MIGRATION_ARTIFACT_DIR and COMMONSWARM_MIGRATION_ENV_FILE are required");
}
if (((await stat(migrationEnvPath)).mode & 0o077) !== 0) {
  throw new Error("migration environment file must have mode 0600");
}

function parseEnv(source) {
  const result = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("migration environment file contains a malformed line");
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("migration environment file contains an invalid name");
    if (/^["']/.test(value)) {
      throw new Error(`migration environment value for ${name} starts with a quote; write it unquoted, because docker --env-file keeps quotes`);
    }
    result[name] = value;
  }
  return result;
}

const environment = parseEnv(await readFile(migrationEnvPath, "utf8"));
const required = [
  "SOURCE_STORAGE_URL",
  "SOURCE_SERVICE_ROLE_KEY",
  "TARGET_STORAGE_URL",
  "TARGET_SERVICE_ROLE_KEY",
];
for (const name of required) {
  if (!environment[name]) throw new Error(`required environment variable is empty: ${name}`);
}
const endpoints = {
  sourceUrl: environment.SOURCE_STORAGE_URL,
  sourceKey: environment.SOURCE_SERVICE_ROLE_KEY,
  targetUrl: environment.TARGET_STORAGE_URL,
  targetKey: environment.TARGET_SERVICE_ROLE_KEY,
};

const manifest = await readFile(`${artifactDir}/storage-objects.ndjson`, "utf8");
const objects = manifest.split("\n").filter(Boolean).map((line) => JSON.parse(line));

function objectPath(bucket, name) {
  return [bucket, ...name.split("/")].map(encodeURIComponent).join("/");
}

function headers(key, contentType) {
  return {
    authorization: `Bearer ${key}`,
    apikey: key,
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

let copied = 0;
let totalBytes = 0;
let cursor = 0;
const workers = Array.from({ length: Math.min(2, Math.max(1, objects.length)) }, async () => {
  while (true) {
    const index = cursor++;
    if (index >= objects.length) return;
    const object = objects[index];
    if (
      !object || object.bucket !== "swarm-files" || typeof object.name !== "string" ||
      typeof object.content_type !== "string"
    ) {
      throw new Error(`storage manifest row ${index + 1} is malformed`);
    }
    const path = objectPath(object.bucket, object.name);
    const source = await fetch(
      `${endpoints.sourceUrl.replace(/\/$/, "")}/storage/v1/object/authenticated/${path}`,
      { headers: headers(endpoints.sourceKey) },
    );
    if (!source.ok) throw new Error(`source object read failed at row ${index + 1}: HTTP ${source.status}`);
    const bytes = Buffer.from(await source.arrayBuffer());
    const uploaded = await fetch(
      `${endpoints.targetUrl.replace(/\/$/, "")}/storage/v1/object/${path}`,
      {
        method: "POST",
        headers: {
          ...headers(endpoints.targetKey, object.content_type),
          "x-upsert": "true",
        },
        body: bytes,
      },
    );
    if (!uploaded.ok) {
      const detail = (await uploaded.text()).slice(0, 200).replaceAll(/\s+/g, " ");
      throw new Error(`target object write failed at row ${index + 1}: HTTP ${uploaded.status}; ${detail}`);
    }
    const target = await fetch(
      `${endpoints.targetUrl.replace(/\/$/, "")}/storage/v1/object/authenticated/${path}`,
      { headers: headers(endpoints.targetKey) },
    );
    if (!target.ok) throw new Error(`target object read failed at row ${index + 1}: HTTP ${target.status}`);
    const targetBytes = Buffer.from(await target.arrayBuffer());
    if (bytes.length !== targetBytes.length || digest(bytes) !== digest(targetBytes)) {
      throw new Error(`target object digest mismatch at row ${index + 1}`);
    }
    copied += 1;
    totalBytes += bytes.length;
  }
});

await Promise.all(workers);
process.stdout.write(JSON.stringify({
  direction,
  copied,
  bytes: totalBytes,
  verified: copied,
  metadata_repair_required: true,
}) + "\n");
