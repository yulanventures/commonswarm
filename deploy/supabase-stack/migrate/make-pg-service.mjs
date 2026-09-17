import { readFile, writeFile } from "node:fs/promises";

const output = process.env.PG_SERVICE_OUTPUT;
const passOutput = process.env.PG_PASS_OUTPUT;
if (!output || !passOutput) {
  throw new Error("PG_SERVICE_OUTPUT and PG_PASS_OUTPUT are required");
}

async function envFile(path) {
  if (!path) return {};
  const result = {};
  for (const rawLine of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("environment file contains a malformed line");
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("environment file contains an invalid name");
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    result[name] = value;
  }
  return result;
}

const serviceEnv = await envFile(process.env.COMMONSWARM_ENV_FILE);
const migrationEnv = await envFile(process.env.COMMONSWARM_MIGRATION_ENV_FILE);
const value = (name) => process.env[name] ?? migrationEnv[name] ?? serviceEnv[name];

const targetUrl = value("TARGET_DATABASE_URL");
if (targetUrl) {
  const hostname = new URL(targetUrl).hostname;
  const allowed = new Set(["db.commonswarm.internal", "172.31.0.10"]);
  if (value("COMMONSWARM_LOCAL_REHEARSAL") === "1") {
    for (const name of (value("COMMONSWARM_LOCAL_TARGET_HOSTS") ?? "").split(",")) {
      if (name.trim()) allowed.add(name.trim());
    }
  }
  if (!allowed.has(hostname)) {
    throw new Error("TARGET_DATABASE_URL host is not an allowed CommonSwarm target");
  }
}

function section(name, raw) {
  if (!raw) return "";
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} database URL must use postgres or postgresql`);
  }
  const values = {
    host: url.hostname,
    port: url.port || "5432",
    dbname: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    user: decodeURIComponent(url.username),
  };
  for (const [key, value] of url.searchParams) values[key] = value;
  if (name === "target" && value("COMMONSWARM_LOCAL_REHEARSAL") === "1") {
    const address = value("COMMONSWARM_LOCAL_TARGET_ADDRESS");
    if (!address || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
      throw new Error("COMMONSWARM_LOCAL_TARGET_ADDRESS is required for a local target");
    }
    values.options = [
      values.options,
      "-ccommonswarm.local_rehearsal=1",
      `-ccommonswarm.local_target_address=${address}`,
    ].filter(Boolean).join(" ");
  }
  const lines = [`[${name}]`];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z_]+$/i.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`${name} database URL contains an unsupported parameter`);
    }
    if (value !== value.trim()) {
      throw new Error(`${name} database URL contains surrounding whitespace`);
    }
    lines.push(`${key}=${value}`);
  }
  const escapePass = (value) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  const pass = [
    url.hostname,
    url.port || "5432",
    decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
  ].map(escapePass).join(":");
  if (/[\r\n]/.test(pass)) throw new Error(`${name} database URL contains a newline`);
  return { service: `${lines.join("\n")}\n`, pass: `${pass}\n` };
}

const sections = [
  section("source", value("SOURCE_DATABASE_URL")),
  section("target", targetUrl),
].filter(Boolean);
if (sections.length === 0) throw new Error("a source or target database URL is required");
await writeFile(output, sections.map(({ service }) => service).join(""), { mode: 0o600 });
await writeFile(passOutput, sections.map(({ pass }) => pass).join(""), { mode: 0o600 });
