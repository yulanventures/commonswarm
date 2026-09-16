import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const required = [
  "MIGRATION_ARTIFACT_DIR",
  "SOURCE_STORAGE_URL",
  "SOURCE_SERVICE_ROLE_KEY",
  "TARGET_STORAGE_URL",
  "TARGET_SERVICE_ROLE_KEY",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`required environment variable is empty: ${name}`);
}

const manifest = await readFile(
  `${process.env.MIGRATION_ARTIFACT_DIR}/storage-objects.ndjson`,
  "utf8",
);
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
      `${process.env.SOURCE_STORAGE_URL.replace(/\/$/, "")}/storage/v1/object/authenticated/${path}`,
      { headers: headers(process.env.SOURCE_SERVICE_ROLE_KEY) },
    );
    if (!source.ok) throw new Error(`source object read failed at row ${index + 1}: HTTP ${source.status}`);
    const bytes = Buffer.from(await source.arrayBuffer());
    const uploaded = await fetch(
      `${process.env.TARGET_STORAGE_URL.replace(/\/$/, "")}/storage/v1/object/${path}`,
      {
        method: "POST",
        headers: {
          ...headers(process.env.TARGET_SERVICE_ROLE_KEY, object.content_type),
          "x-upsert": "true",
        },
        body: bytes,
      },
    );
    if (!uploaded.ok) throw new Error(`target object write failed at row ${index + 1}: HTTP ${uploaded.status}`);
    const target = await fetch(
      `${process.env.TARGET_STORAGE_URL.replace(/\/$/, "")}/storage/v1/object/authenticated/${path}`,
      { headers: headers(process.env.TARGET_SERVICE_ROLE_KEY) },
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
process.stdout.write(JSON.stringify({ copied, bytes: totalBytes, verified: copied }) + "\n");
