#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const envPath = process.argv[2];
if (!envPath) {
  console.error("Usage: validate-site-env.mjs <site-env-file>");
  process.exit(2);
}

const source = await readFile(envPath, "utf8");
const values = new Map();
for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  values.set(match[1], value);
}

for (const name of ["PUBLIC_SUPABASE_URL", "PUBLIC_SUPABASE_ANON_KEY"]) {
  if (!values.get(name)) {
    console.error(`Refusing deploy: site/.env lacks a non-empty ${name} value.`);
    process.exit(1);
  }
}

const anonKey = values.get("PUBLIC_SUPABASE_ANON_KEY");
const segments = anonKey.split(".");
if (segments.length !== 3) {
  console.error("Refusing deploy: PUBLIC_SUPABASE_ANON_KEY is not a JWT.");
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
} catch {
  console.error("Refusing deploy: PUBLIC_SUPABASE_ANON_KEY has an invalid JWT payload.");
  process.exit(1);
}
if (payload?.role === "service_role") {
  console.error("Refusing deploy: PUBLIC_SUPABASE_ANON_KEY contains the service_role role.");
  process.exit(1);
}
