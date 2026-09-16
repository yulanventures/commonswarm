import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = process.argv[2];
const mode = process.argv[3];
if (
  !outputDirectory ||
  !["with-trusted-proxies", "without-trusted-proxies"].includes(mode)
) {
  throw new Error(
    "usage: node build-caddy-validation-fixture.mjs <output-directory> " +
      "<with-trusted-proxies|without-trusted-proxies>",
  );
}

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const sitesDirectory = join(outputDirectory, "sites");
await mkdir(sitesDirectory, { recursive: true });
await copyFile(
  join(sourceDirectory, "commonswarm.caddy"),
  join(sitesDirectory, "10-commonswarm-api.caddy"),
);

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
