import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { templates } from "./templates.mjs";
import { renderTemplate } from "./render.mjs";

/** The auth email templates released with GoTrue. The artifact is served read-only on the private
 * stack network by the `auth-templates` service (deploy/supabase-stack/compose.yaml), and GoTrue
 * loads it with an absolute private URL (GOTRUE_MAILER_TEMPLATES_MAGIC_LINK). Site deploys never
 * touch it. Every other email keeps GoTrue's built-in template until it is listed here. */
export const PUBLISHED_TEMPLATE_KEYS = ["magic_link"];

/** Writes `<key>.html` for each published template plus `SHA256SUMS` (sha256sum format), the
 * digests the operator pins and verifies on the host before the server mounts the directory. */
export async function publishTemplates(outputDir) {
  await mkdir(outputDir, { recursive: true });
  const sums = [];
  for (const key of PUBLISHED_TEMPLATE_KEYS) {
    const template = templates.find((candidate) => candidate.key === key);
    if (!template) throw new Error(`Unknown template: ${key}`);
    const html = await renderTemplate(template);
    await writeFile(join(outputDir, `${key}.html`), html, { mode: 0o644 });
    sums.push(`${createHash("sha256").update(html).digest("hex")}  ${key}.html\n`);
  }
  await writeFile(join(outputDir, "SHA256SUMS"), sums.join(""), { mode: 0o644 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputDir = process.argv[2];
  if (!outputDir) {
    process.stderr.write("Usage: node site/emails/publish.mjs <output-dir>\n");
    process.exitCode = 2;
  } else {
    await publishTemplates(outputDir);
  }
}
