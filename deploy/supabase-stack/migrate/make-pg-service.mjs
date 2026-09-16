import { writeFile } from "node:fs/promises";

const output = process.env.PG_SERVICE_OUTPUT;
if (!output) throw new Error("PG_SERVICE_OUTPUT is required");

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
    password: decodeURIComponent(url.password),
  };
  for (const [key, value] of url.searchParams) values[key] = value;
  const lines = [`[${name}]`];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z_]+$/i.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`${name} database URL contains an unsupported parameter`);
    }
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

const body = section("source", process.env.SOURCE_DATABASE_URL) +
  section("target", process.env.TARGET_DATABASE_URL);
if (!body) throw new Error("a source or target database URL is required");
await writeFile(output, body, { mode: 0o600 });
