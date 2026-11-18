import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { templates } from "./templates.mjs";
import { renderTemplate } from "./render.mjs";

/** The templates self-hosted GoTrue loads from the site. Production sets
 * GOTRUE_MAILER_TEMPLATES_MAGIC_LINK=/auth-email/magic_link.html, which GoTrue fetches as
 * SITE_URL + path. Every other email keeps GoTrue's built-in template until it is listed here. */
export const PUBLISHED_TEMPLATE_KEYS = ["magic_link"];

export async function publishTemplates(outputDir) {
  await mkdir(outputDir, { recursive: true });
  for (const key of PUBLISHED_TEMPLATE_KEYS) {
    const template = templates.find((candidate) => candidate.key === key);
    if (!template) throw new Error(`Unknown template: ${key}`);
    await writeFile(join(outputDir, `${key}.html`), await renderTemplate(template));
  }
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
