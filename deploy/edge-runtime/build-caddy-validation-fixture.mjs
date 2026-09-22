import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = process.argv[2];
const mode = process.argv[3];
if (
  !outputDirectory ||
  !["with-trusted-proxies", "without-trusted-proxies"].includes(mode)
) {
  throw new Error(
    "usage: node build-caddy-validation-fixture.mjs <output-directory> " +
      "<with-trusted-proxies|without-trusted-proxies> [site-caddy]",
  );
}

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const siteFile = resolve(
  process.argv[4] ??
    join(sourceDirectory, "..", "supabase-stack", "commonswarm-api.caddy"),
);
const sitesDirectory = join(outputDirectory, "sites");
await mkdir(sitesDirectory, { recursive: true });
await copyFile(siteFile, join(sitesDirectory, "10-commonswarm-api.caddy"));

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
