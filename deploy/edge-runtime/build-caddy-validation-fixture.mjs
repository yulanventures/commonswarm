import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = process.argv[2];
const mode = process.argv[3];
if (
  !outputDirectory ||
  !["with-trusted-proxies", "without-trusted-proxies"].includes(mode)
) {
  throw new Error(
    "usage: node build-caddy-validation-fixture.mjs <output-directory> " +
      "<with-trusted-proxies|without-trusted-proxies> [site-caddy ...]",
  );
}

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const siteFiles = (process.argv.length > 4
  ? process.argv.slice(4)
  : [
      join(sourceDirectory, "..", "supabase-stack", "commonswarm-api.caddy"),
      join(sourceDirectory, "..", "supabase-stack", "commonswarm-edge-staging.caddy"),
    ]
).map((path) => resolve(path));
const sitesDirectory = join(outputDirectory, "sites");
await mkdir(sitesDirectory, { recursive: true });
for (const [index, siteFile] of siteFiles.entries()) {
  await copyFile(
    siteFile,
    join(sitesDirectory, `${String(index + 10).padStart(2, "0")}-${basename(siteFile)}`),
  );
}

let globalServers = "";
if (mode === "with-trusted-proxies") {
  const fragment = await readFile(
    join(sourceDirectory, "caddy-global-servers.caddy"),
    "utf8",
  );
  globalServers = fragment
    .split("\n")
    .map((line) => line.length === 0 ? line : `\t${line}`)
    .join("\n");
}

await writeFile(
  join(outputDirectory, "Caddyfile"),
  `{\n\tauto_https off\n${globalServers}\n}\n\nimport sites/*.caddy\n`,
);
